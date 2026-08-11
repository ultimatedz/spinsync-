const CACHE_NAME = 'spinsync-v4';

// Everything needed to run a workout with no network at all. The old service worker
// was network-first with no precache, so the first offline launch had nothing to serve
// and a captive-portal wifi would hang on fetch before falling back.
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/ble-manager.js',
  './js/hr-parser.js',
  './js/cadence-parser.js',
  './js/zone-calculator.js',
  './js/calorie-calculator.js',
  './js/workout-recorder.js',
  './js/charts.js',
  './js/training-plans.js',
  './js/analytics.js',
  './js/storage.js',
  './js/health-sync.js',
  './js/progression.js',
  './js/haptics.js',
  './js/vendor/capacitor-core.js',
  './js/vendor/capacitor-app.js',
  './js/vendor/bluetooth-le.js',
  './js/vendor/capacitor-health.js',
  './js/vendor/capacitor-synapse.js',
  './js/vendor/capacitor-filesystem.js',
  './js/tcx-export.js',
  './js/auto-backup.js',
  './js/physiology.js',
  './js/vendor/chart.umd.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // addAll is all-or-nothing; cache entries individually so one bad URL cannot
      // leave the whole app uncached.
      .then(cache => Promise.all(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] precache failed:', url, err))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  // Stale-while-revalidate: serve instantly from cache (so a dead gym wifi never
  // delays startup) and refresh in the background for the next launch.
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
