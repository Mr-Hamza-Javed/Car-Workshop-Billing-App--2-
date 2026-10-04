/* =====================================================================
   MSA Billing — data + auth layer  (firebase-db.js)
   ---------------------------------------------------------------------
   ONE async facade used by the whole app. Two backends behind it:

     • API mode  — the real backend for the deployed site:
         · Auth  → Firebase Authentication (email + password) — login,
                   logout, session and "change my password" stay right
                   here in the web app.
         · Data  → the Node.js API server (server/). The web app NEVER
                   talks to Firestore directly; it sends the user's
                   Firebase ID token with every request and the server
                   verifies it, checks permissions and reads/writes
                   Firestore with the Admin SDK.
     • Local     — localStorage: design-preview / demo fallback. Mirrors
                   the SAME interface (incl. a seeded admin) so the app is
                   fully usable without any backend.

   Mode + API address come from app-config.js (MODE, API_URL).
   Overrides for quick testing (browser console):
     localStorage.msa_mode = 'api' | 'local'
     localStorage.msa_api  = 'http://localhost:8080'

   The business logic (bill numbers, stats aggregates, transactions) lives
   in db-core.js and is shared with the server, so both modes behave the
   same. The app awaits getDB() and calls these methods; everything
   returns app-shaped objects (Date timestamps).
   ===================================================================== */

export const firebaseConfig = {
  apiKey: "AIzaSyAtZs3RFt79f8v6VQ4BS8eM90zjy4mWehQ",
  authDomain: "mirza-bills.firebaseapp.com",
  databaseURL: "https://mirza-bills-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "mirza-bills",
  storageBucket: "mirza-bills.firebasestorage.app",
  messagingSenderId: "138677740907",
  appId: "1:138677740907:web:37c6e2eaa78e536e5cd82e",
  measurementId: "G-M6EB0DS6WW",
};

const SDK = "https://www.gstatic.com/firebasejs/12.15.0/";
const LS_PREFIX = "msa_fs_";                   // local-adapter document store
const SESSION_KEY = "msa_session_v1";          // local-adapter session

import { APP_CONFIG } from "./app-config.js";
import {
  FULL_PERMS, makeDB, encodeJSON, decodeJSON,
  lower, nowMs, rid, sha256Hex, randomSalt, hashPassword, userPublic, actFromStoreFull, billFromStoreFull,
} from "./db-core.js";
export { FULL_PERMS };

/* Hosts that should use the real backend when APP_CONFIG.MODE is "auto". */
const FIREBASE_HOSTS = [
  "mirza-bills.firebaseapp.com",
  "mirza-bills.web.app",
];
function pickMode() {
  let forced = null;
  try { forced = localStorage.getItem("msa_mode"); } catch (e) {}
  if (forced === "api" || forced === "firebase") return "api";
  if (forced === "local") return "local";
  const cfgMode = (APP_CONFIG && APP_CONFIG.MODE) || "auto";
  if (cfgMode === "production") return "api";
  if (cfgMode === "demo") return "local";
  // "auto" (or an unrecognized value) — fall back to hostname heuristics
  const h = (location.hostname || "").toLowerCase();
  if (h.endsWith(".github.io") || FIREBASE_HOSTS.includes(h)) return "api";
  return "local";
}
/* Base URL of the Node API server ("" = same origin as the web app). */
function apiBase() {
  let forced = null;
  try { forced = localStorage.getItem("msa_api"); } catch (e) {}
  const url = forced || (APP_CONFIG && APP_CONFIG.API_URL) || "";
  return String(url).replace(/\/+$/, "");
}

/* =====================================================================
   LOCAL ADAPTER  (localStorage)  — data primitives + app-managed auth
   ===================================================================== */
function makeLocalAdapter() {
  const read = (path) => { try { const r = localStorage.getItem(LS_PREFIX + path); return r ? JSON.parse(r) : null; } catch (e) { return null; } };
  const write = (path, data) => { try { localStorage.setItem(LS_PREFIX + path, JSON.stringify(data)); } catch (e) {} };
  const remove = (path) => { try { localStorage.removeItem(LS_PREFIX + path); } catch (e) {} };
  const idxKey = (coll) => "__index__/" + coll;
  const idx = (coll) => read(idxKey(coll)) || [];
  const setIdx = (coll, ids) => write(idxKey(coll), ids);

  const A = {
    mode: "local",
    async get(path) { return read(path); },
    async set(path, data) { const [coll, id] = path.split("/"); if (id) { const ids = idx(coll); if (!ids.includes(id)) { ids.push(id); setIdx(coll, ids); } } write(path, data); },
    async update(path, patch) { const cur = read(path) || {}; write(path, { ...cur, ...patch }); },
    async del(path) { const [coll, id] = path.split("/"); if (id) setIdx(coll, idx(coll).filter((x) => x !== id)); remove(path); },
    async getAccessStatus() {
      let doc = read("app/access");
      if (!doc) { doc = { isBlocked: 0, title: "Your title", message: "Your message" }; write("app/access", doc); }
      return doc;
    },
    async query(coll, opts) {
      opts = opts || {};
      let rows = idx(coll).map((id) => ({ id, ...(read(coll + "/" + id) || {}) }));
      (opts.where || []).forEach(([f, op, v]) => {
        rows = rows.filter((r) => {
          const x = f === "__name__" ? r.id : r[f];
          if (op === "==") return x === v;
          if (op === "!=") return x !== v;
          if (op === ">") return x > v;
          if (op === ">=") return x >= v;
          if (op === "<") return x < v;
          if (op === "<=") return x <= v;
          if (op === ">=p") return typeof x === "string" && x.startsWith(v);
          return true;
        });
      });
      if (opts.orderBy) { const [f, dir] = opts.orderBy; const key = (r) => (f === "__name__" ? r.id : r[f]); rows.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * (dir === "desc" ? -1 : 1)); }
      if (opts.startAfter != null && opts.orderBy) { const [f, dir] = opts.orderBy; const key = (r) => (f === "__name__" ? r.id : r[f]); rows = rows.filter((r) => (dir === "desc" ? key(r) < opts.startAfter : key(r) > opts.startAfter)); }
      const hasMore = opts.limit ? rows.length > opts.limit : false;
      if (opts.limit) rows = rows.slice(0, opts.limit);
      return { rows, hasMore };
    },
    async txn(fn) { const self = A; const api = { get: async (p) => read(p), set: async (p, d) => self.set(p, d), update: async (p, patch) => self.update(p, patch) }; return fn(api); },

    /* ---- local auth (app-managed; seeded admin) ---- */
    _authCb: null,
    async _emit() { if (this._authCb) this._authCb(await this._currentProfile()); },
    async _currentProfile() {
      let s; try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { s = null; }
      if (!s || !s.uid) return null;
      const row = read("users/" + s.uid);
      if (!row || row.disabled) return null;
      const verifier = (await sha256Hex(row.hash)).slice(0, 24);
      if (verifier !== s.verifier) return null;
      return userPublic(s.uid, row);
    },
    initAuth(cb) { this._authCb = cb; this._currentProfile().then((p) => cb(p)); return () => { this._authCb = null; }; },
    async bootstrap(seed) {
      const res = await this.query("users", { limit: 1 });
      if (res.rows.length) return { seeded: false };
      const salt = randomSalt(); const hash = await hashPassword(seed.password, salt);
      await this.set("users/u_admin", { email: lower(seed.email), fullName: seed.fullName, role: "Admin", perms: FULL_PERMS, activityScope: "all", disabled: false, salt, hash, createdAtMs: nowMs() });
      return { seeded: true };
    },
    async login(email, password) {
      const res = await this.query("users", { where: [["email", "==", lower(email)]], limit: 1 });
      const row = res.rows[0];
      if (!row) return { ok: false, error: "Is email se koi account nahi mila" };
      if (row.disabled) return { ok: false, error: "Yeh account band kar diya gaya hai" };
      const hash = await hashPassword(password, row.salt);
      if (hash !== row.hash) return { ok: false, error: "Password ghalat hai" };
      const verifier = (await sha256Hex(row.hash)).slice(0, 24);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify({ uid: row.id, verifier, ts: nowMs() })); } catch (e) {}
      await this._emit();
      return { ok: true, user: userPublic(row.id, row) };
    },
    async logout() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} await this._emit(); },
    async refreshAuthToken() { /* local mode: claims nahi hote */ },
    async listUsers() { const res = await this.query("users", { orderBy: ["createdAtMs", "asc"] }); return res.rows.map((r) => userPublic(r.id, r)); },
    async createUser({ email, fullName, password, role, perms, activityScope }) {
      const ex = await this.query("users", { where: [["email", "==", lower(email)]], limit: 1 });
      if (ex.rows.length) return { ok: false, error: "Yeh email pehle se mojood hai" };
      const salt = randomSalt(); const hash = await hashPassword(password, salt);
      const id = "u_" + rid("");
      await this.set("users/" + id, { email: lower(email), fullName, role, perms, activityScope, disabled: false, salt, hash, createdAtMs: nowMs() });
      return { ok: true, id };
    },
    async updateUser(id, patch) { const clean = { ...patch }; delete clean.password; delete clean.email; await this.update("users/" + id, clean); return { ok: true }; },
    async setPassword(id, password) { const salt = randomSalt(); const hash = await hashPassword(password, salt); await this.update("users/" + id, { salt, hash }); return { ok: true }; },
    /* apna password khud change karna — mojooda password verify karke */
    async changeMyPassword(currentPw, newPw) {
      let s; try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { s = null; }
      if (!s || !s.uid) return { ok: false, error: "Login nahi mila" };
      const row = read("users/" + s.uid);
      if (!row) return { ok: false, error: "Account nahi mila" };
      const hash = await hashPassword(currentPw, row.salt);
      if (hash !== row.hash) return { ok: false, error: "Mojooda password ghalat hai" };
      const salt = randomSalt(); const nh = await hashPassword(newPw, salt);
      await this.update("users/" + s.uid, { salt, hash: nh });
      const verifier = (await sha256Hex(nh)).slice(0, 24);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify({ uid: s.uid, verifier, ts: nowMs() })); } catch (e) {}
      return { ok: true };
    },
    async setDisabled(id, disabled) { await this.update("users/" + id, { disabled: !!disabled }); return { ok: true }; },
    async deleteUser(id) { await this.del("users/" + id); return { ok: true }; },
    async getClientGeo() {
      // no Cloud Function in offline/local mode — best-effort free client-side lookup
      try {
        const res = await fetch("https://ipwho.is/");
        const data = await res.json();
        if (data && data.success !== false) {
          const parts = [data.city, data.region].filter(Boolean).join(", ");
          const location = [parts, data.country].filter(Boolean).join(" · ");
          return { ip: data.ip || null, location: location || null };
        }
      } catch (e) {}
      return null;
    },
  };
  return A;
}
/* =====================================================================
   API ADAPTER  — Firebase Auth (login only) + Node API server (all data)
   ===================================================================== */
async function makeApiDB() {
  const appMod = await import(SDK + "firebase-app.js");
  const authMod = await import(SDK + "firebase-auth.js");
  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  try { await authMod.setPersistence(auth, authMod.browserLocalPersistence); } catch (e) {}
  // local development against the Firebase Auth emulator: localStorage.msa_auth_emulator = 'http://127.0.0.1:9099'
  try { const emu = localStorage.getItem("msa_auth_emulator"); if (emu) authMod.connectAuthEmulator(auth, emu, { disableWarnings: true }); } catch (e) {}
  const BASE = apiBase();

  /* one fetch wrapper for every call: adds the ID token, encodes/decodes Dates, and turns
     server errors into Error objects shaped like the app expects (e.code === 'permission-denied',
     e.userMessage for business-rule messages). */
  async function api(method, path, body, opts) {
    opts = opts || {};
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false) {
      const u = auth.currentUser;
      if (!u) { const e = new Error("Login zaroori hai"); e.code = "unauthenticated"; throw e; }
      headers.Authorization = "Bearer " + (await u.getIdToken());
    }
    let res;
    const ctl = opts.timeoutMs ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs) : null;
    try { res = await fetch(BASE + "/api" + path, { method, headers, body: body !== undefined ? encodeJSON(body) : undefined, signal: ctl ? ctl.signal : undefined }); }
    catch (e) { const er = new Error("Network problem — server tak rasai nahi ho saki"); er.code = "unavailable"; throw er; }
    finally { if (timer) clearTimeout(timer); }
    const text = await res.text();
    let data = null;
    try { data = text ? decodeJSON(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const info = (data && data.error) || {};
      const er = new Error(info.message || ("Server error (" + res.status + ")"));
      er.code = info.code || (res.status === 403 ? "permission-denied" : res.status === 401 ? "unauthenticated" : "internal");
      er.status = res.status;
      if (info.userMessage) er.userMessage = info.userMessage;
      throw er;
    }
    return data;
  }
  const qs = (params) => {
    const sp = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null || v === "") return;
      sp.set(k, k === "startAfter" ? JSON.stringify(v) : String(v));
    });
    const s = sp.toString();
    return s ? "?" + s : "";
  };
  const enc = encodeURIComponent;
  const okOrErr = async (fn) => { try { return { ok: true, ...((await fn()) || {}) }; } catch (e) { return { ok: false, error: e.userMessage || e.message || "Operation nahi ho saka" }; } };

  /* ---- profile (from the server) — short memo so login + onAuthStateChanged share one call ---- */
  let meMemo = null;
  async function fetchProfile(user) {
    if (meMemo && meMemo.uid === user.uid && Date.now() - meMemo.at < 5000) return meMemo.promise;
    const promise = (async () => {
      let lastErr = null;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await api("GET", "/me");
          if (r && r.profile) return r.profile;
          return { id: user.uid, email: user.email, fullName: user.email, role: "User", perms: {}, activityScope: "own", disabled: false, createdAtMs: 0, _noProfile: true };
        } catch (e) { lastErr = e; if (e.status && e.status < 500) break; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
      }
      console.warn("[MSA] profile load failed", lastErr);
      // server unreachable — keep the session but with no permissions; data calls will show errors
      return { id: user.uid, email: user.email, fullName: user.email, role: "User", perms: {}, activityScope: "own", disabled: false, createdAtMs: 0, _noProfile: true, _serverDown: true };
    })();
    meMemo = { uid: user.uid, at: Date.now(), promise };
    promise.catch(() => { meMemo = null; });
    return promise;
  }

  const core = makeDB({ mode: "api" });   // only for derive() (pure); no storage behind it

  /* ---- FULL-SYNC FALLBACK: direct Firestore read ----
     The complete bills + activity downloads normally come from the API. If the API is down /
     unreachable / errors, the app reads those collections DIRECTLY from Firestore instead
     (read-only — the Firestore rules allow any known user to read /bills and /activity). The
     Firestore SDK is only downloaded the first time this fallback is actually needed. Silent. */
  let fsPromise = null;
  function directFirestore() {
    if (!fsPromise) {
      fsPromise = import(SDK + "firebase-firestore.js").then((fs) => {
        const fdb = fs.getFirestore(app);
        // local development against the Firestore emulator: localStorage.msa_firestore_emulator = '127.0.0.1:8080'
        try { const emu = localStorage.getItem("msa_firestore_emulator"); if (emu) { const [h, p] = emu.split(":"); fs.connectFirestoreEmulator(fdb, h, Number(p)); } } catch (e) {}
        return { fs, fdb };
      });
      fsPromise.catch(() => { fsPromise = null; });   // allow a retry after a failed SDK load
    }
    return fsPromise;
  }
  async function allFromFirestore(coll, mapDoc) {
    const { fs, fdb } = await directFirestore();
    const out = [];
    let last = null;
    for (let guard = 0; guard < 100000; guard++) {
      // paged by document id (unique, no composite index) — same as the server does
      const parts = [fs.orderBy(fs.documentId()), fs.limit(1000)];
      if (last) parts.splice(1, 0, fs.startAfter(last));
      const snap = await fs.getDocs(fs.query(fs.collection(fdb, coll), ...parts));
      snap.docs.forEach((d) => out.push(mapDoc(d.id, d.data())));
      if (snap.docs.length < 1000) break;
      last = snap.docs[snap.docs.length - 1];
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  return {
    mode: "api",
    derive: core.derive,
    raw: null,   // no direct database access from the browser

    /* ---------- auth (stays in the web app: Firebase Authentication) ---------- */
    initAuth(cb) {
      return authMod.onAuthStateChanged(auth, async (user) => {
        if (!user) { meMemo = null; cb(null); return; }
        const prof = await fetchProfile(user);
        if (prof && prof.disabled) { await authMod.signOut(auth); cb(null); return; }
        cb(prof);
      });
    },
    async bootstrap() { try { return await api("POST", "/bootstrap", {}); } catch (e) { return { ok: false, error: e.message }; } },
    async login(email, password) {
      try {
        const cred = await authMod.signInWithEmailAndPassword(auth, lower(email), password);
        const prof = await fetchProfile(cred.user);
        if (prof && prof.disabled) { await authMod.signOut(auth); return { ok: false, error: "Yeh account band kar diya gaya hai" }; }
        return { ok: true, user: prof };
      } catch (e) {
        const map = { "auth/invalid-credential": "Email ya password ghalat hai", "auth/wrong-password": "Password ghalat hai", "auth/user-not-found": "Is email se koi account nahi mila", "auth/invalid-email": "Email theek nahi", "auth/user-disabled": "Yeh account band kar diya gaya hai", "auth/too-many-requests": "Bohat zyada koshishein — thodi der baad try karein", "auth/network-request-failed": "Network problem — internet check karein" };
        return { ok: false, error: map[e.code] || ("Login nahi ho saka: " + (e.code || e.message)) };
      }
    },
    async logout() { meMemo = null; await authMod.signOut(auth); },
    // fresh ID token + re-read profile (called by the app after a permission-denied)
    async refreshAuthToken() { meMemo = null; try { if (auth.currentUser) await auth.currentUser.getIdToken(true); } catch (e) {} },
    /* apna password khud change karna — Firebase Auth reauthenticate + updatePassword */
    async changeMyPassword(currentPw, newPw) {
      const user = auth.currentUser;
      if (!user || !user.email) return { ok: false, error: "Login nahi mila" };
      try {
        const cred = authMod.EmailAuthProvider.credential(user.email, currentPw);
        await authMod.reauthenticateWithCredential(user, cred);
        await authMod.updatePassword(user, newPw);
        return { ok: true };
      } catch (e) {
        const map = { "auth/invalid-credential": "Mojooda password ghalat hai", "auth/wrong-password": "Mojooda password ghalat hai", "auth/weak-password": "Naya password kamzor hai", "auth/too-many-requests": "Bohat zyada koshishein — thodi der baad try karein", "auth/network-request-failed": "Network problem — internet check karein" };
        return { ok: false, error: map[e.code] || ("Password change nahi hua: " + (e.code || e.message)) };
      }
    },

    /* ---------- users (admin) ---------- */
    listUsers: () => api("GET", "/users"),
    createUser: (p) => okOrErr(async () => { const r = await api("POST", "/users", p); return { id: r.uid }; }),
    updateUser: (id, patch) => okOrErr(() => api("PATCH", "/users/" + enc(id), patch)),
    setPassword: (id, password) => okOrErr(() => api("POST", "/users/" + enc(id) + "/password", { password })),
    setDisabled: (id, disabled) => okOrErr(() => api("POST", "/users/" + enc(id) + "/disabled", { disabled: !!disabled })),
    deleteUser: (id) => okOrErr(() => api("DELETE", "/users/" + enc(id))),
    async getClientGeo() { try { return await api("GET", "/geo"); } catch (e) { return null; } },

    /* ---------- kill switch (public — checked before login) ---------- */
    getAccessStatus: () => api("GET", "/access", undefined, { auth: false }),

    /* ---------- settings / templates / presets / counter ---------- */
    getSettings: () => api("GET", "/settings"),
    saveSettings: (s) => api("PUT", "/settings", s),
    getNoteTemplates: () => api("GET", "/note-templates"),
    saveNoteTemplates: (d) => api("PUT", "/note-templates", d),
    getPrintPresets: () => api("GET", "/print-presets"),
    savePrintPresets: (d) => api("PUT", "/print-presets", d),
    async peekCounter() { const r = await api("GET", "/counter"); return r ? r.value : null; },
    initCounter: (start) => api("POST", "/counter/init", { start }),
    bumpCounterIfHigher: (start) => api("POST", "/counter/bump", { start }),

    /* ---------- bills ---------- */
    loadBillsPage: ({ mode, batch, startAfter }) => api("GET", "/bills" + qs({ mode, batch, startAfter })),
    loadPendingPage: ({ batch, startAfter }) => api("GET", "/bills/pending" + qs({ batch, startAfter })),
    // EVERY bill (active + archived + bin) with all nested data — API first, direct Firestore if it fails
    async loadAllBills() {
      try { return await api("GET", "/bills/all", undefined, { timeoutMs: 60000 }); }
      catch (e) { return allFromFirestore("bills", billFromStoreFull); }
    },
    billsForDay: (dayMs) => api("GET", "/bills/day" + qs({ dayMs: new Date(dayMs).getTime() })),
    async searchBills(q) { q = (q || "").trim(); if (!q) return []; return api("GET", "/bills/search" + qs({ q })); },
    async getBill(id) { try { return await api("GET", "/bills/" + enc(id)); } catch (e) { if (e.status === 404) return null; throw e; } },
    customerHistoryByPhone: (phone, exId) => api("GET", "/customers/history" + qs({ phone: phone || "", exId })).then((r) => r || { count: 0 }),
    customerHistoryByCar: (car, exId) => api("GET", "/customers/history" + qs({ car: car || "", exId })).then((r) => r || { count: 0 }),
    saveNewBill: (bill) => api("POST", "/bills", { bill }),
    updateBill: (id, bill, oldBill) => api("PUT", "/bills/" + enc(id), { bill, oldBill }),
    archiveBill: (id, oldBill, archived) => api("POST", "/bills/" + enc(id) + "/archive", { archived: !!archived }),
    softDeleteBill: (id) => api("POST", "/bills/" + enc(id) + "/soft-delete", {}),
    restoreBill: (id) => api("POST", "/bills/" + enc(id) + "/restore", {}),
    permanentDelete: (id) => api("DELETE", "/bills/" + enc(id)),
    addHistory: (id, oldBill, entry) => api("POST", "/bills/" + enc(id) + "/history", { entry }),

    /* ---------- products ---------- */
    listProducts: (limit) => api("GET", "/products/pool" + qs({ limit })),
    loadProductsPage: ({ batch, startAfter }) => api("GET", "/products" + qs({ batch, startAfter })),
    deleteProduct: (name) => api("DELETE", "/products" + qs({ name })),

    /* ---------- activity ---------- */
    async logActivity(entry) { const r = await api("POST", "/activity", entry); return r && r.id; },
    loadActivityPage: ({ batch, startAfter }) => api("GET", "/activity" + qs({ batch, startAfter })),
    // API first; if the API fails for any reason (down, timeout, server error) read Firestore directly
    async loadAllActivity() {
      try { return await api("GET", "/activity/all", undefined, { timeoutMs: 30000 }); }
      catch (e) { return allFromFirestore("activity", actFromStoreFull); }
    },
    billActivity: (billId) => api("GET", "/bills/" + enc(billId) + "/activity"),

    /* ---------- stats ---------- */
    statsForDays: (keys) => (keys && keys.length ? api("GET", "/stats/days" + qs({ keys: keys.join(",") })) : Promise.resolve({})),
    statsForMonths: (keys) => (keys && keys.length ? api("GET", "/stats/months" + qs({ keys: keys.join(",") })) : Promise.resolve({})),
    allMonthStats: () => api("GET", "/stats/months/all"),
    recomputeStats: () => api("POST", "/stats/recompute", {}),
    reconcileDay: (dayMs, truth) => api("POST", "/stats/reconcile-day", { dayMs: new Date(dayMs).getTime(), truth }),

    /* ---------- background recalculation (runs on the server; app polls progress) ---------- */
    startRecalcJob: (range) => api("POST", "/recalc", range),
    cancelRecalcJob: (jobId) => api("POST", "/recalc/" + enc(jobId) + "/cancel", {}),
    subscribeRecalcJob(jobId, cb) {
      let dead = false, timer = null, misses = 0;
      const tick = async () => {
        if (dead) return;
        let job = null;
        try { job = await api("GET", "/recalc/" + enc(jobId)); misses = 0; }
        catch (e) {
          if (e.status === 404) {
            // the job just started (POST may still be in flight) — give it a moment before giving up
            if (++misses < 5) { timer = setTimeout(tick, 1000); return; }
            job = { status: "error", error: "Job server par nahi mila (server restart ho gaya ho sakta hai)" };
          } else { timer = setTimeout(tick, 2500); return; }
        }
        if (dead) return;
        try { cb(job); } catch (e) {}
        if (job && job.status === "running") timer = setTimeout(tick, 1000);
      };
      tick();
      return () => { dead = true; if (timer) clearTimeout(timer); };
    },
  };
}

/* =====================================================================
   LOCAL (demo) DB — shared core over localStorage + local auth
   ===================================================================== */
function makeLocalDB() {
  const A = makeLocalAdapter();
  const db = makeDB(A);
  return Object.assign(db, {
    getAccessStatus: () => A.getAccessStatus(),
    // no cloud recalc in demo mode — the frontend uses its local engine
    startRecalcJob: null, cancelRecalcJob: null, subscribeRecalcJob: null,
    initAuth: (cb) => A.initAuth(cb),
    bootstrap: (seed) => A.bootstrap(seed),
    login: (email, pw) => A.login(email, pw),
    logout: () => A.logout(),
    refreshAuthToken: () => A.refreshAuthToken(),
    listUsers: () => A.listUsers(),
    createUser: (p) => A.createUser(p),
    updateUser: (id, patch) => A.updateUser(id, patch),
    setPassword: (id, pw) => A.setPassword(id, pw),
    changeMyPassword: (cur, nw) => A.changeMyPassword(cur, nw),
    setDisabled: (id, d) => A.setDisabled(id, d),
    deleteUser: (id) => A.deleteUser(id),
    getClientGeo: () => A.getClientGeo(),
  });
}

/* =====================================================================
   SINGLETON
   ===================================================================== */
let _dbPromise = null;
export function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const mode = pickMode();
    if (mode === "api") {
      try {
        return await Promise.race([
          makeApiDB(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("firebase-auth-init-timeout")), 9000)),
        ]);
      } catch (e) {
        console.warn("[MSA] API/auth init failed, falling back to local:", e && e.message);
        return makeLocalDB();
      }
    }
    return makeLocalDB();
  })();
  return _dbPromise;
}

export { pickMode };
