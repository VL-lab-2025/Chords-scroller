// Local preview server:  node dev-server.mjs
//
// Serves the app from a subdirectory on purpose. GitHub Pages hosts projects at
// /<repo>/, so testing at a subpath catches absolute-path mistakes that would
// only show up after deploying.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Matches the GitHub Pages path (/<repo>/) so local runs hit the same subpath.
const MOUNT = '/Chords-scroller';
const PORT = Number(process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  if (path === MOUNT) {
    res.writeHead(302, { Location: MOUNT + '/' });
    res.end();
    return;
  }
  if (!path.startsWith(MOUNT + '/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`nothing here — open http://localhost:${PORT}${MOUNT}/`);
    return;
  }

  let rel = path.slice(MOUNT.length);
  if (rel.endsWith('/')) rel += 'index.html';

  const file = join(ROOT, normalize(rel).replace(/^([\\/]|\.\.)+/, ''));
  if (!file.startsWith(ROOT + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => console.log(`open http://localhost:${PORT}${MOUNT}/`));
