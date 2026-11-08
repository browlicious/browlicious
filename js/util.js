// Shared helpers: ids, HTML escaping, dates, money, phone numbers.

export const DAY_MS = 86400000;

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---- HTML templating with automatic escaping ----
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s ?? ''));

function part(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}

/** Tagged template: interpolated values are escaped unless produced by html`` or raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += part(vals[i]);
  });
  return new Raw(out);
}

// ---- Dates (all local time) ----
export function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + Number(n || 0)); return x; }
export function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS); }

const F = (o) => new Intl.DateTimeFormat('en-NZ', o);
const fDate = F({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fDateShort = F({ day: 'numeric', month: 'short', year: 'numeric' });
const fDay = F({ weekday: 'long', day: 'numeric', month: 'long' });
const fTime = F({ hour: 'numeric', minute: '2-digit' });

export const fmtDate = (d) => (d ? fDate.format(new Date(d)) : '');
export const fmtDateShort = (d) => (d ? fDateShort.format(new Date(d)) : '');
export const fmtDay = (d) => (d ? fDay.format(new Date(d)) : '');
export const fmtTime = (d) => (d ? fTime.format(new Date(d)).replace(/\s/g, '').toLowerCase() : '');

/** "today", "tomorrow", "in 5 days", "3 weeks ago", ... */
export function relDays(d) {
  const n = daysBetween(new Date(), d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  const a = Math.abs(n);
  let s;
  if (a < 14) s = `${a} days`;
  else if (a < 60) s = `${Math.round(a / 7)} weeks`;
  else if (a < 730) s = `${Math.round(a / 30.4)} months`;
  else s = `${(a / 365).toFixed(1).replace(/\.0$/, '')} years`;
  return n > 0 ? `in ${s}` : `${s} ago`;
}

const pad = (n) => String(n).padStart(2, '0');
export const dateInput = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
export const timeInput = (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
export const fromInputs = (ds, ts) => new Date(`${ds}T${ts || '09:00'}`);
/** 'YYYY-MM-DD' as local midnight (new Date('YYYY-MM-DD') would be UTC). */
export function localDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// ---- Money ----
export function money(n) {
  const v = Number(n) || 0;
  return '$' + (Number.isInteger(v) ? v : v.toFixed(2));
}

// ---- Names / phones ----
export const fullName = (c) => (c ? `${c.firstName || ''} ${c.lastName || ''}`.trim() || '(no name)' : '(deleted client)');
export const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
export const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s-]|\b[a-z]')([a-z])/g, (m, a, b) => a + b.toUpperCase());

/** Normalise an NZ phone number to +64 format for sms:/tel: links. */
export function normPhone(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('0064')) return '+' + s.slice(2);
  if (s.startsWith('64') && s.length > 9) return '+' + s;
  if (s.startsWith('0')) return '+64' + s.slice(1);
  return s;
}
export const phoneDigits = (p) => normPhone(p).replace(/\D/g, '');

/** Android Messages format: sms:+6421...?body=... */
export const smsUrl = (phone, body) => `sms:${normPhone(phone)}?body=${encodeURIComponent(body)}`;
export const telUrl = (phone) => `tel:${normPhone(phone)}`;

/** Replace {placeholders} with values; unknown placeholders are left as-is. */
export const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

/** Plain text from possibly-HTML calendar descriptions (DOMParser does not execute scripts). */
export function stripHtml(s) {
  if (!s || !/[<&]/.test(s)) return s || '';
  const doc = new DOMParser().parseFromString(String(s).replace(/<br\s*\/?>/gi, '\n'), 'text/html');
  return (doc.body.textContent || '').trim();
}

export const byStart = (a, b) => new Date(a.start) - new Date(b.start);
export const byStartDesc = (a, b) => new Date(b.start) - new Date(a.start);
