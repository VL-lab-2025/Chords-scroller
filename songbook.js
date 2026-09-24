// songbook.js — reading and writing plain-text song files.
//
// A .txt file may hold one song or a whole songbook. On the way in, songs are
// found by divider lines when the file has them, and otherwise by their title
// lines. On the way out, songbooks are always written with dividers, so an
// exported file splits back into exactly the songs that went into it.

import { lineKind, isMetaLine, parseSong, displayShift, useFlatsFor, transposeText } from './model.js';

// Five or more of the same rule character on a line of its own.
const DIVIDER_RE = /^\s*([=\-_*~—─═])\1{4,}\s*$/;
const DIVIDER = '='.repeat(40);

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Bytes → text. Honours a byte-order mark; otherwise tries UTF-8 and falls back
 * to a legacy single-byte code page. Russian text saved as Windows-1251 is
 * dense with high bytes, Western text in Windows-1252 only has the odd accent,
 * which is enough to tell them apart.
 */
export function decodeBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'UTF-8' };
  }
  if (b[0] === 0xFF && b[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'UTF-16' };
  if (b[0] === 0xFE && b[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'UTF-16' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'UTF-8' };
  } catch {
    let high = 0;
    let letters = 0;
    for (const x of b) {
      if (x >= 0xC0) high++;
      if ((x >= 0x41 && x <= 0x5A) || (x >= 0x61 && x <= 0x7A) || x >= 0xC0) letters++;
    }
    const cyrillic = letters > 0 && high / letters > 0.3;
    const label = cyrillic ? 'windows-1251' : 'windows-1252';
    return { text: new TextDecoder(label).decode(b), encoding: cyrillic ? 'Windows-1251' : 'Windows-1252' };
  }
}

// ---------------------------------------------------------------------------
// Title lines
// ---------------------------------------------------------------------------

/**
 * "Title, Artist" · "Title — Artist" · "Title" → { title, artist }.
 * A leading "12." and a trailing running counter such as "(10)" are dropped.
 * A trailing dash ("Title —") explicitly means there is no artist.
 */
export function parseTitleLine(line) {
  const s = String(line == null ? '' : line).trim()
    .replace(/^\d{1,3}[.)]\s+/, '')
    .replace(/\s*\(\d{1,4}\)\s*$/, '');
  let m = /^(.*\S)\s+[—–]\s*$/.exec(s);
  if (m) return { title: m[1], artist: '' };
  m = /^(.*\S)\s+[—–-]\s+(\S.*)$/.exec(s);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };
  const c = s.lastIndexOf(',');
  if (c > 0 && c < s.length - 1) return { title: s.slice(0, c).trim(), artist: s.slice(c + 1).trim() };
  return { title: s, artist: '' };
}

/** The inverse of parseTitleLine: always reads back as the same title/artist. */
export function formatTitleLine(title, artist) {
  const t = String(title || '').trim() || 'Untitled';
  const a = String(artist || '').trim();
  if (a) return `${t} — ${a}`;
  // Without the trailing dash, "Яхта, парус" would read back as title "Яхта"
  // by artist "парус".
  return /,|\s[—–-]\s/.test(t) ? `${t} —` : t;
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

function trimBlankLines(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

const endsLikeSentence = (s) => /[.!?…;:,]$/.test(s);

/**
 * Does a song start at line i? The strongest evidence is a strumming, capo or
 * key note directly underneath ("Бой 2", "Capo 3") — some songbooks put
 * several text lines between the title and the first chords, so waiting for
 * chords would merge songs. Failing that, a "Title, Artist" line with chords
 * soon after also counts.
 */
function isTitleAt(lines, i) {
  const line = lines[i].trim();
  if (!line || line.length > 80) return false;
  if (i > 0 && lines[i - 1].trim()) return false;
  if (lineKind(line) !== 'text') return false;
  if (i + 1 < lines.length && isMetaLine(lines[i + 1])) return true;
  if (endsLikeSentence(line)) return false;
  const { artist } = parseTitleLine(line);
  if (!artist || artist.length > 40 || artist.split(/\s+/).length > 5) return false;
  if (!/^[\p{Lu}\p{N}"«'(]/u.test(artist)) return false;
  for (let k = i + 1, seen = 0; k < lines.length && seen < 6; k++) {
    if (!lines[k].trim()) continue;
    seen++;
    if (lineKind(lines[k]) === 'chords') return true;
  }
  return false;
}

/** A file holding exactly one song: find its title, or fall back to the file name. */
function singleSong(lines, fileTitle) {
  const body = trimBlankLines(lines);
  const text = body.join('\n');
  const meta = parseSong(text).meta;
  if (meta.title) return { title: meta.title, artist: meta.artist || '', body: text };

  // "Title" then a blank line then the song.
  const first = body.length ? body[0].trim() : '';
  if (first && first.length <= 80 && body.length > 2 && !body[1].trim()
      && lineKind(first) === 'text' && !endsLikeSentence(first)) {
    return { ...parseTitleLine(first), body: trimBlankLines(body.slice(1)).join('\n') };
  }
  // Exported files are named "Title - Artist.txt", so the name is informative.
  return { ...parseTitleLine(fileTitle || 'Untitled'), body: text };
}

/**
 * Split a text file into songs.
 * Returns { collection, songs: [{ title, artist, body }], mode } where
 * `collection` is the songbook's own name if it has one (e.g. a first line
 * "Гитара" above the first song) and `mode` says how songs were found.
 */
export function splitSongbook(text, { filename = '' } = {}) {
  const src = String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const fileTitle = String(filename).replace(/\.[^./\\]*$/, '').trim();

  // Divider mode — our own exports, and many hand-made songbooks.
  if (lines.some((l) => DIVIDER_RE.test(l))) {
    const chunks = [[]];
    for (const l of lines) {
      if (DIVIDER_RE.test(l)) chunks.push([]);
      else chunks[chunks.length - 1].push(l);
    }
    let collection = '';
    const songs = [];
    chunks.map(trimBlankLines).forEach((c, idx) => {
      if (!c.length) return;
      const body = trimBlankLines(c.slice(1));
      if (!body.length) {
        if (idx === 0) collection = c[0].trim();
        return;
      }
      songs.push({ ...parseTitleLine(c[0]), body: body.join('\n') });
    });
    return { collection, songs, mode: 'dividers' };
  }

  // Title mode.
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (isTitleAt(lines, i)) starts.push(i);
  if (!starts.length) return { collection: '', songs: [singleSong(lines, fileTitle)], mode: 'single' };

  let collection = '';
  const songs = [];
  const preamble = trimBlankLines(lines.slice(0, starts[0]));
  if (preamble.length) {
    // A line or two with no chords is the songbook's name; anything more is a
    // song that lost its title.
    const named = preamble.filter((l) => l.trim()).length <= 2
      && !preamble.some((l) => lineKind(l) === 'chords');
    if (named) collection = preamble[0].trim();
    else songs.push({ ...parseTitleLine(fileTitle || 'Untitled'), body: preamble.join('\n') });
  }
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    songs.push({ ...parseTitleLine(lines[s]), body: trimBlankLines(lines.slice(s + 1, end)).join('\n') });
  });
  return { collection, songs, mode: starts.length > 1 ? 'titles' : 'single' };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * A song as plain text. By default it is written the way it is shown — with the
 * song's transpose and capo applied, plus a "Capo N" line — so whoever receives
 * it plays exactly what you play. `asWritten` keeps the original chords.
 */
export function formatSong(song, { asWritten = false } = {}) {
  const s = song.settings || {};
  const head = [formatTitleLine(song.title, song.artist)];
  let body = String(song.body || '').replace(/\r\n?/g, '\n');
  if (!asWritten) {
    const shift = displayShift(s.transpose, s.capo);
    body = transposeText(body, shift, useFlatsFor(song, parseSong(body), shift, s.accidentals));
    if (s.capo > 0) head.push(`Capo ${s.capo}`);
  }
  return `${head.join('\n')}\n\n${trimBlankLines(body.split('\n')).join('\n')}\n`;
}

/** Several songs as one file, divided so it imports back song for song. */
export function formatSongbook(songs, { name = '', asWritten = false } = {}) {
  const parts = [];
  if (name && name.trim()) parts.push(`${name.trim()}\n`);
  for (const song of songs) parts.push(`${DIVIDER}\n${formatSong(song, { asWritten })}`);
  return parts.join('\n');
}

/** Case-, punctuation- and ё/е-insensitive identity, for spotting duplicates. */
export function songKey(title, artist) {
  const n = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `${n(title)}|${n(artist)}`;
}

export function safeFilename(name, ext = 'txt') {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'song'}.${ext}`;
}
