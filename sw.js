/* ═══════════════════════════════════════════════════════
   DocScan Pro — Service Worker
   Stratégie :
   • Shell (HTML, CSS, fonts) → Cache First
   • OpenCV.js (WASM, ~9 MB) → Cache First avec fallback réseau
   • Vidéo / caméra → jamais mis en cache (réseau direct)
═══════════════════════════════════════════════════════ */

const APP_VERSION   = 'v1.0.0';
const CACHE_SHELL   = `docscan-shell-${APP_VERSION}`;
const CACHE_OPENCV  = `docscan-opencv-${APP_VERSION}`;
const CACHE_FONTS   = `docscan-fonts-${APP_VERSION}`;

/* Assets à pré-cacher au premier install */
const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
  /* jsPDF depuis CDN — sera mis en cache au 1er chargement */
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

/* OpenCV.js — gros fichier WASM, cache séparé */
const OPENCV_URL = 'https://docs.opencv.org/4.8.0/opencv.js';

/* Fonts Google — cache long terme */
const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

/* ─────────────────────────────────────────────
   INSTALL — pré-cacher le shell
───────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(CACHE_SHELL);
      /* Cache sans throw si une ressource manque (offline install) */
      await Promise.allSettled(
        SHELL_ASSETS.map(url =>
          shellCache.add(url).catch(err =>
            console.warn('[SW] Pré-cache échoué:', url, err)
          )
        )
      );
      /* Active immédiatement sans attendre la fermeture des onglets */
      await self.skipWaiting();
    })()
  );
});

/* ─────────────────────────────────────────────
   ACTIVATE — purge les anciens caches
───────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const valid = new Set([CACHE_SHELL, CACHE_OPENCV, CACHE_FONTS]);
      await Promise.all(
        keys
          .filter(k => k.startsWith('docscan-') && !valid.has(k))
          .map(k => {
            console.log('[SW] Suppression ancien cache:', k);
            return caches.delete(k);
          })
      );
      await self.clients.claim();
    })()
  );
});

/* ─────────────────────────────────────────────
   FETCH — routage des requêtes
───────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Ignorer les requêtes non-GET et les requêtes chrome-extension */
  if (request.method !== 'GET') return;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  /* ── 1. OpenCV.js / WASM → Cache First + fallback réseau ── */
  if (url.href.includes('opencv.org') || url.href.includes('opencv.js')) {
    event.respondWith(cacheFirst(request, CACHE_OPENCV));
    return;
  }

  /* ── 2. Fonts Google → Cache First (longue durée) ── */
  if (FONT_ORIGINS.some(o => url.href.startsWith(o))) {
    event.respondWith(cacheFirst(request, CACHE_FONTS));
    return;
  }

  /* ── 3. Caméra / media streams → jamais mis en cache ── */
  if (url.href.includes('blob:') || request.destination === 'video') {
    return; /* laisser le navigateur gérer */
  }

  /* ── 4. Shell (HTML, JS CDN, manifest) → Cache First ── */
  if (
    url.origin === self.location.origin ||
    url.href.includes('cdnjs.cloudflare.com')
  ) {
    event.respondWith(cacheFirst(request, CACHE_SHELL));
    return;
  }

  /* ── 5. Tout le reste → Network First ── */
  event.respondWith(networkFirst(request, CACHE_SHELL));
});

/* ─────────────────────────────────────────────
   STRATÉGIES DE CACHE
───────────────────────────────────────────── */

/** Cache First : lit le cache, va sur le réseau si manquant, met en cache la réponse */
async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      /* Ne pas mettre en cache les grosses réponses en streaming */
      const clone = response.clone();
      cache.put(request, clone).catch(() => {});
    }
    return response;
  } catch (err) {
    /* Offline et non en cache : retourner une page de fallback si possible */
    const fallback = await cache.match('./index.html');
    if (fallback) return fallback;
    return new Response('Hors ligne — ressource non disponible.', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/** Network First : va sur le réseau, met en cache, retombe sur le cache en cas d'erreur */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('Hors ligne.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/* ─────────────────────────────────────────────
   MESSAGE — communication avec la page
───────────────────────────────────────────── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
  }
});
