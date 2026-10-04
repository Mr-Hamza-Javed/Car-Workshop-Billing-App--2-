/* =====================================================================
   Server config + Firebase Admin initialisation.
   Imported FIRST by index.js so env + timezone are set before anything
   else touches Date.
   ===================================================================== */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(here, "..");
export const WEB_ROOT = path.resolve(SERVER_DIR, "..");

// optional .env next to package.json (no dotenv dependency needed on Node 22)
try { process.loadEnvFile(path.join(SERVER_DIR, ".env")); } catch (e) { /* no .env — use real env vars */ }

// Report buckets (stats/YYYY-MM-DD, stats_m/YYYY-MM) are keyed by LOCAL date. The browser used
// to compute them in the shop's timezone, so the server must use the same one or bills near
// midnight would land on the wrong day.
process.env.TZ = process.env.TZ || "Asia/Karachi";

export const PORT = Number(process.env.PORT) || 8080;
export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "mirza-bills";
export const ADMIN_EMAIL = "admin@msa.com";
export const SERVE_STATIC = String(process.env.SERVE_STATIC || "true").toLowerCase() !== "false";
export const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

function credential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")));
  }
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath) {
    const abs = path.isAbsolute(keyPath) ? keyPath : path.resolve(SERVER_DIR, keyPath);
    let json;
    try { json = readFileSync(abs, "utf8"); }
    catch (e) { throw new Error("Service-account key not found at " + abs + " — see server/README.md (GOOGLE_APPLICATION_CREDENTIALS)"); }
    return cert(JSON.parse(json));
  }
  return applicationDefault();   // e.g. running on Google Cloud with an attached service account
}

initializeApp({ credential: credential(), projectId: PROJECT_ID });
export const adminAuth = getAuth();
export const firestore = getFirestore();
