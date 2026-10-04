/* =====================================================================
   MSA Billing — deployment mode config
   ---------------------------------------------------------------------
   Controls whether the app talks to the REAL Firebase backend or runs
   fully offline against a local demo dataset. Edit MODE below and
   redeploy — nothing else in the app needs to change.

   MODE options:
     "production" — ALWAYS use the real backend (Firebase Auth for login
                    + the Node.js API server for all data). Use this once you've deployed to
                    your real domain (custom domain, GitHub Pages, or
                    Firebase Hosting) and want real users to sign in with
                    real accounts and real data.

     "demo"       — ALWAYS use the built-in offline demo data
                    (localStorage only, no Firebase calls at all, login
                    with admin@msa.com / 123456). Useful for showing the
                    app around without touching real business data.

     "auto"       — guess from the hostname: known Firebase hosts
                    (*.web.app, *.firebaseapp.com, *.github.io) get the
                    real backend, everything else (including a custom
                    domain!) falls back to demo. This is only a fallback
                    for when MODE hasn't been set explicitly — a custom
                    domain is NOT auto-detected, which is exactly why this
                    file exists. Prefer "production" or "demo" explicitly.

   API_URL — where the Node.js API server (server/) is running, e.g.
     "https://msa-billing-api.onrender.com". Leave it "" when the same
     Node server also serves this web app (same origin). The web app never
     talks to Firestore directly — every read/write goes through this API.

   A per-browser override still exists for quick local testing without
   editing this file: run this in the browser console —
     localStorage.msa_mode = 'api'        // or 'local'
     localStorage.msa_api  = 'http://localhost:8080'   // API server address
   Those overrides always win over this file.
   ===================================================================== */

export const APP_CONFIG = {
  MODE: "production", // "production" | "demo" | "auto"
  API_URL: "",        // Node API server base URL ("" = same origin as this site)
};
