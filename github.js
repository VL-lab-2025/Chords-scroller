// github.js — download .txt songbooks from a GitHub repository.
//
// The phone talks to the GitHub REST API directly; there is no server of ours
// in between. A private repository needs a fine-grained token with read-only
// Contents access. The token goes only to api.github.com, and only in the
// Authorization header — never in a URL, where it could end up in logs.

const API = 'https://api.github.com';
const JSON_TYPE = 'application/vnd.github+json';
const RAW_TYPE = 'application/vnd.github.raw+json';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/**
 * "owner/repo", or any github.com URL pointing into the repository, becomes
 * { owner, repo }. Returns null when it cannot be a repository.
 */
export function parseRepo(input) {
  const parts = String(input || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?github\.com\//i, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  return { owner, repo };
}

function explain(status, headers, cfg) {
  const name = `${cfg.owner}/${cfg.repo}`;
  if (status === 401) {
    return 'GitHub rejected the access token — it may have expired. Create a new one and paste it in Settings.';
  }
  if (status === 403 || status === 429) {
    if (headers && headers.get('x-ratelimit-remaining') === '0') {
      return 'GitHub’s download limit was reached. Try again in a little while.';
    }
    return `The access token can’t read ${name}. Give it read-only Contents access to that repository.`;
  }
  if (status === 404) {
    return cfg.token
      ? `${name} wasn’t found. Check the name, and that the token was given access to it.`
      : `${name} wasn’t found. If it’s private, add an access token in Settings.`;
  }
  if (status === 409) return `${name} is empty. Add a .txt songbook to it first.`;
  return `GitHub answered with an error (${status}). Try again later.`;
}

async function request(cfg, path, accept, fetchImpl) {
  const headers = { Accept: accept };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  let res;
  try {
    // no-store: always fetch the current songbook, and never keep a
    // token-authenticated response in any cache.
    res = await fetchImpl(API + path, { headers, cache: 'no-store' });
  } catch {
    throw new GitHubError('Can’t reach GitHub. Check your connection.', 0);
  }
  if (!res.ok) throw new GitHubError(explain(res.status, res.headers, cfg), res.status);
  return res;
}

const defaultFetch = () => globalThis.fetch.bind(globalThis);

/**
 * Every .txt file in the repository, at any depth, sorted by path:
 * [{ path, name, size }]. Two requests: the repository (for its default
 * branch), then that branch's whole file tree.
 */
export async function listSongbooks(cfg, fetchImpl = defaultFetch()) {
  const base = `/repos/${cfg.owner}/${cfg.repo}`;
  const info = await (await request(cfg, base, JSON_TYPE, fetchImpl)).json();
  const branch = encodeURIComponent(info.default_branch || 'main');
  const tree = await (await request(cfg, `${base}/git/trees/${branch}?recursive=1`, JSON_TYPE, fetchImpl)).json();
  return (tree.tree || [])
    .filter((e) => e.type === 'blob' && /\.txt$/i.test(e.path))
    .map((e) => ({ path: e.path, name: e.path.split('/').pop(), size: e.size || 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The raw bytes of one file, ready for decodeBytes. */
export async function downloadFile(cfg, path, fetchImpl = defaultFetch()) {
  const encoded = String(path).split('/').map(encodeURIComponent).join('/');
  const res = await request(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${encoded}`, RAW_TYPE, fetchImpl);
  return new Uint8Array(await res.arrayBuffer());
}
