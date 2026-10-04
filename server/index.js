/* =====================================================================
   MSA Billing — Node.js API server
   ---------------------------------------------------------------------
   The ONLY component that reads/writes Firestore. The web app never
   talks to Firestore directly any more — it calls this REST API.

   Login stays in the web app (Firebase Authentication). Every request
   carries the user's Firebase ID token (Authorization: Bearer <token>);
   the server verifies it and enforces permissions before touching data.

   Business logic (bill numbering, stats aggregates, transactions ...) is
   the SAME shared code the browser demo mode uses — ../db-core.js.

   Responses are JSON; Date values travel as { "$date": <ms> }.
   ===================================================================== */
import { PORT, SERVE_STATIC, ALLOWED_ORIGINS, WEB_ROOT, firestore } from "./lib/config.js";
import path from "node:path";
import express from "express";
import cors from "cors";
import compression from "compression";
import { makeDB, encodeJSON, reviveDates, userPublic } from "../db-core.js";
import { makeFirestoreAdapter } from "./lib/firestore-adapter.js";
import { authenticate, requireKnownUser, requirePerm, requireAdmin, badRequest, notFound, loadProfile } from "./lib/auth.js";
import * as users from "./lib/users.js";
import * as recalc from "./lib/recalc.js";
import { isFirebaseOutage } from "./lib/firebase-errors.js";

const core = makeDB(makeFirestoreAdapter(firestore));
const app = express();
app.set("trust proxy", true);   // real client IP behind Render/Railway/nginx (for the activity-log geo)
app.disable("x-powered-by");

/* ---------- helpers ---------- */
const send = (res, data) => { res.type("application/json").send(encodeJSON(data === undefined ? null : data)); };
const body = (req) => reviveDates(req.body || {});
/* cursor values (numbers or ids) travel JSON-encoded in ?startAfter= */
const cursor = (req) => {
  const v = req.query.startAfter;
  if (v == null || v === "") return null;
  try { return JSON.parse(v); } catch (e) { throw badRequest("startAfter ghalat hai"); }
};
const batchOf = (req, def = 30) => Math.max(1, Math.min(500, Number(req.query.batch) || def));

/* bill + stats permissions — mirror of the old Firestore rules, but enforced per action */
const P = {
  read: requireKnownUser,
  billCreate: requirePerm(["bills", "create"]),
  billEdit: requirePerm(["bills", "edit"]),
  billArchive: requirePerm(["bills", "archive"]),
  billDelete: requirePerm(["bills", "delete"]),
  billPayment: requirePerm(["bills", "payments"]),
  billRestore: requirePerm(["recycle", "restore"]),
  billPurge: requirePerm(["recycle", "purge"]),
  settings: requirePerm(["settings", "manage"]),
  counter: requirePerm(["bills", "create"], ["settings", "manage"]),
  productDelete: requirePerm(["products", "delete"]),
  statsWrite: requirePerm(["bills", "create"], ["bills", "edit"], ["bills", "delete"], ["bills", "archive"], ["bills", "payments"], ["recycle", "restore"]),
};

/* ---------- CORS + body parsing ---------- */
const allowAll = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes("*");
app.use("/api", cors({
  origin: allowAll ? true : ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400,
}));
app.use("/api", express.json({ limit: "10mb" }));
app.use(compression());   // gzip — the full bills / activity downloads shrink a lot   // settings may carry a base64 logo

/* =====================================================================
   PUBLIC
   ===================================================================== */
app.get("/api/health", (req, res) => send(res, { ok: true, time: Date.now() }));
// Firebase status — public, checked by the app before login. One tiny Firestore read: if Firebase
// fails (quota exhausted, outage, billing, credentials) the error handler answers 503
// firebase-unavailable and the app shows its fixed "service unavailable" page.
app.get("/api/status", async (req, res) => {
  // a dead/unreachable Firestore can make the SDK retry for ~40s — answer within 10s instead
  const deadline = new Promise((_, rej) => setTimeout(() => { const e = new Error("Firestore status check timed out"); e.code = 4; rej(e); }, 10000).unref());
  await Promise.race([firestore.doc("app/status").get(), deadline]);
  send(res, { ok: true });
});

/* =====================================================================
   AUTHENTICATED (valid Firebase ID token)
   ===================================================================== */
const api = express.Router();
api.use(authenticate);

// caller's profile. The primary admin's profile is created on first login (old bootstrapAdmin).
api.get("/me", async (req, res) => {
  const u = req.user;
  let prof = u.profile;
  if (!prof && u.isPrimary) { await users.bootstrapAdmin(u); prof = await loadProfile(u.uid, { fresh: true }); }
  send(res, { profile: prof ? userPublic(u.uid, prof) : null });
});
api.post("/bootstrap", async (req, res) => send(res, await users.bootstrapAdmin(req.user)));

// IP + city/region/country for the activity log — from the real connecting IP
api.get("/geo", P.read, async (req, res) => {
  let ip = String(req.ip || "").split(",")[0].trim().replace(/^::ffff:/, "");
  if (!ip || ip === "::1" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.")) return send(res, { ip: ip || null, location: null });
  try {
    const r = await fetch("http://ip-api.com/json/" + encodeURIComponent(ip) + "?fields=status,city,regionName,country", { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    if (d && d.status === "success") {
      const parts = [d.city, d.regionName].filter(Boolean).join(", ");
      return send(res, { ip, location: [parts, d.country].filter(Boolean).join(" · ") || null });
    }
  } catch (e) { /* best-effort */ }
  send(res, { ip, location: null });
});

/* ---------- app docs: settings / note templates / print presets / counter ---------- */
api.get("/settings", P.read, async (req, res) => send(res, await core.getSettings()));
api.put("/settings", P.read, P.settings, async (req, res) => { await core.saveSettings(body(req)); send(res, { ok: true }); });
api.get("/note-templates", P.read, async (req, res) => send(res, await core.getNoteTemplates()));
api.put("/note-templates", P.read, P.billCreate, async (req, res) => { await core.saveNoteTemplates(body(req)); send(res, { ok: true }); });
api.get("/print-presets", P.read, async (req, res) => send(res, await core.getPrintPresets()));
api.put("/print-presets", P.read, P.settings, async (req, res) => { await core.savePrintPresets(body(req)); send(res, { ok: true }); });
api.get("/counter", P.read, async (req, res) => send(res, { value: await core.peekCounter() }));
api.post("/counter/init", P.read, P.counter, async (req, res) => { await core.initCounter(body(req).start); send(res, { ok: true }); });
api.post("/counter/bump", P.read, P.counter, async (req, res) => { await core.bumpCounterIfHigher(body(req).start); send(res, { ok: true }); });

/* ---------- bills ---------- */
api.get("/bills", P.read, async (req, res) => {
  const mode = ["bin", "archived"].includes(req.query.mode) ? req.query.mode : "active";
  send(res, await core.loadBillsPage({ mode, batch: batchOf(req), startAfter: cursor(req) }));
});
api.get("/bills/pending", P.read, async (req, res) => send(res, await core.loadPendingPage({ batch: batchOf(req), startAfter: cursor(req) })));
api.get("/bills/day", P.read, async (req, res) => {
  const dayMs = Number(req.query.dayMs);
  if (!Number.isFinite(dayMs)) throw badRequest("dayMs chahiye");
  send(res, await core.billsForDay(dayMs));
});
api.get("/bills/all", P.read, async (req, res) => send(res, await core.loadAllBills()));
api.get("/bills/search", P.read, async (req, res) => send(res, await core.searchBills(String(req.query.q || ""))));
api.get("/customers/history", P.read, async (req, res) => {
  const exId = req.query.exId ? String(req.query.exId) : undefined;
  if (req.query.phone != null) return send(res, await core.customerHistoryByPhone(String(req.query.phone), exId));
  if (req.query.car != null) return send(res, await core.customerHistoryByCar(String(req.query.car), exId));
  throw badRequest("phone ya car chahiye");
});
api.get("/bills/:id", P.read, async (req, res) => {
  const b = await core.getBill(req.params.id);
  if (!b) throw notFound("Bill nahi mila");
  send(res, b);
});
api.post("/bills", P.read, P.billCreate, async (req, res) => send(res, await core.saveNewBill(body(req).bill)));
api.put("/bills/:id", P.read, P.billEdit, async (req, res) => { const b = body(req); send(res, await core.updateBill(req.params.id, b.bill, b.oldBill)); });
api.post("/bills/:id/archive", P.read, P.billArchive, async (req, res) => send(res, await core.archiveBill(req.params.id, null, !!body(req).archived)));
api.post("/bills/:id/soft-delete", P.read, P.billDelete, async (req, res) => send(res, await core.softDeleteBill(req.params.id, null)));
api.post("/bills/:id/restore", P.read, P.billRestore, async (req, res) => send(res, await core.restoreBill(req.params.id, null)));
api.delete("/bills/:id", P.read, P.billPurge, async (req, res) => send(res, await core.permanentDelete(req.params.id)));
api.post("/bills/:id/history", P.read, P.billPayment, async (req, res) => send(res, await core.addHistory(req.params.id, null, body(req).entry || {})));
api.get("/bills/:id/activity", P.read, async (req, res) => send(res, await core.billActivity(req.params.id)));

/* ---------- products ---------- */
api.get("/products/pool", P.read, async (req, res) => send(res, await core.listProducts(Math.max(1, Math.min(1000, Number(req.query.limit) || 200)))));
api.get("/products", P.read, async (req, res) => send(res, await core.loadProductsPage({ batch: batchOf(req), startAfter: cursor(req) })));
api.delete("/products", P.read, P.productDelete, async (req, res) => {
  const name = String(req.query.name || "");
  if (!name.trim()) throw badRequest("name chahiye");
  send(res, await core.deleteProduct(name));
});

/* ---------- activity log (append-only) ---------- */
api.post("/activity", P.read, async (req, res) => {
  const e = body(req);
  // the server stamps WHO did it from the verified token — a client can't log as someone else
  const prof = req.user.profile;
  const id = await core.logActivity({ ...e, ts: e.ts instanceof Date ? e.ts : new Date(), userId: req.user.uid, userName: (prof && prof.fullName) || e.userName || req.user.email });
  send(res, { id });
});
api.get("/activity/all", P.read, async (req, res) => send(res, await core.loadAllActivity()));
api.get("/activity", P.read, async (req, res) => send(res, await core.loadActivityPage({ batch: batchOf(req), startAfter: cursor(req) })));

/* ---------- stats (dashboard + reports) ---------- */
const keysOf = (req) => String(req.query.keys || "").split(",").map((s) => s.trim()).filter((k) => /^\d{4}-\d{2}(-\d{2})?$/.test(k)).slice(0, 400);
api.get("/stats/days", P.read, async (req, res) => send(res, await core.statsForDays(keysOf(req))));
api.get("/stats/months", P.read, async (req, res) => send(res, await core.statsForMonths(keysOf(req))));
api.get("/stats/months/all", P.read, async (req, res) => send(res, await core.allMonthStats()));
api.post("/stats/recompute", P.read, P.statsWrite, async (req, res) => send(res, await core.recomputeStats()));
api.post("/stats/reconcile-day", P.read, P.statsWrite, async (req, res) => {
  const b = body(req);
  if (!Number.isFinite(Number(b.dayMs))) throw badRequest("dayMs chahiye");
  send(res, await core.reconcileDay(Number(b.dayMs), b.truth || {}));
});

/* ---------- background report recalculation ---------- */
api.post("/recalc", P.read, async (req, res) => {
  const prof = req.user.profile;
  send(res, recalc.startJob(body(req), (prof && prof.fullName) || req.user.uid));
});
api.get("/recalc/:jobId", P.read, async (req, res) => {
  const job = recalc.getJob(req.params.jobId);
  if (!job) throw notFound("Job nahi mila");
  send(res, job);
});
api.post("/recalc/:jobId/cancel", P.read, requireAdmin, async (req, res) => {
  if (!recalc.cancelJob(req.params.jobId)) throw notFound("Job nahi mila");
  send(res, { ok: true });
});

/* ---------- users (admin) ---------- */
api.get("/users", P.read, async (req, res) => send(res, await users.listUsers()));
api.post("/users", P.read, async (req, res) => send(res, await users.createUser(req.user, body(req))));
api.patch("/users/:id", P.read, async (req, res) => send(res, await users.updateUser(req.user, req.params.id, body(req))));
api.post("/users/:id/password", P.read, async (req, res) => send(res, await users.setPassword(req.user, req.params.id, body(req).password)));
api.post("/users/:id/disabled", P.read, async (req, res) => send(res, await users.setDisabled(req.user, req.params.id, !!body(req).disabled)));
api.delete("/users/:id", P.read, async (req, res) => send(res, await users.deleteUser(req.user, req.params.id)));

app.use("/api", api);
app.use("/api", (req, res) => res.status(404).json({ error: { code: "not-found", message: "API route nahi mila" } }));

/* =====================================================================
   OPTIONAL: serve the web app itself (one service = site + API)
   ===================================================================== */
if (SERVE_STATIC) {
  const blocked = /^\/(server|functions|node_modules|uploads)(\/|$)|\/\.|\.md$|^\/firebase\.json$|^\/firestore\.|^\/database\.rules\.json$/i;
  app.use((req, res, next) => (blocked.test(req.path) ? res.status(404).end() : next()));
  app.use(express.static(WEB_ROOT, { dotfiles: "ignore", index: "index.html", extensions: ["html"] }));
  app.get("/", (req, res) => res.sendFile(path.join(WEB_ROOT, "index.html")));
}

/* ---------- errors ---------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Firebase itself failed (quota / outage / billing / credentials) -> 503 firebase-unavailable
  if (isFirebaseOutage(err)) {
    console.error("[firebase]", req.method, req.originalUrl, err.code, err.message);
    return res.status(503).json({ error: { code: "firebase-unavailable", message: "Firebase service unavailable" } });
  }
  // business-rule errors from db-core (e.g. "bill permanently delete ho chuka hai") carry a userMessage
  const status = err.status || (err.userMessage ? 409 : err.type === "entity.too.large" ? 413 : 500);
  if (status >= 500) console.error("[api]", req.method, req.originalUrl, err);
  const out = { code: err.code && typeof err.code === "string" ? err.code : "internal", message: err.message || "Server error" };
  if (err.userMessage) out.userMessage = err.userMessage;
  res.status(status).json({ error: out });
});

app.listen(PORT, () => {
  console.log("[MSA] API server listening on :" + PORT + "  (TZ=" + process.env.TZ + ", static=" + SERVE_STATIC + ")");
});
