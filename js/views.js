// Page and sheet markup. All dynamic values go through html`` (auto-escaped).

import { db, client, service, paymentsFor } from './db.js';
import {
  html, fmtDate, fmtDateShort, fmtDay, fmtTime, relDays, money, startOfDay, addDays,
  fullName, dateInput, timeInput, telUrl, byStart, byStartDesc, fill,
} from './util.js';
import { trackStatus, mostUrgent, payInfo, clientAppts, suggestedPrice } from './rules.js';
import { TRACKS, GCAL_COLORS } from './defaults.js';
import { findClientByName } from './match.js';
import { backupDue, pendingCalendarChanges } from './sync.js';
import { hasToken, isConfigured } from './google.js';
import { CHANNELS, available, channelFor, canMessage, channelLabel } from './contact.js';
import { summary as financeSummary, yearOf, yearLabel, gstPart } from './finance.js';
import * as GH from './ghstore.js';
import { githubSection } from './views-github.js';

const STATUS = { booked: 'Booked', done: 'Done', cancelled: 'Cancelled', noshow: 'No-show' };
const PAY = { paid: 'Paid', part: 'Part-paid', unpaid: 'Unpaid', free: 'No charge' };
const STATE = { overdue: 'Overdue', due: 'Due soon', booked: 'Booked', ok: 'Up to date', lapsed: 'Lapsed', none: '' };

const chip = (text, kind) => (text ? html`<span class="chip chip-${kind}">${text}</span>` : '');
const inRange = (d, a, b) => { const t = new Date(d); return t >= a && t < b; };
const activeServices = () => db().services.filter((s) => s.active !== false);

function empty(text) { return html`<p class="empty">${text}</p>`; }
function section(title, body, extra = '') {
  return html`<section><h2>${title}${extra}</h2>${body}</section>`;
}

// ---------------- shared cards ----------------

function smsSentFor(c, tpl, apptId) {
  return (c?.smsLog || []).some((l) => l.tpl === tpl && (!apptId || l.apptId === apptId));
}

export function apptCard(a, { showDate = false } = {}) {
  const c = client(a.clientId);
  const s = service(a.serviceId);
  const p = payInfo(a);
  const reminded = a.status === 'booked' && smsSentFor(c, 'reminder', a.id);
  return html`<div class="card appt status-${a.status}" data-act="appt-edit" data-id="${a.id}">
    <div class="when">${showDate ? html`<b>${fmtDateShort(a.start)}</b>` : ''}<span>${fmtTime(a.start)}</span></div>
    <div class="main">
      <div class="name">${fullName(c)}</div>
      <div class="sub">${s?.name || 'Unknown service'} · ${money(a.price)}</div>
      <div class="chips">
        ${a.status !== 'booked' ? chip(STATUS[a.status], a.status) : ''}
        ${a.status === 'done' ? chip(PAY[p.status], p.status) : ''}
        ${reminded ? chip('Reminder sent', 'ok') : ''}
        ${a.gcalDirty ? chip('Not in calendar yet', 'warn') : ''}
      </div>
    </div>
    <div class="actions">
      ${canMessage(c) ? html`<button class="btn-sm" data-act="sms" data-client="${c.id}" data-appt="${a.id}">${channelLabel(c)}</button>` : ''}
      ${a.status === 'booked' ? html`<button class="btn-sm" data-act="appt-done" data-id="${a.id}">Done</button>` : ''}
      ${a.status === 'done' && p.owing > 0 ? html`<button class="btn-sm primary" data-act="pay" data-id="${a.id}">Pay ${money(p.owing)}</button>` : ''}
    </div>
  </div>`;
}

function lastSmsAfter(c, tpl, sinceIso) {
  const l = (c.smsLog || []).filter((x) => x.tpl === tpl && x.at > sinceIso).pop();
  return l ? l.at : null;
}

function dueCard(x) {
  const svc = service(x.next.serviceId);
  const texted = lastSmsAfter(x.client, 'due', x.last.start);
  return html`<div class="card due" data-act="go" data-href="#/client/${x.client.id}">
    <div class="main">
      <div class="name">${fullName(x.client)}</div>
      <div class="sub">${svc?.name} ${x.state === 'overdue' || x.state === 'lapsed' ? 'was due' : 'due'} ${relDays(x.next.date)}</div>
      <div class="sub muted">Last visit ${fmtDateShort(x.last.start)} (${service(x.last.serviceId)?.name || ''})</div>
      <div class="chips">${chip(STATE[x.state], x.state)}${texted ? chip(`Messaged ${relDays(texted)}`, 'ok') : ''}${tagChips(x.client)}</div>
    </div>
    <div class="actions">
      ${canMessage(x.client) ? html`<button class="btn-sm" data-act="sms-direct" data-client="${x.client.id}" data-tpl="due" data-track="${x.track}">${channelLabel(x.client)}</button>` : ''}
      <button class="btn-sm primary" data-act="appt-new" data-client="${x.client.id}" data-service="${x.next.serviceId}">Book</button>
    </div>
  </div>`;
}

export function dueList() {
  const out = [];
  for (const c of db().clients) {
    if (c.archived) continue;
    for (const t of trackStatus(c.id)) if (t.next && t.last) out.push({ client: c, ...t });
  }
  return out.sort((a, b) => a.next.date - b.next.date);
}

// ---------------- Home ----------------

export function homeView() {
  const d = db();
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  const after = addDays(today, 2);
  const A = d.appointments;

  const todays = A.filter((a) => a.status !== 'cancelled' && inRange(a.start, today, tomorrow)).sort(byStart);
  const tomorrows = A.filter((a) => a.status === 'booked' && inRange(a.start, tomorrow, after)).sort(byStart);
  const toClose = A.filter((a) => a.status === 'booked' && inRange(a.start, addDays(today, -120), today)).sort(byStartDesc);
  const unpaid = A.filter((a) => a.status === 'done' && payInfo(a).owing > 0).sort(byStartDesc);
  const due = dueList().filter((x) => x.state === 'due' || x.state === 'overdue');

  const banners = [];
  if (d.review.length) banners.push(html`<a class="banner" href="#/review"><b>${d.review.length}</b> calendar events to match to clients &rsaquo;</a>`);
  const ghs = GH.state();
  if (GH.isConfigured() && ghs.lastError) banners.push(html`<button class="banner warn" data-act="gh-sync">Not saved to GitHub: ${ghs.lastError} Tap to retry.</button>`);
  if (backupDue()) {
    banners.push(d.settings.driveBackup
      ? html`<button class="banner warn" data-act="backup-drive">Backup to Google Drive is due. Tap to back up now.</button>`
      : html`<a class="banner warn" href="#/settings">No recent backup. Set up Google Drive backup or save a backup file &rsaquo;</a>`);
  }
  const pend = pendingCalendarChanges();
  if (pend && d.settings.calendarSync) banners.push(html`<button class="banner" data-act="sync">${pend} change(s) not in Google Calendar yet. Tap to sync.</button>`);

  return html`
    ${banners}
    ${section(`Today, ${fmtDay(today)}`, todays.length ? todays.map((a) => apptCard(a)) : empty('Nothing booked today.'))}
    ${tomorrows.length ? section('Tomorrow', html`${tomorrows.map((a) => apptCard(a))}`,
      tomorrows.some((a) => client(a.clientId)?.phone) ? html`<small class="hint"> tap SMS to send reminders</small>` : '') : ''}
    ${toClose.length ? section('Past bookings to close off', toClose.map((a) => apptCard(a, { showDate: true }))) : ''}
    ${unpaid.length ? section(`Unpaid (${money(unpaid.reduce((t, a) => t + payInfo(a).owing, 0))})`, unpaid.map((a) => apptCard(a, { showDate: true }))) : ''}
    ${section(`Due for follow-up (${due.length})`, due.length ? due.map(dueCard) : empty('No one due in the next ' + d.settings.dueWindowDays + ' days.'))}
    <a class="banner" href="#/lapsed">Lapsed clients: overdue by more than ${d.settings.lapseAfterDays} days &rsaquo;</a>
  `;
}

/** Clients long overdue: candidates for a "time for a refresh" text. Most recent first. */
export function lapsedView() {
  const list = dueList().filter((x) => x.state === 'lapsed').sort((a, b) => b.next.date - a.next.date);
  return html`
    <p class="hint">Clients whose follow-up is more than ${db().settings.lapseAfterDays} days overdue (change this in Settings). Most recent first.</p>
    ${section(`Lapsed (${list.length})`, list.length ? list.slice(0, 200).map(dueCard) : empty('No lapsed clients.'))}
    ${list.length > 200 ? html`<p class="hint center">Showing the 200 most recent.</p>` : ''}`;
}

// ---------------- Bookings ----------------

export function bookingsView(showPast) {
  const today = startOfDay(new Date());
  const list = showPast
    ? db().appointments.filter((a) => new Date(a.start) < today).sort(byStartDesc).slice(0, 300)
    : db().appointments.filter((a) => new Date(a.start) >= today && a.status !== 'cancelled').sort(byStart);
  const groups = new Map();
  for (const a of list) {
    const k = dateInput(a.start);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return html`
    <div class="seg">
      <a href="#/bookings" class="${showPast ? '' : 'on'}">Upcoming</a>
      <a href="#/bookings/past" class="${showPast ? 'on' : ''}">Past</a>
    </div>
    ${list.length ? [...groups].map(([k, arr]) => html`
      <section><h2>${fmtDay(arr[0].start)} <small class="hint">${relDays(arr[0].start)}</small></h2>${arr.map((a) => apptCard(a))}</section>`)
      : empty(showPast ? 'No past visits yet.' : 'No upcoming bookings.')}
  `;
}

// ---------------- Clients ----------------

// Filters/sorts for the client list. Keys are stored by app.js between visits.
export const CLIENT_FILTERS = {
  all: 'All clients',
  recent: 'Visited in last 12 months',
  notRecent: 'No visit in last 12 months',
  upcoming: 'Has upcoming booking',
  due: 'Due or overdue',
  lapsed: 'Lapsed',
  owing: 'Money owing',
  texted: 'Messaged since last visit',
  notTexted: 'Due/overdue, not messaged yet',
  tagged: 'Has any tag',
  never: 'No visits yet',
};

/** Tag chips for a client (manual tags). */
export function tagChips(c) {
  return (c?.tags || []).map((t) => chip(t, 'tag'));
}
export const CLIENT_SORTS = {
  az: 'Name A–Z',
  za: 'Name Z–A',
  lastVisit: 'Last visit (newest first)',
  nextDue: 'Due date (closest to today)',
  visits: 'Most visits',
};

/** Per-client summary, cached until the data changes. */
let summaryCache = { at: null, map: null };
function clientSummaries() {
  const d = db();
  if (summaryCache.at === d.meta.updatedAt && summaryCache.map) return summaryCache.map;
  const today = startOfDay(new Date());
  const byClient = new Map();
  for (const a of d.appointments) {
    if (!byClient.has(a.clientId)) byClient.set(a.clientId, []);
    byClient.get(a.clientId).push(a);
  }
  const map = new Map();
  for (const c of d.clients) {
    const appts = byClient.get(c.id) || [];
    const happened = appts.filter((a) => a.status !== 'cancelled' && a.status !== 'noshow' && new Date(a.start) < today);
    const last = happened.sort(byStartDesc)[0] || null;
    const tracks = trackStatus(c.id);
    const nextDue = tracks.filter((t) => t.next && t.state !== 'booked').map((t) => t.next.date).sort((x, y) => x - y)[0] || null;
    // Last text sent after the last visit (any template).
    const sinceIso = last ? new Date(last.start).toISOString() : '';
    const textedAt = (c.smsLog || []).filter((l) => l.at > sinceIso).map((l) => l.at).sort().pop() || null;
    map.set(c.id, {
      last,
      textedAt,
      visits: happened.length,
      upcoming: appts.some((a) => a.status === 'booked' && new Date(a.start) >= today),
      owing: appts.reduce((t, a) => t + (a.status === 'done' ? payInfo(a).owing : 0), 0),
      tracks,
      urgent: mostUrgent(tracks),
      nextDue,
    });
  }
  summaryCache = { at: d.meta.updatedAt, map };
  return map;
}

export function clientsView(state) {
  const sel = (name, opts, value) => html`<select id="client-${name}" aria-label="${name}">
    ${Object.entries(opts).map(([k, v]) => html`<option value="${k}" ${k === value ? 'selected' : ''}>${v}</option>`)}</select>`;
  return html`
    <div class="toolbar">
      <input type="search" id="client-search" placeholder="Search name, phone or email" value="${state.q}" autocomplete="off">
      <button class="btn primary" data-act="client-new">+ Client</button>
    </div>
    <div class="filters">
      ${sel('filter', CLIENT_FILTERS, state.filter)}
      ${sel('track', { all: 'All services', ...Object.fromEntries(Object.entries(TRACKS).filter(([k]) => k !== 'none')) }, state.track)}
      ${sel('tag', { all: 'Any tag', ...Object.fromEntries((db().settings.clientTags || []).map((t) => [t, `Tag: ${t}`])) }, state.tag)}
      ${sel('sort', CLIENT_SORTS, state.sort)}
    </div>
    <div id="client-list">${clientList(state)}</div>`;
}

export function clientList({ q = '', filter = 'all', track = 'all', sort = 'az', tag = 'all' } = {}) {
  const sums = clientSummaries();
  const today = startOfDay(new Date());
  const yearAgo = addDays(today, -365);
  const s = String(q || '').toLowerCase().trim();
  const digits = s.replace(/\D/g, '');

  const tests = {
    all: () => true,
    recent: (x) => x.last && new Date(x.last.start) >= yearAgo,
    notRecent: (x) => x.visits > 0 && (!x.last || new Date(x.last.start) < yearAgo),
    upcoming: (x) => x.upcoming,
    due: (x) => x.tracks.some((t) => t.state === 'due' || t.state === 'overdue'),
    lapsed: (x) => x.tracks.some((t) => t.state === 'lapsed') && !x.upcoming,
    owing: (x) => x.owing > 0,
    texted: (x) => !!x.textedAt,
    notTexted: (x) => !x.textedAt && !x.upcoming && x.tracks.some((t) => t.state === 'due' || t.state === 'overdue'),
    tagged: (x, c) => (c.tags || []).length > 0,
    never: (x) => x.visits === 0 && !x.upcoming,
  };
  const test = tests[filter] || tests.all;

  let list = db().clients.filter((c) => {
    const x = sums.get(c.id);
    if (!x || !test(x, c)) return false;
    if (tag !== 'all' && !(c.tags || []).includes(tag)) return false;
    if (track !== 'all' && !x.tracks.some((t) => t.track === track)) return false;
    if (!s) return true;
    return `${c.firstName} ${c.lastName} ${c.email}`.toLowerCase().includes(s) ||
      (digits.length >= 3 && String(c.phone || '').replace(/\D/g, '').includes(digits));
  });

  const name = (c) => fullName(c).toLocaleLowerCase();
  const t = (d) => (d ? new Date(d).getTime() : 0);
  const sorters = {
    az: (a, b) => name(a).localeCompare(name(b)),
    za: (a, b) => name(b).localeCompare(name(a)),
    lastVisit: (a, b) => t(sums.get(b.id).last?.start) - t(sums.get(a.id).last?.start),
    // Closest to today first (just overdue and coming up soon at the top), no due date last.
    nextDue: (a, b) => {
      const da = sums.get(a.id).nextDue; const db_ = sums.get(b.id).nextDue;
      const dist = (d) => (d ? Math.abs(t(d) - today.getTime()) : Infinity);
      return dist(da) - dist(db_);
    },
    visits: (a, b) => sums.get(b.id).visits - sums.get(a.id).visits,
  };
  list = list.sort(sorters[sort] || sorters.az);

  if (!list.length) {
    return empty(db().clients.length ? 'No clients match.' : 'No clients yet. Add one, or import your Google Calendar under More.');
  }
  const LIMIT = 2000;
  const showLetters = (sort === 'az' || sort === 'za') && !s;
  let lastLetter = '';
  const rows = [];
  for (const c of list.slice(0, LIMIT)) {
    const x = sums.get(c.id);
    if (showLetters) {
      const L = (fullName(c)[0] || '#').toUpperCase().replace(/[^A-Z]/, '#');
      if (L !== lastLetter) { rows.push(html`<div class="letter">${L}</div>`); lastLetter = L; }
    }
    const u = x.urgent;
    const label = u?.state === 'booked' ? `Booked ${fmtDateShort(u.booked.start)}`
      : u?.next ? `${STATE[u.state]}: ${service(u.next.serviceId)?.name} ${relDays(u.next.date)}` : '';
    rows.push(html`<a class="row" href="#/client/${c.id}">
      <div><div class="name">${fullName(c)}</div>
        <div class="sub">${x.last ? `Last visit ${fmtDateShort(x.last.start)} · ${service(x.last.serviceId)?.name || ''}` : 'No visits yet'}${x.visits > 1 ? ` · ${x.visits} visits` : ''}</div>
        ${x.owing > 0 ? html`<div class="sub bad">${money(x.owing)} owing</div>` : ''}
        <div class="chips">${u && u.state !== 'none' ? chip(label, u.state) : ''}${tagChips(c)}${x.textedAt ? chip(`Messaged ${relDays(x.textedAt)}`, 'ok') : ''}</div>
      </div></a>`);
  }
  return html`<p class="hint">${list.length} client${list.length === 1 ? '' : 's'}</p>
    <div class="list">${rows}</div>
    ${list.length > LIMIT ? html`<p class="hint center">Showing ${LIMIT} of ${list.length}. Search or filter to narrow down.</p>` : ''}`;
}

export function clientView(id) {
  const c = client(id);
  if (!c) return empty('Client not found.');
  const appts = clientAppts(id);
  const tracks = trackStatus(id);
  const paidTotal = appts.reduce((t, a) => t + (a.status === 'done' ? (a.paidHistoric ? Number(a.price) || 0 : payInfo(a).paid) : 0), 0);
  const owing = appts.reduce((t, a) => t + (a.status === 'done' ? payInfo(a).owing : 0), 0);
  return html`
    <div class="client-head">
      <h1>${fullName(c)}</h1>
      <div class="contact">
        ${c.phone ? html`<a href="${telUrl(c.phone)}">${c.phone}</a>` : html`<span class="muted">No phone</span>`}
        ${c.email ? html` · <a href="mailto:${c.email}">${c.email}</a>` : ''}
      </div>
      ${c.address ? html`<div class="muted">${c.address}</div>` : ''}
      <div class="btn-row">
        <button class="btn primary" data-act="appt-new" data-client="${c.id}">Book</button>
        ${canMessage(c) ? html`<button class="btn" data-act="sms" data-client="${c.id}">${channelLabel(c)}</button>` : ''}
        <button class="btn" data-act="client-edit" data-id="${c.id}">Edit</button>
      </div>
      ${c.noSms ? html`<p class="hint">Does not want reminder messages.</p>` : html`<p class="hint">Preferred contact: ${CHANNELS[c.preferredContact || db().settings.defaultContact || 'sms']}${channelFor(c) && channelFor(c) !== (c.preferredContact || 'sms') ? ` (no details, using ${CHANNELS[channelFor(c)]})` : ''}</p>`}
      <div class="tag-row" aria-label="Tags">${(db().settings.clientTags || []).map((t) => {
        const on = (c.tags || []).includes(t);
        return html`<button class="tag-btn ${on ? 'on' : ''}" data-act="tag-toggle" data-id="${c.id}" data-tag="${t}" aria-pressed="${on}">${on ? '✓ ' : ''}${t}</button>`;
      })}</div>
    </div>

    ${tracks.length ? section('Next due', html`<div class="list">${tracks.map((t) => html`
      <div class="row static"><div>
        <div class="name">${TRACKS[t.track] || t.track}</div>
        <div class="sub">${t.booked ? html`Booked ${fmtDate(t.booked.start)} ${fmtTime(t.booked.start)}`
          : t.next ? html`${service(t.next.serviceId)?.name} due ${fmtDateShort(t.next.date)} (${relDays(t.next.date)})` : 'Nothing scheduled'}</div>
      </div>${chip(STATE[t.state], t.state)}</div>`)}</div>`) : ''}

    <div class="stats">
      <div><b>${appts.filter((a) => a.status === 'done').length}</b><span>visits</span></div>
      <div><b>${money(paidTotal)}</b><span>paid</span></div>
      <div class="${owing ? 'bad' : ''}"><b>${money(owing)}</b><span>owing</span></div>
    </div>

    ${(c.skinType || c.pigment || c.notes) ? section('Notes', html`
      ${c.skinType ? html`<p><b>Skin type:</b> ${c.skinType}</p>` : ''}
      ${c.pigment ? html`<p><b>Pigment:</b> ${c.pigment}</p>` : ''}
      ${c.notes ? html`<p class="pre">${c.notes}</p>` : ''}`) : ''}

    ${section('History', appts.length ? appts.map((a) => apptCard(a, { showDate: true })) : empty('No visits yet.'))}
  `;
}

// ---------------- More / settings pages ----------------

export function moreView() {
  const d = db();
  return html`<div class="list">
    <a class="row" href="#/review"><div class="name">Calendar import &amp; review</div>${d.review.length ? chip(String(d.review.length), 'due') : ''}</a>
    <a class="row" href="#/contacts"><div class="name">Match Google Contacts</div><span class="muted">fill in phones &amp; emails</span></a>
    <a class="row" href="#/finance"><div class="name">Financials</div><span class="muted">earnings by month &amp; year</span></a>
    <a class="row" href="#/services"><div class="name">Services &amp; prices</div><span class="muted">${d.services.length}</span></a>
    <a class="row" href="#/templates"><div class="name">SMS templates</div><span class="muted">${d.templates.length}</span></a>
    <a class="row" href="#/settings"><div class="name">Settings, Google &amp; backups</div></a>
  </div>
  <p class="hint center">${d.clients.length} clients · ${d.appointments.length} visits · data stored on this phone</p>`;
}

export function servicesView() {
  const groups = {};
  for (const s of db().services) (groups[s.track || 'none'] ||= []).push(s);
  return html`
    <div class="toolbar"><p class="hint">Prices, durations and when the next visit is due. Tap to edit.</p>
      <button class="btn primary" data-act="service-new">+ Service</button></div>
    ${Object.keys(TRACKS).filter((t) => groups[t]).map((t) => section(TRACKS[t], html`<div class="list">${groups[t].map((s) => html`
      <button class="row" data-act="service-edit" data-id="${s.id}">
        <div><div class="name">${s.name}${s.active === false ? ' (hidden)' : ''}</div>
        <div class="sub">${s.durationMin} min · ${money(s.price)}${s.latePrice ? html` (${money(s.latePrice)} after ${s.lateAfterDays} days)` : ''}
        ${(s.followUps || []).length ? html` · next: ${s.followUps.map((f) => `${service(f.serviceId)?.name || '?'} +${f.days}d`).join(', ')}` : ''}</div></div>
      </button>`)}</div>`))}`;
}

export function templatesView() {
  return html`
    <div class="toolbar"><p class="hint">Placeholders: {first} {name} {service} {day} {date} {time} {when} {due} {lastDate} {outstanding} {sign}</p>
      <button class="btn primary" data-act="template-new">+ Template</button></div>
    <div class="list">${db().templates.map((t) => html`
      <button class="row" data-act="template-edit" data-id="${t.id}"><div><div class="name">${t.name}</div><div class="sub clamp">${t.body}</div></div></button>`)}</div>`;
}

/** Review-list filter shared by the screen and the bulk buttons. */
export function filterReview(items, f = {}) {
  const today = startOfDay(new Date()).toISOString();
  const q = String(f.q || '').toLowerCase().trim();
  const from = f.from ? new Date(f.from + 'T00:00:00').toISOString() : '';
  const to = f.to ? new Date(f.to + 'T23:59:59').toISOString() : '';
  return items.filter((r) => {
    if (f.color && f.color !== 'all') {
      if (f.color === 'unknown' ? r.colorId !== undefined : (r.colorId ?? null) !== (f.color === 'default' ? '' : f.color)) return false;
    }
    if (from && r.start < from) return false;
    if (to && r.start > to) return false;
    if (f.when === 'past' && r.start >= today) return false;
    if (f.when === 'upcoming' && r.start < today) return false;
    const matched = !!(r.suggestion.serviceId && r.suggestion.name);
    if (f.match === 'matched' && !matched) return false;
    if (f.match === 'unmatched' && matched) return false;
    if (f.repeat === 'hide' && r.recurring) return false;
    if (q && !(`${r.summary} ${r.description || ''}`).toLowerCase().includes(q)) return false;
    return true;
  });
}

const colorKey = (r) => (r.colorId === undefined ? 'unknown' : r.colorId === '' ? 'default' : r.colorId);
function colorInfo(k) {
  if (k === 'unknown') return { name: 'No colour info (file import)', hex: 'transparent' };
  return GCAL_COLORS[k === 'default' ? '' : k] || { name: `Colour ${k}`, hex: '#ccc' };
}

export function reviewView(page = 0, f = {}) {
  const d = db();
  const PAGE = 40;
  const list = filterReview(d.review, f);
  const items = list.slice(page * PAGE, page * PAGE + PAGE);
  const matched = list.filter((r) => r.suggestion.serviceId && r.suggestion.name).length;
  const unmatched = list.filter((r) => !r.suggestion.serviceId).length;
  const opts = db().services;
  const today = startOfDay(new Date());
  const counts = {};
  for (const r of filterReview(d.review, { ...f, color: 'all' })) counts[colorKey(r)] = (counts[colorKey(r)] || 0) + 1;
  const sel = (id, opts2, value) => html`<select id="review-${id}">${Object.entries(opts2).map(([k, v]) => html`<option value="${k}" ${k === (value || Object.keys(opts2)[0]) ? 'selected' : ''}>${v}</option>`)}</select>`;
  const filtered = list.length !== d.review.length;
  return html`
    <section>
      <h2>Import</h2>
      <p class="hint">Google Calendar export (.zip or .ics) from calendar.google.com &gt; Settings &gt; Import &amp; export. Or connect Google under Settings and sync directly. Event colours only come through Google sync (the export file has none).</p>
      <div class="btn-row">
        <label class="btn">Choose export file<input type="file" id="ics-file" accept=".ics,.zip,text/calendar,application/zip" hidden></label>
        ${d.settings.calendarSync ? html`<button class="btn" data-act="sync">Sync Google Calendar</button>` : ''}
      </div>
    </section>
    <section>
      <h2>To review (${filtered ? `${list.length} of ${d.review.length}` : d.review.length})</h2>
      ${d.review.length ? html`
        <div class="color-row">
          <button class="color-chip ${!f.color || f.color === 'all' ? 'on' : ''}" data-act="review-filter" data-key="color" data-val="all">All colours</button>
          ${Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map((k) => { const ci = colorInfo(k); return html`
            <button class="color-chip ${f.color === k ? 'on' : ''}" data-act="review-filter" data-key="color" data-val="${k}" title="${ci.name}">
              <span class="swatch" style="background:${ci.hex}"></span>${ci.name} <small>${counts[k]}</small></button>`; })}
        </div>
        <div class="filters">
          <label>From<input type="date" id="review-from" value="${f.from || ''}"></label>
          <label>To<input type="date" id="review-to" value="${f.to || ''}"></label>
          ${sel('when', { all: 'Past and upcoming', past: 'Past only', upcoming: 'Upcoming only' }, f.when)}
          ${sel('match', { all: 'Matched and unmatched', matched: 'Matched only', unmatched: 'Unmatched only' }, f.match)}
          ${sel('repeat', { show: 'Include repeating events', hide: 'Hide repeating events' }, f.repeat)}
          <input type="search" id="review-q" placeholder="Search title" value="${f.q || ''}" autocomplete="off">
        </div>
        ${filtered ? html`<p class="hint"><button class="link" data-act="review-filter-clear">Clear filters</button></p>` : ''}
        <p class="hint">Each event becomes a visit for that client. Past events are marked done, and "Paid" is ticked by default for old visits. Titles with "cancelled" or "no show" are saved with that status. Names that don't match an existing client create a new one. The buttons below only act on the events shown by the filter.</p>
        <div class="btn-row">
          <button class="btn primary" data-act="review-accept-all" ${matched ? '' : 'disabled'}>Accept matched (${matched})</button>
          <button class="btn" data-act="review-ignore-unmatched" ${unmatched ? '' : 'disabled'}>Ignore unmatched (${unmatched})</button>
          ${filtered ? html`<button class="btn danger" data-act="review-ignore-shown" ${list.length ? '' : 'disabled'}>Ignore all shown (${list.length})</button>` : ''}
        </div>
        <datalist id="client-names">${d.clients.map((c) => html`<option value="${fullName(c)}">`)}</datalist>
        ${items.map((r) => {
          const sg = r.suggestion;
          const existing = sg.name && findClientByName(sg.name);
          const past = new Date(r.start) < today;
          return html`<form class="card review" data-form="review" data-key="${r.key}">
            <div class="review-head">${r.colorId !== undefined ? html`<span class="swatch" style="background:${colorInfo(colorKey(r)).hex}" title="${colorInfo(colorKey(r)).name}"></span>` : ''}<b>${r.allDay ? fmtDate(r.start) : `${fmtDate(r.start)} ${fmtTime(r.start)}`}</b>
              ${past ? chip('Past', 'done') : chip('Upcoming', 'booked')}${r.recurring ? chip('Repeating', 'warn') : ''}
              ${sg.status ? chip(sg.status === 'noshow' ? 'No-show' : 'Cancelled', sg.status) : ''}</div>
            <div class="review-title">${r.summary || '(no title)'}</div>
            ${r.description ? html`<div class="sub clamp">${r.description}</div>` : ''}
            <div class="grid2">
              <label>Client ${existing ? chip('existing', 'ok') : sg.name ? chip('new', 'due') : ''}
                <input name="name" list="client-names" value="${sg.name}" placeholder="Client name"></label>
              <label>Service<select name="serviceId"><option value="">Choose...</option>
                ${opts.map((s) => html`<option value="${s.id}" ${s.id === sg.serviceId ? 'selected' : ''}>${s.name}</option>`)}</select></label>
              <label>Price<input name="price" type="number" inputmode="decimal" step="0.01" value="${sg.price ?? ''}" placeholder="service price"></label>
              ${past ? html`<label class="check"><input type="checkbox" name="paid" checked> Paid</label>` : html`<span></span>`}
            </div>
            <div class="btn-row"><button class="btn primary" type="submit">Accept</button>
              <button class="btn" type="button" data-act="review-ignore" data-key="${r.key}">Ignore</button></div>
          </form>`;
        })}
        ${list.length > PAGE ? html`<div class="btn-row center">
          ${page > 0 ? html`<a class="btn" href="#/review/${page - 1}">&lsaquo; Prev</a>` : ''}
          <span class="hint">Page ${page + 1} of ${Math.ceil(list.length / PAGE)}</span>
          ${(page + 1) * PAGE < list.length ? html`<a class="btn" href="#/review/${page + 1}">Next &rsaquo;</a>` : ''}</div>` : ''}
        ${!list.length ? empty('No events match these filters.') : ''}
      ` : empty('Nothing waiting. Import a calendar file or sync Google Calendar.')}
    </section>`;
}

export function settingsView() {
  const s = db().settings;
  const connected = hasToken();
  return html`
  <form data-form="settings">
    ${section('Business', html`
      <label>Business name<input name="businessName" value="${s.businessName}"></label>
      <label>SMS sign-off {sign}<input name="signature" value="${s.signature}"></label>`)}
    ${section('Follow-ups', html`
      <div class="grid2">
        <label>Show "due soon" days ahead<input name="dueWindowDays" type="number" min="0" value="${s.dueWindowDays}"></label>
        <label>Lapsed after overdue (days)<input name="lapseAfterDays" type="number" min="0" value="${s.lapseAfterDays}"></label>
      </div>
      <label>Client tags (comma separated)<input name="clientTags" value="${(s.clientTags || []).join(', ')}"></label>`)}
    ${section('Google account', html`
      <p class="hint">Needed for Google Calendar sync and Drive backups. See README for the one-off Google Cloud setup.</p>
      <label>OAuth client ID<input name="googleClientId" value="${s.googleClientId}" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off"></label>
      <div class="btn-row">
        ${connected ? html`<span class="chip chip-ok">Connected</span><button class="btn" type="button" data-act="google-disconnect">Disconnect</button>`
          : html`<button class="btn primary" type="button" data-act="google-connect" ${isConfigured() ? '' : 'disabled'}>Connect Google</button>`}
      </div>
      <p class="hint">Google only allows the app about an hour per sign-in, so you may be asked to tap Connect again when you open the app.</p>`)}
    ${section('Google Calendar', html`
      <label class="check"><input type="checkbox" name="calendarSync" ${s.calendarSync ? 'checked' : ''}> Sync bookings with Google Calendar</label>
      <div class="grid2">
        <label>Calendar ID<input name="calendarId" value="${s.calendarId}" placeholder="primary"></label>
        <label>Import events from<input name="importFrom" type="date" value="${s.importFrom}"></label>
      </div>
      <div class="btn-row"><button class="btn" type="button" data-act="sync">Sync now</button>
        <span class="hint">${s.lastCalendarSyncAt ? `Last sync ${relDays(s.lastCalendarSyncAt)} ${fmtTime(s.lastCalendarSyncAt)}` : 'Never synced'}</span></div>`)}
    ${section('Google Drive backup', html`
      <label class="check"><input type="checkbox" name="driveBackup" ${s.driveBackup ? 'checked' : ''}> Back up automatically to Google Drive</label>
      <div class="grid2">
        <label>Every (hours)<input name="backupIntervalHours" type="number" min="1" value="${s.backupIntervalHours}"></label>
        <label>Keep newest<input name="backupKeep" type="number" min="1" value="${s.backupKeep}"></label>
      </div>
      <p class="hint">Runs when the app is open and Google is connected. Saved in the Drive folder "Browlicious Backups". Older copies go to Drive's bin.</p>
      <div class="btn-row"><button class="btn" type="button" data-act="backup-drive">Back up now</button>
        <button class="btn" type="button" data-act="restore-drive">Restore from Drive</button></div>
      <p class="hint">${s.lastBackupAt ? `Last Drive backup: ${fmtDate(s.lastBackupAt)} ${fmtTime(s.lastBackupAt)}` : 'No Drive backup yet.'}</p>`)}
    <div class="sticky-save"><button class="btn primary wide" type="submit">Save settings</button></div>
  </form>
  ${githubSection()}
  ${section('Backup file', html`
    <div class="btn-row"><button class="btn" data-act="backup-file">Save backup file</button>
      <label class="btn">Restore from file<input type="file" id="restore-file" accept=".json,application/json" hidden></label></div>
    <p class="hint">${s.lastLocalExportAt ? `Last file backup: ${fmtDate(s.lastLocalExportAt)}` : 'No file backup yet.'}</p>`)}
  ${section('Storage', html`<p class="hint" id="storage-info">Checking...</p>
    <button class="btn danger" data-act="wipe">Erase all data on this phone</button>`)}
  `;
}

// ---------------- Sheets (forms in a bottom dialog) ----------------

function sheet(title, body) {
  return html`<div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-act="close" aria-label="Close">&times;</button></div>${body}`;
}

export function clientSheet(c) {
  const isNew = !c;
  c = c || {};
  return sheet(isNew ? 'New client' : 'Edit client', html`
  <form data-form="client" data-id="${c.id || ''}">
    <div class="grid2">
      <label>First name<input name="firstName" value="${c.firstName || ''}" required autocomplete="off"></label>
      <label>Last name<input name="lastName" value="${c.lastName || ''}" autocomplete="off"></label>
    </div>
    <label>Mobile<input name="phone" type="tel" value="${c.phone || ''}" autocomplete="off"></label>
    <label>Email<input name="email" type="email" value="${c.email || ''}" autocomplete="off"></label>
    <label>Facebook (profile link or username)<input name="facebook" value="${c.facebook || ''}" autocomplete="off" placeholder="facebook.com/... or username"></label>
    <label>Preferred contact<select name="preferredContact">
      ${Object.entries(CHANNELS).map(([k, v]) => html`<option value="${k}" ${(c.preferredContact || db().settings.defaultContact || 'sms') === k ? 'selected' : ''}>${v}</option>`)}</select></label>
    <label>Address<input name="address" value="${c.address || ''}" autocomplete="off"></label>
    <div class="grid2">
      <label>Skin type<input name="skinType" value="${c.skinType || ''}" placeholder="e.g. III, medium"></label>
      <label>Pigment mix<input name="pigment" value="${c.pigment || ''}"></label>
    </div>
    <label>Notes<textarea name="notes" rows="4">${c.notes || ''}</textarea></label>
    <label class="check"><input type="checkbox" name="noSms" ${c.noSms ? 'checked' : ''}> Does not want reminder messages</label>
    <p class="hint">Health questionnaires and consent forms stay on paper.</p>
    <div class="btn-row">
      <button class="btn primary" type="submit">Save</button>
      ${!isNew ? html`<button class="btn danger" type="button" data-act="client-delete" data-id="${c.id}">Delete</button>` : ''}
    </div>
  </form>`);
}

function serviceOptions(selected) {
  const groups = {};
  for (const s of db().services) if (s.active !== false || s.id === selected) (groups[s.track || 'none'] ||= []).push(s);
  return Object.keys(TRACKS).filter((t) => groups[t]).map((t) => html`<optgroup label="${TRACKS[t]}">
    ${groups[t].map((s) => html`<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${s.name} (${money(s.price)})</option>`)}</optgroup>`);
}

export function apptSheet(a, preset = {}) {
  const isNew = !a;
  const now = new Date();
  const start = a ? new Date(a.start) : preset.date ? new Date(preset.date) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0);
  const clientId = a?.clientId || preset.clientId || '';
  const c = clientId ? client(clientId) : null;
  const serviceId = a?.serviceId || preset.serviceId || '';
  const svc = service(serviceId);
  const price = a ? a.price : serviceId ? suggestedPrice(clientId, serviceId, start) : '';
  const pays = a ? paymentsFor(a.id) : [];
  const p = a ? payInfo(a) : null;
  return sheet(isNew ? 'New booking' : 'Booking', html`
  <form data-form="appt" data-id="${a?.id || ''}">
    <label>Client<input name="clientName" list="appt-clients" value="${c ? fullName(c) : ''}" required autocomplete="off" placeholder="Start typing a name"></label>
    <datalist id="appt-clients">${db().clients.map((x) => html`<option value="${fullName(x)}">`)}</datalist>
    <label class="new-only" style="${c ? 'display:none' : ''}">Mobile (only needed for a new client)<input name="newPhone" type="tel" autocomplete="off"></label>
    <label>Service<select name="serviceId" required><option value="">Choose...</option>${serviceOptions(serviceId)}</select></label>
    <div class="grid2">
      <label>Date<input name="date" type="date" value="${dateInput(start)}" required></label>
      <label>Time<input name="time" type="time" value="${timeInput(start)}" required step="300"></label>
      <label>Length (min)<input name="durationMin" type="number" min="5" step="5" value="${a?.durationMin || svc?.durationMin || 60}"></label>
      <label>Price ($)<input name="price" type="number" step="0.01" inputmode="decimal" value="${price}" data-touched="${a ? '1' : ''}"></label>
    </div>
    <p class="hint" id="price-hint"></p>
    ${!isNew ? html`<label>Status<select name="status">
      ${Object.entries(STATUS).map(([k, v]) => html`<option value="${k}" ${a.status === k ? 'selected' : ''}>${v}</option>`)}</select></label>` : ''}
    <label>Notes<textarea name="notes" rows="3">${a?.notes || ''}</textarea></label>
    ${!isNew ? html`
      <div class="pay-box">
        <div class="pay-head"><b>Payment</b> ${chip(PAY[p.status], p.status)}</div>
        ${a.paidHistoric ? html`<p class="hint">Marked as paid during import.</p>` : ''}
        ${pays.map((x) => html`<div class="pay-line">${fmtDateShort(x.date)} · ${x.method === 'eftpos' ? 'EFTPOS' : 'Cash'} · <b>${money(x.amount)}</b>
          <button class="link danger" type="button" data-act="pay-delete" data-id="${x.id}" data-appt="${a.id}">remove</button></div>`)}
        ${p.owing > 0 ? html`<button class="btn" type="button" data-act="pay" data-id="${a.id}">Take payment (${money(p.owing)} owing)</button>` : ''}
      </div>` : ''}
    <div class="btn-row">
      <button class="btn primary" type="submit">${isNew ? 'Book' : 'Save'}</button>
      ${!isNew && client(a.clientId)?.phone ? html`<button class="btn" type="button" data-act="sms" data-client="${a.clientId}" data-appt="${a.id}">SMS</button>` : ''}
      ${!isNew ? html`<button class="btn danger" type="button" data-act="appt-delete" data-id="${a.id}">Delete</button>` : ''}
    </div>
  </form>`);
}

export function paySheet(a) {
  const p = payInfo(a);
  const c = client(a.clientId);
  return sheet('Take payment', html`
  <form data-form="pay" data-id="${a.id}">
    <p><b>${fullName(c)}</b><br>${service(a.serviceId)?.name} · ${fmtDate(a.start)}</p>
    <p>Price ${money(p.price)} · paid ${money(p.paid)} · <b>owing ${money(p.owing)}</b></p>
    <div class="grid2">
      <label>Amount ($)<input name="amount" type="number" step="0.01" inputmode="decimal" value="${p.owing}" required></label>
      <label>Date<input name="date" type="date" value="${dateInput(new Date())}" required></label>
    </div>
    <div class="btn-row big">
      <button class="btn primary" type="submit" name="method" value="eftpos">EFTPOS</button>
      <button class="btn primary" type="submit" name="method" value="cash">Cash</button>
    </div>
  </form>`);
}

/** Variables available to SMS templates for a client (+ optional booking / track). */
export function smsVars(c, a, track) {
  const s = db().settings;
  const t = track ? trackStatus(c.id).find((x) => x.track === track)
    : mostUrgent(trackStatus(c.id).filter((x) => x.next));
  const target = a || t?.booked || null;
  const p = a ? payInfo(a) : null;
  const start = target ? new Date(target.start) : null;
  const n = start ? Math.round((startOfDay(start) - startOfDay(new Date())) / 86400000) : null;
  return {
    first: c.firstName || fullName(c),
    name: fullName(c),
    service: target ? (service(target.serviceId)?.name || '').toLowerCase() : '',
    day: start ? fmtDay(start) : '',
    date: start ? fmtDateShort(start) : '',
    time: start ? fmtTime(start) : '',
    when: n === 0 ? 'today' : n === 1 ? 'tomorrow' : start ? `on ${fmtDay(start)}` : '',
    due: t?.next ? (service(t.next.serviceId)?.name || '').toLowerCase() : 'next appointment',
    lastDate: t?.last ? fmtDateShort(t.last.start) : '',
    outstanding: p ? money(p.owing) : '',
    sign: s.signature || s.businessName,
    business: s.businessName,
  };
}

/** Email subject for a template (falls back to "<business> - <template name>"). */
export function templateSubject(t, vars) {
  return fill(t?.subject || `${db().settings.businessName} - ${t?.name || 'Message'}`, vars);
}

export function smsSheet(c, a, prefer = null, channel = null) {
  const vars = smsVars(c, a);
  const ch = channelFor(c, channel);
  const av = available(c);
  let order = a ? (a.status === 'booked' ? ['reminder', 'confirm'] : ['thanks', 'payment']) : ['due'];
  if (prefer) order = [prefer, ...order];
  const tpls = [...db().templates].sort((x, y) => {
    const ix = order.indexOf(x.id); const iy = order.indexOf(y.id);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  });
  const how = { sms: 'opens Messages', email: 'opens your email app (Gmail) with subject and text filled in', facebook: 'copies the text and opens Messenger, then paste it' }[ch];
  return sheet(`Message ${c.firstName || fullName(c)}`, html`
    <div class="seg">${Object.entries(CHANNELS).map(([k, v]) => html`
      <button type="button" class="${k === ch ? 'on' : ''}" data-act="msg-channel" data-channel="${k}" data-client="${c.id}" data-appt="${a?.id || ''}" data-prefer="${prefer || ''}" ${av[k] ? '' : 'disabled'}>${v}</button>`)}</div>
    <p class="hint">Tapping a message ${how}. You can still edit it before sending.</p>
    <div class="list">${tpls.map((t) => html`
      <button class="row sms-opt" data-act="sms-open" data-tpl="${t.id}" data-client="${c.id}" data-appt="${a?.id || ''}" data-channel="${ch}">
        <div><div class="name">${t.name}</div>
        ${ch === 'email' ? html`<div class="sub"><b>${templateSubject(t, vars)}</b></div>` : ''}
        <div class="sub">${fill(t.body, vars)}</div></div></button>`)}
      <button class="row sms-opt" data-act="sms-open" data-tpl="" data-client="${c.id}" data-channel="${ch}"><div class="name">Blank message</div></button>
    </div>`);
}

export function serviceSheet(s) {
  const isNew = !s;
  s = s || { followUps: [] };
  const f = [...(s.followUps || []), {}, {}].slice(0, Math.max(3, (s.followUps || []).length + 1));
  const opts = (sel) => html`<option value="">-</option>${db().services.map((x) => html`<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${x.name}</option>`)}`;
  return sheet(isNew ? 'New service' : 'Edit service', html`
  <form data-form="service" data-id="${s.id || ''}">
    <label>Name<input name="name" value="${s.name || ''}" required></label>
    <div class="grid2">
      <label>Group<select name="track">${Object.entries(TRACKS).map(([k, v]) => html`<option value="${k}" ${s.track === k ? 'selected' : ''}>${v}</option>`)}</select></label>
      <label>Length (min)<input name="durationMin" type="number" min="5" step="5" value="${s.durationMin || 60}"></label>
      <label>Price ($)<input name="price" type="number" step="0.01" value="${s.price ?? ''}" required></label>
      <span></span>
      <label>Higher price if last visit older than (days)<input name="lateAfterDays" type="number" min="0" value="${s.lateAfterDays || ''}" placeholder="optional"></label>
      <label>Higher price ($)<input name="latePrice" type="number" step="0.01" value="${s.latePrice || ''}" placeholder="optional"></label>
    </div>
    <fieldset><legend>Next visit due</legend>
      <p class="hint">Days after this visit. If more than one has passed, the later one is shown.</p>
      ${f.map((x, i) => html`<div class="grid2">
        <label>Service<select name="fu_service_${i}">${opts(x.serviceId)}</select></label>
        <label>After (days)<input name="fu_days_${i}" type="number" min="1" value="${x.days || ''}"></label></div>`)}
    </fieldset>
    <label>Calendar keywords (comma separated, used to recognise imported events)<textarea name="keywords" rows="2">${s.keywords || ''}</textarea></label>
    <label class="check"><input type="checkbox" name="active" ${s.active !== false ? 'checked' : ''}> Show when booking</label>
    <div class="btn-row"><button class="btn primary" type="submit">Save</button>
      ${!isNew ? html`<button class="btn danger" type="button" data-act="service-delete" data-id="${s.id}">Delete</button>` : ''}</div>
  </form>`);
}

export function templateSheet(t) {
  const isNew = !t;
  t = t || {};
  return sheet(isNew ? 'New template' : 'Edit template', html`
  <form data-form="template" data-id="${t.id || ''}">
    <label>Name<input name="name" value="${t.name || ''}" required></label>
    <label>Email subject<input name="subject" value="${t.subject || ''}" placeholder="Used when sending by email"></label>
    <label>Message<textarea name="body" rows="6" required>${t.body || ''}</textarea></label>
    <p class="hint">{first} {name} {service} {day} {date} {time} {when} {due} {lastDate} {outstanding} {sign} {business}</p>
    <div class="btn-row"><button class="btn primary" type="submit">Save</button>
      ${!isNew ? html`<button class="btn danger" type="button" data-act="template-delete" data-id="${t.id}">Delete</button>` : ''}</div>
  </form>`);
}

export function restoreSheet(files) {
  return sheet('Restore from Google Drive', html`
    <p class="hint">Restoring replaces everything on this phone with the chosen backup.</p>
    ${files.length ? html`<div class="list">${files.map((f) => html`
      <button class="row" data-act="restore-drive-file" data-id="${f.id}"><div><div class="name">${fmtDate(f.createdTime)} ${fmtTime(f.createdTime)}</div>
      <div class="sub">${f.name} · ${Math.round((Number(f.size) || 0) / 1024)} KB</div></div></button>`)}</div>` : empty('No backups found in Drive.')}`);
}

// ---------------- Financials ----------------

export function financeView(mode, year) {
  const s = db().settings;
  const F = financeSummary(mode, year);
  const gst = !!s.gstRegistered;
  const amt = (v) => (gst ? html`${money(v)}<small class="muted"> (ex ${money(v - gstPart(v))})</small>` : money(v));
  const yearsAvail = [...new Set([...F.years.map(([y]) => y), yearOf(new Date(), mode)])].sort((a, b) => b - a);
  const diff = F.yearTotal.total - F.prevTotal.total;
  return html`
    <div class="seg">
      <a href="#/finance/calendar/${yearOf(new Date(), 'calendar')}" class="${mode === 'calendar' ? 'on' : ''}">Calendar year</a>
      <a href="#/finance/tax/${yearOf(new Date(), 'tax')}" class="${mode === 'tax' ? 'on' : ''}">Tax year (Apr–Mar)</a>
    </div>
    <div class="toolbar">
      <select id="finance-year" data-mode="${mode}">${yearsAvail.map((y) => html`<option value="${y}" ${y === year ? 'selected' : ''}>${yearLabel(y, mode)}</option>`)}</select>
      <label class="check"><input type="checkbox" id="finance-gst" ${gst ? 'checked' : ''}> GST (${s.gstRate || 15}%)</label>
    </div>
    <div class="stats">
      <div><b>${money(F.yearTotal.total)}</b><span>earned</span></div>
      <div><b>${diff >= 0 ? '+' : '-'}${money(Math.abs(diff))}</b><span>vs previous year</span></div>
      <div class="${F.owing ? 'bad' : ''}"><b>${money(F.owing)}</b><span>owing now</span></div>
    </div>
    ${gst ? html`<p class="hint center">Includes GST of ${money(gstPart(F.yearTotal.total))}. Excluding GST: ${money(F.yearTotal.total - gstPart(F.yearTotal.total))}.</p>` : ''}
    ${section('By month', html`<div class="list table">
      <div class="trow head"><span>Month</span><span>EFTPOS</span><span>Cash</span><span>Total</span></div>
      ${F.months.map((m) => html`<div class="trow ${m.total ? '' : 'zero'}"><span>${m.label}</span><span>${money(m.eftpos)}</span><span>${money(m.cash)}</span><span><b>${amt(m.total)}</b></span></div>`)}
      <div class="trow head"><span>Total</span><span>${money(F.yearTotal.eftpos)}</span><span>${money(F.yearTotal.cash)}</span><span>${amt(F.yearTotal.total)}</span></div>
    </div>`)}
    ${section('By service', F.services.length ? html`<div class="list table">${F.services.map(([n, v]) => html`
      <div class="trow two"><span>${n} <small class="muted">× ${v.count}</small></span><span><b>${money(v.total)}</b></span></div>`)}</div>` : empty('No payments recorded in this year.'))}
    ${section(mode === 'tax' ? 'All tax years' : 'All years', F.years.length ? html`<div class="list table">${F.years.map(([y, v]) => html`
      <a class="trow two" href="#/finance/${mode}/${y}"><span>${yearLabel(y, mode)}</span><span><b>${amt(v.total)}</b></span></a>`)}</div>` : empty('No payments recorded yet.'))}
    <div class="btn-row"><button class="btn" data-act="finance-csv">Export payments (CSV)</button></div>
    <p class="hint">Counts payments taken in the app (Done > Cash/EFTPOS). Visits imported from the old calendar are not included.</p>`;
}
