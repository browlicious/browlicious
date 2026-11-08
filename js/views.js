// Page and sheet markup. All dynamic values go through html`` (auto-escaped).

import { db, client, service, paymentsFor } from './db.js';
import {
  html, fmtDate, fmtDateShort, fmtDay, fmtTime, relDays, money, startOfDay, addDays,
  fullName, dateInput, timeInput, telUrl, byStart, byStartDesc, fill,
} from './util.js';
import { trackStatus, mostUrgent, payInfo, clientAppts, suggestedPrice } from './rules.js';
import { TRACKS } from './defaults.js';
import { findClientByName } from './match.js';
import { backupDue, pendingCalendarChanges } from './sync.js';
import { hasToken, isConfigured } from './google.js';

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
      ${c?.phone && !c.noSms ? html`<button class="btn-sm" data-act="sms" data-client="${c.id}" data-appt="${a.id}">SMS</button>` : ''}
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
      <div class="chips">${chip(STATE[x.state], x.state)}${texted ? chip(`Texted ${relDays(texted)}`, 'ok') : ''}</div>
    </div>
    <div class="actions">
      ${x.client.phone && !x.client.noSms ? html`<button class="btn-sm" data-act="sms-direct" data-client="${x.client.id}" data-tpl="due" data-track="${x.track}">SMS</button>` : ''}
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

export function clientsView(q) {
  return html`
    <div class="toolbar">
      <input type="search" id="client-search" placeholder="Search name, phone or email" value="${q}" autocomplete="off">
      <button class="btn primary" data-act="client-new">+ Client</button>
    </div>
    <div id="client-list">${clientList(q)}</div>`;
}

export function clientList(q) {
  const s = String(q || '').toLowerCase().trim();
  const digits = s.replace(/\D/g, '');
  const list = db().clients
    .filter((c) => !s || `${c.firstName} ${c.lastName} ${c.email}`.toLowerCase().includes(s) ||
      (digits.length >= 3 && String(c.phone || '').replace(/\D/g, '').includes(digits)))
    .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  if (!list.length) return empty(s ? 'No matches.' : 'No clients yet. Add one, or import your Google Calendar under More.');
  return html`<div class="list">${list.slice(0, 300).map((c) => {
    const u = mostUrgent(trackStatus(c.id));
    const label = u?.state === 'booked' ? `Booked ${fmtDateShort(u.booked.start)}`
      : u?.next ? `${STATE[u.state]}: ${service(u.next.serviceId)?.name} ${relDays(u.next.date)}` : '';
    return html`<a class="row" href="#/client/${c.id}">
      <div><div class="name">${fullName(c)}</div><div class="sub">${c.phone || c.email || ''}</div></div>
      ${u ? chip(label, u.state) : ''}</a>`;
  })}</div>${list.length > 300 ? html`<p class="hint">Showing 300 of ${list.length}. Search to narrow down.</p>` : ''}`;
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
        ${c.phone && !c.noSms ? html`<button class="btn" data-act="sms" data-client="${c.id}">SMS</button>` : ''}
        <button class="btn" data-act="client-edit" data-id="${c.id}">Edit</button>
      </div>
      ${c.noSms ? html`<p class="hint">Opted out of texts.</p>` : ''}
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

export function reviewView(page = 0) {
  const d = db();
  const PAGE = 40;
  const items = d.review.slice(page * PAGE, page * PAGE + PAGE);
  const matched = d.review.filter((r) => r.suggestion.serviceId && r.suggestion.name).length;
  const unmatched = d.review.filter((r) => !r.suggestion.serviceId).length;
  const opts = db().services;
  const today = startOfDay(new Date());
  return html`
    <section>
      <h2>Import</h2>
      <p class="hint">Google Calendar export (.zip or .ics) from calendar.google.com &gt; Settings &gt; Import &amp; export. Or connect Google under Settings and sync directly.</p>
      <div class="btn-row">
        <label class="btn">Choose export file<input type="file" id="ics-file" accept=".ics,.zip,text/calendar,application/zip" hidden></label>
        ${d.settings.calendarSync ? html`<button class="btn" data-act="sync">Sync Google Calendar</button>` : ''}
      </div>
    </section>
    <section>
      <h2>To review (${d.review.length})</h2>
      ${d.review.length ? html`
        <p class="hint">Each event becomes a visit for that client. Past events are marked done, and "Paid" is ticked by default for old visits. Titles with "cancelled" or "no show" are saved with that status. Names that don't match an existing client create a new one.</p>
        <div class="btn-row">
          <button class="btn primary" data-act="review-accept-all" ${matched ? '' : 'disabled'}>Accept all matched (${matched})</button>
          <button class="btn" data-act="review-ignore-unmatched" ${unmatched ? '' : 'disabled'}>Ignore unmatched (${unmatched})</button>
        </div>
        <datalist id="client-names">${d.clients.map((c) => html`<option value="${fullName(c)}">`)}</datalist>
        ${items.map((r) => {
          const sg = r.suggestion;
          const existing = sg.name && findClientByName(sg.name);
          const past = new Date(r.start) < today;
          return html`<form class="card review" data-form="review" data-key="${r.key}">
            <div class="review-head"><b>${r.allDay ? fmtDate(r.start) : `${fmtDate(r.start)} ${fmtTime(r.start)}`}</b>
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
        ${d.review.length > PAGE ? html`<div class="btn-row center">
          ${page > 0 ? html`<a class="btn" href="#/review/${page - 1}">&lsaquo; Prev</a>` : ''}
          <span class="hint">Page ${page + 1} of ${Math.ceil(d.review.length / PAGE)}</span>
          ${(page + 1) * PAGE < d.review.length ? html`<a class="btn" href="#/review/${page + 1}">Next &rsaquo;</a>` : ''}</div>` : ''}
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
      </div>`)}
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
    <label>Address<input name="address" value="${c.address || ''}" autocomplete="off"></label>
    <div class="grid2">
      <label>Skin type<input name="skinType" value="${c.skinType || ''}" placeholder="e.g. III, medium"></label>
      <label>Pigment mix<input name="pigment" value="${c.pigment || ''}"></label>
    </div>
    <label>Notes<textarea name="notes" rows="4">${c.notes || ''}</textarea></label>
    <label class="check"><input type="checkbox" name="noSms" ${c.noSms ? 'checked' : ''}> Does not want text messages</label>
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

export function smsSheet(c, a, prefer = null) {
  const vars = smsVars(c, a);
  let order = a ? (a.status === 'booked' ? ['reminder', 'confirm'] : ['thanks', 'payment']) : ['due'];
  if (prefer) order = [prefer, ...order];
  const tpls = [...db().templates].sort((x, y) => {
    const ix = order.indexOf(x.id); const iy = order.indexOf(y.id);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  });
  return sheet(`Text ${c.firstName || fullName(c)}`, html`
    <p class="hint">Tap a message to open it in Messages. You can still edit it before sending.</p>
    <div class="list">${tpls.map((t) => html`
      <button class="row sms-opt" data-act="sms-open" data-tpl="${t.id}" data-client="${c.id}" data-appt="${a?.id || ''}">
        <div><div class="name">${t.name}</div><div class="sub">${fill(t.body, vars)}</div></div></button>`)}
      <button class="row sms-opt" data-act="sms-open" data-tpl="" data-client="${c.id}"><div class="name">Blank message</div></button>
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
