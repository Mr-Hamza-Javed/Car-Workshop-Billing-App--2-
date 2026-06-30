/* =====================================================================
   MSA Billing — Cloud Functions (Admin SDK)
   Secure, server-verified user administration. The browser never holds
   admin credentials; every privileged operation is checked here.

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
   ===================================================================== */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const auth = getAuth();
const db = getFirestore();

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
