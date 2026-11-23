'use strict';

const CACHE_NAME = 'evrakplus-dd-pwa-v1.0.3';
const STATIC_ASSETS = [
  './index.html',
  './app.js',
  './editor_logic.js',
  './export_engine.js',
  './duty_module.js',
  './evrakplus_ui.js',
  './system_ui.js',
  './manifest.webmanifest',
  './assets/styles.css',
  './assets/lucide.min.js',
  './assets/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API isteklerini asla önbelleğe alma
  if (url.pathname.includes('/wp-json/')) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return resp;
      });
    })
  );
});
