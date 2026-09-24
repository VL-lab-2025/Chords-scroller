// Tests for reading and writing .txt songbooks.  Run: node test-songbook.mjs
//
// The fixture imitates the layout of a real hand-made songbook — "Title,
// Artist" lines, a strumming note underneath, a running "(10)" counter,
// Cyrillic look-alike chords — using invented placeholder text only.
import {
  decodeBytes, parseTitleLine, formatTitleLine, splitSongbook,
  formatSong, formatSongbook, songKey, safeFilename, sameSongText,
} from './songbook.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got  ${a}\n  want ${b}`); }
};

// --- decoding -----------------------------------------------------------------
const enc = (s) => new TextEncoder().encode(s);
eq('utf-8', decodeBytes(enc('Привет Am')), { text: 'Привет Am', encoding: 'UTF-8' });
eq('utf-8 with BOM', decodeBytes(new Uint8Array([0xEF, 0xBB, 0xBF, ...enc('Am')])).text, 'Am');
eq('utf-16 LE with BOM', decodeBytes(new Uint8Array([0xFF, 0xFE, 0x41, 0x00, 0x6D, 0x00])), { text: 'Am', encoding: 'UTF-16' });
// "Привет" in Windows-1251
eq('windows-1251', decodeBytes(new Uint8Array([0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2])), { text: 'Привет', encoding: 'Windows-1251' });
// "Café au lait" in Windows-1252: one accented letter among plain ones
eq('windows-1252', decodeBytes(new Uint8Array([...enc('Caf'), 0xE9, ...enc(' au lait')])), { text: 'Café au lait', encoding: 'Windows-1252' });

// --- title lines ----------------------------------------------------------------
eq('Title, Artist', parseTitleLine('Первая песня, Группа'), { title: 'Первая песня', artist: 'Группа' });
eq('comma inside the title', parseTitleLine('Раз, два, Группа'), { title: 'Раз, два', artist: 'Группа' });
eq('running counter dropped', parseTitleLine('Песня, Группа (10)'), { title: 'Песня', artist: 'Группа' });
eq('em dash', parseTitleLine('Песня — Группа'), { title: 'Песня', artist: 'Группа' });
eq('file-name hyphen', parseTitleLine('Песня - Группа'), { title: 'Песня', artist: 'Группа' });
eq('numbered entry', parseTitleLine('12. Песня, Группа'), { title: 'Песня', artist: 'Группа' });
eq('trailing dash means no artist', parseTitleLine('Раз, два —'), { title: 'Раз, два', artist: '' });
eq('title only', parseTitleLine('Песня'), { title: 'Песня', artist: '' });
for (const [t, a] of [['Песня', 'Группа'], ['Раз, два', ''], ['Раз, два', 'Группа'], ['А — Б', ''], ['Песня', '']])
  eq(`format/parse round trip: ${t} | ${a}`, parseTitleLine(formatTitleLine(t, a)), { title: t, artist: a });

// --- splitting a songbook by its title lines --------------------------------------
const BOOK = [
  'Песенник',
  '',
  'Первая песня, Группа Один',
  'Бой 2',
  'Am        C',
  'строка номер один',
  'Dm        E',
  'строка номер два',
  '',
  'Припев:',
  'F     G',
  'строка припева',
  '',
  'Это строка, просто текст.',          // a comma line inside a song, not a title
  '',
  'Две строки, да и только',            // lowercase "artist": not a title
  'Am',
  'строка после',
  '',
  'Вторая песня, Группа Два (10)',
  'Бой 1',
  'Нет аккордов в этой строке',         // no chords straight after the title:
  'Еще одна строка без аккордов',       // only the strum note marks the song
  'Em        H7',
  'строка с аккордами',
  '',
  'Песня без исполнителя',
  'Бой 2',
  'С         Еm',             // Cyrillic С and Е
  'строка с кириллическими аккордами',
  '',
  'Запятая, в названии, Группа Три',
  'Бой 2 / Вступление: Am G C E',
  'Am    G',
  'последняя строка',
  '',
].join('\n');

const book = splitSongbook(BOOK, { filename: 'Песенник.txt' });
eq('collection name', book.collection, 'Песенник');
eq('mode', book.mode, 'titles');
eq('song titles', book.songs.map((s) => [s.title, s.artist]), [
  ['Первая песня', 'Группа Один'],
  ['Вторая песня', 'Группа Два'],
  ['Песня без исполнителя', ''],
  ['Запятая, в названии', 'Группа Три'],
]);
eq('body starts with the strum note', book.songs.map((s) => s.body.split('\n')[0]),
  ['Бой 2', 'Бой 1', 'Бой 2', 'Бой 2 / Вступление: Am G C E']);
eq('false titles stayed inside the first song', book.songs[0].body.includes('Две строки, да и только'), true);
eq('no line lost or duplicated',
  book.songs.reduce((n, s) => n + 1 + s.body.split('\n').filter((l) => l.trim()).length, 1),
  BOOK.split('\n').filter((l) => l.trim()).length);

// --- writing and reading back ---------------------------------------------------------
const written = formatSongbook(book.songs, { name: book.collection, asWritten: true });
const back = splitSongbook(written);
eq('divider mode on re-import', back.mode, 'dividers');
eq('round trip: collection', back.collection, book.collection);
eq('round trip: songs identical', back.songs, book.songs);
eq('round trip without a collection name',
  splitSongbook(formatSongbook(book.songs, { asWritten: true })).songs, book.songs);

// --- single-song files -------------------------------------------------------------------
eq('title line then a blank line',
  splitSongbook('Моя песня, Автор\n\nAm   C\nслова').songs,
  [{ title: 'Моя песня', artist: 'Автор', body: 'Am   C\nслова' }]);
eq('no title: falls back to the file name',
  splitSongbook('Am   C\nслова\n', { filename: 'Моя песня - Автор.txt' }).songs,
  [{ title: 'Моя песня', artist: 'Автор', body: 'Am   C\nслова' }]);
eq('ChordPro directives win',
  splitSongbook('{title: Song}\n{artist: Band}\n[Am]words', { filename: 'x.txt' }).songs[0].title, 'Song');
eq('leading spaces of the first chord row survive',
  splitSongbook('\n\n     Am\nслова', { filename: 'x.txt' }).songs[0].body, '     Am\nслова');

// --- exporting a song as it is played ------------------------------------------------------
const song = { title: 'Песня', artist: 'Группа', body: 'Am        C\nслова тут', settings: { transpose: 0, capo: 2, accidentals: 'auto' } };
// Am with capo 2 is played as G minor shapes; Gm is a flat key, so C → Bb.
eq('capo: shapes plus a Capo line', formatSong(song), 'Песня — Группа\nCapo 2\n\nGm        Bb\nслова тут\n');
eq('as written ignores capo', formatSong(song, { asWritten: true }), 'Песня — Группа\n\nAm        C\nслова тут\n');
const flat = { ...song, settings: { transpose: 0, capo: 0, accidentals: 'auto' } };
eq('no shift: body verbatim', formatSong(flat), 'Песня — Группа\n\nAm        C\nслова тут\n');
eq('shared song imports back with its capo note',
  splitSongbook(formatSong(song), { filename: 'Песня - Группа.txt' }).songs[0].body.split('\n')[0], 'Capo 2');

// --- has a re-downloaded song changed? ---------------------------------------------------------
eq('CRLF and trailing spaces are not changes', sameSongText('Am  C\r\nслова  \r\n', 'Am  C\nслова'), true);
eq('blank lines at the ends are not changes', sameSongText('\n\nAm\nслова\n\n', 'Am\nслова'), true);
eq('a corrected chord is a change', sameSongText('Am  C\nслова', 'Am  G\nслова'), false);
eq('leading spaces of a chord row matter', sameSongText('   Am\nслова', 'Am\nслова'), false);

// --- identity and file names ------------------------------------------------------------------
eq('duplicate key ignores case, ё and punctuation', songKey('Ёлка', 'Кино!'), songKey('елка', '  кино'));
eq('different artists differ', songKey('Песня', 'А') === songKey('Песня', 'Б'), false);
eq('safe file name', safeFilename('Песня: A/B? — «Группа»'), 'Песня A B — «Группа».txt');
eq('empty file name', safeFilename('  '), 'song.txt');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
