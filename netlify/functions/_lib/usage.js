// Read side of usage metering. Counters at businesses/{bid}/usage/{YYYY-MM}
// are written only by server functions (from Phase 7 on); here we only
// read them for display. The month is computed in the BUSINESS's timezone.
// Phase 18: the meters and their kinds come from shared/metering.js
// (./metering.js reads them); file storage is a running total at
// usageCurrent/storage, not a monthly counter.

import { readCurrentUsage } from "./metering.js";

export function monthKey(timezone, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit" }).formatToParts(now);
  }
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}`;
}

// The session's usage block (members with billing.view): every meter's
// current value (`values`, keyed by meter id), plus the original fields.
export async function readUsageSummary(tenant, timezone, now = new Date()) {
  const u = await readCurrentUsage(tenant, timezone, now);
  return {
    period: u.period,
    values: u.values,
    storage: { bytes: u.storage.bytes, reservedBytes: u.storage.reservedBytes, objects: u.storage.objects, measured: u.storage.measured },
    users: u.values.activeUsers,
    ordersThisMonth: u.values.ordersCreated,
    storageBytes: u.values.storageBytes,
    importsThisMonth: u.values.excelImports,
  };
}
