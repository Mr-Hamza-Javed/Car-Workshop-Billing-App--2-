/* =====================================================================
   User administration (ported from the old Cloud Functions).

   Authorization model (admin hierarchy) — unchanged:
     • admin@msa.com is THE primary admin — identified strictly by EMAIL.
     • The primary admin fully controls every OTHER user, incl. co-admins.
     • On its OWN account the primary admin may change only its full name
       (password changes happen in the app via Firebase Auth).
     • A co-admin (role "Admin", not primary) manages regular users only.
     • Regular users cannot manage users at all.
   Custom claims are still kept in sync so the Firestore security rules
   stay meaningful as a second line of defence.
   ===================================================================== */
import { adminAuth, firestore, ADMIN_EMAIL } from "./config.js";
import { FULL_PERMS, userPublic } from "../../db-core.js";
import { ApiError, denied, badRequest, notFound, invalidateProfile, loadProfile } from "./auth.js";

const PERM_SHAPE = {
  bills: ["view", "create", "edit", "payments", "archive", "delete"],
  recycle: ["view", "restore", "purge"],
  reports: ["view"], activity: ["view"], products: ["delete"], settings: ["manage"],
};
function cleanScope(s) {
  const modes = ["self", "all", "include", "exclude"];
  const mode = (s && modes.includes(s.mode)) ? s.mode : "self";
  const users = (s && Array.isArray(s.users)) ? s.users.filter((x) => typeof x === "string").slice(0, 100) : [];
  return { mode, users };
}
/* compact claim flags for Firestore rules: { bv, bc, be, bp, ba, bd, rv, rr, rp, rep, av, pd, sm } */
function claimPerms(p) {
  const g = (c, a) => !!(p && p[c] && p[c][a] && p[c][a].on);
  return {
    bv: g("bills", "view"), bc: g("bills", "create"), be: g("bills", "edit"), bp: g("bills", "payments"),
    ba: g("bills", "archive"), bd: g("bills", "delete"),
    rv: g("recycle", "view"), rr: g("recycle", "restore"), rp: g("recycle", "purge"),
    rep: g("reports", "view"), av: g("activity", "view"), pd: g("products", "delete"), sm: g("settings", "manage"),
  };
}
/* sanitize an incoming v2 perms object to the exact known shape (unknown keys drop) */
function cleanPerms(p) {
  const out = {};
  Object.keys(PERM_SHAPE).forEach((cat) => {
    out[cat] = {};
    PERM_SHAPE[cat].forEach((act) => {
      const a = (p && p[cat] && p[cat][act]) || {};
      const days = Math.max(0, Math.min(3650, Math.round(Number(a.days) || 0)));
      const entry = { on: !!a.on, days };
      if (!(cat === "reports" || cat === "products" || cat === "settings")) entry.scope = cleanScope(a.scope);
      out[cat][act] = entry;
    });
  });
  return out;
}
const validEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const emailOf = (p) => String((p && p.email) || "").toLowerCase();

/* only the primary admin or an enabled Admin-role user may manage users */
function requireUserManager(caller) {
  if (caller.isPrimary) return;
  if (caller.profile && caller.profile.role === "Admin" && !caller.profile.disabled) return;
  throw denied("Sirf admin users aur permissions manage kar sakta hai");
}
async function targetInfo(uid) {
  const target = await loadProfile(uid, { fresh: true });
  const isPrimary = emailOf(target) === ADMIN_EMAIL;
  return { target, isPrimary, isCoAdmin: !isPrimary && !!target && target.role === "Admin" };
}

/* idempotent: the known admin email self-promotes once (creates/repairs its profile) */
export async function bootstrapAdmin(caller) {
  if (!caller.isPrimary) throw denied("Sirf admin account bootstrap kar sakta hai");
  await adminAuth.setCustomUserClaims(caller.uid, { admin: true, p: claimPerms(FULL_PERMS) });
  const ref = firestore.doc("users/" + caller.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ email: ADMIN_EMAIL, fullName: "Asif Shakoor", role: "Admin", perms: FULL_PERMS, activityScope: "all", disabled: false, createdAtMs: Date.now() });
  } else {
    await ref.set({ role: "Admin", perms: FULL_PERMS, activityScope: "all", disabled: false }, { merge: true });
  }
  invalidateProfile(caller.uid);
  return { ok: true, admin: true };
}

export async function listUsers() {
  const snap = await firestore.collection("users").orderBy("createdAtMs", "asc").get();
  return snap.docs.map((d) => userPublic(d.id, d.data()));
}

export async function createUser(caller, data) {
  requireUserManager(caller);
  const { email, password, fullName, role, perms, activityScope } = data || {};
  if (!validEmail(email)) throw badRequest("Email theek nahi");
  if (!password || String(password).length < 6) throw badRequest("Password kam az kam 6 characters");
  const wantAdmin = role === "Admin" || String(email).toLowerCase() === ADMIN_EMAIL;
  if (wantAdmin && !caller.isPrimary) throw denied("Sirf primary admin naya admin bana sakta hai");
  let rec;
  try {
    rec = await adminAuth.createUser({ email: String(email).toLowerCase(), password: String(password), displayName: fullName || email });
  } catch (e) {
    if (e.code === "auth/email-already-exists") throw new ApiError(409, "already-exists", "Yeh email pehle se mojood hai");
    throw new ApiError(500, "internal", e.message);
  }
  const cleaned = wantAdmin ? FULL_PERMS : cleanPerms(perms);
  await adminAuth.setCustomUserClaims(rec.uid, { admin: wantAdmin, p: claimPerms(cleaned) });
  await firestore.doc("users/" + rec.uid).set({
    email: String(email).toLowerCase(), fullName: fullName || email,
    role: wantAdmin ? "Admin" : (role || "User"), perms: cleaned,
    activityScope: activityScope || "own", disabled: false, createdAtMs: Date.now(),
  });
  return { ok: true, uid: rec.uid };
}

export async function updateUser(caller, uid, data) {
  requireUserManager(caller);
  const { fullName, role, perms, activityScope } = data || {};
  if (!uid) throw badRequest("uid chahiye");
  const { target, isPrimary, isCoAdmin } = await targetInfo(uid);
  if (!target) throw notFound("User nahi mila");
  const patch = {};
  if (isPrimary) {
    if (!caller.isPrimary) throw denied("Sirf primary admin apni profile edit kar sakta hai");
    // self-edit, name only — role/perms/activityScope/disable are never touched here
    if (typeof fullName === "string" && fullName.trim()) patch.fullName = fullName.trim();
    if (!Object.keys(patch).length) throw denied("Admin ka sirf naam change ho sakta hai");
  } else {
    if (isCoAdmin && !caller.isPrimary) throw denied("Doosre admin ko sirf primary admin manage kar sakta hai");
    if (typeof fullName === "string" && fullName.trim()) patch.fullName = fullName.trim();
    if (typeof role === "string") {
      if (!isCoAdmin && role === "Admin" && !caller.isPrimary) throw denied("Sirf primary admin kisi ko admin bana sakta hai");
      patch.role = role;
    }
    if (perms && typeof perms === "object") patch.perms = cleanPerms(perms);
    if (typeof activityScope === "string") patch.activityScope = activityScope;
  }
  await firestore.doc("users/" + uid).set(patch, { merge: true });
  if (patch.perms || patch.role) {
    const isAdminNow = (patch.role || target.role) === "Admin";
    const newPerms = patch.perms || target.perms || {};
    await adminAuth.setCustomUserClaims(uid, { admin: isAdminNow, p: claimPerms(isAdminNow ? FULL_PERMS : cleanPerms(newPerms)) });
  }
  if (patch.fullName) { try { await adminAuth.updateUser(uid, { displayName: patch.fullName }); } catch (e) {} }
  invalidateProfile(uid);
  return { ok: true };
}

export async function setPassword(caller, uid, password) {
  requireUserManager(caller);
  if (!uid) throw badRequest("uid chahiye");
  if (!password || String(password).length < 6) throw badRequest("Password kam az kam 6 characters");
  const { isPrimary, isCoAdmin } = await targetInfo(uid);
  if (isPrimary && !caller.isPrimary) throw denied("Admin ka password sirf admin khud set kar sakta hai");
  if (isCoAdmin && !caller.isPrimary) throw denied("Doosre admin ka password sirf primary admin set kar sakta hai");
  await adminAuth.updateUser(uid, { password: String(password) });
  return { ok: true };
}

export async function setDisabled(caller, uid, disabled) {
  requireUserManager(caller);
  if (!uid) throw badRequest("uid chahiye");
  if (uid === caller.uid) throw denied("Aap khud ko disable nahi kar sakte");
  const { isPrimary, isCoAdmin } = await targetInfo(uid);
  if (isPrimary) throw denied("Primary admin account disable nahi ho sakta");
  if (isCoAdmin && !caller.isPrimary) throw denied("Doosre admin ko sirf primary admin disable kar sakta hai");
  await adminAuth.updateUser(uid, { disabled: !!disabled });
  // revoke refresh tokens so a disabled user is signed out everywhere on the next token refresh
  if (disabled) { try { await adminAuth.revokeRefreshTokens(uid); } catch (e) {} }
  await firestore.doc("users/" + uid).set({ disabled: !!disabled }, { merge: true });
  invalidateProfile(uid);
  return { ok: true };
}

export async function deleteUser(caller, uid) {
  requireUserManager(caller);
  if (!uid) throw badRequest("uid chahiye");
  if (uid === caller.uid) throw denied("Aap khud ko delete nahi kar sakte");
  const { isPrimary, isCoAdmin } = await targetInfo(uid);
  if (isPrimary) throw denied("Primary admin account delete nahi ho sakta");
  if (isCoAdmin && !caller.isPrimary) throw denied("Doosre admin ko sirf primary admin delete kar sakta hai");
  try { await adminAuth.deleteUser(uid); } catch (e) { /* may already be gone */ }
  await firestore.doc("users/" + uid).delete();
  invalidateProfile(uid);
  return { ok: true };
}
