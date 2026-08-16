// store.js — on-device persistence (IndexedDB) plus JSON backup/restore.
//
// Everything lives on the phone. There is no server and no account; the export
// file is the only way data leaves the device, and the only way it comes back.

const DB_NAME = 'songs-scroll';
const DB_VERSION = 1;
const SONGS = 'songs';
const SETLISTS = 'setlists';
const PREFS = 'prefs';

export const DEFAULT_SETTINGS = {
  speed: 28,          // px per second
  fontSize: 20,       // px
  lineHeight: 1.75,
  transpose: 0,       // semitones
  capo: 0,            // fret
  accidentals: 'auto', // 'auto' | 'sharp' | 'flat'
  showChords: true,
  leadIn: 3,          // seconds of countdown before scrolling starts
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SONGS)) db.createObjectStore(SONGS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SETLISTS)) db.createObjectStore(SETLISTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PREFS)) db.createObjectStore(PREFS, { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function newId() {
  // Random enough for local records; avoids requiring crypto.randomUUID.
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

export const getSongs = () => tx(SONGS, 'readonly', s => s.getAll()).then(sortByTitle);
export const getSong = (id) => tx(SONGS, 'readonly', s => s.get(id));
export const deleteSong = (id) => tx(SONGS, 'readwrite', s => s.delete(id));

export function saveSong(song) {
  const now = new Date().toISOString();
  const record = {
    id: song.id || newId(),
    title: (song.title || '').trim() || 'Untitled',
    artist: (song.artist || '').trim(),
    key: (song.key || '').trim(),
    format: song.format || 'auto',
    body: song.body || '',
    settings: { ...DEFAULT_SETTINGS, ...(song.settings || {}) },
    createdAt: song.createdAt || now,
    updatedAt: now,
  };
  return tx(SONGS, 'readwrite', s => s.put(record)).then(() => record);
}

function sortByTitle(list) {
  return (list || []).sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

// ---------------------------------------------------------------------------
// Setlists
// ---------------------------------------------------------------------------

export const getSetlists = () => tx(SETLISTS, 'readonly', s => s.getAll())
  .then(l => (l || []).sort((a, b) => a.name.localeCompare(b.name)));
export const getSetlist = (id) => tx(SETLISTS, 'readonly', s => s.get(id));
export const deleteSetlist = (id) => tx(SETLISTS, 'readwrite', s => s.delete(id));

export function saveSetlist(setlist) {
  const now = new Date().toISOString();
  const record = {
    id: setlist.id || newId(),
    name: (setlist.name || '').trim() || 'Untitled set',
    songIds: setlist.songIds || [],
    createdAt: setlist.createdAt || now,
    updatedAt: now,
  };
  return tx(SETLISTS, 'readwrite', s => s.put(record)).then(() => record);
}

// ---------------------------------------------------------------------------
// Preferences (global defaults for new songs)
// ---------------------------------------------------------------------------

export function getPrefs() {
  return tx(PREFS, 'readonly', s => s.get('app'))
    .then(r => ({ defaults: { ...DEFAULT_SETTINGS }, ...(r ? r.v : {}) }));
}

export function savePrefs(prefs) {
  return tx(PREFS, 'readwrite', s => s.put({ k: 'app', v: prefs })).then(() => prefs);
}

// ---------------------------------------------------------------------------
// Backup / restore
//
// iOS can evict web storage, and phones get replaced. This export is the user's
// only safety net, so it carries everything needed to rebuild the library.
// ---------------------------------------------------------------------------

export async function exportAll() {
  const [songs, setlists, prefs] = await Promise.all([getSongs(), getSetlists(), getPrefs()]);
  return {
    app: 'songs-scroll',
    version: 1,
    exportedAt: new Date().toISOString(),
    songs,
    setlists,
    prefs,
  };
}

/**
 * Merge a backup into the current library.
 * `mode` is 'merge' (keep existing, add/update by id) or 'replace'.
 * Returns counts so the UI can report what actually happened.
 */
export async function importAll(data, mode = 'merge') {
  if (!data || data.app !== 'songs-scroll' || !Array.isArray(data.songs)) {
    throw new Error('That file is not a Songs Scroll backup.');
  }
  const db = await openDb();

  if (mode === 'replace') {
    await new Promise((resolve, reject) => {
      const t = db.transaction([SONGS, SETLISTS], 'readwrite');
      t.objectStore(SONGS).clear();
      t.objectStore(SETLISTS).clear();
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }

  const existing = new Set((await getSongs()).map(s => s.id));
  let added = 0, updated = 0;
  for (const song of data.songs) {
    if (!song || !song.body) continue;
    if (existing.has(song.id)) updated++; else added++;
    await saveSong({ ...song, id: song.id || newId() });
  }

  let sets = 0;
  for (const sl of data.setlists || []) {
    if (!sl || !sl.name) continue;
    await saveSetlist(sl);
    sets++;
  }

  if (data.prefs) await savePrefs(data.prefs);
  return { added, updated, setlists: sets };
}

/** Estimate of how much space the library is using, for the settings screen. */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch { return null; }
}

/**
 * Ask the browser to make storage persistent so it survives eviction.
 * iOS grants this to home-screen web apps; it is best-effort everywhere else.
 */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}
