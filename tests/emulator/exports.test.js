// Exports on the REAL Firestore emulator (Admin SDK): the shared list-query
// specs are valid Firestore queries, pagination by document cursor never
// skips or repeats a row (including thousands of rows with equal sort
// values, where the document-id tiebreak matters), filters return exactly
// the matching rows, the limit refuses instead of truncating, and a full
// export (workbook + audit + usage) runs end to end.

import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

let db, admin, tenantDb, readRows, runExport, Q, RECORD_BUILDERS, EXPORT_DATASETS, readXlsx, computeEntitlements, PLAN_SEED, resolvePermissions;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  ({ db, admin } = await (await import("../../netlify/functions/_lib/firebase-admin.js")).getAdmin());
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  ({ readRows, runExport } = await import("../../netlify/functions/_lib/export-core.js"));
  ({ RECORD_BUILDERS } = await import("../../netlify/functions/_lib/exports/records.js"));
  Q = await import("../../shared/list-queries.js");
  ({ EXPORT_DATASETS } = await import("../../shared/export-datasets.js"));
  ({ readXlsx } = await import("../../shared/xlsx.js"));
  ({ computeEntitlements } = await import("../../shared/entitlements.js"));
  ({ PLAN_SEED } = await import("../../shared/plans.seed.js"));
  ({ resolvePermissions } = await import("../../shared/permissions.js"));
});

const FieldPath = () => admin.firestore.FieldPath;
function world() {
  run += 1;
  const id = `expc-${Date.now().toString(36)}-${run}`;
  return { id, tenant: tenantDb(db, id) };
}
async function seedMany(tenant, collection, docs) {
  for (let i = 0; i < docs.length; i += 450) {
    const batch = db.batch();
    for (const [id, data] of docs.slice(i, i + 450)) batch.set(tenant.doc(collection, id), data);
    await batch.commit();
  }
}
const read = (w, collection, spec, max = 10000) => readRows({ tenant: w.tenant, collection, spec, FieldPath: FieldPath(), max });

describe("list-query specs on real Firestore", () => {
  it("orders: 2,150 rows, paid + fulfilled + date range -> exactly the matching ones, in order, across 3 pages", async () => {
    const w = world();
    const days = ["2026-09-30", "2026-10-01", "2026-10-15", "2026-10-31", "2026-11-01"];
    const pays = ["paid", "unpaid", "partially_paid"];
    const fuls = ["fulfilled", "pending"];
    const docs = Array.from({ length: 2150 }, (_, i) => [
      `o${String(i).padStart(19, "0")}`,
      { orderNumber: `ORD-${i}`, orderDate: days[i % 5], paymentStatus: pays[i % 3], fulfillmentStatus: fuls[i % 2], source: "phone", createdAt: new Date(Date.UTC(2026, 9, 1) + (i % 7) * 1000) },
    ]);
    await seedMany(w.tenant, "orders", docs);
    const expected = docs.filter(([, o]) => o.paymentStatus === "paid" && o.fulfillmentStatus === "fulfilled" && o.orderDate >= "2026-10-01" && o.orderDate <= "2026-10-31").map(([id]) => id);
    const rows = await read(w, "orders", Q.ordersQuery({ paymentStatus: "paid", fulfillmentStatus: "fulfilled", from: "2026-10-01", to: "2026-10-31" }));
    expect(rows.map((r) => r.id).sort()).toEqual(expected.sort());
    // No filter: all 2,150 (three reads of up to 1,000), none twice.
    const all = await read(w, "orders", Q.ordersQuery({}));
    expect(all).toHaveLength(2150);
    expect(new Set(all.map((r) => r.id)).size).toBe(2150);
    const keys = all.map((r) => r.createdAt.toMillis());
    expect([...keys].sort((a, b) => b - a)).toEqual(keys);
    await expect(read(w, "orders", Q.ordersQuery({}), 2149)).rejects.toMatchObject({ code: "too-many-rows" });
  });

  it("1,200 customers with the SAME name: the id tiebreak pages through all of them once; prefix search works", async () => {
    const w = world();
    const docs = Array.from({ length: 1200 }, (_, i) => [`c${String(i).padStart(19, "0")}`, { name: "Same Store", nameLower: "same store", status: "active" }]);
    docs.push(["cx000000000000000001", { name: "Other", nameLower: "other", status: "active" }], ["cx000000000000000002", { name: "Gone", nameLower: "same gone", status: "inactive" }]);
    await seedMany(w.tenant, "customers", docs);
    const rows = await read(w, "customers", Q.customersQuery({}));
    expect(rows).toHaveLength(1201);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1201);
    expect((await read(w, "customers", Q.customersQuery({ search: "SAME" }))).length).toBe(1200);
    expect((await read(w, "customers", Q.customersQuery({ search: "same", status: "inactive" }))).map((r) => r.id)).toEqual(["cx000000000000000002"]);
  });

  it("expenses: 1,050 on one date page by date then id (desc); search parts honour the other filters", async () => {
    const w = world();
    const docs = Array.from({ length: 1050 }, (_, i) => [`e${String(i).padStart(19, "0")}`, { date: "2026-10-05", category: i % 2 ? "rent" : "fuel", method: "cash", payee: "Shell", payeeLower: "shell", reference: i === 7 ? "REF-7" : null, status: "active", amount: 100 }]);
    docs.push(["eremoved00000000000x", { date: "2026-10-05", category: "rent", method: "cash", payee: "Shell", payeeLower: "shell", status: "removed", amount: 1 }]);
    await seedMany(w.tenant, "expenses", docs);
    const rows = await read(w, "expenses", Q.expensesQuery({ from: "2026-10-01", to: "2026-10-31" }));
    expect(rows).toHaveLength(1050);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort().reverse());
    expect((await read(w, "expenses", Q.expensesQuery({ category: "rent" }))).length).toBe(525);
    expect((await read(w, "expenses", Q.expensesQuery({ search: "REF-7" }))).map((r) => r.id)).toEqual(["e0000000000000000007"]);
    expect((await read(w, "expenses", Q.expensesQuery({ search: "she", category: "rent" }))).length).toBe(525);
  });

  it("products: category (any case) + low stock; search = name prefix OR exact SKU", async () => {
    const w = world();
    const p = (sku, name, cat, low, status = "active") => [sku, { sku, name, nameLower: name.toLowerCase(), category: cat, categoryLower: cat.toLowerCase(), isLowStock: low, status }];
    await seedMany(w.tenant, "products", [p("W-1", "Wings", "Frozen", true), p("T-1", "Thighs", "Frozen", false), p("S-1", "Sauce", "Condiments", true), p("X-1", "Wiper", "Frozen", true, "inactive")]);
    expect((await read(w, "products", Q.productsQuery({ category: "FROZEN", lowOnly: true }))).map((r) => r.id)).toEqual(["W-1"]);
    expect((await read(w, "products", Q.productsQuery({ search: "wi" }))).map((r) => r.id)).toEqual(["W-1"]);
    expect((await read(w, "products", Q.productsQuery({ search: "s-1" }))).map((r) => r.id)).toEqual(["S-1"]);
  });

  it("a full Orders export: workbook rows = matching orders; one audit entry; usage counted", async () => {
    const w = world();
    const docs = Array.from({ length: 30 }, (_, i) => [`o${String(i).padStart(19, "0")}`, { orderNumber: `ORD-${i}`, orderDate: "2026-10-05", paymentStatus: i < 12 ? "paid" : "unpaid", fulfillmentStatus: "fulfilled", source: "phone", customer: { name: `=cmd|' /C calc'!A0 ${i}` }, items: [], total: 1000, createdAt: new Date(Date.UTC(2026, 9, 5, i)) }]);
    await seedMany(w.tenant, "orders", docs);
    const entitlements = computeEntitlements(PLAN_SEED.growth, {}, "distributor");
    const ctx = { uid: "u1", user: { name: "Owner" }, tenant: w.tenant, business: { id: w.id, name: "Emu Biz", timezone: "Asia/Manila" }, permissions: resolvePermissions("manager", { revoke: ["dashboard.financials"] }), entitlements };
    const out = await runExport({ db, ctx, admin, descriptor: EXPORT_DATASETS.orders, builder: RECORD_BUILDERS.orders, rawFilters: { paymentStatus: "paid" }, now: new Date("2026-10-08T06:00:00Z") });
    // One sheet (Phase 18.6): title/info rows, then ONE header row and the records.
    const { reportRows } = await import("../../shared/exports.js");
    const [header, ...body] = reportRows(readXlsx(out.bytes, { sheet: "Orders" }).rows);
    const orders = body.filter((r) => r[header.indexOf("Record")] === "Order");
    expect(orders).toHaveLength(12);
    expect(header.join(" ")).not.toMatch(/COGS/);
    expect(orders.every((r) => r[header.indexOf("Customer")].startsWith("'="))).toBe(true);
    const audit = (await w.tenant.collection("auditLog").where("type", "==", "export.generated").get()).docs.map((d) => d.data());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ dataset: "orders", rowCount: 12, filters: { paymentStatus: "paid" } });
    expect((await w.tenant.doc("usage", "2026-10").get()).data()).toMatchObject({ exportsGenerated: 1, rowsExported: 12 });
  });
});
