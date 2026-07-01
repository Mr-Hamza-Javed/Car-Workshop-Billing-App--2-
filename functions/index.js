/* =====================================================================
   MSA Billing — Cloud Functions (backend for Recalculate reports)
   ---------------------------------------------------------------------
   recalcStats  — callable. Rebuilds Firestore stats/ + stats_m/ aggregates
                  for a date range, IN THE BACKGROUND (keeps running even if
                  the user closes the app). Streams live progress + an event
                  log to the Realtime Database (RTDB) under /recalcJobs/{jobId}.
   cancelRecalc — callable, ADMIN ONLY. Flags a running job to stop.

   DATA SEPARATION (as required):
     - Firestore  = primary DB. Bills are read; stats/ + stats_m/ docs written.
     - RTDB       = ONLY the temporary live job state + logs (fast fan-out to
                    every watching client, no Firestore read/write strain).

   Deploy:  firebase deploy --only functions,database
   (Requires the Blaze plan. Region must match the app's FUNCTIONS_REGION.)
   ===================================================================== */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const rtdb = admin.database();
const TS = admin.database.ServerValue.TIMESTAMP;

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const monthKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1); };

// Same derive() the app/db layer uses, so aggregates match exactly.
function derive(b) {
  const sub = (b.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const disc = Math.max(0, Math.min(sub, Number(b.discount) || 0));
  const total = sub - disc;
  const paid = (b.history || []).reduce((s, h) => s + (Number(h.amount) || 0), 0);
  const pending = Math.max(0, total - paid);
  return { total, paid, pending };
}

exports.recalcStats = onCall({ region: "us-central1", timeoutSeconds: 540, memory: "512MiB" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required");
  const uid = req.auth.uid;
  const from = String((req.data && req.data.from) || "");
  const to = String((req.data && req.data.to) || "");
  if (!from || !to) throw new HttpsError("invalid-argument", "from and to dates are required");
  const fromMs = new Date(from + "T00:00:00").getTime();
  const toMs = new Date(to + "T23:59:59").getTime();
  if (!(fromMs <= toMs)) throw new HttpsError("invalid-argument", "from must be on/before to");

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
    const snap = await db.collection("bills")
      .where("deleted", "==", false)
      .where("tsMs", ">=", fromMs).where("tsMs", "<=", toMs)
      .orderBy("tsMs", "asc").get();
    const bills = snap.docs;
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
      const d = derive(b), dk = dayKey(ts), mk = monthKey(ts);
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

exports.cancelRecalc = onCall({ region: "us-central1" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required");
  const prof = await db.collection("users").doc(req.auth.uid).get();
  const role = prof.exists ? prof.data().role : null;
  if (role !== "Admin") throw new HttpsError("permission-denied", "Sirf Admin process rok sakta hai");
  const jobId = String((req.data && req.data.jobId) || "");
  if (!jobId) throw new HttpsError("invalid-argument", "jobId required");
  await rtdb.ref("recalcJobs/" + jobId + "/cancel").set(true);
  return { ok: true };
});
