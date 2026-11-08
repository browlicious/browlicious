// Business rules: what is due next, payment status, suggested prices.

import { db, service, paymentsFor } from './db.js';
import { addDays, startOfDay, daysBetween } from './util.js';

export const isActive = (a) => a.status !== 'cancelled' && a.status !== 'noshow';

export function clientAppts(clientId) {
  return db().appointments
    .filter((a) => a.clientId === clientId)
    .sort((a, b) => new Date(b.start) - new Date(a.start));
}

/**
 * Per service track (brow tattoo / lashes / brow styling) for one client:
 *  last   - most recent visit that happened (done, or booked in the past and not closed off)
 *  booked - next future booking in this track
 *  next   - { serviceId, date } of what is due next
 *  state  - booked | ok | due | overdue | lapsed
 */
export function trackStatus(clientId, now = new Date()) {
  const s = db().settings;
  const today = startOfDay(now);
  const byTrack = new Map();
  for (const a of clientAppts(clientId)) {
    if (!isActive(a)) continue;
    const t = service(a.serviceId)?.track || 'none';
    if (t === 'none') continue;
    if (!byTrack.has(t)) byTrack.set(t, []);
    byTrack.get(t).push(a);
  }

  const out = [];
  for (const [track, list] of byTrack) {
    const booked = list
      .filter((a) => a.status === 'booked' && new Date(a.start) >= today)
      .sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
    const last = list.find((a) => new Date(a.start) < today || a.status === 'done') || null;

    let next = null;
    if (last) {
      const cands = (service(last.serviceId)?.followUps || [])
        .filter((f) => service(f.serviceId))
        .map((f) => ({ serviceId: f.serviceId, date: addDays(startOfDay(last.start), Number(f.days) || 0) }))
        .sort((a, b) => a.date - b.date);
      if (cands.length) {
        // Latest follow-up whose date has passed wins; otherwise the earliest upcoming one.
        next = cands[0];
        for (const c of cands) if (c.date <= today) next = c;
      }
    }

    let state = 'none';
    let days = null;
    if (next) days = daysBetween(today, next.date);
    if (booked) state = 'booked';
    else if (next) {
      if (days > s.dueWindowDays) state = 'ok';
      else if (days >= 0) state = 'due';
      else if (-days > s.lapseAfterDays) state = 'lapsed';
      else state = 'overdue';
    }
    out.push({ track, last, booked, next, state, days });
  }
  return out;
}

const URGENCY = { overdue: 0, due: 1, booked: 2, ok: 3, lapsed: 4, none: 5 };
export function mostUrgent(tracks) {
  return [...tracks].sort((a, b) => URGENCY[a.state] - URGENCY[b.state])[0] || null;
}

export function payInfo(a) {
  const paid = paymentsFor(a.id).reduce((t, p) => t + (Number(p.amount) || 0), 0);
  const price = Number(a.price) || 0;
  let status;
  if (a.paidHistoric) status = 'paid';
  else if (price <= 0) status = paid > 0 ? 'paid' : 'free';
  else if (paid >= price) status = 'paid';
  else if (paid > 0) status = 'part';
  else status = 'unpaid';
  const owing = a.paidHistoric ? 0 : Math.max(0, price - paid);
  return { paid, price, owing, status };
}

/** Price for a new booking, applying the "after 12 months" touch-up price. */
export function suggestedPrice(clientId, serviceId, date, excludeApptId = null) {
  const svc = service(serviceId);
  if (!svc) return 0;
  if (svc.lateAfterDays && svc.latePrice && clientId) {
    const before = startOfDay(date);
    const prev = clientAppts(clientId).find((a) =>
      a.id !== excludeApptId && isActive(a) &&
      service(a.serviceId)?.track === svc.track && new Date(a.start) < before);
    if (!prev || daysBetween(prev.start, date) > svc.lateAfterDays) return Number(svc.latePrice);
  }
  return Number(svc.price) || 0;
}
