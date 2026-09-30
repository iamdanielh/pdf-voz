// VozPDF service worker — app shell offline. Los documentos viven en IndexedDB.
const CACHE = "vozpdf-v5";
const ASSETS = [
  "./",
  "index.html",
  "css/style.css?v=4",
  "js/app.js?v=10",
  "js/importers.js",
  "js/karaoke.js",
  "js/reader-text.js",
  "js/vendor/pdf.min.mjs",
  "js/vendor/pdf.worker.min.mjs",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-512.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copy = resp.clone();
        if (resp.ok) caches.open(CACHE).then((c) => c.put(event.request, copy));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
