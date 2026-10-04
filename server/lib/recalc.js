/* =====================================================================
   RECALCULATE REPORTS — background aggregate rebuild (replaces the old
   recalcStats Cloud Function + RTDB progress stream).

   The job runs inside this server process, so it keeps going even if the
   user closes the app. Live progress + an event log are kept in memory
   and the app polls GET /api/recalc/:jobId (same object shape the app
   used to receive from RTDB).
   ===================================================================== */
import { firestore } from "./config.js";
import { FieldPath } from "firebase-admin/firestore";
import { dayKey, monthKey } from "../../db-core.js";
import { badRequest } from "./auth.js";

const jobs = new Map();
const KEEP_FINISHED_MS = 2 * 60 * 60 * 1000;   // finished jobs stay readable for 2h

// same derive() the app uses, so aggregates match exactly
function deriveBill(b) {
  const sub = (b.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const disc = Math.max(0, Math.min(sub, Number(b.discount) || 0));
  const total = sub - disc;
  const paid = (b.history || []).reduce((s, h) => s + (Number(h.amount) || 0), 0);
  return { total, paid, pending: Math.max(0, total - paid) };
}

export function getJob(jobId) { return jobs.get(String(jobId || "")) || null; }
export function cancelJob(jobId) {
  const job = getJob(jobId);
  if (!job) return false;
  job.cancel = true;
  return true;
}

export function startJob({ from, to, jobId }, startedBy) {
  from = String(from || ""); to = String(to || "");
  if (!from || !to) throw badRequest("from and to dates are required");
  const fromMs = new Date(from + "T00:00:00").getTime();
  const toMs = new Date(to + "T23:59:59").getTime();
  if (!(fromMs <= toMs)) throw badRequest("from must be on/before to");
  // the client pre-generates the jobId so it can start polling immediately
  const id = String(jobId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)
    || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  if (jobs.has(id)) throw badRequest("Yeh job pehle se chal rahi hai");

  const dayMs = 86400000;
  const totalDays = Math.max(1, Math.round((toMs - fromMs) / dayMs) + 1);
  const monthsSet = {};
  for (let i = 0; i < totalDays; i++) monthsSet[monthKey(fromMs + i * dayMs)] = 1;
  const totalMonths = Math.max(1, Object.keys(monthsSet).length);

  const job = {
    status: "running", progress: 0, from, to, startedBy, startedAt: Date.now(), cancel: false,
    bills: { done: 0, total: 0 }, months: { done: 0, total: totalMonths }, days: { done: 0, total: totalDays },
    logs: {}, updatedAt: Date.now(),
  };
  let seq = 0;
  const log = (level, msg) => { job.logs["l" + String(++seq).padStart(7, "0")] = { t: Date.now(), level, msg }; job.updatedAt = Date.now(); };
  jobs.set(id, job);
  log("info", "Recalculation shuru (" + from + " se " + to + ")");

  run(job, log, fromMs, toMs, totalDays, totalMonths)
    .catch((e) => {
      const msg = String((e && e.message) || e);
      job.status = "error"; job.error = msg; job.updatedAt = Date.now();
      log("error", "Fatal: " + msg);
    })
    .finally(() => setTimeout(() => jobs.delete(id), KEEP_FINISHED_MS).unref());
  return { jobId: id, status: "running" };
}

async function run(job, log, fromMs, toMs, totalDays, totalMonths) {
  // Single-field tsMs range + in-code `deleted` filter — needs NO composite index.
  const snap = await firestore.collection("bills")
    .where("tsMs", ">=", fromMs).where("tsMs", "<=", toMs)
    .orderBy("tsMs", "asc").get();
  const bills = snap.docs.filter((d) => d.data().deleted !== true);
  const totalBills = bills.length;
  job.bills = { done: 0, total: totalBills };
  log("info", totalBills + " bills, " + totalMonths + " months, " + totalDays + " days process karne hain");

  const days = {}, months = {}, seenMonth = {};
  const blank = () => ({ billed: 0, paid: 0, pending: 0, count: 0 });
  let monthsDone = 0, errors = 0;

  for (let i = 0; i < bills.length; i++) {
    if (job.cancel) {
      job.status = "stopped"; job.updatedAt = Date.now();
      log("error", "Process admin ne rok diya");
      return;
    }
    const id = bills[i].id, b = bills[i].data();
    const ts = Number(b.tsMs);
    if (!Number.isFinite(ts) || ts <= 0) { errors++; log("error", "ERROR: bill " + id + " ka timestamp kharab, skip"); continue; }
    const d = deriveBill(b), dk = dayKey(ts), mk = monthKey(ts);
    (days[dk] = days[dk] || blank()); days[dk].billed += d.total; days[dk].paid += d.paid; days[dk].pending += d.pending; days[dk].count++;
    (months[mk] = months[mk] || blank()); months[mk].billed += d.total; months[mk].paid += d.paid; months[mk].pending += d.pending; months[mk].count++;
    if (!seenMonth[mk]) { seenMonth[mk] = 1; monthsDone++; log("ok", "Month " + mk + " completed"); }
    if (i % 10 === 0 || i === bills.length - 1) {
      const done = i + 1;
      log("info", "Processing bill " + (b.no || id));
      job.progress = Math.round((done / Math.max(1, totalBills)) * 100);
      job.bills = { done, total: totalBills };
      job.months = { done: Math.min(monthsDone, totalMonths), total: totalMonths };
      job.days = { done: Math.min(totalDays, Math.round((done / Math.max(1, totalBills)) * totalDays)), total: totalDays };
      job.updatedAt = Date.now();
      await new Promise((r) => setImmediate(r));   // keep the server responsive on huge ranges
    }
  }
  if (job.cancel) { job.status = "stopped"; log("error", "Process admin ne rok diya"); return; }

  // write aggregates in <=450-op batches
  const commitMap = async (coll, map) => {
    let batch = firestore.batch(), n = 0;
    for (const k of Object.keys(map)) {
      batch.set(firestore.collection(coll).doc(k), map[k]); n++;
      if (n % 450 === 0) { await batch.commit(); batch = firestore.batch(); }
    }
    await batch.commit();
  };
  await commitMap("stats", days);
  await commitMap("stats_m", months);

  // ZERO any existing aggregate doc IN RANGE that no longer has bills (stale totals)
  const zeroStale = async (coll, map, loKey, hiKey) => {
    const ex = await firestore.collection(coll)
      .where(FieldPath.documentId(), ">=", loKey)
      .where(FieldPath.documentId(), "<=", hiKey).get();
    let batch = firestore.batch(), n = 0;
    for (const d of ex.docs) {
      if (!map[d.id]) { batch.set(d.ref, blank()); n++; if (n % 450 === 0) { await batch.commit(); batch = firestore.batch(); } }
    }
    await batch.commit();
    return n;
  };
  const staleD = await zeroStale("stats", days, dayKey(fromMs), dayKey(toMs));
  const staleM = await zeroStale("stats_m", months, monthKey(fromMs), monthKey(toMs));
  if (staleD || staleM) log("info", "Purane khali aggregates saaf kiye: " + staleD + " din, " + staleM + " mahine");

  job.summary = { bills: totalBills, months: totalMonths, days: totalDays, errors };
  job.status = "done"; job.progress = 100;
  job.bills = { done: totalBills, total: totalBills };
  job.months = { done: totalMonths, total: totalMonths };
  job.days = { done: totalDays, total: totalDays };
  log("ok", "Recalculation mukammal");
}
