// store.js — on-device persistence (IndexedDB) plus JSON backup/restore.
//
// Everything lives on the phone. There is no server and no account; the export
// file is the only way data leaves the device, and the only way it comes back.

// Storage identifier, not a display name — never rename it to match the app's
// title. Changing it opens a different, empty database and every song already
// saved on the device becomes unreachable.
const DB_NAME = 'songs-scroll';
const DB_VERSION = 2; // 2 added version history and Recently deleted
const SONGS = 'songs';
const SETLISTS = 'setlists';
const PREFS = 'prefs';
const VERSIONS = 'versions';
const TRASH = 'trash';

const KEEP_VERSIONS = 30;    // per song
export const TRASH_DAYS = 30;

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
    // Upgrades only ever add stores: songs, setlists and settings already on
    // the phone are left exactly as they are.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SONGS)) db.createObjectStore(SONGS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SETLISTS)) db.createObjectStore(SETLISTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PREFS)) db.createObjectStore(PREFS, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(VERSIONS)) {
        db.createObjectStore(VERSIONS, { keyPath: 'id' }).createIndex('bySong', 'songId');
      }
      if (!db.objectStoreNames.contains(TRASH)) db.createObjectStore(TRASH, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // If a newer version of the app needs to upgrade, step aside for it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * One transaction across several stores. `fn` gets the transaction and a
 * `done(value)` to report a result; the promise resolves once it commits.
 */
function run(stores, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    fn(t, (value) => { result = value; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
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

/**
 * Save a song. When its words, title or artist change, the text it had until
 * now goes into its version history first, in the same transaction — so no
 * way of changing a song (editing, an import, restoring a version) can lose
 * the previous text. `reason` records what replaced it: 'edit', 'import' or
 * 'restore'. Only the newest KEEP_VERSIONS per song are kept.
 */
export function saveSong(song, { reason = 'edit' } = {}) {
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
  return run([SONGS, VERSIONS], 'readwrite', (t) => {
    const songs = t.objectStore(SONGS);
    const versions = t.objectStore(VERSIONS);
    const req = songs.get(record.id);
    req.onsuccess = () => {
      const old = req.result;
      if (old && (old.body !== record.body || old.title !== record.title || old.artist !== record.artist)) {
        versions.put({
          id: newId(), songId: old.id, title: old.title, artist: old.artist,
          body: old.body, replacedAt: now, reason,
        });
        const all = versions.index('bySong').getAll(old.id);
        all.onsuccess = () => {
          all.result
            .sort((a, b) => b.replacedAt.localeCompare(a.replacedAt))
            .slice(KEEP_VERSIONS)
            .forEach((v) => versions.delete(v.id));
        };
      }
      songs.put(record);
    };
  }).then(() => record);
}

/** A song's earlier texts, newest first. */
export function getVersions(songId) {
  return run([VERSIONS], 'readonly', (t, done) => {
    const r = t.objectStore(VERSIONS).index('bySong').getAll(songId);
    r.onsuccess = () => done(r.result.sort((a, b) => b.replacedAt.localeCompare(a.replacedAt)));
  });
}

// ---------------------------------------------------------------------------
// Recently deleted
//
// Deleting a song moves it here for TRASH_DAYS; its history stays with it,
// and setlists keep its place, so a restore brings everything back.
// ---------------------------------------------------------------------------

export function trashSong(id) {
  return run([SONGS, TRASH], 'readwrite', (t, done) => {
    const r = t.objectStore(SONGS).get(id);
    r.onsuccess = () => {
      if (!r.result) return;
      const item = { ...r.result, deletedAt: new Date().toISOString() };
      t.objectStore(TRASH).put(item);
      t.objectStore(SONGS).delete(id);
      done(item);
    };
  });
}

export function restoreSong(id) {
  return run([SONGS, TRASH, VERSIONS], 'readwrite', (t, done) => {
    const r = t.objectStore(TRASH).get(id);
    r.onsuccess = () => {
      if (!r.result) return;
      const { deletedAt, ...song } = r.result;
      const songs = t.objectStore(SONGS);
      const live = songs.get(id);
      live.onsuccess = () => {
        t.objectStore(TRASH).delete(id);
        if (!live.result) { songs.put(song); done(song); return; }
        // Already back in the library — a backup brought it back. Keep that
        // copy, and file the deleted text in its history so nothing is lost.
        if (live.result.body !== song.body) {
          t.objectStore(VERSIONS).put({
            id: newId(), songId: id, title: song.title, artist: song.artist,
            body: song.body, replacedAt: deletedAt, reason: 'restore',
          });
        }
        done(live.result);
      };
    };
  });
}

/** Delete for good: the song and its whole history. */
export function purgeSong(id) {
  return run([TRASH, SONGS, VERSIONS], 'readwrite', (t) => {
    t.objectStore(TRASH).delete(id);
    const live = t.objectStore(SONGS).count(id);
    live.onsuccess = () => {
      if (live.result) return; // back in the library (from a backup): its history stays
      const versions = t.objectStore(VERSIONS);
      const keys = versions.index('bySong').getAllKeys(id);
      keys.onsuccess = () => keys.result.forEach((k) => versions.delete(k));
    };
  });
}

/** Recently deleted, newest first. Anything past TRASH_DAYS is removed for good on the way. */
export async function getTrash() {
  const items = await run([TRASH], 'readonly', (t, done) => {
    const r = t.objectStore(TRASH).getAll();
    r.onsuccess = () => done(r.result);
  });
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  for (const s of items) if (Date.parse(s.deletedAt) < cutoff) await purgeSong(s.id);
  return items
    .filter((s) => Date.parse(s.deletedAt) >= cutoff)
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

// ---------------------------------------------------------------------------
// The edit in progress
//
// Saved as the user types, so switching apps — or iOS closing the app —
// loses nothing. Kept apart from preferences, which go into backups.
// ---------------------------------------------------------------------------

export const getDraft = () => tx(PREFS, 'readonly', s => s.get('draft')).then(r => (r ? r.v : null));
export const saveDraft = (draft) => tx(PREFS, 'readwrite', s => s.put({ k: 'draft', v: draft }));
export const clearDraft = () => tx(PREFS, 'readwrite', s => s.delete('draft'));

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
// GitHub songbook source
//
// Kept in its own record, deliberately apart from the preferences above: the
// JSON backup exports preferences, and a backup file gets shared around. The
// access token must never ride along.
// ---------------------------------------------------------------------------

export function getGithubConfig() {
  return tx(PREFS, 'readonly', s => s.get('github'))
    .then(r => ({ repo: '', token: '', ...(r ? r.v : {}) }));
}

export function saveGithubConfig({ repo = '', token = '' }) {
  const v = { repo: String(repo).trim(), token: String(token).trim() };
  return tx(PREFS, 'readwrite', s => s.put({ k: 'github', v })).then(() => v);
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
    // File-format tag, checked on import. Renaming it would make every backup
    // exported before the change unreadable.
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
    throw new Error('That file is not a Chords backup.');
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
    await saveSong({ ...song, id: song.id || newId() }, { reason: 'import' });
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
