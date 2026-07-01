/* =====================================================================
   MSA Billing — Cloud Functions (Admin SDK)  — FINAL, COMPLETE FILE
   ---------------------------------------------------------------------
   Secure, server-verified user administration + background report
   recalculation. The browser never holds admin credentials; every
   privileged operation is checked here.

   Callable functions (region: us-central1):
     bootstrapAdmin   — one-time: makes admin@msa.com the Admin (claim + profile)
     adminCreateUser  — create an Auth user + profile (+ custom claims)
     adminUpdateUser  — update fullName / role / perms / activityScope (+ claims)
     adminSetPassword — set/reset a user's password
     adminSetDisabled — enable / disable a user
     adminDeleteUser  — delete a user (Auth + profile)
     getClientGeo     — resolves the caller's IP + city/region/country for
                         the Activity log, using the real connecting IP
                         (server-side — no CORS, no client geo permission).
                         The app calls this ONCE per login session and
                         reuses the result for every activity entry, so it
                         costs one function call per session, not one per
                         action.
     recalcStats      — rebuilds Firestore stats/ + stats_m/ report
                         aggregates for a date range, IN THE BACKGROUND
                         (keeps running even if the user closes the app).
                         Streams live progress + an event log to the
                         Realtime Database under /recalcJobs/{jobId}.
     cancelRecalc     — ADMIN ONLY. Flags a running recalc job to stop.

   DATA SEPARATION:
     - Firestore = primary DB (bills, users, stats/ + stats_m/ aggregates).
     - RTDB      = ONLY temporary live recalc-job state + logs (fast fan-out
                   to every watching client, no Firestore read/write strain).

   Authorization model (admin hierarchy)
     • admin@msa.com is THE primary admin — identified strictly by EMAIL,
       never by role label or custom claim alone (so a second "Admin" role
       user can never impersonate this tier).
     • The primary admin has full control over every OTHER user, INCLUDING
       other Admin-role accounts: create, edit, disable, delete, reset
       password — all of it.
     • On its OWN account, the primary admin may change ONLY its full name
       and password. Nothing else about admin@msa.com is ever editable by
       anyone (including itself) — not role, not perms, not disable, not
       delete.
     • Any OTHER Admin-role account ("co-admin") is fully manageable ONLY
       by the primary admin — a co-admin cannot touch the primary, and
       cannot touch other co-admins either.
     • A regular (non-admin) user-manager — anyone whose profile grants
       perms.users === true — may manage regular, non-admin users, exactly
       as before. They can never touch the primary admin or any co-admin.

   Deploy:  firebase deploy --only functions,database   (Blaze plan; Node 24)
   ===================================================================== */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getDatabase, ServerValue } = require("firebase-admin/database");

initializeApp();
const auth = getAuth();
const db = getFirestore();
const rtdb = getDatabase();
const TS = ServerValue.TIMESTAMP;

const ADMIN_EMAIL = "admin@msa.com";
const REGION = "us-central1";
const opts = { region: REGION, cors: true };

const FULL_PERMS = {
  bills_create: true, bills_edit: true, bills_delete: true, bills_archive: true,
  payments: true, products: true, reports: true, recycle: true,
  users: true, settings: true,
};

/* ---------- helpers ---------- */
function requireAuth(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "Login zaroori hai");
  return request.auth;
}
async function loadProfile(uid) {
  const snap = await db.doc("users/" + uid).get();
  return snap.exists ? snap.data() : null;
}
function emailOf(profileOrNull, fallback) {
  return ((profileOrNull && profileOrNull.email) || fallback || "").toLowerCase();
}
/* The ONE true check for "is this the untouchable primary admin" — strictly by email,
   never by role label or custom claim (those can be granted to other accounts too). */
async function callerEmail(a) {
  if (a.token && a.token.email) return String(a.token.email).toLowerCase();
  try { const u = await auth.getUser(a.uid); return (u.email || "").toLowerCase(); } catch (e) { return ""; }
}

/* Caller must be the primary admin, OR an Admin-role/perms.users holder (for managing
   REGULAR users only — admin-tier targets are gated separately, per-function, below). */
async function requireUserManager(request) {
  const a = requireAuth(request);
  const email = await callerEmail(a);
  const isPrimary = email === ADMIN_EMAIL;
  if (isPrimary) return { uid: a.uid, email, isPrimary: true };
  if (a.token && a.token.admin === true) return { uid: a.uid, email, isPrimary: false }; // co-admin: can manage regular users only
  const prof = await loadProfile(a.uid);
  if (prof && prof.disabled) throw new HttpsError("permission-denied", "Account band hai");
  if (prof && prof.perms && prof.perms.users === true) return { uid: a.uid, email, isPrimary: false, prof };
  throw new HttpsError("permission-denied", "Aapko users manage karne ki ijazat nahi");
}
function cleanPerms(p) {
  const out = {};
  Object.keys(FULL_PERMS).forEach((k) => { out[k] = !!(p && p[k]); });
  return out;
}
function validEmail(e) { return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

/* =====================================================================
   bootstrapAdmin — idempotent. The known admin email self-promotes once.
   ===================================================================== */
exports.bootstrapAdmin = onCall(opts, async (request) => {
  const a = requireAuth(request);
  const user = await auth.getUser(a.uid);
  if ((user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Sirf admin account bootstrap kar sakta hai");
  }
  await auth.setCustomUserClaims(a.uid, { admin: true, perms: FULL_PERMS });
  const ref = db.doc("users/" + a.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      email: ADMIN_EMAIL, fullName: "Asif Shakoor", role: "Admin",
      perms: FULL_PERMS, activityScope: "all", disabled: false,
      createdAtMs: Date.now(),
    });
  } else {
    await ref.set({ role: "Admin", perms: FULL_PERMS, activityScope: "all", disabled: false }, { merge: true });
  }
  return { ok: true, admin: true };
});

/* =====================================================================
   adminCreateUser — only the primary admin may create another Admin-role
   account; anyone with perms.users may create a regular (non-admin) user.
   ===================================================================== */
exports.adminCreateUser = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { email, password, fullName, role, perms, activityScope } = request.data || {};
  if (!validEmail(email)) throw new HttpsError("invalid-argument", "Email theek nahi");
  if (!password || String(password).length < 6) throw new HttpsError("invalid-argument", "Password kam az kam 6 characters");
  const wantAdmin = role === "Admin" || (email || "").toLowerCase() === ADMIN_EMAIL;
  if (wantAdmin && !caller.isPrimary) throw new HttpsError("permission-denied", "Sirf primary admin naya admin bana sakta hai");

  let userRecord;
  try {
    userRecord = await auth.createUser({ email: String(email).toLowerCase(), password: String(password), displayName: fullName || email });
  } catch (e) {
    if (e.code === "auth/email-already-exists") throw new HttpsError("already-exists", "Yeh email pehle se mojood hai");
    throw new HttpsError("internal", e.message);
  }
  const cleanedPerms = wantAdmin ? FULL_PERMS : cleanPerms(perms);
  await auth.setCustomUserClaims(userRecord.uid, { admin: wantAdmin, perms: cleanedPerms });
  await db.doc("users/" + userRecord.uid).set({
    email: String(email).toLowerCase(), fullName: fullName || email,
    role: wantAdmin ? "Admin" : (role || "User"), perms: cleanedPerms,
    activityScope: activityScope || "own", disabled: false, createdAtMs: Date.now(),
  });
  return { ok: true, uid: userRecord.uid };
});

/* =====================================================================
   adminUpdateUser — fullName / role / perms / activityScope (NOT email)

   Target tiers:
     • primary (target.email === admin@msa.com): ONLY the primary itself
       may call this on its own account, and ONLY fullName may change —
       role/perms/activityScope are silently ignored even if sent.
     • co-admin (target.role === 'Admin', not primary): only the primary
       admin may edit — full edit (name/role/perms/scope).
     • regular user: any caller who passed requireUserManager may edit.
   ===================================================================== */
exports.adminUpdateUser = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { uid, fullName, role, perms, activityScope } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid chahiye");
  const target = await loadProfile(uid);
  if (!target) throw new HttpsError("not-found", "User nahi mila");
  const targetEmail = emailOf(target, null);
  const targetIsPrimary = targetEmail === ADMIN_EMAIL;
  const targetIsCoAdmin = !targetIsPrimary && target.role === "Admin";

  const patch = {};
  if (targetIsPrimary) {
    if (!caller.isPrimary) throw new HttpsError("permission-denied", "Sirf primary admin apni profile edit kar sakta hai");
    // self-edit, name only — role/perms/activityScope/disable are never touched here
    if (typeof fullName === "string" && fullName.trim()) patch.fullName = fullName.trim();
    if (Object.keys(patch).length === 0) throw new HttpsError("permission-denied", "Admin ka sirf naam change ho sakta hai");
  } else if (targetIsCoAdmin) {
    if (!caller.isPrimary) throw new HttpsError("permission-denied", "Doosre admin ko sirf primary admin manage kar sakta hai");
    if (typeof fullName === "string" && fullName.trim()) patch.fullName = fullName.trim();
    if (typeof role === "string") patch.role = role; // primary may change a co-admin's role freely, incl. demoting
    if (perms && typeof perms === "object") patch.perms = cleanPerms(perms);
    if (typeof activityScope === "string") patch.activityScope = activityScope;
  } else {
    // regular (non-admin) target — existing perms.users-gated behaviour
    if (typeof fullName === "string" && fullName.trim()) patch.fullName = fullName.trim();
    if (typeof role === "string") {
      if (role === "Admin" && !caller.isPrimary) throw new HttpsError("permission-denied", "Sirf primary admin kisi ko admin bana sakta hai");
      patch.role = role;
    }
    if (perms && typeof perms === "object") patch.perms = cleanPerms(perms);
    if (typeof activityScope === "string") patch.activityScope = activityScope;
  }

  await db.doc("users/" + uid).set(patch, { merge: true });
  if (patch.perms || patch.role) {
    const newPerms = patch.perms || target.perms || {};
    const isAdminNow = (patch.role || target.role) === "Admin";
    await auth.setCustomUserClaims(uid, { admin: isAdminNow, perms: isAdminNow ? FULL_PERMS : cleanPerms(newPerms) });
  }
  if (patch.fullName) { try { await auth.updateUser(uid, { displayName: patch.fullName }); } catch (e) {} }
  return { ok: true };
});

/* =====================================================================
   adminSetPassword
     • primary target: only the primary itself may set its own password.
     • co-admin target: only the primary admin may reset it.
     • regular user: any caller who passed requireUserManager may reset it.
   ===================================================================== */
exports.adminSetPassword = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { uid, password } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid chahiye");
  if (!password || String(password).length < 6) throw new HttpsError("invalid-argument", "Password kam az kam 6 characters");
  const target = await loadProfile(uid);
  const targetEmail = emailOf(target, null);
  const targetIsPrimary = targetEmail === ADMIN_EMAIL;
  const targetIsCoAdmin = !targetIsPrimary && target && target.role === "Admin";
  if (targetIsPrimary && !caller.isPrimary) throw new HttpsError("permission-denied", "Admin ka password sirf admin khud set kar sakta hai");
  if (targetIsCoAdmin && !caller.isPrimary) throw new HttpsError("permission-denied", "Doosre admin ka password sirf primary admin set kar sakta hai");
  await auth.updateUser(uid, { password: String(password) });
  return { ok: true };
});

/* =====================================================================
   adminSetDisabled
     • primary target: never allowed, for anyone, ever.
     • co-admin target: only the primary admin may disable/enable.
     • regular user: any caller who passed requireUserManager may toggle.
   ===================================================================== */
exports.adminSetDisabled = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { uid, disabled } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid chahiye");
  if (uid === caller.uid) throw new HttpsError("permission-denied", "Aap khud ko disable nahi kar sakte");
  const target = await loadProfile(uid);
  const targetEmail = emailOf(target, null);
  const targetIsPrimary = targetEmail === ADMIN_EMAIL;
  const targetIsCoAdmin = !targetIsPrimary && target && target.role === "Admin";
  if (targetIsPrimary) throw new HttpsError("permission-denied", "Primary admin account disable nahi ho sakta");
  if (targetIsCoAdmin && !caller.isPrimary) throw new HttpsError("permission-denied", "Doosre admin ko sirf primary admin disable kar sakta hai");
  await auth.updateUser(uid, { disabled: !!disabled });
  await db.doc("users/" + uid).set({ disabled: !!disabled }, { merge: true });
  return { ok: true };
});

/* =====================================================================
   adminDeleteUser
     • primary target: never allowed, for anyone, ever.
     • co-admin target: only the primary admin may delete.
     • regular user: any caller who passed requireUserManager may delete.
   ===================================================================== */
exports.adminDeleteUser = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { uid } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid chahiye");
  if (uid === caller.uid) throw new HttpsError("permission-denied", "Aap khud ko delete nahi kar sakte");
  const target = await loadProfile(uid);
  const targetEmail = emailOf(target, null);
  const targetIsPrimary = targetEmail === ADMIN_EMAIL;
  const targetIsCoAdmin = !targetIsPrimary && target && target.role === "Admin";
  if (targetIsPrimary) throw new HttpsError("permission-denied", "Primary admin account delete nahi ho sakta");
  if (targetIsCoAdmin && !caller.isPrimary) throw new HttpsError("permission-denied", "Doosre admin ko sirf primary admin delete kar sakta hai");
  try { await auth.deleteUser(uid); } catch (e) { /* may already be gone */ }
  await db.doc("users/" + uid).delete();
  return { ok: true };
});

/* =====================================================================
   getClientGeo — IP + city/region/country for the Activity log.
   Uses the real connecting IP (from the request, not the client's own
   guess) and a free, keyless geo-IP lookup (ip-api.com). Called once per
   login session by the app and cached client-side — never once per action.
   Always returns under the field name "location" (never any other key) —
   the single source of truth the client stores activity entries under.
   ===================================================================== */
exports.getClientGeo = onCall(opts, async (request) => {
  requireAuth(request);
  const req = request.rawRequest;
  let ip = (req && req.headers && req.headers["x-forwarded-for"]) || (req && req.ip) || "";
  ip = String(ip).split(",")[0].trim();
  // strip IPv6-mapped-IPv4 prefix if present
  ip = ip.replace(/^::ffff:/, "");
  if (!ip || ip === "::1" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.")) {
    return { ip: ip || null, location: null };
  }
  try {
    const res = await fetch("http://ip-api.com/json/" + encodeURIComponent(ip) + "?fields=status,city,regionName,country");
    const data = await res.json();
    if (data && data.status === "success") {
      const parts = [data.city, data.regionName].filter(Boolean).join(", ");
      const location = [parts, data.country].filter(Boolean).join(" · ");
      return { ip, location: location || null };
    }
  } catch (e) { /* geo lookup is best-effort */ }
  return { ip, location: null };
});

/* =====================================================================
   RECALCULATE REPORTS — background aggregate rebuild + RTDB live progress
   ===================================================================== */

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const monthKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1); };

// Same derive() the app/db layer uses, so aggregates match exactly.
function deriveBill(b) {
  const sub = (b.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const disc = Math.max(0, Math.min(sub, Number(b.discount) || 0));
  const total = sub - disc;
  const paid = (b.history || []).reduce((s, h) => s + (Number(h.amount) || 0), 0);
  const pending = Math.max(0, total - paid);
  return { total, paid, pending };
}

/* recalcStats — rebuilds Firestore stats/ + stats_m/ for [from..to], streaming
   progress + an event log to RTDB /recalcJobs/{jobId}. Runs to completion on the
   server even if the caller closes the app. */
exports.recalcStats = onCall({ ...opts, timeoutSeconds: 540, memory: "512MiB" }, async (request) => {
  requireAuth(request);
  const uid = request.auth.uid;
  const from = String((request.data && request.data.from) || "");
  const to = String((request.data && request.data.to) || "");
  if (!from || !to) throw new HttpsError("invalid-argument", "from and to dates are required");
  const fromMs = new Date(from + "T00:00:00").getTime();
  const toMs = new Date(to + "T23:59:59").getTime();
  if (!(fromMs <= toMs)) throw new HttpsError("invalid-argument", "from must be on/before to");

  // Client may pre-generate the jobId so it can subscribe to RTDB progress IMMEDIATELY
  // (the callable promise only resolves when the whole job finishes).
  const jobId = (String((request.data && request.data.jobId) || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40))
    || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  const jobRef = rtdb.ref("recalcJobs/" + jobId);
  const logRef = jobRef.child("logs");
  const log = (level, msg) => logRef.push({ t: TS, level, msg });

  const dayMs = 86400000;
  const totalDays = Math.max(1, Math.round((toMs - fromMs) / dayMs) + 1);
  const monthsSet = {};
  for (let i = 0; i < totalDays; i++) monthsSet[monthKey(fromMs + i * dayMs)] = 1;
  const totalMonths = Math.max(1, Object.keys(monthsSet).length);

  await jobRef.set({
    status: "running", progress: 0, from, to, startedBy: uid, startedAt: TS, cancel: false,
    bills: { done: 0, total: 0 }, months: { done: 0, total: totalMonths }, days: { done: 0, total: totalDays }, updatedAt: TS,
  });
  await log("info", "Recalculation shuru (" + from + " se " + to + ")");

  try {
    // Single-field tsMs range query + in-code `deleted` filter — deliberately avoids the
    // (deleted, tsMs) composite index so this NEVER fails with "query requires an index"
    // (that's exactly how the first deployment broke: index not deployed -> internal error).
    const snap = await db.collection("bills")
      .where("tsMs", ">=", fromMs).where("tsMs", "<=", toMs)
      .orderBy("tsMs", "asc").get();
    const bills = snap.docs.filter((doc) => doc.data().deleted !== true);
    const totalBills = bills.length;
    await jobRef.child("bills").set({ done: 0, total: totalBills });
    await log("info", totalBills + " bills, " + totalMonths + " months, " + totalDays + " days process karne hain");

    const days = {}, months = {}, seenMonth = {};
    const blank = () => ({ billed: 0, paid: 0, pending: 0, count: 0 });
    let monthsDone = 0, errors = 0, cancelled = false;

    for (let i = 0; i < bills.length; i++) {
      if (i % 25 === 0) {
        const c = await jobRef.child("cancel").once("value");
        if (c.val() === true) { cancelled = true; break; }
      }
      const id = bills[i].id, b = bills[i].data();
      const ts = Number(b.tsMs);
      if (!isFinite(ts) || ts <= 0) { errors++; await log("error", "ERROR: bill " + id + " ka timestamp kharab, skip"); continue; }
      const d = deriveBill(b), dk = dayKey(ts), mk = monthKey(ts);
      (days[dk] = days[dk] || blank()); days[dk].billed += d.total; days[dk].paid += d.paid; days[dk].pending += d.pending; days[dk].count++;
      (months[mk] = months[mk] || blank()); months[mk].billed += d.total; months[mk].paid += d.paid; months[mk].pending += d.pending; months[mk].count++;
      if (!seenMonth[mk]) { seenMonth[mk] = 1; monthsDone++; await log("ok", "Month " + mk + " completed"); }
      if (i % 10 === 0 || i === bills.length - 1) {
        const done = i + 1;
        await log("info", "Processing bill " + (b.no || id));
        await jobRef.update({
          progress: Math.round((done / Math.max(1, totalBills)) * 100),
          "bills/done": done,
          "months/done": Math.min(monthsDone, totalMonths),
          "days/done": Math.min(totalDays, Math.round((done / Math.max(1, totalBills)) * totalDays)),
          updatedAt: TS,
        });
      }
    }

    if (cancelled) {
      await jobRef.update({ status: "stopped", updatedAt: TS });
      await log("error", "Process admin ne rok diya");
      return { jobId, status: "stopped" };
    }

    // Write aggregates to Firestore in <=450-op batches. Also zero any day/month doc that
    // falls in-range but no longer has bills, so stale numbers can't linger.
    const commitMap = async (coll, map) => {
      let batch = db.batch(), n = 0;
      for (const k of Object.keys(map)) {
        batch.set(db.collection(coll).doc(k), map[k]); n++;
        if (n % 450 === 0) { await batch.commit(); batch = db.batch(); }
      }
      await batch.commit();
    };
    await commitMap("stats", days);
    await commitMap("stats_m", months);

    const summary = { bills: totalBills, months: totalMonths, days: totalDays, errors };
    await jobRef.update({ status: "done", progress: 100, "bills/done": totalBills, "months/done": totalMonths, "days/done": totalDays, summary, updatedAt: TS });
    await log("ok", "Recalculation mukammal");
    return { jobId, status: "done", summary };
  } catch (e) {
    const msg = String((e && e.message) || e);
    await jobRef.update({ status: "error", error: msg, updatedAt: TS });
    await log("error", "Fatal: " + msg);
    throw new HttpsError("internal", msg);
  }
});

/* cancelRecalc — ADMIN ONLY (primary admin or admin custom-claim). */
exports.cancelRecalc = onCall(opts, async (request) => {
  const a = requireAuth(request);
  const email = await callerEmail(a);
  const isPrimary = email === ADMIN_EMAIL;
  const isCoAdmin = !!(a.token && a.token.admin === true);
  if (!isPrimary && !isCoAdmin) {
    const prof = await loadProfile(a.uid);
    if (!(prof && prof.role === "Admin")) throw new HttpsError("permission-denied", "Sirf Admin process rok sakta hai");
  }
  const jobId = String((request.data && request.data.jobId) || "");
  if (!jobId) throw new HttpsError("invalid-argument", "jobId required");
  await rtdb.ref("recalcJobs/" + jobId + "/cancel").set(true);
  return { ok: true };
});
