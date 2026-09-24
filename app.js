// app.js — views, wiring, and the chord-chart renderer.

import {
  parseSong, segmentsFor, displayShift, useFlatsFor,
  tonicOf, keyName, chordInventory, detectFormat,
} from './model.js';
import {
  DEFAULT_SETTINGS, getSongs, getSong, saveSong, deleteSong,
  getSetlists, getSetlist, saveSetlist, deleteSetlist,
  getPrefs, savePrefs, exportAll, importAll,
  storageEstimate, requestPersistence, getGithubConfig, saveGithubConfig,
} from './store.js';
import {
  decodeBytes, splitSongbook, formatSong, formatSongbook, songKey, safeFilename, sameSongText,
} from './songbook.js';
import { parseRepo, listSongbooks, downloadFile } from './github.js';
import { createPlayer, wakeLockSupported } from './player.js';

const APP_VERSION = '1.2.0';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = {
  songs: [],
  setlists: [],
  prefs: null,
  song: null,          // song being viewed / played
  parsed: null,        // parsed form of state.song
  setlist: null,       // active setlist, if playing through one
  setlistIndex: -1,
  editingId: null,
  player: null,
  search: '',
  history: [],
  importDraft: null,   // songs read from .txt files, awaiting confirmation
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function show(name, { push = true } = {}) {
  const current = $$('.view.active')[0];
  if (current && push) state.history.push(current.id.replace('view-', ''));
  $$('.view').forEach(v => v.classList.remove('active'));
  const view = $('#view-' + name);
  if (view) view.classList.add('active');
  if (name !== 'player' && state.player) {
    state.player.destroy();
    state.player = null;
  }
}

function toast(message, ms = 2400) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------------------
// Chart rendering
// ---------------------------------------------------------------------------

/**
 * Render a parsed song into `el`. Segments are joined with no whitespace
 * between them — they are inline-blocks, so stray newlines in the markup would
 * become visible gaps in the lyrics.
 */
function renderChart(el, parsed, settings, song) {
  const shift = displayShift(settings.transpose, settings.capo);
  const flats = useFlatsFor(song, parsed, shift, settings.accidentals);
  // Untransposed, show chords exactly as the author wrote them ("H7" stays
  // "H7"); an explicit ♭/♯ choice respells everything.
  const keep = settings.accidentals === 'auto';
  const out = [];

  for (const line of parsed.lines) {
    if (line.t === 'blank') { out.push('<div class="blank"></div>'); continue; }
    if (line.t === 'section') {
      const note = line.note ? `<span class="note">${esc(line.note)}</span>` : '';
      out.push(`<div class="section">${esc(line.label)}${note}</div>`);
      continue;
    }
    if (line.t === 'comment') { out.push(`<div class="comment">${esc(line.text)}</div>`); continue; }
    if (!line.chords.length) {
      out.push(`<div class="line plain">${line.text ? esc(line.text) : '&nbsp;'}</div>`);
      continue;
    }
    const segs = segmentsFor(line, shift, flats, keep)
      .map(s => `<span class="seg"><span class="ch${s.deco ? ' x' : ''}">${s.chord ? esc(s.chord) : ''}</span>${esc(s.text)}</span>`)
      .join('');
    out.push(`<div class="line">${segs}</div>`);
  }

  el.innerHTML = out.join('');
  el.style.fontSize = settings.fontSize + 'px';
  el.style.lineHeight = String(settings.lineHeight);
  el.classList.toggle('no-chords', !settings.showChords);
}

/** "Play Am shapes · capo 3 · sounds in Cm" — the line that answers "what do I finger?" */
function keyReadout(song, parsed, settings) {
  const tonic = tonicOf(song, parsed);
  if (!tonic) return 'No chords detected in this song.';

  const shift = displayShift(settings.transpose, settings.capo);
  const shapeFlats = useFlatsFor(song, parsed, shift, settings.accidentals);
  const soundFlats = useFlatsFor(song, parsed, settings.transpose, settings.accidentals);
  const shape = keyName(tonic.pitch + shift, tonic.minor, shapeFlats);
  const sounding = keyName(tonic.pitch + settings.transpose, tonic.minor, soundFlats);

  const parts = [`Play <b>${esc(shape)}</b> shapes`];
  if (settings.capo > 0) parts.push(`capo ${settings.capo}`);
  if (settings.capo > 0 || settings.transpose !== 0) parts.push(`sounds in ${esc(sounding)}`);
  return parts.join(' &middot; ');
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function refreshLibrary() {
  state.songs = await getSongs();
  state.setlists = await getSetlists();
  renderSongList();
  renderSetlistList();
}

function renderSongList() {
  const q = state.search.trim().toLowerCase();
  const items = state.songs.filter(s =>
    !q || s.title.toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q));

  $('#songs-empty').classList.toggle('hidden', state.songs.length > 0);
  $('#song-list').innerHTML = items.map(s => {
    const bits = [s.artist, s.settings.capo ? `capo ${s.settings.capo}` : null]
      .filter(Boolean).join(' · ');
    const parsedKey = songKeyLabel(s);
    return `<li data-song="${esc(s.id)}">
      <div class="item-main">
        <div class="item-title">${esc(s.title)}</div>
        ${bits ? `<div class="item-sub">${esc(bits)}</div>` : ''}
      </div>
      ${parsedKey ? `<span class="chip">${esc(parsedKey)}</span>` : ''}
    </li>`;
  }).join('');
}

// Search re-renders the list on every keystroke; parsing every song each time
// is wasted work. Any edit or settings change bumps updatedAt, so it keys this.
const keyLabelCache = new Map();

/** The chord the player will actually finger first — shown as the list badge. */
function songKeyLabel(song) {
  const cacheKey = `${song.id}:${song.updatedAt}`;
  if (keyLabelCache.has(cacheKey)) return keyLabelCache.get(cacheKey);
  let label = '';
  try {
    const parsed = parseSong(song.body);
    const tonic = tonicOf(song, parsed);
    if (tonic) {
      const shift = displayShift(song.settings.transpose, song.settings.capo);
      const flats = useFlatsFor(song, parsed, shift, song.settings.accidentals);
      label = keyName(tonic.pitch + shift, tonic.minor, flats);
    }
  } catch { /* an unparseable song simply gets no badge */ }
  keyLabelCache.set(cacheKey, label);
  return label;
}

function renderSetlistList() {
  $('#setlists-empty').classList.toggle('hidden', state.setlists.length > 0);
  $('#setlist-list').innerHTML = state.setlists.map(sl => `
    <li data-setlist="${esc(sl.id)}">
      <div class="item-main">
        <div class="item-title">${esc(sl.name)}</div>
        <div class="item-sub">${sl.songIds.length} song${sl.songIds.length === 1 ? '' : 's'}</div>
      </div>
    </li>`).join('');
}

// ---------------------------------------------------------------------------
// Song detail
// ---------------------------------------------------------------------------

async function openSong(id, { push = true } = {}) {
  const song = await getSong(id);
  if (!song) { toast('Song not found'); return; }
  state.song = song;
  state.parsed = parseSong(song.body);
  $('#song-title').textContent = song.title;
  $('#song-artist').textContent = song.artist || '';
  syncSongControls();
  show('song', { push });
}

function syncSongControls() {
  const s = state.song.settings;
  $('#c-speed').value = s.speed;
  $('#c-font').value = s.fontSize;
  $('#c-lh').value = Math.round(s.lineHeight * 100);
  $('#v-speed').textContent = s.speed + ' px/s';
  $('#v-font').textContent = s.fontSize + ' px';
  $('#v-lh').textContent = s.lineHeight.toFixed(2);
  $('#v-transpose').textContent = s.transpose > 0 ? `+${s.transpose}` : String(s.transpose);
  $('#v-capo').textContent = s.capo === 0 ? 'off' : `fret ${s.capo}`;
  $('#v-leadin').textContent = s.leadIn === 0 ? 'off' : `${s.leadIn}s`;
  $$('#c-accidentals button').forEach(b =>
    b.classList.toggle('active', b.dataset.acc === s.accidentals));

  $('#key-readout').innerHTML = keyReadout(state.song, state.parsed, s);

  const shift = displayShift(s.transpose, s.capo);
  const flats = useFlatsFor(state.song, state.parsed, shift, s.accidentals);
  $('#chord-inventory').innerHTML = chordInventory(state.parsed, shift, flats, s.accidentals === 'auto')
    .map(c => `<span>${esc(c)}</span>`).join('');

  // Sharing sends what you see; say so when that differs from the original.
  const changes = [
    s.transpose ? `transposed ${s.transpose > 0 ? '+' : ''}${s.transpose}` : '',
    s.capo ? `capo ${s.capo}` : '',
  ].filter(Boolean);
  $('#share-hint').textContent = changes.length
    ? `Shared as you play it (${changes.join(', ')}) — the recipient sees the same chords.`
    : 'Shared exactly as written.';

  renderChart($('#song-preview'), state.parsed, { ...s, fontSize: 16 }, state.song);
}

let saveTimer = null;
function updateSetting(key, value) {
  state.song.settings[key] = value;
  syncSongControls();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSong(state.song);
    state.songs = await getSongs();
    renderSongList();
  }, 400);
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function openEditor(song) {
  state.editingId = song ? song.id : null;
  $('#f-title').value = song ? song.title : '';
  $('#f-artist').value = song ? song.artist : '';
  $('#f-key').value = song ? song.key : '';
  $('#f-body').value = song ? song.body : '';
  updateFormatBadge();
  show('editor');
}

function updateFormatBadge() {
  const body = $('#f-body').value;
  $('#format-badge').textContent = body.trim() ? detectFormat(body) : '';
}

async function saveFromEditor() {
  const body = $('#f-body').value;
  if (!body.trim()) { toast('Add some chords or lyrics first'); return; }

  const existing = state.editingId ? await getSong(state.editingId) : null;
  const parsed = parseSong(body);
  const record = await saveSong({
    ...(existing || {}),
    id: state.editingId || undefined,
    title: $('#f-title').value || parsed.meta.title || 'Untitled',
    artist: $('#f-artist').value || parsed.meta.artist || '',
    key: $('#f-key').value || parsed.meta.key || '',
    format: 'auto',
    body,
    settings: existing ? existing.settings : { ...state.prefs.defaults },
  });

  await refreshLibrary();
  // Opening the editor pushed the view we came from; saving returns there, so
  // drop that entry or Back would land on the song detail twice.
  state.history.pop();
  await openSong(record.id, { push: false });
  toast('Saved');
}

// ---------------------------------------------------------------------------
// Setlists
// ---------------------------------------------------------------------------

async function openSetlist(id) {
  const sl = await getSetlist(id);
  if (!sl) return;
  state.setlist = sl;
  $('#setlist-title').textContent = sl.name;
  renderSetlistDetail();
  show('setlist');
}

function renderSetlistDetail() {
  const sl = state.setlist;
  const byId = new Map(state.songs.map(s => [s.id, s]));
  const inSet = sl.songIds.filter(id => byId.has(id));

  $('#setlist-empty').classList.toggle('hidden', inSet.length > 0);
  $('#setlist-songs').innerHTML = inSet.map((id, i) => {
    const s = byId.get(id);
    return `<li data-play="${esc(id)}">
      <div class="item-main">
        <div class="item-title">${i + 1}. ${esc(s.title)}</div>
        ${s.artist ? `<div class="item-sub">${esc(s.artist)}</div>` : ''}
      </div>
      <button class="row-btn" data-move="${esc(id)}" data-dir="-1" aria-label="Move up">↑</button>
      <button class="row-btn" data-move="${esc(id)}" data-dir="1" aria-label="Move down">↓</button>
      <button class="row-btn" data-remove="${esc(id)}" aria-label="Remove">✕</button>
    </li>`;
  }).join('');

  $('#setlist-available').innerHTML = state.songs
    .filter(s => !sl.songIds.includes(s.id))
    .map(s => `<li data-add="${esc(s.id)}">
      <div class="item-main"><div class="item-title">${esc(s.title)}</div></div>
      <span class="chip">＋</span>
    </li>`).join('');
}

async function persistSetlist() {
  state.setlist = await saveSetlist(state.setlist);
  state.setlists = await getSetlists();
  renderSetlistList();
  renderSetlistDetail();
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

let chromeTimer = null;

function startPlayer(song, { setlist = null, index = -1 } = {}) {
  state.song = song;
  state.parsed = parseSong(song.body);
  state.setlist = setlist;
  state.setlistIndex = index;

  const s = song.settings;
  const content = $('#player-content');
  renderChart(content, state.parsed, s, song);

  $('#player-title').textContent = song.title;
  $('#player-key').textContent = stripTags(keyReadout(song, state.parsed, s));
  $('#p-speed-readout').textContent = `${s.speed} px/s`;
  $('#p-next').textContent = nextInSetlist() ? `Next: ${nextInSetlist().title}` : '';

  show('player');

  // The engine re-measures scrollHeight every frame, so there is nothing to
  // wait for here. Creating the player synchronously matters: waiting on
  // requestAnimationFrame would never resolve if the app is backgrounded
  // between pressing play and the first frame, leaving dead controls.
  const player = createPlayer({
    viewport: $('#player-viewport'),
    content,
    onTick: () => {
      $('#progress-fill').style.width = (player.progress() * 100).toFixed(1) + '%';
      const n = Math.ceil(player.state.leadIn);
      if (player.state.leadIn > 0) {
        $('#countdown').classList.remove('hidden');
        $('#countdown-n').textContent = String(n);
      } else {
        $('#countdown').classList.add('hidden');
      }
    },
    onStateChange: (st) => {
      $('#p-toggle').textContent = st.playing ? '❚❚' : '▶';
      if (!st.playing) $('#countdown').classList.add('hidden');
      st.playing ? scheduleChromeDim() : revealChrome();
    },
    onEnd: () => {
      revealChrome();
      const next = nextInSetlist();
      toast(next ? `End of song — next: ${next.title}` : 'End of song');
    },
  });
  player.setSpeed(s.speed);
  state.player = player;
  revealChrome();
}

const stripTags = (html) => html.replace(/<[^>]*>/g, '');

function nextInSetlist() {
  if (!state.setlist || state.setlistIndex < 0) return null;
  const nextId = state.setlist.songIds[state.setlistIndex + 1];
  return nextId ? state.songs.find(s => s.id === nextId) || null : null;
}

function scheduleChromeDim() {
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => {
    if (state.player && state.player.state.playing) $('#player-chrome').classList.add('dimmed');
  }, 2600);
}

function revealChrome() {
  clearTimeout(chromeTimer);
  $('#player-chrome').classList.remove('dimmed');
  if (state.player && state.player.state.playing) scheduleChromeDim();
}

function adjustPlayerSetting(key, delta, min, max) {
  if (!state.song || !state.player) return;
  const s = state.song.settings;
  s[key] = Math.min(max, Math.max(min, s[key] + delta));
  if (key === 'speed') {
    state.player.setSpeed(s.speed);
    $('#p-speed-readout').textContent = `${s.speed} px/s`;
  } else {
    renderChart($('#player-content'), state.parsed, s, state.song);
  }
  revealChrome();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSong(state.song), 500);
}

// ---------------------------------------------------------------------------
// Settings sheet
// ---------------------------------------------------------------------------

async function openSettings() {
  $('#d-speed').value = state.prefs.defaults.speed;
  $('#d-font').value = state.prefs.defaults.fontSize;
  $('#v-dspeed').textContent = state.prefs.defaults.speed + ' px/s';
  $('#v-dfont').textContent = state.prefs.defaults.fontSize + ' px';
  $('#app-version').textContent = 'v' + APP_VERSION;

  const theme = state.prefs.theme || 'auto';
  $$('#c-theme button').forEach(b => b.classList.toggle('active', b.dataset.themeSet === theme));

  $('#wakelock-info').textContent = wakeLockSupported()
    ? 'Screen stays awake while scrolling.'
    : 'This browser cannot keep the screen awake — set Auto-Lock to Never in iOS Settings › Display.';

  const est = await storageEstimate();
  $('#storage-info').textContent = est
    ? `${state.songs.length} songs · ${(est.usage / 1024 / 1024).toFixed(1)} MB used`
    : `${state.songs.length} songs stored on this device`;

  await renderGithubSettings();
  $('#gh-check').textContent = '';
  $('#sheet-settings').classList.remove('hidden');
}

/**
 * Hand a file to the share sheet — on iOS that reaches Telegram, Files,
 * AirDrop and the rest — falling back to a download where sharing files is
 * unsupported. Callers must not await anything slow first: Safari only allows
 * sharing shortly after the tap that asked for it.
 */
async function shareFile(name, content, type, title) {
  try {
    const file = new File([content], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user dismissed the sheet
  }

  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportLibrary() {
  const data = await exportAll();
  await shareFile(`chords-backup-${data.exportedAt.slice(0, 10)}.json`,
    JSON.stringify(data, null, 2), 'application/json', 'Chords backup');
}

/** Every song as one readable .txt songbook, chords as written. */
function exportLibraryText() {
  if (!state.songs.length) { toast('No songs to export yet'); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  shareFile(`chords-songs-${stamp}.txt`,
    formatSongbook(state.songs, { name: `Chords — ${stamp}`, asWritten: true }), 'text/plain', 'Chords songs');
}

const songFileName = (song) => safeFilename(song.artist ? `${song.title} - ${song.artist}` : song.title);

function shareSong() {
  shareFile(songFileName(state.song), formatSong(state.song), 'text/plain', state.song.title);
}

async function copySong() {
  try {
    await navigator.clipboard.writeText(formatSong(state.song));
    toast('Copied — paste it into any chat');
  } catch {
    toast('Copying is not available here');
  }
}

function shareSetlist() {
  const byId = new Map(state.songs.map(s => [s.id, s]));
  const songs = state.setlist.songIds.map(id => byId.get(id)).filter(Boolean);
  if (!songs.length) { toast('This setlist is empty'); return; }
  shareFile(safeFilename(state.setlist.name), formatSongbook(songs, { name: state.setlist.name }),
    'text/plain', state.setlist.name);
}

// ---------------------------------------------------------------------------
// Importing .txt files — picked on the phone, or downloaded from GitHub
// ---------------------------------------------------------------------------

const closeSheets = () => $$('.sheet').forEach(s => s.classList.add('hidden'));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Files picked on the phone go into the same pipeline as GitHub downloads. */
async function readTxtFiles(fileList) {
  const items = [];
  for (const f of Array.from(fileList || [])) {
    try {
      items.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    } catch {
      toast(`Could not read ${f.name}`);
    }
  }
  if (items.length) await prepareImport(items);
}

/**
 * Decode and split the files, compare every song with the library, and show
 * the result before anything is saved — splitting a songbook is heuristic, so
 * the user confirms it. Each song is one of:
 *   new      not in the library yet; ticked
 *   changed  same title and artist, different text; can update the copy
 *   same     already in the library word for word; nothing to do
 *
 * Compares against the database, not the in-memory list: settings changed in
 * the player are saved without refreshing that list.
 */
async function prepareImport(items) {
  const [library, setlists] = await Promise.all([getSongs(), getSetlists()]);
  const known = new Map(library.map(s => [songKey(s.title, s.artist), s]));
  const draft = { files: [], songs: [], setlistName: '', setlistExists: false, makeSetlist: false };
  for (const { name, bytes } of items) {
    const decoded = decodeBytes(bytes);
    const book = splitSongbook(decoded.text, { filename: name });
    draft.files.push({ name, encoding: decoded.encoding, text: decoded.text, collection: book.collection });
    for (const s of book.songs) {
      if (!s.body.trim()) continue;
      const mine = known.get(songKey(s.title, s.artist));
      const status = !mine ? 'new' : sameSongText(mine.body, s.body) ? 'same' : 'changed';
      draft.songs.push({ ...s, status, existingId: mine ? mine.id : null, selected: status === 'new' });
    }
  }
  if (!draft.songs.length) { toast('No songs found in that file'); return; }

  // A songbook keeps its order as a setlist, named after the book or the file.
  if (draft.files.length === 1 && draft.songs.length > 1) {
    const f = draft.files[0];
    draft.setlistName = f.collection || f.name.replace(/\.[^.]*$/, '');
    draft.setlistExists = setlists.some(sl => sl.name === draft.setlistName);
    // Refreshing an existing setlist would undo any reordering done on the
    // phone, so it is offered but never ticked by default.
    draft.makeSetlist = !draft.setlistExists;
  }
  state.importDraft = draft;
  renderImportSheet();
  closeSheets();
  $('#sheet-import').classList.remove('hidden');
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function renderImportSheet() {
  const d = state.importDraft;
  const count = (status) => d.songs.filter(s => s.status === status).length;
  const toAdd = d.songs.filter(s => s.status === 'new' && s.selected).length;
  const toUpdate = d.songs.filter(s => s.status === 'changed' && s.selected).length;

  const source = d.files.length === 1 ? `${d.files[0].name} · ${d.files[0].encoding}` : `${d.files.length} files`;
  const tally = [
    count('new') ? `${count('new')} new` : '',
    count('changed') ? `${count('changed')} changed` : '',
    count('same') ? `${count('same')} already in your library` : '',
  ].filter(Boolean).join(', ');
  $('#import-summary').textContent = `${source} · ${plural(d.songs.length, 'song')}: ${tally}`;

  const note = { new: '', changed: 'changed — tick to update your copy', same: 'already in your library' };
  $('#import-list').innerHTML = d.songs.map((s, i) => `
    <li data-pick="${i}" class="${s.selected ? 'picked' : ''}${s.status === 'same' ? ' same' : ''}">
      <span class="tick" aria-hidden="true">${s.selected ? '✓' : ''}</span>
      <div class="item-main">
        <div class="item-title">${esc(s.title)}</div>
        <div class="item-sub">${esc([s.artist, note[s.status]].filter(Boolean).join(' · '))}</div>
      </div>
    </li>`).join('');
  const selectable = d.songs.filter(s => s.status !== 'same');
  $('#import-all-row').classList.toggle('hidden', !selectable.length);
  $('#import-all').checked = selectable.length > 0 && selectable.every(s => s.selected);

  const canSet = !!d.setlistName;
  $('#import-setlist-row').classList.toggle('hidden', !canSet);
  if (canSet) {
    $('#import-setlist').checked = d.makeSetlist;
    $('#import-setlist-label').textContent = d.setlistExists
      ? `Update setlist “${d.setlistName}” to match this file`
      : `Also create setlist “${d.setlistName}” in this order`;
  }

  // Everything that will be in the library afterwards can go in the setlist.
  const inSetlist = d.songs.filter(s => s.existingId || s.selected).length;
  const setlistOnly = !toAdd && !toUpdate && canSet && d.makeSetlist && inSetlist > 1;
  const action = [
    toAdd ? `import ${plural(toAdd, 'song')}` : '',
    toUpdate ? `update ${plural(toUpdate, 'song')}` : '',
  ].filter(Boolean).join(' · ');
  const go = $('#btn-import-go');
  go.disabled = !action && !setlistOnly;
  go.textContent = action ? capitalise(action)
    : setlistOnly ? (d.setlistExists ? 'Update setlist only' : 'Create setlist only')
    : 'Nothing new to import';

  $('#btn-import-whole').classList.toggle('hidden', !(d.files.length === 1 && d.songs.length > 1));
}

async function runImport() {
  const d = state.importDraft;
  if (!d) return;
  const ids = [];
  let added = 0;
  let updated = 0;
  for (const s of d.songs) {
    if (s.status === 'new') {
      if (!s.selected) continue;
      const rec = await saveSong({
        title: s.title, artist: s.artist, key: '', format: 'auto',
        body: s.body, settings: { ...state.prefs.defaults },
      });
      ids.push(rec.id);
      added++;
      continue;
    }
    // Read the stored record now: it holds the latest speed, capo and key.
    const mine = await getSong(s.existingId);
    if (!mine) continue; // deleted since the preview was shown
    if (s.status === 'changed' && s.selected) {
      // New words and chords; the player's own settings stay.
      await saveSong({ ...mine, body: s.body });
      updated++;
    }
    ids.push(mine.id); // already in the library: still belongs in the setlist
  }

  let note = '';
  if (d.setlistName && d.makeSetlist && ids.length > 1) {
    const existing = (await getSetlists()).find(sl => sl.name === d.setlistName);
    await saveSetlist(existing ? { ...existing, songIds: ids } : { name: d.setlistName, songIds: ids });
    note = ` · setlist “${d.setlistName}” ${existing ? 'updated' : 'created'}`;
  }
  state.importDraft = null;
  closeSheets();
  await refreshLibrary();
  const done = [
    added ? `imported ${plural(added, 'song')}` : '',
    updated ? `updated ${plural(updated, 'song')}` : '',
  ].filter(Boolean).join(', ');
  toast(capitalise(done || 'nothing new imported') + note);
}

// ---------------------------------------------------------------------------
// Songbooks on GitHub
// ---------------------------------------------------------------------------

/** The saved repository as { owner, repo, token }, or null if none is set up. */
async function githubSource() {
  const cfg = await getGithubConfig();
  const repo = parseRepo(cfg.repo);
  return repo ? { ...repo, token: cfg.token } : null;
}

const formatSize = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;

async function openGithubSheet() {
  closeSheets();
  $('#sheet-github').classList.remove('hidden');
  $('#gh-list').innerHTML = '';
  const src = await githubSource();
  if (!src) {
    $('#gh-status').textContent = 'No repository set up yet. Add one under “GitHub songbooks” in Settings.';
    return;
  }
  const name = `${src.owner}/${src.repo}`;
  $('#gh-status').textContent = `Looking in ${name}…`;
  try {
    const files = await listSongbooks(src);
    $('#gh-status').textContent = files.length
      ? `${name} · tap a songbook to import it`
      : `${name} has no .txt files yet.`;
    $('#gh-list').innerHTML = files.map(f => {
      const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      return `<li data-gh-path="${esc(f.path)}">
        <div class="item-main">
          <div class="item-title">${esc(f.name)}</div>
          <div class="item-sub">${esc([folder, formatSize(f.size)].filter(Boolean).join(' · '))}</div>
        </div>
        <span class="chip">↓</span>
      </li>`;
    }).join('');
  } catch (err) {
    $('#gh-status').textContent = err.message;
  }
}

async function importFromGithub(path) {
  const src = await githubSource();
  if (!src) return;
  const name = path.split('/').pop();
  $('#gh-status').textContent = `Downloading ${name}…`;
  try {
    await prepareImport([{ name, bytes: await downloadFile(src, path) }]);
  } catch (err) {
    $('#gh-status').textContent = err.message;
  }
}

async function renderGithubSettings() {
  const cfg = await getGithubConfig();
  $('#gh-repo').value = cfg.repo;
  $('#gh-token').value = ''; // a saved token is never put back on screen
  $('#gh-token-state').textContent = cfg.token
    ? `A token is saved on this phone (ending …${cfg.token.slice(-4)}). Leave the field empty to keep it.`
    : 'No token saved: only public repositories can be read.';
  $('#btn-gh-forget').classList.toggle('hidden', !cfg.token);
}

async function saveGithubSettings() {
  const repo = parseRepo($('#gh-repo').value);
  if (!repo) {
    $('#gh-check').textContent = 'Enter the repository as owner/name, for example VL-lab-2025/chords-songbooks.';
    return;
  }
  const current = await getGithubConfig();
  const token = $('#gh-token').value.trim() || current.token;
  await saveGithubConfig({ repo: `${repo.owner}/${repo.repo}`, token });
  await renderGithubSettings();
  $('#gh-check').textContent = 'Saved. Checking the connection…';
  try {
    const files = await listSongbooks({ ...repo, token });
    $('#gh-check').textContent = `Connected: ${plural(files.length, 'songbook')} found.`;
  } catch (err) {
    $('#gh-check').textContent = err.message;
  }
}

async function forgetGithubToken() {
  const cfg = await getGithubConfig();
  await saveGithubConfig({ repo: cfg.repo, token: '' });
  await renderGithubSettings();
  $('#gh-check').textContent = '';
  toast('Token removed from this phone');
}

/** The escape hatch when splitting got it wrong: keep the file as one song. */
async function importWholeFile() {
  const f = state.importDraft.files[0];
  const record = await saveSong({
    title: f.collection || f.name.replace(/\.[^.]*$/, '') || 'Untitled',
    artist: '', key: '', format: 'auto',
    body: f.text.replace(/^\uFEFF/, '').replace(/^(?:[ \t\u3000]*\n)+/, '').replace(/\s+$/, ''),
    settings: { ...state.prefs.defaults },
  });
  state.importDraft = null;
  closeSheets();
  await refreshLibrary();
  openSong(record.id);
}

async function importLibrary(file) {
  try {
    const text = await file.text();
    const result = await importAll(JSON.parse(text), 'merge');
    await refreshLibrary();
    toast(`Imported ${result.added} new, ${result.updated} updated`);
  } catch (err) {
    toast(err.message || 'Could not read that file');
  }
}

function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wire() {
  // --- library ---
  $('#btn-new-song').addEventListener('click', () => $('#sheet-add').classList.remove('hidden'));
  $('#btn-settings').addEventListener('click', openSettings);

  // --- adding songs: type one in, or import .txt files ---
  $('#btn-add-new').addEventListener('click', () => { closeSheets(); openEditor(null); });
  // The file picker must open inside the tap itself, or iOS refuses it.
  const pickTxt = () => { closeSheets(); $('#txt-file').click(); };
  $('#btn-add-import').addEventListener('click', pickTxt);
  $('#btn-import-empty').addEventListener('click', pickTxt);
  $('#txt-file').addEventListener('change', (e) => {
    readTxtFiles(e.target.files);
    e.target.value = '';
  });

  $('#import-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-pick]');
    if (!li) return;
    const s = state.importDraft.songs[+li.dataset.pick];
    if (s.status === 'same') return; // importing it again would only make a copy
    s.selected = !s.selected;
    renderImportSheet();
  });
  $('#import-all').addEventListener('change', (e) => {
    state.importDraft.songs.forEach(s => { if (s.status !== 'same') s.selected = e.target.checked; });
    renderImportSheet();
  });

  // --- songbooks on GitHub ---
  $('#btn-add-github').addEventListener('click', openGithubSheet);
  $('#gh-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-gh-path]');
    if (li) importFromGithub(li.dataset.ghPath);
  });
  $('#btn-gh-settings').addEventListener('click', async () => {
    closeSheets();
    await openSettings();
    $('#gh-section').scrollIntoView({ block: 'start' });
  });
  $('#btn-gh-save').addEventListener('click', saveGithubSettings);
  $('#btn-gh-forget').addEventListener('click', forgetGithubToken);
  $('#import-setlist').addEventListener('change', (e) => {
    state.importDraft.makeSetlist = e.target.checked;
    renderImportSheet();
  });
  $('#btn-import-go').addEventListener('click', runImport);
  $('#btn-import-whole').addEventListener('click', importWholeFile);

  // --- sheets close from their ✕ or by tapping the dimmed backdrop ---
  $$('[data-close-sheet]').forEach(b => b.addEventListener('click', closeSheets));
  $$('.sheet').forEach(sheet => sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeSheets();
  }));
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderSongList(); });

  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.pane').forEach(p => p.classList.remove('active'));
    $('#pane-' + tab.dataset.tab).classList.add('active');
  }));

  $('#song-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-song]');
    if (li) openSong(li.dataset.song);
  });

  $('#setlist-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-setlist]');
    if (li) openSetlist(li.dataset.setlist);
  });

  $('#btn-new-setlist').addEventListener('click', async () => {
    const name = prompt('Name this setlist');
    if (!name) return;
    const sl = await saveSetlist({ name, songIds: [] });
    state.setlists = await getSetlists();
    renderSetlistList();
    openSetlist(sl.id);
  });

  $('#btn-example').addEventListener('click', async () => {
    const record = await saveSong({
      title: 'Amazing Grace',
      artist: 'Traditional',
      key: 'G',
      body: EXAMPLE_SONG,
      settings: { ...state.prefs.defaults },
    });
    await refreshLibrary();
    openSong(record.id);
  });

  // --- back buttons ---
  $$('[data-back]').forEach(btn => btn.addEventListener('click', () => {
    const target = state.history.pop() || btn.dataset.back;
    show(target, { push: false });
    // Refresh whatever we land on — speed and font can be changed from inside
    // the player, so the song controls would otherwise show stale values.
    if (target === 'library') refreshLibrary();
    else if (target === 'song' && state.song) syncSongControls();
    else if (target === 'setlist' && state.setlist) renderSetlistDetail();
  }));

  // --- song detail controls ---
  $('#c-speed').addEventListener('input', e => updateSetting('speed', +e.target.value));
  $('#c-font').addEventListener('input', e => updateSetting('fontSize', +e.target.value));
  $('#c-lh').addEventListener('input', e => updateSetting('lineHeight', +e.target.value / 100));

  $$('[data-step]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.step;
    const delta = +btn.dataset.delta;
    const limits = { transpose: [-11, 11], capo: [0, 11], leadIn: [0, 15] }[key];
    const next = Math.min(limits[1], Math.max(limits[0], state.song.settings[key] + delta));
    updateSetting(key, next);
  }));

  $$('#c-accidentals button').forEach(btn =>
    btn.addEventListener('click', () => updateSetting('accidentals', btn.dataset.acc)));

  $('#btn-edit-song').addEventListener('click', () => openEditor(state.song));
  $('#btn-play').addEventListener('click', () => startPlayer(state.song));
  $('#btn-share-song').addEventListener('click', shareSong);
  $('#btn-copy-song').addEventListener('click', copySong);

  $('#btn-delete-song').addEventListener('click', async () => {
    if (!confirm(`Delete "${state.song.title}"? This cannot be undone.`)) return;
    await deleteSong(state.song.id);
    await refreshLibrary();
    state.history = [];
    show('library', { push: false });
    toast('Deleted');
  });

  // --- editor ---
  $('#f-body').addEventListener('input', updateFormatBadge);
  $('#btn-save-song').addEventListener('click', saveFromEditor);

  // --- setlist detail ---
  $('#setlist-songs').addEventListener('click', async (e) => {
    const move = e.target.closest('[data-move]');
    if (move) {
      const ids = state.setlist.songIds;
      const i = ids.indexOf(move.dataset.move);
      const j = i + Number(move.dataset.dir);
      if (i >= 0 && j >= 0 && j < ids.length) {
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await persistSetlist();
      }
      return;
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      state.setlist.songIds = state.setlist.songIds.filter(id => id !== remove.dataset.remove);
      await persistSetlist();
      return;
    }
    const play = e.target.closest('[data-play]');
    if (play) {
      const song = await getSong(play.dataset.play);
      const index = state.setlist.songIds.indexOf(play.dataset.play);
      if (song) startPlayer(song, { setlist: state.setlist, index });
    }
  });

  $('#setlist-available').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]');
    if (!add) return;
    state.setlist.songIds.push(add.dataset.add);
    await persistSetlist();
  });

  $('#btn-share-setlist').addEventListener('click', shareSetlist);

  $('#btn-rename-setlist').addEventListener('click', async () => {
    const name = prompt('Rename setlist', state.setlist.name);
    if (!name) return;
    state.setlist.name = name;
    $('#setlist-title').textContent = name;
    await persistSetlist();
  });

  $('#btn-delete-setlist').addEventListener('click', async () => {
    if (!confirm(`Delete setlist "${state.setlist.name}"?`)) return;
    await deleteSetlist(state.setlist.id);
    state.setlist = null;
    await refreshLibrary();
    state.history = [];
    show('library', { push: false });
  });

  // --- player ---
  $('#player-viewport').addEventListener('click', () => {
    if (!state.player || state.player.wasDrag()) return;
    state.player.toggle(state.song.settings.leadIn);
    revealChrome();
  });

  $('#p-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.player) return;
    state.player.toggle(state.song.settings.leadIn);
    revealChrome();
  });
  $('#p-slower').addEventListener('click', () => adjustPlayerSetting('speed', -2, 4, 200));
  $('#p-faster').addEventListener('click', () => adjustPlayerSetting('speed', 2, 4, 200));
  $('#p-font-down').addEventListener('click', () => adjustPlayerSetting('fontSize', -1, 12, 44));
  $('#p-font-up').addEventListener('click', () => adjustPlayerSetting('fontSize', 1, 12, 44));
  $('#btn-restart').addEventListener('click', () => {
    if (!state.player) return;
    state.player.reset();
    revealChrome();
  });

  // --- settings sheet ---
  $('#d-speed').addEventListener('input', async (e) => {
    state.prefs.defaults.speed = +e.target.value;
    $('#v-dspeed').textContent = e.target.value + ' px/s';
    await savePrefs(state.prefs);
  });
  $('#d-font').addEventListener('input', async (e) => {
    state.prefs.defaults.fontSize = +e.target.value;
    $('#v-dfont').textContent = e.target.value + ' px';
    await savePrefs(state.prefs);
  });

  $$('#c-theme button').forEach(btn => btn.addEventListener('click', async () => {
    $$('#c-theme button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.prefs.theme = btn.dataset.themeSet;
    applyTheme(state.prefs.theme);
    await savePrefs(state.prefs);
  }));

  $('#btn-export').addEventListener('click', exportLibrary);
  $('#btn-export-txt').addEventListener('click', exportLibraryText);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importLibrary(file);
    e.target.value = '';
  });

  $('#btn-update').addEventListener('click', async () => {
    if (!navigator.serviceWorker) { toast('Offline mode not available here'); return; }
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { toast('Not installed for offline use yet'); return; }
    await reg.update();
    toast('Checked — reopen the app to apply any update');
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const EXAMPLE_SONG = `[Verse 1]
G          G7        C        G
Amazing grace how sweet the sound
                          D
That saved a wretch like me
G         G7       C          G
I once was lost, but now am found
        Em     D      G
Was blind, but now I see

[Verse 2]
G         G7        C          G
'Twas grace that taught my heart to fear
                            D
And grace my fears relieved
G           G7      C           G
How precious did that grace appear
       Em      D       G
The hour I first believed`;

async function init() {
  state.prefs = await getPrefs();
  if (!state.prefs.defaults) state.prefs.defaults = { ...DEFAULT_SETTINGS };
  applyTheme(state.prefs.theme || 'auto');

  wire();
  await refreshLibrary();
  requestPersistence();

  if ('serviceWorker' in navigator) {
    // A new service worker calls skipWaiting and claims this page, but the JS
    // already running is still the old copy — reload once so an update you just
    // published actually takes effect instead of appearing to do nothing.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return; // first install: nothing to replace
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Offline caching unavailable (e.g. opened over file://) — app still runs.
    });
  }
}

init();
