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

   Authorization model
     • A user may manage OTHER users if they are Admin (token.admin === true)
       OR their profile grants perms.users === true.
     • The admin account (admin@msa.com) can only be modified by an Admin.
     • Nobody can delete / disable / demote themselves into lockout, and a
       non-admin can never create or edit an Admin.
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
/* caller must be Admin or have perms.users */
async function requireUserManager(request) {
  const a = requireAuth(request);
  if (a.token && a.token.admin === true) return { uid: a.uid, isAdmin: true };
  const prof = await loadProfile(a.uid);
  if (prof && prof.disabled) throw new HttpsError("permission-denied", "Account band hai");
  if (prof && prof.perms && prof.perms.users === true) return { uid: a.uid, isAdmin: false, prof };
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
   adminCreateUser
   ===================================================================== */
exports.adminCreateUser = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { email, password, fullName, role, perms, activityScope } = request.data || {};
  if (!validEmail(email)) throw new HttpsError("invalid-argument", "Email theek nahi");
  if (!password || String(password).length < 6) throw new HttpsError("invalid-argument", "Password kam az kam 6 characters");
  const wantAdmin = role === "Admin" || (email || "").toLowerCase() === ADMIN_EMAIL;
  if (wantAdmin && !caller.isAdmin) throw new HttpsError("permission-denied", "Sirf admin, naya admin bana sakta hai");

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
   ===================================================================== */
exports.adminUpdateUser = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { uid, fullName, role, perms, activityScope } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid chahiye");
  const target = await loadProfile(uid);
  if (!target) throw new HttpsError("not-found", "User nahi mila");
  const targetIsAdmin = target.role === "Admin" || (target.email || "").toLowerCase() === ADMIN_EMAIL;
  if (targetIsAdmin && !caller.isAdmin) throw new HttpsError("permission-denied", "Admin ki settings sirf admin change kar sakta hai");

  const patch = {};
  if (typeof fullName === "string" && fullName.trim()) patch.fullName = fullName.trim();
  if (!targetIsAdmin) {
    if (typeof role === "string") {
      if (role === "Admin" && !caller.isAdmin) throw new HttpsError("permission-denied", "Sirf admin kisi ko admin bana sakta hai");
      patch.role = role;
    }
    if (perms && typeof perms === "object") patch.perms = cleanPerms(perms);
    if (typeof activityScope === "string") patch.activityScope = activityScope;
  } else {
    // editing the admin: only the display name may change
    if (Object.keys(patch).length === 0) throw new HttpsError("permission-denied", "Admin ka sirf naam change ho sakta hai");
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
   ===================================================================== */
exports.adminSetPassword = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { uid, password } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid chahiye");
  if (!password || String(password).length < 6) throw new HttpsError("invalid-argument", "Password kam az kam 6 characters");
  const target = await loadProfile(uid);
  const targetIsAdmin = target && (target.role === "Admin" || (target.email || "").toLowerCase() === ADMIN_EMAIL);
  if (targetIsAdmin && !caller.isAdmin) throw new HttpsError("permission-denied", "Admin ka password sirf admin set kar sakta hai");
  await auth.updateUser(uid, { password: String(password) });
  return { ok: true };
});

/* =====================================================================
   adminSetDisabled
   ===================================================================== */
exports.adminSetDisabled = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { uid, disabled } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid chahiye");
  if (uid === caller.uid) throw new HttpsError("permission-denied", "Aap khud ko disable nahi kar sakte");
  const target = await loadProfile(uid);
  const targetIsAdmin = target && (target.role === "Admin" || (target.email || "").toLowerCase() === ADMIN_EMAIL);
  if (targetIsAdmin) throw new HttpsError("permission-denied", "Admin account disable nahi ho sakta");
  await auth.updateUser(uid, { disabled: !!disabled });
  await db.doc("users/" + uid).set({ disabled: !!disabled }, { merge: true });
  return { ok: true };
});

/* =====================================================================
   adminDeleteUser
   ===================================================================== */
exports.adminDeleteUser = onCall(opts, async (request) => {
  const caller = await requireUserManager(request);
  const { uid } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid chahiye");
  if (uid === caller.uid) throw new HttpsError("permission-denied", "Aap khud ko delete nahi kar sakte");
  const target = await loadProfile(uid);
  const targetIsAdmin = target && (target.role === "Admin" || (target.email || "").toLowerCase() === ADMIN_EMAIL);
  if (targetIsAdmin) throw new HttpsError("permission-denied", "Admin account delete nahi ho sakta");
  try { await auth.deleteUser(uid); } catch (e) { /* may already be gone */ }
  await db.doc("users/" + uid).delete();
  return { ok: true };
});
