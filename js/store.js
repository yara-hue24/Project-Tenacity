// Storage in the browser: saved plans, the history of changes, and the crew's own map marks.
// An IndexedDB database named "tenacity" with three tables. If the browser refuses a database
// (private windows sometimes do), the same tables are kept in memory for the session.

const DB_NAME = 'tenacity';
const TABLES = ['plans', 'history', 'marks'];
const HISTORY_CAP = 200;
let db = null;
const mem = { plans: new Map(), history: new Map(), marks: new Map() };
let memId = 1;

const wrap = (request) => new Promise((ok, fail) => { request.onsuccess = () => ok(request.result); request.onerror = () => fail(request.error); });

export async function openStore() {
  if (typeof indexedDB === 'undefined') return false;
  try {
    db = await new Promise((ok, fail) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains('plans')) d.createObjectStore('plans', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('history')) d.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('marks')) d.createObjectStore('marks', { keyPath: 'id' });
      };
      open.onsuccess = () => ok(open.result);
      open.onerror = () => fail(open.error);
      open.onblocked = () => fail(new Error('blocked'));
    });
    return true;
  } catch { db = null; return false; }
}
export const persistent = () => !!db;

const table = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);

export async function all(name) {
  if (!db) return [...mem[name].values()];
  try { return await wrap(table(name).getAll()); } catch { return [...mem[name].values()]; }
}
// Saves a record and returns its id. A record without an id gets one.
export async function put(name, value) {
  if (!db) {
    const v = { ...value, id: value.id ?? memId++ };
    mem[name].set(v.id, v);
    return v.id;
  }
  try { return await wrap(table(name, 'readwrite').put(value)); } catch { return null; }
}
export async function del(name, id) {
  if (!db) { mem[name].delete(id); return; }
  try { await wrap(table(name, 'readwrite').delete(id)); } catch { /* nothing to remove */ }
}
export async function clear(name) {
  if (!db) { mem[name].clear(); return; }
  try { await wrap(table(name, 'readwrite').clear()); } catch { /* already empty */ }
}

// Keep the history from growing without end: the oldest entries go first.
export async function trimHistory() {
  const rows = await all('history');
  if (rows.length <= HISTORY_CAP) return;
  rows.sort((a, b) => a.id - b.id);
  for (const r of rows.slice(0, rows.length - HISTORY_CAP)) await del('history', r.id);
}

export async function counts() {
  const out = {};
  for (const t of TABLES) out[t] = (await all(t)).length;
  return out;
}
// Everything in one object, for export; and back in, for import.
export async function dump() {
  const out = { format: 'tenacity-export', version: 1, exported_utc: new Date().toISOString() };
  for (const t of TABLES) out[t] = await all(t);
  return out;
}
export async function restore(data) {
  if (!data || data.format !== 'tenacity-export') throw new Error('not a Tenacity export file');
  for (const t of TABLES) {
    if (!Array.isArray(data[t])) continue;
    await clear(t);
    for (const row of data[t]) await put(t, row);
  }
}
