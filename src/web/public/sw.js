/*
 * Service worker scris de mână (fără dependențe): ține aplicația în cache ca să pornească și fără internet.
 * Lista fișierelor și versiunea sunt completate la build (vezi vite.web.config.mts).
 * O versiune nouă se instalează în fundal și rămâne „în așteptare” până când utilizatorul apasă „Actualizează”.
 */
const VERSION = '__BUILD_ID__';
const CACHE = 'pb-' + VERSION;
const PRECACHE = __PRECACHE__;
const SCOPE = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((path) => new Request(SCOPE + path, { cache: 'reload' }))))
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pb-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Cererile către alte site-uri (prețuri, proxy) nu trec prin cache: datele de preț se țin în baza de date.
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(caches.match(SCOPE + 'index.html').then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
    )
  );
});
