// Usage metering, server side (Phase 18). The registry is shared/metering.js.
//
// Documents (businesses/{bid}/..., all server-only):
//   usage/{YYYY-MM}        monthly counters + { period, timezone, timezones }
//   usageCurrent/storage   { bytes, reservedBytes, objects, alerts }   (./storage-usage.js)
//   usageCurrent/users     { alerts }  (the active-user count itself is live)
//
// Writes: a counter is incremented in the SAME transaction (or batch) as the
// record it measures, so a retried or failed operation can't count twice or
// count something that didn't happen. The browser never writes usage.
//
// Period: the month of the BUSINESS's timezone when the activity happened.
// Each monthly document remembers the timezone(s) used for it. A timezone
// change near a month boundary can put an event in the neighbouring month;
// already-counted usage is never moved (documented limitation).

import { METERS, MONTHLY_METER_IDS, LIMIT_METER, MeteringError, crossedThresholds, monthlyAlertKey, runningAlerts, runningAlertKey, previousPeriods, historyRows, effectiveLimit } from "../../../shared/metering.js";
import { monthKey } from "./usage.js";
import { prepareNotifications } from "./notifications.js";

export const usageMonthRef = (tenant, period) => tenant.doc("usage", period);
export const usageCurrentRef = (tenant, id) => tenant.doc("usageCurrent", id);
export const nonNegative = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

// `writer`: a transaction or a write batch. counts: { meterId: n }.
export function meterActivity(writer, { tenant, FieldValue, timezone, now = new Date(), period = null, counts }) {
  const p = period ?? monthKey(timezone, now);
  const inc = {};
  for (const [id, n] of Object.entries(counts || {})) {
    if (!MONTHLY_METER_IDS.includes(id)) throw new Error(`meterActivity: unknown monthly meter ${id}`);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`meterActivity: invalid count for ${id}`);
    if (n > 0) inc[id] = FieldValue.increment(n);
  }
  if (!Object.keys(inc).length) return p;
  const tz = typeof timezone === "string" && timezone ? timezone : "UTC";
  writer.set(usageMonthRef(tenant, p), { period: p, timezone: tz, timezones: FieldValue.arrayUnion(tz), ...inc, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return p;
}

// ---------- Warnings ----------

const fmt = (unit, n) => {
  if (unit !== "bytes") return Number(n).toLocaleString("en-PH");
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
};

export function usageEvent({ meterId, key, threshold, used, limit, period = null }) {
  const m = METERS[meterId];
  const span = m.kind === "monthly" ? ` this month (${period})` : "";
  return {
    type: "usage.threshold",
    key,
    title: threshold >= 100 ? `${m.label}: plan limit reached` : `${m.label}: ${threshold}% of your plan limit used`,
    message: `${fmt(m.unit, used)} of ${fmt(m.unit, limit)}${span}.${threshold >= 100 ? " New ones are blocked until the limit is raised" + (m.kind === "monthly" ? " or next month starts." : " or usage goes down.") : " Contact Luna to raise it."}`,
    recordType: "usage",
    recordId: meterId,
  };
}

// Monthly enforced meter going before -> after (inside the caller's
// transaction, before its writes). Returns the notification plan.
export async function prepareMonthlyAlerts(tx, { tenant, meterId, period, before, after, limit }) {
  const events = crossedThresholds(before, after, limit).map((t) => usageEvent({ meterId, key: monthlyAlertKey(meterId, period, t), threshold: t, used: after, limit, period }));
  return prepareNotifications(tx, { tenant, events });
}

// Running meter: evaluates the episode state; returns { notes, next, changed }.
export async function prepareRunningAlerts(tx, { tenant, meterId, state, used, limit }) {
  const r = runningAlerts(state, used, limit);
  const events = r.fire.map((f) => usageEvent({ meterId, key: runningAlertKey(meterId, f.episode, f.threshold), threshold: f.threshold, used, limit }));
  const notes = await prepareNotifications(tx, { tenant, events });
  return { notes, next: r.next, changed: r.changed };
}

// A limited action was REFUSED because usage is already at / over the
// limit (e.g. the operator lowered it below what's used). Records the
// "limit reached" state once (monthly: per month; running: per episode)
// so the owner hears about it, without counting the refused action and
// without notifying again on every blocked attempt. Best effort: it can
// never change the refusal itself.
export async function noteLimitReached({ db, tenant, FieldValue, meterId, used, limit, period = null }) {
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(used) || used < limit || limit <= 0) return 0;
  try {
    return await db.runTransaction(async (tx) => {
      if (METERS[meterId].kind === "monthly") {
        const notes = await prepareNotifications(tx, { tenant, events: [usageEvent({ meterId, key: monthlyAlertKey(meterId, period, 100), threshold: 100, used, limit, period })] });
        return notes.commit({ FieldValue });
      }
      const ref = usageCurrentRef(tenant, meterId === "activeUsers" ? "users" : "storage");
      const snap = await tx.get(ref);
      const r = await prepareRunningAlerts(tx, { tenant, meterId, state: snap.exists ? snap.data().alerts : null, used, limit });
      if (r.changed) tx.set(ref, { alerts: r.next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return r.notes.commit({ FieldValue });
    });
  } catch (err) {
    console.error("noteLimitReached failed (refusal unaffected):", err?.message);
    return 0;
  }
}

// ---------- Monthly limit check (inside a transaction) ----------

// Reads the business (for the CURRENT effective limit, so a limit changed
// a moment ago is honoured) and the month's usage. `entitlements` (the
// caller's snapshot) is used only when there is no business document at
// all (low-level emulator tests); an existing document always decides, and
// a malformed limit refuses. Throws `error(code,
// message, details)` when the limit is reached; otherwise returns what the
// caller needs to increment and warn.
export async function checkMonthlyLimit(tx, { tenant, meterId, timezone, now, error, entitlements = null }) {
  const m = METERS[meterId];
  const period = monthKey(timezone, now);
  const [biz, usage] = await Promise.all([tx.get(tenant.ref), tx.get(usageMonthRef(tenant, period))]);
  const limit = effectiveLimit(biz.exists ? biz.data().entitlements : entitlements, m.limitKey);
  if (limit === null) throw error("business-misconfigured", `This business has no valid ${m.label.toLowerCase()} limit`);
  const used = usage.exists ? nonNegative(usage.data()[meterId]) : 0;
  if (used >= limit) throw error(m.limitKey === "importsPerMonth" ? "import-limit-reached" : "order-limit-reached", `This month's ${m.label.toLowerCase()} limit (${limit}) has been reached. Contact Luna to raise it.`, { meterId, used, limit, period });
  return { period, used, limit };
}

// ---------- Reads ----------

export async function readStorageCurrent(tenant) {
  const snap = await usageCurrentRef(tenant, "storage").get();
  const d = snap.exists ? snap.data() : {};
  return { bytes: nonNegative(d.bytes), reservedBytes: nonNegative(d.reservedBytes), objects: nonNegative(d.objects), recountedAt: d.recountedAt ?? null, measured: snap.exists };
}

// Current values of every meter: this month's counters, active users and
// stored bytes.
export async function readCurrentUsage(tenant, timezone, now = new Date()) {
  const period = monthKey(timezone, now);
  const [month, active, storage] = await Promise.all([usageMonthRef(tenant, period).get(), tenant.collection("members").where("status", "==", "active").count().get(), readStorageCurrent(tenant)]);
  const m = month.exists ? month.data() : {};
  const values = { activeUsers: active.data().count, storageBytes: storage.bytes };
  for (const id of MONTHLY_METER_IDS) values[id] = nonNegative(m[id]);
  return { period, recorded: month.exists, values, storage };
}

// The last `months` months, newest first (shared/metering.js historyRows).
export async function readUsageHistory(tenant, timezone, { months = 12, now = new Date() } = {}) {
  const periods = previousPeriods(monthKey(timezone, now), Math.min(24, Math.max(1, months)));
  const snaps = await Promise.all(periods.map((p) => usageMonthRef(tenant, p).get()));
  return historyRows(
    periods,
    snaps.map((s) => (s.exists ? s.data() : null))
  );
}

export { LIMIT_METER, MeteringError };
