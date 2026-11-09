// Earnings from payments recorded in the app (cash / EFTPOS).
// Visits imported from the old calendar are not included.

import { db, appointment, client, service } from './db.js';
import { payInfo } from './rules.js';
import { fullName, dateInput } from './util.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Year key for a date. Tax year = NZ year 1 April to 31 March, named by its end year. */
export function yearOf(date, mode) {
  const d = new Date(date);
  if (mode === 'tax') return d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
  return d.getFullYear();
}
export const yearLabel = (y, mode) => (mode === 'tax' ? `${y - 1}/${String(y).slice(2)} tax year` : String(y));

/** Months of a year in order: Jan..Dec, or Apr..Mar for the tax year. */
export function monthsOf(y, mode) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const m = mode === 'tax' ? (i + 3) % 12 : i;
    const yy = mode === 'tax' ? (m >= 3 ? y - 1 : y) : y;
    out.push({ key: `${yy}-${String(m + 1).padStart(2, '0')}`, label: `${MONTHS[m]} ${yy}` });
  }
  return out;
}

export function gstPart(amount) {
  const s = db().settings;
  if (!s.gstRegistered) return 0;
  const r = Number(s.gstRate) || 15;
  return Math.round((amount * r / (100 + r)) * 100) / 100;
}

const blank = () => ({ total: 0, cash: 0, eftpos: 0, count: 0 });
function add(b, p) {
  const amt = Number(p.amount) || 0;
  b.total += amt;
  b[p.method === 'cash' ? 'cash' : 'eftpos'] += amt;
  b.count += 1;
}

export function summary(mode, year) {
  const pays = db().payments.filter((p) => p.date);
  const years = new Map();
  const months = new Map();
  const services = new Map();
  for (const p of pays) {
    const y = yearOf(p.date + 'T12:00', mode);
    if (!years.has(y)) years.set(y, blank());
    add(years.get(y), p);
    if (y !== year) continue;
    const mk = p.date.slice(0, 7);
    if (!months.has(mk)) months.set(mk, blank());
    add(months.get(mk), p);
    const sname = service(appointment(p.appointmentId)?.serviceId)?.name || 'Other';
    if (!services.has(sname)) services.set(sname, blank());
    add(services.get(sname), p);
  }
  const owing = db().appointments
    .filter((a) => a.status === 'done')
    .reduce((t, a) => t + payInfo(a).owing, 0);
  return {
    years: [...years.entries()].sort((a, b) => b[0] - a[0]),
    months: monthsOf(year, mode).map((m) => ({ ...m, ...(months.get(m.key) || blank()) })),
    services: [...services.entries()].sort((a, b) => b[1].total - a[1].total),
    yearTotal: years.get(year) || blank(),
    prevTotal: years.get(year - 1) || blank(),
    owing,
  };
}

/** CSV of all payments for the accountant. */
export function paymentsCsv() {
  const rows = [['Date', 'Client', 'Service', 'Method', 'Amount', 'GST', 'Excl GST']];
  const pays = [...db().payments].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const p of pays) {
    const a = appointment(p.appointmentId);
    const g = gstPart(Number(p.amount) || 0);
    rows.push([p.date, fullName(client(p.clientId)), service(a?.serviceId)?.name || '', p.method === 'cash' ? 'Cash' : 'EFTPOS',
      (Number(p.amount) || 0).toFixed(2), g.toFixed(2), ((Number(p.amount) || 0) - g).toFixed(2)]);
  }
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

export function downloadCsv() {
  const blob = new Blob(['﻿' + paymentsCsv()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `browlicious-payments-${dateInput(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
