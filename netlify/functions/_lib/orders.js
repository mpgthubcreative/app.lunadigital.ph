// Orders service (server only; Admin SDK). Each operation is ONE Firestore
// transaction: every read first (idempotency key, counter, usage, order,
// products via prepareMovements), every check before any write, then all
// writes together. Inventory changes go through the Phase 6 movement
// planner; nothing the browser sends is used as a price, name, cost, stock
// level or total.
//
// Operational sales recognition (shared/orders.js):
//   create   reserve + count the order (metrics/{day}.orderCount, usage) - no sales, no COGS
//   fulfill  consume stock, snapshot cost per line (orderCosts), and record
//            grossSales / discounts / cogs on the business-local FULFILLMENT day
//   cancel   release reservations (pending only) - no sales, no COGS
//
// Documents (businesses/{bid}/...):
//   orders/{orderId}                order, line snapshots, statusHistory      (orders.view)
//   orderCosts/{orderId}            per-line cost consumed, COGS, gross profit (dashboard.financials)
//   counters/orders-{YYYYMMDD}      next order sequence for that local day     (server only)
//   idempotencyKeys/{key}           create-once guard                          (server only)
//   usage/{YYYY-MM}.ordersCreated   plan limit counter (never decremented)     (server only)

import { createHash } from "node:crypto";
import {
  ORDER_SCHEMA_VERSION,
  MAX_HISTORY_ENTRIES,
  OrderError,
  validateOrderInput,
  computeTotals,
  formatOrderNumber,
  orderPrefixFor,
  isValidOrderId,
  isValidIdempotencyKey,
  paymentStatusFor,
} from "../../../shared/orders.js";
import { businessDate } from "../../../shared/metrics.js";
import { prepareMovements } from "./inventory.js";
import { recordDailyMetrics, adjustCurrentMetrics } from "./metrics.js";

const TX_OPTIONS = { maxAttempts: 10 };

function orderRef(tenant, orderId) {
  if (!isValidOrderId(orderId)) throw new OrderError("invalid-order", "Invalid order id");
  return tenant.doc("orders", orderId);
}

function historyEntry(type, actor, extra = {}) {
  // Server clock (serverTimestamp() can't be used inside arrays).
  return { type, at: new Date(), actor, ...extra };
}

function appendHistory(order, entry) {
  const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  if (history.length >= MAX_HISTORY_ENTRIES) throw new OrderError("history-full", "This order has too many changes; create a new order instead");
  return [...history, entry];
}

const hashRequest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function movementsFor(lines, type, orderId, orderNumber, reason) {
  return lines.map((l) => ({ productId: l.productId, movement: { type, quantity: l.quantity, referenceType: "order", referenceId: orderId, note: orderNumber, reason } }));
}

// ---------- Create ----------

export async function createOrder({ db, tenant, FieldValue, business, entitlements, input, idempotencyKey, actor, canDiscount, now = new Date() }) {
  if (!isValidIdempotencyKey(idempotencyKey)) throw new OrderError("invalid-input", "A valid idempotency key is required");
  const data = validateOrderInput(input);
  if (data.discount > 0 && !canDiscount) throw new OrderError("discount-not-allowed", "You don't have permission to give discounts");
  const limit = entitlements && entitlements.limits && entitlements.limits.ordersPerMonth;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new OrderError("business-misconfigured", "This business has no valid order limit");

  const day = businessDate(business.timezone, now); // throws on a bad timezone
  const month = day.slice(0, 7);
  const prefix = orderPrefixFor(business);
  const requestHash = hashRequest({ uid: actor.uid, data });

  const idemRef = tenant.doc("idempotencyKeys", idempotencyKey);
  const replay = (prior) => {
    if (prior.requestHash !== requestHash) throw new OrderError("idempotency-conflict", "This request key was already used for a different order");
    return { orderId: prior.orderId, orderNumber: prior.orderNumber, replayed: true };
  };

  try {
    return await runCreate();
  } catch (err) {
    // Two identical requests raced and the other one created the key first
    // (ALREADY_EXISTS from tx.create): this request is a replay of that order.
    if (err && err.code === 6) {
      const prior = await idemRef.get();
      if (prior.exists) return replay(prior.data());
    }
    throw err;
  }

  // The create itself: one transaction, all reads before any write.
  function runCreate() {
    return db.runTransaction(async (tx) => {
      const idem = await tx.get(idemRef);
      if (idem.exists) return replay(idem.data());

      const counterRef = tenant.doc("counters", `orders-${day.replace(/-/g, "")}`);
      const usageRef = tenant.doc("usage", month);
      const [counterSnap, usageSnap] = await Promise.all([tx.get(counterRef), tx.get(usageRef)]);
      const used = usageSnap.exists && Number.isSafeInteger(usageSnap.data().ordersCreated) ? usageSnap.data().ordersCreated : 0;
      if (used >= limit) throw new OrderError("order-limit-reached", `This month's order limit (${limit}) has been reached. Contact Luna to raise it.`);

      const seq = counterSnap.exists && Number.isSafeInteger(counterSnap.data().next) ? counterSnap.data().next : 1;
      const orderNumber = formatOrderNumber(prefix, day, seq);
      const ref = tenant.collection("orders").doc();

      const plan = await prepareMovements(tx, { tenant, items: movementsFor(data.items, "reservation", ref.id, orderNumber, "order_created") });
      for (const r of plan.results) {
        if (r.product.status !== "active") throw new OrderError("product-inactive", `${r.product.name} is inactive`);
      }
      const lines = plan.results.map((r, i) => ({
        lineId: `L${i + 1}`,
        productId: r.productId,
        sku: r.product.sku,
        name: r.product.name,
        unit: r.product.unit,
        quantity: data.items[i].quantity,
        unitPrice: r.product.sellingPrice,
      }));
      const totals = computeTotals(lines, data.discount);

      const stamp = FieldValue.serverTimestamp();
      const order = {
        schemaVersion: ORDER_SCHEMA_VERSION,
        orderNumber,
        orderDate: day,
        source: data.source,
        sourceNote: data.sourceNote || null,
        customer: data.customer,
        customerId: null, // linked in Phase 9
        customerNameLower: data.customer.name.toLocaleLowerCase("en"),
        items: totals.lines,
        itemCount: totals.lines.length,
        subtotal: totals.subtotal,
        discount: totals.discount,
        total: totals.total,
        amountPaid: 0,
        balance: totals.total,
        paymentStatus: "unpaid",
        fulfillmentStatus: "pending",
        statusHistory: [historyEntry("created", actor, { to: "pending" })],
        notes: data.notes || null,
        revision: 1,
        idempotencyKey,
        createdBy: actor,
        createdAt: stamp,
        updatedBy: actor,
        updatedAt: stamp,
        fulfilledBy: null,
        fulfilledAt: null,
        fulfilledDay: null,
        cancelledBy: null,
        cancelledAt: null,
        cancellationReason: null,
      };

      tx.create(idemRef, { orderId: ref.id, orderNumber, requestHash, uid: actor.uid, createdAt: stamp });
      tx.create(ref, order);
      tx.set(counterRef, { next: seq + 1, day, updatedAt: stamp });
      tx.set(usageRef, { period: month, ordersCreated: FieldValue.increment(1), updatedAt: stamp }, { merge: true });
      recordDailyMetrics({ tx, tenant, FieldValue, timezone: business.timezone, at: now, operational: { orderCount: 1 } });
      adjustCurrentMetrics({ tx, tenant, FieldValue, operational: { pendingFulfillment: 1, unpaidOrders: 1 }, financial: { receivablesOutstanding: totals.total } });
      plan.commit({ actor, FieldValue });
      return { orderId: ref.id, orderNumber, replayed: false, order: { ...order, createdAt: null, updatedAt: null } };
    }, TX_OPTIONS);
  }
}

// ---------- Edit (pending only) ----------

// Existing lines keep their price/name snapshot; new products are priced
// from the product now; removed products are released. Only the
// reservation DIFFERENCE moves: 20 -> 15 releases 5, 20 -> 30 reserves 10.
export async function updateOrder({ db, tenant, FieldValue, orderId, input, expectedRevision = null, actor, canDiscount }) {
  const ref = orderRef(tenant, orderId);
  const data = validateOrderInput(input);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new OrderError("not-found", "Order not found");
    const order = snap.data();
    if (order.fulfillmentStatus !== "pending") throw new OrderError("not-pending", `A ${order.fulfillmentStatus} order can't be edited`);
    if (expectedRevision !== null && expectedRevision !== order.revision) throw new OrderError("stale-order", "This order was changed by someone else. Reload and try again");
    if (data.discount !== order.discount && !canDiscount) throw new OrderError("discount-not-allowed", "You don't have permission to change the discount");

    const oldLines = new Map(order.items.map((l) => [l.productId, l]));
    const newQty = new Map(data.items.map((i) => [i.productId, i.quantity]));
    const moves = [];
    const changes = [];
    for (const [productId, quantity] of newQty) {
      const before = oldLines.get(productId);
      const delta = quantity - (before ? before.quantity : 0);
      if (delta > 0) moves.push({ productId, movement: { type: "reservation", quantity: delta, referenceType: "order", referenceId: orderId, note: order.orderNumber, reason: "order_edited" } });
      if (delta < 0) moves.push({ productId, movement: { type: "release", quantity: -delta, referenceType: "order", referenceId: orderId, note: order.orderNumber, reason: "order_edited" } });
      if (delta !== 0) changes.push({ productId, sku: before ? before.sku : null, from: before ? before.quantity : 0, to: quantity });
    }
    for (const [productId, line] of oldLines) {
      if (!newQty.has(productId)) {
        moves.push({ productId, movement: { type: "release", quantity: line.quantity, referenceType: "order", referenceId: orderId, note: order.orderNumber, reason: "order_edited" } });
        changes.push({ productId, sku: line.sku, from: line.quantity, to: 0 });
      }
    }

    const plan = moves.length ? await prepareMovements(tx, { tenant, items: moves }) : null;
    const fresh = new Map(plan ? plan.results.map((r) => [r.productId, r.product]) : []);
    let n = order.items.length;
    const lines = data.items.map((i) => {
      const prior = oldLines.get(i.productId);
      if (prior) return { lineId: prior.lineId, productId: prior.productId, sku: prior.sku, name: prior.name, unit: prior.unit, quantity: i.quantity, unitPrice: prior.unitPrice };
      const p = fresh.get(i.productId);
      if (!p || p.status !== "active") throw new OrderError("product-inactive", "A new product on the order is unavailable");
      n += 1;
      // New products are added at their current trusted price.
      for (const c of changes) if (c.productId === i.productId) c.sku = p.sku;
      return { lineId: `L${n}`, productId: i.productId, sku: p.sku, name: p.name, unit: p.unit, quantity: i.quantity, unitPrice: p.sellingPrice };
    });
    const totals = computeTotals(lines, data.discount);
    const amountPaid = order.amountPaid || 0;
    if (totals.total < amountPaid) throw new OrderError("below-paid", "The new total would be less than what's already been paid");

    const customerChanged = JSON.stringify(order.customer) !== JSON.stringify(data.customer);
    const entry = historyEntry("edited", actor, {
      from: "pending",
      to: "pending",
      changes: {
        lines: changes,
        ...(data.discount !== order.discount ? { discount: { from: order.discount, to: data.discount } } : {}),
        ...(totals.total !== order.total ? { total: { from: order.total, to: totals.total } } : {}),
        ...(customerChanged ? { customer: true } : {}),
        ...(data.source !== order.source ? { source: { from: order.source, to: data.source } } : {}),
      },
    });

    tx.update(ref, {
      customer: data.customer,
      customerNameLower: data.customer.name.toLocaleLowerCase("en"),
      source: data.source,
      sourceNote: data.sourceNote || null,
      notes: data.notes || null,
      items: totals.lines,
      itemCount: totals.lines.length,
      subtotal: totals.subtotal,
      discount: totals.discount,
      total: totals.total,
      balance: totals.total - amountPaid,
      paymentStatus: paymentStatusFor({ total: totals.total, amountPaid }),
      statusHistory: appendHistory(order, entry),
      revision: order.revision + 1,
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const totalDelta = totals.total - order.total;
    if (totalDelta) adjustCurrentMetrics({ tx, tenant, FieldValue, financial: { receivablesOutstanding: totalDelta } });
    if (plan) plan.commit({ actor, FieldValue });
    return { orderId, revision: order.revision + 1, total: totals.total };
  }, TX_OPTIONS);
}

// ---------- Fulfill ----------

export async function fulfillOrder({ db, tenant, FieldValue, business, orderId, actor, now = new Date() }) {
  const ref = orderRef(tenant, orderId);
  const day = businessDate(business.timezone, now);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new OrderError("not-found", "Order not found");
    const order = snap.data();
    if (order.fulfillmentStatus !== "pending") throw new OrderError("not-pending", `This order is already ${order.fulfillmentStatus}`);

    const plan = await prepareMovements(tx, { tenant, items: movementsFor(order.items, "fulfillment", orderId, order.orderNumber, "order_fulfilled") });
    const consumed = new Map(plan.results.map((r) => [r.productId, r.costConsumed]));
    const costLines = order.items.map((l) => ({ lineId: l.lineId, productId: l.productId, quantity: l.quantity, lineSubtotal: l.lineSubtotal, costConsumed: consumed.get(l.productId) }));
    const cogs = costLines.reduce((s, l) => s + l.costConsumed, 0);
    const stamp = FieldValue.serverTimestamp();

    tx.update(ref, {
      fulfillmentStatus: "fulfilled",
      fulfilledBy: actor,
      fulfilledAt: stamp,
      fulfilledDay: day,
      statusHistory: appendHistory(order, historyEntry("fulfilled", actor, { from: "pending", to: "fulfilled" })),
      revision: order.revision + 1,
      updatedBy: actor,
      updatedAt: stamp,
    });
    // The cost snapshot IS this order's COGS forever; later cost changes can't reach it.
    tx.create(tenant.doc("orderCosts", orderId), {
      schemaVersion: ORDER_SCHEMA_VERSION,
      orderId,
      orderNumber: order.orderNumber,
      fulfilledDay: day,
      lines: costLines,
      grossSales: order.subtotal,
      discount: order.discount,
      netSales: order.total,
      cogs,
      grossProfit: order.total - cogs,
      createdAt: stamp,
    });
    recordDailyMetrics({ tx, tenant, FieldValue, timezone: business.timezone, at: now, operational: { fulfilledOrders: 1 }, financial: { grossSales: order.subtotal, discounts: order.discount, cogs } });
    adjustCurrentMetrics({ tx, tenant, FieldValue, operational: { pendingFulfillment: -1 } });
    plan.commit({ actor, FieldValue });
    return { orderId, fulfilledDay: day, cogs, grossSales: order.subtotal, discount: order.discount, netSales: order.total };
  }, TX_OPTIONS);
}

// ---------- Cancel (pending only) ----------

export async function cancelOrder({ db, tenant, FieldValue, business, orderId, reason, actor, now = new Date() }) {
  const ref = orderRef(tenant, orderId);
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (why.length < 3 || why.length > 300) throw new OrderError("invalid-input", "Give a cancellation reason (3-300 characters)");

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new OrderError("not-found", "Order not found");
    const order = snap.data();
    if (order.fulfillmentStatus !== "pending") {
      throw new OrderError("not-pending", order.fulfillmentStatus === "fulfilled" ? "A fulfilled order can't be cancelled (returns will handle reversals)" : "This order is already cancelled");
    }
    const plan = await prepareMovements(tx, { tenant, items: movementsFor(order.items, "release", orderId, order.orderNumber, "order_cancelled") });
    const stamp = FieldValue.serverTimestamp();

    tx.update(ref, {
      fulfillmentStatus: "cancelled",
      cancelledBy: actor,
      cancelledAt: stamp,
      cancellationReason: why,
      balance: 0,
      statusHistory: appendHistory(order, historyEntry("cancelled", actor, { from: "pending", to: "cancelled", reason: why })),
      revision: order.revision + 1,
      updatedBy: actor,
      updatedAt: stamp,
    });
    // Created stays counted (metrics + plan usage); the order leaves the
    // pending and unpaid exposure.
    recordDailyMetrics({ tx, tenant, FieldValue, timezone: business.timezone, at: now, operational: { cancelledOrders: 1 } });
    adjustCurrentMetrics({
      tx,
      tenant,
      FieldValue,
      operational: { pendingFulfillment: -1, ...(order.paymentStatus !== "paid" ? { unpaidOrders: -1 } : {}) },
      financial: { receivablesOutstanding: -(order.balance || 0) },
    });
    plan.commit({ actor, FieldValue });
    return { orderId, cancelled: true };
  }, TX_OPTIONS);
}
