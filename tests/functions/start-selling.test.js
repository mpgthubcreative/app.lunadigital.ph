// Start taking orders before inventory is finished (2026-11-01): Track
// Inventory per product, Quick Add Product (New Order), a forgiving product
// import, and untracked products on the Share Menu / Reseller Menu.
// Existing products (no trackInventory field) stay tracked: the rest of the
// suite covers their unchanged behaviour.

import { describe, it, expect, beforeEach } from "vitest";
import { createProductsHandler } from "../../netlify/functions/products.js";
import { createStorefrontHandler } from "../../netlify/functions/storefront.js";
import { createStoreHandler } from "../../netlify/functions/store.js";
import { createProduct, recordMovement, updateProduct, deleteUnusedProduct, quickAddProduct } from "../../netlify/functions/_lib/inventory.js";
import { createOrder, fulfillOrder, updateOrder, cancelOrder } from "../../netlify/functions/_lib/orders.js";
import { previewImport, commitImport } from "../../netlify/functions/_lib/imports.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { createResellerMenuHandler } from "../../netlify/functions/reseller-menu.js";
import { createResellersHandler } from "../../netlify/functions/resellers.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";
import { skuFromName } from "../../shared/inventory.js";

const Q = (n) => n * QTY_SCALE;
const NOW = new Date("2026-10-15T02:00:00Z");
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const actor = { uid: "u-setup", name: "Setup", email: "" };
let world;
let A;
let k = 0;
const key = () => `ss-key-${String(++k).padStart(12, "0")}`;
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const docAt = (p) => world.db.docs.get(p);
const docsUnder = (prefix) => [...world.db.docs.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => ({ path: p, ...d }));
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

async function products(uid, body, businessId = "biz-a") {
  const res = await createProductsHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const quick = (product, uid = world.uids.ownera, businessId = "biz-a") => products(uid, { action: "quickAdd", product }, businessId);
const order = (items, now = NOW) => createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { customer: { name: "Marian" }, source: "phone", items }, idempotencyKey: key(), actor, canDiscount: false, now });
const fulfill = (orderId) => fulfillOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, actor, now: NOW });

describe("Quick Add Product (New Order)", () => {
  it("TEST CASE 1: Nipple Tape ₱250, nothing else → Track inventory OFF; sold, fulfilled and sold again with no stock or COGS error", async () => {
    const r = ok(await quick({ name: "Nipple Tape", sellingPrice: 25000 }), 201);
    expect(r.product).toMatchObject({ name: "Nipple Tape", sellingPrice: 25000, unit: "pcs", trackInventory: false, status: "active", onHand: 0, available: 0, isLowStock: false });
    expect(r.product.sku).toMatch(/^NIPPLE-TAPE-[A-Z0-9]{4}$/);
    const id = r.productId;
    const { orderId } = await order([{ productId: id, quantity: Q(3) }]);
    const o = docAt(`businesses/biz-a/orders/${orderId}`);
    expect(o.items[0]).toMatchObject({ name: "Nipple Tape", unitPrice: 25000, untracked: true });
    expect(o.total).toBe(75000);
    // No reservation, no stock movement.
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ onHand: 0, reserved: 0, available: 0, movementCount: 0, isLowStock: false, orderUses: 1 });
    expect(docsUnder("businesses/biz-a/inventoryTransactions/")).toHaveLength(0);
    const f = await fulfill(orderId);
    expect(f.cogs).toBe(0); // no COGS entered: ₱0 cost, never an error
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ onHand: 0, reserved: 0 });
    // Reusable: the next order sells it again, any quantity.
    const again = await order([{ productId: id, quantity: Q(500) }]);
    expect(docAt(`businesses/biz-a/orders/${again.orderId}`).items[0].untracked).toBe(true);
    // A product on orders can't be deleted (deactivate instead).
    await expect(deleteUnusedProduct({ db: world.db, tenant: A, FieldValue, productId: id, actor })).rejects.toMatchObject({ code: "product-in-use" });
  });

  it("TEST CASE 2: White Top ₱350 with stock 2 → Track inventory ON, stock 2; normal reservation and deduction", async () => {
    const r = ok(await quick({ name: "White Top", sellingPrice: 35000, stock: Q(2) }), 201);
    expect(r.product).toMatchObject({ trackInventory: true, onHand: Q(2), available: Q(2) });
    const id = r.productId;
    const first = await order([{ productId: id, quantity: Q(2) }]);
    expect(docAt(`businesses/biz-a/orders/${first.orderId}`).items[0].untracked).toBeUndefined();
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ reserved: Q(2), available: 0 });
    await expect(order([{ productId: id, quantity: Q(1) }])).rejects.toMatchObject({ code: "insufficient-stock" });
    await fulfill(first.orderId);
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ onHand: 0, reserved: 0, available: 0 });
    // Its starting stock has no cost yet ("no cost set", not a made-up ₱0).
    expect(docAt(`businesses/biz-a/productCosts/${id}`).avgCostUnits).toBeNull();
  });

  it("optional Category and COGS (₱0 is fine); untracked products still book COGS at their unit cost", async () => {
    const r = ok(await quick({ name: "Black Shoes", sellingPrice: 80000, category: "Shoes", unitCost: 50000 }), 201);
    expect(r.product).toMatchObject({ category: "Shoes", trackInventory: false });
    const z = ok(await quick({ name: "Free Sticker", sellingPrice: 100, unitCost: 0 }), 201);
    const { orderId } = await order([{ productId: r.productId, quantity: Q(2) }, { productId: z.productId, quantity: Q(1) }]);
    const f = await fulfill(orderId);
    expect(f.cogs).toBe(100000); // 2 × ₱500 + 1 × ₱0
    expect(docAt(`businesses/biz-a/orderCosts/${orderId}`).lines.map((l) => l.costConsumed)).toEqual([100000, 0]);
  });

  it("required: name and price; only fields Quick Add knows; Reseller owners add with the owner/base price", async () => {
    expect((await quick({ sellingPrice: 100 })).status).toBe(400);
    expect((await quick({ name: "X" })).status).toBe(400);
    expect((await quick({ name: "X", sellingPrice: 100, sku: "HACK" })).status).toBe(400);
    expect((await quick({ name: "X", sellingPrice: 100, stock: -1 })).status).toBe(400);
    expect((await quick({ name: "X", sellingPrice: 100, stock: 1500 })).status).toBe(400); // 1.5 pcs
    // Reseller workspace: the price is the owner/base price; resellers set theirs per order.
    await createBusiness({ ...world, name: "Res", planId: "reseller-basic", workspaceTemplateId: "reseller", businessId: "res-q" });
    const o = await ensureAuthUser({ auth: world.auth, email: "owner@res-q.test", name: "Owner" });
    await addMember({ ...world, businessId: "res-q", uid: o.uid, email: o.email, name: "Owner", roleTemplate: "owner", isAccountOwner: true });
    const p = ok(await quick({ name: "Glow Serum", sellingPrice: 50000 }, o.uid, "res-q"), 201);
    expect(p.product).toMatchObject({ sellingPrice: 50000, trackInventory: false });
    const created = ok(await (async () => {
      const res = await createResellersHandler(deps())({ ...request({ uid: o.uid, businessId: "res-q", method: "POST" }), body: JSON.stringify({ action: "create", reseller: { name: "Riza" } }) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    })(), 201);
    const token = created.path.split("#")[1];
    const menu = async (body) => {
      const res = await createResellerMenuHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    // Reseller Menu: an untracked product is shown and orderable (never out of stock).
    const v = ok(await menu({ action: "view", token }));
    expect(v.products).toEqual([expect.objectContaining({ id: p.productId, ownerPrice: 50000 })]);
    expect(v.products[0].max).toBeGreaterThan(0);
    const placed = ok(await menu({ action: "order", token, idempotencyKey: key(), order: { customerName: "Ana", fulfillment: "pickup", items: [{ productId: p.productId, quantity: Q(4), sellingPrice: 65000 }] } }), 201);
    expect(placed).toMatchObject({ total: 260000, commission: 60000 });
  });

  it("permissions and tenants: Staff can't Quick Add; a COGS needs cost access; one business never touches another's products", async () => {
    expect((await quick({ name: "X", sellingPrice: 100 }, world.uids.staffa)).status).toBe(403);
    // A COGS needs inventory.costs (refused before anything is created).
    await expect(quickAddProduct({ db: world.db, tenant: A, FieldValue, input: { name: "Y", sellingPrice: 100, unitCost: 50 }, canSetCost: false, actor })).rejects.toMatchObject({ code: "forbidden-cost" });
    expect(docsUnder("businesses/biz-a/products/")).toHaveLength(0);
    const a = ok(await quick({ name: "Only A", sellingPrice: 100 }), 201);
    expect(docsUnder("businesses/biz-b/products/")).toHaveLength(0);
    expect((await products(world.uids.ownerb, { action: "setTracking", productId: a.productId, track: true }, "biz-b")).status).toBe(404);
    expect((await products(world.uids.ownera, { action: "setTracking", productId: a.productId, track: true }, "biz-b")).status).toBe(403);
  });
});

describe("Track inventory ON / OFF", () => {
  it("OFF → ON with stock (and a cost): a Starting stock; orders taken while untracked never touch stock", async () => {
    const id = ok(await quick({ name: "Lip Tint", sellingPrice: 20000 }), 201).productId;
    const early = await order([{ productId: id, quantity: Q(3) }]); // untracked line
    const on = ok(await products(world.uids.ownera, { action: "setTracking", productId: id, track: true, stock: Q(10), unitCost: 8000 }));
    expect(on.trackInventory).toBe(true);
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ trackInventory: true, onHand: Q(10), reserved: 0, available: Q(10), movementCount: 1 });
    expect(docsUnder("businesses/biz-a/inventoryTransactions/").map((t) => [t.type, t.quantity, t.note])).toEqual([["opening", Q(10), "Track inventory turned on"]]);
    // The early order fulfils without deducting stock it never set aside; its COGS uses the cost now known.
    const f = await fulfill(early.orderId);
    expect(f.cogs).toBe(24000);
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ onHand: Q(10), reserved: 0 });
    // New orders follow normal stock rules.
    const later = await order([{ productId: id, quantity: Q(4) }]);
    expect(docAt(`businesses/biz-a/orders/${later.orderId}`).items[0].untracked).toBeUndefined();
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ reserved: Q(4), available: Q(6) });
    await expect(order([{ productId: id, quantity: Q(7) }])).rejects.toMatchObject({ code: "insufficient-stock" });
    // OFF is refused while an open order has stock set aside.
    expect((await products(world.uids.ownera, { action: "setTracking", productId: id, track: false })).body).toMatchObject({ error: "has-reservations" });
    await cancelOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId: later.orderId, reason: "Customer changed mind", actor, now: NOW });
    ok(await products(world.uids.ownera, { action: "setTracking", productId: id, track: false }));
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ trackInventory: false, isLowStock: false, onHand: Q(10) });
    // Manual stock moves need tracking on.
    await expect(recordMovement({ db: world.db, tenant: A, FieldValue, productId: id, actor, movement: { type: "receipt", quantity: Q(1), unitCost: 100 } })).rejects.toMatchObject({ code: "untracked" });
    // Back ON with a stock count to the figure counted now.
    ok(await products(world.uids.ownera, { action: "setTracking", productId: id, track: true, stock: Q(7) }));
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ trackInventory: true, onHand: Q(7), available: Q(7) });
  });

  it("an existing tracked product is untouched: no field added, same stock rules; editing an untracked line keeps it untracked", async () => {
    const { productId: old } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: "OLD-1", name: "Old Item", unit: "pcs", sellingPrice: 1000, reorderLevel: 0 } });
    expect(docAt(`businesses/biz-a/products/${old}`)).not.toHaveProperty("trackInventory");
    await expect(order([{ productId: old, quantity: Q(1) }])).rejects.toMatchObject({ code: "insufficient-stock" });
    const id = ok(await quick({ name: "Tape", sellingPrice: 5000 }), 201).productId;
    const { orderId } = await order([{ productId: id, quantity: Q(1) }]);
    ok(await products(world.uids.ownera, { action: "setTracking", productId: id, track: true, stock: Q(2) }));
    await updateOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, input: { customer: { name: "Marian" }, source: "phone", items: [{ productId: id, quantity: Q(5) }] }, actor, canDiscount: false });
    const o = docAt(`businesses/biz-a/orders/${orderId}`);
    expect(o.items[0]).toMatchObject({ quantity: Q(5), untracked: true });
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ onHand: Q(2), reserved: 0, available: Q(2) });
  });
});

describe("forgiving product import", () => {
  async function importRows(rows, { canSetCost = true } = {}) {
    const p = await previewImport({ db: world.db, tenant: A, FieldValue, type: "products", fileName: "products.xlsx", rows: rows.map((values, i) => ({ n: i + 2, values })), actor, now: NOW });
    const c = await commitImport({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, jobId: p.jobId, actor, now: NOW, canSetCost });
    return { preview: p, commit: c, products: docsUnder("businesses/biz-a/products/") };
  }

  it("TEST CASE 3: Product | Price only → 3 products, Track inventory OFF, SKUs made, usable in orders at once", async () => {
    const { preview, commit, products: list } = await importRows([{ name: "Nipple Tape", sellingPrice: "250" }, { name: "White Top", sellingPrice: "350" }, { name: "Black Shoes", sellingPrice: "800" }]);
    expect(preview.counts).toMatchObject({ total: 3, ready: 3, error: 0 });
    expect(commit.result).toMatchObject({ created: 3 });
    expect(list.map((p) => [p.name, p.sellingPrice, p.unit, p.trackInventory, p.available]).sort()).toEqual([["Black Shoes", 80000, "pcs", false, 0], ["Nipple Tape", 25000, "pcs", false, 0], ["White Top", 35000, "pcs", false, 0]]);
    for (const p of list) expect(p.sku).toMatch(/^[A-Z0-9-]+-[A-Z0-9]{4}$/);
    const id = list.find((p) => p.name === "White Top").path.split("/").pop();
    const { orderId } = await order([{ productId: id, quantity: Q(10) }]);
    expect(docAt(`businesses/biz-a/orders/${orderId}`).total).toBe(350000);
  });

  it("TEST CASE 4: Product | Category | Stock | Price | COGS → tracked with that stock, COGS ₱0 accepted, categories saved", async () => {
    const { commit, products: list } = await importRows([{ name: "Nipple Tape", category: "Beauty", stock: "30", sellingPrice: "250", cogs: "0" }, { name: "White Top", category: "Shirts", stock: "2", sellingPrice: "350", cogs: "180" }]);
    expect(commit.result).toMatchObject({ created: 2 });
    const by = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(by["Nipple Tape"]).toMatchObject({ category: "Beauty", trackInventory: true, onHand: Q(30), available: Q(30), sellingPrice: 25000 });
    expect(by["White Top"]).toMatchObject({ category: "Shirts", trackInventory: true, onHand: Q(2), available: Q(2) });
    const cost = (name) => docAt(`businesses/biz-a/productCosts/${by[name].path.split("/").pop()}`).avgCostUnits;
    expect(cost("Nipple Tape")).toBe(0);
    expect(cost("White Top")).toBeGreaterThan(0);
  });

  it("missing price is imported and flagged (off the menus until priced); bad cells flag only their row; Track Inventory column wins", async () => {
    const { preview, commit, products: list } = await importRows([
      { name: "No Price Yet" },
      { name: "Bad Stock", stock: "lots" },
      { name: "Counted But Off", stock: "5", trackInventory: "No", sellingPrice: "10" },
      { name: "On No Stock", trackInventory: "yes", sellingPrice: "10" },
      { name: "", sellingPrice: "10" },
    ]);
    expect(preview.counts).toMatchObject({ total: 5, error: 2 });
    expect(preview.rows.find((r) => r.n === 2)).toMatchObject({ status: "ready", messages: ["No price yet: set one before selling it"] });
    expect(preview.rows.find((r) => r.n === 3).messages[0]).toMatch(/^Stock: /);
    expect(preview.rows.find((r) => r.n === 4).messages[0]).toMatch(/Track Inventory is No/);
    expect(commit.result).toMatchObject({ created: 3 });
    const by = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(by["No Price Yet"]).toMatchObject({ sellingPrice: 0, needsPrice: true, trackInventory: false });
    expect(by["Counted But Off"]).toMatchObject({ trackInventory: false, onHand: 0 });
    expect(by["On No Stock"]).toMatchObject({ trackInventory: true, onHand: 0 });
    // Pricing it later clears the flag.
    const id = by["No Price Yet"].path.split("/").pop();
    await updateProduct({ db: world.db, tenant: A, FieldValue, productId: id, changes: { sellingPrice: 9900 }, actor });
    expect(docAt(`businesses/biz-a/products/${id}`)).toMatchObject({ sellingPrice: 9900, needsPrice: false });
  });

  it("COGS from a file needs cost access (ignored without it); SKUs from the file still work; existing SKUs are skipped", async () => {
    const { products: list } = await importRows([{ name: "Costed", sku: "C-1", sellingPrice: "100", cogs: "40" }], { canSetCost: false });
    expect(list[0]).toMatchObject({ sku: "C-1" });
    expect(docAt(`businesses/biz-a/productCosts/${list[0].path.split("/").pop()}`).avgCostUnits).toBeNull();
    const again = await importRows([{ name: "Costed again", sku: "C-1", sellingPrice: "100" }]);
    expect(again.commit.result).toMatchObject({ created: 0, skipped: 1 });
  });
});

describe("Share Menu: untracked products are sold while active and shown on the menu", () => {
  const store = async (body) => {
    const res = await createStoreHandler(deps())({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": "203.0.113.7" }, body: JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const owner = async (body) => {
    const res = await createStorefrontHandler(deps())({ ...request({ uid: world.uids.ownera, businessId: "biz-a", method: "POST" }), body: JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it("never sold out, no 'only N left'; Show on Menu OFF hides it; a tracked product with no stock stays sold out", async () => {
    const got = ok(await owner({ action: "get" }));
    ok(await owner({ action: "save", settings: { open: true, pickup: true, delivery: true, paymentMethods: ["cod"] } }));
    const slug = got.settings.slug;
    const tape = ok(await quick({ name: "Nipple Tape", sellingPrice: 25000 }), 201).productId;
    const { productId: empty } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: "EMPTY-1", name: "Empty Tracked", unit: "pcs", sellingPrice: 1000, reorderLevel: 0 } });
    let v = ok(await store({ action: "view", slug }));
    const shown = v.products.find((p) => p.id === tape);
    expect(shown).toMatchObject({ name: "Nipple Tape", price: 25000, soldOut: false, left: null });
    expect(shown.max).toBeGreaterThan(0);
    expect(v.products.some((p) => p.id === empty)).toBe(false); // tracked, 0 stock: sold out as before
    const placed = await store({ action: "order", slug, idempotencyKey: key(), order: { name: "Marian Santos", phone: "0917 123 4567", fulfillment: "pickup", paymentMethod: "cod", items: [{ productId: tape, quantity: Q(2) }] } });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    ok(await owner({ action: "showOnMenu", productId: tape, show: false }));
    v = ok(await store({ action: "view", slug }));
    expect(v.products.some((p) => p.id === tape)).toBe(false);
  });
});

describe("skuFromName", () => {
  it("makes a valid SKU from any name", () => {
    expect(skuFromName("Nipple Tape", () => "ab12")).toBe("NIPPLE-TAPE-AB12");
    expect(skuFromName("  ", () => "zz99")).toBe("ITEM-ZZ99");
    expect(skuFromName("Café Ñame / 1kg pack (big)", () => "q1w2")).toMatch(/^[A-Z0-9-]{1,40}$/);
  });
});
