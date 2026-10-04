/* =====================================================================
   MSA Billing — shared business logic  (db-core.js)
   ---------------------------------------------------------------------
   Pure, environment-neutral code shared by:
     • the Node API server  (server/)      — runs it over Firestore (Admin SDK)
     • the browser demo mode (firebase-db.js) — runs it over localStorage

   makeDB(A) takes a tiny storage adapter A with:
     get(path) · set(path, data) · update(path, patch) · del(path)
     query(coll, { where, orderBy, limit, startAfter }) → { rows, hasMore }
     txn(fn)   — fn receives { get, set, update } (all reads before writes)
   and returns the high-level data API (bills, products, stats, ...).

   Uses only globals available in BOTH modern browsers and Node 20+
   (crypto.subtle, TextEncoder) — no imports.
   ===================================================================== */

/* =====================================================================
   PERMISSIONS v2 — structured, per-category
   Har action: { on:bool, days:int (0 = sab din, warna last N din), scope:{ mode:'self'|'all'|'include'|'exclude', users:[uid] } }
   - days  : record ki DATE par lagta hai (bill ki date / activity ka waqt)
   - scope : kis ke banaye records par ijazat hai (apne records hamesha shamil)
   Reports ka sirf days hota hai (collective data), scope nahi.
   ===================================================================== */
export const SC_ALL = () => ({ mode: "all", users: [] });
export const PA = () => ({ on: true, days: 0, scope: SC_ALL() });
/* full permission set for a brand-new admin */
export const FULL_PERMS = {
  bills:    { view: PA(), create: PA(), edit: PA(), payments: PA(), archive: PA(), delete: PA() },
  recycle:  { view: PA(), restore: PA(), purge: PA() },
  reports:  { view: { on: true, days: 0 } },
  activity: { view: PA() },
  products: { delete: PA() },
  settings: { manage: PA() },
};

/* ---------- small utils ---------- */
export const nowMs = () => Date.now();
export const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
export const digits = (s) => String(s == null ? "" : s).replace(/[^\d]/g, "");
export const carCore = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
export const phoneCore = (s) => { let d = digits(s); d = d.replace(/^(0092|92)/, "").replace(/^0/, ""); return d; };
export const rid = (p) => (p || "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomSalt() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function hashPassword(pw, salt) { return sha256Hex(salt + "::" + pw); }

function aggHistory(rows) {
  if (!rows.length) return { count: 0 };
  let total = 0, pend = 0, pc = 0, last = 0;
  rows.forEach((r) => { total += r.total || 0; if ((r.pending || 0) > 0) { pend += r.pending; pc++; } if ((r.tsMs || 0) > last) last = r.tsMs; });
  return { count: rows.length, total, pending: pend, pendingCount: pc, last: new Date(last) };
}

/* ---------- app-shape <-> stored-doc conversion ---------- */
export function billToStore(b, derive) {
  const d = derive(b);
  return {
    no: b.no, name: b.name || "", nameLower: lower(b.name),
    phone: b.phone || "", phoneCore: phoneCore(b.phone),
    car: b.car || "", carCore: carCore(b.car), model: b.model || "",
    lines: (b.lines || []).map((l) => ({ name: l.name, qty: Number(l.qty) || 0, price: Number(l.price) || 0 })),
    discount: Number(b.discount) || 0, comment: b.comment || "", note: b.note || "",
    // Never let a corrupt/invalid Date become NaN here — a NaN timestamp would produce a
    // "NaN-NaN" aggregate key and poison the reports. Fall back to "now".
    tsMs: (function () { const d = (b.ts instanceof Date ? b.ts : new Date()); const t = d.getTime(); return Number.isFinite(t) ? t : Date.now(); })(),
    createdBy: b.createdBy || "", createdById: b.createdById || "",
    // creation time (device clock when the bill was first made) — distinct from tsMs (the
    // bill's DATE, which the user may backdate). Lists sort by this. Old docs lack it;
    // billFromStore falls back to tsMs so they still sort stably.
    createdAtMs: (b.createdAt instanceof Date && Number.isFinite(b.createdAt.getTime())) ? b.createdAt.getTime() : nowMs(),
    archived: !!b.archived, deleted: !!b.deleted,
    deletedAtMs: b.deletedAt instanceof Date ? b.deletedAt.getTime() : (b.deletedAtMs || null),
    history: (b.history || []).map((h) => ({ kind: h.kind, amount: Number(h.amount) || 0, comment: h.comment || "", tsMs: (h.ts instanceof Date ? h.ts : new Date()).getTime(), by: h.by || "" })),
    sub: d.sub, disc: d.disc, total: d.total, paid: d.paid, pending: d.pending, status: d.status,
  };
}
export function billFromStore(id, d) {
  return {
    id, no: d.no, name: d.name || "", phone: d.phone || "", car: d.car || "", model: d.model || "",
    lines: (d.lines || []).map((l) => ({ name: l.name, qty: Number(l.qty) || 0, price: Number(l.price) || 0 })),
    discount: Number(d.discount) || 0, comment: d.comment || "", note: d.note || "",
    ts: new Date(d.tsMs || nowMs()), createdBy: d.createdBy || "", createdById: d.createdById || "",
    createdAt: new Date(d.createdAtMs || d.tsMs || nowMs()),
    archived: !!d.archived, deleted: !!d.deleted,
    deletedAt: d.deletedAtMs ? new Date(d.deletedAtMs) : null,
    history: (d.history || []).map((h) => ({ kind: h.kind, amount: Number(h.amount) || 0, comment: h.comment || "", ts: new Date(h.tsMs || d.tsMs || nowMs()), by: h.by || "" })),
  };
}
export function actToStore(a) {
  return { tsMs: (a.ts instanceof Date ? a.ts : new Date()).getTime(), userId: a.userId || "", userName: a.userName || "", action: a.action || "", entity: a.entity || "", entityId: a.entityId || "", entityLabel: a.entityLabel || "", summary: a.summary || "", changes: a.changes || [], ip: a.ip || null, location: a.location || null };
}
export function actFromStore(id, d) {
  // normalize against any legacy/inconsistent field name a record may have been written with —
  // current code always WRITES under "location" (see actToStore), but old/foreign records may not.
  const loc = (d.location != null ? d.location : (d.__cpLocation != null ? d.__cpLocation : (d.locationName != null ? d.locationName : null)));
  return { id, ts: new Date(d.tsMs || nowMs()), userId: d.userId, userName: d.userName, action: d.action, entity: d.entity, entityId: d.entityId, entityLabel: d.entityLabel, summary: d.summary, changes: d.changes || [], ip: d.ip || null, location: loc };
}
export function userPublic(id, d) {
  return { id, email: d.email, fullName: d.fullName, role: d.role, perms: d.perms || {}, activityScope: d.activityScope || "own", disabled: !!d.disabled, createdAtMs: d.createdAtMs || 0 };
}
export const dayKey = (ms) => { const dt = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()); };
export const monthKey = (ms) => { const dt = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return dt.getFullYear() + "-" + p(dt.getMonth() + 1); };


/* =====================================================================
   JSON over the wire — Date-preserving encode/decode
   Dates travel as { "$date": <ms> } so app-shaped objects (bill.ts,
   history[].ts, ...) survive the API round-trip as real Date objects.
   ===================================================================== */
export function encodeJSON(value) {
  return JSON.stringify(value, function (key, v) {
    const raw = this[key];
    if (raw instanceof Date) return { $date: raw.getTime() };
    return v;
  });
}
export function decodeJSON(text) {
  return JSON.parse(text, (key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.$date === "number" && Object.keys(v).length === 1) return new Date(v.$date);
    return v;
  });
}
/* revive an already-parsed object (e.g. express.json() output) */
export function reviveDates(v) {
  if (Array.isArray(v)) return v.map(reviveDates);
  if (v && typeof v === "object") {
    if (typeof v.$date === "number" && Object.keys(v).length === 1) return new Date(v.$date);
    const out = {};
    for (const k of Object.keys(v)) out[k] = reviveDates(v[k]);
    return out;
  }
  return v;
}

/* =====================================================================
   HIGH-LEVEL DB FACADE — shared business logic over either adapter
   ===================================================================== */
export function makeDB(A) {
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
    // a bill only contributes to stats when it exists, isn't deleted, AND has a valid timestamp
    const counts = (s) => s && !s.deleted && Number.isFinite(Number(s.tsMs)) && Number(s.tsMs) > 0;
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
      const v = {
        billed: (c.billed || 0) + (b.billed || 0),
        paid: (c.paid || 0) + (b.paid || 0),
        pending: (c.pending || 0) + (b.pending || 0),
        count: (c.count || 0) + (b.count || 0),
      };
      // Safety floor: incremental drift or an unexpected race must NEVER surface as a negative
      // total or count in a report. The exact true values are always restored by recomputeStats().
      if (v.billed < 0) v.billed = 0;
      if (v.paid < 0) v.paid = 0;
      if (v.pending < 0) v.pending = 0;
      if (v.count < 0) v.count = 0;
      await api.set(path, v);
    }
  }

  async function ensureProducts(names) {
    if (!names || !names.length) return;
    // Ensure every line-item name exists in the products catalog. Names are independent, so
    // run them in parallel instead of one sequential round-trip each. This only feeds the
    // New Bill autocomplete — it is never part of the bill-save transaction (callers run it
    // AFTER the bill is already committed), so nothing here affects whether a bill is saved.
    await Promise.all(names.map(async (nm) => {
      if (!nm || !nm.trim()) return;
      const id = "p_" + (await sha256Hex(lower(nm))).slice(0, 16);
      const existing = await A.get("products/" + id);
      if (!existing) await A.set("products/" + id, { name: nm.trim(), nameLower: lower(nm), count: 1, createdAtMs: nowMs() });
    }));
  }

  return {
    mode: A.mode,
    derive,
    raw: A,

    /* ---------- settings ---------- */
    async getSettings() { return (await A.get("app/settings")) || null; },
    async saveSettings(s) { await A.set("app/settings", s); },
    /* ---------- note templates (printed Comment + Internal note) ----------
       Kept in their OWN doc (app/noteTemplates), NOT app/settings, so anyone
       who can create a bill may add/edit/delete them without the settings
       permission. Shape: { comment:[{id,name,md}], note:[{id,name,md}] }. */
    async getNoteTemplates() { return (await A.get("app/noteTemplates")) || null; },
    async saveNoteTemplates(d) { await A.set("app/noteTemplates", d); },
    /* ---------- print presets (named full print-appearance bundles) ----------
       Own doc (app/printPresets), shop-wide + synced. Read by any known user (so the
       print dialog can list & apply them); writes gated to the settings permission by
       the existing app/{doc} rule (preset CRUD lives on the settings-gated Template page).
       Shape: { presets:[{id,name,cfg}], activeId }. */
    async getPrintPresets() { return (await A.get("app/printPresets")) || null; },
    async savePrintPresets(d) { await A.set("app/printPresets", d); },
    async getAccessStatus() { return A.getAccessStatus(); },

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
      try {
        const { rows } = await A.query("bills", { where: [["deleted", "==", false], ["tsMs", ">=", start.getTime()], ["tsMs", "<=", end.getTime()]], orderBy: ["tsMs", "desc"], limit: 200 });
        return rows.map((r) => billFromStore(r.id, r));
      } catch (e) {
        // composite index (deleted, tsMs DESC) not deployed — fall back to the single-field
        // tsMs range (needs no composite index) and filter deleted in code. Day reports must
        // NEVER break because of a missing index.
        const { rows } = await A.query("bills", { where: [["tsMs", ">=", start.getTime()], ["tsMs", "<=", end.getTime()]], orderBy: ["tsMs", "desc"], limit: 250 });
        return rows.filter((r) => !r.deleted).map((r) => billFromStore(r.id, r));
      }
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
      // Bill is already committed above. Building the products catalog is a best-effort
      // background side-effect — do not block the caller (or fail the save) on it.
      ensureProducts((bill.lines || []).map((l) => l.name)).catch((e) => { try { console.warn("ensureProducts", e); } catch (_) {} });
      return billFromStore(result.id, result.store);
    },
    async updateBill(id, bill, oldBill) {
      let store;
      await A.txn(async (t) => {
        // AUTHORITATIVE baseline = the CURRENT stored doc, read inside the transaction — never
        // the app's possibly-stale copy.
        const current = await t.get("bills/" + id);
        // SAFEGUARD: a permanently deleted bill can NEVER be resurrected by an edit. Without
        // this, editing a stale copy re-created the doc while its stats contribution was long
        // gone — corrupting reports (only the edit's delta ever got counted).
        if (!current) { const err = new Error("Yeh bill permanently delete ho chuka hai - update mumkin nahi"); err.userMessage = err.message; throw err; }
        const curHistApp = Array.isArray(current.history)
          ? current.history.map((h) => ({ kind: h.kind, amount: Number(h.amount) || 0, comment: h.comment || "", ts: new Date(h.tsMs || nowMs()), by: h.by || "" }))
          : [];
        // the editor only ever APPENDS payments on top of what it loaded (oldBill.history);
        // carry those appended entries over onto the authoritative history so none are lost.
        const oldLen = (oldBill && Array.isArray(oldBill.history)) ? oldBill.history.length : 0;
        const editAppended = oldBill ? (bill.history || []).slice(oldLen) : [];
        const mergedHistory = [...curHistApp, ...editAppended];
        store = billToStore({ ...bill, history: mergedHistory }, derive);
        if (current.createdAtMs) store.createdAtMs = current.createdAtMs;   // creation time never changes on edit
        const buckets = statsBuckets(current, store);
        const cur = await readStats(t, buckets);            // all reads before any write
        await t.set("bills/" + id, store);
        await writeStats(t, buckets, cur);
      });
      // Bill is already committed above. Building the products catalog is a best-effort
      // background side-effect — do not block the caller (or fail the save) on it.
      ensureProducts((bill.lines || []).map((l) => l.name)).catch((e) => { try { console.warn("ensureProducts", e); } catch (_) {} });
      return billFromStore(id, store);
    },
    async _flagBill(id, oldBill, patch) {
      let newStore;
      await A.txn(async (t) => {
        // flip flags on the AUTHORITATIVE current doc. SAFEGUARD: if the doc no longer exists
        // (permanently deleted), refuse — archiving/restoring a stale copy used to re-create
        // the bill with no stats contribution, silently corrupting reports.
        const current = await t.get("bills/" + id);
        if (!current) { const err = new Error("Yeh bill permanently delete ho chuka hai - action mumkin nahi"); err.userMessage = err.message; throw err; }
        newStore = { ...current, ...patch };
        const buckets = statsBuckets(current, newStore);
        const cur = await readStats(t, buckets);            // reads first
        await t.set("bills/" + id, newStore);                // then writes
        await writeStats(t, buckets, cur);
      });
      return billFromStore(id, newStore);
    },
    archiveBill(id, oldBill, archived) { return this._flagBill(id, oldBill, { archived: !!archived }); },
    softDeleteBill(id, oldBill) { return this._flagBill(id, oldBill, { deleted: true, deletedAtMs: nowMs() }); },
    restoreBill(id, oldBill) { return this._flagBill(id, oldBill, { deleted: false, deletedAtMs: null }); },
    async permanentDelete(id) {
      // Bills reach here from the Recycle bin, so they're already soft-deleted and no longer
      // counted in stats. Guard the rare case of hard-deleting a still-active bill: strip its
      // stats contribution first so no phantom totals are ever left behind.
      const current = await A.get("bills/" + id);
      if (current && !current.deleted) {
        await A.txn(async (t) => {
          const c = await t.get("bills/" + id);
          if (c && !c.deleted) {
            const buckets = statsBuckets(c, null);
            const cur = await readStats(t, buckets);
            await writeStats(t, buckets, cur);
          }
        });
      }
      await A.del("bills/" + id);
      return { ok: true };
    },
    async addHistory(id, oldBill, entry) {
      let newStore;
      const entryStore = { kind: entry.kind, amount: Number(entry.amount) || 0, comment: entry.comment || "", tsMs: (entry.ts instanceof Date ? entry.ts : new Date()).getTime(), by: entry.by || "" };
      await A.txn(async (t) => {
        // Append to the AUTHORITATIVE stored history. SAFEGUARD: never add a payment to a
        // permanently deleted bill (would resurrect it and corrupt stats).
        const current = await t.get("bills/" + id);
        if (!current) { const err = new Error("Yeh bill permanently delete ho chuka hai - payment mumkin nahi"); err.userMessage = err.message; throw err; }
        const newHist = [...((current.history) || []), entryStore];
        const sub = (current.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
        const disc = Math.max(0, Math.min(sub, Number(current.discount) || 0));
        const total = sub - disc;
        const paid = newHist.reduce((s, h) => s + (Number(h.amount) || 0), 0);
        const pending = Math.max(0, total - paid);
        const status = pending <= 0 && total > 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
        newStore = { ...current, history: newHist, sub, disc, total, paid, pending, status };
        const buckets = statsBuckets(current, newStore);
        const cur = await readStats(t, buckets);            // reads first
        await t.set("bills/" + id, newStore);                // then writes
        await writeStats(t, buckets, cur);
      });
      return billFromStore(id, newStore);
    },

    /* ---------- products ---------- */
    // Autocomplete pool: at most `limit` products, ordered most-used first (count desc) and then
    // newest-first among equal counts — so a big block of once-used products surfaces the newest
    // ones. A compound orderBy (count desc, createdAtMs desc) would need a composite index, so we
    // instead run two index-free single-field queries and merge client-side:
    //   A = products used more than once (few), ordered by count then newest
    //   B = newest products overall — fills the rest after A, up to `limit`.
    async listProducts(limit) {
      limit = limit || 200;
      const [aRes, bRes] = await Promise.all([
        A.query("products", { where: [["count", ">", 1]], orderBy: ["count", "desc"], limit }),
        A.query("products", { orderBy: ["createdAtMs", "desc"], limit }),
      ]);
      const aSorted = aRes.rows.slice().sort((x, y) => (y.count || 0) - (x.count || 0) || (y.createdAtMs || 0) - (x.createdAtMs || 0));
      const seen = {}, out = [];
      const push = (r) => { if (!seen[r.id] && out.length < limit) { seen[r.id] = 1; out.push({ name: r.name, count: r.count || 0, createdAtMs: r.createdAtMs || 0 }); } };
      aSorted.forEach(push);
      bRes.rows.forEach(push);
      return out;
    },
    // Products page: newest-first, cursor-paginated (infinite scroll). createdAtMs desc — single
    // field, needs no composite index; cursor is the last row's createdAtMs (like loadBillsPage).
    async loadProductsPage({ batch, startAfter }) {
      const { rows, hasMore } = await A.query("products", { orderBy: ["createdAtMs", "desc"], limit: batch, startAfter });
      return { products: rows.map((r) => ({ name: r.name, count: r.count || 0, createdAtMs: r.createdAtMs || 0 })), cursor: rows.length ? rows[rows.length - 1].createdAtMs : null, hasMore };
    },
    async deleteProduct(name) { const id = "p_" + (await sha256Hex(lower(name))).slice(0, 16); await A.del("products/" + id); return { ok: true }; },

    /* ---------- activity ---------- */
    async logActivity(entry) { const id = "a_" + rid(""); await A.set("activity/" + id, actToStore(entry)); return id; },
    async loadActivityPage({ batch, startAfter }) {
      const { rows, hasMore } = await A.query("activity", { orderBy: ["tsMs", "desc"], limit: batch, startAfter });
      return { items: rows.map((r) => actFromStore(r.id, r)), cursor: rows.length ? rows[rows.length - 1].tsMs : null, hasMore };
    },
    // Activity for ONE bill (the bill-log modal). Single equality filter => needs NO composite
    // index and reads only this bill's handful of entries (cheap) — so the log works even when
    // the Activity tab was never opened, and never scans the whole activity collection.
    async billActivity(billId) {
      const { rows } = await A.query("activity", { where: [["entityId", "==", billId]], limit: 300 });
      return rows.map((r) => actFromStore(r.id, r));
    },

    /* ---------- stats (dashboard + reports — never scans bills) ---------- */
    async statsForDays(keys) { const out = {}; await Promise.all(keys.map(async (k) => { out[k] = (await A.get("stats/" + k)) || { billed: 0, paid: 0, pending: 0, count: 0 }; })); return out; },
    async statsForMonths(keys) { const out = {}; await Promise.all(keys.map(async (k) => { out[k] = (await A.get("stats_m/" + k)) || { billed: 0, paid: 0, pending: 0, count: 0 }; })); return out; },
    async allMonthStats() { const res = await A.query("stats_m", { orderBy: ["__name__", "asc"] }); const out = {}; res.rows.forEach((r) => { out[r.id] = r; }); return out; },

    /* ---------- reconciliation / self-heal safeguards ----------
       The aggregates above are maintained incrementally for cheap reads. These two methods are
       the safety net that guarantees they can never stay wrong. */

    // FULL REPAIR — rebuild every day + month aggregate from the actual (non-deleted) bills.
    // The one guaranteed source of truth; a deliberate action (costs reads) that leaves reports
    // provably correct no matter what drift, missed update or legacy data existed before.
    async recomputeStats(onProgress) {
      const days = {}, months = {};
      const blank = () => ({ billed: 0, paid: 0, pending: 0, count: 0 });
      const bump = (map, key, d) => { const m = map[key] || (map[key] = blank()); m.billed += d.total; m.paid += d.paid; m.pending += d.pending; m.count += 1; };
      let startAfter = null, scanned = 0, guard = 0;
      while (guard++ < 5000) {
        // Paginate by document name with a single equality filter — needs NO composite index,
        // so the full repair can never fail with "query requires an index" (which is exactly
        // what happened when the (deleted, tsMs) index wasn't deployed).
        const { rows, hasMore } = await A.query("bills", { where: [["deleted", "==", false]], orderBy: ["__name__", "asc"], limit: 400, startAfter });
        if (!rows.length) break;
        for (const r of rows) {
          const ts = Number(r.tsMs); if (!Number.isFinite(ts) || ts <= 0) continue;   // skip corrupt timestamps
          const d = derive(billFromStore(r.id, r));
          bump(days, dayKey(ts), d); bump(months, monthKey(ts), d);
        }
        scanned += rows.length;
        if (onProgress) { try { onProgress(scanned); } catch (e) {} }
        if (!hasMore) break;
        startAfter = rows[rows.length - 1].id;
      }
      // Write fresh totals, and ZERO any existing aggregate doc that no longer has bills
      // (e.g. every bill in a day was deleted/moved) so stale numbers can't linger.
      const [exD, exM] = await Promise.all([
        A.query("stats", { orderBy: ["__name__", "asc"] }).catch(() => ({ rows: [] })),
        A.query("stats_m", { orderBy: ["__name__", "asc"] }).catch(() => ({ rows: [] })),
      ]);
      for (const k of Object.keys(days)) await A.set("stats/" + k, days[k]);
      for (const k of Object.keys(months)) await A.set("stats_m/" + k, months[k]);
      for (const r of exD.rows) if (!days[r.id]) await A.set("stats/" + r.id, blank());
      for (const r of exM.rows) if (!months[r.id]) await A.set("stats_m/" + r.id, blank());
      return { scanned, days: Object.keys(days).length, months: Object.keys(months).length };
    },

    // CHEAP SELF-HEAL — correct ONE day's aggregates (its day doc + rolling the delta into its
    // month doc) to match the real bills the app just read for that day's report. No-op when
    // already consistent, so simply opening a day report quietly keeps that day accurate.
    async reconcileDay(dayMs, truth) {
      const k = dayKey(dayMs), mk = monthKey(dayMs);
      const fields = ["billed", "paid", "pending", "count"];
      const cur = (await A.get("stats/" + k)) || { billed: 0, paid: 0, pending: 0, count: 0 };
      const same = fields.every((f) => Math.abs((cur[f] || 0) - (truth[f] || 0)) < 0.5);
      if (same) return { fixed: false };
      await A.txn(async (t) => {
        const dCur = (await t.get("stats/" + k)) || { billed: 0, paid: 0, pending: 0, count: 0 };
        const mCur = (await t.get("stats_m/" + mk)) || { billed: 0, paid: 0, pending: 0, count: 0 };
        const dv = {}, mv = {};
        fields.forEach((f) => { const delta = (truth[f] || 0) - (dCur[f] || 0); dv[f] = Math.max(0, truth[f] || 0); mv[f] = Math.max(0, (mCur[f] || 0) + delta); });
        await t.set("stats/" + k, dv);
        await t.set("stats_m/" + mk, mv);
      });
      return { fixed: true };
    },
  };
}
