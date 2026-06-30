/* =====================================================================
   MSA Billing — data + auth layer  (firebase-db.js)
   ---------------------------------------------------------------------
   ONE async facade used by the whole app. Two adapters behind it:

     • Firebase  — real backend for the deployed site:
         · Auth         → Firebase Authentication (email + password)
         · Data         → Cloud Firestore (with offline persistence)
         · User admin   → Cloud Functions (Admin SDK, server-verified)
     • Local     — localStorage: offline cache + design-preview fallback.
                   Mirrors the SAME interface (incl. a seeded admin) so the
                   app is fully usable in preview / offline.

   Mode is chosen by host:
     - real deploy host (github.io / firebase host / custom)  → Firebase
     - preview / localhost / file://                          → Local
     - override anytime with  localStorage.msa_mode = 'firebase' | 'local'

   The app NEVER imports firebase directly — it awaits getDB() and calls
   these methods. Everything returns app-shaped objects (Date timestamps).
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
const FUNCTIONS_REGION = "us-central1";       // must match functions deploy region
const LS_PREFIX = "msa_fs_";                   // local-adapter document store
const SESSION_KEY = "msa_session_v1";          // local-adapter session
const ADMIN_EMAIL = "admin@msa.com";           // self-bootstrap allowed only for this

/* Hosts that should use the real Firebase backend. Add your custom domain. */
const FIREBASE_HOSTS = [
  "mirza-bills.firebaseapp.com",
  "mirza-bills.web.app",
];
function pickMode() {
  let forced = null;
  try { forced = localStorage.getItem("msa_mode"); } catch (e) {}
  if (forced === "firebase" || forced === "local") return forced;
  const h = (location.hostname || "").toLowerCase();
  if (h.endsWith(".github.io") || FIREBASE_HOSTS.includes(h)) return "firebase";
  return "local";
}

/* default permission set for a brand-new admin */
export const FULL_PERMS = {
  bills_create: true, bills_edit: true, bills_delete: true, bills_archive: true,
  payments: true, products: true, reports: true, recycle: true,
  users: true, settings: true,
};

/* ---------- small utils ---------- */
const nowMs = () => Date.now();
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
const digits = (s) => String(s == null ? "" : s).replace(/[^\d]/g, "");
const carCore = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const phoneCore = (s) => { let d = digits(s); d = d.replace(/^(0092|92)/, "").replace(/^0/, ""); return d; };
const rid = (p) => (p || "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomSalt() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(pw, salt) { return sha256Hex(salt + "::" + pw); }

function aggHistory(rows) {
  if (!rows.length) return { count: 0 };
  let total = 0, pend = 0, pc = 0, last = 0;
  rows.forEach((r) => { total += r.total || 0; if ((r.pending || 0) > 0) { pend += r.pending; pc++; } if ((r.tsMs || 0) > last) last = r.tsMs; });
  return { count: rows.length, total, pending: pend, pendingCount: pc, last: new Date(last) };
}

/* ---------- app-shape <-> stored-doc conversion ---------- */
function billToStore(b, derive) {
  const d = derive(b);
  return {
    no: b.no, name: b.name || "", nameLower: lower(b.name),
    phone: b.phone || "", phoneCore: phoneCore(b.phone),
    car: b.car || "", carCore: carCore(b.car), model: b.model || "",
    lines: (b.lines || []).map((l) => ({ name: l.name, qty: Number(l.qty) || 0, price: Number(l.price) || 0 })),
    discount: Number(b.discount) || 0, comment: b.comment || "", note: b.note || "",
    tsMs: (b.ts instanceof Date ? b.ts : new Date()).getTime(),
    createdBy: b.createdBy || "", createdById: b.createdById || "",
    archived: !!b.archived, deleted: !!b.deleted,
    deletedAtMs: b.deletedAt instanceof Date ? b.deletedAt.getTime() : (b.deletedAtMs || null),
    history: (b.history || []).map((h) => ({ kind: h.kind, amount: Number(h.amount) || 0, comment: h.comment || "", tsMs: (h.ts instanceof Date ? h.ts : new Date()).getTime(), by: h.by || "" })),
    sub: d.sub, disc: d.disc, total: d.total, paid: d.paid, pending: d.pending, status: d.status,
  };
}
function billFromStore(id, d) {
  return {
    id, no: d.no, name: d.name || "", phone: d.phone || "", car: d.car || "", model: d.model || "",
    lines: (d.lines || []).map((l) => ({ name: l.name, qty: Number(l.qty) || 0, price: Number(l.price) || 0 })),
    discount: Number(d.discount) || 0, comment: d.comment || "", note: d.note || "",
    ts: new Date(d.tsMs || nowMs()), createdBy: d.createdBy || "", createdById: d.createdById || "",
    archived: !!d.archived, deleted: !!d.deleted,
    deletedAt: d.deletedAtMs ? new Date(d.deletedAtMs) : null,
    history: (d.history || []).map((h) => ({ kind: h.kind, amount: Number(h.amount) || 0, comment: h.comment || "", ts: new Date(h.tsMs || d.tsMs || nowMs()), by: h.by || "" })),
  };
}
function actToStore(a) {
  return { tsMs: (a.ts instanceof Date ? a.ts : new Date()).getTime(), userId: a.userId || "", userName: a.userName || "", action: a.action || "", entity: a.entity || "", entityId: a.entityId || "", entityLabel: a.entityLabel || "", summary: a.summary || "", changes: a.changes || [], ip: a.ip || null, location: a.location || null };
}
function actFromStore(id, d) {
  // normalize against any legacy/inconsistent field name a record may have been written with —
  // current code always WRITES under "location" (see actToStore), but old/foreign records may not.
  const loc = (d.location != null ? d.location : (d.__cpLocation != null ? d.__cpLocation : (d.locationName != null ? d.locationName : null)));
  return { id, ts: new Date(d.tsMs || nowMs()), userId: d.userId, userName: d.userName, action: d.action, entity: d.entity, entityId: d.entityId, entityLabel: d.entityLabel, summary: d.summary, changes: d.changes || [], ip: d.ip || null, location: loc };
}
function userPublic(id, d) {
  return { id, email: d.email, fullName: d.fullName, role: d.role, perms: d.perms || {}, activityScope: d.activityScope || "own", disabled: !!d.disabled, createdAtMs: d.createdAtMs || 0 };
}
const dayKey = (ms) => { const dt = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()); };
const monthKey = (ms) => { const dt = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return dt.getFullYear() + "-" + p(dt.getMonth() + 1); };

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
   FIREBASE ADAPTER  (Auth + Firestore + Cloud Functions)
   ===================================================================== */
async function makeFirebaseAdapter() {
  const appMod = await import(SDK + "firebase-app.js");
  const authMod = await import(SDK + "firebase-auth.js");
  const fs = await import(SDK + "firebase-firestore.js");
  const fnMod = await import(SDK + "firebase-functions.js");

  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  try { await authMod.setPersistence(auth, authMod.browserLocalPersistence); } catch (e) {}
  const functions = fnMod.getFunctions(app, FUNCTIONS_REGION);
  let db;
  try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
  catch (e) { db = fs.getFirestore(app); }

  const ref = (path) => fs.doc(db, ...path.split("/"));
  const call = (name) => fnMod.httpsCallable(functions, name);
  const buildConstraints = (opts) => {
    const c = [];
    (opts.where || []).forEach(([f, op, v]) => { if (op === ">=p") { c.push(fs.where(f, ">=", v)); c.push(fs.where(f, "<=", v + "\uf8ff")); } else c.push(fs.where(f, op, v)); });
    if (opts.orderBy) c.push(fs.orderBy(opts.orderBy[0] === "__name__" ? fs.documentId() : opts.orderBy[0], opts.orderBy[1] || "asc"));
    if (opts.startAfter != null) c.push(fs.startAfter(opts.startAfter));
    if (opts.limit) c.push(fs.limit(opts.limit + 1));
    return c;
  };

  return {
    mode: "firebase", _fs: fs, _db: db, _auth: auth, _authMod: authMod,

    /* ---- data primitives ---- */
    async get(path) { const s = await fs.getDoc(ref(path)); return s.exists() ? s.data() : null; },
    async set(path, data) { await fs.setDoc(ref(path), data); },
    async update(path, patch) { await fs.setDoc(ref(path), patch, { merge: true }); },
    async del(path) { await fs.deleteDoc(ref(path)); },
    async query(coll, opts) {
      opts = opts || {};
      const q = fs.query(fs.collection(db, coll), ...buildConstraints(opts));
      const snap = await fs.getDocs(q);
      let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      let hasMore = false;
      if (opts.limit && rows.length > opts.limit) { hasMore = true; rows = rows.slice(0, opts.limit); }
      return { rows, hasMore };
    },
    async txn(fn) {
      return fs.runTransaction(db, async (t) => {
        const api = {
          get: async (p) => { const s = await t.get(ref(p)); return s.exists() ? s.data() : null; },
          set: async (p, d) => { t.set(ref(p), d); },
          update: async (p, patch) => { t.set(ref(p), patch, { merge: true }); },
        };
        return fn(api);
      });
    },

    /* ---- Firebase Auth ---- */
    async _profileFor(user) {
      if (!user) return null;
      let snap = await fs.getDoc(ref("users/" + user.uid));
      if (!snap.exists()) {
        // self-bootstrap only for the known admin email
        if (lower(user.email) === ADMIN_EMAIL) {
          try { await call("bootstrapAdmin")({}); await user.getIdToken(true); snap = await fs.getDoc(ref("users/" + user.uid)); } catch (e) { console.warn("bootstrapAdmin failed", e); }
        }
        if (!snap.exists()) return { id: user.uid, email: user.email, fullName: user.email, role: "User", perms: {}, activityScope: "own", disabled: false, createdAtMs: 0, _noProfile: true };
      }
      return userPublic(user.uid, snap.data());
    },
    initAuth(cb) {
      return authMod.onAuthStateChanged(auth, async (user) => {
        if (!user) { cb(null); return; }
        const prof = await this._profileFor(user);
        if (prof && prof.disabled) { await authMod.signOut(auth); cb(null); return; }
        cb(prof);
      });
    },
    async bootstrap() { try { const r = await call("bootstrapAdmin")({}); if (auth.currentUser) await auth.currentUser.getIdToken(true); return r.data || { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
    async login(email, password) {
      try {
        const cred = await authMod.signInWithEmailAndPassword(auth, lower(email), password);
        const prof = await this._profileFor(cred.user);
        if (prof && prof.disabled) { await authMod.signOut(auth); return { ok: false, error: "Yeh account band kar diya gaya hai" }; }
        return { ok: true, user: prof };
      } catch (e) {
        const map = { "auth/invalid-credential": "Email ya password ghalat hai", "auth/wrong-password": "Password ghalat hai", "auth/user-not-found": "Is email se koi account nahi mila", "auth/invalid-email": "Email theek nahi", "auth/user-disabled": "Yeh account band kar diya gaya hai", "auth/too-many-requests": "Bohat zyada koshishein — thodi der baad try karein", "auth/network-request-failed": "Network problem — internet check karein" };
        return { ok: false, error: map[e.code] || ("Login nahi ho saka: " + (e.code || e.message)) };
      }
    },
    async logout() { await authMod.signOut(auth); },
    async listUsers() { const res = await this.query("users", { orderBy: ["createdAtMs", "asc"] }); return res.rows.map((r) => userPublic(r.id, r)); },
    async createUser(payload) { try { const r = await call("adminCreateUser")(payload); return { ok: true, id: r.data.uid }; } catch (e) { return { ok: false, error: friendlyFn(e) }; } },
    async updateUser(id, patch) { try { await call("adminUpdateUser")({ uid: id, ...patch }); return { ok: true }; } catch (e) { return { ok: false, error: friendlyFn(e) }; } },
    async setPassword(id, password) { try { await call("adminSetPassword")({ uid: id, password }); return { ok: true }; } catch (e) { return { ok: false, error: friendlyFn(e) }; } },
    async setDisabled(id, disabled) { try { await call("adminSetDisabled")({ uid: id, disabled: !!disabled }); return { ok: true }; } catch (e) { return { ok: false, error: friendlyFn(e) }; } },
    async deleteUser(id) { try { await call("adminDeleteUser")({ uid: id }); return { ok: true }; } catch (e) { return { ok: false, error: friendlyFn(e) }; } },
    async getClientGeo() { try { const r = await call("getClientGeo")({}); return r.data || null; } catch (e) { return null; } },
  };
}
function friendlyFn(e) {
  if (e && e.message) return e.message;
  return "Operation nahi ho saka";
}

/* =====================================================================
   HIGH-LEVEL DB FACADE — shared business logic over either adapter
   ===================================================================== */
function makeDB(A) {
  const derive = (b) => {
    const sub = (b.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
    const disc = Math.max(0, Math.min(sub, Number(b.discount) || 0));
    const total = sub - disc;
    const paid = (b.history || []).reduce((s, h) => s + (Number(h.amount) || 0), 0);
    const pending = Math.max(0, total - paid);
    const status = pending <= 0 && total > 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
    return { sub, disc, total, paid, pending, status };
  };

  // Firestore transactions require ALL reads before ANY writes. These helpers split a stats
  // update into a read phase (call first, while only reads have happened) and a write phase
  // (call after — once every read in the transaction is done).
  function statsBuckets(oldStore, newStore) {
    const buckets = {};
    const add = (key, fld, v) => { buckets[key] = buckets[key] || {}; buckets[key][fld] = (buckets[key][fld] || 0) + v; };
    const counts = (s) => s && !s.deleted;
    if (counts(oldStore)) { ["d:" + dayKey(oldStore.tsMs), "m:" + monthKey(oldStore.tsMs)].forEach((k) => { add(k, "billed", -oldStore.total); add(k, "paid", -oldStore.paid); add(k, "pending", -oldStore.pending); add(k, "count", -1); }); }
    if (counts(newStore)) { ["d:" + dayKey(newStore.tsMs), "m:" + monthKey(newStore.tsMs)].forEach((k) => { add(k, "billed", newStore.total); add(k, "paid", newStore.paid); add(k, "pending", newStore.pending); add(k, "count", 1); }); }
    return buckets;
  }
  function statsPath(key) { return (key[0] === "d" ? "stats/" : "stats_m/") + key.slice(2); }
  async function readStats(api, buckets) {
    const cur = {};
    for (const key of Object.keys(buckets)) { const path = statsPath(key); cur[path] = (await api.get(path)) || { billed: 0, paid: 0, pending: 0, count: 0 }; }
    return cur;
  }
  async function writeStats(api, buckets, cur) {
    for (const key of Object.keys(buckets)) {
      const path = statsPath(key); const c = cur[path]; const b = buckets[key];
      await api.set(path, { billed: (c.billed || 0) + (b.billed || 0), paid: (c.paid || 0) + (b.paid || 0), pending: (c.pending || 0) + (b.pending || 0), count: (c.count || 0) + (b.count || 0) });
    }
  }

  async function ensureProducts(names) {
    if (!names || !names.length) return;
    for (const nm of names) {
      if (!nm || !nm.trim()) continue;
      const id = "p_" + (await sha256Hex(lower(nm))).slice(0, 16);
      const existing = await A.get("products/" + id);
      if (!existing) await A.set("products/" + id, { name: nm.trim(), nameLower: lower(nm), count: 1, createdAtMs: nowMs() });
    }
  }

  return {
    mode: A.mode,
    derive,
    raw: A,

    /* ---------- auth passthrough ---------- */
    initAuth: (cb) => A.initAuth(cb),
    bootstrap: (seed) => A.bootstrap(seed),
    login: (email, pw) => A.login(email, pw),
    logout: () => A.logout(),
    listUsers: () => A.listUsers(),
    createUser: (p) => A.createUser(p),
    updateUser: (id, patch) => A.updateUser(id, patch),
    setPassword: (id, pw) => A.setPassword(id, pw),
    setDisabled: (id, d) => A.setDisabled(id, d),
    deleteUser: (id) => A.deleteUser(id),
    getClientGeo: () => A.getClientGeo(),

    /* ---------- settings ---------- */
    async getSettings() { return (await A.get("app/settings")) || null; },
    async saveSettings(s) { await A.set("app/settings", s); },

    /* ---------- counter (atomic bill number) ---------- */
    async peekCounter() { const c = await A.get("app/counter"); return c ? c.value : null; },
    async initCounter(start) { const c = await A.get("app/counter"); if (!c) await A.set("app/counter", { value: Number(start) || 1000 }); },
    // Only RAISES the counter when the new starting number is ahead of where billing already is —
    // never rewinds it (so existing bill numbers are never reused). No-op if newStart <= current.
    async bumpCounterIfHigher(newStart) {
      const ns = Number(newStart) || 0; if (ns <= 0) return;
      await A.txn(async (t) => {
        const c = (await t.get("app/counter")) || { value: 1000 };
        if (ns > (c.value || 0)) await t.set("app/counter", { value: ns });
      });
    },

    /* ---------- bills ---------- */
    async loadBillsPage({ mode, batch, startAfter }) {
      let where, orderBy, cursorField = "tsMs";
      if (mode === "bin") { where = [["deleted", "==", true]]; orderBy = ["deletedAtMs", "desc"]; cursorField = "deletedAtMs"; }
      else if (mode === "archived") { where = [["deleted", "==", false], ["archived", "==", true]]; orderBy = ["tsMs", "desc"]; }
      else { where = [["deleted", "==", false], ["archived", "==", false]]; orderBy = ["tsMs", "desc"]; }
      const { rows, hasMore } = await A.query("bills", { where, orderBy, limit: batch, startAfter });
      return { bills: rows.map((r) => billFromStore(r.id, r)), cursor: rows.length ? rows[rows.length - 1][cursorField] : null, hasMore };
    },
    async loadPendingPage({ batch, startAfter }) {
      // outstanding bills (pending > 0), biggest first — index: deleted ASC, pending DESC
      const { rows, hasMore } = await A.query("bills", { where: [["deleted", "==", false], ["pending", ">", 0]], orderBy: ["pending", "desc"], limit: batch, startAfter });
      return { bills: rows.map((r) => billFromStore(r.id, r)), cursor: rows.length ? rows[rows.length - 1].pending : null, hasMore };
    },
    async billsForDay(dayMs) {
      const start = new Date(dayMs); start.setHours(0, 0, 0, 0);
      const end = new Date(dayMs); end.setHours(23, 59, 59, 999);
      const { rows } = await A.query("bills", { where: [["deleted", "==", false], ["tsMs", ">=", start.getTime()], ["tsMs", "<=", end.getTime()]], orderBy: ["tsMs", "desc"], limit: 200 });
      return rows.map((r) => billFromStore(r.id, r));
    },
    async searchBills(q) {
      q = (q || "").trim(); if (!q) return [];
      const ql = lower(q), pc = phoneCore(q), cc = carCore(q);
      const queries = [A.query("bills", { where: [["deleted", "==", false], ["nameLower", ">=p", ql]], orderBy: ["nameLower", "asc"], limit: 25 }), A.query("bills", { where: [["deleted", "==", false], ["no", ">=p", q.toUpperCase()]], orderBy: ["no", "asc"], limit: 25 })];
      if (pc) queries.push(A.query("bills", { where: [["deleted", "==", false], ["phoneCore", ">=p", pc]], orderBy: ["phoneCore", "asc"], limit: 25 }));
      if (cc) queries.push(A.query("bills", { where: [["deleted", "==", false], ["carCore", ">=p", cc]], orderBy: ["carCore", "asc"], limit: 25 }));
      const results = await Promise.allSettled(queries);
      const seen = {}, out = [];
      results.forEach((r) => { if (r.status === "fulfilled") r.value.rows.forEach((row) => { if (!seen[row.id]) { seen[row.id] = 1; out.push(billFromStore(row.id, row)); } }); });
      out.sort((a, b) => b.ts - a.ts);
      return out;
    },
    async getBill(id) { const d = await A.get("bills/" + id); return d ? billFromStore(id, d) : null; },
    async customerHistoryByPhone(phone, exId) {
      const pc = phoneCore(phone); if (!pc) return { count: 0 };
      const { rows } = await A.query("bills", { where: [["deleted", "==", false], ["phoneCore", "==", pc]], limit: 60 });
      return aggHistory(rows.filter((r) => r.id !== exId));
    },
    async customerHistoryByCar(car, exId) {
      const cc = carCore(car); if (!cc) return { count: 0 };
      const { rows } = await A.query("bills", { where: [["deleted", "==", false], ["carCore", "==", cc]], limit: 60 });
      const ms = rows.filter((r) => r.id !== exId);
      const agg = aggHistory(ms);
      if (agg.count) { const nums = [...new Set(ms.map((r) => phoneCore(r.phone)).filter(Boolean))]; agg.multiNum = nums.length > 1; }
      return agg;
    },
    async saveNewBill(bill) {
      const tmp = { ...bill };
      const result = await A.txn(async (t) => {
        // ---- READS (must all happen before any write in this transaction) ----
        const c = (await t.get("app/counter")) || { value: 1000 };
        const value = c.value;
        tmp.no = (bill.prefix || "MSA") + "-" + value;
        const id = bill.id || ("b_" + rid(""));
        const store = billToStore(tmp, derive);
        const buckets = statsBuckets(null, store);
        const cur = await readStats(t, buckets);
        // ---- WRITES ----
        await t.set("app/counter", { value: value + 1 });
        await t.set("bills/" + id, store);
        await writeStats(t, buckets, cur);
        return { id, store };
      });
      await ensureProducts((bill.lines || []).map((l) => l.name));
      return billFromStore(result.id, result.store);
    },
    async updateBill(id, bill, oldBill) {
      const oldStore = oldBill ? billToStore(oldBill, derive) : await A.get("bills/" + id);
      const store = billToStore(bill, derive);
      await A.txn(async (t) => {
        const buckets = statsBuckets(oldStore, store);
        const cur = await readStats(t, buckets);            // reads first
        await t.set("bills/" + id, store);                  // then writes
        await writeStats(t, buckets, cur);
      });
      await ensureProducts((bill.lines || []).map((l) => l.name));
      return billFromStore(id, store);
    },
    async _flagBill(id, oldBill, patch) {
      const oldStore = billToStore(oldBill, derive);
      const newStore = { ...oldStore, ...patch };
      await A.txn(async (t) => {
        const buckets = statsBuckets(oldStore, newStore);
        const cur = await readStats(t, buckets);            // reads first
        await t.set("bills/" + id, newStore);                // then writes
        await writeStats(t, buckets, cur);
      });
      return billFromStore(id, newStore);
    },
    archiveBill(id, oldBill, archived) { return this._flagBill(id, oldBill, { archived: !!archived }); },
    softDeleteBill(id, oldBill) { return this._flagBill(id, oldBill, { deleted: true, deletedAtMs: nowMs() }); },
    restoreBill(id, oldBill) { return this._flagBill(id, oldBill, { deleted: false, deletedAtMs: null }); },
    async permanentDelete(id) { await A.del("bills/" + id); return { ok: true }; },
    async addHistory(id, oldBill, entry) {
      const oldStore = billToStore(oldBill, derive);
      const newStore = billToStore({ ...oldBill, history: [...(oldBill.history || []), entry] }, derive);
      await A.txn(async (t) => {
        const buckets = statsBuckets(oldStore, newStore);
        const cur = await readStats(t, buckets);            // reads first
        await t.set("bills/" + id, newStore);                // then writes
        await writeStats(t, buckets, cur);
      });
      return billFromStore(id, newStore);
    },

    /* ---------- products ---------- */
    async listProducts() { const res = await A.query("products", { orderBy: ["nameLower", "asc"] }); return res.rows.map((r) => ({ name: r.name, count: r.count || 0 })); },
    async deleteProduct(name) { const id = "p_" + (await sha256Hex(lower(name))).slice(0, 16); await A.del("products/" + id); return { ok: true }; },

    /* ---------- activity ---------- */
    async logActivity(entry) { const id = "a_" + rid(""); await A.set("activity/" + id, actToStore(entry)); return id; },
    async loadActivityPage({ batch, startAfter }) {
      const { rows, hasMore } = await A.query("activity", { orderBy: ["tsMs", "desc"], limit: batch, startAfter });
      return { items: rows.map((r) => actFromStore(r.id, r)), cursor: rows.length ? rows[rows.length - 1].tsMs : null, hasMore };
    },

    /* ---------- stats (dashboard + reports — never scans bills) ---------- */
    async statsForDays(keys) { const out = {}; await Promise.all(keys.map(async (k) => { out[k] = (await A.get("stats/" + k)) || { billed: 0, paid: 0, pending: 0, count: 0 }; })); return out; },
    async statsForMonths(keys) { const out = {}; await Promise.all(keys.map(async (k) => { out[k] = (await A.get("stats_m/" + k)) || { billed: 0, paid: 0, pending: 0, count: 0 }; })); return out; },
    async allMonthStats() { const res = await A.query("stats_m", { orderBy: ["__name__", "asc"] }); const out = {}; res.rows.forEach((r) => { out[r.id] = r; }); return out; },
  };
}

/* =====================================================================
   SINGLETON
   ===================================================================== */
let _dbPromise = null;
export function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const mode = pickMode();
    if (mode === "firebase") {
      try {
        const adapter = await Promise.race([
          makeFirebaseAdapter(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("firebase-init-timeout")), 9000)),
        ]);
        return makeDB(adapter);
      } catch (e) {
        console.warn("[MSA] Firebase init failed, falling back to local:", e && e.message);
        return makeDB(makeLocalAdapter());
      }
    }
    return makeDB(makeLocalAdapter());
  })();
  return _dbPromise;
}

export { pickMode };
