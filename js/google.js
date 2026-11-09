// Google sign-in (browser token flow, no server), Drive backups and Calendar API.
// Tokens last ~1 hour and are kept only for this browser tab session.

import { db } from './db.js';
import { CONFIG } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',      // only files this app creates
  'https://www.googleapis.com/auth/calendar.events', // read/write events
  'https://www.googleapis.com/auth/contacts.readonly', // read her Google Contacts (never changed)
];
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CAL = 'https://www.googleapis.com/calendar/v3';
const FOLDER_NAME = 'Browlicious Backups';

let token = null;
let exp = 0;
try {
  const t = JSON.parse(sessionStorage.getItem('gtok') || 'null');
  if (t && t.exp > Date.now()) { token = t.token; exp = t.exp; }
} catch { /* storage unavailable */ }

export class NeedsAuth extends Error {
  constructor() { super('Google sign-in needed: tap "Connect Google".'); this.needsAuth = true; }
}

export const clientId = () => (db().settings.googleClientId || CONFIG.googleClientId || '').trim();
export const isConfigured = () => !!clientId();
export const hasToken = () => !!token && Date.now() < exp - 60000;

let gisPromise = null;
export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in (offline?).')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

/** Must be called from a tap (opens Google's consent popup). */
export async function signIn() {
  if (!isConfigured()) throw new Error('Add the Google OAuth client ID in More > Settings first.');
  await loadGis();
  return new Promise((resolve, reject) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPES.join(' '),
      callback: (r) => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES)) {
          reject(new Error('Please tick all the boxes (Drive, Calendar and Contacts) when connecting Google.'));
          return;
        }
        token = r.access_token;
        exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        try { sessionStorage.setItem('gtok', JSON.stringify({ token, exp })); } catch { /* ignore */ }
        resolve(token);
      },
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'Google sign-in was closed.' : (e?.message || 'Google sign-in failed.'))),
    });
    tc.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  const t = token;
  token = null; exp = 0;
  try { sessionStorage.removeItem('gtok'); } catch { /* ignore */ }
  if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
}

async function api(url, { method = 'GET', body, headers = {}, text = false } = {}) {
  if (!hasToken()) throw new NeedsAuth();
  const r = await fetch(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } });
  if (r.status === 401) { signOut(); throw new NeedsAuth(); }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error?.message || msg; } catch { /* not json */ }
    const e = new Error(`Google: ${msg}`);
    e.status = r.status;
    throw e;
  }
  if (r.status === 204) return null;
  return text ? r.text() : r.json();
}
const json = (o) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

// ---------------- Drive backups ----------------

async function folderId() {
  const s = db().settings;
  if (s.driveFolderId) {
    try {
      const f = await api(`${DRIVE}/files/${encodeURIComponent(s.driveFolderId)}?fields=id,trashed`);
      if (!f.trashed) return f.id;
    } catch (e) { if (e.needsAuth) throw e; }
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const list = await api(`${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive`);
  let id = list.files?.[0]?.id;
  if (!id) {
    const f = await api(`${DRIVE}/files?fields=id`, { method: 'POST', ...json({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) });
    id = f.id;
  }
  s.driveFolderId = id; // caller commits
  return id;
}

export async function uploadBackup(content, name) {
  const parent = await folderId();
  const boundary = 'bl' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [parent], mimeType: 'application/json' }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    content + `\r\n--${boundary}--`;
  return api(`${UPLOAD}/files?uploadType=multipart&fields=id,name,createdTime`, {
    method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  });
}

export async function listBackups() {
  const parent = await folderId();
  const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
  const r = await api(`${DRIVE}/files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=files(id,name,createdTime,size)`);
  return r.files || [];
}

export const downloadBackup = (id) => api(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, { text: true });

/** Move backups beyond the newest `keep` to Drive's bin (recoverable for 30 days). */
export async function trimBackups(keep) {
  const files = await listBackups();
  for (const f of files.slice(Math.max(1, keep))) {
    await api(`${DRIVE}/files/${encodeURIComponent(f.id)}`, { method: 'PATCH', ...json({ trashed: true }) });
  }
}

// ---------------- Calendar ----------------

const calPath = () => `${CAL}/calendars/${encodeURIComponent(db().settings.calendarId || 'primary')}/events`;

export async function listEvents(timeMinIso) {
  const all = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '2500', timeMin: timeMinIso });
    if (pageToken) p.set('pageToken', pageToken);
    const r = await api(`${calPath()}?${p}`);
    all.push(...(r.items || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return all;
}

export async function upsertEvent(gcalId, body) {
  if (gcalId) {
    try {
      return await api(`${calPath()}/${encodeURIComponent(gcalId)}`, { method: 'PATCH', ...json(body) });
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e; // deleted in Google: recreate
    }
  }
  return api(calPath(), { method: 'POST', ...json(body) });
}

export async function deleteEvent(gcalId) {
  try {
    await api(`${calPath()}/${encodeURIComponent(gcalId)}`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404 && e.status !== 410) throw e;
  }
}

// ---------------- Contacts (read only) ----------------

/** All of her Google Contacts: [{ name, given, family, phones[], emails[] }]. Kept in memory only. */
export async function listContacts() {
  const out = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({ personFields: 'names,phoneNumbers,emailAddresses', pageSize: '1000' });
    if (pageToken) p.set('pageToken', pageToken);
    const r = await api(`https://people.googleapis.com/v1/people/me/connections?${p}`);
    for (const x of r.connections || []) {
      const n = x.names?.[0] || {};
      out.push({
        name: n.displayName || [n.givenName, n.familyName].filter(Boolean).join(' '),
        given: n.givenName || '', family: n.familyName || '',
        phones: (x.phoneNumbers || []).map((v) => v.value).filter(Boolean),
        emails: (x.emailAddresses || []).map((v) => v.value).filter(Boolean),
      });
    }
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}
