// edit.js — text operations for the song editor, kept free of the DOM so they
// can be tested: undo history, line tools, insertion, find & replace, and a
// line diff for comparing saved versions.
//
// Editor state is { text, start, end }: the text plus the selection, exactly
// as a <textarea> reports them.

// ---------------------------------------------------------------------------
// Undo history
// ---------------------------------------------------------------------------

/**
 * A stack of earlier editor states. The editor decides what counts as one
 * step (a burst of typing, one tool action) and pushes the state from *before*
 * that step; undo returns it, redo walks back forward.
 */
export class EditHistory {
  /**
   * `same(a, b)` decides whether two states hold the same content (the
   * selection doesn't count). By default that is just the text; the editor
   * also compares title, artist and key, so undoing a revert restores them.
   */
  constructor({ limit = 300, same = (a, b) => a.text === b.text } = {}) {
    this.limit = limit;
    this.same = same;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Remember `state` as the point to return to. A no-op if nothing changed. */
  push(state) {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && this.same(last, state)) return;
    this.undoStack.push({ ...state });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** The state to go back to, given where the editor is now; null if none. */
  undo(current) {
    while (this.undoStack.length) {
      const prev = this.undoStack.pop();
      if (this.same(prev, current)) continue; // nothing to undo in that step
      this.redoStack.push({ ...current });
      return prev;
    }
    return null;
  }

  redo(current) {
    if (!this.redoStack.length) return null;
    this.undoStack.push({ ...current });
    return this.redoStack.pop();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const lineStartAt = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const lineEndAt = (text, pos) => {
  const i = text.indexOf('\n', pos);
  return i === -1 ? text.length : i;
};

/**
 * The whole lines a selection touches, as [from, to): `to` stops before the
 * final newline. A selection ending exactly at the start of a line — what a
 * triple-click or drag to the line below produces — doesn't include that line.
 */
export function selectedLineRange({ text, start, end }) {
  const from = lineStartAt(text, start);
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  return [from, lineEndAt(text, Math.max(last, from))];
}

/** Copy the current line(s) below themselves; the cursor moves to the copy. */
export function duplicateLines(state) {
  const { text, start, end } = state;
  const [from, to] = selectedLineRange(state);
  const block = text.slice(from, to);
  const shift = block.length + 1;
  return { text: text.slice(0, to) + '\n' + block + text.slice(to), start: start + shift, end: end + shift };
}

/** Swap the current line(s) with the line above (dir -1) or below (dir +1). */
export function moveLines(state, dir) {
  const { text, start, end } = state;
  const [from, to] = selectedLineRange(state);
  const block = text.slice(from, to);
  if (dir < 0) {
    if (from === 0) return state;
    const prevFrom = lineStartAt(text, from - 1);
    const prev = text.slice(prevFrom, from - 1);
    const shift = prev.length + 1;
    return {
      text: text.slice(0, prevFrom) + block + '\n' + prev + text.slice(to),
      start: start - shift,
      end: end - shift,
    };
  }
  if (to >= text.length) return state;
  const nextTo = lineEndAt(text, to + 1);
  const next = text.slice(to + 1, nextTo);
  const shift = next.length + 1;
  return {
    text: text.slice(0, from) + next + '\n' + block + text.slice(nextTo),
    start: start + shift,
    end: end + shift,
  };
}

/** Remove the current line(s) entirely; the cursor lands where they were. */
export function deleteLines(state) {
  const { text } = state;
  const [from, to] = selectedLineRange(state);
  let a = from;
  let b = to;
  if (b < text.length) b += 1;   // take the newline after the block…
  else if (a > 0) a -= 1;        // …or, on the last line, the one before it
  const out = text.slice(0, a) + text.slice(b);
  const pos = a === from ? from : lineStartAt(out, a);
  return { text: out, start: pos, end: pos };
}

// ---------------------------------------------------------------------------
// Inserting
// ---------------------------------------------------------------------------

/** Replace the selection with `snippet`; the cursor goes `caret` chars in. */
export function replaceSelection({ text, start, end }, snippet, caret = snippet.length) {
  return {
    text: text.slice(0, start) + snippet + text.slice(end),
    start: start + caret,
    end: start + caret,
  };
}

/**
 * Insert a chord at the cursor, or put it in place of the selected one. In a
 * ChordPro song it goes in brackets. In a plain chart it is padded with a
 * space where needed so it never runs into the text beside it — and, because
 * columns matter when chords sit above the lyrics, whatever follows on the
 * line keeps its column: growth comes out of the spaces after the cursor
 * (keeping one before the next chord), and a shorter chord is padded out.
 * The cursor stops right after the chord name.
 */
export function insertChord(state, chord, { chordPro = false } = {}) {
  if (chordPro) return replaceSelection(state, `[${chord}]`);
  const { text, start, end } = state;
  const before = start > 0 ? text[start - 1] : '\n';
  const after = end < text.length ? text[end] : '\n';
  const pre = /\s/.test(before) ? '' : ' ';
  const post = /\s/.test(after) ? '' : ' ';
  let snippet = pre + chord + post;

  const rest = text.slice(end, lineEndAt(text, end));
  const spaces = rest.match(/^ */)[0].length;
  const more = spaces < rest.length; // something else follows on this line
  const growth = snippet.length - (end - start);
  let cut = 0;
  if (growth > 0) cut = Math.min(growth, more ? Math.max(0, spaces - 1) : spaces);
  else if (growth < 0 && more) snippet += ' '.repeat(-growth);

  const caret = start + pre.length + chord.length;
  return { text: text.slice(0, start) + snippet + text.slice(end + cut), start: caret, end: caret };
}

/**
 * Put a whole line — a heading such as "Припев:" or a strum note — above the
 * line the cursor is on, or into that line if it is empty.
 */
export function insertLine(state, line) {
  const { text, start } = state;
  const from = lineStartAt(text, start);
  const to = lineEndAt(text, start);
  const pos = from + line.length;
  if (!text.slice(from, to).trim()) {
    return { text: text.slice(0, from) + line + text.slice(to), start: pos, end: pos };
  }
  return { text: text.slice(0, from) + line + '\n' + text.slice(from), start: pos, end: pos };
}

// ---------------------------------------------------------------------------
// Find & replace
// ---------------------------------------------------------------------------

function matcher(query, matchCase) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, matchCase ? 'gu' : 'giu');
}

/** Start offsets of every match. */
export function findAll(text, query, { matchCase = true } = {}) {
  if (!query) return [];
  return [...text.matchAll(matcher(query, matchCase))].map((m) => m.index);
}

/** The next match after the selection, wrapping round to the top; or null. */
export function findNext(state, query, opts = {}) {
  const hits = findAll(state.text, query, opts);
  if (!hits.length) return null;
  const at = hits.find((i) => i >= state.end) ?? hits[0];
  return { text: state.text, start: at, end: at + query.length };
}

/**
 * Replace the match that is currently selected and move on to the next one;
 * if the selection isn't a match, just find the next one first.
 */
export function replaceOne(state, query, replacement, opts = {}) {
  if (!query) return state;
  const selected = state.text.slice(state.start, state.end);
  const isMatch = opts.matchCase === false
    ? selected.toLowerCase() === query.toLowerCase()
    : selected === query;
  if (!isMatch) return findNext(state, query, opts) || state;
  const replaced = replaceSelection(state, replacement);
  return findNext(replaced, query, opts) || replaced;
}

/** Replace every match; reports how many were changed. */
export function replaceAll(text, query, replacement, { matchCase = true } = {}) {
  if (!query) return { text, count: 0 };
  let count = 0;
  const out = text.replace(matcher(query, matchCase), () => { count++; return replacement; });
  return { text: out, count };
}

// ---------------------------------------------------------------------------
// Comparing versions
// ---------------------------------------------------------------------------

/**
 * Line-by-line comparison of an earlier text `a` with the current text `b`
 * (longest common subsequence, ignoring trailing spaces). For every line of
 * `a` it says whether that line still exists in `b`, and it counts the
 * non-blank lines only one side has — "4 lines here are gone from the current
 * text" is exactly what someone hunting for deleted lines needs to see.
 */
export function compareLines(a, b) {
  const A = String(a).replace(/\r\n?/g, '\n').split('\n');
  const B = String(b).replace(/\r\n?/g, '\n').split('\n');
  const key = (l) => l.replace(/\s+$/, '');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = key(A[i]) === key(B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keptA = new Array(n).fill(false);
  const keptB = new Array(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (key(A[i]) === key(B[j])) { keptA[i] = true; keptB[j] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const blank = (l) => !l.trim();
  return {
    lines: A.map((line, i) => ({ line, kept: keptA[i] || blank(line) })),
    onlyHere: A.filter((l, i) => !keptA[i] && !blank(l)).length,
    onlyNow: B.filter((l, j) => !keptB[j] && !blank(l)).length,
  };
}
