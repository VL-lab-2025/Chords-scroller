// app.js — views, wiring, and the chord-chart renderer.

import {
  parseSong, unitsFor, displayShift, useFlatsFor,
  tonicOf, keyName, chordInventory, detectFormat, lyricLineCount,
} from './model.js';
import {
  DEFAULT_SETTINGS, getSongs, getSong, saveSong,
  getSetlists, getSetlist, saveSetlist, deleteSetlist,
  getPrefs, savePrefs, exportAll, importAll,
  storageEstimate, requestPersistence, getGithubConfig, saveGithubConfig,
  getVersions, trashSong, restoreSong, purgeSong, getTrash, TRASH_DAYS,
  getDraft, saveDraft, clearDraft,
} from './store.js';
import {
  decodeBytes, splitSongbook, formatSong, formatSongbook, songKey, safeFilename, sameSongText,
} from './songbook.js';
import { parseRepo, listSongbooks, downloadFile } from './github.js';
import {
  EditHistory, selectedLineRange, duplicateLines, moveLines, deleteLines, insertChord, insertLine,
  findAll, findNext, replaceOne, replaceAll, compareLines,
} from './edit.js';
import { createPlayer, wakeLockSupported } from './player.js';

const APP_VERSION = '1.6.0';

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
  player: null,
  search: '',
  history: [],
  importDraft: null,   // songs read from .txt files, awaiting confirmation
  pendingDraft: null,  // an unsaved edit found on launch, awaiting a decision
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Back to the view we came from, refreshed: settings may have changed meanwhile. */
function goBack(fallback) {
  const target = state.history.pop() || fallback;
  show(target, { push: false });
  if (target === 'library') refreshLibrary();
  else if (target === 'song' && state.song) syncSongControls();
  else if (target === 'setlist' && state.setlist) renderSetlistDetail();
}

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

/**
 * A brief message at the bottom of the screen, optionally with one action —
 * "Undo" after anything that removes something. A toast with an action stays
 * up longer, so there is time to reach it.
 */
function toast(message, { ms = 2400, action = '', onAction = null } = {}) {
  const el = $('#toast');
  el.replaceChildren(document.createTextNode(message));
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action;
    btn.addEventListener('click', () => { el.classList.add('hidden'); onAction(); });
    el.append(btn);
  }
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), action ? Math.max(ms, 6000) : ms);
}

// ---------------------------------------------------------------------------
// Chart rendering
// ---------------------------------------------------------------------------

// Text is measured on a canvas rather than in the page: songs are often laid
// out while their view is still hidden, and a hidden element has no layout.
const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(text, font) {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/**
 * Render a parsed song into `el`. Segments are joined with no whitespace
 * between them — they are inline-blocks, so stray newlines in the markup would
 * become visible gaps in the lyrics.
 *
 * Chord labels float over the lyric after them, so a chord on the last letter
 * of a word leaves no gap. A segment gets a margin only where its label would
 * not fit: before the next chord (so two labels never overlap), or past the
 * end of the line (so the last chord wraps instead of running off the screen).
 */
function renderChart(el, parsed, settings, song) {
  const shift = displayShift(settings.transpose, settings.capo);
  const flats = useFlatsFor(song, parsed, shift, settings.accidentals);
  // Untransposed, show chords exactly as the author wrote them ("H7" stays
  // "H7"); an explicit ♭/♯ choice respells everything.
  const keep = settings.accidentals === 'auto';
  const px = settings.fontSize;
  const family = getComputedStyle(el).fontFamily || 'sans-serif';
  const lyricFont = `400 ${px}px ${family}`;
  const chordFont = `700 ${0.82 * px}px ${family}`; // matches .chart .ch
  const labelGap = 0.45 * px;
  const shortfall = (s) => (s.chord
    ? textWidth(s.chord, chordFont) + (s.last ? 0 : labelGap) - textWidth(s.span, lyricFont)
    : 0);
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
    // One .w per wrap unit (a word and its chords): the line breaks only
    // between units, never inside a word.
    const units = unitsFor(line, shift, flats, keep)
      .map(unit => `<span class="w">${unit.map(s => {
        const push = shortfall(s);
        const style = push > 0.5 ? ` style="margin-right:${push.toFixed(1)}px"` : '';
        return `<span class="seg"${style}><span class="ch${s.deco ? ' x' : ''}">${s.chord ? esc(s.chord) : ''}</span>${esc(s.text)}</span>`;
      }).join('')}</span>`)
      .join('');
    out.push(`<div class="line">${units}</div>`);
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
  const trash = await getTrash();
  $('#btn-open-trash').textContent = `Recently deleted · ${trash.length}`;
  $('#btn-open-trash').classList.toggle('hidden', !trash.length);
}

/** A count beside a tab's name, hidden while there is nothing to count. */
function setCount(selector, n) {
  const el = $(selector);
  el.textContent = String(n);
  el.classList.toggle('hidden', !n);
}

/** "26 lines", or nothing for a song with no sung lines (chords only). */
const linesLabel = (n) => (n ? plural(n, 'line') : '');

function renderSongList() {
  const q = state.search.trim().toLowerCase();
  const items = state.songs.filter(s =>
    !q || s.title.toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q));
  const total = state.songs.length;

  $('#songs-empty').classList.toggle('hidden', total > 0);
  setCount('#songs-count', total);
  // While searching, say how much of the library the list is showing.
  const found = $('#search-count');
  found.classList.toggle('hidden', !q);
  if (q) {
    found.textContent = items.length
      ? `${items.length} of ${plural(total, 'song')}`
      : `No songs match “${state.search.trim()}”`;
  }

  $('#song-list').innerHTML = items.map(s => {
    const meta = songMeta(s);
    const bits = [s.artist, s.settings.capo ? `capo ${s.settings.capo}` : null, linesLabel(meta.lines)]
      .filter(Boolean).join(' · ');
    return `<li data-song="${esc(s.id)}">
      <div class="item-main">
        <div class="item-title">${esc(s.title)}</div>
        ${bits ? `<div class="item-sub">${esc(bits)}</div>` : ''}
      </div>
      ${meta.key ? `<span class="chip">${esc(meta.key)}</span>` : ''}
    </li>`;
  }).join('');
}

// Search re-renders the list on every keystroke; parsing every song each time
// is wasted work. Any edit or settings change bumps updatedAt, so it keys this.
const songMetaCache = new Map();

/**
 * What the list shows about a song, from one parse: the chord the player will
 * actually finger first (the badge) and the song's length in sung lines.
 */
function songMeta(song) {
  const cacheKey = `${song.id}:${song.updatedAt}`;
  if (songMetaCache.has(cacheKey)) return songMetaCache.get(cacheKey);
  const meta = { key: '', lines: 0 };
  try {
    const parsed = parseSong(song.body);
    meta.lines = lyricLineCount(parsed);
    const tonic = tonicOf(song, parsed);
    if (tonic) {
      const shift = displayShift(song.settings.transpose, song.settings.capo);
      const flats = useFlatsFor(song, parsed, shift, song.settings.accidentals);
      meta.key = keyName(tonic.pitch + shift, tonic.minor, flats);
    }
  } catch { /* an unparseable song simply gets no badge */ }
  songMetaCache.set(cacheKey, meta);
  return meta;
}

function renderSetlistList() {
  setCount('#setlists-count', state.setlists.length);
  $('#setlists-empty').classList.toggle('hidden', state.setlists.length > 0);
  // A deleted song keeps its place in setlists (restoring it brings it back
  // there), but it isn't counted while it is gone.
  const live = new Set(state.songs.map(s => s.id));
  $('#setlist-list').innerHTML = state.setlists.map(sl => `
    <li data-setlist="${esc(sl.id)}">
      <div class="item-main">
        <div class="item-title">${esc(sl.name)}</div>
        <div class="item-sub">${plural(sl.songIds.filter(id => live.has(id)).length, 'song')}</div>
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
  $('#song-artist').textContent = [song.artist, linesLabel(lyricLineCount(state.parsed))]
    .filter(Boolean).join(' · ');
  syncSongControls();
  renderHistoryCount(song.id);
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
//
// Nothing typed here can be lost by accident. Every change can be undone step
// by step, and redone; Revert goes back to the saved text and can itself be
// undone; the status line says as soon as lines go missing; leaving with
// unsaved changes asks first; and the edit in progress is kept as a draft
// while typing, so even iOS closing the app loses nothing. Saving files the
// text it replaces in the song's version history (saveSong in store.js).
// ---------------------------------------------------------------------------

const COMMON_CHORDS = ['Am', 'Dm', 'Em', 'C', 'D', 'E', 'F', 'G', 'A', 'E7', 'A7', 'D7', 'G7', 'B7', 'Bm'];
const HEADINGS = {
  ru: ['Вступление:', 'Куплет:', 'Припев:', 'Проигрыш:', 'Бридж:', 'Соло:', 'Кода:', 'Бой 1', 'Бой 2', 'Бой 3'],
  en: ['Intro:', 'Verse:', 'Chorus:', 'Bridge:', 'Solo:', 'Outro:'],
};
const TYPING_STEP_MS = 900; // a pause this long ends one undo step of typing

/** Same content — the cursor doesn't count. What undo, Revert and "unsaved" compare. */
const sameForm = (a, b) =>
  a.text === b.text && a.title === b.title && a.artist === b.artist && a.key === b.key;

/** Non-blank lines of text — chord rows, words, headings: what a slip deletes. */
const textLines = (text) => text.split('\n').filter(l => l.trim()).length;

const editor = {
  open: false,
  songId: null,         // null while writing a new song
  saved: null,          // the form as last saved: { title, artist, key, text }
  savedLines: 0,
  settings: null,       // the song's display settings, for the preview
  history: new EditHistory({ same: sameForm }),
  typing: '',           // the typing step in progress: which field, insert or delete
  typingTimer: null,
  announced: false,     // the browser said a change is coming (beforeinput)
  lastState: null,      // the form after the latest change, for changes nobody announced
  draftTimer: null,
  hasDraft: false,      // a draft of this edit is stored
  panel: '',            // the open tool panel
  preview: false,
  focusAtTap: null,     // what had focus when the current tap began
  reloadPending: false, // an app update arrived mid-edit; it waits for the editor to close
};

/** Everything in the form, with the cursor or selection in the text. */
function formState() {
  const ta = $('#f-body');
  return {
    text: ta.value, start: ta.selectionStart, end: ta.selectionEnd,
    title: $('#f-title').value, artist: $('#f-artist').value, key: $('#f-key').value,
  };
}

/** Put a state into the form. Records nothing — callers decide what is a step. */
function setForm(st) {
  $('#f-title').value = st.title;
  $('#f-artist').value = st.artist;
  $('#f-key').value = st.key;
  const ta = $('#f-body');
  if (ta.value !== st.text) ta.value = st.text;
  ta.setSelectionRange(st.start, st.end);
}

/**
 * Scroll the text so the cursor's line shows, even without focus — after an
 * undo or a tool, the change should be in view. Lines never wrap in the
 * editor (white-space: pre), so the line's offset is just index × height.
 */
function revealCursor() {
  const ta = $('#f-body');
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 21;
  const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
  const top = (parseFloat(cs.paddingTop) || 0) + line * lh;
  if (top < ta.scrollTop || top + lh > ta.scrollTop + ta.clientHeight) {
    ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  }
}

/** Everything that follows a change to the form, however it was made. */
function afterChange() {
  const f = formState();
  editor.lastState = f;
  const dirty = !sameForm(f, editor.saved);
  $('#format-badge').textContent = f.text.trim() ? detectFormat(f.text) : '';
  $('#ed-undo').disabled = !editor.history.canUndo;
  $('#ed-redo').disabled = !editor.history.canRedo;
  $('#ed-revert').disabled = !dirty;
  renderEditStatus(f, dirty);
  if (editor.panel === 'find') updateFindCount();
  if (editor.preview) renderPreview();
  scheduleDraft();
}

/** "52 lines of text · 2 fewer than saved" — missing lines are the thing to catch. */
function renderEditStatus(f, dirty) {
  const n = textLines(f.text);
  const was = editor.savedLines;
  let html = `${plural(n, 'line')} of text`;
  if (editor.songId) {
    if (n < was) html += ` · <b class="fewer">${was - n} fewer than saved</b>`;
    else if (n > was) html += ` · ${was === 0 ? 'was empty' : `${n - was} more than saved`}`;
    else html += dirty ? ' · unsaved changes' : ' · saved';
  } else if (dirty) {
    html += ' · not saved yet';
  }
  $('#ed-status').innerHTML = html;
  $('#ed-status-bar').classList.toggle('dirty', dirty);
  $('#ed-compare').classList.toggle('hidden', !(editor.songId && dirty));
}

// --- undo steps ---

function endTyping() {
  clearTimeout(editor.typingTimer);
  editor.typing = '';
}

/**
 * Decide what one undo step is, before the browser changes anything. Typing
 * groups into steps, as in Word: a run of insertions or deletions in one
 * field, ended by a pause, a new line, or switching between typing and
 * deleting. A paste, a cut, an autocorrection, and above all wiping out a
 * selection — several lines gone at once — are always a step of their own.
 */
function beforeFormInput(e) {
  const type = e.inputType || '';
  if (type === 'historyUndo') { e.preventDefault(); undo(); return; }
  if (type === 'historyRedo') { e.preventDefault(); redo(); return; }

  const cur = formState();
  const kind = type.startsWith('delete') ? 'delete' : 'insert';
  const ownStep = /^(insertFromPaste|insertFromDrop|insertReplacementText|insertFromYank|deleteByCut)/.test(type)
    || (e.target.id === 'f-body' && cur.end > cur.start);
  const step = `${e.target.id}:${kind}`;
  if (ownStep || editor.typing !== step) editor.history.push(cur);
  editor.typing = ownStep || type === 'insertParagraph' || type === 'insertLineBreak' ? '' : step;
  clearTimeout(editor.typingTimer);
  if (editor.typing) editor.typingTimer = setTimeout(endTyping, TYPING_STEP_MS);
  // The input event follows within this same task; after that, forget it.
  editor.announced = true;
  setTimeout(() => { editor.announced = false; }, 0);
}

/**
 * After any change to the form. Some changes arrive without a beforeinput —
 * dictation, some keyboards and text services — so the step above never
 * happened; record the form as it was before this change instead, or the
 * change could not be undone.
 */
function onFormInput() {
  if (!editor.announced && editor.lastState) {
    endTyping();
    editor.history.push(editor.lastState);
  }
  editor.announced = false;
  afterChange();
}

function undo() {
  endTyping();
  const prev = editor.history.undo(formState());
  if (prev) restoreForm(prev);
  else afterChange();
}

function redo() {
  endTyping();
  const next = editor.history.redo(formState());
  if (next) restoreForm(next);
}

function restoreForm(st) {
  setForm(st);
  revealCursor();
  afterChange();
}

/** Apply a tool's result ({ text, start, end }) as one undoable step. */
function applyEdit(next) {
  endTyping();
  const cur = formState();
  if (next.text === cur.text) {
    $('#f-body').setSelectionRange(next.start, next.end);
    revealCursor();
    return false;
  }
  editor.history.push(cur);
  restoreForm({ ...cur, text: next.text, start: next.start, end: next.end });
  return true;
}

/** A toast whose Undo takes back exactly that action — never something typed after it. */
function undoToast(message) {
  const after = formState();
  toast(message, {
    action: 'Undo',
    onAction: () => {
      if (!editor.open) return;
      if (sameForm(formState(), after)) undo();
      else toast('Use ↶ at the top to step back through your changes');
    },
  });
}

/** Back to the text as last saved. Undo brings the edit back. */
function revertToSaved() {
  if (!editor.open || sameForm(formState(), editor.saved)) return;
  endTyping();
  const cur = formState();
  editor.history.push(cur);
  const pos = Math.min(cur.start, editor.saved.text.length);
  restoreForm({ ...editor.saved, start: pos, end: pos });
  undoToast(editor.songId ? 'Back to the saved text' : 'Cleared');
}

/** After a tool runs, give focus back to the text if that is where it was. */
function refocus() {
  const ta = $('#f-body');
  if (editor.focusAtTap === ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
}

// --- tool panels ---

function togglePanel(name) {
  const next = editor.panel === name ? '' : name;
  editor.panel = next;
  $$('.edit-toolbar [data-panel]').forEach(b => b.setAttribute('aria-expanded', String(b.dataset.panel === next)));
  for (const p of ['chords', 'lines', 'find']) $('#ed-panel-' + p).classList.toggle('hidden', p !== next);
  if (next === 'chords') renderChordPalette();
  if (next === 'find') openFind();
}

/**
 * The song's own chords as written, then common ones, then headings. Drawn
 * when the panel opens and left alone while it is used, so chips never move
 * under a finger. A song written with H (Russian/German: H7 = B7) gets H in
 * the common row too.
 */
function renderChordPalette() {
  const text = $('#f-body').value;
  const mine = chordInventory(parseSong(text), 0, false, true);
  const usesH = mine.some(c => /^H/.test(c));
  const common = COMMON_CHORDS.map(c => (usesH ? c.replace(/^B/, 'H') : c));
  const chip = (c) => `<button class="chip-btn chord keep-focus" data-chord="${esc(c)}">${esc(c)}</button>`;
  $('#ed-song-chords').innerHTML = mine.length ? mine.map(chip).join('') : '<span class="hint">None yet</span>';
  $('#ed-common-chords').innerHTML = common.map(chip).join('');
  const headings = !text.trim() || /[а-яё]/i.test(text) ? HEADINGS.ru : HEADINGS.en;
  $('#ed-headings').innerHTML = headings
    .map(h => `<button class="chip-btn keep-focus" data-heading="${esc(h)}">${esc(h)}</button>`).join('');
}

function insertChordAtCursor(chord) {
  const cur = formState();
  applyEdit(insertChord(cur, chord, { chordPro: detectFormat(cur.text) === 'chordpro' }));
  refocus();
}

function insertHeading(line) {
  applyEdit(insertLine(formState(), line));
  refocus();
}

function lineTool(kind) {
  const cur = formState();
  if (kind === 'duplicate') applyEdit(duplicateLines(cur));
  else if (kind === 'up') applyEdit(moveLines(cur, -1));
  else if (kind === 'down') applyEdit(moveLines(cur, 1));
  else if (kind === 'delete') {
    const [from, to] = selectedLineRange(cur);
    const n = cur.text.slice(from, to).split('\n').length;
    if (applyEdit(deleteLines(cur))) undoToast(n > 1 ? `${n} lines deleted` : 'Line deleted');
  }
  refocus();
}

// --- find & replace ---

const findOpts = () => ({ matchCase: $('#ed-case').checked });

function openFind() {
  const ta = $('#f-body');
  const picked = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  if (picked && !picked.includes('\n') && picked.length <= 40) $('#ed-find').value = picked;
  $('#ed-find').focus();
  $('#ed-find').select();
  updateFindCount();
}

function updateFindCount() {
  const q = $('#ed-find').value;
  const f = formState();
  const hits = q ? findAll(f.text, q, findOpts()) : [];
  const at = hits.indexOf(f.start);
  const onHit = at >= 0 && f.end - f.start === q.length;
  $('#ed-find-count').textContent = !q ? ''
    : !hits.length ? 'Not found'
    : onHit ? `${at + 1} of ${hits.length}`
    : `${hits.length} found`;
  for (const id of ['#ed-find-next', '#ed-replace-one', '#ed-replace-all']) $(id).disabled = !hits.length;
}

/** Select a match in the text. Only a focused textarea shows its selection on an iPhone. */
function showMatch(start, end) {
  const ta = $('#f-body');
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(start, end);
  revealCursor();
  updateFindCount();
}

function findNextMatch() {
  const next = findNext(formState(), $('#ed-find').value, findOpts());
  if (next) showMatch(next.start, next.end);
  else updateFindCount();
}

function replaceCurrent() {
  const q = $('#ed-find').value;
  if (!q) return;
  const cur = formState();
  const next = replaceOne(cur, q, $('#ed-replace').value, findOpts());
  $('#f-body').focus({ preventScroll: true });
  if (!applyEdit(next)) showMatch(next.start, next.end);
  else updateFindCount();
}

function replaceEverywhere() {
  const q = $('#ed-find').value;
  if (!q) return;
  const cur = formState();
  const { text, count } = replaceAll(cur.text, q, $('#ed-replace').value, findOpts());
  if (!count) { updateFindCount(); return; }
  const pos = Math.min(cur.start, text.length);
  applyEdit({ text, start: pos, end: pos });
  undoToast(count === 1 ? 'Replaced 1 match' : `Replaced ${count} matches`);
}

// --- live preview ---

/** The chart as the player lays it out — same font size and wrapping — chords as written. */
function setPreview(on) {
  editor.preview = on;
  $('#ed-preview').setAttribute('aria-pressed', String(on));
  $('#view-editor').classList.toggle('previewing', on);
  $('#ed-preview-pane').classList.toggle('hidden', !on);
  // The other tools work on the text, which is hidden while previewing.
  $$('.edit-toolbar [data-panel]').forEach(b => { b.disabled = on; });
  if (on) {
    togglePanel('');
    $('#f-body').blur();
    renderPreview();
  }
}

function renderPreview() {
  const f = formState();
  const settings = { ...editor.settings, transpose: 0, capo: 0, accidentals: 'auto', showChords: true };
  renderChart($('#ed-preview-pane'), parseSong(f.text), settings, { key: f.key, body: f.text });
}

// --- the draft: survives the app being closed mid-edit ---

function scheduleDraft() {
  clearTimeout(editor.draftTimer);
  editor.draftTimer = setTimeout(writeDraft, 600);
}

/** Store the edit if it differs from the saved song; drop our draft once it doesn't. */
async function writeDraft() {
  clearTimeout(editor.draftTimer);
  if (!editor.open) return;
  const f = formState();
  if (sameForm(f, editor.saved)) {
    if (editor.hasDraft) { editor.hasDraft = false; await clearDraft(); }
    return;
  }
  editor.hasDraft = true;
  await saveDraft({
    songId: editor.songId, title: f.title, artist: f.artist, key: f.key, body: f.text,
    savedAt: new Date().toISOString(),
  });
}

/** Offered on launch when the app was closed with an edit unsaved. */
async function offerDraft() {
  const draft = await getDraft();
  if (!draft) return;
  const song = draft.songId ? await getSong(draft.songId) : null;
  const lines = plural(textLines(draft.body), 'line');
  $('#draft-summary').textContent = song
    ? `Your changes to “${song.title}” from ${when(draft.savedAt)} were not saved: ${lines} of text — the saved song has ${textLines(song.body)}.`
    : `A new song you were writing${draft.title.trim() ? `, “${draft.title.trim()}”,` : ''} was not saved (${lines} of text, ${when(draft.savedAt)}).`;
  state.pendingDraft = { draft, song };
  $('#sheet-draft').classList.remove('hidden');
}

function continueDraft() {
  const { draft, song } = state.pendingDraft || {};
  state.pendingDraft = null;
  closeSheets();
  if (!draft) return;
  openEditor(song, { draft });
}

async function discardDraft() {
  const { draft, song } = state.pendingDraft || {};
  state.pendingDraft = null;
  closeSheets();
  await clearDraft();
  if (draft) toast('Unsaved edit discarded', { action: 'Undo', onAction: () => openEditor(song, { draft }) });
}

// --- opening, saving and leaving ---

/**
 * Open the editor on a song (or a blank one). With `draft`, the draft's text
 * goes in on top of the saved one as an undoable step, so Undo or Revert
 * shows what was saved.
 */
function openEditor(song, { draft = null } = {}) {
  editor.open = true;
  editor.songId = song ? song.id : null;
  editor.saved = song
    ? { title: song.title, artist: song.artist || '', key: song.key || '', text: song.body }
    : { title: '', artist: '', key: '', text: '' };
  editor.savedLines = textLines(editor.saved.text);
  editor.settings = song ? song.settings : { ...state.prefs.defaults };
  editor.history.clear();
  editor.hasDraft = !!draft;
  endTyping();
  setForm({ ...editor.saved, start: 0, end: 0 });
  $('#editor-heading').textContent = song ? 'Edit song' : 'New song';
  $('#ed-find').value = '';
  $('#ed-replace').value = '';
  togglePanel('');
  setPreview(false);
  const view = $('#view-editor');
  view.style.height = '';
  view.style.transform = '';
  show('editor');
  view.querySelector('.scroll-body').scrollTop = 0;
  $('#f-body').scrollTop = 0;
  if (draft) {
    editor.history.push(formState());
    setForm({ title: draft.title, artist: draft.artist, key: draft.key, text: draft.body, start: 0, end: 0 });
  }
  afterChange();
}

/** Back from the editor: straight out if everything is saved, otherwise ask. */
function requestCloseEditor() {
  if (sameForm(formState(), editor.saved)) {
    if (editor.hasDraft) clearDraft();
    closeEditor();
    return;
  }
  const n = textLines($('#f-body').value);
  $('#unsaved-summary').textContent = editor.songId
    ? `“${editor.saved.title}” has changes that aren't saved — ${plural(n, 'line')} of text now, ${editor.savedLines} when saved.`
    : 'This new song isn’t saved yet.';
  $('#sheet-unsaved').classList.remove('hidden');
}

function leaveEditor() {
  editor.open = false;
  clearTimeout(editor.draftTimer);
  endTyping();
  editor.history.clear();
  $('#f-body').blur();
}

function closeEditor() {
  const fallback = editor.songId ? 'song' : 'library';
  leaveEditor();
  goBack(fallback);
  if (editor.reloadPending) location.reload();
}

/** Leave without saving. The text stays in memory a few seconds, behind an Undo. */
async function discardEdit() {
  const f = formState();
  const song = editor.songId ? await getSong(editor.songId) : null;
  closeSheets();
  if (editor.hasDraft) await clearDraft();
  closeEditor();
  toast('Changes discarded', {
    action: 'Undo',
    onAction: () => openEditor(song, { draft: { title: f.title, artist: f.artist, key: f.key, body: f.text } }),
  });
}

async function saveFromEditor() {
  const f = formState();
  if (!f.text.trim()) { closeSheets(); toast('Add some chords or lyrics first'); return; }

  const existing = editor.songId ? await getSong(editor.songId) : null;
  const parsed = parseSong(f.text);
  const record = await saveSong({
    ...(existing || {}),
    id: existing ? existing.id : undefined,
    title: f.title.trim() || parsed.meta.title || 'Untitled',
    artist: f.artist.trim() || parsed.meta.artist || '',
    key: f.key.trim() || parsed.meta.key || '',
    format: 'auto',
    body: f.text,
    settings: existing ? existing.settings : { ...state.prefs.defaults },
  });
  const replaced = existing
    && (existing.body !== record.body || existing.title !== record.title || existing.artist !== record.artist);

  closeSheets();
  leaveEditor();
  await clearDraft();
  editor.hasDraft = false;
  if (editor.reloadPending) { location.reload(); return; }
  await refreshLibrary();
  // Opening the editor pushed the view we came from; saving returns there, so
  // drop that entry or Back would land on the song detail twice.
  state.history.pop();
  await openSong(record.id, { push: false });
  toast(replaced ? 'Saved · the previous text is in Version history' : 'Saved');
}

/** The saved text with the lines this edit has lost highlighted — and a way back to it. */
function openCompare() {
  const cmp = compareLines(editor.saved.text, $('#f-body').value);
  historyView = { mode: 'compare' };
  $('#history-title').textContent = 'Compare with saved';
  $('#history-detail-summary').textContent = (cmp.onlyHere
    ? `Highlighted: ${plural(cmp.onlyHere, 'line')} of the saved text that your edit no longer has.`
    : 'Your edit still has every line of the saved text.')
    + (cmp.onlyNow ? ` It adds or changes ${plural(cmp.onlyNow, 'line')}.` : '');
  renderVersionText(cmp.lines);
  $('#btn-history-restore').textContent = 'Revert to saved text';
  $('#btn-history-back').textContent = 'Keep editing';
  $('#history-list-view').classList.add('hidden');
  $('#history-detail').classList.remove('hidden');
  $('#sheet-history').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Version history and Recently deleted
// ---------------------------------------------------------------------------

const REPLACED_BY = { edit: 'an edit', import: 'an import', restore: 'a restored version' };

/** "today, 14:32", "yesterday, 09:05", "3 Nov, 18:40" — when something happened. */
function when(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate())
    - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days === 0) return `today, ${time}`;
  if (days === 1) return `yesterday, ${time}`;
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

let historyView = null; // { mode: 'versions', song, versions, index } or { mode: 'compare' }

/** The line under "Version history" on the song screen. */
async function renderHistoryCount(id) {
  const versions = await getVersions(id);
  if (!state.song || state.song.id !== id) return; // another song opened meanwhile
  $('#btn-history').disabled = !versions.length;
  $('#history-count').textContent = versions.length
    ? `${plural(versions.length, 'earlier version')} · the latest replaced ${when(versions[0].replacedAt)}`
    : 'None yet. Whenever the words change, the text from before is kept here.';
}

async function openHistory() {
  const song = await getSong(state.song.id);
  if (!song) return;
  historyView = { mode: 'versions', song, versions: await getVersions(song.id), index: -1 };
  $('#history-title').textContent = 'Version history';
  renderHistoryList();
  $('#sheet-history').classList.remove('hidden');
}

function renderHistoryList() {
  const { song, versions } = historyView;
  $('#history-list-view').classList.remove('hidden');
  $('#history-detail').classList.add('hidden');
  $('#history-hint').textContent = versions.length
    ? 'Newest first. Each one is the text as it was until the time shown, when something replaced it. Tap one to see it.'
    : 'No earlier versions yet.';
  $('#history-list').innerHTML = versions.map((v, i) => {
    const missing = compareLines(v.body, song.body).onlyHere;
    const sub = [
      v.title !== song.title ? `“${v.title}”` : '',
      `${plural(textLines(v.body), 'line')} of text`,
      missing ? `${missing} not in the current text` : '',
      `replaced by ${REPLACED_BY[v.reason] || 'an edit'}`,
    ].filter(Boolean).join(' · ');
    return `<li data-version="${i}">
      <div class="item-main">
        <div class="item-title">Until ${esc(when(v.replacedAt))}</div>
        <div class="item-sub">${esc(sub)}</div>
      </div>
    </li>`;
  }).join('');
}

function showVersion(i) {
  const v = historyView.versions[i];
  historyView.index = i;
  const cmp = compareLines(v.body, historyView.song.body);
  $('#history-detail-summary').textContent = [
    `The text until ${when(v.replacedAt)}${v.title !== historyView.song.title ? `, titled “${v.title}”` : ''}.`,
    cmp.onlyHere
      ? `Highlighted: ${plural(cmp.onlyHere, 'line')} the current text no longer has.`
      : 'Every line here is still in the current text.',
  ].join(' ');
  renderVersionText(cmp.lines);
  $('#btn-history-restore').textContent = 'Restore this version';
  $('#btn-history-back').textContent = 'All versions';
  $('#history-list-view').classList.add('hidden');
  $('#history-detail').classList.remove('hidden');
  $('#history-detail-text').scrollTop = 0;
}

function renderVersionText(lines) {
  $('#history-detail-text').innerHTML = lines
    .map(l => `<span class="vl${l.kept ? '' : ' gone'}">${esc(l.line)}</span>`).join('');
}

/** Make an earlier text current again. What it replaces goes into the history in turn. */
async function restoreVersion() {
  const v = historyView.versions[historyView.index];
  const song = await getSong(historyView.song.id);
  if (!v || !song) return;
  await saveSong({ ...song, title: v.title, artist: v.artist, body: v.body }, { reason: 'restore' });
  closeSheets();
  await refreshLibrary();
  await openSong(song.id, { push: false });
  toast('Version restored · the text it replaced is in Version history');
}

/** Days until a deleted song is removed for good. */
const daysLeft = (s) =>
  Math.max(1, Math.ceil((Date.parse(s.deletedAt) + TRASH_DAYS * 86400000 - Date.now()) / 86400000));

async function renderTrash() {
  const items = await getTrash();
  $('#trash-list').innerHTML = items.map(s => `
    <li class="trash-item">
      <div class="item-main">
        <div class="item-title">${esc(s.title)}</div>
        <div class="item-sub">${esc([s.artist, `deleted ${when(s.deletedAt)}`, `${plural(daysLeft(s), 'day')} left`].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="item-actions">
        <button class="chip-btn" data-trash-restore="${esc(s.id)}">Restore</button>
        <button class="chip-btn danger" data-trash-purge="${esc(s.id)}">Delete</button>
      </div>
    </li>`).join('');
  return items;
}

async function openTrash() {
  if (!(await renderTrash()).length) return;
  $('#sheet-trash').classList.remove('hidden');
}

/** After restoring or deleting from Recently deleted: refresh, and close it once empty. */
async function afterTrashChange() {
  await refreshLibrary();
  if (!(await renderTrash()).length) closeSheets();
}

async function deleteSongToTrash() {
  const song = state.song;
  if (!confirm(`Delete “${song.title}”? You can restore it from Recently deleted for ${TRASH_DAYS} days.`)) return;
  await trashSong(song.id);
  await refreshLibrary();
  state.history = [];
  show('library', { push: false });
  toast('Moved to Recently deleted', {
    action: 'Undo',
    onAction: async () => {
      await restoreSong(song.id);
      await refreshLibrary();
      toast(`Restored “${song.title}”`);
    },
  });
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
    const sub = [s.artist, linesLabel(songMeta(s).lines)].filter(Boolean).join(' · ');
    return `<li data-play="${esc(id)}">
      <div class="item-main">
        <div class="item-title">${i + 1}. ${esc(s.title)}</div>
        ${sub ? `<div class="item-sub">${esc(sub)}</div>` : ''}
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
//
// While a song is open the screen belongs to the song: the controls stay
// hidden before it starts, while it scrolls and while it is paused. Tapping
// the text starts or pauses; the ⋯ button brings the controls back, and they
// tuck themselves away again after a few seconds without a touch.
// ---------------------------------------------------------------------------

const CONTROLS_IDLE_MS = 4000;
let controlsTimer = null;
let controlsVisible = false;
let hintTimer = null;

function startPlayer(song, { setlist = null, index = -1 } = {}) {
  state.song = song;
  state.parsed = parseSong(song.body);
  state.setlist = setlist;
  state.setlistIndex = index;

  const s = song.settings;
  const content = $('#player-content');
  renderChart(content, state.parsed, s, song);

  $('#player-title').textContent = song.title;
  $('#progress-fill').style.width = '0%'; // not the last song's progress
  $('#player-key').textContent = stripTags(keyReadout(song, state.parsed, s));
  $('#p-speed-readout').textContent = `${s.speed} px/s`;
  $('#p-next').textContent = nextInSetlist() ? `Next: ${nextInSetlist().title}` : '';

  show('player');

  // The engine re-measures scrollHeight every frame, so there is nothing to
  // wait for here. Creating the player synchronously matters: waiting on
  // requestAnimationFrame would never resolve if the app is backgrounded
  // between pressing play and the first frame, leaving dead controls.
  let wasPlaying = false;
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
      $('#view-player').classList.toggle('playing', st.playing);
      if (!st.playing) $('#countdown').classList.add('hidden');
      // This also fires for every speed or position change; only the moment
      // scrolling starts should put the controls away, or adjusting the speed
      // would hide them mid-adjustment.
      if (st.playing && !wasPlaying) hideControls();
      wasPlaying = st.playing;
    },
    onEnd: () => {
      showControls({ stay: true }); // the song is over: back, restart or next
      const next = nextInSetlist();
      toast(next ? `End of song — next: ${next.title}` : 'End of song');
    },
  });
  player.setSpeed(s.speed);
  state.player = player;

  hideControls();
  showHint(`${keyReadout(song, state.parsed, s)}<br><b>Tap the text to start</b> · ⋯ shows the controls`);
}

const stripTags = (html) => html.replace(/<[^>]*>/g, '');

function nextInSetlist() {
  if (!state.setlist || state.setlistIndex < 0) return null;
  for (const id of state.setlist.songIds.slice(state.setlistIndex + 1)) {
    const song = state.songs.find(s => s.id === id);
    if (song) return song; // skipping any that were deleted
  }
  return null;
}

/** Bring the controls up; they hide again after a pause in touching them. */
function showControls({ stay = false } = {}) {
  controlsVisible = true;
  hideHint();
  $('#player-chrome').classList.remove('dimmed');
  $('#p-handle').classList.add('hidden');
  clearTimeout(controlsTimer);
  if (!stay) controlsTimer = setTimeout(hideControls, CONTROLS_IDLE_MS);
}

function hideControls() {
  controlsVisible = false;
  clearTimeout(controlsTimer);
  $('#player-chrome').classList.add('dimmed');
  $('#p-handle').classList.remove('hidden');
}

/** A brief ▶ or ❚❚ mid-screen: feedback for a tap without the controls. */
function flashState(symbol) {
  const el = $('#p-flash');
  el.textContent = symbol;
  el.classList.remove('show');
  void el.offsetWidth; // restart the animation if it is still running
  el.classList.add('show');
}

function showHint(html) {
  const el = $('#p-hint');
  el.innerHTML = html;
  el.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, 4500);
}

function hideHint() {
  clearTimeout(hintTimer);
  $('#p-hint').classList.add('hidden');
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
  showControls(); // keep them up while they are being used
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
      draft.songs.push({
        ...s, status, existingId: mine ? mine.id : null, selected: status === 'new',
        lines: lyricLineCount(parseSong(s.body)), // a 2-line "song" usually means a bad split
      });
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
        <div class="item-sub">${esc([s.artist, linesLabel(s.lines), note[s.status]].filter(Boolean).join(' · '))}</div>
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
      await saveSong({ ...mine, body: s.body }, { reason: 'import' });
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

/**
 * Keep the editor's header and tools on screen while the keyboard is up. On
 * an iPhone the keyboard covers the page instead of shrinking it, and iOS
 * pans the page to reach the cursor, pushing the toolbar out of sight. The
 * visual viewport is the part still visible: the editor is sized to it and
 * moved with it. Ignored while pinch-zoomed, when the viewport is small for
 * another reason.
 */
function fitEditorAboveKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const view = $('#view-editor');
  const fit = () => {
    const covered = view.classList.contains('active') && Math.abs(vv.scale - 1) < 0.01
      && (vv.height < window.innerHeight - 1 || vv.offsetTop > 0);
    view.style.height = covered ? `${vv.height}px` : '';
    view.style.transform = covered ? `translateY(${vv.offsetTop}px)` : '';
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
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
    if (e.target === sheet && !sheet.hasAttribute('data-modal')) closeSheets();
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
  // Whatever we land on is refreshed — speed and font can be changed from
  // inside the player, so the song controls would otherwise show stale values.
  $$('[data-back]').forEach(btn => btn.addEventListener('click', () => goBack(btn.dataset.back)));

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

  $('#btn-delete-song').addEventListener('click', deleteSongToTrash);

  // --- version history and Recently deleted ---
  $('#btn-history').addEventListener('click', openHistory);
  $('#history-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-version]');
    if (li) showVersion(+li.dataset.version);
  });
  $('#btn-history-restore').addEventListener('click', () => {
    if (historyView && historyView.mode === 'compare') { closeSheets(); revertToSaved(); }
    else restoreVersion();
  });
  $('#btn-history-back').addEventListener('click', () => {
    if (historyView && historyView.mode === 'compare') closeSheets();
    else renderHistoryList();
  });

  $('#btn-open-trash').addEventListener('click', openTrash);
  $('#trash-list').addEventListener('click', async (e) => {
    const restore = e.target.closest('[data-trash-restore]');
    const purge = e.target.closest('[data-trash-purge]');
    if (restore) {
      const song = await restoreSong(restore.dataset.trashRestore);
      await afterTrashChange();
      if (song) toast(`Restored “${song.title}”`);
    } else if (purge) {
      const title = purge.closest('li').querySelector('.item-title').textContent;
      if (!confirm(`Delete “${title}” for good? It can't be brought back.`)) return;
      await purgeSong(purge.dataset.trashPurge);
      await afterTrashChange();
      toast('Deleted for good');
    }
  });
  $('#btn-trash-empty').addEventListener('click', async () => {
    const items = await getTrash();
    if (!items.length) return;
    if (!confirm(`Delete ${plural(items.length, 'song')} for good? They can't be brought back.`)) return;
    for (const s of items) await purgeSong(s.id);
    await afterTrashChange();
    toast('Recently deleted is empty');
  });

  // --- editor ---
  // Tool buttons are .keep-focus: pressing one must not take focus from the
  // text, or the iPhone keyboard would drop and bounce back on every tap.
  document.addEventListener('pointerdown', (e) => {
    editor.focusAtTap = document.activeElement;
    if (e.target.closest && e.target.closest('.keep-focus')) e.preventDefault();
  });
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.keep-focus')) e.preventDefault();
  });

  for (const sel of ['#f-title', '#f-artist', '#f-key', '#f-body']) {
    $(sel).addEventListener('beforeinput', beforeFormInput);
    $(sel).addEventListener('input', onFormInput);
  }
  document.addEventListener('keydown', (e) => {
    if (!editor.open || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (!$('#view-editor').classList.contains('active') || $$('.sheet:not(.hidden)').length) return;
    const k = e.key.toLowerCase();
    // By letter, or by key position for other layouts (Ctrl+Я is Ctrl+Z).
    const is = (letter) => k === letter || e.code === `Key${letter.toUpperCase()}`;
    // In the find and replace boxes, undo belongs to what is typed there.
    if ((is('z') || is('y')) && e.target.closest && e.target.closest('#ed-panel-find')) return;
    if (is('z') && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((is('z') && e.shiftKey) || is('y')) { e.preventDefault(); redo(); }
    else if (is('s')) { e.preventDefault(); saveFromEditor(); }
    else if (is('f') && !editor.preview) {
      e.preventDefault();
      if (editor.panel === 'find') openFind(); else togglePanel('find');
    }
  });

  $('#btn-editor-back').addEventListener('click', requestCloseEditor);
  $('#btn-save-song').addEventListener('click', saveFromEditor);
  $('#ed-undo').addEventListener('click', () => { undo(); refocus(); });
  $('#ed-redo').addEventListener('click', () => { redo(); refocus(); });
  $('#ed-revert').addEventListener('click', () => { revertToSaved(); refocus(); });
  $('#ed-compare').addEventListener('click', openCompare);
  $('#ed-preview').addEventListener('click', () => setPreview(!editor.preview));
  $$('.edit-toolbar [data-panel]').forEach(b => b.addEventListener('click', () => {
    togglePanel(b.dataset.panel);
    if (b.classList.contains('keep-focus')) refocus();
  }));
  $('#ed-panel-chords').addEventListener('click', (e) => {
    const chord = e.target.closest('[data-chord]');
    const heading = e.target.closest('[data-heading]');
    if (chord) insertChordAtCursor(chord.dataset.chord);
    else if (heading) insertHeading(heading.dataset.heading);
  });
  $('#ed-panel-lines').addEventListener('click', (e) => {
    const b = e.target.closest('[data-line]');
    if (b) lineTool(b.dataset.line);
  });
  $('#ed-find').addEventListener('input', updateFindCount);
  $('#ed-find').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findNextMatch(); }
  });
  $('#ed-case').addEventListener('change', updateFindCount);
  $('#ed-find-next').addEventListener('click', findNextMatch);
  $('#ed-replace-one').addEventListener('click', replaceCurrent);
  $('#ed-replace-all').addEventListener('click', replaceEverywhere);

  $('#btn-unsaved-save').addEventListener('click', saveFromEditor);
  $('#btn-unsaved-discard').addEventListener('click', discardEdit);
  $('#btn-unsaved-keep').addEventListener('click', closeSheets);
  $('#btn-draft-restore').addEventListener('click', continueDraft);
  $('#btn-draft-discard').addEventListener('click', discardDraft);

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
  // Tapping the text starts or pauses. If the controls are showing, the tap
  // only puts them away, so a tap meant to clear them never stops the song.
  $('#player-viewport').addEventListener('click', () => {
    if (!state.player || state.player.wasDrag()) return;
    hideHint();
    if (controlsVisible) { hideControls(); return; }
    state.player.toggle(state.song.settings.leadIn);
    const st = state.player.state;
    if (!st.playing) flashState('❚❚');
    else if (!st.leadIn) flashState('▶'); // with a lead-in, the countdown is the feedback
  });
  $('#p-handle').addEventListener('click', () => showControls());

  $('#p-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.player) return;
    state.player.toggle(state.song.settings.leadIn);
    // Starting puts the controls away (see onStateChange); pausing from here
    // usually means something is about to be adjusted, so they stay a while.
    if (!state.player.state.playing) showControls();
  });
  $('#p-slower').addEventListener('click', () => adjustPlayerSetting('speed', -2, 4, 200));
  $('#p-faster').addEventListener('click', () => adjustPlayerSetting('speed', 2, 4, 200));
  $('#p-font-down').addEventListener('click', () => adjustPlayerSetting('fontSize', -1, 12, 44));
  $('#p-font-up').addEventListener('click', () => adjustPlayerSetting('fontSize', 1, 12, 44));
  $('#btn-restart').addEventListener('click', () => {
    if (!state.player) return;
    state.player.reset();
    showControls();
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
  fitEditorAboveKeyboard();
  await refreshLibrary();
  requestPersistence();
  await offerDraft();

  // iOS may close a backgrounded app without warning: store the edit now
  // rather than when the typing pause ends.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && editor.open) writeDraft();
  });

  if ('serviceWorker' in navigator) {
    // A new service worker calls skipWaiting and claims this page, but the JS
    // already running is still the old copy — reload once so an update you just
    // published actually takes effect instead of appearing to do nothing.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return; // first install: nothing to replace
      // Never mid-edit: the reload waits until the editor is closed.
      if (editor.open) { editor.reloadPending = true; return; }
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Offline caching unavailable (e.g. opened over file://) — app still runs.
    });
  }
}

init();
