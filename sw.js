// sw.js — offline cache.
//
// Bump CACHE whenever you change any file below, otherwise phones that already
// installed the app will keep serving the old copy from disk.
const CACHE = 'songs-scroll-v3';

// Relative paths only: the app must work from a GitHub Pages subdirectory.
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './model.js',
  './store.js',
  './player.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll fails the whole install if any single file 404s; tolerate gaps.
      // cache:'reload' bypasses the HTTP cache so an update really is fresh.
      .then(cache => Promise.allSettled(
        ASSETS.map(a => cache.add(new Request(a, { cache: 'reload' })))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network so updates land, fall back to the cached shell
  // when offline — which is the normal case for this app.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Everything else: cache first, refreshing in the background.
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
