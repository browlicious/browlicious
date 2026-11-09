// Calendar import (file or Google), review queue, pushing bookings to Google,
// and backups (Google Drive + local file).

import { db, commit, client, service, replaceAll, flush } from './db.js';
import { uid, startOfDay, fullName, localDate, stripHtml, dateInput } from './util.js';
import { suggest, findClientByName, findClientByPhone } from './match.js';
import { suggestedPrice } from './rules.js';
import * as G from './google.js';

// ---------------- Review queue ----------------

const eventKey = (icalUid, startIso) => `${icalUid}|${startIso}`;

function fromGcal(ev) {
  const allDay = !!ev.start?.date;
  const start = ev.start ? (allDay ? localDate(ev.start.date) : new Date(ev.start.dateTime)) : null;
  const end = ev.end ? (ev.end.date ? localDate(ev.end.date) : new Date(ev.end.dateTime)) : start;
  return {
    source: 'gcal',
    gcalId: ev.id,
    icalUid: ev.iCalUID || ev.id,
    blId: ev.extendedProperties?.private?.blId || null,
    summary: ev.summary || '',
    description: ev.description || '',
    start, end, allDay,
    cancelled: ev.status === 'cancelled',
  };
}

/** Link events to existing appointments, or queue them for review. */
export function ingest(events) {
  const d = db();
  const res = { added: 0, updated: 0, cancelled: 0, linked: 0, skipped: 0 };
  const byGcal = new Map(d.appointments.filter((a) => a.gcalId).map((a) => [a.gcalId, a]));
  const byId = new Map(d.appointments.map((a) => [a.id, a]));
  const byKey = new Map(d.appointments.filter((a) => a.icalUid).map((a) => [eventKey(a.icalUid, a.start), a]));
  const reviewByKey = new Map(d.review.map((r) => [r.key, r]));
  const ignored = new Set(d.ignored);

  for (const e of events) {
    if (e.cancelled) {
      const a = e.gcalId && byGcal.get(e.gcalId);
      if (a && a.status === 'booked' && !a.gcalDirty) { a.status = 'cancelled'; a.gcalId = null; res.cancelled++; }
      if (e.gcalId) d.review = d.review.filter((r) => r.gcalId !== e.gcalId);
      continue;
    }
    if (!(e.start instanceof Date) || isNaN(e.start)) { res.skipped++; continue; }
    const startIso = e.start.toISOString();
    const key = eventKey(e.icalUid, startIso);
    const dur = Math.max(0, Math.round((e.end - e.start) / 60000));

    const a = (e.gcalId && byGcal.get(e.gcalId)) || (e.blId && byId.get(e.blId)) || byKey.get(key);
    if (a) {
      if (e.gcalId && a.gcalId !== e.gcalId) { a.gcalId = e.gcalId; res.linked++; }
      // Booking moved in Google Calendar: follow it (unless we have unsent local edits).
      if (e.source === 'gcal' && !a.gcalDirty && a.start !== startIso && a.status === 'booked') {
        a.start = startIso;
        if (dur > 0 && !e.allDay) a.durationMin = dur;
        res.updated++;
      }
      continue;
    }
    if (ignored.has(key)) continue;
    const existing = reviewByKey.get(key);
    if (existing) { if (e.gcalId) existing.gcalId = e.gcalId; continue; }

    const description = stripHtml(e.description);
    const item = {
      key, source: e.source, gcalId: e.gcalId || null, icalUid: e.icalUid,
      summary: e.summary, description, start: startIso, durationMin: e.allDay ? 0 : dur,
      allDay: !!e.allDay, recurring: !!e.recurring,
      // Facebook / Eventbrite events saved to the calendar are never client bookings.
      suggestion: /fb:\/\/event|facebook\.com\/events|eventbrite\./i.test(description)
        ? { ...suggest(''), name: '' }
        : suggest(e.summary),
    };
    d.review.push(item);
    reviewByKey.set(key, item);
    res.added++;
  }
  d.review.sort((x, y) => x.start.localeCompare(y.start));
  return res;
}

export function acceptReview(key, { name, serviceId, price, paid, status }) {
  const d = db();
  const i = d.review.findIndex((r) => r.key === key);
  if (i < 0) return null;
  const r = d.review[i];
  const svc = service(serviceId);
  if (!svc) throw new Error('Pick a service first.');
  const nm = String(name || '').trim();
  if (!nm) throw new Error('Enter the client name first.');

  let c = findClientByName(nm) || (r.suggestion.phone && findClientByPhone(r.suggestion.phone)) || null;
  if (!c) {
    const [first, ...rest] = nm.split(/\s+/);
    c = newClient({ firstName: first, lastName: rest.join(' '), phone: r.suggestion.phone || '' });
    d.clients.push(c);
  } else if (!c.phone && r.suggestion.phone) c.phone = r.suggestion.phone;

  const past = new Date(r.start) < startOfDay(new Date());
  const p = price === '' || price == null || isNaN(Number(price))
    ? suggestedPrice(c.id, svc.id, new Date(r.start)) : Number(price);
  const a = {
    id: uid(), clientId: c.id, serviceId: svc.id, start: r.start,
    durationMin: r.durationMin || svc.durationMin,
    status: status || r.suggestion.status || (past ? 'done' : 'booked'),
    price: p, notes: [r.summary, r.description].filter(Boolean).join('\n'),
    gcalId: r.gcalId, icalUid: r.icalUid, source: r.source,
    paidHistoric: past && !!paid && !(status || r.suggestion.status), gcalDirty: false,
    createdAt: new Date().toISOString(),
  };
  d.appointments.push(a);
  d.review.splice(i, 1);
  return a;
}

export function ignoreReview(key) {
  const d = db();
  d.review = d.review.filter((r) => r.key !== key);
  if (!d.ignored.includes(key)) d.ignored.push(key);
}

export function newClient(fields = {}) {
  return {
    id: uid(), firstName: '', lastName: '', phone: '', email: '', address: '',
    skinType: '', pigment: '', notes: '', noSms: false, archived: false, smsLog: [], facebook: '', preferredContact: 'sms', tags: [],
    createdAt: new Date().toISOString(), ...fields,
  };
}

// ---------------- Google Calendar push/pull ----------------

/** Mark an appointment as needing to be written to Google Calendar. */
export function markDirty(a) {
  if (db().settings.calendarSync) a.gcalDirty = true;
}

export function queueDelete(a) {
  const d = db();
  if (d.settings.calendarSync && a.gcalId && !d.gcalDeletes.includes(a.gcalId)) d.gcalDeletes.push(a.gcalId);
}

export async function pushAppt(a) {
  if (a.status === 'cancelled' || a.status === 'noshow') {
    if (a.gcalId && a.status === 'cancelled') { await G.deleteEvent(a.gcalId); a.gcalId = null; }
    a.gcalDirty = false;
    return;
  }
  const c = client(a.clientId);
  const svc = service(a.serviceId);
  const start = new Date(a.start);
  const end = new Date(start.getTime() + (Number(a.durationMin) || svc?.durationMin || 60) * 60000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    extendedProperties: { private: { blId: a.id } },
  };
  // Only rewrite title/notes for bookings made in the app; imported events keep her wording.
  if (a.source === 'app' || !a.gcalId) {
    body.summary = `${fullName(c)} - ${svc?.name || 'Appointment'}`;
    body.description = [c?.phone ? `Phone: ${c.phone}` : '', a.notes || ''].filter(Boolean).join('\n');
  }
  const ev = await G.upsertEvent(a.gcalId, body);
  a.gcalId = ev.id;
  a.icalUid = ev.iCalUID || a.icalUid;
  a.gcalDirty = false;
}

/** Push local changes, then pull everything from Google Calendar. */
export async function syncCalendar() {
  const d = db();
  const s = d.settings;
  if (!G.hasToken()) throw new G.NeedsAuth();
  let pushed = 0;
  try {
    for (const id of [...d.gcalDeletes]) {
      await G.deleteEvent(id);
      d.gcalDeletes = d.gcalDeletes.filter((x) => x !== id);
    }
    for (const a of d.appointments.filter((x) => x.gcalDirty)) { await pushAppt(a); pushed++; }
    const from = localDate(s.importFrom || '2015-01-01').toISOString();
    const items = await G.listEvents(from);
    const res = ingest(items.map(fromGcal));
    s.lastCalendarSyncAt = new Date().toISOString();
    return { ...res, pushed };
  } finally {
    commit();
  }
}

/** Try to send one appointment straight away; leave it queued if offline / signed out. */
export async function pushSoon(a) {
  if (!db().settings.calendarSync || !G.hasToken()) return false;
  try {
    if (a.gcalDirty) await pushAppt(a);
    for (const id of [...db().gcalDeletes]) {
      await G.deleteEvent(id);
      db().gcalDeletes = db().gcalDeletes.filter((x) => x !== id);
    }
    commit();
    return true;
  } catch (e) {
    console.warn('Calendar push failed, will retry on next sync', e);
    return false;
  }
}

export const pendingCalendarChanges = () =>
  db().appointments.filter((a) => a.gcalDirty).length + db().gcalDeletes.length;

// ---------------- Backups ----------------

export function backupJson() {
  return JSON.stringify({ app: 'browlicious', version: 1, exportedAt: new Date().toISOString(), data: db() });
}

export function backupDue() {
  const s = db().settings;
  const last = s.driveBackup ? s.lastBackupAt : s.lastLocalExportAt;
  if (!last) return true;
  const hours = s.driveBackup ? Number(s.backupIntervalHours) || 24 : 24 * 7;
  return Date.now() - new Date(last).getTime() > hours * 3600 * 1000;
}

export function downloadLocalBackup() {
  const blob = new Blob([backupJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `browlicious-backup-${dateInput(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  db().settings.lastLocalExportAt = new Date().toISOString();
  commit();
}

export async function driveBackupNow() {
  const s = db().settings;
  await flush();
  const stamp = new Date().toISOString().replace(/[:]/g, '-').slice(0, 16);
  await G.uploadBackup(backupJson(), `browlicious-backup-${stamp}.json`);
  s.lastBackupAt = new Date().toISOString();
  commit();
  try { await G.trimBackups(Number(s.backupKeep) || 30); } catch (e) { console.warn('Trim failed', e); }
}

export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('That file is not a valid backup (not JSON).'); }
  const data = obj?.app === 'browlicious' ? obj.data : null;
  if (!data || !Array.isArray(data.clients) || !Array.isArray(data.appointments)) {
    throw new Error('That file is not a Browlicious backup.');
  }
  return data;
}

export async function restoreBackup(data) {
  await replaceAll(data);
}
