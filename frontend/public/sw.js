// Lidify Service Worker
const CACHE_NAME = 'lidify-v1';
const IMAGE_CACHE_NAME = 'lidify-images-v3';
const MAX_IMAGE_CACHE_ENTRIES = 2000;
const MAX_CONCURRENT_IMAGE_REQUESTS = 8;
const REQUEST_DELAY_MS = 10;

// Assets to cache on install (app shell)
const PRECACHE_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/assets/images/LIDIFY.webp',
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
 * Process the image request queue
 */
function processImageQueue() {
  while (activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS && imageRequestQueue.length > 0) {
    const { request, cacheKey, resolve, reject } = imageRequestQueue.shift();
    activeImageRequests++;

    fetchAndCacheImage(request, cacheKey)
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
 * Queue an image request with throttling
 */
function queueImageRequest(request, cacheKey) {
  return new Promise((resolve, reject) => {
    imageRequestQueue.push({ request, cacheKey, resolve, reject });
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
  // Take control immediately
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

  // For everything else, try network first, then cache
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Clone the response before caching
        const responseClone = response.clone();

        // Cache successful responses
        if (response.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }

        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }

          // Return a fallback for navigation requests
          if (request.mode === 'navigate') {
            return caches.match('/');
          }

          return new Response('Offline', { status: 503 });
        });
      })
  );
});
