# Chords

An offline autoscrolling chord-chart reader for guitar, built as a PWA so it runs
entirely on an iPhone — no server, no account, no PC left switched on.

Songs live in the phone's own storage. Once the app has been opened one time it
works in airplane mode forever.

## Deploy to GitHub Pages

Published from [VL-lab-2025/Chords-scroller](https://github.com/VL-lab-2025/Chords-scroller)
to **https://vl-lab-2025.github.io/Chords-scroller/**

Turning Pages on is a one-time step in the repo's own settings:

1. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`,
   folder `/ (root)` → **Save**.
2. Wait ~1 minute for the first build, then open the URL above.

The repo must stay **public** for Pages to be free. That is fine here: it holds
only app code. Songs are stored on the phone and are never committed, so
nothing personal is published.

### Put it on the iPhone

Open that URL in **Safari** (not Chrome — only Safari can install web apps on
iOS) → Share → **Add to Home Screen**.

Launch it from the home-screen icon. It runs full screen with no browser bars,
and works with no signal.

## Using it

**Adding a song** — tap ＋, paste a chart, Save. Both formats work and the
format is detected for you:

```
Am        F
Some lyric line here
```

```
[Am]Some [F]lyric line here
```

Anything copied from a tab site generally pastes in as-is. `[Verse]`,
`[Chorus]`, `Припев:`, `Куплет 2` and similar are recognised as section
headings, not chords. Russian conventions work too: `H7` means B7, chords typed
with Cyrillic look-alike letters (`С`, `Е`) are understood, and strumming notes
such as `Бой 2` are shown as notes. Repeat marks, bar lines and strum arrows in
a chord row (`(2)`, `x2`, `|`, `↓`) stay where they were written.

**Importing .txt files** — ＋ → *Import .txt files*, then pick files from Files,
iCloud Drive or a Telegram download. A file can hold one song or a whole
songbook. Songbooks are split at each song's title line — `Title, Artist`,
ideally with a strumming or capo note right under it — or at divider lines
(`=====`). You see every song found before anything is saved; songs already in
your library are left unticked, and a songbook can become a setlist in its
original order. If a file splits wrongly, import it as a single song instead.
UTF-8, UTF-16 and old Windows-1251 files all read correctly.

**Sending songs** — on a song, *Share as .txt* opens the share sheet (Telegram,
AirDrop, Files…) and *Copy text* puts it on the clipboard. What you send is what
you see: with a capo or transpose set, the recipient gets the same chord shapes
plus a `Capo N` line. A setlist shares as one file, in order. Everything the app
exports imports back song for song.

**Capo and transpose.** The chords on screen are always **the shapes you
finger**, never the concert pitch:

| Written | Setting | Shown | Header says |
|---|---|---|---|
| `Bbm` | capo 1 | `Am` | Play Am shapes · capo 1 · sounds in Bbm |
| `G` | capo 3 | `E` | Play E shapes · capo 3 · sounds in G |
| `Am` | transpose +1 | `Bbm` | Play Bbm shapes · sounds in Bbm |

Sharps versus flats are chosen from the resulting key, so you get `Bbm` rather
than `A#m`. Override per song with the ♭/♯ buttons.

**Playing.** Each song remembers its own speed, font size, spacing, transpose,
capo and lead-in. Tap **Start scrolling**; the screen stays awake and the
controls fade out. Tap anywhere to pause or resume, drag to find your place,
and use −/＋ to adjust speed mid-song.

**Setlists.** Group songs into an ordered set and play straight through; the
player shows what's coming next.

## Back up your songs

Settings → **Export library** writes a JSON file (via the iOS share sheet, so
you can drop it in Files or iCloud Drive). **Import backup** restores it,
including each song's speed, font size and capo. **Export all songs as .txt**
writes the songs alone as one readable songbook.

Do this occasionally. iOS can evict web-app storage, and the export is the only
copy that exists off the device.

## Changing the app later

You can edit files straight from github.com in mobile Safari — commit, and the
app updates itself.

**One rule:** whenever you change any file, bump the version in `sw.js`:

```js
const CACHE = 'songs-scroll-v4';   // -> v5, v6, ...
```

That string is what tells installed phones their cached copy is stale. Without
bumping it they keep serving the old files from disk. On the next launch the app
notices the new version, refreshes itself and reloads once.

**Renaming the app** means changing the display strings only: `<title>` and
`apple-mobile-web-app-title` in `index.html`, and `name` / `short_name` in
`manifest.json`. Leave `DB_NAME` in `store.js` and the `app:` tag in the backup
format alone — they read like the app's name but are storage and file-format
identifiers. Renaming `DB_NAME` opens a different, empty database and hides
every song already on the phone. The iOS home-screen label is also captured at
install time, so an already-installed icon keeps its old name until you delete
and re-add it.

## Development

```bash
node dev-server.mjs
```

Then open `http://localhost:5173/Chords-scroller/`. It deliberately serves from
the same subdirectory GitHub Pages uses, so path mistakes surface locally
instead of after deploying.

```bash
npm test
```

Covers the areas with real logic: chord parsing and transposition
(`test-model.mjs`), reading and writing .txt songbooks (`test-songbook.mjs`) and
the scroll engine's timing (`test-player.mjs`).

**Keep songbooks out of the repo.** The repo is public, and song lyrics are
usually copyrighted. Put personal files in `data/`, which is gitignored, and
never commit them — test fixtures here use invented text only.

## Files

| File | Purpose |
|---|---|
| `model.js` | chord grammar, both input formats, transposition, render model |
| `songbook.js` | reading and writing .txt files: encodings, splitting, formatting |
| `store.js` | IndexedDB persistence, export/import |
| `player.js` | scroll engine, wake lock |
| `app.js` | views and wiring |
| `sw.js` | offline cache |

No build step and no dependencies — the files you edit are the files that run.

## iOS notes

- **Screen wake** needs iOS 16.4+. On older versions set Settings → Display &
  Brightness → Auto-Lock → Never before playing.
- **Orientation** can't be locked by a web app; the layout works either way.
- **Low Power Mode** may refuse the wake lock. The app still scrolls.
