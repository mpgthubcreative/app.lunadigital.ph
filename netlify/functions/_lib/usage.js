// Read side of usage metering. Counters at businesses/{bid}/usage/{YYYY-MM}
// are written only by server functions (from Phase 7 on); here we only
// read them for display. The month is computed in the BUSINESS's timezone.

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

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function readUsageSummary(tenant, timezone) {
  const period = monthKey(timezone);
  const [usageSnap, activeMembers] = await Promise.all([
    tenant.doc("usage", period).get(),
    tenant.collection("members").where("status", "==", "active").count().get(),
  ]);
  const usage = usageSnap.exists ? usageSnap.data() : {};
  return {
    period,
    users: activeMembers.data().count,
    ordersThisMonth: nonNegativeInt(usage.ordersCreated),
    storageBytes: nonNegativeInt(usage.storageBytes),
    importsThisMonth: nonNegativeInt(usage.excelImports),
  };
}
