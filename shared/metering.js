// Luna Usage Metering (Phase 18): the shared registry. One definition of
// every usage counter, used by enforcement (server), warnings, the tenant
// Settings page, the Super Admin console, usage history and the recount
// tool. Nothing else keeps its own list of counters.
//
// Two kinds:
//   monthly  activity in a calendar month of the BUSINESS's timezone, at
//            businesses/{bid}/usage/{YYYY-MM}. Only ever incremented, in the
//            same transaction (or batch) as the record it measures; deleting
//            or cancelling the record never decrements it (it measures
//            activity, not how many records exist now).
//   running  a current total that can go up and down:
//            activeUsers   live count of ACTIVE memberships (no counter)
//            storageBytes  bytes retained in object storage, at
//                          businesses/{bid}/usageCurrent/storage
//
// Commercial limits: a meter with a limitKey is ENFORCED against the
// business's effective limit (entitlements.limits[limitKey] = the plan's
// limit, or the operator's per-business override). Every other meter is
// informational: never enforced, never warned about.
//
// Applicability: `module` null = every workspace; otherwise the meter only
// means something while that module is enabled for the business.

import { LIMIT_DEFINITIONS, LIMIT_KEYS } from "./plans.seed.js";

export const METER_KINDS = Object.freeze({ monthly: "Per month", running: "Current total" });

// `since`: the first month this counter was recorded (null = since the
// start of metering). Earlier months show "not metered", never 0. Counters
// added in Phase 18 start mid-October 2026, so that first month is partial.
const P18 = "2026-10";

export const METERS = Object.freeze({
  activeUsers: {
    kind: "running",
    label: "Active users",
    unit: "count",
    limitKey: "users",
    module: null,
    definition: "Memberships with status Active right now (a live count, not a stored counter). Deactivated members don't count.",
  },
  storageBytes: {
    kind: "running",
    label: "File storage",
    unit: "bytes",
    limitKey: "storageBytes",
    module: null,
    since: P18,
    definition: "Bytes of files Luna keeps for the business in object storage (payment screenshots today). Measured by the server from the stored bytes; goes down only when a stored file is actually deleted.",
  },
  ordersCreated: {
    kind: "monthly",
    label: "Orders",
    unit: "count",
    limitKey: "ordersPerMonth",
    module: "orders",
    recordCreation: true,
    since: null,
    definition: "Orders created this month. Deleting or cancelling an order doesn't give the slot back.",
  },
  excelImports: {
    kind: "monthly",
    label: "Spreadsheet imports",
    unit: "count",
    limitKey: "importsPerMonth",
    module: "imports",
    since: null,
    definition: "Spreadsheet imports committed this month (counted when the import starts writing rows). Imported rows aren't counted as records created.",
  },
  exportsGenerated: {
    kind: "monthly",
    label: "Excel exports",
    unit: "count",
    limitKey: null,
    module: null,
    since: null,
    definition: "Excel files generated this month (every dataset and the reports workbook).",
  },
  rowsExported: {
    kind: "monthly",
    label: "Rows exported",
    unit: "count",
    limitKey: null,
    module: null,
    since: null,
    definition: "Data rows written into Excel exports this month (sum over all exports).",
  },
  paymentsRecorded: {
    kind: "monthly",
    label: "Customer payments recorded",
    unit: "count",
    limitKey: null,
    module: "payments",
    recordCreation: true,
    since: P18,
    definition: "Customer payments recorded against orders this month. Voiding a payment doesn't decrement it.",
  },
  expensesCreated: {
    kind: "monthly",
    label: "Expenses recorded",
    unit: "count",
    limitKey: null,
    module: "expenses",
    recordCreation: true,
    since: P18,
    definition: "Expense records created this month, including the expense Luna records when a scheduled or supplier payment is marked Paid. Removing an expense doesn't decrement it.",
  },
  scheduledPaymentsPaid: {
    kind: "monthly",
    label: "Scheduled payments paid",
    unit: "count",
    limitKey: null,
    module: "schedule",
    since: P18,
    definition: "Baby payment-schedule items marked Paid this month (the expense each one records is counted in Expenses recorded).",
  },
  supplierPaymentsPaid: {
    kind: "monthly",
    label: "Supplier payments paid",
    unit: "count",
    limitKey: null,
    module: "vendorpayments",
    since: P18,
    definition: "Wedding supplier payments marked Paid this month (the expense each one records is counted in Expenses recorded).",
  },
  guestsAdded: {
    kind: "monthly",
    label: "Guests added",
    unit: "count",
    limitKey: null,
    module: "guests",
    recordCreation: true,
    since: P18,
    definition: "Wedding guests added this month. Removing a guest doesn't decrement it.",
  },
  payrollsReleased: {
    kind: "monthly",
    label: "Payroll runs released",
    unit: "count",
    limitKey: null,
    module: "payroll",
    since: P18,
    definition: "Salaries released this month (one payroll per staff member per pay period). Drafts prepared and then deleted never count.",
  },
});

export const METER_IDS = Object.freeze(Object.keys(METERS));
export const MONTHLY_METER_IDS = Object.freeze(METER_IDS.filter((id) => METERS[id].kind === "monthly"));
export const RUNNING_METER_IDS = Object.freeze(METER_IDS.filter((id) => METERS[id].kind === "running"));
// "Records created" = the sum of these: each counts distinct user-created
// operational records exactly once (a payment marked Paid isn't a new
// record; the expense it creates is already in expensesCreated). Imported
// rows, audit entries, notifications, metrics, usage, history, locks and
// entitlement snapshots are never records created.
export const RECORD_CREATION_METER_IDS = Object.freeze(METER_IDS.filter((id) => METERS[id].recordCreation === true));

// Every commercial limit has exactly one meter (checked at load).
export const LIMIT_METER = Object.freeze(Object.fromEntries(METER_IDS.filter((id) => METERS[id].limitKey).map((id) => [METERS[id].limitKey, id])));
for (const key of LIMIT_KEYS) if (!LIMIT_METER[key]) throw new Error(`metering: limit ${key} has no meter`);
for (const id of METER_IDS) if (METERS[id].limitKey && !LIMIT_KEYS.includes(METERS[id].limitKey)) throw new Error(`metering: ${id} names an unknown limit`);
export const ENFORCED_METER_IDS = Object.freeze(Object.values(LIMIT_METER));
export const isEnforced = (meterId) => Boolean(METERS[meterId]?.limitKey);

export class MeteringError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Does this meter apply to a business with these entitlements?
export function meterApplies(meterId, entitlements) {
  const m = METERS[meterId];
  if (!m) return false;
  return m.module === null || entitlements?.modules?.[m.module] === true;
}

// ---------- Limits ----------

// Operator overrides of a plan limit: recognised limit keys only, whole
// numbers within a sane ceiling. `null` = remove the override (plan default).
export const LIMIT_OVERRIDE_MAX = Object.freeze({ users: 10_000, ordersPerMonth: 10_000_000, storageBytes: 10 * 1024 ** 4, importsPerMonth: 100_000 });
export function validateLimitOverride(limitKey, value) {
  if (typeof limitKey !== "string" || !LIMIT_KEYS.includes(limitKey)) throw new MeteringError("unknown-limit", `Unknown limit ${String(limitKey).slice(0, 40)}`);
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new MeteringError("invalid-limit", `${LIMIT_DEFINITIONS[limitKey].label} must be a whole number of 0 or more`);
  if (value > LIMIT_OVERRIDE_MAX[limitKey]) throw new MeteringError("invalid-limit", `${LIMIT_DEFINITIONS[limitKey].label} can't be more than ${LIMIT_OVERRIDE_MAX[limitKey]}`);
  return value;
}

// The effective limit is the snapshot's (plan, or the business override),
// computed by computeEntitlements. A missing / malformed value refuses the
// action instead of skipping the limit.
export function effectiveLimit(entitlements, limitKey) {
  const v = entitlements?.limits?.[limitKey];
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// Limit | Plan | Override | Effective | Current, for the console and Settings.
export function limitRows({ plan = null, overrides = {}, entitlements, usage = {} }) {
  return LIMIT_KEYS.map((limitKey) => {
    const meterId = LIMIT_METER[limitKey];
    const effective = effectiveLimit(entitlements, limitKey);
    const current = Number.isSafeInteger(usage[meterId]) ? usage[meterId] : 0;
    return {
      limitKey,
      meterId,
      label: LIMIT_DEFINITIONS[limitKey].label,
      unit: LIMIT_DEFINITIONS[limitKey].unit,
      kind: METERS[meterId].kind,
      plan: Number.isSafeInteger(plan?.limits?.[limitKey]) ? plan.limits[limitKey] : null,
      override: Object.hasOwn(overrides || {}, limitKey) ? overrides[limitKey] : null,
      effective,
      current,
      percent: usagePercent(current, effective),
      atOrOver: effective !== null && current >= effective,
    };
  });
}

export function usagePercent(used, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return null;
  return Math.round((used / limit) * 100);
}

// The warning shown BEFORE an operator saves a lower limit.
export function overrideImpact({ limitKey, value, current }) {
  if (value === null || !Number.isSafeInteger(current) || current < value) return null;
  const meter = METERS[LIMIT_METER[limitKey]];
  const what = LIMIT_DEFINITIONS[limitKey].label;
  const blocked = limitKey === "users" ? "Nobody is deactivated; adding or reactivating members stays blocked until active users are under the limit." : meter.kind === "monthly" ? "Nothing is deleted; further ones are blocked until next month or until the limit is raised." : "Nothing is deleted; new uploads are blocked until usage is under the limit.";
  return `${what}: ${current} already used, at or above the new limit of ${value}. ${blocked}`;
}

// ---------- Warnings (80% / 100%, enforced limits only) ----------

export const WARNING_THRESHOLDS = Object.freeze([80, 100]);
// Usage at which a threshold is reached (whole units, at least 1).
export const thresholdUnits = (limit, pct) => Math.max(1, Math.ceil((limit * pct) / 100));

// Monthly meters: a threshold fires when usage crosses it (before < need
// <= after). One notification per business + meter + month + threshold
// (the event key); a lowered limit is caught by limitReachedKey on refusal.
export function crossedThresholds(before, after, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  return WARNING_THRESHOLDS.filter((t) => before < thresholdUnits(limit, t) && after >= thresholdUnits(limit, t));
}
export const monthlyAlertKey = (meterId, period, threshold) => `${meterId}-${period}-${threshold}`;

// Running meters (storage, active users): usage episodes. A threshold
// fires once when usage reaches it; it re-arms only after usage falls
// below (threshold - 10)% of the limit, and the next crossing is a new
// episode (a new event key). Repeated uploads above 80% never re-notify.
// state: { "80": { episode, open }, "100": { episode, open } }
export const REARM_GAP = 10;
export function runningAlerts(state, used, limit) {
  const next = {};
  const fire = [];
  let changed = false;
  for (const t of WARNING_THRESHOLDS) {
    const s = state?.[t] && Number.isSafeInteger(state[t].episode) ? { episode: state[t].episode, open: state[t].open === true } : { episode: 0, open: false };
    if (Number.isSafeInteger(limit) && limit > 0) {
      if (s.open && used < Math.ceil((limit * (t - REARM_GAP)) / 100)) {
        s.open = false;
        changed = true;
      } else if (!s.open && used >= thresholdUnits(limit, t)) {
        s.episode += 1;
        s.open = true;
        changed = true;
        fire.push({ threshold: t, episode: s.episode });
      }
    }
    next[t] = s;
  }
  return { fire, next, changed };
}
export const runningAlertKey = (meterId, episode, threshold) => `${meterId}-e${episode}-${threshold}`;

// ---------- History ----------

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isPeriod = (p) => typeof p === "string" && PERIOD.test(p);
// [period, the month before, ...] newest first.
export function previousPeriods(period, count = 12) {
  if (!isPeriod(period)) throw new MeteringError("invalid-period", "Invalid month");
  let [y, m] = period.split("-").map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

// One row per month. A month with no usage document is "no recorded usage"
// (null values), never zeros; a counter that wasn't metered yet that month
// is null too. Inside a recorded month, an absent counter is a real 0.
export function historyRows(periods, docs, meterIds = MONTHLY_METER_IDS) {
  return periods.map((period, i) => {
    const d = docs[i];
    const recorded = Boolean(d);
    const values = {};
    for (const id of meterIds) {
      const since = METERS[id].since;
      if (!recorded || (since && period < since)) values[id] = null;
      else values[id] = Number.isSafeInteger(d[id]) && d[id] >= 0 ? d[id] : 0;
    }
    const parts = RECORD_CREATION_METER_IDS.filter((id) => meterIds.includes(id)).map((id) => values[id]);
    const recordsCreated = parts.some((v) => v !== null) ? parts.reduce((s, v) => s + (v || 0), 0) : null;
    return { period, recorded, timezone: recorded ? (d.timezone ?? null) : null, values, recordsCreated };
  });
}
