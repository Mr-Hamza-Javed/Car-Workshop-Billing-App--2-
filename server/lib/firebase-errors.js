/* =====================================================================
   Is this error a FIREBASE failure (quota exhausted, service down,
   project / billing / credential problem) — as opposed to a normal
   app error (bad input, missing permission, business rule)?
   Such errors are answered with 503 { code: "firebase-unavailable" } and
   the web app then shows its fixed "service unavailable" page.
   ===================================================================== */

// gRPC status codes thrown by the Firestore Admin SDK that mean "Firebase itself failed":
// UNKNOWN 2, DEADLINE_EXCEEDED 4, PERMISSION_DENIED 7 (service account / API / billing — app
// permissions are checked before Firestore is touched), RESOURCE_EXHAUSTED 8 (quota),
// INTERNAL 13, UNAVAILABLE 14, DATA_LOSS 15, UNAUTHENTICATED 16 (bad server credentials).
const GRPC_OUTAGE = new Set([2, 4, 7, 8, 13, 14, 15, 16]);
// Admin-SDK auth errors that mean the Firebase Auth service / project failed (not a user mistake)
const AUTH_OUTAGE = new Set([
  "auth/internal-error", "auth/quota-exceeded", "auth/project-not-found", "auth/insufficient-permission",
  "auth/invalid-credential", "auth/operation-not-allowed", "auth/too-many-requests",
]);

export function isFirebaseOutage(err) {
  if (!err || err.userMessage || err.status) return false;   // our own ApiError / business-rule errors
  if (typeof err.code === "number") return GRPC_OUTAGE.has(err.code);
  const code = String(err.code || (err.errorInfo && err.errorInfo.code) || "");
  if (AUTH_OUTAGE.has(code) || code.startsWith("app/")) return true;
  // credential / metadata failures surface without a code
  return /RESOURCE_EXHAUSTED|quota|Could not load the default credentials|Failed to (fetch|determine) .*(token|project)|getaddrinfo|ECONNREFUSED|ETIMEDOUT/i.test(String(err.message || ""));
}
