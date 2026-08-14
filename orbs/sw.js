/*
 * Orbs — service worker (CLASSIC script, no modules, no imports).
 *
 * CACHING STRATEGY
 *   install   : precache the app shell, one URL at a time. Each cache.add() is wrapped
 *               in its own .catch() so a single missing asset (e.g. an icon that has not
 *               been generated yet) can never abort the whole install. cache.addAll() is
 *               deliberately NOT used because it is all-or-nothing.
 *   activate   : drop every cache that is not the current CACHE_NAME, then claim clients
 *               so the very first load is controlled without a second refresh.
 *   navigations: network-first, falling back to the cached './index.html' (then './').
 *               This is what makes an offline reload of the installed PWA work.
 *   other GETs : cache-first with background revalidation (stale-while-revalidate). A hit
 *               is returned immediately and a fresh copy is fetched into the cache for
 *               next time; a miss goes to the network and is cached when the response is
 *               ok and of type 'basic'. Opaque / status-0 responses are never stored.
 *               If both cache and network fail we synthesize a 504 instead of rejecting,
 *               so a fetch failure inside the worker can never take down the page.
 *   cross-origin and non-GET requests are passed straight through, untouched.
 *
 * DEPLOY RULE
 *   BUMP CACHE_VERSION ON EVERY DEPLOY. The browser detects a service worker update by
 *   byte-diffing this file, so changing the literal below is both the update trigger and
 *   the cache invalidation. It must stay a literal in this file — never imported.
 */

// BUMP THIS ON EVERY DEPLOY — the browser byte-diffs this file to detect updates.
const CACHE_VERSION = 'orbs-v1';

// CacheStorage is scoped to the ORIGIN, not to this worker's scope. On GitHub Pages every
// repo shares one origin, so activate() must only ever delete caches carrying this prefix —
// otherwise installing Orbs wipes the offline data of every neighbouring project.
const CACHE_PREFIX = 'orbs-cache-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const PRECACHE = [
  './',
  './index.html',
  './main.js',
  './sim.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

const OFFLINE_RESPONSE = function () {
  return new Response('', { status: 504, statusText: 'offline' });
};

/* ------------------------------------------------------------------ install */

self.addEventListener('install', function (event) {
  event.waitUntil(
    (async function precache() {
      try {
        const cache = await caches.open(CACHE_NAME);
        // Individually, so one 404 cannot fail the install.
        await Promise.all(
          PRECACHE.map(function (url) {
            return cache.add(url).catch(function () {});
          })
        );
      } catch (err) {
        // Storage unavailable / quota — install anyway, the app still runs online.
      }
      try {
        await self.skipWaiting();
      } catch (err) {}
    })()
  );
});

/* ----------------------------------------------------------------- activate */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function cleanup() {
      try {
        const names = await caches.keys();
        await Promise.all(
          names.map(function (name) {
            if (name === CACHE_NAME || name.indexOf(CACHE_PREFIX) !== 0) return Promise.resolve(false);
            return caches.delete(name).catch(function () {});
          })
        );
      } catch (err) {}
      try {
        await self.clients.claim();
      } catch (err) {}
    })()
  );
});

/* -------------------------------------------------------------- fetch logic */

function isCacheable(response) {
  return !!response && response.status !== 0 && response.ok && response.type === 'basic';
}

async function putInCache(request, response) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch (err) {}
}

function revalidate(request) {
  // Refresh in the background. The promise is RETURNED so the caller can hand it to
  // event.waitUntil — a worker may be killed the moment respondWith settles, which would
  // otherwise tear this fetch down mid-flight and quietly disable revalidation entirely.
  return fetch(request)
    .then(function (response) {
      if (isCacheable(response)) {
        return putInCache(request, response.clone());
      }
    })
    .catch(function () {});
}

async function handleNavigate(request, event) {
  try {
    const fresh = await fetch(request);
    if (isCacheable(fresh) && event) {
      event.waitUntil(putInCache(request, fresh.clone()));
    }
    return fresh;
  } catch (err) {
    // Offline (or the network hiccuped) — serve the cached shell.
  }
  try {
    const shell = await caches.match('./index.html');
    if (shell) return shell;
    const root = await caches.match('./');
    if (root) return root;
  } catch (err) {}
  return OFFLINE_RESPONSE();
}

async function handleAsset(request, event) {
  let cached = null;
  try {
    cached = await caches.match(request);
  } catch (err) {}

  if (cached) {
    if (event) event.waitUntil(revalidate(request));
    return cached;
  }

  try {
    const response = await fetch(request);
    if (isCacheable(response) && event) {
      event.waitUntil(putInCache(request, response.clone()));
    }
    return response;
  } catch (err) {}

  return OFFLINE_RESPONSE();
}

self.addEventListener('fetch', function (event) {
  const request = event.request;

  // Non-GET: let the network handle it.
  if (!request || request.method !== 'GET') return;

  // Cross-origin: pass through untouched.
  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      handleNavigate(request, event).catch(function () {
        return OFFLINE_RESPONSE();
      })
    );
    return;
  }

  event.respondWith(
    handleAsset(request, event).catch(function () {
      return OFFLINE_RESPONSE();
    })
  );
});

/* ------------------------------------------------------------------ message */

self.addEventListener('message', function (event) {
  try {
    if (event && event.data === 'SKIP_WAITING') {
      // skipWaiting() returns a promise; an unhandled rejection here would be a real one.
      Promise.resolve(self.skipWaiting()).catch(function () {});
    }
  } catch (err) {}
});
