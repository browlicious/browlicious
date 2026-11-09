// How to reach a client: preferred channel (SMS / Email / Facebook) with fallback,
// and opening a pre-filled message in the right app.

import { db } from './db.js';
import { smsUrl } from './util.js';

export const CHANNELS = { sms: 'SMS', email: 'Email', facebook: 'Facebook' };
const ORDER = ['sms', 'email', 'facebook'];

export function available(c) {
  return { sms: !!c?.phone, email: !!c?.email, facebook: !!c?.facebook };
}

/** Channel to use: the one asked for, else the client's preference, else whatever they have. */
export function channelFor(c, wanted = null) {
  if (!c) return null;
  const av = available(c);
  const pref = wanted || c.preferredContact || db().settings.defaultContact || 'sms';
  if (av[pref]) return pref;
  return ORDER.find((k) => av[k]) || null;
}

export const canMessage = (c) => !!c && !c.noSms && !!channelFor(c);
export const channelLabel = (c) => CHANNELS[channelFor(c)] || 'Message';

export function emailUrl(to, subject, body) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
}

/** Messenger link from a profile URL or username; falls back to the Business Suite inbox. */
export function facebookUrl(fb) {
  const v = String(fb || '').trim();
  if (/^https?:\/\//i.test(v)) {
    const m = v.match(/facebook\.com\/(?:profile\.php\?id=)?([^/?#&]+)/i);
    return m && m[1] !== 'profile.php' ? `https://m.me/${m[1]}` : v;
  }
  if (v) return `https://m.me/${encodeURIComponent(v.replace(/^@/, ''))}`;
  return 'https://business.facebook.com/latest/inbox';
}

/**
 * Open the message in the right app. Facebook can't be pre-filled, so the text is
 * copied to the clipboard first. Returns a short status string for a toast.
 */
export async function openMessage(c, channel, subject, body) {
  if (channel === 'email') {
    window.location.href = emailUrl(c.email, subject, body);
    return 'Opening email...';
  }
  if (channel === 'facebook') {
    let copied = false;
    try { await navigator.clipboard.writeText(body); copied = true; } catch { /* clipboard blocked */ }
    window.open(facebookUrl(c.facebook), '_blank', 'noopener');
    return copied ? 'Message copied. Paste it into Messenger.' : 'Could not copy automatically. Copy the text from the preview.';
  }
  window.location.href = smsUrl(c.phone, body);
  return 'Opening Messages...';
}
