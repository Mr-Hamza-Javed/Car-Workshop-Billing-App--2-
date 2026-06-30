/* MSA Billing — service worker registration (kept as an external file so the inline
   <helmet> script stays minimal; also lets the file update independently of the page). */
(function () {
  try {
    var h = (location.hostname || "").toLowerCase();
    var isDeployedHost = (h.indexOf(".github.io") !== -1) || (h.indexOf(".web.app") !== -1) || (h.indexOf(".firebaseapp.com") !== -1);
    if (!("serviceWorker" in navigator)) return;
    if (isDeployedHost && location.protocol.indexOf("http") === 0) {
      // real deployed site — register for offline app-shell caching
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("service-worker.js").catch(function (e) {
          console.warn("SW register failed", e && e.message);
        });
      });
    } else {
      // editor preview / localhost / any other host — never cache-lock active development;
      // proactively clear anything a previous deploy test may have left registered here.
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        for (var i = 0; i < regs.length; i++) regs[i].unregister();
      }).catch(function () {});
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) {
          for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf("msa-") === 0) caches.delete(keys[i]);
          }
        }).catch(function () {});
      }
    }
  } catch (e) {}
})();
