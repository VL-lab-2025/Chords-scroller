// Sanity tests for the parsing / transposition core.  Run: node test-model.mjs
import {
  isChordToken, detectFormat, parseSong, transposeChord,
  segmentsFor, unitsFor, displayShift, useFlatsFor, tonicOf, keyName,
  chordInventory, transposeText, normalizeSpaces, lineKind,
} from './model.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got  ${a}\n  want ${b}`); }
};

// --- chord token recognition -----------------------------------------------
for (const t of ['A', 'Am', 'F#m7', 'Cadd9', 'Am7/G', 'Bb', 'Dsus4', 'G/B', 'C#m7b5', 'Emaj7', 'N.C.'])
  eq(`chord "${t}"`, isChordToken(t), true);
for (const t of ['Bad', 'Dear', 'Can', 'Bass', 'Ends', 'Add', 'And', 'Girl', 'the', 'Away'])
  eq(`word "${t}"`, isChordToken(t), false);

// --- format detection -------------------------------------------------------
eq('detect plain w/ [Verse]', detectFormat('[Verse 1]\nAm   F\nsome words'), 'plain');
eq('detect chordpro', detectFormat('[Am]some [F]words'), 'chordpro');

// --- plain-text parsing -----------------------------------------------------
const plain = parseSong('[Verse]\nAm        F\nSome lyric line here\n\nC\n');
eq('plain: section', plain.lines[0], { t: 'section', label: 'Verse' });
eq('plain: paired line', plain.lines[1],
  { t: 'line', text: 'Some lyric line here', chords: [{ i: 0, c: 'Am' }, { i: 10, c: 'F' }] });
eq('plain: blank', plain.lines[2], { t: 'blank' });
eq('plain: lone chord line', plain.lines[3], { t: 'line', text: '', chords: [{ i: 0, c: 'C' }] });

// --- chordpro parsing -------------------------------------------------------
const cp = parseSong('{title: Test}\n[Am]Some [F]lyric line here');
eq('chordpro: title', cp.meta.title, 'Test');
eq('chordpro: line', cp.lines[0],
  { t: 'line', text: 'Some lyric line here', chords: [{ i: 0, c: 'Am' }, { i: 5, c: 'F' }] });

// --- transposition & spelling ----------------------------------------------
eq('Am +1 as flats', transposeChord('Am', 1, true), 'Bbm');
eq('Am +1 as sharps', transposeChord('Am', 1, false), 'A#m');
eq('Am7/G +2 flats', transposeChord('Am7/G', 2, true), 'Bm7/A');
eq('N.C. untouched', transposeChord('N.C.', 5, false), 'N.C.');

// auto spelling should prefer Bbm over A#m for a song in Am transposed up 1
const amSong = parseSong('Am F G\n');
eq('auto picks flats for Bbm', useFlatsFor({}, amSong, 1, 'auto'), true);
eq('auto picks sharps for Bm', useFlatsFor({}, amSong, 2, 'auto'), false);

// --- capo semantics: written Bbm + capo 1 must DISPLAY as Am ----------------
const bbm = parseSong('Bbm   Ebm\nsome words here');
const shift = displayShift(0, 1);
eq('displayShift(0, capo 1)', shift, -1);
const flats = useFlatsFor({}, bbm, shift, 'auto');
eq('capo 1 on Bbm shows Am', transposeChord('Bbm', shift, flats), 'Am');
eq('capo 1 on Ebm shows Dm', transposeChord('Ebm', shift, flats), 'Dm');
const tonic = tonicOf({}, bbm);
eq('sounding key still Bbm', keyName(tonic.pitch, tonic.minor, true), 'Bbm');

// --- segmentation preserves alignment ---------------------------------------
const seg = segmentsFor({ t: 'line', text: 'Some lyric line here', chords: [{ i: 0, c: 'Am' }, { i: 10, c: 'F' }] }, 0, false);
eq('segment chords', seg.filter(s => s.chord).map(s => s.chord), ['Am', 'F']);
eq('segment text rejoins', seg.map(s => s.text).join(''), 'Some lyric line here');

// chord sitting past the end of a short lyric line still renders
const past = segmentsFor({ t: 'line', text: 'hi', chords: [{ i: 6, c: 'G' }] }, 0, false);
eq('chord past end of lyric', past[past.length - 1].chord, 'G');

// --- wrap units: a narrow screen breaks lines only between words -------------
const unitText = (units) => units.map((u) => u.map((s) => s.text).join(''));
const unitChords = (units) => units.map((u) => u.map((s) => s.chord).filter(Boolean));

//            0         1         2         3
//            0123456789012345678901234567890123456
const walk = 'we walk along the river bank at dawn';
const walkUnits = unitsFor({ t: 'line', text: walk, chords: [
  { i: 0, c: 'Am' }, { i: 8, c: 'C' }, { i: 20, c: 'G' }, { i: 32, c: 'E' }] }, 0, false);
eq('one unit per word', unitText(walkUnits), ['we ', 'walk ', 'along ', 'the ', 'river ', 'bank ', 'at ', 'dawn']);
eq('a chord mid-word stays inside its word', walkUnits[4].map((s) => [s.chord, s.text]), [[null, 'ri'], ['G', 'ver ']]);
eq('units rejoin to the line', unitText(walkUnits).join(''), walk);
eq('each label knows the lyric it can float over, across words',
  walkUnits.flat().filter((s) => s.chord).map((s) => [s.span, s.last]),
  [['we walk ', false], ['along the ri', false], ['ver bank at ', false], ['dawn', true]]);
const pastEnd = unitsFor({ t: 'line', text: 'short line', chords: [{ i: 0, c: 'Am' }, { i: 14, c: 'Em(2)' }] }, 0, false);
eq('a chord past the end of the lyric has nothing to float over', pastEnd.flat().at(-1), { chord: 'Em(2)', deco: false, text: '', span: '', last: true });

// Never a unit boundary between two letters — that is exactly a mid-word break.
let pos = 0, midWord = 0;
for (const u of unitText(walkUnits).slice(0, -1)) { pos += u.length; if (/\S/.test(walk[pos - 1]) && /\S/.test(walk[pos])) midWord++; }
eq('no boundary falls inside a word', midWord, 0);

// A chord written over the gap before a word starts that word's unit.
const gap = unitsFor({ t: 'line', text: 'some lyric line here', chords: [{ i: 0, c: 'Am' }, { i: 10, c: 'F' }] }, 0, false);
eq('a chord over a gap travels with the next word', unitText(gap), ['some ', 'lyric', ' line ', 'here']);
eq('…and leads that unit', gap[2][0].chord, 'F');

// The bug behind lines running off the screen: one chord, then a long line.
const long = unitsFor({ t: 'line', text: 'one two three four five', chords: [{ i: 0, c: 'Am' }] }, 0, false);
eq('a long line under one chord can still wrap', unitText(long), ['one ', 'two ', 'three ', 'four ', 'five']);

// A chord row with no lyric wraps between its chords.
const row = unitsFor({ t: 'line', text: '', chords: [{ i: 0, c: 'Am' }, { i: 6, c: 'F' }, { i: 11, c: 'G' }] }, 0, false);
eq('chord row: one unit per chord', unitChords(row), [['Am'], ['F'], ['G']]);

// Decorations take part in the layout like chords, and stay flagged.
const decoUnits = unitsFor({ t: 'line', text: 'some words', chords: [{ i: 0, c: 'Am' }, { i: 5, c: '(2)', x: true }] }, 2, false);
eq('decorations are laid out but not transposed', decoUnits.flat().filter((s) => s.chord).map((s) => [s.chord, s.deco]), [['Bm', false], ['(2)', true]]);

// --- Russian / German notation and Cyrillic look-alikes ---------------------
eq('H7 is B7', transposeChord('H7', 0, false), 'B7');
eq('Hm up one is Cm', transposeChord('Hm', 1, false), 'Cm');
eq('bass H', transposeChord('Em/H', 0, false), 'Em/B');
eq('H7 kept as written when unshifted', transposeChord('H7', 0, false, true), 'H7');
eq('H7 respelled once shifted', transposeChord('H7', 2, false, true), 'C#7');
eq('Cyrillic С is C', transposeChord('С', 0, false), 'C');
eq('Cyrillic Е + Latin m is Em', transposeChord('Еm', 2, false), 'F#m');
eq('look-alike shown as Latin even when kept', transposeChord('С', 0, false, true), 'C');
for (const w of ['Сон', 'Нет', 'Ваня', 'Сердце', 'Ехал'])
  eq(`Cyrillic word "${w}" is not a chord`, isChordToken(w), false);

// --- chord rows with decorations ------------------------------------------
const deco = parseSong('Am (2) | F ↓ }x2\nsome words here').lines[0];
eq('decorated row pairs with lyric', deco.text, 'some words here');
eq('real chords in decorated row', deco.chords.filter(c => !c.x).map(c => c.c), ['Am', 'F']);
eq('decorations kept in place', deco.chords.filter(c => c.x).map(c => c.c), ['(2)', '|', '↓', '}x2']);
eq('Cyrillic х2 is a decoration', parseSong('Am  х2').lines[0].chords.map(c => !!c.x), [false, true]);
eq('chord glued to a repeat brace', parseSong('E}x2').lines[0].chords.map(c => c.c), ['E', '}x2']);
const intro = parseSong('Вступление: Am G C E').lines[0];
eq('label row keeps its label', intro.chords[0], { i: 0, c: 'Вступление:', x: true });
eq('label row chords', intro.chords.slice(1).map(c => c.c), ['Am', 'G', 'C', 'E']);
eq('strum note with chords is a chord row', lineKind('Бой 1 Am C D E'), 'chords');
eq('tonic skips a leading label', tonicOf({}, parseSong('Вступление: Am G')), { pitch: 9, minor: true });

// --- sections and notes -----------------------------------------------------
eq('Припев:', parseSong('Припев:').lines[0], { t: 'section', label: 'Припев' });
eq('[Куплет 2]', parseSong('[Куплет 2]').lines[0], { t: 'section', label: 'Куплет 2' });
eq('Припев: х2 keeps a note', parseSong('Припев: х2').lines[0], { t: 'section', label: 'Припев', note: 'х2' });
eq('Chorus x2', parseSong('Chorus x2').lines[0], { t: 'section', label: 'Chorus', note: 'x2' });
eq('lyric starting with a keyword stays a lyric', parseSong('Соло моей гитары звучит').lines[0].t, 'line');
eq('Припевка is not a heading', parseSong('Припевка').lines[0].t, 'line');
eq('strum note', parseSong('Бой 2').lines[0], { t: 'comment', text: 'Бой 2' });
eq('capo note', parseSong('Capo 3').lines[0], { t: 'comment', text: 'Capo 3' });
eq('Бойцы is a lyric, not a strum note', parseSong('Бойцы шли').lines[0].t, 'line');
eq('chord row does not swallow a section', parseSong('Am\nПрипев:').lines.map(l => l.t), ['line', 'section']);

// --- whitespace -------------------------------------------------------------
eq('full-width space is one column', normalizeSpaces('\u3000\u3000Am'), '  Am');
eq('tab to 4-column stop', normalizeSpaces('Am\tC'), 'Am  C');
const wide = parseSong('\u3000\u3000\u3000Am\nabc lyric').lines[0];
eq('chord after full-width spaces lands on column 3', wide.chords[0].i, 3);

// --- chord inventory ----------------------------------------------------------
eq('inventory drops repeat counts and decorations',
  chordInventory(parseSong('Em(2) Am (2) H7\nwords\nEm'), 0, false, true), ['Em', 'Am', 'H7']);

// --- transposing source text --------------------------------------------------
const chart = 'Am        C\nlyric line here\n[Припев]\nEm    H7\nmore words';
eq('shift 0 is byte-identical', transposeText(chart, 0, false), chart);
eq('columns kept, lyrics untouched', transposeText(chart, 2, false),
  'Bm        D\nlyric line here\n[Припев]\nF#m   C#7\nmore words');
eq('longer name eats the gap, then pushes', transposeText('E F G', 1, false), 'F F# G#');
eq('ChordPro brackets', transposeText('[Am]one [H7]two', 3, false), '[Cm]one [D7]two');
eq('labels and decorations survive', transposeText('Вступление: Am (2) | E}x2', 2, false),
  'Вступление: Bm (2) | F#}x2');
eq('negative shift', transposeText('C', -1, false), 'B');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
