// App bootstrap, router, and all tap/form handlers.

import { load, db, commit, flush, subscribe, requestPersist, client, service, appointment, emptyDb, replaceAll } from './db.js';
import { uid, fromInputs, fill, smsUrl, fullName, money } from './util.js';
import { suggestedPrice, payInfo } from './rules.js';
import { findClientByName } from './match.js';
import { readCalendarFile, parseICS } from './ics.js';
import * as G from './google.js';
import * as S from './sync.js';
import * as V from './views.js';

const view = document.getElementById('view');
const dlg = document.getElementById('sheet');
let route = [];
let clientQuery = '';

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
  const [name = 'home', arg] = route;
  let out;
  let title = '';
  switch (name) {
    case 'bookings': out = V.bookingsView(arg === 'past'); title = 'Bookings'; break;
    case 'clients': out = V.clientsView(clientQuery); title = 'Clients'; break;
    case 'client': out = V.clientView(arg); title = 'Client'; break;
    case 'more': out = V.moreView(); title = 'More'; break;
    case 'lapsed': out = V.lapsedView(); title = 'Lapsed clients'; break;
    case 'services': out = V.servicesView(); title = 'Services'; break;
    case 'templates': out = V.templatesView(); title = 'SMS templates'; break;
    case 'review': out = V.reviewView(Number(arg) || 0); title = 'Calendar import'; break;
    case 'settings': out = V.settingsView(); title = 'Settings'; break;
    default: out = V.homeView();
  }
  // Keep the search box focused while typing.
  const searching = document.activeElement?.id === 'client-search';
  view.innerHTML = String(out);
  document.getElementById('page-title').textContent = title;
  const tab = { home: 'home', bookings: 'bookings', clients: 'clients', client: 'clients' }[name] || 'more';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  if (searching) {
    const s = document.getElementById('client-search');
    s.focus(); s.setSelectionRange(s.value.length, s.value.length);
  }
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

function openSms(c, tplId, a = null, track = null) {
  const t = db().templates.find((x) => x.id === tplId);
  const body = t ? fill(t.body, V.smsVars(c, a, track)) : '';
  c.smsLog = [...(c.smsLog || []), { at: new Date().toISOString(), tpl: tplId || 'blank', apptId: a?.id || null }].slice(-50);
  commit();
  closeSheet();
  window.location.href = smsUrl(c.phone, body);
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
    if (!c?.phone) { toast('No mobile number for this client.', 'error'); return; }
    openSheet(V.smsSheet(c, el.dataset.appt ? appointment(el.dataset.appt) : null));
  },
  'sms-direct': (el) => {
    const c = client(el.dataset.client);
    openSms(c, el.dataset.tpl, null, el.dataset.track || null);
  },
  'sms-open': (el) => {
    const c = client(el.dataset.client);
    openSms(c, el.dataset.tpl, el.dataset.appt ? appointment(el.dataset.appt) : null);
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
  'review-accept-all': () => {
    const items = db().review.filter((r) => r.suggestion.serviceId && r.suggestion.name);
    if (!confirm(`Accept ${items.length} matched events as visits? Past ones will be marked done and paid.`)) return;
    let n = 0;
    for (const r of items) {
      try { S.acceptReview(r.key, { name: r.suggestion.name, serviceId: r.suggestion.serviceId, price: r.suggestion.price ?? '', paid: true, status: r.suggestion.status }); n++; } catch (e) { console.warn(e); }
    }
    commit(); toast(`${n} visits added`);
  },
  'review-ignore-unmatched': () => {
    const items = db().review.filter((r) => !r.suggestion.serviceId);
    if (!confirm(`Ignore ${items.length} events with no recognised service? (Personal events, holidays, etc.)`)) return;
    items.forEach((r) => S.ignoreReview(r.key));
    commit();
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
      noSms: d.noSms === 'on',
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
    if (isNew && c.phone && !c.noSms) openSheet(V.smsSheet(c, a, 'confirm'));
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
    Object.assign(t, { name: d.name.trim(), body: d.body });
    commit(); closeSheet(); toast('Template saved');
  },

  review(f, d) {
    try {
      S.acceptReview(f.dataset.key, { name: d.name, serviceId: d.serviceId, price: d.price, paid: d.paid === 'on' });
      commit();
    } catch (e) { toast(e.message, 'error'); }
  },

  settings(f, d) {
    const s = db().settings;
    const before = s.googleClientId;
    Object.assign(s, {
      businessName: d.businessName.trim(), signature: d.signature.trim(),
      dueWindowDays: num(d.dueWindowDays, 14), lapseAfterDays: num(d.lapseAfterDays, 365),
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
  if (t.id === 'client-search') {
    clientQuery = t.value;
    document.getElementById('client-list').innerHTML = String(V.clientList(clientQuery));
  }
  if (t.name === 'price' && t.form?.dataset.form === 'appt') t.dataset.touched = '1';
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  const f = t.form;
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
  if (autoRunning || !navigator.onLine || !G.hasToken()) return;
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush().catch(() => {});
  else { render(); autoTasks(); }
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
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e));
  }
})();
