// app.js — views, wiring, and the chord-chart renderer.

import {
  parseSong, segmentsFor, displayShift, useFlatsFor,
  tonicOf, keyName, chordInventory, detectFormat,
} from './model.js';
import {
  DEFAULT_SETTINGS, getSongs, getSong, saveSong, deleteSong,
  getSetlists, getSetlist, saveSetlist, deleteSetlist,
  getPrefs, savePrefs, exportAll, importAll,
  storageEstimate, requestPersistence,
} from './store.js';
import { createPlayer, wakeLockSupported } from './player.js';

const APP_VERSION = '1.0.0';

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
  const out = [];

  for (const line of parsed.lines) {
    if (line.t === 'blank') { out.push('<div class="blank"></div>'); continue; }
    if (line.t === 'section') { out.push(`<div class="section">${esc(line.label)}</div>`); continue; }
    if (line.t === 'comment') { out.push(`<div class="comment">${esc(line.text)}</div>`); continue; }
    if (!line.chords.length) {
      out.push(`<div class="line plain">${line.text ? esc(line.text) : '&nbsp;'}</div>`);
      continue;
    }
    const segs = segmentsFor(line, shift, flats)
      .map(s => `<span class="seg"><span class="ch">${s.chord ? esc(s.chord) : ''}</span>${esc(s.text)}</span>`)
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

/** The chord the player will actually finger first — shown as the list badge. */
function songKeyLabel(song) {
  try {
    const parsed = parseSong(song.body, song.format === 'auto' ? null : song.format);
    const tonic = tonicOf(song, parsed);
    if (!tonic) return '';
    const shift = displayShift(song.settings.transpose, song.settings.capo);
    const flats = useFlatsFor(song, parsed, shift, song.settings.accidentals);
    return keyName(tonic.pitch + shift, tonic.minor, flats);
  } catch { return ''; }
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
  state.parsed = parseSong(song.body, song.format === 'auto' ? null : song.format);
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
  $('#chord-inventory').innerHTML = chordInventory(state.parsed, shift, flats)
    .map(c => `<span>${esc(c)}</span>`).join('');

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
  state.parsed = parseSong(song.body, song.format === 'auto' ? null : song.format);
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

  $('#sheet-settings').classList.remove('hidden');
}

async function exportLibrary() {
  const data = await exportAll();
  const json = JSON.stringify(data, null, 2);
  const name = `songs-scroll-backup-${data.exportedAt.slice(0, 10)}.json`;

  // On iOS the share sheet is far more reliable than a download link, and it
  // lets the file go straight to Files or iCloud Drive.
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Songs Scroll backup' });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user dismissed the sheet
  }

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
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
  $('#btn-new-song').addEventListener('click', () => openEditor(null));
  $('#btn-settings').addEventListener('click', openSettings);
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
  $('#btn-close-settings').addEventListener('click', () => $('#sheet-settings').classList.add('hidden'));
  $('#sheet-settings').addEventListener('click', (e) => {
    if (e.target.id === 'sheet-settings') $('#sheet-settings').classList.add('hidden');
  });

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
