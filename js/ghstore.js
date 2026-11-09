// Encrypted copy of the app data in a PRIVATE GitHub repo.
//
// - The token and passphrase are kept only on this phone (localStorage), never in the
//   app data, the Drive backup, or the public repo.
// - Data is gzipped, then encrypted with AES-256-GCM using a key derived from the
//   passphrase (PBKDF2-SHA256). GitHub only ever sees ciphertext.
// - Each save replaces the branch with a single new commit (force push), so old copies
//   don't pile up in git history. Version history lives in the Google Drive backups.

import { db, replaceAll } from './db.js';

const API = 'https://api.github.com';
const ITER = 310000;
const CFG_KEY = 'ghConfig';
const STATE_KEY = 'ghState';

const DEFAULTS = { owner: 'browlicious', repo: 'browlicious-data', branch: 'main', path: 'browlicious-data.enc.json', token: '', passphrase: '' };

function readLS(k, def) { try { return { ...def, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return { ...def }; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } }

export const config = () => readLS(CFG_KEY, DEFAULTS);
export const state = () => readLS(STATE_KEY, {});
export function saveConfig(c) { writeLS(CFG_KEY, { ...config(), ...c }); }
function saveState(s) { writeLS(STATE_KEY, { ...state(), ...s }); }
export function disconnect() {
  try { localStorage.removeItem(CFG_KEY); localStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
}
export const isConfigured = () => { const c = config(); return !!(c.token && c.passphrase && c.owner && c.repo); };
export const hasPending = () => isConfigured() && (db().meta.updatedAt || 0) > (state().pushedUpdatedAt || 0);

// ---------------- crypto ----------------

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(obj, pass) {
  const gz = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('gzip'));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz));
  return JSON.stringify({
    app: 'browlicious', v: 1, enc: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: ITER, gzip: true,
    savedAt: new Date().toISOString(), salt: b64(salt), iv: b64(iv), data: b64(ct),
  });
}

export async function decrypt(text, pass) {
  let env;
  try { env = JSON.parse(text); } catch { throw new Error('The GitHub data file is not readable.'); }
  if (env?.app !== 'browlicious' || !env.data) throw new Error('The GitHub data file is not a Browlicious file.');
  const key = await deriveKey(pass, unb64(env.salt));
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.data)));
  } catch {
    throw new Error('Wrong passphrase: could not decrypt the data in GitHub.');
  }
  if (env.gzip) plain = await pipe(plain, new DecompressionStream('gzip'));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------------- GitHub API ----------------

async function gh(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const c = config();
  const r = await fetch(`${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const exp = r.headers.get('github-authentication-token-expiration');
  if (exp) saveState({ tokenExpires: exp });
  if (r.status === 404) {
    if (method === 'GET') return null;
    const e = new Error(`GitHub repo ${c.owner}/${c.repo} not found, or the token cannot write to it.`);
    e.status = 404;
    throw e;
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).message || msg; } catch { /* not json */ }
    if (r.status === 401) msg = 'GitHub token is invalid or expired. Create a new one and paste it in Settings.';
    if (r.status === 403) msg = `GitHub refused access (${msg}). Check the token has Contents: Read and write on the data repo.`;
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return accept.includes('raw') ? r.text() : r.json();
}

async function checkRepo() {
  const c = config();
  const r = await fetch(`${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, {
    headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json' }, cache: 'no-store',
  });
  if (r.status === 401) throw new Error('GitHub token is invalid or expired. Create a new one and paste it in Settings.');
  if (r.status === 404) throw new Error(`GitHub repo ${c.owner}/${c.repo} not found, or the token has no access to it.`);
  if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
  const info = await r.json();
  if (!info.private) throw new Error(`${c.owner}/${c.repo} is PUBLIC. Client data must only go to a private repo, so nothing was saved.`);
}

async function headCommit() {
  const ref = await gh(`/git/ref/heads/${encodeURIComponent(config().branch)}`);
  return ref?.object?.sha || null;
}

async function readRemote() {
  const c = config();
  return gh(`/contents/${c.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(c.branch)}`,
    { accept: 'application/vnd.github.raw+json' });
}

const README = '# Browlicious data\n\nEncrypted app data for the Browlicious client app. Do not edit by hand.\n' +
  'Each save replaces the previous commit; history is kept in the Google Drive backups.\n';

async function writeRemote(envText, parentSha) {
  const c = config();
  const blob = await gh('/git/blobs', { method: 'POST', body: { content: envText, encoding: 'utf-8' } });
  const tree = await gh('/git/trees', {
    method: 'POST',
    body: { tree: [
      { path: c.path, mode: '100644', type: 'blob', sha: blob.sha },
      { path: 'README.md', mode: '100644', type: 'blob', content: README },
    ] },
  });
  const commit = await gh('/git/commits', {
    method: 'POST',
    body: { message: `Save data ${new Date().toISOString()}`, tree: tree.sha, parents: [] },
  });
  if (parentSha) {
    await gh(`/git/refs/heads/${encodeURIComponent(c.branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: true } });
  } else {
    await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/${c.branch}`, sha: commit.sha } });
  }
  return commit.sha;
}

// ---------------- sync ----------------

export class Conflict extends Error {
  constructor(remoteData) {
    super('GitHub has data saved from another device that this phone has not loaded.');
    this.conflict = true;
    this.remoteData = remoteData;
  }
}

let busy = null;
const once = (fn) => async (...a) => { while (busy) await busy.catch(() => {}); busy = fn(...a); try { return await busy; } finally { busy = null; } };

/** Save this phone's data to GitHub (unless GitHub has newer, unseen data). */
export const push = once(async ({ force = false } = {}) => {
  if (!isConfigured()) return false;
  await checkRepo();
  const st = state();
  const head = await headCommit();
  if (head && st.commitSha && head !== st.commitSha && !force) {
    const remoteText = await readRemote();
    if (remoteText) throw new Conflict(await decrypt(remoteText, config().passphrase));
  }
  const updatedAt = db().meta.updatedAt;
  const sha = await writeRemote(await encrypt(db(), config().passphrase), head);
  saveState({ commitSha: sha, pushedUpdatedAt: updatedAt, lastPushAt: new Date().toISOString(), lastError: null });
  return true;
});

/**
 * Load GitHub's copy if it changed since our last sync. Returns 'unchanged', 'loaded',
 * 'empty' (nothing in GitHub yet) or throws Conflict when both sides changed.
 */
export const pull = once(async ({ force = false } = {}) => {
  if (!isConfigured()) return 'off';
  await checkRepo();
  const head = await headCommit();
  const st = state();
  if (head && head === st.commitSha && !force) return 'unchanged';
  const text = await readRemote();
  if (!text) return 'empty';
  const remote = await decrypt(text, config().passphrase);
  const localEmpty = !db().clients.length && !db().appointments.length;
  const localChanged = (db().meta.updatedAt || 0) > (st.pushedUpdatedAt || 0);
  if (!force && localChanged && !localEmpty && st.commitSha) throw new Conflict(remote);
  if (!force && localChanged && !localEmpty && !st.commitSha) throw new Conflict(remote); // first connect with data on both sides
  await replaceAll(remote);
  saveState({ commitSha: head, pushedUpdatedAt: remote.meta?.updatedAt || 0, lastPullAt: new Date().toISOString(), lastError: null });
  return 'loaded';
});

/** Use GitHub's version (after a conflict). */
export async function acceptRemote(remote) {
  const head = await headCommit();
  await replaceAll(remote);
  saveState({ commitSha: head, pushedUpdatedAt: remote.meta?.updatedAt || 0, lastPullAt: new Date().toISOString(), lastError: null });
}

export function recordError(e) { saveState({ lastError: e?.message || String(e), lastErrorAt: new Date().toISOString() }); }
