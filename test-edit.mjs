// Tests for the editor's text operations.  Run: node test-edit.mjs
import {
  EditHistory, selectedLineRange, duplicateLines, moveLines, deleteLines,
  replaceSelection, insertChord, insertLine, findAll, findNext, replaceOne,
  replaceAll, compareLines,
} from './edit.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got  ${a}\n  want ${b}`); }
};
const at = (text, pos, end = pos) => ({ text, start: pos, end });

// --- undo history ---------------------------------------------------------------
{
  const h = new EditHistory();
  h.push(at('a', 1));
  h.push(at('ab', 2));
  eq('undo steps back', h.undo(at('abc', 3)).text, 'ab');
  eq('…and again', h.undo(at('ab', 2)).text, 'a');
  eq('nothing left to undo', h.undo(at('a', 1)), null);
  eq('redo comes forward', h.redo(at('a', 1)).text, 'ab');
  eq('…to where we were', h.redo(at('ab', 2)).text, 'abc');
  eq('nothing left to redo', h.redo(at('abc', 3)), null);

  const h2 = new EditHistory();
  h2.push(at('x', 1));
  h2.push(at('x', 1));
  eq('identical states are not stacked', h2.undoStack.length, 1);
  h2.push(at('xy', 2));
  h2.undo(at('xyz', 3));
  h2.push(at('xy!', 3));
  eq('a new change clears redo', h2.canRedo, false);

  const h3 = new EditHistory({ limit: 3 });
  for (const t of ['1', '2', '3', '4', '5']) h3.push(at(t, 1));
  eq('history is capped', h3.undoStack.map((s) => s.text), ['3', '4', '5']);

  // With a custom comparison, a change to another field is a real step.
  const form = new EditHistory({ same: (a, b) => a.text === b.text && a.title === b.title });
  form.push({ ...at('body', 0), title: 'Old' });
  eq('a title-only change can be undone', form.undo({ ...at('body', 0), title: 'New' }).title, 'Old');

  const h4 = new EditHistory();
  h4.push(at('same', 4));
  eq('a step that changed nothing is skipped', h4.undo(at('same', 4)), null);
  eq('selection is restored with the text', (() => { const h = new EditHistory(); h.push(at('hello', 1, 3)); return h.undo(at('hello!', 6)); })(), at('hello', 1, 3));
}

// --- line tools ----------------------------------------------------------------------
const T = 'one\ntwo\nthree';
eq('line under the cursor', selectedLineRange(at(T, 5)), [4, 7]);
eq('selection across two lines', selectedLineRange(at(T, 5, 10)), [4, 13]);
eq('selection ending at a line start stops before it', selectedLineRange(at(T, 4, 8)), [4, 7]);

eq('duplicate', duplicateLines(at(T, 5)), at('one\ntwo\ntwo\nthree', 9));
eq('duplicate the last line', duplicateLines(at(T, 10)).text, 'one\ntwo\nthree\nthree');
eq('move up', moveLines(at(T, 5), -1), at('two\none\nthree', 1));
eq('move the first line up: no change', moveLines(at(T, 1), -1), at(T, 1));
eq('move down', moveLines(at(T, 5), 1), at('one\nthree\ntwo', 11));
eq('move the last line down: no change', moveLines(at(T, 10), 1), at(T, 10));
eq('move two lines together', moveLines(at('a\nb\nc\nd', 2, 5), 1).text, 'a\nd\nb\nc');
eq('delete a middle line', deleteLines(at(T, 5)), at('one\nthree', 4));
eq('delete the last line', deleteLines(at(T, 10)), at('one\ntwo', 4));
eq('delete the only line', deleteLines(at('solo', 2)), at('', 0));
eq('delete two selected lines', deleteLines(at(T, 1, 5)), at('three', 0));

// --- inserting --------------------------------------------------------------------------
eq('replace the selection', replaceSelection(at('hello world', 6, 11), 'there'), at('hello there', 11));
// In a chord row the chord after the cursor must keep its column ("F" at 8).
eq('chord into spaces keeps later chords in place', insertChord(at('Am      F', 4), 'C'), at('Am  C   F', 5));
eq('chord after a letter gets a space', insertChord(at('Am', 2), 'F'), at('Am F', 4));
eq('chord before a letter gets a space', insertChord(at('Am', 0), 'C'), at('C Am', 1));
eq('shorter chord over a selected one is padded', insertChord(at('Am   F', 0, 2), 'C'), at('C    F', 1));
eq('longer chord over a selected one eats spaces', insertChord(at('C    F', 0, 1), 'Am7'), at('Am7  F', 3));
eq('…but always leaves one space before the next', insertChord(at('C F', 0, 1), 'Am7'), at('Am7 F', 3));
// Rows lined up with tabs: a chord between two tabs leaves the next one's tab stop alone.
eq('chord between tabs keeps the tab layout', insertChord(at('Em\t\tAm', 3), 'G'), at('Em\tG\tAm', 4));
eq('ChordPro chord goes in brackets', insertChord(at('word', 0), 'Am', { chordPro: true }), at('[Am]word', 4));
eq('heading above the current line', insertLine(at('Am\nwords', 4), 'Припев:'), at('Am\nПрипев:\nwords', 10));
eq('heading into an empty line', insertLine(at('Am\n\nwords', 3), 'Бой 2'), at('Am\nБой 2\nwords', 8));

// --- find & replace -----------------------------------------------------------------------
const S = 'H7 h7 Am(2) H7';
eq('find, matching case', findAll(S, 'H7'), [0, 12]);
eq('find, ignoring case', findAll(S, 'h7', { matchCase: false }), [0, 3, 12]);
eq('find ignores case in Cyrillic too', findAll('Припев припев', 'ПРИПЕВ', { matchCase: false }), [0, 7]);
eq('special characters are literal', findAll(S, 'Am(2)'), [6]);
eq('find next after the selection', findNext(at(S, 1), 'H7'), at(S, 12, 14));
eq('find next wraps round', findNext(at(S, 13), 'H7'), at(S, 0, 2));
eq('no match', findNext(at(S, 0), 'Dm'), null);
eq('replace the selected match, select the next', replaceOne(at(S, 0, 2), 'H7', 'B7'), at('B7 h7 Am(2) H7', 12, 14));
eq('replace when nothing is selected just finds', replaceOne(at(S, 4), 'H7', 'B7'), at(S, 12, 14));
eq('replace all', replaceAll(S, 'H7', 'B7'), { text: 'B7 h7 Am(2) B7', count: 2 });
eq('"$&" in a replacement is literal', replaceAll('a', 'a', '$&$&').text, '$&$&');

// --- comparing versions -------------------------------------------------------------------
const before = 'one\ntwo\n\nthree\nfour';
const now = 'one\n\nthree   ';
const cmp = compareLines(before, now);
eq('lines gone from the current text', cmp.lines.filter((l) => !l.kept).map((l) => l.line), ['two', 'four']);
eq('counted, blank lines ignored', [cmp.onlyHere, cmp.onlyNow], [2, 0]);
eq('lines added since', compareLines('a\nb', 'a\nx\nb\ny').onlyNow, 2);
eq('identical texts', compareLines('a\nb', 'a\nb'), { lines: [{ line: 'a', kept: true }, { line: 'b', kept: true }], onlyHere: 0, onlyNow: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
