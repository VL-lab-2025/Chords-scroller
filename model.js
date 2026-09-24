// model.js — chord grammar, song parsing, transposition, and the render model.
//
// Plain "chords above lyrics" charts and ChordPro "[Am]inline" chords both
// parse into one internal representation:
//
//   { t: 'line', text: 'Some lyric line', chords: [ { i: 0, c: 'Am' }, ... ] }
//
// Chord positions are character offsets into the lyric text, so transposition
// rewrites chord *symbols* without ever disturbing alignment. Chord-row entries
// flagged `x: true` are decorations — repeat marks, bar lines, strum arrows,
// labels — shown where they were written but never transposed.

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

// Charts typed on a Russian keyboard layout often contain Cyrillic letters that
// look identical to chord letters (С, Е, А…), and Russian and German notation
// write B natural as H. Both are mapped — but only when the result then parses
// as a chord, so ordinary Cyrillic words are never touched.
const HOMOGLYPHS = { 'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'м': 'm' };
const HOMOGLYPH_RE = /[АВСЕНм]/g;

// Measured on a real songbook: full-width spaces (U+3000) used for alignment
// behave as one column, not the two a monospace terminal would give them.
// Tabs were too rare there to measure; 4 is the common editor default.
const TAB_STOP = 4;

// Section headings, English plus Russian and Ukrainian. A keyword only counts
// when it is not the start of a longer word ("Припевка" is not a heading).
const SECTION_WORDS =
  'intro|verse|chorus|pre[- ]?chorus|bridge|outro|solo|interlude|instrumental|refrain|hook|coda|tag|ending|breakdown|riff|' +
  'вступление|вступ|проигрыш|програш|припев|приспів|куплет|запев|рефрен|бридж|соло|кода|концовка|окончание|финал|интро|аутро|переход';
// Performance notes: strumming pattern (бой), picking (перебор), capo, key.
const META_WORDS =
  'бой|перебор|ритм|размер|темп|тональность|строй|каподастр|капо|capo|tuning|tempo|bpm|strumming|strum|picking';
const NOT_LETTER = '(?![a-zа-яёіїєґ])';

const SECTION_RE = new RegExp(
  `^\\s*[\\[({]?\\s*(${SECTION_WORDS})${NOT_LETTER}(\\s*\\d+)?\\s*[\\])}]?(.*)$`, 'i');
const META_LINE_RE = new RegExp(`^\\s*(?:(?:${META_WORDS})${NOT_LETTER}|Б\\d|key\\s*:|tone\\s*:)`, 'i');
const LABEL_TOKEN_RE = new RegExp(`^[\\[(]?(?:${SECTION_WORDS}|${META_WORDS})\\d*[\\])]?[:./]*$`, 'i');
const DIRECTIVE_RE = /^\s*\{\s*([a-z_]+)\s*:?\s*([^}]*)\}\s*$/i;

// Things written in a chord row that are not chords.
const DECORATION_RES = [
  /^[}\])]?[xх×*]\d{1,2}\)?$/i,           // x2, х2 (Cyrillic), }x2, ×4
  /^\(?\d{1,2}\s*[xх×]\)?$/i,             // 2x, (2x)
  /^\([^()]{1,16}\)$/,                    // (2), (x2), (баррэ)
  /^\d{1,2}$/,                            // bare counts
  /^\d{1,2}\s*р(?:аза?)?\.?$/i,           // 2р, 2раза
  /^(?:раза?|times|repeat)$/i,
  /^[|‖/\\:.,;~–—\-→←↑↓>]+$/,            // bar lines, arrows, separators
  /^[{}]$/,
  /^Б\d\/?$/,                             // "Б1/", shorthand for "Бой 1/"
];

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------

/** Turn tabs, full-width and non-breaking spaces into plain columns. */
export function normalizeSpaces(line) {
  const s = String(line == null ? '' : line);
  if (!/[\t\u00A0\u2000-\u200B\u3000\uFEFF\r]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') out += ' '.repeat(TAB_STOP - (out.length % TAB_STOP));
    else if (ch === '\u200B' || ch === '\uFEFF' || ch === '\r') continue;
    else if (ch === '\u00A0' || ch === '\u3000' || (ch >= '\u2000' && ch <= '\u200A')) out += ' ';
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chord parsing and transposition
// ---------------------------------------------------------------------------

function matchChord(t) {
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

export function parseChord(token) {
  if (!token) return null;
  const t = token.trim();
  if (!t) return null;
  if (NO_CHORD_RE.test(t)) return { special: t };
  const direct = matchChord(t);
  if (direct) return direct;
  const canon = t.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch]).replace(/^H/, 'B').replace(/\/H/, '/B');
  return canon === t ? null : matchChord(canon);
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
 *
 * With `keepWritten`, an untransposed chord is shown as its author wrote it —
 * "H7" stays "H7" rather than becoming "B7" — apart from Cyrillic look-alike
 * letters, which are swapped for the Latin ones they imitate.
 */
export function transposeChord(token, semitones, useFlats, keepWritten = false) {
  const c = parseChord(token);
  if (!c || c.special) return token;
  const s = ((semitones % 12) + 12) % 12;
  if (keepWritten && s === 0) return token.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch]);
  const names = useFlats ? FLAT_NAMES : SHARP_NAMES;
  let out = names[(pitchOf(c.root, c.acc) + s) % 12] + c.suffix;
  if (c.bass) out += '/' + names[(pitchOf(c.bass.root, c.bass.acc) + s) % 12];
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
    if (line.t !== 'line') continue;
    for (const ch of line.chords) {
      if (ch.x) continue;
      const p = rootPitch(ch.c);
      if (p !== null) return { pitch: p, minor: isMinorChord(ch.c) };
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
// Line classification
// ---------------------------------------------------------------------------

/**
 * ChordPro is identified by bracketed groups whose contents are *valid chords*.
 * That deliberately excludes "[Verse]" and "[Chorus]", which appear all over
 * plain-text charts copied from tab sites. The parser handles both formats
 * line by line, so this only labels the song for the editor.
 */
export function detectFormat(text) {
  const brackets = String(text).match(/\[([^\]\n]{1,12})\]/g) || [];
  for (const b of brackets) {
    const inner = b.slice(1, -1).trim();
    if (inner && isChordToken(inner)) return 'chordpro';
  }
  return 'plain';
}

export function isDecoration(token) {
  return DECORATION_RES.some((re) => re.test(token)) || LABEL_TOKEN_RE.test(token);
}

/** Tokens with their columns. A chord glued to a repeat brace ("E}x2") splits. */
function tokenize(line) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const glued = /^([^}]+)(\}.*)$/.exec(m[0]);
    if (glued && parseChord(glued[1])) {
      out.push({ i: m.index, c: glued[1] });
      out.push({ i: m.index + glued[1].length, c: glued[2], glued: true });
    } else {
      out.push({ i: m.index, c: m[0] });
    }
  }
  return out;
}

/**
 * The chord-row tokens if a line holds only chords and decorations — "Am  F",
 * "Am (2) | E ↓", "Вступление: Am G C E" — otherwise null. A single chord is
 * enough: a bare "C" above an intro is common, a lyric line of just "C" is not.
 */
function chordRow(line) {
  const toks = tokenize(line);
  let chords = 0;
  for (const t of toks) {
    if (parseChord(t.c)) chords++;
    else if (isDecoration(t.c)) t.x = true;
    else return null;
  }
  return chords ? toks : null;
}

function hasBracketChord(line) {
  const re = /\[([^\]\n]{1,16})\]/g;
  let m;
  while ((m = re.exec(line)) !== null) if (parseChord(m[1].trim())) return true;
  return false;
}

/**
 * A heading such as "Припев:", "[Verse 2]" or "Chorus x2", split into its
 * label and any trailing note. A lyric that merely starts with a keyword
 * ("Соло моей гитары…") is rejected.
 */
function sectionOf(line) {
  const m = SECTION_RE.exec(line);
  if (m) {
    const label = m[1] + (m[2] ? ' ' + m[2].trim() : '');
    const rest = m[3];
    const r = rest.trim();
    if (r) {
      const punctLead = /^[:/.\-–—)\]]/.test(r);
      const countLead = /^(?:[xх×]\s*\d|\d|\()/i.test(r);
      const shortNote = /^\s/.test(rest) && r.split(/\s+/).length <= 2;
      if (!punctLead && !countLead && !shortNote) return null;
    }
    const note = r.replace(/^[:/.\-–—\s]+/, '').trim();
    return note ? { t: 'section', label, note } : { t: 'section', label };
  }
  // Bracketed non-chord on its own line, e.g. "[Part 2]".
  const b = /^\s*\[([^\]\n]{1,30})\]\s*$/.exec(line);
  if (b && !isChordToken(b[1].trim())) return { t: 'section', label: b[1].trim() };
  return null;
}

export function isMetaLine(line) {
  return META_LINE_RE.test(line);
}

function isLyricLine(line) {
  return !!line.trim() && !DIRECTIVE_RE.test(line) && !hasBracketChord(line) && !chordRow(line)
    && !sectionOf(line) && !isMetaLine(line);
}

/** 'blank' | 'chords' | 'section' | 'meta' | 'text' — used to split songbooks. */
export function lineKind(raw) {
  const line = normalizeSpaces(raw);
  if (!line.trim()) return 'blank';
  if (hasBracketChord(line) || chordRow(line)) return 'chords';
  if (sectionOf(line)) return 'section';
  if (isMetaLine(line)) return 'meta';
  return 'text';
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function applyDirective(name, value, meta, lines) {
  if (name === 'title' || name === 't') meta.title = value;
  else if (name === 'artist' || name === 'subtitle' || name === 'st') meta.artist = value;
  else if (name === 'key') meta.key = value;
  else if (name === 'capo') meta.capo = parseInt(value, 10) || 0;
  else if (name === 'comment' || name === 'c') lines.push({ t: 'comment', text: value });
  else if (/^(soc|start_of_chorus)$/.test(name)) lines.push({ t: 'section', label: 'Chorus' });
  else if (/^(sob|start_of_bridge)$/.test(name)) lines.push({ t: 'section', label: 'Bridge' });
  else if (/^(sov|start_of_verse)$/.test(name)) lines.push({ t: 'section', label: value || 'Verse' });
}

/** Peel [chord] groups off a ChordPro line, recording where each one lands. */
function inlineLine(line) {
  let text = '';
  const chords = [];
  const re = /\[([^\]\n]*)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    text += line.slice(last, m.index);
    const inner = m[1].trim();
    if (parseChord(inner)) chords.push({ i: text.length, c: inner });
    else text += m[0]; // not a chord — keep the brackets as literal text
    last = m.index + m[0].length;
  }
  text += line.slice(last);
  return { t: 'line', text: text.replace(/\s+$/, ''), chords };
}

/**
 * Parse song text into the internal line model.
 * Returns { format, lines, meta } where meta may carry title/artist/capo
 * picked up from ChordPro directives.
 */
export function parseSong(text) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const raw = src.split('\n');
  const lines = [];
  const meta = {};

  for (let n = 0; n < raw.length; n++) {
    const line = normalizeSpaces(raw[n]);

    const directive = DIRECTIVE_RE.exec(line);
    if (directive) { applyDirective(directive[1].toLowerCase(), directive[2].trim(), meta, lines); continue; }
    if (!line.trim()) { lines.push({ t: 'blank' }); continue; }
    if (hasBracketChord(line)) { lines.push(inlineLine(line)); continue; }

    const row = chordRow(line);
    if (row) {
      // Pair a chord row with the lyric line beneath it.
      const next = n + 1 < raw.length ? normalizeSpaces(raw[n + 1]) : null;
      if (next != null && isLyricLine(next)) {
        lines.push({ t: 'line', text: next.replace(/\s+$/, ''), chords: row });
        n++;
      } else {
        lines.push({ t: 'line', text: '', chords: row });
      }
      continue;
    }

    const section = sectionOf(line);
    if (section) { lines.push(section); continue; }
    if (isMetaLine(line)) { lines.push({ t: 'comment', text: line.trim() }); continue; }

    lines.push({ t: 'line', text: line.replace(/\s+$/, ''), chords: [] });
  }
  return { format: detectFormat(src), lines, meta };
}

// ---------------------------------------------------------------------------
// Render model
// ---------------------------------------------------------------------------

/**
 * Split a parsed line into positioned segments for rendering. Each segment is
 * { chord, deco, text }; the chord sits directly above the first character of
 * its text. Chordless runs are split at spaces so long lines can still wrap on
 * a narrow phone screen without breaking chord alignment.
 */
export function segmentsFor(line, shift, useFlats, keepWritten = false) {
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
    for (const p of parts) segments.push({ chord: null, deco: false, text: p });
  };

  if (!chords.length) {
    if (text) pushChordless(text);
    return segments;
  }

  pushChordless(text.slice(0, chords[0].i));
  for (let k = 0; k < chords.length; k++) {
    const ch = chords[k];
    const end = k + 1 < chords.length ? chords[k + 1].i : text.length;
    segments.push({
      chord: ch.x ? ch.c : transposeChord(ch.c, shift, useFlats, keepWritten),
      deco: !!ch.x,
      text: text.slice(ch.i, end),
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

/**
 * Every distinct chord in the song, in first-appearance order, transposed.
 * Repeat counts written onto a chord ("Em(2)") are dropped: it is still Em.
 */
export function chordInventory(parsed, shift, useFlats, keepWritten = false) {
  const seen = new Set();
  const out = [];
  for (const line of parsed.lines) {
    if (line.t !== 'line') continue;
    for (const ch of line.chords) {
      if (ch.x) continue;
      const p = parseChord(ch.c);
      if (!p || p.special) continue;
      const t = transposeChord(ch.c, shift, useFlats, keepWritten).replace(/\(\d+\)$/, '');
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transposing source text (for sharing a song in the key it is played in)
// ---------------------------------------------------------------------------

/**
 * Transpose every chord in a song's source text and leave everything else —
 * lyrics, labels, notes — as written. With no net shift the text comes back
 * untouched, byte for byte.
 */
export function transposeText(body, shift, useFlats) {
  const src = String(body == null ? '' : body).replace(/\r\n?/g, '\n');
  if (((shift % 12) + 12) % 12 === 0) return src;
  return src.split('\n').map((raw) => {
    if (DIRECTIVE_RE.test(raw)) return raw;
    const line = normalizeSpaces(raw);
    if (hasBracketChord(line)) {
      return line.replace(/\[([^\]\n]*)\]/g, (m, inner) =>
        parseChord(inner.trim()) ? `[${transposeChord(inner.trim(), shift, useFlats)}]` : m);
    }
    const row = chordRow(line);
    return row ? layoutRow(row, shift, useFlats) : line;
  }).join('\n');
}

// Re-typeset a chord row with new symbols. Each keeps its column where it can:
// a longer name eats into the gap after it, and pushes the next symbol right
// only when no gap is left, so chords stay over the syllables they belong to.
function layoutRow(tokens, shift, useFlats) {
  let out = '';
  for (const t of tokens) {
    const sym = t.x ? t.c : transposeChord(t.c, shift, useFlats);
    let col = t.i;
    if (t.glued) col = out.length;
    else if (out.length && col <= out.length) col = out.length + 1;
    out += ' '.repeat(Math.max(0, col - out.length)) + sym;
  }
  return out;
}
