/* =====================================================================
   MSA Billing — service worker
   App-shell cache for an installable, fast-loading PWA.

   Strategy
     • App CODE (HTML navigations, index.html, support.js, firebase-db.js,
       app-config.js, settings.json)          → NETWORK-FIRST (cache fallback
       when offline). Guarantees users always run the LATEST deployed code —
       stale-while-revalidate here meant every deploy showed up one full
       reload late (users kept seeing the old app on first load).
     • Other same-origin assets (logos, etc.) → stale-while-revalidate
       (instant load from cache, refresh in background)
     • Google Fonts                           → cache-first
     • Firebase SDK / Firestore / Auth / APIs → NEVER cached here
       (Firestore has its own robust offline persistence; caching its
        requests would corrupt sync). We simply pass them through.

   Bump CACHE_VERSION whenever you ship new app code so clients update.
   ===================================================================== */

const CACHE_VERSION = "msa-v2";
const SHELL_CACHE = CACHE_VERSION + "-shell";
const FONT_CACHE = CACHE_VERSION + "-fonts";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./support.js",
  "./firebase-db.js",
  "./manifest.webmanifest",
  "./assets/logo-256.png",
  "./assets/logo-1000.png",
  "./assets/logo-favicon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // best-effort: don't fail install if one asset 404s
      Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isFirebase(url) {
  return /firebaseio|firestore\.googleapis|identitytoolkit|googleapis\.com\/.*(firestore|securetoken)|cloudfunctions\.net|firebaseapp\.com|firebase-settings|google-analytics|gstatic\.com\/firebasejs/.test(url);
}
function isFont(url) {
  return /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url);
}
// App code: must always be fresh when online (network-first)
function isAppCode(req, url) {
  if (req.mode === "navigate") return true;
  const p = new URL(url).pathname;
  return /\.html$|\/support\.js$|\/firebase-db\.js$|\/app-config\.js$|\/sw-register\.js$|\/settings\.json$|\/$/.test(p);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = req.url;

  // 1) Firebase & analytics — always go to network (their SDK handles offline)
  if (isFirebase(url)) return;

  // 2) Google Fonts — cache-first
  if (isFont(url)) {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try { const res = await fetch(req); if (res && res.status === 200) cache.put(req, res.clone()); return res; }
        catch (e) { return hit || Response.error(); }
      })
    );
    return;
  }

  // 3) Same-origin — app CODE is network-first (always latest when online,
  //    cache fallback offline); other assets stale-while-revalidate.
  if (new URL(url).origin === self.location.origin) {
    if (isAppCode(req, url)) {
      event.respondWith(
        caches.open(SHELL_CACHE).then(async (cache) => {
          try {
            const res = await fetch(req);
            if (res && res.status === 200 && res.type === "basic") cache.put(req, res.clone());
            return res;
          } catch (e) {
            const hit = await cache.match(req, { ignoreSearch: true });
            return hit || Response.error();
          }
        })
      );
      return;
    }
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: false });
        const network = fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === "basic") cache.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || network;
      })
    );
  }
});

// allow the page to trigger an immediate update
self.addEventListener("message", (e) => { if (e.data === "skipWaiting") self.skipWaiting(); });
