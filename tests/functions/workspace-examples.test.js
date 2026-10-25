// Example empty states (2026-10-25) are drawn on screen only: nothing is
// stored. These tests show the server side of a brand-new Distributor and
// Household workspace: the export, usage, reports, stock, receivables and
// payroll hold nothing until a REAL record is made, and then exactly that
// record (the examples' figures never appear). Another tenant sees nothing.

import { describe, it, expect, beforeEach } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { createWorkbookHandler } from "../../netlify/functions/workbook.js";
import { createReportsHandler } from "../../netlify/functions/reports.js";
import { createUsageHandler } from "../../netlify/functions/usage.js";
import { createCustomersHandler } from "../../netlify/functions/customers.js";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { createOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const NOW = new Date("2026-10-20T04:00:00Z");
const H = "home-examples";
let world;
let homeOwner;
// Every name / figure the example lists show (src/modules/*: *_EXAMPLES).
const EXAMPLE_TEXT = /Maria's Mini Mart|ABC Restaurant|Juan Store|Chicken Siomai|Pork Tocino|Beef Tapa|Maria Santos|Ana Reyes|2,450|6,200|1,850|8,650/;
beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes Household", planId: "household-basic", workspaceTemplateId: "household-payroll", businessId: H });
  const o = await ensureAuthUser({ auth: world.auth, email: "owner@home-examples.test", name: "Liza" });
  await addMember({ ...world, businessId: H, uid: o.uid, email: o.email, name: "Liza", roleTemplate: "owner", isAccountOwner: true });
  homeOwner = o.uid;
});
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const post = async (handler, uid, businessId, body) => {
  const res = await handler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const get = async (handler, uid, businessId, query = {}) => {
  const res = await handler(deps())({ ...request({ uid, businessId, method: "GET" }), queryStringParameters: query });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const ok = (r) => {
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  return r.body;
};
async function workbookText(uid, businessId) {
  const res = await createWorkbookHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify({}) });
  expect(res.statusCode, res.body).toBe(200);
  return Object.values(unzipSync(new Uint8Array(Buffer.from(res.body, "base64")))).map((f) => strFromU8(f)).join("\n");
}
const docsOf = (businessId, col) => [...world.db.docs.keys()].filter((k) => k.startsWith(`businesses/${businessId}/${col}/`));

describe("Distributor: a new workspace stores nothing for its examples", () => {
  it("export, usage, reports and receivables are empty; one real order → exactly that order (stock reserved only for it)", async () => {
    const owner = world.uids.ownera;
    // Before anything: no orders, customers, products, payments, movements or usage.
    for (const col of ["orders", "customers", "products", "payments", "inventoryMovements", "usage"]) expect(docsOf("biz-a", col), col).toEqual([]);
    expect(await workbookText(owner, "biz-a")).not.toMatch(EXAMPLE_TEXT);
    const rep = ok(await get(createReportsHandler, owner, "biz-a", { from: "2026-10-01", to: "2026-10-20" }));
    // Nothing recorded at all: no figure yet (never an example one).
    expect(rep.overview.ordersCreated ?? 0).toBe(0);
    expect(rep.overview.grossSales ?? 0).toBe(0);
    const usage = ok(await get(createUsageHandler, owner, "biz-a"));
    expect(JSON.stringify(usage)).not.toMatch(/"ordersCreated":[1-9]/);
    // One real order of 2 × ₱75 for a real buyer.
    const A = tenantDb(world.db, "biz-a");
    const common = { db: world.db, tenant: A, FieldValue, actor: { uid: owner, name: "Owner", email: "" } };
    const { productId } = await createProduct({ ...common, input: { sku: "KOPI-1", name: "Kopi", unit: "pcs", sellingPrice: 7500, reorderLevel: 0 } });
    await recordMovement({ ...common, productId, movement: { type: "opening", quantity: 20 * QTY_SCALE, unitCost: 5000, note: "count" } });
    const business = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
    await createOrder({ ...common, business, entitlements: world.db.docs.get("businesses/biz-a").entitlements, input: { customer: { name: "Aling Nena" }, source: "viber", items: [{ productId, quantity: 2 * QTY_SCALE }] }, idempotencyKey: "examples-order-00001", canDiscount: false, canLinkCustomers: false, now: NOW });
    expect(docsOf("biz-a", "orders")).toHaveLength(1);
    const p = world.db.docs.get(`businesses/biz-a/products/${productId}`);
    // Stock moved only for the real order: 20 on hand, 2 set aside, 18 available.
    expect({ onHand: p.onHand, reserved: p.reserved, available: p.available }).toEqual({ onHand: 20 * QTY_SCALE, reserved: 2 * QTY_SCALE, available: 18 * QTY_SCALE });
    const text = await workbookText(owner, "biz-a");
    expect(text).toMatch(/Aling Nena/);
    expect(text).not.toMatch(EXAMPLE_TEXT);
    const rep2 = ok(await get(createReportsHandler, owner, "biz-a", { from: "2026-10-01", to: "2026-10-20" }));
    expect(rep2.overview.ordersCreated).toBe(1);
    // Customers list = the real one only (no example balances anywhere).
    ok(await post(createCustomersHandler, owner, "biz-a", { action: "create", customer: { name: "Real Buyer" } }));
    expect(docsOf("biz-a", "customers").map((k) => world.db.docs.get(k).name)).toEqual(["Real Buyer"]);
    // Another tenant: still nothing.
    for (const col of ["orders", "customers", "products"]) expect(docsOf("biz-b", col), col).toEqual([]);
    expect(await workbookText(world.uids.ownerb, "biz-b")).not.toMatch(/Aling Nena|Real Buyer|Kopi/);
  });
});

describe("Household: a new workspace stores nothing for its examples", () => {
  it("no staff, attendance, payroll or advance until real ones; then payroll = the real days only, with no deduction", async () => {
    for (const col of ["householdStaff", "attendance", "payrolls", "advances", "usage"]) expect(docsOf(H, col), col).toEqual([]);
    expect(await workbookText(homeOwner, H)).not.toMatch(EXAMPLE_TEXT);
    const empty = ok(await post(createPayrollHandler, homeOwner, H, { action: "period" })).view;
    expect(empty.rows).toEqual([]);
    // A real helper with three real days.
    const sid = ok(await post(createHouseholdStaffHandler, homeOwner, H, { action: "create", staff: { name: "Lorna Cruz", dailyWage: 50000, payCycle: "semi_monthly", startDate: "2026-10-01" } })).staffId;
    ok(await post(createAttendanceHandler, homeOwner, H, { action: "setMany", staffId: sid, days: ["2026-10-01", "2026-10-02", "2026-10-03"].map((date) => ({ date, status: "present" })) }));
    const view = ok(await post(createPayrollHandler, homeOwner, H, { action: "period", period: { start: "2026-10-01", end: "2026-10-15" }, staffId: sid })).view;
    const row = view.rows.find((r) => r.staffId === sid);
    expect(row).toMatchObject({ basePay: 150000, deductionsTotal: 0, netPay: 150000 });
    expect(docsOf(H, "advances")).toEqual([]);
    const text = await workbookText(homeOwner, H);
    expect(text).toMatch(/Lorna Cruz/);
    expect(text).not.toMatch(EXAMPLE_TEXT);
  });
});
