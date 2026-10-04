# MSA Billing — Car Workshop Billing App

A complete, production-ready billing & management web app for **MSA Auto Workshop**. Staff create
bills, take payments, manage products, view reports, and administer users — backed by a
**Node.js API server** (`server/`) on top of **Firebase** (Auth + Firestore). Login happens in the
web app with Firebase Auth; **all data goes through the Node API** — the browser never talks to
Firestore directly. Built as a single Design Component, served as `index.html`, that runs directly
in the browser, hosts as a static site (or from the Node server itself), and installs as a PWA.

> **New here? Open [`guide.html`](guide.html) for the full step-by-step setup.**

---

## What it does

- **Login** — secure email + password (Firebase Auth). Dark, branded sign-in screen. Sessions
  persist; logout from the sidebar user chip.
- **Dashboard** — period selector (24h / 7d / 28d / 90d) with summary cards (billed / paid / pending
  / count) read from **cheap aggregate documents** (never scans bills), a master privacy "eye"
  toggle, live clock, and recent bills.
- **Bill form** — product rows with auto-suggest, live line totals, two-way linked **discount ↔
  final-total**, and **paid starts at 0 on a new bill** — it never auto-fills; the cashier types the
  amount actually received (any balance stays pending/udhaar). Printed comment + internal note, customer history lookups by phone/car.
- **Bill view (read-only)** — readable invoice card. **Next/Prev** via buttons + keyboard ← →
  only (tapping the bill never navigates), with smooth slide animations. As you reach the end of the
  loaded list, the next batch loads automatically. Mobile shows a **back icon**; desktop shows
  window-style **close (×)** + arrows. Closing returns you to the exact list scroll position you left.
- **Payments** — payment + adjustment (refund) ledger, each entry attributed to the staff member.
- **Search** — by phone / car / customer name / bill number (server-side, indexed).
- **Bills list / Pending** — server-paginated, color-coded statuses, Archived filter, infinite scroll.
- **Reports** — day / month / year / total bar chart from aggregate docs. **No horizontal scroll** —
  bars keep a fixed footprint and labels thin out to tick marks when space is tight (professional
  chart behaviour). Click a bar for a detail panel; open that day's bills as a filtered secondary
  view (back returns you to the report, unchanged).
- **Activity logs** — append-only audit trail (create / update / delete / archive / restore /
  payment / refund / user & settings changes) with field-level diffs and per-user visibility scope.
- **Recycle bin & archive** — soft-delete to a restorable bin; permanent delete / empty-bin; archive.
- **Print templates** — A4 / A5 / Letter + thermal 80/58mm, live preview, logo/colors/columns/
  header/footer/font controls (font size down to 40%), **black mode** (pure-black text, lines &
  logo for B&W printers — only the meta band & note keep a light gray background), long item
  names wrap to new lines, multi-page overflow, Print / Save-PDF.
- **Products**, **Users & permissions**, **Settings** — see below.
- **Emergency kill switch** — an admin can instantly lock the whole app for every user by flipping
  `isBlocked` to `1` on the `app/access` Firestore document (console-only, never from the app UI). All
  users are stopped before the login screen with a full-screen, un-dismissable message (title +
  Markdown body) until it's switched back off.

---

## Loading & responsiveness model

Every action gives clear feedback and is protected against double-submit:

- **Full-screen blocking overlay** for big actions the user must wait on (saving/deleting a bill,
  payments, user operations, emptying the bin, login). All action buttons disable while their
  operation is in flight — one action runs once, even on a slow connection.
- **Header spinner** for small background saves (settings change, permission toggle, activity scope).
  There is no Settings "Save" button — changes auto-save and show the header spinner.
- **Per-list skeleton loaders** — open a page before its data has arrived and the list shows a
  loading state, not a frozen empty screen.
- **Per-page scroll memory** — each page keeps its own scroll position; first visit opens at the top.
- **Animations everywhere** with a **speed slider** in Settings (Off → Slow → Standard → Fast),
  driving a global multiplier on popups, route changes, list population, bill slide nav, and the
  privacy reveal.
- **Frosted, scroll-aware header & sidebar** (backdrop blur) for a modern, premium feel.

---

## Architecture

| Layer | Tech | Notes |
|---|---|---|
| **App** | Single `index.html` (Design Component) | UI + logic; static, hosts on GitHub Pages; installable PWA. |
| **Data + auth (client)** | `firebase-db.js` | One async facade. **Login / logout / change-password = Firebase Auth in the browser.** Every data call = `fetch` to the Node API with the user's Firebase ID token. **localStorage demo fallback** so the design preview works without a backend. |
| **Activity fallback** | `firebase-db.js` | The activity log comes from the API; if the API fails, the app silently reads the `activity` collection directly from Firestore (read-only, allowed by `firestore.rules`). |
| **Business logic** | `db-core.js` | Shared by the server and the demo mode: bill numbering, stats aggregates, transactions, search. |
| **API server** | `server/` | Node.js + Express + Firebase **Admin SDK** — the ONLY thing that reads/writes Firestore. Verifies the ID token and the caller's permissions on every request; also does user admin, geo lookup and background report recalculation (replaces the old Cloud Functions). See [`server/README.md`](server/README.md). |
| **Security** | `server/lib/auth.js` (+ `firestore.rules`) | Per-action permission checks on the server. Firestore rules remain as a second line of defence. |
| **Indexes** | `firestore.indexes.json` | Composite indexes for bills (active/archived/bin/pending) and search. |
| **PWA** | `manifest.webmanifest`, `service-worker.js` | Installable; app-shell cached. `/api/` responses are never cached. |
| **Legacy** | `functions/` | Old Cloud Functions — **no longer called by the web app** (the Node server does their job). Kept only until the new setup is live. |

**Mode selection:** controlled explicitly by **`app-config.js`** — set `MODE` to `"production"` (real
backend: Firebase Auth + Node API, needed for any real deployment including a custom domain) and
`API_URL` to the Node server's address (`""` when the Node server also serves the site), `"demo"` (always offline demo
data), or `"auto"` (guesses from hostname — only recognizes `*.github.io` / `*.web.app` /
`*.firebaseapp.com`, so it will silently stay in demo mode on a custom domain unless you set
`"production"` explicitly). Override per-browser without editing the file via
`localStorage.msa_mode = 'api' | 'local'` (and `localStorage.msa_api = 'http://localhost:8080'`) in
the console.

### Efficiency (core requirement)
- Bills are **paginated** (batch from Settings, default 25) and cached; opening a loaded bill is
  instant. Reaching the end of the view list pre-loads the next batch.
- All dashboard/report totals come from **aggregate documents** (`stats/{day}`, `stats_m/{month}`)
  updated transactionally on every write — the bills collection is never scanned for totals.
- Bill numbers are allocated by an **atomic Firestore counter** in a transaction (no duplicates under
  concurrency). Prefix & starting number are editable in Settings.

---

## Auth & users

- Login is **email + password**. The first admin is **`admin@msa.com`** (display name *Asif
  Shakoor*) — created once in the Firebase console; its app profile self-seeds on first login.
- Users have a **flat permission set**: create / edit / delete / archive bills, record payments,
  manage products, view reports, recycle bin, manage users, edit settings. Role presets
  (Admin / Manager / Cashier / Viewer) set these in one click; toggles fine-tune.
- Anyone with the **users** permission (not just the admin) can add, edit (full name + role),
  set/reset passwords, disable, and delete users — but **only an admin can touch the admin account or
  create another admin**. Emails are fixed; **only the full name and password change.**
- Passwords are **set by the admin** and not user-changeable; the admin resets them from the UI.

---

## Setup & deploy

See **[`guide.html`](guide.html)** for the complete walkthrough. In short:

1. Enable **Firestore** and **Authentication (Email/Password)** in the Firebase console.
2. Ensure the admin user exists: `admin@msa.com` / `123456`.
3. `npm i -g firebase-tools` → `firebase login` → `firebase use mirza-bills` →
   `firebase deploy --only firestore:rules,firestore:indexes`.
4. **Run the Node API server** — see [`server/README.md`](server/README.md)
   (`cd server && npm install && npm start`, with a service-account key in `server/.env`).
5. In `app-config.js` set `API_URL` to the server's public URL (or leave `""` if the Node server
   also serves the site).
6. Add your host (e.g. `your-username.github.io`) to **Auth → Authorized domains**.
7. Host the site on **GitHub Pages** / `firebase deploy --only hosting` — or just let the Node server
   serve it.
8. Log in, set a strong admin password, configure Settings, add your team.

---

## Credits

Built for **MSA Auto Workshop**. Node.js API + Firebase backend (Auth + Firestore), static
PWA frontend.
