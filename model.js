// model.js — chord grammar, song parsing, transposition, and the render model.
//
// Both supported input formats (plain "chords above lyrics" and ChordPro
// "[Am]inline") are parsed into one internal representation:
//
//   { t: 'line', text: 'Some lyric line', chords: [ { i: 0, c: 'Am' }, ... ] }
//
// Chord positions are character offsets into the lyric text, so transposition
// rewrites chord *symbols* without ever disturbing alignment.

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Keys conventionally written with flats. Everything else gets sharps; C major
// and A minor have no accidentals either way.
const MAJOR_FLAT_KEYS = new Set([1, 3, 5, 8, 10]);      // Db Eb F Ab Bb
const MINOR_FLAT_KEYS = new Set([0, 2, 3, 5, 7, 10]);   // Cm Dm Ebm Fm Gm Bbm

// A chord suffix is built only from these tokens. Anything else means the word
// is a lyric, not a chord — this is what stops "Bad", "Dear" and "Can" from
// being mistaken for B, D and C.
const QUALITY = '(?:maj|Maj|MAJ|min|Min|dim|aug|sus|add|alt|dom|M|m|\\+|°|ø|Δ)';
const SUFFIX_RE = new RegExp(`^(?:${QUALITY}|[0-9]|[#b]|\\(|\\)|-)*$`);
const CHORD_RE = /^([A-G])([#b]{0,2})([^/\s]*?)(?:\/([A-G])([#b]{0,2}))?$/;
const NO_CHORD_RE = /^(n\.?c\.?|stop|tacet)$/i;

// ---------------------------------------------------------------------------
// Chord parsing and transposition
// ---------------------------------------------------------------------------

export function parseChord(token) {
  if (!token) return null;
  const t = token.trim();
  if (!t) return null;
  if (NO_CHORD_RE.test(t)) return { special: t };
  const m = CHORD_RE.exec(t);
  if (!m) return null;
  const [, root, acc, suffix, bassRoot, bassAcc] = m;
  if (!SUFFIX_RE.test(suffix)) return null;
  return {
    root,
    acc: acc || '',
    suffix: suffix || '',
    bass: bassRoot ? { root: bassRoot, acc: bassAcc || '' } : null,
  };
}

export function isChordToken(token) {
  return parseChord(token) !== null;
}

function pitchOf(root, acc) {
  let p = NATURAL[root];
  for (const ch of acc) p += ch === '#' ? 1 : -1;
  return ((p % 12) + 12) % 12;
}

/** Semitone offset of a chord's root, or null if the token isn't a chord. */
export function rootPitch(token) {
  const c = parseChord(token);
  if (!c || c.special) return null;
  return pitchOf(c.root, c.acc);
}

export function isMinorChord(token) {
  const c = parseChord(token);
  if (!c || c.special) return false;
  // "m" or "min", but not "maj" / "M".
  return /^(m(?!aj)|min)/.test(c.suffix);
}

/**
 * Transpose a chord symbol by `semitones`, spelling accidentals with sharps or
 * flats according to `useFlats`. Returns the token unchanged if unparseable.
 */
export function transposeChord(token, semitones, useFlats) {
  const c = parseChord(token);
  if (!c) return token;
  if (c.special) return token;
  const names = useFlats ? FLAT_NAMES : SHARP_NAMES;
  const root = names[(pitchOf(c.root, c.acc) + semitones % 12 + 12) % 12];
  let out = root + c.suffix;
  if (c.bass) out += '/' + names[(pitchOf(c.bass.root, c.bass.acc) + semitones % 12 + 12) % 12];
  return out;
}

/**
 * Decide whether a song should be spelled with flats once transposed.
 * `pref` is 'auto' | 'sharp' | 'flat'.
 */
export function useFlatsFor(song, parsed, shift, pref = 'auto') {
  if (pref === 'flat') return true;
  if (pref === 'sharp') return false;
  const tonic = tonicOf(song, parsed);
  if (!tonic) return false;
  const pc = (tonic.pitch + shift % 12 + 12) % 12;
  return tonic.minor ? MINOR_FLAT_KEYS.has(pc) : MAJOR_FLAT_KEYS.has(pc);
}

/** Best guess at the song's tonic: an explicit key, else the first chord. */
export function tonicOf(song, parsed) {
  const explicit = song && song.key;
  if (explicit) {
    const p = rootPitch(explicit);
    if (p !== null) return { pitch: p, minor: isMinorChord(explicit) };
  }
  for (const line of parsed.lines) {
    if (line.t === 'line' && line.chords.length) {
      const first = line.chords[0].c;
      const p = rootPitch(first);
      if (p !== null) return { pitch: p, minor: isMinorChord(first) };
    }
  }
  return null;
}

/** Human-readable key name, e.g. "Bbm" or "D". */
export function keyName(pitch, minor, useFlats) {
  const names = useFlats ? FLAT_NAMES : SHARP_NAMES;
  return names[((pitch % 12) + 12) % 12] + (minor ? 'm' : '');
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * ChordPro is identified by bracketed groups whose contents are *valid chords*.
 * That deliberately excludes "[Verse]" and "[Chorus]", which appear all over
 * plain-text charts copied from tab sites.
 */
export function detectFormat(text) {
  const brackets = text.match(/\[([^\]\n]{1,12})\]/g) || [];
  for (const b of brackets) {
    const inner = b.slice(1, -1).trim();
    if (inner && isChordToken(inner)) return 'chordpro';
  }
  return 'plain';
}

/**
 * True if every token on the line is a chord (an "Am    F    G" line).
 * Single-token lines count too: a bare "C" above an intro is common, whereas a
 * lyric line consisting of nothing but "C" essentially never occurs.
 */
function isChordOnlyLine(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(isChordToken);
}

const SECTION_RE = /^\s*[\[({]?\s*((?:intro|verse|chorus|pre[- ]?chorus|bridge|outro|solo|interlude|instrumental|refrain|hook|coda|tag|ending|breakdown|riff)[^\])}\n]*)\s*[\])}]?\s*:?\s*$/i;

function sectionLabel(line) {
  const m = SECTION_RE.exec(line);
  if (m) return m[1].trim();
  // Bracketed non-chord on its own line, e.g. "[Part 2]".
  const b = /^\s*\[([^\]\n]{1,30})\]\s*$/.exec(line);
  if (b && !isChordToken(b[1].trim())) return b[1].trim();
  return null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse song text into the internal line model.
 * Returns { format, lines, meta } where meta may carry title/artist/capo
 * picked up from ChordPro directives.
 */
export function parseSong(text, formatHint) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const format = formatHint || detectFormat(src);
  return format === 'chordpro' ? parseChordPro(src) : parsePlain(src);
}

function parseChordPro(src) {
  const lines = [];
  const meta = {};
  for (const raw of src.split('\n')) {
    const directive = /^\s*\{\s*([a-z_]+)\s*:?\s*([^}]*)\}\s*$/i.exec(raw);
    if (directive) {
      const name = directive[1].toLowerCase();
      const value = directive[2].trim();
      if (name === 'title' || name === 't') meta.title = value;
      else if (name === 'artist' || name === 'subtitle' || name === 'st') meta.artist = value;
      else if (name === 'key') meta.key = value;
      else if (name === 'capo') meta.capo = parseInt(value, 10) || 0;
      else if (name === 'comment' || name === 'c') lines.push({ t: 'comment', text: value });
      else if (/^(soc|start_of_chorus)$/.test(name)) lines.push({ t: 'section', label: 'Chorus' });
      else if (/^(sob|start_of_bridge)$/.test(name)) lines.push({ t: 'section', label: 'Bridge' });
      else if (/^(sov|start_of_verse)$/.test(name)) lines.push({ t: 'section', label: value || 'Verse' });
      continue;
    }
    if (!raw.trim()) { lines.push({ t: 'blank' }); continue; }

    const label = sectionLabel(raw);
    if (label) { lines.push({ t: 'section', label }); continue; }

    // Walk the line, peeling off [chord] groups and recording where they land.
    let text = '';
    const chords = [];
    const re = /\[([^\]\n]*)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      text += raw.slice(last, m.index);
      const inner = m[1].trim();
      if (isChordToken(inner)) chords.push({ i: text.length, c: inner });
      else text += m[0]; // not a chord — keep the brackets as literal text
      last = m.index + m[0].length;
    }
    text += raw.slice(last);
    lines.push({ t: 'line', text: text.replace(/\s+$/, ''), chords });
  }
  return { format: 'chordpro', lines, meta };
}

function parsePlain(src) {
  const raw = src.split('\n');
  const lines = [];
  const meta = {};
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line.trim()) { lines.push({ t: 'blank' }); continue; }

    const label = sectionLabel(line);
    if (label) { lines.push({ t: 'section', label }); continue; }

    if (isChordOnlyLine(line)) {
      const chords = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(line)) !== null) chords.push({ i: m.index, c: m[0] });

      // Pair with the following line if that line is lyrics.
      const next = raw[i + 1];
      const nextIsLyric = next != null && next.trim() && !isChordOnlyLine(next) && !sectionLabel(next);
      if (nextIsLyric) {
        lines.push({ t: 'line', text: next.replace(/\s+$/, ''), chords });
        i++;
      } else {
        lines.push({ t: 'line', text: '', chords });
      }
      continue;
    }

    lines.push({ t: 'line', text: line.replace(/\s+$/, ''), chords: [] });
  }
  return { format: 'plain', lines, meta };
}

// ---------------------------------------------------------------------------
// Render model
// ---------------------------------------------------------------------------

/**
 * Split a parsed line into positioned segments for rendering. Each segment is
 * { chord, text }; the chord sits directly above the first character of its
 * text. Chordless runs are split at spaces so long lines can still wrap on a
 * narrow phone screen without breaking chord alignment.
 */
export function segmentsFor(line, shift, useFlats) {
  const chords = [...line.chords].sort((a, b) => a.i - b.i);
  let text = line.text || '';

  // A chord may sit past the end of a short lyric line; pad so it still shows.
  const maxIndex = chords.length ? chords[chords.length - 1].i : 0;
  if (maxIndex > text.length) text += ' '.repeat(maxIndex - text.length);

  const segments = [];
  const pushChordless = (chunk) => {
    if (!chunk) return;
    // Keep each word with its trailing spaces so wrapping looks natural.
    const parts = chunk.match(/\S+\s*|\s+/g) || [];
    for (const p of parts) segments.push({ chord: null, text: p });
  };

  if (!chords.length) {
    if (text) pushChordless(text);
    return segments;
  }

  pushChordless(text.slice(0, chords[0].i));
  for (let k = 0; k < chords.length; k++) {
    const start = chords[k].i;
    const end = k + 1 < chords.length ? chords[k + 1].i : text.length;
    segments.push({
      chord: transposeChord(chords[k].c, shift, useFlats),
      text: text.slice(start, end),
    });
  }
  return segments;
}

/**
 * The net semitone shift applied to written chords for display.
 * Sounding pitch  = written + transpose
 * Fingered shape  = sounding - capo   ← what the player actually sees
 */
export function displayShift(transpose, capo) {
  return (transpose || 0) - (capo || 0);
}

/** Every distinct chord in the song, in first-appearance order, transposed. */
export function chordInventory(parsed, shift, useFlats) {
  const seen = new Set();
  const out = [];
  for (const line of parsed.lines) {
    if (line.t !== 'line') continue;
    for (const ch of line.chords) {
      const t = transposeChord(ch.c, shift, useFlats);
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}
