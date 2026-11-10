// App bootstrap, router, and all tap/form handlers.

import { load, db, commit, flush, subscribe, requestPersist, client, service, appointment, emptyDb, replaceAll } from './db.js';
import { uid, fromInputs, fill, smsUrl, fullName, money } from './util.js';
import { suggestedPrice, payInfo } from './rules.js';
import { findClientByName } from './match.js';
import { readCalendarFile, parseICS } from './ics.js';
import * as G from './google.js';
import * as S from './sync.js';
import * as V from './views.js';
import { channelFor, openMessage, canMessage } from './contact.js';
import * as FIN from './finance.js';
import * as GH from './ghstore.js';
import * as CT from './contacts.js';

const view = document.getElementById('view');
const dlg = document.getElementById('sheet');
let route = [];
// Client list search/filter/sort; remembered on this phone between visits.
const clientState = { q: '', filter: 'all', track: 'all', tag: 'all', sort: 'az' };
try { Object.assign(clientState, JSON.parse(localStorage.getItem('clientState') || '{}'), { q: '' }); } catch { /* ignore */ }
function saveClientState() {
  try { localStorage.setItem('clientState', JSON.stringify({ ...clientState, q: '' })); } catch { /* ignore */ }
}
// Review-list filters (colour, dates, matched...), remembered on this phone.
let reviewState = {};
try { reviewState = JSON.parse(localStorage.getItem('reviewState') || '{}'); } catch { /* ignore */ }
function setReviewFilter(patchObj) {
  reviewState = { ...reviewState, ...patchObj };
  try { localStorage.setItem('reviewState', JSON.stringify(reviewState)); } catch { /* ignore */ }
  if (location.hash !== '#/review') location.hash = '#/review'; else render();
}
const reviewShown = () => V.filterReview(db().review, reviewState);

function refreshClientList() {
  const el = document.getElementById('client-list');
  if (el) el.innerHTML = String(V.clientList(clientState));
}

// ---------------- UI helpers ----------------

let toastTimer;
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, kind === 'error' ? 6000 : 3000);
}

function openSheet(markup) {
  dlg.innerHTML = String(markup);
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}
function closeSheet() { if (dlg.open) dlg.close(); }
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); }); // backdrop tap

async function guarded(fn, busyMsg) {
  if (busyMsg) toast(busyMsg + '...');
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error');
    return undefined;
  }
}

async function ensureGoogle() {
  if (G.hasToken()) return;
  await G.signIn();
}

// ---------------- Router ----------------

function parseRoute() { route = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean); }

function render() {
  if (!db()) return; // storage not loaded yet
  const [name = 'home', arg] = route;
  let out;
  let title = '';
  switch (name) {
    case 'bookings': out = V.bookingsView(arg === 'past'); title = 'Bookings'; break;
    case 'clients': out = V.clientsView(clientState); title = 'Clients'; break;
    case 'client': out = V.clientView(arg); title = 'Client'; break;
    case 'more': out = V.moreView(); title = 'More'; break;
    case 'contacts': out = CT.matchesView(); title = 'Google Contacts'; break;
    case 'lapsed': out = V.lapsedView(); title = 'Lapsed clients'; break;
    case 'finance': {
      const mode = arg === 'tax' ? 'tax' : 'calendar';
      const y = Number(route[2]) || FIN.yearOf(new Date(), mode);
      out = V.financeView(mode, y); title = 'Financials'; break;
    }
    case 'services': out = V.servicesView(); title = 'Services'; break;
    case 'templates': out = V.templatesView(); title = 'SMS templates'; break;
    case 'review': out = V.reviewView(Number(arg) || 0, reviewState); title = 'Calendar import'; break;
    case 'settings': out = V.settingsView(); title = 'Settings'; break;
    default: out = V.homeView();
  }
  // Keep the search box focused while typing.
  const focusId = ['client-search', 'review-q'].includes(document.activeElement?.id) ? document.activeElement.id : null;
  view.innerHTML = String(out);
  document.getElementById('page-title').textContent = title;
  const tab = { home: 'home', bookings: 'bookings', clients: 'clients', client: 'clients' }[name] || 'more';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  const s = focusId && document.getElementById(focusId);
  if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  if (name === 'settings') fillStorageInfo();
}

async function fillStorageInfo() {
  const el = document.getElementById('storage-info');
  if (!el) return;
  let persisted = false; let used = '';
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* ignore */ }
  try { const e = await navigator.storage?.estimate?.(); if (e) used = `${(e.usage / 1024 / 1024).toFixed(1)} MB used. `; } catch { /* ignore */ }
  el.textContent = used + (persisted
    ? 'Storage is protected from automatic clean-up.'
    : 'Storage is NOT protected yet. Install the app to the home screen (Chrome menu > Add to Home screen) and keep backups on.');
}

window.addEventListener('hashchange', () => { parseRoute(); closeSheet(); render(); window.scrollTo(0, 0); });
subscribe(() => render());
window.addEventListener('save-error', () => toast('Could not save on this phone! Make a backup file now.', 'error'));

// ---------------- SMS ----------------

/** Open a template as SMS / email / Facebook (preferred channel unless one is given). */
async function openSms(c, tplId, a = null, track = null, channel = null) {
  const ch = channelFor(c, channel);
  if (!ch) { toast('No phone, email or Facebook saved for this client.', 'error'); return; }
  const t = db().templates.find((x) => x.id === tplId);
  const vars = V.smsVars(c, a, track);
  const body = t ? fill(t.body, vars) : '';
  const subject = t ? V.templateSubject(t, vars) : db().settings.businessName;
  c.smsLog = [...(c.smsLog || []), { at: new Date().toISOString(), tpl: tplId || 'blank', apptId: a?.id || null, channel: ch }].slice(-50);
  commit();
  closeSheet();
  toast(await openMessage(c, ch, subject, body));
}

// ---------------- Tap actions ----------------

const actions = {
  go: (el) => { location.hash = el.dataset.href; },
  close: () => closeSheet(),

  'client-new': () => openSheet(V.clientSheet(null)),
  'client-edit': (el) => openSheet(V.clientSheet(client(el.dataset.id))),
  'client-delete': (el) => {
    const c = client(el.dataset.id);
    const d = db();
    const appts = d.appointments.filter((a) => a.clientId === c.id);
    if (!confirm(`Delete ${fullName(c)} and their ${appts.length} visit(s) and payments? This cannot be undone (except from a backup).`)) return;
    appts.forEach((a) => { if (a.status === 'booked') S.queueDelete(a); });
    const ids = new Set(appts.map((a) => a.id));
    d.appointments = d.appointments.filter((a) => !ids.has(a.id));
    d.payments = d.payments.filter((p) => !ids.has(p.appointmentId));
    d.clients = d.clients.filter((x) => x.id !== c.id);
    commit(); closeSheet(); location.hash = '#/clients';
    S.pushSoon({});
  },

  'tag-toggle': (el) => {
    const c = client(el.dataset.id);
    const tag = el.dataset.tag;
    const tags = new Set(c.tags || []);
    if (tags.has(tag)) tags.delete(tag); else tags.add(tag);
    c.tags = [...tags];
    commit();
  },

  'appt-new': (el) => openSheet(V.apptSheet(null, { clientId: el.dataset.client, serviceId: el.dataset.service })),
  'appt-edit': (el) => openSheet(V.apptSheet(appointment(el.dataset.id))),
  'appt-done': (el) => {
    const a = appointment(el.dataset.id);
    a.status = 'done';
    commit();
    if (payInfo(a).owing > 0) openSheet(V.paySheet(a)); else toast('Marked as done');
  },
  'appt-delete': (el) => {
    const a = appointment(el.dataset.id);
    if (!confirm('Delete this booking and its payments? Use Status > Cancelled instead to keep a record.')) return;
    const d = db();
    S.queueDelete(a);
    d.appointments = d.appointments.filter((x) => x.id !== a.id);
    d.payments = d.payments.filter((p) => p.appointmentId !== a.id);
    commit(); closeSheet(); toast('Booking deleted');
    S.pushSoon({});
  },

  pay: (el) => openSheet(V.paySheet(appointment(el.dataset.id))),
  'pay-delete': (el) => {
    if (!confirm('Remove this payment?')) return;
    db().payments = db().payments.filter((p) => p.id !== el.dataset.id);
    commit();
    openSheet(V.apptSheet(appointment(el.dataset.appt)));
  },

  sms: (el) => {
    const c = client(el.dataset.client);
    if (!channelFor(c)) { toast('No phone, email or Facebook saved for this client.', 'error'); return; }
    openSheet(V.smsSheet(c, el.dataset.appt ? appointment(el.dataset.appt) : null));
  },
  'sms-direct': (el) => {
    const c = client(el.dataset.client);
    openSms(c, el.dataset.tpl, null, el.dataset.track || null);
  },
  'sms-open': (el) => {
    const c = client(el.dataset.client);
    openSms(c, el.dataset.tpl, el.dataset.appt ? appointment(el.dataset.appt) : null, null, el.dataset.channel || null);
  },
  'msg-channel': (el) => {
    const c = client(el.dataset.client);
    openSheet(V.smsSheet(c, el.dataset.appt ? appointment(el.dataset.appt) : null, el.dataset.prefer || null, el.dataset.channel));
  },

  'service-new': () => openSheet(V.serviceSheet(null)),
  'service-edit': (el) => openSheet(V.serviceSheet(service(el.dataset.id))),
  'service-delete': (el) => {
    const id = el.dataset.id;
    const used = db().appointments.filter((a) => a.serviceId === id).length;
    if (used) { toast(`Used by ${used} visit(s). Untick "Show when booking" to hide it instead.`, 'error'); return; }
    if (!confirm('Delete this service?')) return;
    const d = db();
    d.services = d.services.filter((s) => s.id !== id);
    d.services.forEach((s) => { s.followUps = (s.followUps || []).filter((f) => f.serviceId !== id); });
    commit(); closeSheet();
  },

  'template-new': () => openSheet(V.templateSheet(null)),
  'template-edit': (el) => openSheet(V.templateSheet(db().templates.find((t) => t.id === el.dataset.id))),
  'template-delete': (el) => {
    if (!confirm('Delete this template?')) return;
    db().templates = db().templates.filter((t) => t.id !== el.dataset.id);
    commit(); closeSheet();
  },

  'review-ignore': (el) => { S.ignoreReview(el.dataset.key); commit(); },
  'review-filter': (el) => setReviewFilter({ [el.dataset.key]: el.dataset.val }),
  'review-filter-clear': () => { reviewState = {}; setReviewFilter({}); },
  'review-ignore-shown': () => {
    const items = reviewShown();
    if (!confirm(`Ignore all ${items.length} events shown by this filter? They won't come back on the next sync.`)) return;
    S.ignoreMany(items.map((r) => r.key));
    commit(); toast(`${items.length} events ignored`);
  },
  'review-accept-all': () => {
    const items = reviewShown().filter((r) => r.suggestion.serviceId && r.suggestion.name);
    if (!confirm(`Accept ${items.length} matched events (shown by the filter) as visits? Past ones will be marked done and paid.`)) return;
    let n = 0;
    for (const r of items) {
      try { S.acceptReview(r.key, { name: r.suggestion.name, serviceId: r.suggestion.serviceId, price: r.suggestion.price ?? '', paid: true, status: r.suggestion.status }); n++; } catch (e) { console.warn(e); }
    }
    commit(); toast(`${n} visits added`);
  },
  'review-ignore-unmatched': () => {
    const items = reviewShown().filter((r) => !r.suggestion.serviceId);
    if (!confirm(`Ignore ${items.length} events (shown by the filter) with no recognised service? (Personal events, holidays, etc.)`)) return;
    S.ignoreMany(items.map((r) => r.key));
    commit(); toast(`${items.length} events ignored`);
  },

  sync: () => guarded(async () => {
    if (!db().settings.calendarSync) { toast('Turn on Google Calendar sync in Settings first.'); location.hash = '#/settings'; return; }
    await ensureGoogle();
    toast('Syncing calendar...');
    const r = await S.syncCalendar();
    toast(`Calendar synced: ${r.pushed} sent, ${r.added} new to review, ${r.updated} moved, ${r.cancelled} cancelled`);
  }),
  'google-connect': () => guarded(async () => { await G.signIn(); toast('Google connected'); render(); }),
  'google-disconnect': () => { G.signOut(); toast('Google disconnected'); render(); },

  'backup-drive': () => guarded(async () => {
    await ensureGoogle();
    toast('Backing up to Google Drive...');
    await S.driveBackupNow();
    toast('Backed up to Google Drive');
  }),
  'restore-drive': () => guarded(async () => {
    await ensureGoogle();
    const files = await G.listBackups();
    commit();
    openSheet(V.restoreSheet(files));
  }),
  'restore-drive-file': (el) => guarded(async () => {
    if (!confirm('Replace ALL data on this phone with this backup?')) return;
    const data = S.parseBackup(await G.downloadBackup(el.dataset.id));
    await S.restoreBackup(data);
    closeSheet(); toast('Backup restored');
  }),
  'contacts-load': () => guarded(async () => {
    await ensureGoogle();
    toast('Reading Google Contacts...');
    const list = await G.listContacts();
    const m = CT.buildMatches(list);
    render();
    toast(`${list.length} contacts read, ${m.length} suggestions`);
  }),
  'gh-sync': () => ghSync({ manual: true }),
  'gh-disconnect': () => {
    if (!confirm('Disconnect GitHub storage on this phone? The token and passphrase are removed from this phone. Data in GitHub is not deleted.')) return;
    GH.disconnect(); toast('GitHub storage disconnected'); render();
  },
  'finance-csv': () => { FIN.downloadCsv(); toast('Payments CSV saved to Downloads'); },
  'backup-file': () => { S.downloadLocalBackup(); toast('Backup file saved to Downloads'); },
  wipe: async () => {
    if (!confirm('Erase ALL clients, visits and payments from this phone?')) return;
    if (prompt('Type ERASE to confirm') !== 'ERASE') return;
    await replaceAll(emptyDb());
    toast('All data erased');
    location.hash = '#/';
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  e.stopPropagation();
  fn(el, e);
});

// ---------------- Forms ----------------

const num = (v, def = 0) => (v === '' || v == null || isNaN(Number(v)) ? def : Number(v));

const forms = {
  client(f, d) {
    const db_ = db();
    let c = f.dataset.id ? client(f.dataset.id) : null;
    const isNew = !c;
    if (isNew) { c = S.newClient(); db_.clients.push(c); }
    Object.assign(c, {
      firstName: d.firstName.trim(), lastName: d.lastName.trim(), phone: d.phone.trim(), email: d.email.trim(),
      address: d.address.trim(), skinType: d.skinType.trim(), pigment: d.pigment.trim(), notes: d.notes,
      noSms: d.noSms === 'on', facebook: d.facebook.trim(), preferredContact: d.preferredContact || 'sms',
    });
    commit(); closeSheet();
    if (isNew) location.hash = `#/client/${c.id}`;
    toast('Client saved');
  },

  appt(f, d) {
    const name = d.clientName.trim();
    let c = findClientByName(name);
    if (!c) {
      if (!confirm(`"${name}" is not an existing client. Create a new client?`)) return;
      const [first, ...rest] = name.split(/\s+/);
      c = S.newClient({ firstName: first, lastName: rest.join(' '), phone: d.newPhone.trim() });
      db().clients.push(c);
    }
    if (!service(d.serviceId)) { toast('Choose a service', 'error'); return; }
    const start = fromInputs(d.date, d.time);
    if (isNaN(start)) { toast('Check the date and time', 'error'); return; }
    let a = f.dataset.id ? appointment(f.dataset.id) : null;
    const isNew = !a;
    const fields = {
      clientId: c.id, serviceId: d.serviceId, start: start.toISOString(),
      durationMin: num(d.durationMin, service(d.serviceId).durationMin),
      price: num(d.price, suggestedPrice(c.id, d.serviceId, start)), notes: d.notes,
    };
    if (isNew) {
      a = { id: uid(), status: 'booked', source: 'app', gcalId: null, icalUid: null, paidHistoric: false, createdAt: new Date().toISOString(), ...fields };
      db().appointments.push(a);
      S.markDirty(a);
    } else {
      const calChanged = a.start !== fields.start || a.durationMin !== fields.durationMin ||
        a.serviceId !== fields.serviceId || a.clientId !== fields.clientId || a.status !== d.status;
      Object.assign(a, fields, { status: d.status });
      if (calChanged) S.markDirty(a);
    }
    commit();
    S.pushSoon(a);
    if (isNew && canMessage(c)) openSheet(V.smsSheet(c, a, 'confirm'));
    else closeSheet();
    toast(isNew ? 'Booked' : 'Saved');
  },

  pay(f, d, submitter) {
    const a = appointment(f.dataset.id);
    const amount = num(d.amount, NaN);
    if (!(amount > 0)) { toast('Enter an amount', 'error'); return; }
    const method = submitter?.value || 'eftpos';
    db().payments.push({ id: uid(), appointmentId: a.id, clientId: a.clientId, amount, method, date: d.date, createdAt: new Date().toISOString() });
    if (a.status === 'booked') a.status = 'done';
    commit(); closeSheet();
    toast(`${money(amount)} ${method === 'cash' ? 'cash' : 'EFTPOS'} recorded`);
  },

  service(f, d) {
    let s = f.dataset.id ? service(f.dataset.id) : null;
    if (!s) { s = { id: uid() }; db().services.push(s); }
    const followUps = [];
    for (let i = 0; i < 10; i++) {
      const sid = d[`fu_service_${i}`]; const days = num(d[`fu_days_${i}`], 0);
      if (sid && days > 0) followUps.push({ serviceId: sid, days });
    }
    Object.assign(s, {
      name: d.name.trim(), track: d.track, durationMin: num(d.durationMin, 60), price: num(d.price),
      lateAfterDays: num(d.lateAfterDays, 0) || null, latePrice: num(d.latePrice, 0) || null,
      keywords: d.keywords, followUps, active: d.active === 'on',
    });
    commit(); closeSheet(); toast('Service saved');
  },

  template(f, d) {
    let t = f.dataset.id ? db().templates.find((x) => x.id === f.dataset.id) : null;
    if (!t) { t = { id: uid() }; db().templates.push(t); }
    Object.assign(t, { name: d.name.trim(), subject: d.subject.trim(), body: d.body });
    commit(); closeSheet(); toast('Template saved');
  },

  review(f, d) {
    try {
      S.acceptReview(f.dataset.key, { name: d.name, serviceId: d.serviceId, price: d.price, paid: d.paid === 'on' });
      commit();
    } catch (e) { toast(e.message, 'error'); }
  },

  contacts(f) {
    const idx = [...f.querySelectorAll('input[name=m]:checked')].map((x) => Number(x.value));
    if (!idx.length) { toast('Nothing ticked'); return; }
    const n = CT.apply(idx);
    commit(); toast(`${n} clients updated`);
  },

  async github(f, d) {
    const c = GH.config();
    const pass = d.passphrase || '';
    if (pass && pass.length < 10) { toast('Passphrase must be at least 10 characters.', 'error'); return; }
    if (pass && !c.passphrase && pass !== d.passphrase2) { toast('Passphrases do not match.', 'error'); return; }
    if (!d.token && !c.token) { toast('Paste the GitHub access token.', 'error'); return; }
    if (!pass && !c.passphrase) { toast('Choose an encryption passphrase.', 'error'); return; }
    const changedTarget = d.owner.trim() !== c.owner || d.repo.trim() !== c.repo;
    GH.saveConfig({
      owner: d.owner.trim(), repo: d.repo.trim(),
      ...(d.token ? { token: d.token.trim() } : {}),
      ...(pass ? { passphrase: pass } : {}),
    });
    if (changedTarget || pass || d.token) { try { localStorage.removeItem('ghState'); } catch { /* ignore */ } }
    toast('Connecting to GitHub...');
    await ghSync({ manual: true });
  },

  settings(f, d) {
    const s = db().settings;
    const before = s.googleClientId;
    Object.assign(s, {
      businessName: d.businessName.trim(), signature: d.signature.trim(),
      dueWindowDays: num(d.dueWindowDays, 14), lapseAfterDays: num(d.lapseAfterDays, 365),
      clientTags: [...new Set(String(d.clientTags || '').split(',').map((x) => x.trim()).filter(Boolean))],
      googleClientId: d.googleClientId.trim(),
      calendarSync: d.calendarSync === 'on', calendarId: d.calendarId.trim() || 'primary', importFrom: d.importFrom || '2015-01-01',
      driveBackup: d.driveBackup === 'on', backupIntervalHours: num(d.backupIntervalHours, 24), backupKeep: num(d.backupKeep, 30),
    });
    if (s.googleClientId !== before) { G.signOut(); if (s.googleClientId) G.loadGis().catch(() => {}); }
    commit(); toast('Settings saved');
  },
};

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  forms[f.dataset.form]?.(f, d, e.submitter);
});

// ---------------- Live inputs ----------------

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'review-q') { clearTimeout(window.__rq); window.__rq = setTimeout(() => setReviewFilter({ q: t.value }), 300); }
  if (t.id === 'client-search') {
    clientState.q = t.value;
    refreshClientList();
  }
  if (t.name === 'price' && t.form?.dataset.form === 'appt') t.dataset.touched = '1';
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  const f = t.form;
  const m = /^client-(filter|track|tag|sort)$/.exec(t.id || '');
  if (m) { clientState[m[1]] = t.value; saveClientState(); refreshClientList(); return; }
  const rv = /^review-(from|to|when|match|repeat)$/.exec(t.id || '');
  if (rv) { setReviewFilter({ [rv[1]]: t.value }); return; }
  if (t.id === 'finance-year') { location.hash = `#/finance/${t.dataset.mode}/${t.value}`; return; }
  if (t.id === 'finance-gst') { db().settings.gstRegistered = t.checked; commit(); return; }
  if (f?.dataset.form === 'appt' && ['serviceId', 'date', 'clientName'].includes(t.name)) {
    const svc = service(f.serviceId.value);
    const c = findClientByName(f.clientName.value);
    f.querySelector('.new-only').style.display = c ? 'none' : '';
    if (!svc) return;
    if (t.name === 'serviceId') f.durationMin.value = svc.durationMin;
    const start = fromInputs(f.date.value, f.time.value);
    const price = suggestedPrice(c?.id, svc.id, start, f.dataset.id || null);
    if (!f.price.dataset.touched) f.price.value = price;
    document.getElementById('price-hint').textContent =
      svc.latePrice && price === Number(svc.latePrice) ? `Higher price applies: last visit was more than ${svc.lateAfterDays} days earlier.` : '';
  }

  if (t.id === 'ics-file' && t.files[0]) {
    await guarded(async () => {
      const files = await readCalendarFile(t.files[0]);
      const events = files.flatMap((x) => parseICS(x.text));
      const r = S.ingest(events);
      commit();
      toast(`${events.length} events read: ${r.added} new to review, ${r.linked} already linked`);
    }, 'Reading calendar');
    t.value = '';
  }

  if (t.id === 'restore-file' && t.files[0]) {
    await guarded(async () => {
      const data = S.parseBackup(await t.files[0].text());
      if (!confirm(`Replace ALL data on this phone with this backup (${data.clients.length} clients, ${data.appointments.length} visits)?`)) return;
      await S.restoreBackup(data);
      toast('Backup restored');
    });
    t.value = '';
  }
});

// ---------------- Background-ish tasks (only while the app is open) ----------------

let autoRunning = false;
async function autoTasks() {
  if (!db() || autoRunning || !navigator.onLine || !G.hasToken()) return;
  autoRunning = true;
  const s = db().settings;
  try {
    if (s.calendarSync) {
      const last = s.lastCalendarSyncAt ? new Date(s.lastCalendarSyncAt).getTime() : 0;
      if (Date.now() - last > 10 * 60 * 1000) {
        const r = await S.syncCalendar();
        if (r.added) toast(`${r.added} new calendar events to review`);
      }
    }
    if (s.driveBackup && S.backupDue()) await S.driveBackupNow();
  } catch (e) {
    console.warn('Auto task failed', e);
  } finally {
    autoRunning = false;
  }
}

// ---------------- Encrypted GitHub copy ----------------

async function resolveConflict(e) {
  const when = e.remoteData?.meta?.updatedAt ? new Date(e.remoteData.meta.updatedAt).toLocaleString('en-NZ') : 'unknown time';
  const useRemote = confirm(
    `GitHub has data saved from another device (${when}), and this phone also has unsaved changes.\n\n` +
    'OK = load the GitHub version (a backup file of this phone is saved first)\n' +
    "Cancel = keep this phone's version and overwrite GitHub");
  if (useRemote) {
    S.downloadLocalBackup();
    await GH.acceptRemote(e.remoteData);
    toast('Loaded data from GitHub');
  } else {
    await GH.push({ force: true });
    toast("Saved this phone's data to GitHub");
  }
  render();
}

/** Pull GitHub's copy if it changed, then push local changes. */
async function ghSync({ manual = false } = {}) {
  if (!GH.isConfigured() || !navigator.onLine) {
    if (manual) toast(GH.isConfigured() ? 'Offline: will save to GitHub when back online.' : 'GitHub storage is not set up.');
    return;
  }
  try {
    const r = await GH.pull();
    if (r === 'loaded') toast('Loaded latest data from GitHub');
    if (GH.hasPending() || r === 'empty') await GH.push();
    if (manual) toast('Saved to GitHub');
  } catch (e) {
    if (e.conflict) { await resolveConflict(e).catch((x) => { GH.recordError(x); toast(x.message, 'error'); }); return; }
    console.warn('GitHub sync failed', e);
    GH.recordError(e);
    if (manual) toast(e.message, 'error');
  } finally {
    if (route[0] === 'settings' || !route[0]) render();
  }
}

// Save to GitHub about a minute after the last change, and when the app is put away.
let ghTimer = null;
subscribe(() => {
  if (!GH.hasPending()) return;
  clearTimeout(ghTimer);
  ghTimer = setTimeout(() => ghSync(), 60 * 1000);
});

document.addEventListener('visibilitychange', () => {
  if (!db()) return;
  if (document.visibilityState === 'hidden') {
    flush().catch(() => {});
    if (GH.hasPending()) { clearTimeout(ghTimer); ghSync(); }
  } else { render(); autoTasks(); ghSync(); }
});

// ---------------- Boot ----------------

(async function boot() {
  try {
    await load();
  } catch (e) {
    view.innerHTML = '<p class="empty">Could not open storage on this device. Is private browsing on?</p>';
    console.error(e);
    return;
  }
  requestPersist();
  parseRoute();
  render();
  if (G.isConfigured()) G.loadGis().catch(() => {});
  autoTasks();
  setInterval(autoTasks, 15 * 60 * 1000);
  ghSync();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e));
  }
})();
