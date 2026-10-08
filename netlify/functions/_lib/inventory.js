// Products + inventory service (server only; Admin SDK). Every write runs in
// a Firestore transaction that reads the current documents, decides with
// shared/inventory.js, and writes the result. Nothing the browser sends is
// used as a balance or a cost; it only says WHAT to do.
//
// Documents (all under businesses/{bid}/):
//   products/{productId}                   master data + balances + isLowStock   (inventory.view)
//   productCosts/{productId}               moving average cost, value             (inventory.costs)
//   skuIndex/{SKU}                         { productId }: per-business SKU uniqueness (server only)
//   inventoryTransactions/{txId}           append-only movement log, quantities   (inventory.view)
//   inventoryTransactionCosts/{txId}       the same movement's cost side          (inventory.costs)
//   metrics/current.lowStockProducts       gauge, +/-1 only when a product flips
// Total inventory value is NOT a gauge (it would be a business-wide write
// hot spot): sum() over productCosts.inventoryValue gives it in one query.
//   auditLog/{id}                          product master-data changes
//
// Phase 7 uses prepareMovements() inside its own order transaction:
//   const plan = await prepareMovements(tx, { tenant, items: [{ productId, movement: { type: "reservation", quantity } }] });
//   ...write the order...
//   plan.commit({ actor, FieldValue });          // writes balances, log, gauges
//   plan.results[0].costConsumed                 // COGS snapshot on fulfillment

import {
  PRODUCT_SCHEMA_VERSION,
  validateProductInput,
  isLowStock,
  isValidProductId,
  planMovement,
  InventoryError,
  MOVEMENT_TYPES,
} from "../../../shared/inventory.js";
import { inventoryValue } from "../../../shared/quantity.js";
import { adjustCurrentMetrics } from "./metrics.js";

const lower = (s) => (s || "").toLocaleLowerCase("en");

function refs(tenant, productId) {
  if (!isValidProductId(productId)) throw new InventoryError("invalid-product", "Invalid product id");
  return {
    product: tenant.doc("products", productId),
    costs: tenant.doc("productCosts", productId),
  };
}

// Same-product contention is real (popular items, Phase 7 orders); give
// inventory transactions more retries than the SDK's default 5.
const TX_OPTIONS = { maxAttempts: 10 };

function gaugeWrites(tx, { tenant, FieldValue, lowStockDelta = 0 }) {
  if (lowStockDelta) adjustCurrentMetrics({ tx, tenant, FieldValue, operational: { lowStockProducts: lowStockDelta } });
}

function audit(tx, tenant, FieldValue, entry) {
  tx.set(tenant.collection("auditLog").doc(), { ...entry, at: FieldValue.serverTimestamp() });
}

// ---------- Products ----------

// hooks (imports): { read(tx) before any write, may throw; write(tx, productId) }
// let an import mark its row done in the SAME transaction (idempotent).
export async function createProduct({ db, tenant, FieldValue, input, actor, hooks = null }) {
  const data = validateProductInput(input);
  const productRef = tenant.collection("products").doc();
  const skuRef = tenant.doc("skuIndex", data.sku);

  return db.runTransaction(async (tx) => {
    const skuSnap = await tx.get(skuRef);
    if (skuSnap.exists) throw new InventoryError("duplicate-sku", `SKU ${data.sku} is already used by another product`);
    if (hooks && hooks.read) await hooks.read(tx);

    const now = FieldValue.serverTimestamp();
    const product = {
      schemaVersion: PRODUCT_SCHEMA_VERSION,
      ...data,
      nameLower: lower(data.name),
      categoryLower: lower(data.category),
      status: "active",
      onHand: 0,
      reserved: 0,
      available: 0,
      movementCount: 0,
      isLowStock: isLowStock({ status: "active", available: 0, reorderLevel: data.reorderLevel }),
      createdBy: actor,
      createdAt: now,
      updatedBy: actor,
      updatedAt: now,
    };
    // create() fails if a concurrent transaction claimed the SKU first.
    tx.create(skuRef, { productId: productRef.id, createdAt: now });
    tx.create(productRef, product);
    tx.create(tenant.doc("productCosts", productRef.id), { schemaVersion: PRODUCT_SCHEMA_VERSION, productId: productRef.id, avgCostUnits: null, lastReceiptUnitCost: null, inventoryValue: 0, updatedAt: now });
    gaugeWrites(tx, { tenant, FieldValue, lowStockDelta: product.isLowStock ? 1 : 0 });
    audit(tx, tenant, FieldValue, { type: "product.created", productId: productRef.id, actor, after: data });
    if (hooks && hooks.write) hooks.write(tx, productRef.id);
    return { productId: productRef.id, product: { ...product, createdAt: null, updatedAt: null } };
  }, TX_OPTIONS);
}

export async function updateProduct({ db, tenant, FieldValue, productId, changes, actor }) {
  const { product: productRef } = refs(tenant, productId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(productRef);
    if (!snap.exists) throw new InventoryError("not-found", "Product not found");
    const current = snap.data();
    const data = validateProductInput(changes, { existing: current });

    let newSkuRef = null;
    if (data.sku !== undefined && data.sku !== current.sku) {
      newSkuRef = tenant.doc("skuIndex", data.sku);
      if ((await tx.get(newSkuRef)).exists) throw new InventoryError("duplicate-sku", `SKU ${data.sku} is already used by another product`);
    }

    const merged = { ...current, ...data };
    const low = isLowStock({ status: merged.status, available: merged.available, reorderLevel: merged.reorderLevel });
    const update = { ...data, isLowStock: low, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() };
    if (data.name !== undefined) update.nameLower = lower(data.name);
    if (data.category !== undefined) update.categoryLower = lower(data.category);

    if (newSkuRef) {
      tx.create(newSkuRef, { productId, createdAt: FieldValue.serverTimestamp() });
      tx.delete(tenant.doc("skuIndex", current.sku));
    }
    tx.update(productRef, update);
    gaugeWrites(tx, { tenant, FieldValue, lowStockDelta: (low ? 1 : 0) - (current.isLowStock ? 1 : 0) });
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, current[k] ?? null]));
    audit(tx, tenant, FieldValue, { type: "product.updated", productId, actor, before, after: data });
    return { productId, product: { ...merged, isLowStock: low } };
  }, TX_OPTIONS);
}

export async function setProductStatus({ db, tenant, FieldValue, productId, status, actor }) {
  if (!["active", "inactive"].includes(status)) throw new InventoryError("invalid-input", "Status must be active or inactive");
  const { product: productRef } = refs(tenant, productId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(productRef);
    if (!snap.exists) throw new InventoryError("not-found", "Product not found");
    const current = snap.data();
    if (current.status === status) return { productId, product: current };
    if (status === "inactive" && current.reserved > 0) throw new InventoryError("has-reservations", "A product with reserved stock can't be deactivated");
    const low = isLowStock({ status, available: current.available, reorderLevel: current.reorderLevel });
    tx.update(productRef, { status, isLowStock: low, updatedBy: actor, updatedAt: FieldValue.serverTimestamp() });
    gaugeWrites(tx, { tenant, FieldValue, lowStockDelta: (low ? 1 : 0) - (current.isLowStock ? 1 : 0) });
    audit(tx, tenant, FieldValue, { type: "product.status", productId, actor, before: { status: current.status }, after: { status } });
    return { productId, product: { ...current, status, isLowStock: low } };
  }, TX_OPTIONS);
}

// Deletion only for products that never moved: no stock, no reservations,
// no inventory history. Anything else is deactivated instead, so history
// and its snapshots stay intact.
export async function deleteUnusedProduct({ db, tenant, FieldValue, productId, actor }) {
  const { product: productRef, costs: costsRef } = refs(tenant, productId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(productRef);
    if (!snap.exists) throw new InventoryError("not-found", "Product not found");
    const p = snap.data();
    if (p.movementCount > 0 || p.onHand !== 0 || p.reserved !== 0) {
      throw new InventoryError("product-in-use", "Products with stock history can't be deleted. Deactivate it instead");
    }
    tx.delete(productRef);
    tx.delete(costsRef);
    tx.delete(tenant.doc("skuIndex", p.sku));
    gaugeWrites(tx, { tenant, FieldValue, lowStockDelta: p.isLowStock ? -1 : 0 });
    audit(tx, tenant, FieldValue, { type: "product.deleted", productId, actor, before: { sku: p.sku, name: p.name } });
    return { productId, deleted: true };
  }, TX_OPTIONS);
}

// ---------- Movements ----------

// Phase 1 of a movement transaction: READ every product involved, plan
// each movement (throws on anything invalid, before any write). Returns
// { results, commit } where commit() performs all the writes. Callers
// that write their own documents (Phase 7 orders) do their reads first,
// call prepareMovements, then write, then commit().
export async function prepareMovements(tx, { tenant, items }) {
  if (!Array.isArray(items) || !items.length) throw new InventoryError("invalid-input", "No movements");
  const ids = items.map((i) => i.productId);
  if (new Set(ids).size !== ids.length) throw new InventoryError("invalid-input", "Combine quantities per product into one movement");

  const loaded = [];
  for (const item of items) {
    const r = refs(tenant, item.productId);
    const [productSnap, costSnap] = await Promise.all([tx.get(r.product), tx.get(r.costs)]);
    if (!productSnap.exists || !costSnap.exists) throw new InventoryError("not-found", "Product not found");
    loaded.push({ item, refs: r, product: productSnap.data(), costs: costSnap.data() });
  }

  const planned = loaded.map(({ item, refs: r, product, costs }) => {
    const state = {
      status: product.status,
      unit: product.unit,
      onHand: product.onHand,
      reserved: product.reserved,
      reorderLevel: product.reorderLevel,
      movementCount: product.movementCount,
      avgCostUnits: costs.avgCostUnits ?? null,
    };
    return { item, refs: r, product, costs, state, plan: planMovement(state, item.movement) };
  });

  function commit({ actor, FieldValue }) {
    const now = FieldValue.serverTimestamp();
    let lowStockDelta = 0;
    for (const { item, refs: r, product, costs, state, plan } of planned) {
      const m = item.movement;
      const { next } = plan;
      const seq = next.movementCount;
      const txRef = tenant.collection("inventoryTransactions").doc();

      tx.update(r.product, { onHand: next.onHand, reserved: next.reserved, available: next.available, isLowStock: next.isLowStock, movementCount: seq, updatedAt: now });
      tx.update(r.costs, {
        avgCostUnits: next.avgCostUnits,
        inventoryValue: plan.valueAfter,
        ...(m.type === "opening" || m.type === "receipt" ? { lastReceiptUnitCost: m.unitCost } : {}),
        updatedAt: now,
      });

      const common = { schemaVersion: PRODUCT_SCHEMA_VERSION, productId: item.productId, seq, type: m.type, at: now };
      tx.create(txRef, {
        ...common,
        label: MOVEMENT_TYPES[m.type].label,
        sku: product.sku,
        productName: product.name,
        unit: product.unit,
        quantity: m.quantity,
        onHandDelta: plan.delta.onHand,
        reservedDelta: plan.delta.reserved,
        onHandBefore: state.onHand,
        onHandAfter: next.onHand,
        reservedBefore: state.reserved,
        reservedAfter: next.reserved,
        availableBefore: state.onHand - state.reserved,
        availableAfter: next.available,
        reason: m.reason ?? null,
        note: m.note ?? null,
        referenceType: m.referenceType ?? null,
        referenceId: m.referenceId ?? null,
        actor,
      });
      tx.create(tenant.doc("inventoryTransactionCosts", txRef.id), {
        ...common,
        unitCost: m.unitCost ?? null,
        avgCostBefore: costs.avgCostUnits ?? null,
        avgCostAfter: next.avgCostUnits,
        valueBefore: plan.valueBefore,
        valueAfter: plan.valueAfter,
        costConsumed: plan.costConsumed,
      });
      plan.transactionId = txRef.id;
      lowStockDelta += (next.isLowStock ? 1 : 0) - (product.isLowStock ? 1 : 0);
    }
    gaugeWrites(tx, { tenant, FieldValue, lowStockDelta });
    return planned.map(({ item, plan }) => ({ productId: item.productId, transactionId: plan.transactionId, next: plan.next, costConsumed: plan.costConsumed }));
  }

  // `product`: the trusted product fields read in THIS transaction, so callers
  // (orders) price and snapshot lines from the same reads, never from the browser.
  const snapshot = (p) => ({ sku: p.sku, name: p.name, unit: p.unit, sellingPrice: p.sellingPrice, status: p.status });
  return { results: planned.map(({ item, plan, product }) => ({ productId: item.productId, next: plan.next, costConsumed: plan.costConsumed, product: snapshot(product) })), commit };
}

// One movement on one product, in its own transaction.
export async function recordMovement({ db, tenant, FieldValue, productId, movement, actor }) {
  return db.runTransaction(async (tx) => {
    const plan = await prepareMovements(tx, { tenant, items: [{ productId, movement }] });
    return plan.commit({ actor, FieldValue })[0];
  }, TX_OPTIONS);
}

// What a caller may see of a product's cost side.
export function costView(costs, onHand) {
  if (!costs) return null;
  return { avgCostUnits: costs.avgCostUnits ?? null, lastReceiptUnitCost: costs.lastReceiptUnitCost ?? null, inventoryValue: inventoryValue(onHand, costs.avgCostUnits ?? 0) };
}
