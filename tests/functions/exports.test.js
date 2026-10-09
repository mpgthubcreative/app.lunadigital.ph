// Phase 12.5: the Export Core on the server. Filter -> View -> Download
// (all matching rows, not one page; nothing that doesn't match), access
// (tenant, membership, module, workspace, view + export permissions),
// money / cost columns only for those allowed AND never read otherwise,
// validated filters, the row limit, formula safety, audit + usage, and the
// Dashboard / Reports workbooks (same figures, period vs current).

import { describe, it, expect, beforeEach } from "vitest";
import { createExportsHandler } from "../../netlify/functions/exports.js";
import { readRows, runExport } from "../../netlify/functions/_lib/export-core.js";
import { RECORD_BUILDERS } from "../../netlify/functions/_lib/exports/records.js";
import { buildReport } from "../../netlify/functions/_lib/reports.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { createBusiness, addMember, ensureAuthUser, updateOverrides } from "../../netlify/functions/_lib/provisioning.js";
import { ordersQuery } from "../../shared/list-queries.js";
import { EXPORT_DATASETS } from "../../shared/export-datasets.js";
import { validateExportFilters, canExport, exportFileName, ExportError } from "../../shared/exports.js";
import { readXlsx } from "../../shared/xlsx.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { FieldPath } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";

const NOW = new Date("2026-10-08T06:00:00Z"); // 14:00 in Manila
let world;
let A;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const seed = (path, data) => world.db.seed(`businesses/biz-a/${path}`, data);
const at = (day, hh = 9) => new Date(`${day}T${String(hh - 8).padStart(2, "0")}:00:00Z`);

async function call(uid, body, businessId) {
  const res = await createExportsHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  if (res.statusCode === 200) return { status: 200, headers: res.headers, bytes: new Uint8Array(Buffer.from(res.body, "base64")) };
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const sheet = (bytes, name) => readXlsx(bytes, { sheet: name, maxRows: 20000 }).rows;
const col = (rows, header) => rows.slice(1).map((r) => r[rows[0].indexOf(header)]);
async function member(key, roleTemplate, overrides = {}, businessId = "biz-a") {
  const u = await ensureAuthUser({ auth: world.auth, email: `${key}@t.test`, name: key });
  await addMember({ ...world, businessId, uid: u.uid, email: u.email, name: key, roleTemplate, permissionOverrides: overrides });
  return u.uid;
}

function order(i, { day = "2026-10-05", pay = "paid", ful = "fulfilled", source = "phone", total = 10000, name = `Customer ${i}` } = {}) {
  const id = `ord${String(i).padStart(17, "0")}`;
  seed(`orders/${id}`, {
    orderNumber: `ORD-${String(i).padStart(5, "0")}`,
    orderDate: day,
    createdAt: new Date(at(day).getTime() + i * 1000),
    customer: { name, phone: "0917" },
    items: [{ lineId: "L1", sku: `SKU-${i}`, name: `Item ${i}`, unit: "pcs", quantity: 2000, unitPrice: total / 2, lineSubtotal: total }],
    itemCount: 1,
    subtotal: total,
    discount: 0,
    total,
    amountPaid: pay === "paid" ? total : 0,
    balance: pay === "paid" ? 0 : total,
    paymentStatus: pay,
    fulfillmentStatus: ful,
    source,
  });
  if (ful === "fulfilled") seed(`orderCosts/${id}`, { cogs: total * 0.6, grossProfit: total * 0.4, lines: [{ lineId: "L1", costConsumed: total * 0.6 }] });
  return id;
}

describe("filters and file names (shared)", () => {
  const d = EXPORT_DATASETS.orders;
  it("valid filters pass; empty ones drop; unknown keys, bad values and bad ranges are refused", () => {
    expect(validateExportFilters(d, { paymentStatus: "paid", source: "", from: "2026-10-01", to: "2026-10-31" })).toEqual({ paymentStatus: "paid", from: "2026-10-01", to: "2026-10-31" });
    expect(() => validateExportFilters(d, { collection: "users" })).toThrow(/Unknown filter collection/);
    expect(() => validateExportFilters(d, { orderBy: "total" })).toThrow(ExportError);
    expect(() => validateExportFilters(d, { paymentStatus: "free" })).toThrow(/Invalid paymentStatus/);
    expect(() => validateExportFilters(d, { from: "2026-13-01" })).toThrow(/date/);
    expect(() => validateExportFilters(d, { from: "2026-10-31", to: "2026-10-01" })).toThrow(/after the end/);
    expect(() => validateExportFilters(d, { from: "2025-01-01", to: "2026-10-01" })).toThrow(/at most 366 days/);
    expect(() => validateExportFilters(d, [])).toThrow(/Invalid filters/);
    expect(() => validateExportFilters(EXPORT_DATASETS.dashboard, {})).toThrow(/start and end/);
    expect(() => validateExportFilters(EXPORT_DATASETS.dashboard, { from: "2026-10-01", to: "2026-10-09" }, { today: "2026-10-08" })).toThrow(/after today/);
    expect(() => validateExportFilters(EXPORT_DATASETS.expenses, { status: "removed" })).toThrow(/Invalid status/);
  });
  it("file names are safe and say the period", () => {
    expect(exportFileName("Orders", { from: "2026-10-01", to: "2026-10-31" })).toBe("Luna_Orders_2026-10-01_to_2026-10-31.xlsx");
    expect(exportFileName("Inventory", { day: "2026-10-08" })).toBe("Luna_Inventory_2026-10-08.xlsx");
    expect(exportFileName('Ana\'s "Store"/../x', { day: "2026-10-08" })).toBe("Luna_Ana_s_Store_x_2026-10-08.xlsx");
  });
  it("who may export: Owner and Manager yes, Staff no; Reports keeps reports.export", () => {
    const ent = world.db.docs.get("businesses/biz-a").entitlements;
    const can = (role, id, o) => canExport({ entitlements: ent, permissions: resolvePermissions(role, o) }, EXPORT_DATASETS[id]);
    expect(can("owner", "orders")).toBe(true);
    expect(can("manager", "orders")).toBe(true);
    expect(can("staff", "orders")).toBe(false);
    expect(can("manager", "orders", { revoke: ["data.export"] })).toBe(false);
    expect(can("manager", "reports", { revoke: ["data.export"] })).toBe(true);
    expect(can("manager", "reports", { revoke: ["reports.export"] })).toBe(false);
    expect(can("staff", "orders", { grant: ["data.export"] })).toBe(true); // explicit grant: orders.view + data.export
    expect(can("staff", "expenses", { grant: ["data.export"] })).toBe(false); // no expenses.view
  });
});

describe("reading every matching row", () => {
  it("pages of 1,000 never skip or repeat a row (2,345 orders), in the list's order", async () => {
    for (let i = 0; i < 2345; i++) order(i, { day: `2026-10-0${1 + (i % 7)}` });
    const rows = await readRows({ tenant: A, collection: "orders", spec: ordersQuery({ from: "2026-10-01", to: "2026-10-07" }), FieldPath, max: 10000 });
    expect(rows).toHaveLength(2345);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2345);
    const keys = rows.map((r) => `${r.orderDate}|${String(r.createdAt.getTime()).padStart(15, "0")}`);
    expect([...keys].sort().reverse()).toEqual(keys);
  });
  it("over the limit is refused, never truncated", async () => {
    for (let i = 0; i < 30; i++) order(i);
    await expect(readRows({ tenant: A, collection: "orders", spec: ordersQuery({}), FieldPath, max: 29 })).rejects.toMatchObject({ code: "too-many-rows", message: "This export contains too many rows. Narrow your filters and try again." });
    expect(await readRows({ tenant: A, collection: "orders", spec: ordersQuery({}), FieldPath, max: 30 })).toHaveLength(30);
  });
});

describe("POST /api/exports — access", () => {
  const body = { dataset: "orders", filters: {} };
  it("401 without a token; staff (no data.export) 403; manager 200 with an .xlsx", async () => {
    expect((await createExportsHandler({ getAdmin: async () => world })({ ...request({ method: "POST" }), body: "{}" })).statusCode).toBe(401);
    expect((await call(world.uids.staffa, body)).status).toBe(403);
    const ok = await call(world.uids.managera, body);
    expect(ok.status).toBe(200);
    expect(ok.headers["Content-Type"]).toMatch(/spreadsheetml/);
    expect(ok.headers["Content-Disposition"]).toBe('attachment; filename="Luna_Orders_2026-10-08.xlsx"');
    expect(ok.headers["Cache-Control"]).toBe("no-store");
  });
  it("A can't export B: selecting B is denied; nothing of B's appears in A's file", async () => {
    world.db.seed("businesses/biz-b/orders/ordBBBBBBBBBBBBBBBBB", { orderNumber: "B-SECRET", orderDate: "2026-10-05", createdAt: NOW, items: [], customer: { name: "B" } });
    order(1);
    const denied = await call(world.uids.ownera, body, "biz-b");
    expect(denied).toMatchObject({ status: 403, body: { error: "business-access-denied" } });
    const mine = await call(world.uids.ownera, body);
    expect(col(sheet(mine.bytes, "Orders"), "Order #")).toEqual(["ORD-00001"]);
  });
  it("a disabled module, a workspace without it, a missing view permission: refused", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { expenses: false } }, actor: "t", reason: "off" });
    expect((await call(world.uids.ownera, { dataset: "expenses" })).status).toBe(403);
    await createBusiness({ ...world, name: "Wedding", planId: "pro", workspaceTemplateId: "bridal-expense", businessId: "biz-w" });
    const w = await member("ownerw", "owner", {}, "biz-w");
    for (const dataset of ["orders", "inventory", "customers", "payments", "reports"]) expect((await call(w, { dataset }, "biz-w")).status).toBe(403);
    const noView = await member("noview", "manager", { revoke: ["orders.view"] });
    expect((await call(noView, body)).status).toBe(403);
  });
  it("unknown datasets, fields and filters are 400s; never a query of the caller's choosing", async () => {
    expect((await call(world.uids.ownera, { dataset: "members" })).status).toBe(400);
    expect((await call(world.uids.ownera, { dataset: "orders", collection: "members" })).status).toBe(400);
    expect((await call(world.uids.ownera, { dataset: "orders", filters: { "createdBy.uid": "x" } })).body.error).toBe("invalid-filters");
    expect((await call(world.uids.ownera, { dataset: "orders", filters: { from: "2025-01-01", to: "2026-10-01" } })).body.error).toBe("invalid-range");
    expect((await call(world.uids.ownera, { dataset: "dashboard", filters: { from: "2026-10-01", to: "2026-10-09" } })).body.error).toBe("invalid-range");
  });
  it("too many rows -> 413 with the plain message", async () => {
    for (let i = 0; i < 6; i++) order(i);
    const ctx = { ...(await ctxFor(world.uids.ownera)) };
    await expect(runExport({ db: world.db, ctx, admin: world.admin, descriptor: EXPORT_DATASETS.orders, builder: RECORD_BUILDERS.orders, rawFilters: {}, now: NOW, maxRows: 5 })).rejects.toMatchObject({ code: "too-many-rows" });
  });
});

async function ctxFor(uid) {
  const { requireTenant } = await import("../../netlify/functions/_lib/tenant.js");
  const ctx = await requireTenant(request({ uid, method: "POST" }), { db: world.db, auth: world.auth });
  return ctx;
}

describe("Orders: filter -> view -> download", () => {
  it("exactly the matching orders across all pages; non-matching ones absent; amounts and labels", async () => {
    const match = [];
    for (let i = 1; i <= 60; i++) match.push(order(i, { day: "2026-10-03", total: 12345 }));
    order(100, { pay: "unpaid", ful: "fulfilled" });
    order(101, { pay: "paid", ful: "pending" });
    order(102, { day: "2026-09-30" });
    const r = await call(world.uids.ownera, { dataset: "orders", filters: { paymentStatus: "paid", fulfillmentStatus: "fulfilled", from: "2026-10-01", to: "2026-10-31" } });
    const rows = sheet(r.bytes, "Orders");
    expect(rows[0]).toEqual(["Order #", "Order date", "Created", "Customer", "Phone", "Items", "Lines", "Subtotal", "Discount", "Total", "Amount paid", "Balance", "Payment", "Fulfillment", "Source", "Last payment ref", "COGS", "Gross profit"]);
    expect(rows).toHaveLength(61);
    expect(new Set(col(rows, "Order #"))).toEqual(new Set(Array.from({ length: 60 }, (_, i) => `ORD-${String(i + 1).padStart(5, "0")}`)));
    expect(new Set(col(rows, "Total"))).toEqual(new Set(["123.45"]));
    expect(new Set(col(rows, "Payment"))).toEqual(new Set(["Paid"]));
    expect(col(rows, "Order date")[0]).toBe("46298"); // 2026-10-03 as an Excel date
    expect(col(rows, "COGS")[0]).toBe("74.07");
    expect(sheet(r.bytes, "Order lines")).toHaveLength(61);
    expect(r.headers["Content-Disposition"]).toContain("Luna_Orders_2026-10-01_to_2026-10-31.xlsx");
    expect(r.headers["X-Luna-Export-Rows"]).toBe("60");
  });

  it("no dashboard.financials: no COGS / profit columns AND orderCosts is never read", async () => {
    order(1);
    const reads = [];
    const getAll = world.db.getAll.bind(world.db);
    world.db.getAll = (...refs) => (reads.push(...refs.map((r) => r.path)), getAll(...refs));
    const m = await member("nofin", "manager", { revoke: ["dashboard.financials"] });
    const rows = sheet((await call(m, { dataset: "orders" })).bytes, "Orders");
    expect(rows[0]).not.toContain("COGS");
    expect(rows[0]).not.toContain("Gross profit");
    expect(sheet((await call(m, { dataset: "orders" })).bytes, "Order lines")[0]).not.toContain("Line COGS");
    expect(reads.filter((p) => p.includes("/orderCosts/"))).toEqual([]);
  });
});

describe("Inventory, Products, Customers, Payments, Expenses", () => {
  beforeEach(() => {
    seed("products/p1", { sku: "W-1", name: "Wings", nameLower: "wings", category: "Frozen", categoryLower: "frozen", unit: "kg", sellingPrice: 25050, reorderLevel: 5000, onHand: 12500, reserved: 2500, available: 10000, isLowStock: false, status: "active" });
    seed("products/p2", { sku: "T-1", name: "Thighs", nameLower: "thighs", category: "Frozen", categoryLower: "frozen", unit: "kg", sellingPrice: 19900, reorderLevel: 5000, onHand: 1000, reserved: 0, available: 1000, isLowStock: true, status: "active" });
    seed("products/p3", { sku: "S-1", name: "Sauce", nameLower: "sauce", category: "Condiments", categoryLower: "condiments", unit: "bottle", sellingPrice: 5000, reorderLevel: 0, onHand: 0, reserved: 0, available: 0, isLowStock: false, status: "inactive" });
    seed("productCosts/p1", { avgCostUnits: 150000000, inventoryValue: 0 });
    seed("productCosts/p2", { avgCostUnits: 140000000, inventoryValue: 0 });
  });

  it("inventory honours category + low-stock filters; costs only with inventory.costs (never read without)", async () => {
    const all = sheet((await call(world.uids.ownera, { dataset: "inventory", filters: { category: "FROZEN" } })).bytes, "Inventory");
    expect(col(all, "SKU")).toEqual(["T-1", "W-1"]);
    expect(col(all, "On hand")).toEqual(["1", "12.5"]);
    expect(col(all, "Average cost")).toEqual(["140", "150"]);
    expect(col(all, "Inventory value (est.)")).toEqual(["140", "1875"]);
    expect(col(sheet((await call(world.uids.ownera, { dataset: "inventory", filters: { lowOnly: true } })).bytes, "Inventory"), "SKU")).toEqual(["T-1"]);
    const reads = [];
    const getAll = world.db.getAll.bind(world.db);
    world.db.getAll = (...refs) => (reads.push(...refs.map((r) => r.path)), getAll(...refs));
    const noCost = await member("nocost", "manager", { revoke: ["inventory.costs"] });
    const rows = sheet((await call(noCost, { dataset: "inventory" })).bytes, "Inventory");
    expect(rows[0]).not.toContain("Average cost");
    expect(rows[0]).not.toContain("Inventory value (est.)");
    expect(reads).toEqual([]);
  });

  it("products: the product list (no stock or cost); search = name prefix or exact SKU; status", async () => {
    const rows = sheet((await call(world.uids.ownera, { dataset: "products", filters: { search: "w" } })).bytes, "Products");
    expect(rows).toEqual([["SKU", "Product", "Category", "Unit", "Selling price", "Reorder level", "Status"], ["W-1", "Wings", "Frozen", "kg", "250.5", "5", "Active"]]);
    expect(col(sheet((await call(world.uids.ownera, { dataset: "products", filters: { search: "t-1" } })).bytes, "Products"), "SKU")).toEqual(["T-1"]);
    expect(col(sheet((await call(world.uids.ownera, { dataset: "products", filters: { status: "inactive" } })).bytes, "Products"), "SKU")).toEqual(["S-1"]);
  });

  it("customers: formula-like text is neutralised; statistics exported as stored", async () => {
    seed("customers/c1", { name: '=HYPERLINK("http://x","Click")', nameLower: '=hyperlink("http://x","click")', phone: "+639171234567", status: "active", stats: { orderCount: 3, totalOrdered: 150000, outstandingBalance: 2500, lastOrderNumber: "ORD-9", lastOrderAt: NOW } });
    const r = await call(world.uids.managera, { dataset: "customers" });
    const rows = sheet(r.bytes, "Customers");
    expect(col(rows, "Customer")).toEqual(['\'=HYPERLINK("http://x","Click")']);
    expect(col(rows, "Phone")).toEqual(["'+639171234567"]);
    expect(col(rows, "Total ordered")).toEqual(["1500"]);
    expect(col(rows, "Outstanding balance")).toEqual(["25"]);
  });

  it("payments: date range on the received day; proof is Yes/No, never a path or URL", async () => {
    seed("payments/pay1", { orderNumber: "ORD-1", customerName: "A", amount: 100000, method: "gcash", reference: "G1", state: "verified", proof: { path: "tenants/biz-a/payments/pay1.png", contentType: "image/png" }, receivedAt: at("2026-10-02"), receivedDay: "2026-10-02", createdAt: at("2026-10-02") });
    seed("payments/pay2", { orderNumber: "ORD-2", customerName: "B", amount: 5000, method: "cash", reference: null, state: "for_verification", proof: null, receivedAt: at("2026-09-28"), receivedDay: "2026-09-28", createdAt: at("2026-09-28") });
    const r = await call(world.uids.ownera, { dataset: "payments", filters: { from: "2026-10-01", to: "2026-10-31" } });
    const rows = sheet(r.bytes, "Payments");
    expect(col(rows, "Order #")).toEqual(["ORD-1"]);
    expect(col(rows, "Proof attached")).toEqual(["Yes"]);
    expect(col(rows, "Method")).toEqual(["GCash"]);
    expect(Buffer.from(r.bytes).toString("latin1")).not.toContain("tenants/");
  });

  it("expenses: active only (removed never exported); search still honours the other filters", async () => {
    seed("expenses/e1", { date: "2026-10-02", category: "rent", amount: 1500000, payee: "Landlord", payeeLower: "landlord", method: "bank_transfer", reference: "R1", status: "active", recurring: true });
    seed("expenses/e2", { date: "2026-10-03", category: "utilities", amount: 300000, payee: "Meralco", payeeLower: "meralco", method: "cash", reference: null, status: "removed" });
    seed("expenses/e3", { date: "2026-09-03", category: "rent", amount: 1500000, payee: "Landlord", payeeLower: "landlord", method: "bank_transfer", reference: null, status: "active" });
    const rows = sheet((await call(world.uids.ownera, { dataset: "expenses", filters: { from: "2026-10-01", to: "2026-10-31" } })).bytes, "Expenses");
    expect(rows.slice(1).map((r) => [r[1], r[2], r[5], r[6]])).toEqual([["Rent", "Landlord", "15000", "Yes"]]);
    expect(col(sheet((await call(world.uids.ownera, { dataset: "expenses", filters: { search: "land", from: "2026-10-01" } })).bytes, "Expenses"), "Reference")).toEqual(["R1"]);
  });

  it("every export leaves one small audit entry (no exported data) and counts usage", async () => {
    await call(world.uids.ownera, { dataset: "inventory", filters: { category: "Frozen" } });
    const audit = [...world.db.docs.entries()].filter(([p, d]) => p.startsWith("businesses/biz-a/auditLog/") && d.type === "export.generated").map(([, d]) => d);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ dataset: "inventory", filters: { category: "Frozen" }, rowCount: 2 });
    expect(JSON.stringify(audit[0])).not.toContain("Wings");
    expect(world.db.docs.get("businesses/biz-a/usage/2026-10")).toMatchObject({ exportsGenerated: 1, rowsExported: 2 });
  });
});

describe("Dashboard and Reports workbooks", () => {
  const fin = (o) => ({ grossSales: 0, discounts: 0, returns: 0, cogs: 0, operatingExpenses: 0, paymentsReceived: 0, ...o });
  const ops = (o) => ({ orderCount: 0, fulfilledOrders: 0, cancelledOrders: 0, unpaidOrders: 0, pendingFulfillment: 0, lowStockProducts: 0, ...o });
  beforeEach(() => {
    seed("financialMetrics/2026-10-07", fin({ grossSales: 1000000, cogs: 600000, operatingExpenses: 150000, paymentsReceived: 1200000 }));
    seed("financialMetrics/2026-10-08", fin({ grossSales: 500000, cogs: 300000, paymentsReceived: 0 }));
    seed("metrics/2026-10-07", ops({ orderCount: 2, fulfilledOrders: 2 }));
    seed("metrics/2026-10-08", ops({ orderCount: 1, fulfilledOrders: 1 }));
    seed("metrics/current", ops({ unpaidOrders: 4, pendingFulfillment: 3, lowStockProducts: 7 }));
    seed("financialMetrics/current", { receivablesOutstanding: 300000 });
  });
  const pairs = (rows) => Object.fromEntries(rows.slice(1).map((r) => [r[0], r[1]]));

  it("Dashboard = Reports for the same range; period vs current operations kept apart", async () => {
    const r = await call(world.uids.ownera, { dataset: "dashboard", filters: { from: "2026-10-07", to: "2026-10-08" } });
    const s = pairs(sheet(r.bytes, "Summary"));
    const ctx = await ctxFor(world.uids.ownera);
    const rep = await buildReport({ db: world.db, tenant: A, from: "2026-10-07", to: "2026-10-08", permissions: ctx.permissions, entitlements: ctx.entitlements });
    expect(s["Net sales"]).toBe(String(rep.overview.netSales / 100));
    expect(s.COGS).toBe(String(rep.overview.cogs / 100));
    expect(s["Gross profit"]).toBe(String(rep.overview.grossProfit / 100));
    expect(s["Estimated operating profit"]).toBe(String(rep.overview.estimatedOperatingProfit / 100));
    expect(s["Payments received"]).toBe("12000");
    expect(s.Orders).toBe("3");
    expect(s["Current unpaid balance"]).toBeUndefined(); // not a period figure
    const cur = sheet(r.bytes, "Current operations");
    expect(cur[1][2]).toMatch(/NOT for the selected period/);
    expect(pairs(cur)["Current unpaid balance"]).toBe("3000");
    expect(pairs(cur)["Current low stock"]).toBe("7");
    expect(sheet(r.bytes, "Period activity").map((x) => x[0])).toEqual(["Day", "2026-10-07", "2026-10-08"]);
    expect(r.headers["Content-Disposition"]).toContain("Luna_Dashboard_2026-10-07_to_2026-10-08.xlsx");
  });

  it("a period with no summaries says No data yet, never 0; staff-like viewers get no money", async () => {
    const s = pairs(sheet((await call(world.uids.ownera, { dataset: "dashboard", filters: { from: "2026-09-01", to: "2026-09-30" } })).bytes, "Summary"));
    expect(s["Net sales"]).toBe("No data yet");
    expect(s.Orders).toBe("No data yet");
    const viewer = await member("dashonly", "staff", { grant: ["data.export"] });
    const v = await call(viewer, { dataset: "dashboard", filters: { from: "2026-10-07", to: "2026-10-08" } });
    const sv = pairs(sheet(v.bytes, "Summary"));
    expect(sv.Orders).toBe("3");
    expect(sv["Net sales"]).toBeUndefined();
    expect(JSON.stringify(sheet(v.bytes, "Current operations"))).not.toContain("unpaid balance");
  });

  it("Reports workbook: sections the caller may see; no money sheets/columns without dashboard.financials", async () => {
    const full = await call(world.uids.ownera, { dataset: "reports", filters: { from: "2026-10-07", to: "2026-10-08" } });
    expect(pairs(sheet(full.bytes, "Overview"))["Net sales"]).toBe("15000");
    expect(sheet(full.bytes, "Sales")[0]).toContain("Net sales");
    await updateOverrides({ ...world, businessId: "biz-a", set: { limits: { users: 10 } }, actor: "t", reason: "room for test members" });
    const m = await member("repnofin", "manager", { revoke: ["dashboard.financials"] });
    const r = await call(m, { dataset: "reports", filters: { from: "2026-10-07", to: "2026-10-08" } });
    const ov = pairs(sheet(r.bytes, "Overview"));
    expect(ov["Orders created"]).toBe("3");
    for (const k of ["Net sales", "COGS", "Gross profit", "Payments received", "Unpaid balance (now)"]) expect(ov[k]).toBeUndefined();
    expect(sheet(r.bytes, "Sales")[0]).toEqual(["Day", "Orders created", "Fulfilled orders"]);
    const noExport = await member("repnoexp", "manager", { revoke: ["reports.export"] });
    expect((await call(noExport, { dataset: "reports", filters: { from: "2026-10-07", to: "2026-10-08" } })).status).toBe(403);
  });
});

describe("value cursors (how the browser pages a list) never skip equal sort values", () => {
  it("60 customers with the same name, 25 per page: all 60 once, via the spec's orderBy (incl. the id tiebreak)", async () => {
    const { customersQuery, expensesQuery, ID } = await import("../../shared/list-queries.js");
    for (let i = 0; i < 60; i++) seed(`customers/c${String(i).padStart(19, "0")}`, { name: "Same", nameLower: "same", status: "active" });
    for (let i = 0; i < 60; i++) seed(`expenses/e${String(i).padStart(19, "0")}`, { date: "2026-10-05", status: "active", amount: 1 });
    const pageAll = async (collection, spec) => {
      const [part] = spec.parts;
      const field = (f) => (f === ID ? FieldPath.documentId() : f);
      const seen = [];
      let cursor = null;
      for (let guard = 0; guard < 10; guard++) {
        let q = A.collection(collection);
        for (const [f, op, v] of part.where) q = q.where(field(f), op, v);
        for (const [f, dir] of part.orderBy) q = q.orderBy(field(f), dir);
        if (cursor) q = q.startAfter(...part.orderBy.map(([f]) => (f === ID ? cursor.id : cursor[f])));
        const docs = (await q.limit(26).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
        seen.push(...docs.slice(0, 25));
        if (docs.length <= 25) break;
        cursor = docs[24];
      }
      return seen;
    };
    const customers = await pageAll("customers", customersQuery({}));
    expect(new Set(customers.map((c) => c.id)).size).toBe(60);
    const expenses = await pageAll("expenses", expensesQuery({}));
    expect(new Set(expenses.map((e) => e.id)).size).toBe(60);
  });
});
