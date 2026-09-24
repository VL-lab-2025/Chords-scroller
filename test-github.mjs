// Tests for the GitHub download client, against a fake fetch that records
// every request.  Run: node test-github.mjs
import { parseRepo, listSongbooks, downloadFile, GitHubError } from './github.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got  ${a}\n  want ${b}`); }
};
const ok = (label, cond) => eq(label, !!cond, true);

/** A fake fetch: `routes` maps URL substrings to [status, body, headers]. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: { ...(init && init.headers) } });
    for (const [part, [status, body, headers]] of Object.entries(routes)) {
      if (url.includes(part)) {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return new Response(text, { status, headers: headers || {} });
      }
    }
    return new Response('{}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// --- repository names ---------------------------------------------------------------------
eq('owner/repo', parseRepo('VL-lab-2025/chords-songbooks'), { owner: 'VL-lab-2025', repo: 'chords-songbooks' });
eq('https URL', parseRepo('https://github.com/VL-lab-2025/chords-songbooks'), { owner: 'VL-lab-2025', repo: 'chords-songbooks' });
eq('URL deep inside the repo', parseRepo('https://github.com/a/b/tree/main/folder'), { owner: 'a', repo: 'b' });
eq('.git suffix and spaces', parseRepo('  github.com/a/b.git '), { owner: 'a', repo: 'b' });
eq('no repo part', parseRepo('just-a-name'), null);
eq('empty', parseRepo(''), null);
eq('illegal owner', parseRepo('bad owner/repo'), null);

// --- listing songbooks ----------------------------------------------------------------------
const cfg = { owner: 'me', repo: 'songs', token: 'github_pat_SECRET123' };
const tree = {
  tree: [
    { path: 'Guitar.txt', type: 'blob', size: 99519 },
    { path: 'README.md', type: 'blob', size: 10 },
    { path: 'folder', type: 'tree' },
    { path: 'folder/Песни.txt', type: 'blob', size: 2048 },
    { path: 'notes.TXT', type: 'blob', size: 5 },
  ],
};
const f1 = fakeFetch({ '/git/trees/': [200, tree], '/repos/me/songs': [200, { default_branch: 'trunk' }] });
const listed = await listSongbooks(cfg, f1);
eq('only .txt files, any depth, sorted', listed.map((f) => f.path), ['folder/Песни.txt', 'Guitar.txt', 'notes.TXT']);
eq('file name and size', listed[1], { path: 'Guitar.txt', name: 'Guitar.txt', size: 99519 });
ok('uses the default branch', f1.calls[1].url.endsWith('/repos/me/songs/git/trees/trunk?recursive=1'));
ok('token sent as a Bearer header', f1.calls.every((c) => c.headers.Authorization === 'Bearer github_pat_SECRET123'));
ok('token never in a URL', f1.calls.every((c) => !c.url.includes('SECRET')));
ok('only api.github.com is contacted', f1.calls.every((c) => c.url.startsWith('https://api.github.com/')));

const f2 = fakeFetch({ '/git/trees/': [200, { tree: [] }], '/repos/me/songs': [200, { default_branch: 'main' }] });
await listSongbooks({ owner: 'me', repo: 'songs', token: '' }, f2);
ok('no token: no Authorization header at all', f2.calls.every((c) => !('Authorization' in c.headers)));

// --- downloading --------------------------------------------------------------------------------
const f3 = fakeFetch({ '/contents/': [200, 'Am  C\nwords'] });
const bytes = await downloadFile(cfg, 'Мои песни/Гитара 2.txt', f3);
eq('raw bytes returned', new TextDecoder().decode(bytes), 'Am  C\nwords');
ok('Cyrillic path encoded, folder slash kept',
  f3.calls[0].url.endsWith('/contents/' + encodeURIComponent('Мои песни') + '/' + encodeURIComponent('Гитара 2.txt')));
eq('asks for the raw file', f3.calls[0].headers.Accept, 'application/vnd.github.raw+json');

// --- errors a user can act on ---------------------------------------------------------------------
async function errorFor(status, headers, config = cfg) {
  try {
    await listSongbooks(config, fakeFetch({ '/repos/': [status, { message: 'x' }, headers] }));
    return null;
  } catch (e) {
    return e;
  }
}
const e401 = await errorFor(401);
ok('401 is a GitHubError', e401 instanceof GitHubError && e401.status === 401);
ok('401 says the token may have expired', /expired/.test(e401.message));
ok('403 at the rate limit says so', /limit/.test((await errorFor(403, { 'x-ratelimit-remaining': '0' })).message));
ok('403 otherwise is about permissions', /Contents access/.test((await errorFor(403)).message));
ok('404 with a token: check name and access', /token was given access/.test((await errorFor(404)).message));
ok('404 without a token: suggest adding one', /add an access token/.test((await errorFor(404, {}, { ...cfg, token: '' })).message));
ok('409: empty repository', /empty/.test((await errorFor(409)).message));
ok('no error message ever contains the token',
  [e401, await errorFor(403), await errorFor(404), await errorFor(500)].every((e) => !e.message.includes('SECRET')));

let offline = null;
try { await listSongbooks(cfg, async () => { throw new TypeError('Failed to fetch'); }); }
catch (e) { offline = e; }
ok('offline: a plain explanation', offline && offline.status === 0 && /connection/.test(offline.message));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
