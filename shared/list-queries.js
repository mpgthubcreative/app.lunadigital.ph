// What each list's filters MEAN, defined once (Phase 12.5). The browser
// lists (src/lib/query.js -> Firestore lite, under the rules) and the server
// exports (netlify/functions/_lib/export-core.js -> Admin SDK) both run
// these specs, so "Download Excel" contains exactly the rows the filtered
// list shows, across all of its pages.
//
// spec = { parts: [{ where: [[field, op, value]], orderBy: [[field, dir]], limit? }], keep?, sort? }
//   One part:  a paginated list. orderBy ends with ID (the document id) where
//              equal sort values are possible, so pages never skip or repeat.
//   Several parts (searches): each part is read, merged by document id, then
//              filtered by `keep` and ordered by `sort`. A search isn't
//              paginated in the list (it shows the first matches); an export
//              returns every match.
// Field names, operators and values come only from here: a request can
// never name a field, collection or sort key (filters are validated first,
// shared/exports.js).

export const ID = "__id__";
const PREFIX_END = "";
const lower = (s) => String(s).trim().toLocaleLowerCase("en");
const prefix = (field, term) => [
  [field, ">=", term],
  [field, "<=", `${term}${PREFIX_END}`],
];
const byNameThenId = (a, b) => (a.nameLower < b.nameLower ? -1 : a.nameLower > b.nameLower ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// filters: { fulfillmentStatus?, paymentStatus?, source?, from?, to? } (business-local days)
export function ordersQuery(f = {}) {
  const where = [];
  for (const k of ["fulfillmentStatus", "paymentStatus", "source"]) if (f[k]) where.push([k, "==", f[k]]);
  if (f.from && f.to && f.from === f.to) return { parts: [{ where: [...where, ["orderDate", "==", f.from]], orderBy: [["createdAt", "desc"]] }] };
  if (f.from || f.to) {
    if (f.from) where.push(["orderDate", ">=", f.from]);
    if (f.to) where.push(["orderDate", "<=", f.to]);
    return { parts: [{ where, orderBy: [["orderDate", "desc"], ["createdAt", "desc"]] }] };
  }
  return { parts: [{ where, orderBy: [["createdAt", "desc"]] }] };
}

// filters: { state?, method?, from?, to? } (received day, business-local)
export function paymentsQuery(f = {}) {
  const where = [];
  for (const k of ["state", "method"]) if (f[k]) where.push([k, "==", f[k]]);
  if (f.from && f.to && f.from === f.to) return { parts: [{ where: [...where, ["receivedDay", "==", f.from]], orderBy: [["createdAt", "desc"]] }] };
  if (f.from || f.to) {
    if (f.from) where.push(["receivedDay", ">=", f.from]);
    if (f.to) where.push(["receivedDay", "<=", f.to]);
    return { parts: [{ where, orderBy: [["receivedDay", "desc"], ["createdAt", "desc"]] }] };
  }
  return { parts: [{ where, orderBy: [["createdAt", "desc"]] }] };
}

// filters: { status ("active"|"inactive"), lowOnly?, search? (name prefix or exact SKU), category? (exact, any case) }
export function productsQuery(f = {}) {
  const status = f.status || "active";
  const cat = f.category ? lower(f.category) : "";
  const term = (f.search || "").trim();
  if (term) {
    return {
      parts: [
        { where: [["status", "==", status], ...prefix("nameLower", lower(term))], orderBy: [["nameLower", "asc"]] },
        { where: [["sku", "==", term.toUpperCase()]], orderBy: [], limit: 1 },
      ],
      keep: (p) => p.status === status && (!f.lowOnly || p.isLowStock === true) && (!cat || p.categoryLower === cat),
      sort: byNameThenId,
    };
  }
  const where = [["status", "==", status]];
  if (f.lowOnly) where.push(["isLowStock", "==", true]);
  if (cat) where.push(["categoryLower", "==", cat]);
  return { parts: [{ where, orderBy: [["nameLower", "asc"], [ID, "asc"]] }] };
}

// filters: { status ("active"|"inactive"), search? (name prefix) }
export function customersQuery(f = {}) {
  const status = f.status || "active";
  const term = f.search ? lower(f.search) : "";
  if (term) return { parts: [{ where: [["status", "==", status], ...prefix("nameLower", term)], orderBy: [["nameLower", "asc"], [ID, "asc"]] }] };
  return { parts: [{ where: [["status", "==", status]], orderBy: [["nameLower", "asc"], [ID, "asc"]] }] };
}

// filters: { status ("active"|"removed"), from?, to?, category?, method?, providerId? (Baby), search? (payee prefix or exact reference) }
export function expensesQuery(f = {}) {
  const status = f.status || "active";
  const term = (f.search || "").trim();
  if (term) {
    return {
      parts: [
        { where: [["status", "==", status], ...prefix("payeeLower", lower(term))], orderBy: [["payeeLower", "asc"]] },
        { where: [["status", "==", status], ["reference", "==", term]], orderBy: [] },
      ],
      // A search still honours the other filters.
      keep: (e) => (!f.category || e.category === f.category) && (!f.method || e.method === f.method) && (!f.providerId || e.providerId === f.providerId) && (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to),
      sort: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    };
  }
  const where = [["status", "==", status]];
  if (f.category) where.push(["category", "==", f.category]);
  if (f.providerId) where.push(["providerId", "==", f.providerId]);
  if (f.method) where.push(["method", "==", f.method]);
  if (f.from) where.push(["date", ">=", f.from]);
  if (f.to) where.push(["date", "<=", f.to]);
  return { parts: [{ where, orderBy: [["date", "desc"], [ID, "desc"]] }] };
}

// ---------- Household payroll (Phase 14) ----------

// filters: { status? } (active by default)
export function householdStaffQuery(f = {}) {
  return { parts: [{ where: [["status", "==", f.status || "active"]], orderBy: [["nameLower", "asc"], [ID, "asc"]] }] };
}

// filters: { staffId?, status?, from?, to? } (business-local days). One
// person's timesheet reads oldest first; a day / range across everyone too.
export function attendanceQuery(f = {}) {
  const where = [];
  if (f.staffId) where.push(["staffId", "==", f.staffId]);
  if (f.status) where.push(["status", "==", f.status]);
  if (f.from && f.to && f.from === f.to) where.push(["date", "==", f.from]);
  else {
    if (f.from) where.push(["date", ">=", f.from]);
    if (f.to) where.push(["date", "<=", f.to]);
  }
  return { parts: [{ where, orderBy: [["date", "asc"], [ID, "asc"]] }] };
}

// filters: { staffId?, status?, receiptStatus?, from?, to? } on the period start; newest first.
export function payrollsQuery(f = {}) {
  const where = [];
  if (f.staffId) where.push(["staffId", "==", f.staffId]);
  if (f.status) where.push(["status", "==", f.status]);
  if (f.receiptStatus) where.push(["receiptStatus", "==", f.receiptStatus]);
  if (f.from) where.push(["periodStart", ">=", f.from]);
  if (f.to) where.push(["periodStart", "<=", f.to]);
  return { parts: [{ where, orderBy: [["periodStart", "desc"], [ID, "desc"]] }] };
}

// filters: { staffId?, status?, from?, to? } on the advance date; newest first.
export function advancesQuery(f = {}) {
  const where = [];
  if (f.staffId) where.push(["staffId", "==", f.staffId]);
  if (f.status) where.push(["status", "==", f.status]);
  if (f.from) where.push(["date", ">=", f.from]);
  if (f.to) where.push(["date", "<=", f.to]);
  return { parts: [{ where, orderBy: [["date", "desc"], [ID, "desc"]] }] };
}

// ---------- Baby Expense Tracker (Phase 15) ----------

// Every category (a budget has at most MAX_CATEGORIES lines), display order.
export function categoriesQuery() {
  return { parts: [{ where: [], orderBy: [["order", "asc"], [ID, "asc"]] }] };
}

// filters: { status (active by default), type?, search? (name prefix) }
export function providersQuery(f = {}) {
  const where = [["status", "==", f.status || "active"]];
  if (f.type) where.push(["type", "==", f.type]);
  const term = f.search ? lower(f.search) : "";
  if (term) return { parts: [{ where: [...where, ...prefix("nameLower", term)], orderBy: [["nameLower", "asc"], [ID, "asc"]] }] };
  return { parts: [{ where, orderBy: [["nameLower", "asc"], [ID, "asc"]] }] };
}

// filters: { status? (upcoming by default), category?, providerId?, from?, to? } on the due date.
// Upcoming reads soonest first; Paid / Cancelled most recent first.
export function scheduledPaymentsQuery(f = {}) {
  const status = f.status || "upcoming";
  const where = [["status", "==", status]];
  if (f.category) where.push(["category", "==", f.category]);
  if (f.providerId) where.push(["providerId", "==", f.providerId]);
  if (f.from) where.push(["dueDate", ">=", f.from]);
  if (f.to) where.push(["dueDate", "<=", f.to]);
  const dir = status === "upcoming" ? "asc" : "desc";
  return { parts: [{ where, orderBy: [["dueDate", dir], [ID, dir]] }] };
}

// Merges search parts: by id, then keep, then sort.
export function mergeParts(spec, partRows) {
  const seen = new Map();
  for (const rows of partRows) for (const r of rows) seen.set(r.id, r);
  let rows = [...seen.values()];
  if (spec.keep) rows = rows.filter(spec.keep);
  if (spec.sort) rows.sort(spec.sort);
  return rows;
}
