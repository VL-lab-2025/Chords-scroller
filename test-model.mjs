// Sanity tests for the parsing / transposition core.  Run: node test-model.mjs
import {
  isChordToken, detectFormat, parseSong, transposeChord,
  segmentsFor, displayShift, useFlatsFor, tonicOf, keyName,
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
eq('segment chords', seg.map(s => s.chord), ['Am', 'F']);
eq('segment text rejoins', seg.map(s => s.text).join(''), 'Some lyric line here');

// chord sitting past the end of a short lyric line still renders
const past = segmentsFor({ t: 'line', text: 'hi', chords: [{ i: 6, c: 'G' }] }, 0, false);
eq('chord past end of lyric', past[past.length - 1].chord, 'G');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
