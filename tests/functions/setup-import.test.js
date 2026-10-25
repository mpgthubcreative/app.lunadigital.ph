// Setup-service migration (2026-10-25): a frozen-food distributor's Excel
// file → Luna at a cutover date. Upload → Map → Validate → Preview →
// Commit → Reconcile → Retry. The second run must change nothing.

import { describe, it, expect, beforeEach } from "vitest";
import { writeXlsx, readXlsx } from "../../shared/xlsx.js";
import { mapSheet, planSetupImport, commitSetupImport, setupKey } from "../../netlify/functions/_lib/setup-import.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer } from "../../netlify/functions/_lib/customers.js";
import { createOrder } from "../../netlify/functions/_lib/orders.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "setup-import", name: "Luna setup", email: "" };
const CUTOVER = "2026-11-01";
let world;
let A;
beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});
const docAt = (p) => world.db.docs.get(p);
const docs = (biz, col) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${biz}/${col}/`) && k.split("/").length === 4).map(([k, v]) => ({ id: k.split("/")[3], ...v }));

// ---- The pilot dataset: 150 products, 40 customers, 5 with special prices, 10 opening balances ----
const KINDS = ["Chicken Siomai", "Pork Siomai", "Beef Tapa", "Pork Tocino", "Chicken Nuggets", "Hotdog Jumbo", "Longganisa", "Shanghai Rolls", "Squid Rings", "Fish Balls"];
const SIZES = ["250g", "500g", "1kg", "2kg", "Box 10s", "Box 20s", "Pack 12s", "Tray", "Family Pack", "Party Pack", "Mini", "Value Pack", "Premium", "Classic", "Spicy"];
function pilotWorkbook() {
  const products = [["Item Code", "Description", "UOM", "SRP", "Cost per unit", "Stock on hand"]];
  let i = 0;
  for (const k of KINDS) for (const s of SIZES) {
    i += 1;
    const price = 4500 + i * 37; // centavos → pesos below
    products.push([`FF-${String(i).padStart(3, "0")}`, `${k} ${s}`, "pcs", (price / 100).toFixed(2), ((price * 0.62) / 100).toFixed(2), String(5 + (i % 40))]);
  }
  const customers = [["Customer Name", "Contact Number", "Delivery Address", "Opening balance"]];
  for (let c = 1; c <= 40; c++) customers.push([`Store ${String(c).padStart(2, "0")}`, `0917 ${String(1000000 + c).slice(1)}`, `Barangay ${c}, Quezon City`, c <= 10 ? String(1000 + c * 250) : ""]);
  const prices = [["Customer", "SKU", "Special price"]];
  for (let c = 1; c <= 5; c++) for (let p = 1; p <= 3; p++) prices.push([`Store ${String(c).padStart(2, "0")}`, `FF-${String(p * c).padStart(3, "0")}`, ((4000 + p * 100) / 100).toFixed(2)]);
  return writeXlsx([{ name: "Products", rows: products }, { name: "Customers", rows: customers }, { name: "Special prices", rows: prices }]);
}
// Upload → Map, as the CLI does.
const inputOf = (bytes, cutoverDay = CUTOVER) => ({
  cutoverDay,
  products: mapSheet(readXlsx(bytes, { sheet: "Products" }).rows, "products").rows,
  customers: mapSheet(readXlsx(bytes, { sheet: "Customers" }).rows, "customers").rows,
  prices: mapSheet(readXlsx(bytes, { sheet: "Special prices" }).rows, "prices").rows,
});
const commit = (input, tenant = A, businessId = "biz-a") => commitSetupImport({ db: world.db, tenant, FieldValue, businessId, input, actor });

describe("the pilot migration: 150 products, 40 customers, 5 special-price customers, 10 opening balances", () => {
  it("preview reconciles; commit creates exactly that; the numbers read back from Luna match; a retry changes nothing", async () => {
    const input = inputOf(pilotWorkbook());
    const plan = await planSetupImport({ tenant: A, input });
    const expectedStockValue = input.products.reduce((t, r) => t + Math.round((Number(r.values.openingStock) * Math.round(Number(r.values.cost) * 100) * QTY_SCALE) / 1000), 0);
    const expectedReceivables = Array.from({ length: 10 }, (_, k) => (1000 + (k + 1) * 250) * 100).reduce((a, b) => a + b, 0);
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toEqual({ cutoverDay: CUTOVER, products: 150, productsNew: 150, customers: 40, customersNew: 40, openingStockRecords: 150, openingStockValue: expectedStockValue, customersWithSpecialPrices: 5, specialPrices: 15, customersWithOpeningBalances: 10, openingReceivables: expectedReceivables, rowsWithErrors: 0 });
    // Preview writes nothing.
    expect(docs("biz-a", "products")).toEqual([]);

    const first = await commit(input);
    expect(first.committed).toBe(true);
    expect(first.result).toMatchObject({ productsCreated: 150, openingStockRecorded: 150, customersCreated: 40, specialPricesSet: 15, openingBalancesCreated: 10 });
    expect(first.reconciliation.matches).toBe(true);
    expect(first.reconciliation.actual).toEqual(first.reconciliation.expected);
    // Straight from the database.
    expect(docs("biz-a", "products")).toHaveLength(150);
    expect(docs("biz-a", "customers")).toHaveLength(40);
    expect(docs("biz-a", "customerPrices").filter((p) => p.active !== false)).toHaveLength(15);
    expect(docs("biz-a", "openingBalances")).toHaveLength(10);
    const fin = docAt("businesses/biz-a/financialMetrics/current");
    expect(fin.receivablesOutstanding).toBe(expectedReceivables);
    expect(docs("biz-a", "customers").reduce((t, c) => t + c.stats.outstandingBalance, 0)).toBe(expectedReceivables);
    const p1 = docs("biz-a", "products").find((p) => p.sku === "FF-001");
    expect(p1).toMatchObject({ name: "Chicken Siomai 250g", sellingPrice: 4537, onHand: Q(6), available: Q(6) });
    expect(docAt(`businesses/biz-a/productCosts/${p1.id}`).avgCostUnits).toBeGreaterThan(0);
    // Opening stock is an "opening" movement, never a receipt or an order; nothing is a sale.
    const moves = docs("biz-a", "inventoryTransactions");
    expect(moves).toHaveLength(150);
    expect(new Set(moves.map((m) => m.type))).toEqual(new Set(["opening"]));
    expect(docs("biz-a", "orders")).toEqual([]);
    expect(docs("biz-a", "payments")).toEqual([]);
    expect(docAt("businesses/biz-a/metrics/current")?.pendingFulfillment ?? 0).toBe(0);
    expect(docs("biz-a", "usage").every((u) => !u.ordersCreated)).toBe(true);
    // An audit record of the import.
    expect(docs("biz-a", "setupImports")).toHaveLength(1);

    // RETRY the same file (an interrupted run, or run twice by mistake).
    const before = JSON.stringify([...world.db.docs.entries()].filter(([k]) => k.startsWith("businesses/biz-a/") && !k.includes("/setupImports/")).map(([k, v]) => [k, { ...v, updatedAt: null }]));
    const again = await commit(input);
    expect(again.committed).toBe(true);
    expect(again.result).toMatchObject({ productsCreated: 0, productsKept: 150, openingStockRecorded: 0, openingStockReplayed: 150, customersCreated: 0, customersKept: 40, specialPricesSet: 0, specialPricesUnchanged: 15, openingBalancesCreated: 0, openingBalancesReplayed: 10 });
    expect(again.reconciliation.matches).toBe(true);
    expect(docs("biz-a", "products")).toHaveLength(150);
    expect(docs("biz-a", "customers")).toHaveLength(40);
    expect(docs("biz-a", "openingBalances")).toHaveLength(10);
    expect(docs("biz-a", "inventoryTransactions")).toHaveLength(150);
    expect(docAt("businesses/biz-a/financialMetrics/current").receivablesOutstanding).toBe(expectedReceivables);
    const after = JSON.stringify([...world.db.docs.entries()].filter(([k]) => k.startsWith("businesses/biz-a/") && !k.includes("/setupImports/")).map(([k, v]) => [k, { ...v, updatedAt: null }]));
    expect(after).toBe(before);
    // Another business saw nothing.
    for (const col of ["products", "customers", "openingBalances", "customerPrices"]) expect(docs("biz-b", col), col).toEqual([]);
    // After setup, the special price is what the first real order gets.
    const store01 = docs("biz-a", "customers").find((c) => c.name === "Store 01");
    const o = await createOrder({ db: world.db, tenant: A, FieldValue, business: { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" }, entitlements: docAt("businesses/biz-a").entitlements, input: { customerId: store01.id, customer: { name: "Store 01" }, source: "viber", items: [{ productId: p1.id, quantity: Q(1) }] }, idempotencyKey: "after-setup-order-0001", actor, canDiscount: false, canLinkCustomers: true, now: new Date("2026-11-02T03:00:00Z") });
    expect(docAt(`businesses/biz-a/orders/${o.orderId}`).items[0]).toMatchObject({ unitPrice: 4100, customerPrice: true });
  });
});

describe("validation, duplicates and existing records", () => {
  const sheet = (rows, kind) => mapSheet(rows, kind).rows;
  it("invalid rows are listed in plain words and NOTHING is written until they're fixed", async () => {
    const input = {
      cutoverDay: CUTOVER,
      products: sheet([["SKU", "Name", "Unit", "Price", "Cost", "Opening stock"], ["A-1", "Siomai", "pcs", "55", "35", "50"], ["", "No code", "pcs", "10", "", ""], ["A-2", "", "pcs", "10", "", ""], ["A-3", "Bad price", "pcs", "abc", "", ""], ["A-1", "Siomai again", "pcs", "60", "", ""], ["A-4", "No cost", "pcs", "40", "", "12"], ["A-5", "Bad unit", "crates", "40", "", ""]], "products"),
      customers: sheet([["Name", "Phone", "Opening balance"], ["Maria's Mini Mart", "0917", "950"], ["", "0918", ""], ["maria's mini mart", "", ""], ["Juan Store", "", "x"]], "customers"),
      prices: sheet([["Customer", "SKU", "Price"], ["Maria's Mini Mart", "A-1", "50"], ["Nobody", "A-1", "50"], ["Maria's Mini Mart", "ZZ-9", "50"], ["Maria's Mini Mart", "A-1", "0"]], "prices"),
    };
    const plan = await planSetupImport({ tenant: A, input });
    expect(plan.errors.map((e) => e.message)).toEqual([
      "Products row 3: SKU is missing for No code.",
      "Products row 4: Product name is missing.",
      'Products row 5: Selling price "abc" isn\'t an amount.',
      "Products row 6: SKU A-1 is also on row 2 (each SKU once).",
      "Products row 7: Cost per unit is missing for No cost (needed with opening stock, for profit / COGS).",
      expect.stringMatching(/^Products row 8: Unit must be one of/),
      "Customers row 3: Customer name is missing.",
      "Customers row 4: maria's mini mart is also on row 2 (each customer once).",
      'Customers row 5: Opening balance "x" isn\'t an amount.',
      'Special prices row 3: Customer "Nobody" isn\'t on the Customers sheet or in Luna.',
      "Special prices row 4: SKU ZZ-9 isn't on the Products sheet or in Luna.",
      "Special prices row 5: Special price must be more than ₱0.",
    ]);
    expect(plan.summary.rowsWithErrors).toBe(12);
    const out = await commit(input);
    expect(out.committed).toBe(false);
    expect(docs("biz-a", "products")).toEqual([]);
    expect(docs("biz-a", "customers")).toEqual([]);
  });
  it("a SKU / customer already in Luna is never overwritten (linked instead); stock already moving is left alone", async () => {
    const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: "A-1", name: "Siomai (ours)", unit: "pcs", sellingPrice: 6000, reorderLevel: 0 } });
    await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(9), unitCost: 3000, note: "count" } });
    const { customerId } = await createCustomer({ db: world.db, tenant: A, FieldValue, actor, input: { name: "Maria's Mini Mart", phone: "0917 000 0000" } });
    const input = {
      cutoverDay: CUTOVER,
      products: sheet([["SKU", "Name", "Unit", "Price", "Cost", "Opening stock"], ["A-1", "Siomai from file", "pcs", "55", "35", "50"], ["A-2", "Tocino", "pcs", "120", "80", "10"]], "products"),
      customers: sheet([["Name", "Phone", "Opening balance"], ["MARIA'S MINI MART", "0999", "950"]], "customers"),
      prices: sheet([["Customer", "SKU", "Price"], ["Maria's Mini Mart", "A-1", "50"]], "prices"),
    };
    const plan = await planSetupImport({ tenant: A, input });
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.map((w) => w.message)).toEqual(["Products row 2: SKU A-1 is already in Luna — its details are kept as they are (never overwritten); it already has stock movements, so its stock is NOT changed.", "Customers row 2: MARIA'S MINI MART is already in Luna — kept as it is (never overwritten)."]);
    expect(plan.summary).toMatchObject({ products: 2, productsNew: 1, customers: 1, customersNew: 0, openingStockRecords: 1, customersWithOpeningBalances: 1, openingReceivables: 95000 });
    const out = await commit(input);
    expect(out.reconciliation.matches).toBe(true);
    expect(docAt(`businesses/biz-a/products/${productId}`)).toMatchObject({ name: "Siomai (ours)", sellingPrice: 6000, onHand: Q(9) });
    expect(docAt(`businesses/biz-a/customers/${customerId}`)).toMatchObject({ name: "Maria's Mini Mart", phone: "0917 000 0000" });
    expect(docAt(`businesses/biz-a/customers/${customerId}`).stats.outstandingBalance).toBe(95000);
    expect(docAt(`businesses/biz-a/customerPrices/${customerId}_${productId}`)).toMatchObject({ price: 5000, active: true });
    expect(docs("biz-a", "customers")).toHaveLength(1);
  });
  it("tenant isolation: the import writes only to the business it names; keys differ per business", async () => {
    const input = { cutoverDay: CUTOVER, products: sheet([["SKU", "Name", "Unit", "Price", "Cost", "Opening stock"], ["A-1", "Siomai", "pcs", "55", "35", "5"]], "products"), customers: sheet([["Name", "Opening balance"], ["Juan Store", "100"]], "customers"), prices: [] };
    await commit(input, tenantDb(world.db, "biz-b"), "biz-b");
    expect(docs("biz-b", "products")).toHaveLength(1);
    expect(docs("biz-a", "products")).toEqual([]);
    expect(docs("biz-a", "openingBalances")).toEqual([]);
    expect(setupKey("biz-a", "opening", "A-1")).not.toBe(setupKey("biz-b", "opening", "A-1"));
  });
});
