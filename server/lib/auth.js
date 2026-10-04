/* =====================================================================
   Authentication + authorisation for the API.

   Login itself stays in the web app (Firebase Authentication). The app
   sends its Firebase ID token as   Authorization: Bearer <token>   and
   the server verifies it here, loads the users/{uid} profile and checks
   permissions — the job Firestore security rules used to do.
   ===================================================================== */
import { adminAuth, firestore, ADMIN_EMAIL } from "./config.js";
import { isFirebaseOutage } from "./firebase-errors.js";

export class ApiError extends Error {
  constructor(status, code, message, userMessage) {
    super(message);
    this.status = status; this.code = code;
    if (userMessage) this.userMessage = userMessage;
  }
}
export const unauthenticated = (msg) => new ApiError(401, "unauthenticated", msg || "Login zaroori hai");
export const denied = (msg) => new ApiError(403, "permission-denied", msg || "Aap ko is kaam ki ijazat nahi");
export const badRequest = (msg) => new ApiError(400, "invalid-argument", msg || "Ghalat request");
export const notFound = (msg) => new ApiError(404, "not-found", msg || "Nahi mila");

/* ---- profile cache ----
   Every request needs the caller's profile (perms). A short cache saves a Firestore read per
   call; user-admin routes call invalidateProfile() so permission changes apply immediately. */
const PROFILE_TTL_MS = 15000;
const profileCache = new Map();
export async function loadProfile(uid, { fresh = false } = {}) {
  const hit = profileCache.get(uid);
  if (!fresh && hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  const snap = await firestore.doc("users/" + uid).get();
  const profile = snap.exists ? snap.data() : null;
  profileCache.set(uid, { at: Date.now(), profile });
  return profile;
}
export function invalidateProfile(uid) { if (uid) profileCache.delete(uid); else profileCache.clear(); }

/* Verifies the bearer token. Sets req.user = { uid, email, profile, isPrimary, isAdmin }.
   Does NOT require a profile — use requireKnownUser for that. */
export async function authenticate(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return next(unauthenticated());
  let decoded;
  try { decoded = await adminAuth.verifyIdToken(m[1]); }
  catch (e) { return next(isFirebaseOutage(e) ? e : unauthenticated("Session khatam ho gaya - dobara login karein")); }
  const email = String(decoded.email || "").toLowerCase();
  const profile = await loadProfile(decoded.uid);
  req.user = {
    uid: decoded.uid,
    email,
    profile,
    isPrimary: email === ADMIN_EMAIL,
    isAdmin: email === ADMIN_EMAIL || !!(profile && profile.role === "Admin"),
  };
  next();
}

/* "known" = signed in AND has an admin-created, enabled profile doc (same idea as the old
   isKnownUser() Firestore rule — a self-registered Firebase Auth account gets nothing). */
export function requireKnownUser(req, res, next) {
  const p = req.user && req.user.profile;
  if (!p) return next(denied("Aap ka profile nahi mila - admin se rabta karein"));
  if (p.disabled) return next(denied("Yeh account band kar diya gaya hai"));
  next();
}

/* v2 permission check: Admin role (or the primary admin) can do everything; others need
   profile.perms[cat][act].on. days + per-user scope fine-graining is still applied by the app. */
export function can(user, cat, act) {
  if (!user || !user.profile || user.profile.disabled) return false;
  if (user.isAdmin) return true;
  const p = user.profile.perms;
  return !!(p && p[cat] && p[cat][act] && p[cat][act].on);
}
/* route guard: passes if the caller has ANY of the listed [cat, act] permissions */
export function requirePerm(...pairs) {
  return (req, res, next) => {
    if (pairs.some(([c, a]) => can(req.user, c, a))) return next();
    next(denied());
  };
}
export function requireAdmin(req, res, next) {
  if (req.user && req.user.isAdmin && !(req.user.profile && req.user.profile.disabled)) return next();
  next(denied("Sirf Admin yeh kaam kar sakta hai"));
}
