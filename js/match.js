// Guess client + service from a calendar event title.
// Tuned for titles like "First Last - service 200", "Name- microblading fb perfecting",
// "Name - touch up 200 and lash lift 50", "Name - microblading (cancelled)".
// Keywords and priority per service are editable under More > Services.

import { db } from './db.js';
import { normName, phoneDigits, titleCase } from './util.js';

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kwRe = (kw, flags = 'i') =>
  new RegExp('(^|[^a-z0-9])' + escRe(kw.toLowerCase()) + '(?=$|[^a-z0-9])', flags);

export function keywordsOf(svc) {
  const list = String(svc.keywords || '').split(',').map((k) => k.trim()).filter((k) => k.length >= 2);
  list.push(svc.name);
  return list;
}

/** Keyword hits in text: highest service priority first, then longest keyword. */
function hits(text) {
  const out = [];
  const t = String(text || '');
  for (const svc of db().services) {
    for (const kw of keywordsOf(svc)) if (kwRe(kw).test(t)) out.push({ svc, kw });
  }
  return out.sort((a, b) => (Number(b.svc.priority) || 0) - (Number(a.svc.priority) || 0) || b.kw.length - a.kw.length);
}

const PHONE_RE = /(?:\+?64[\s-]?|\b0)(?:2\d|[3-9])[\s-]?\d{3,4}[\s-]?\d{3,5}\b/g;

export function findClientByName(name) {
  const n = normName(name);
  if (!n) return null;
  return db().clients.find((c) => normName(`${c.firstName} ${c.lastName}`) === n) || null;
}

export function findClientByPhone(p) {
  const d = phoneDigits(p);
  if (d.length < 8) return null;
  return db().clients.find((c) => c.phone && phoneDigits(c.phone) === d) || null;
}

/** Split "Name - rest" on the first dash. Unspaced dashes only split when a service word follows. */
function splitTitle(title, hasKw) {
  const spaced = title.match(/^(.*?)\s+[-–—]\s*|^(.*?)[-–—]\s+/);
  if (spaced) {
    const name = spaced[1] ?? spaced[2];
    return { name, rest: title.slice(spaced[0].length) };
  }
  const m = title.match(/^([^-–—]+)[-–—](.+)$/);
  if (m && hasKw(m[2])) return { name: m[1], rest: m[2] };
  return { name: null, rest: title };
}

/** Sum bare prices like "touch up 200 and lash lift 50"; ignore deposits, years, phone numbers. */
function findPrice(text) {
  const t = text.replace(PHONE_RE, ' ');
  let sum = 0;
  let found = false;
  const re = /(?:\$\s?)?\b(\d{2,4})(?:\.\d{1,2})?\b(?!\s*(?:th|st|nd|rd|min|mins|%))/gi;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    const before = t.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12).toLowerCase();
    if (n >= 1990 && n <= 2100) continue;
    if (/deposit/.test(before) || /^\s*(deposit|dep\b)/.test(after)) continue;
    if (n < 15 || n > 2000) continue;
    sum += n;
    found = true;
  }
  return found ? sum : null;
}

function cleanName(s) {
  let n = String(s || '')
    .replace(/\([^)]*\)/g, ' ')           // (penciled in), (Mandy's Mum)
    .replace(PHONE_RE, ' ')
    .replace(/\$\s?\d+(\.\d+)?/g, ' ')
    .replace(/\S*\d\S*/g, ' ')            // 100deposit, 4weeks, 2x
    .replace(/\b(fb|procedure|off|no|booking|booked|appt|appointment|paid|cash|eftpos|eft|deposit|new client|txt|text|call|email)\b/gi, ' ')
    .replace(/[|:;,/+@#*✓✔.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  n = n.replace(/\s*&\s*friend\b.*$/i, '').replace(/[&-]+$/g, '').trim();
  // Keep her own capitalisation (McKenzie) unless it is all one case.
  if (n === n.toLowerCase() || n === n.toUpperCase()) n = titleCase(n);
  return n;
}

export function suggest(summary = '') {
  // Multi-line titles ("Name\nLash lift $50 & ...") are treated as "Name - rest".
  const title = String(summary || '').trim().replace(/\s*\n+\s*/g, ' - ');
  const hasKw = (t) => hits(t).length > 0;
  const titleHits = hits(title);
  const best = titleHits[0] || null;

  const phoneM = title.match(PHONE_RE);
  const phone = phoneM ? phoneM[0].replace(/[\s-]/g, '') : '';
  const { name: rawName, rest } = splitTitle(title, hasKw);
  const price = findPrice(rawName === null ? title : rest);
  const paid = /\bpaid\b|✓|✔/i.test(title) && !/deposit\s+paid/i.test(title);
  const status = /\bno[\s-]?show\b/i.test(title) ? 'noshow' : /\bcancel+ed\b/i.test(title) ? 'cancelled' : '';

  let name;
  if (rawName !== null) name = cleanName(rawName);
  else {
    // No dash: remove service words from the title and keep what's left.
    let n = title;
    for (const h of titleHits) n = n.replace(kwRe(h.kw, 'ig'), '$1 ');
    name = cleanName(n.replace(/\b(cancel+ed|no\s?show|and|with|or|maybe)\b/gi, ' '));
  }

  const client = findClientByPhone(phone) || findClientByName(name);
  return {
    serviceId: best?.svc.id || '',
    keyword: best?.kw || '',
    name: client ? `${client.firstName} ${client.lastName}`.trim() : name,
    clientId: client?.id || '',
    phone,
    price,
    paid,
    status,
  };
}
