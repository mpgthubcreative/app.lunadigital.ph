// Phase 6 server: the products / inventory service (transactions, SKU
// uniqueness, history, gauges) and the two HTTP endpoints (auth,
// permissions, entitlement, subscription, strict payloads, cost visibility).

import { describe, it, expect, beforeEach } from "vitest";
import { createProduct, updateProduct, setProductStatus, deleteUnusedProduct, recordMovement, prepareMovements } from "../../netlify/functions/_lib/inventory.js";
import { createProductsHandler } from "../../netlify/functions/products.js";
import { createInventoryHandler } from "../../netlify/functions/inventory.js";
import { updateOverrides, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE, costUnitsToCentavos, inventoryValue } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-owner", name: "Owner A", email: "owner@t.test" };
let world;
let A;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const svc = (extra) => ({ db: world.db, tenant: A, FieldValue, actor, ...extra });
const docAt = (path) => world.db.docs.get(path);
const docsUnder = (prefix) => [...world.db.docs.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => ({ id: p.split("/").at(-1), ...d }));
const newProduct = (over = {}) => createProduct(svc({ input: { sku: "RICE-25", name: "Rice 25kg", category: "Grains", unit: "pcs", sellingPrice: 125000, reorderLevel: Q(20), ...over } }));

describe("products", () => {
  it("creates a product with zero balances, a cost doc, a SKU index entry and an audit record", async () => {
    const { productId } = await newProduct();
    expect(docAt(`businesses/biz-a/products/${productId}`)).toMatchObject({ sku: "RICE-25", nameLower: "rice 25kg", onHand: 0, reserved: 0, available: 0, status: "active", movementCount: 0, isLowStock: true });
    expect(docAt(`businesses/biz-a/productCosts/${productId}`)).toMatchObject({ avgCostUnits: null, inventoryValue: 0 });
    expect(docAt("businesses/biz-a/skuIndex/RICE-25")).toMatchObject({ productId });
    expect(docsUnder("businesses/biz-a/auditLog/").some((a) => a.type === "product.created")).toBe(true);
    expect(docAt("businesses/biz-a/metrics/current").lowStockProducts).toBe(1);
  });

  it("SKU is unique per business, case-insensitive", async () => {
    await newProduct();
    await expect(newProduct({ sku: "rice-25", name: "Other" })).rejects.toMatchObject({ code: "duplicate-sku" });
  });

  it("the same SKU may exist in another business", async () => {
    await newProduct();
    const B = tenantDb(world.db, "biz-b");
    await expect(createProduct({ db: world.db, tenant: B, FieldValue, actor, input: { sku: "RICE-25", name: "B rice", unit: "pcs", sellingPrice: 1, reorderLevel: 0 } })).resolves.toBeTruthy();
  });

  it("changing a SKU moves the index entry and refuses a taken SKU", async () => {
    const { productId } = await newProduct();
    await newProduct({ sku: "SUGAR-1", name: "Sugar" });
    await expect(updateProduct(svc({ productId, changes: { sku: "SUGAR-1" } }))).rejects.toMatchObject({ code: "duplicate-sku" });
    await updateProduct(svc({ productId, changes: { sku: "RICE-50" } }));
    expect(docAt("businesses/biz-a/skuIndex/RICE-25")).toBeUndefined();
    expect(docAt("businesses/biz-a/skuIndex/RICE-50")).toMatchObject({ productId });
  });

  it("editing master data never rewrites history snapshots", async () => {
    const { productId } = await newProduct();
    await recordMovement(svc({ productId, movement: { type: "opening", quantity: Q(100), unitCost: 5000, note: "count" } }));
    await updateProduct(svc({ productId, changes: { name: "Premium Rice", sellingPrice: 130000 } }));
    const [t] = docsUnder("businesses/biz-a/inventoryTransactions/");
    expect(t.productName).toBe("Rice 25kg");
    expect(docAt(`businesses/biz-a/products/${productId}`).name).toBe("Premium Rice");
  });

  it("deactivate / activate adjusts low stock; reserved products can't be deactivated", async () => {
    const { productId } = await newProduct();
    await setProductStatus(svc({ productId, status: "inactive" }));
    expect(docAt(`businesses/biz-a/products/${productId}`).isLowStock).toBe(false);
    expect(docAt("businesses/biz-a/metrics/current").lowStockProducts).toBe(0);
    await setProductStatus(svc({ productId, status: "active" }));
    await recordMovement(svc({ productId, movement: { type: "opening", quantity: Q(50), unitCost: 100, note: "x" } }));
    await world.db.runTransaction(async (tx) => (await prepareMovements(tx, { tenant: A, items: [{ productId, movement: { type: "reservation", quantity: Q(1) } }] })).commit({ actor, FieldValue }));
    await expect(setProductStatus(svc({ productId, status: "inactive" }))).rejects.toMatchObject({ code: "has-reservations" });
  });

  it("deletes only never-used products", async () => {
    const unused = await newProduct({ sku: "TMP-1", name: "Temp" });
    await deleteUnusedProduct(svc({ productId: unused.productId }));
    expect(docAt(`businesses/biz-a/products/${unused.productId}`)).toBeUndefined();
    expect(docAt("businesses/biz-a/skuIndex/TMP-1")).toBeUndefined();
    const used = await newProduct();
    await recordMovement(svc({ productId: used.productId, movement: { type: "opening", quantity: Q(1), unitCost: 1, note: "x" } }));
    await expect(deleteUnusedProduct(svc({ productId: used.productId }))).rejects.toMatchObject({ code: "product-in-use" });
  });
});

describe("THE costing scenario through the service", () => {
  it("100 @ ₱50, receive 50 @ ₱60 -> 150 @ ₱53.33; adjust -10 -> 140, average unchanged; full history", async () => {
    const { productId } = await newProduct({ reorderLevel: Q(20) });
    await recordMovement(svc({ productId, movement: { type: "opening", quantity: Q(100), unitCost: 5000, note: "Initial count" } }));
    const receipt = await recordMovement(svc({ productId, movement: { type: "receipt", quantity: Q(50), unitCost: 6000, referenceType: "manual", referenceId: "DR-1001" } }));
    expect(receipt.next).toMatchObject({ onHand: Q(150), available: Q(150) });
    expect(costUnitsToCentavos(receipt.next.avgCostUnits)).toBe(5333); // ₱53.33
    const adj = await recordMovement(svc({ productId, movement: { type: "adjustment_decrease", quantity: Q(10), reason: "damaged", note: "Crushed sacks" } }));
    expect(adj.next).toMatchObject({ onHand: Q(140), avgCostUnits: receipt.next.avgCostUnits });

    const product = docAt(`businesses/biz-a/products/${productId}`);
    const costs = docAt(`businesses/biz-a/productCosts/${productId}`);
    expect(product).toMatchObject({ onHand: Q(140), reserved: 0, available: Q(140), movementCount: 3, isLowStock: false });
    expect(costs).toMatchObject({ avgCostUnits: 53333333, lastReceiptUnitCost: 6000, inventoryValue: inventoryValue(Q(140), 53333333) });

    const log = docsUnder("businesses/biz-a/inventoryTransactions/").sort((a, b) => a.seq - b.seq);
    expect(log.map((t) => [t.type, t.onHandDelta, t.onHandBefore, t.onHandAfter])).toEqual([
      ["opening", Q(100), 0, Q(100)],
      ["receipt", Q(50), Q(100), Q(150)],
      ["adjustment_decrease", -Q(10), Q(150), Q(140)],
    ]);
    expect(log[2]).toMatchObject({ reason: "damaged", note: "Crushed sacks", actor, productName: "Rice 25kg", availableBefore: Q(150), availableAfter: Q(140) });
    expect(log[1]).toMatchObject({ referenceId: "DR-1001" });

    const costLog = log.map((t) => docAt(`businesses/biz-a/inventoryTransactionCosts/${t.id}`));
    expect(costLog.map((c) => [c.unitCost, c.avgCostBefore, c.avgCostAfter])).toEqual([
      [5000, null, 50000000],
      [6000, 50000000, 53333333],
      [null, 53333333, 53333333],
    ]);
    expect(costLog[2].costConsumed).toBe(53333);

    // No sale happened: no COGS, sales or order metrics, and no financial
    // gauge either (total value is a sum() over productCosts, not a hot doc).
    expect(docsUnder("businesses/biz-a/financialMetrics/")).toEqual([]);
    expect(docsUnder("businesses/biz-a/metrics/").map((d) => d.id)).toEqual(["current"]);
  });
});

describe("prepareMovements (the Phase 7 entry point)", () => {
  it("plans every item before writing; one invalid item writes nothing", async () => {
    const a = await newProduct({ sku: "A-1", name: "A" });
    const b = await newProduct({ sku: "B-1", name: "B" });
    for (const p of [a, b]) await recordMovement(svc({ productId: p.productId, movement: { type: "opening", quantity: Q(5), unitCost: 100, note: "x" } }));
    const before = structuredClone([...world.db.docs.entries()]);
    await expect(
      world.db.runTransaction(async (tx) => {
        const plan = await prepareMovements(tx, { tenant: A, items: [{ productId: a.productId, movement: { type: "reservation", quantity: Q(2) } }, { productId: b.productId, movement: { type: "reservation", quantity: Q(9) } }] });
        plan.commit({ actor, FieldValue });
      })
    ).rejects.toMatchObject({ code: "insufficient-stock" });
    expect([...world.db.docs.entries()]).toEqual(before);
  });

  it("refuses duplicate products in one call", async () => {
    const a = await newProduct();
    await expect(world.db.runTransaction((tx) => prepareMovements(tx, { tenant: A, items: [{ productId: a.productId, movement: { type: "reservation", quantity: Q(1) } }, { productId: a.productId, movement: { type: "reservation", quantity: Q(1) } }] }))).rejects.toThrow(/Combine/);
  });

  it("fulfillment returns the cost consumed for the COGS snapshot", async () => {
    const { productId } = await newProduct();
    await recordMovement(svc({ productId, movement: { type: "opening", quantity: Q(10), unitCost: 5000, note: "x" } }));
    await recordMovement(svc({ productId, movement: { type: "reservation", quantity: Q(2) } }));
    const result = await recordMovement(svc({ productId, movement: { type: "fulfillment", quantity: Q(2) } }));
    expect(result.costConsumed).toBe(10000);
    expect(result.next).toMatchObject({ onHand: Q(8), reserved: 0 });
  });
});

describe("POST /api/products and /api/inventory", () => {
  const call = async (handler, uid, body, businessId) => {
    const event = { ...request({ uid, businessId, method: "POST" }), body: body === undefined ? undefined : JSON.stringify(body) };
    const res = await handler(event);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const products = () => createProductsHandler({ getAdmin: async () => world });
  const inventory = () => createInventoryHandler({ getAdmin: async () => world });
  const create = (uid = world.uids.ownera, over = {}) => call(products(), uid, { action: "create", product: { sku: "SKU-1", name: "Item", unit: "pcs", sellingPrice: 1000, reorderLevel: 0, ...over } });

  it("401 before anything else (even for a bad body)", async () => {
    expect((await products()({ ...request({ method: "POST" }), body: "{bad" })).statusCode).toBe(401);
    expect((await inventory()({ ...request({ method: "POST" }), body: "{bad" })).statusCode).toBe(401);
  });

  it("owner and manager create products; staff can't", async () => {
    expect((await create()).status).toBe(201);
    expect((await create(world.uids.managera, { sku: "SKU-2" })).status).toBe(201);
    const staff = await create(world.uids.staffa, { sku: "SKU-3" });
    expect(staff.status).toBe(403);
  });

  it("strict payloads: balances, costs and unknown fields are refused", async () => {
    expect((await call(products(), world.uids.ownera, { action: "create", product: { sku: "X-1", name: "X", unit: "pcs", sellingPrice: 1, reorderLevel: 0, onHand: Q(500) } })).status).toBe(400);
    expect((await call(products(), world.uids.ownera, { action: "create", product: { sku: "X-1", name: "X", unit: "pcs", sellingPrice: 1, reorderLevel: 0 }, businessId: "biz-b" })).status).toBe(400);
    const { body } = await create();
    expect((await call(inventory(), world.uids.ownera, { action: "receipt", productId: body.productId, quantity: Q(1), unitCost: 100, avgCostUnits: 1 })).status).toBe(400);
    expect((await call(inventory(), world.uids.ownera, { action: "reservation", productId: body.productId, quantity: Q(1) })).status).toBe(400);
    expect((await call(inventory(), world.uids.ownera, { action: "receipt", productId: body.productId, quantity: "NaN", unitCost: 100 })).status).toBe(400);
    expect((await call(inventory(), world.uids.ownera, { action: "receipt", productId: "../../biz-b/products/x", quantity: Q(1), unitCost: 100 })).status).toBe(400);
    expect((await call(inventory(), world.uids.ownera, { action: "receipt", productId: "aaaaaaaaaaaaaaaaaaaa", quantity: Q(1), unitCost: 100 })).status).toBe(404);
  });

  it("permissions per action: receive vs adjust; staff has neither", async () => {
    const { body } = await create();
    const pid = body.productId;
    expect((await call(inventory(), world.uids.staffa, { action: "receipt", productId: pid, quantity: Q(1), unitCost: 100 })).status).toBe(403);
    expect((await call(inventory(), world.uids.staffa, { action: "adjustment_decrease", productId: pid, quantity: Q(1), reason: "damaged" })).status).toBe(403);
    const receiver = await ensureAuthUser({ auth: world.auth, email: "recv@t.test", name: "Receiver" });
    await addMember({ ...world, businessId: "biz-a", uid: receiver.uid, email: receiver.email, name: "Receiver", roleTemplate: "staff", permissionOverrides: { grant: ["inventory.receive"] } });
    expect((await call(inventory(), receiver.uid, { action: "receipt", productId: pid, quantity: Q(3), unitCost: 100 })).status).toBe(200);
    expect((await call(inventory(), receiver.uid, { action: "adjustment_decrease", productId: pid, quantity: Q(1), reason: "damaged" })).status).toBe(403);
    expect((await call(inventory(), world.uids.managera, { action: "adjustment_decrease", productId: pid, quantity: Q(1), reason: "damaged" })).status).toBe(200);
  });

  it("cost appears in responses only for inventory.costs holders", async () => {
    const { body } = await create();
    const receiver = await ensureAuthUser({ auth: world.auth, email: "recv2@t.test", name: "Receiver" });
    await addMember({ ...world, businessId: "biz-a", uid: receiver.uid, email: receiver.email, name: "Receiver", roleTemplate: "staff", permissionOverrides: { grant: ["inventory.receive"] } });
    const asReceiver = await call(inventory(), receiver.uid, { action: "receipt", productId: body.productId, quantity: Q(2), unitCost: 6000 });
    expect(asReceiver.body.cost).toBeUndefined();
    const asOwner = await call(inventory(), world.uids.ownera, { action: "receipt", productId: body.productId, quantity: Q(2), unitCost: 6000 });
    expect(asOwner.body.cost.avgUnitCostCentavos).toBe(6000);
  });

  it("opening needs a reference or note; adjustments need a known reason", async () => {
    const { body } = await create();
    expect((await call(inventory(), world.uids.ownera, { action: "opening", productId: body.productId, quantity: Q(5), unitCost: 100 })).status).toBe(400);
    expect((await call(inventory(), world.uids.ownera, { action: "opening", productId: body.productId, quantity: Q(5), unitCost: 100, reference: "COUNT-1" })).status).toBe(200);
    expect((await call(inventory(), world.uids.ownera, { action: "adjustment_decrease", productId: body.productId, quantity: Q(1), reason: "because" })).status).toBe(400);
    expect((await call(inventory(), world.uids.ownera, { action: "adjustment_decrease", productId: body.productId, quantity: Q(1), reason: "other" })).status).toBe(400);
    expect((await call(inventory(), world.uids.ownera, { action: "adjustment_decrease", productId: body.productId, quantity: Q(9), reason: "lost" })).status).toBe(409);
  });

  it("Inventory module disabled -> denied for everyone", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { inventory: false } }, actor: "t", reason: "inventory off" });
    expect((await create()).status).toBe(403);
  });

  it("suspended and cancelled businesses can't write", async () => {
    expect((await create(world.uids.owners)).body.error).toBe("read-only");
    expect((await create(world.uids.ownerx)).status).toBe(403);
  });

  it("cross-tenant: A's owner can't create in or move B's stock", async () => {
    const bProduct = await createProduct({ db: world.db, tenant: tenantDb(world.db, "biz-b"), FieldValue, actor, input: { sku: "B-1", name: "B", unit: "pcs", sellingPrice: 1, reorderLevel: 0 } });
    const viaSelector = await call(products(), world.uids.ownera, { action: "create", product: { sku: "Z-1", name: "Z", unit: "pcs", sellingPrice: 1, reorderLevel: 0 } }, "biz-b");
    expect(viaSelector.body.error).toBe("business-access-denied");
    // B's product id used inside A's tenant: not found in A, B untouched.
    const res = await call(inventory(), world.uids.ownera, { action: "receipt", productId: bProduct.productId, quantity: Q(5), unitCost: 100 });
    expect(res.status).toBe(404);
    expect(docAt(`businesses/biz-b/products/${bProduct.productId}`).onHand).toBe(0);
  });
});
