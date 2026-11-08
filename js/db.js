// Local storage: the whole dataset lives in one IndexedDB record on the phone.
// Small business volumes (hundreds of clients, thousands of visits) fit easily.

import { DEFAULT_SERVICES, DEFAULT_TEMPLATES, DEFAULT_SETTINGS } from './defaults.js';

const DB_NAME = 'browlicious';
const STORE = 'kv';
const KEY = 'db';
const SCHEMA = 1;

let state = null;
let conn = null;
let timer = null;
const listeners = new Set();

function open() {
  if (conn) return Promise.resolve(conn);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => { conn = r.result; resolve(conn); };
    r.onerror = () => reject(r.error);
  });
}

async function idbGet() {
  const c = await open();
  return new Promise((resolve, reject) => {
    const req = c.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(v) {
  const c = await open();
  return new Promise((resolve, reject) => {
    const tx = c.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(v, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function emptyDb() {
  return {
    schema: SCHEMA,
    clients: [],
    appointments: [],
    payments: [],
    services: structuredClone(DEFAULT_SERVICES),
    templates: structuredClone(DEFAULT_TEMPLATES),
    settings: { ...DEFAULT_SETTINGS },
    review: [],        // calendar events waiting to be matched to client + service
    ignored: [],       // event keys the user chose to ignore
    gcalDeletes: [],   // Google event ids to delete on next sync
    meta: { createdAt: new Date().toISOString(), updatedAt: Date.now() },
  };
}

/** Fill in anything missing (older backups, new fields). */
export function normalise(d) {
  const base = emptyDb();
  for (const k of Object.keys(base)) if (d[k] === undefined) d[k] = base[k];
  d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
  d.schema = SCHEMA;
  return d;
}

export async function load() {
  const stored = await idbGet();
  state = normalise(stored || emptyDb());
  if (!stored) await idbPut(state);
  return state;
}

export const db = () => state;

/** Replace in-memory state without saving (used by tests). */
export function setDb(d) { state = normalise(d); }

/** Call after any change: re-renders the UI and saves shortly after. */
export function commit() {
  state.meta.updatedAt = Date.now();
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch(reportSaveError), 200);
  listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
}

export async function flush() {
  clearTimeout(timer);
  timer = null;
  await idbPut(state);
}

function reportSaveError(e) {
  console.error('Save failed', e);
  window.dispatchEvent(new CustomEvent('save-error', { detail: e }));
}

export async function replaceAll(d) {
  state = normalise(d);
  await idbPut(state);
  listeners.forEach((f) => f());
}

export function subscribe(f) { listeners.add(f); return () => listeners.delete(f); }

/** Ask Chrome not to evict our storage. Granted automatically for installed PWAs. */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

// ---- lookups ----
export const client = (id) => state.clients.find((c) => c.id === id);
export const service = (id) => state.services.find((s) => s.id === id);
export const appointment = (id) => state.appointments.find((a) => a.id === id);
export const paymentsFor = (apptId) => state.payments.filter((p) => p.appointmentId === apptId);
