// Offline support: network first (so updates arrive), cache as fallback.
// Bump VERSION when deploying to clear old caches.
const VERSION = 'bl-v5';
const ASSETS = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './img/logo.png', './img/icon-192.png', './img/icon-512.png',
  './js/app.js', './js/db.js', './js/defaults.js', './js/rules.js', './js/match.js',
  './js/ics.js', './js/google.js', './js/contact.js', './js/contacts.js', './js/finance.js', './js/ghstore.js', './js/views-github.js', './js/sync.js', './js/views.js', './js/util.js', './js/config.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
  );
});
