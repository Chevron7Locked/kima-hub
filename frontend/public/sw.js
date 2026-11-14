// Kima Service Worker
const CACHE_NAME = 'kima-v2';
const IMAGE_CACHE_NAME = 'kima-images-v3';
const MAX_IMAGE_CACHE_ENTRIES = 2000;
const MAX_CONCURRENT_IMAGE_REQUESTS = 8;
const REQUEST_DELAY_MS = 10;

// Assets to cache on install (app shell)
const PRECACHE_ASSETS = [
  '/manifest.webmanifest',
  '/assets/images/kima.webp',
  '/offline.html',
];

// Image route patterns to cache
const IMAGE_PATTERNS = [
  /^\/api\/library\/cover-art/,
  /^\/api\/audiobooks\/.*\/cover/,
  /^\/api\/podcasts\/.*\/cover/,
];

// Request queue for throttling concurrent image fetches
let activeImageRequests = 0;
const imageRequestQueue = [];

/**
 * Check if a URL should use image caching
 */
function isImageRoute(pathname) {
  return IMAGE_PATTERNS.some(pattern => pattern.test(pathname));
}

/**
 * Create a cache key URL by stripping auth token from query params.
 * Image identity is determined by path + url + size params only.
 */
function createImageCacheKey(requestUrl) {
  try {
    const url = new URL(requestUrl);
    url.searchParams.delete('token');
    return new Request(url.toString());
  } catch {
    return new Request(requestUrl);
  }
}

/**
 * Trim cache to max entries (LRU eviction by oldest)
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();

  if (keys.length > maxEntries) {
    // Delete oldest entries (first in = oldest)
    const deleteCount = keys.length - maxEntries;
    for (let i = 0; i < deleteCount; i++) {
      await cache.delete(keys[i]);
    }
  }
}

/**
 * A cover stored on the server (its address names a stored file, `native:...`) can change under the same address, so it
 * is shown from the cache at once and checked with the server meanwhile. A cover from another site's address never
 * changes under its address and stays cache-first.
 */
function isStoredCover(url) {
  return /^\/api\/library\/cover-art/.test(url.pathname) && (url.searchParams.get('url') || '').startsWith('native:');
}

/**
 * Process the image request queue
 */
function processImageQueue() {
  while (activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS && imageRequestQueue.length > 0) {
    const { request, cacheKey, revalidate, resolve, reject } = imageRequestQueue.shift();
    activeImageRequests++;

    (revalidate ? revalidateImage(request, cacheKey) : fetchAndCacheImage(request, cacheKey))
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeImageRequests--;
        setTimeout(processImageQueue, REQUEST_DELAY_MS);
      });
  }
}

/**
 * Fetch image from network and cache it
 */
async function fetchAndCacheImage(request, cacheKey) {
  const cache = await caches.open(IMAGE_CACHE_NAME);

  try {
    // Fetch with original request (includes auth token)
    const networkResponse = await fetch(request);

    if (networkResponse.status === 200) {
      // Cache with normalized key (no token)
      cache.put(cacheKey, networkResponse.clone());
      trimCache(IMAGE_CACHE_NAME, MAX_IMAGE_CACHE_ENTRIES);
    }

    return networkResponse;
  } catch {
    return new Response('Image unavailable', { status: 503 });
  }
}

/**
 * Ask the server whether a cached cover changed, and keep the new one when it did. The browser's own HTTP cache is not
 * trusted here (`no-cache` makes it check with the server, and covers saved before the server asked for that check may
 * sit in it as "never changes"). A failed check or a non-200 answer leaves the cached cover as it is.
 */
async function revalidateImage(request, cacheKey) {
  try {
    const cache = await caches.open(IMAGE_CACHE_NAME);
    const networkResponse = await fetch(request, { cache: 'no-cache' });
    if (networkResponse.status !== 200) return;

    const cached = await cache.match(cacheKey);
    const etag = networkResponse.headers.get('etag');
    if (cached && etag && cached.headers.get('etag') === etag) return;
    await cache.put(cacheKey, networkResponse);
  } catch {
    // Offline: the cached cover stands.
  }
}

/**
 * Queue an image request with throttling
 */
function queueImageRequest(request, cacheKey, revalidate = false) {
  return new Promise((resolve, reject) => {
    imageRequestQueue.push({ request, cacheKey, revalidate, resolve, reject });
    processImageQueue();
  });
}

// Install event - cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
  // The worker serves no app code, so a new one can take over at once.
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== IMAGE_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Take control of all clients immediately
  self.clients.claim();
});

// Fetch event - handle requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip non-http(s) URLs (chrome-extension://, etc.)
  if (!url.protocol.startsWith('http')) return;

  // Navigation requests: network-first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return cache.match('/offline.html') ?? new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // Skip streaming endpoints
  if (url.pathname.includes('/stream')) return;

  // Skip Next.js image optimization endpoint
  if (url.pathname.startsWith('/_next/image')) return;

  // Handle image routes with cache-first strategy + request throttling
  if (isImageRoute(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(IMAGE_CACHE_NAME);
        const cacheKey = createImageCacheKey(request.url);

        // Try cache first (token-independent key)
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          // A stored cover may have changed: show this one, check with the server meanwhile.
          if (isStoredCover(url)) event.waitUntil(queueImageRequest(request, cacheKey, true));
          return cachedResponse;
        }

        // Not in cache, queue the request with throttling
        // Pass both original request (for auth) and cache key (for storage)
        return queueImageRequest(request, cacheKey);
      })()
    );
    return;
  }

  // Skip other API requests - always go to network
  if (url.pathname.startsWith('/api/')) return;

  // Let Next.js handle its own static assets and navigation - don't cache them.
  // Next.js already uses immutable cache headers on /_next/static/ and manages
  // HTML responses with proper cache-control. Caching these in the SW causes
  // stale CSS/JS after rebuilds (old HTML references old chunk hashes).
  return;
});
