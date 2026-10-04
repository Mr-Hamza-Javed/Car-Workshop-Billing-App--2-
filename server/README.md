# MSA Billing — Node.js API server

This server is now the **only** part of the system that reads and writes Firestore.
The web app (`index.html` + `firebase-db.js`) calls this REST API instead of Firestore.

```
 Browser (web app)                         Node server (this folder)              Firebase
 ──────────────────                        ─────────────────────────              ────────
 Login / logout / change password  ───────────────────────────────────────────▶  Firebase Auth
 Every data call  ──  fetch /api/...  ──▶  verify ID token + permissions  ──▶     Firestore (Admin SDK)
                      Authorization: Bearer <Firebase ID token>
```

- **Login stays in the web app** (Firebase Authentication — email + password, sessions,
  "change my password"). The app sends the user's Firebase **ID token** with every request.
- The server **verifies the token**, loads `users/{uid}`, checks the permission for that action,
  then runs the shared business logic in [`../db-core.js`](../db-core.js) (the same code the
  browser demo mode uses — bill numbers, stats aggregates, transactions).
- **One exception — full-sync fallback:** the app downloads ALL bills and ALL activity from
  `GET /api/bills/all` and `GET /api/activity/all`; if a call fails (server down, timeout, error)
  it silently reads that collection **directly from Firestore** instead (read-only). Keep the
  `/bills` and `/activity` read rules in `firestore.rules` (`allow read: if isKnownUser()`).
- It also replaces the old Cloud Functions: user admin, IP/geo lookup for the activity log, and the
  background "Recalculate reports" job (progress is polled by the app).

---

## Run it locally

```bash
cd server
npm install
cp .env.example .env        # then edit it
npm start                   # → http://localhost:8080
```

1. Firebase console → **Project settings → Service accounts → Generate new private key**.
   Save the file as `server/service-account.json` (it is git-ignored — **never commit it**).
2. In `.env` keep `GOOGLE_APPLICATION_CREDENTIALS=./service-account.json`.
3. Open `http://localhost:8080` — by default the server also serves the web app, so
   `API_URL: ""` in `app-config.js` just works.

Testing the site from a different origin (e.g. a static dev server)? In the browser console:
`localStorage.msa_api = 'http://localhost:8080'`.

### Fully offline with the Firebase emulators

```bash
firebase emulators:start --only auth,firestore
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 PORT=8090 npm start
```
and in the browser console: `localStorage.msa_auth_emulator = 'http://127.0.0.1:9099'`.

---

## Deploy

Any Node 22+ host works (Render, Railway, Fly.io, a VPS, Google Cloud Run, ...).
The server imports `../db-core.js`, so deploy the **whole repository** and use:

| Setting | Value |
|---|---|
| Build command | `cd server && npm install` |
| Start command | `node server/index.js` |
| Env vars | `FIREBASE_SERVICE_ACCOUNT` (the JSON key on one line) **or** `FIREBASE_SERVICE_ACCOUNT_BASE64`, `TZ=Asia/Karachi`, `ALLOWED_ORIGINS=https://your-site` |

Then set `API_URL` in `app-config.js` to the server's public URL (e.g.
`"https://msa-billing-api.onrender.com"`) — or leave it `""` and open the site from the Node server
itself (`SERVE_STATIC=true`, the default), so one service hosts both.

> **Timezone matters.** Daily/monthly report totals are bucketed by local date. Keep
> `TZ=Asia/Karachi` (the default) so the server agrees with the shop's clock.

> **One instance.** The recalculation job's live progress is kept in memory, so run a single
> instance (the normal setup for this app). Everything else is stateless.

---

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `FIREBASE_PROJECT_ID` | `mirza-bills` | Firebase project |
| `GOOGLE_APPLICATION_CREDENTIALS` | – | Path to the service-account JSON |
| `FIREBASE_SERVICE_ACCOUNT` | – | Service-account JSON as a string |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | – | Service-account JSON, base64 |
| `TZ` | `Asia/Karachi` | Timezone for report day/month buckets |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `SERVE_STATIC` | `true` | Also serve the web app from this server |

---

## API

All routes are under `/api`. Bodies and responses are JSON; `Date` values travel as
`{ "$date": <ms> }`. Errors look like `{ "error": { "code", "message", "userMessage?" } }`
(`401 unauthenticated`, `403 permission-denied`, `404 not-found`, `409` business-rule errors,
`503 firebase-unavailable` whenever Firebase itself fails — quota exhausted, outage, billing,
credentials).

| Method | Path | Permission |
|---|---|---|
| GET | `/health` | public |
| GET | `/status` | public — one tiny Firestore read; `503 firebase-unavailable` when Firebase fails (the app then shows its fixed error page) |
| GET | `/me` | signed in (creates the primary admin's profile on first login) |
| POST | `/bootstrap` | primary admin only |
| GET | `/geo` | known user |
| GET / PUT | `/settings` | read: known user · write: `settings.manage` |
| GET / PUT | `/note-templates` | read: known user · write: `bills.create` |
| GET / PUT | `/print-presets` | read: known user · write: `settings.manage` |
| GET | `/counter` | known user |
| POST | `/counter/init`, `/counter/bump` | `bills.create` or `settings.manage` |
| GET | `/bills?mode=active\|archived\|bin&batch=&startAfter=` | known user |
| GET | `/bills/pending?batch=&startAfter=` | known user |
| GET | `/bills/day?dayMs=` | known user |
| GET | `/bills/all` | known user — EVERY bill (active, archived, recycle bin) with all fields + nested lines/history (the app syncs this after each bill change) |
| GET | `/bills/search?q=` | known user |
| GET | `/customers/history?phone=\|car=&exId=` | known user |
| GET | `/bills/:id` | known user |
| POST | `/bills` | `bills.create` |
| PUT | `/bills/:id` | `bills.edit` |
| POST | `/bills/:id/archive` | `bills.archive` |
| POST | `/bills/:id/soft-delete` | `bills.delete` |
| POST | `/bills/:id/restore` | `recycle.restore` |
| DELETE | `/bills/:id` | `recycle.purge` |
| POST | `/bills/:id/history` | `bills.payments` |
| GET | `/bills/:id/activity` | known user |
| GET | `/products/pool?limit=` | known user |
| GET | `/products?batch=&startAfter=` | known user |
| DELETE | `/products?name=` | `products.delete` |
| GET / POST | `/activity` | known user (the server stamps the user from the token) |
| GET | `/activity/all` | known user — EVERY activity document (the app syncs this after login and after each bill change) |
| GET | `/stats/days?keys=`, `/stats/months?keys=`, `/stats/months/all` | known user |
| POST | `/stats/recompute`, `/stats/reconcile-day` | any bill-write permission |
| POST | `/recalc` · GET `/recalc/:jobId` | known user |
| POST | `/recalc/:jobId/cancel` | Admin |
| GET | `/users` | known user |
| POST | `/users` · PATCH/DELETE `/users/:id` · POST `/users/:id/password`, `/users/:id/disabled` | Admin (same hierarchy rules as before) |

"Known user" = valid token **and** an enabled `users/{uid}` profile. The Admin role (and
`admin@msa.com`) passes every permission check. The "last N days" / per-user scope fine-tuning is
still applied by the app, exactly as before.
