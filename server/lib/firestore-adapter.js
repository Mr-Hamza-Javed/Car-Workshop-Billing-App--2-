/* =====================================================================
   Firestore storage adapter (Admin SDK) for the shared makeDB() core.
   Same interface as the browser's local adapter:
     get · set · update · del · query · txn
   The Admin SDK bypasses security rules — every permission check
   happens in the API routes before these are called.
   ===================================================================== */
import { FieldPath } from "firebase-admin/firestore";

export function makeFirestoreAdapter(db) {
  const ref = (p) => db.doc(p);
  const field = (f) => (f === "__name__" ? FieldPath.documentId() : f);

  function buildQuery(coll, opts) {
    let q = db.collection(coll);
    (opts.where || []).forEach(([f, op, v]) => {
      // ">=p" = prefix match (same convention as the client adapters)
      if (op === ">=p") q = q.where(field(f), ">=", v).where(field(f), "<=", v + "");
      else q = q.where(field(f), op, v);
    });
    if (opts.orderBy) q = q.orderBy(field(opts.orderBy[0]), opts.orderBy[1] || "asc");
    if (opts.startAfter != null) q = q.startAfter(opts.startAfter);
    if (opts.limit) q = q.limit(opts.limit + 1);   // +1 row tells us whether there is more
    return q;
  }

  return {
    mode: "server",
    async get(p) { const s = await ref(p).get(); return s.exists ? s.data() : null; },
    async set(p, data) { await ref(p).set(data); },
    async update(p, patch) { await ref(p).set(patch, { merge: true }); },
    async del(p) { await ref(p).delete(); },
    async query(coll, opts) {
      opts = opts || {};
      const snap = await buildQuery(coll, opts).get();
      let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      let hasMore = false;
      if (opts.limit && rows.length > opts.limit) { hasMore = true; rows = rows.slice(0, opts.limit); }
      return { rows, hasMore };
    },
    async txn(fn) {
      return db.runTransaction(async (t) => {
        const api = {
          get: async (p) => { const s = await t.get(ref(p)); return s.exists ? s.data() : null; },
          set: async (p, d) => { t.set(ref(p), d); },
          update: async (p, patch) => { t.set(ref(p), patch, { merge: true }); },
        };
        return fn(api);
      });
    },
  };
}
