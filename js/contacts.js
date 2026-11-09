// Match Google Contacts to clients and suggest missing phone numbers / emails.
// Contacts are read only, held in memory for the review screen, and never saved.

import { db } from './db.js';
import { normName, phoneDigits, fullName, html } from './util.js';

let lastMatches = [];
export const matches = () => lastMatches;

/**
 * Build suggestions. Strong = same phone number or same full name.
 * Possible = client has only a first name and exactly one contact has that first name.
 */
export function buildMatches(contacts) {
  const byPhone = new Map();
  const byName = new Map();
  const byGiven = new Map();
  for (const ct of contacts) {
    for (const p of ct.phones) { const d = phoneDigits(p); if (d.length >= 8) byPhone.set(d, ct); }
    const n = normName(ct.name);
    if (n) (byName.get(n) || byName.set(n, []).get(n)).push(ct);
    const g = normName(ct.given || ct.name.split(' ')[0]);
    if (g) (byGiven.get(g) || byGiven.set(g, []).get(g)).push(ct);
  }

  const out = [];
  for (const c of db().clients) {
    let ct = null; let strength = '';
    const d = phoneDigits(c.phone);
    if (d.length >= 8 && byPhone.has(d)) { ct = byPhone.get(d); strength = 'phone'; }
    if (!ct) {
      const list = byName.get(normName(fullName(c))) || [];
      if (list.length === 1) { ct = list[0]; strength = 'name'; }
    }
    if (!ct && !c.lastName) {
      const list = byGiven.get(normName(c.firstName)) || [];
      if (list.length === 1) { ct = list[0]; strength = 'possible'; }
    }
    if (!ct) continue;
    const changes = {};
    if (!c.phone && ct.phones[0]) changes.phone = ct.phones[0];
    if (!c.email && ct.emails[0]) changes.email = ct.emails[0];
    if (!c.lastName && strength === 'possible' && ct.family) changes.lastName = ct.family;
    if (!Object.keys(changes).length) continue;
    out.push({ clientId: c.id, clientName: fullName(c), contactName: ct.name, strength, changes });
  }
  lastMatches = out.sort((a, b) => (a.strength === 'possible') - (b.strength === 'possible') || a.clientName.localeCompare(b.clientName));
  return lastMatches;
}

export function apply(selectedIdx) {
  const d = db();
  let n = 0;
  for (const i of selectedIdx) {
    const m = lastMatches[i];
    const c = m && d.clients.find((x) => x.id === m.clientId);
    if (!c) continue;
    for (const [k, v] of Object.entries(m.changes)) if (!c[k]) c[k] = v; // never overwrite existing details
    n++;
  }
  lastMatches = [];
  return n;
}

const LABEL = { phone: 'Mobile', email: 'Email', lastName: 'Last name' };
const WHY = { phone: 'same phone number', name: 'same name', possible: 'possible: first name only' };

export function matchesView() {
  const list = lastMatches;
  return html`
    <p class="hint">Reads her Google Contacts (nothing in Contacts is changed) and suggests details that clients are missing. Existing client details are never overwritten. "Possible" matches are unticked: check those yourself.</p>
    <div class="btn-row"><button class="btn primary" data-act="contacts-load">Read Google Contacts</button></div>
    ${list.length ? html`<form data-form="contacts">
      <div class="list">${list.map((m, i) => html`
        <label class="row check-row"><input type="checkbox" name="m" value="${i}" ${m.strength === 'possible' ? '' : 'checked'}>
          <div><div class="name">${m.clientName} <span class="muted">← ${m.contactName}</span></div>
          <div class="sub">${Object.entries(m.changes).map(([k, v]) => `${LABEL[k]}: ${v}`).join(' · ')}</div>
          <div class="sub muted">${WHY[m.strength]}</div></div></label>`)}</div>
      <div class="sticky-save"><button class="btn primary wide" type="submit">Update ticked clients</button></div>
    </form>` : html`<p class="empty">No suggestions yet. Tap "Read Google Contacts".</p>`}`;
}
