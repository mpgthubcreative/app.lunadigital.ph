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
//   cancel   release reservations (open orders only) - no sales, no COGS
//   correct  edit a FULFILLED order (orders.correct): units that come back
//            return at their ORIGINAL cost snapshot, extra units are consumed
//            at today's average, and the sales / discount / COGS deltas post
//            to the original fulfillment day. History is appended, never
//            rewritten.
//   delete   remove an accidental OPEN, unpaid order: release reservations,
//            audit snapshot; plan usage keeps counting it
//
// Documents (businesses/{bid}/...):
//   orders/{orderId}                order, line snapshots, statusHistory      (orders.view)
//   orderCosts/{orderId}            per-line cost consumed, COGS, gross profit (dashboard.financials)
//   counters/orders-{YYYYMMDD}      next order sequence for that local day     (server only)
//   idempotencyKeys/{key}           create-once guard                          (server only)
//   usage/{YYYY-MM}.ordersCreated   plan limit counter (never decremented)     (server only)

import { applyRollup, fulfilledOrderContribution, diffRollup } from "./reports.js";
import { readCustomerForOrder, applyCustomerStats } from "./customers.js";
import { customerSnapshot } from "../../../shared/customers.js";
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
  isOpenFulfillment,
  isMaterialChange,
} from "../../../shared/orders.js";
import { prorate } from "../../../shared/quantity.js";
import { businessDate } from "../../../shared/metrics.js";
import { prepareMovements } from "./inventory.js";
import { prepareNotifications } from "./notifications.js";
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

// When an order's total changes, the receivables gauge follows the balance
// and the unpaid-order count follows whether a balance remains.
function adjustBalanceGauges(tx, { tenant, FieldValue, order, newTotal }) {
  const paid = order.amountPaid || 0;
  const before = order.total - paid;
  const after = newTotal - paid;
  const unpaid = (after > 0 ? 1 : 0) - (before > 0 ? 1 : 0);
  if (after !== before || unpaid) {
    adjustCurrentMetrics({ tx, tenant, FieldValue, ...(unpaid ? { operational: { unpaidOrders: unpaid } } : {}), ...(after !== before ? { financial: { receivablesOutstanding: after - before } } : {}) });
  }
}

// Resolves the customer side of an edit (call before any write): a linked
// customer's name and phone come from the customer record; linking a NEW
// customer requires them to be active, keeping the same one doesn't.
// Returns { data } with customer/customerId resolved.
async function customerLink(tx, { tenant, order, data }) {
  if (!data.customerId) return { data: { ...data, customerId: null } };
  const same = data.customerId === (order.customerId ?? null);
  const c = await readCustomerForOrder(tx, tenant, data.customerId, { requireActive: !same });
  return { data: { ...data, customer: customerSnapshot(c, data.customer.notes) } };
}

// Customer statistics follow an edited order: same customer -> the total
// and balance deltas; another customer -> the order moves between them.
function moveCustomerStats(tx, { tenant, FieldValue, order, newCustomerId, newTotal }) {
  const paid = order.amountPaid || 0;
  const oldId = order.customerId ?? null;
  if (oldId === newCustomerId) {
    applyCustomerStats(tx, { tenant, FieldValue, customerId: oldId, total: newTotal - order.total, balance: newTotal - order.total });
    return;
  }
  applyCustomerStats(tx, { tenant, FieldValue, customerId: oldId, orders: -1, total: -order.total, balance: -(order.total - paid) });
  applyCustomerStats(tx, { tenant, FieldValue, customerId: newCustomerId, orders: 1, total: newTotal, balance: newTotal - paid });
}

const hashRequest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function movementsFor(lines, type, orderId, orderNumber, reason) {
  return lines.map((l) => ({ productId: l.productId, movement: { type, quantity: l.quantity, referenceType: "order", referenceId: orderId, note: orderNumber, reason } }));
}

// ---------- Create ----------

export async function createOrder({ db, tenant, FieldValue, business, entitlements, input, idempotencyKey, actor, canDiscount, canLinkCustomers = false, now = new Date() }) {
  if (!isValidIdempotencyKey(idempotencyKey)) throw new OrderError("invalid-input", "A valid idempotency key is required");
  const data = validateOrderInput(input);
  if (data.customerId && !canLinkCustomers) throw new OrderError("customer-not-allowed", "You can't link orders to saved customers");
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

      const linked = data.customerId ? await readCustomerForOrder(tx, tenant, data.customerId) : null;
      const customer = linked ? customerSnapshot(linked, data.customer.notes) : data.customer;
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
        customer,
        customerId: data.customerId,
        customerNameLower: customer.name.toLocaleLowerCase("en"),
        items: totals.lines,
        itemCount: totals.lines.length,
        subtotal: totals.subtotal,
        discount: totals.discount,
        total: totals.total,
        amountPaid: 0,
        verifiedPaid: 0,
        pendingPaid: 0,
        paymentCount: 0,
        lastPaymentRef: null,
        lastProofPaymentId: null,
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
      adjustCurrentMetrics({ tx, tenant, FieldValue, operational: { pendingFulfillment: 1, unpaidOrders: totals.total > 0 ? 1 : 0 }, financial: { receivablesOutstanding: totals.total } });
      applyCustomerStats(tx, { tenant, FieldValue, customerId: data.customerId, orders: 1, total: totals.total, balance: totals.total, lastOrder: orderNumber });
      plan.commit({ actor, FieldValue });
      return { orderId: ref.id, orderNumber, replayed: false, order: { ...order, createdAt: null, updatedAt: null } };
    }, TX_OPTIONS);
  }
}

// ---------- Edit (open orders) and correction (fulfilled orders) ----------

// One "Edit -> Save" for the user; the server decides what it means.
//   open order       existing lines keep their price/name snapshot; new
//                    products are priced now; only the reservation
//                    DIFFERENCE moves (20 -> 15 releases 5, 20 -> 30 reserves 10)
//   fulfilled order  a correction (orders.correct), see correctFulfilled()
//   cancelled order  not editable
export async function updateOrder({ db, tenant, FieldValue, business = null, orderId, input, expectedRevision = null, actor, canDiscount, canLinkCustomers = false, canCorrect = false, reason = null }) {
  const ref = orderRef(tenant, orderId);
  const data = validateOrderInput(input);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new OrderError("not-found", "Order not found");
    const order = snap.data();
    if (expectedRevision !== null && expectedRevision !== order.revision) throw new OrderError("stale-order", "This order was changed by someone else. Reload and try again");
    if (order.fulfillmentStatus === "fulfilled" && !canCorrect) {
      // Same answer as Phase 7 for anyone without orders.correct: a fulfilled
      // order isn't editable for them.
      throw new OrderError("not-pending", "This order is fulfilled. Only authorized users can correct it");
    }
    if (order.fulfillmentStatus !== "fulfilled" && !isOpenFulfillment(order.fulfillmentStatus)) throw new OrderError("not-pending", `A ${order.fulfillmentStatus} order can't be edited`);
    if (data.customerId && data.customerId !== (order.customerId ?? null) && !canLinkCustomers) throw new OrderError("customer-not-allowed", "You can't link orders to saved customers");
    const link = await customerLink(tx, { tenant, order, data });
    if (order.fulfillmentStatus === "fulfilled") return correctFulfilled(tx, { tenant, FieldValue, business, ref, orderId, order, data: link.data, link, actor, canDiscount, reason });
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

    const customerChanged = JSON.stringify(order.customer) !== JSON.stringify(link.data.customer) || (order.customerId ?? null) !== link.data.customerId;
    const entry = historyEntry("edited", actor, {
      from: order.fulfillmentStatus,
      to: order.fulfillmentStatus,
      changes: {
        lines: changes,
        ...(data.discount !== order.discount ? { discount: { from: order.discount, to: data.discount } } : {}),
        ...(totals.total !== order.total ? { total: { from: order.total, to: totals.total } } : {}),
        ...(customerChanged ? { customer: true } : {}),
        ...(data.source !== order.source ? { source: { from: order.source, to: data.source } } : {}),
      },
    });

    tx.update(ref, {
      customer: link.data.customer,
      customerId: link.data.customerId,
      customerNameLower: link.data.customer.name.toLocaleLowerCase("en"),
      source: data.source,
      sourceNote: data.sourceNote || null,
      notes: data.notes || null,
      items: totals.lines,
      itemCount: totals.lines.length,
      subtotal: totals.subtotal,
      discount: totals.discount,
      total: totals.total,
      balance: totals.total - amountPaid,
      paymentStatus: paymentStatusFor({ total: totals.total, verifiedPaid: order.verifiedPaid || 0, pendingPaid: order.pendingPaid || 0 }),
      statusHistory: appendHistory(order, entry),
      revision: order.revision + 1,
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
    });
    adjustBalanceGauges(tx, { tenant, FieldValue, order, newTotal: totals.total });
    moveCustomerStats(tx, { tenant, FieldValue, order, newCustomerId: link.data.customerId, newTotal: totals.total });
    if (plan) plan.commit({ actor, FieldValue });
    return { orderId, revision: order.revision + 1, total: totals.total };
  }, TX_OPTIONS);
}

// A fulfilled order corrected after the fact ("we typed 10, it was 8").
// Not a return: the customer never received the difference.
//   decrease  units come back at the line's ORIGINAL cost snapshot
//             (correction_in), so COGS drops by exactly what was booked
//   increase  extra units leave stock at today's average (correction_out)
//   removed / added products: the same, for the whole line
// Prices on existing lines keep their snapshot. Sales, discount and COGS
// deltas post to the ORIGINAL fulfillment day so that day becomes right.
// Inventory history gets new correction movements; nothing is deleted.
async function correctFulfilled(tx, { tenant, FieldValue, business, ref, orderId, order, data, link, actor, canDiscount, reason }) {
  if (data.discount !== order.discount && !canDiscount) throw new OrderError("discount-not-allowed", "You don't have permission to change the discount");
  const material = isMaterialChange({ before: order, after: data });
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (material && (why.length < 3 || why.length > 300)) throw new OrderError("reason-required", "Say why this fulfilled order is being corrected (3-300 characters)");

  const costsRef = tenant.doc("orderCosts", orderId);
  const costsSnap = await tx.get(costsRef);
  if (!costsSnap.exists) throw new OrderError("business-misconfigured", "This order's cost record is missing");
  const costs = costsSnap.data();
  const costByLine = new Map((costs.lines || []).map((l) => [l.lineId, l.costConsumed]));

  const oldLines = new Map(order.items.map((l) => [l.productId, l]));
  const newQty = new Map(data.items.map((i) => [i.productId, i.quantity]));
  const moves = [];
  const changes = [];
  const keptCost = new Map(); // productId -> cost kept from the original snapshot
  const mv = (type, quantity, extra = {}) => ({ type, quantity, referenceType: "order", referenceId: orderId, note: order.orderNumber, reason: "order_corrected", ...extra });

  for (const [productId, quantity] of newQty) {
    const before = oldLines.get(productId);
    const oldQ = before ? before.quantity : 0;
    const delta = quantity - oldQ;
    if (before) {
      const oldCost = costByLine.get(before.lineId) ?? 0;
      if (delta < 0) {
        const keep = prorate(oldCost, quantity, oldQ);
        keptCost.set(productId, keep);
        moves.push({ productId, movement: mv("correction_in", -delta, { value: oldCost - keep }) });
      } else {
        keptCost.set(productId, oldCost);
        if (delta > 0) moves.push({ productId, movement: mv("correction_out", delta) });
      }
    } else {
      keptCost.set(productId, 0);
      moves.push({ productId, movement: mv("correction_out", quantity) });
    }
    if (delta !== 0) changes.push({ productId, sku: before ? before.sku : null, from: oldQ, to: quantity, inventory: -delta });
  }
  for (const [productId, line] of oldLines) {
    if (!newQty.has(productId)) {
      moves.push({ productId, movement: mv("correction_in", line.quantity, { value: costByLine.get(line.lineId) ?? 0 }) });
      changes.push({ productId, sku: line.sku, from: line.quantity, to: 0, inventory: line.quantity });
    }
  }

  const plan = moves.length ? await prepareMovements(tx, { tenant, items: moves }) : null;
  const results = new Map(plan ? plan.results.map((r) => [r.productId, r]) : []);
  let n = order.items.length;
  const lines = data.items.map((i) => {
    const prior = oldLines.get(i.productId);
    if (prior) return { lineId: prior.lineId, productId: prior.productId, sku: prior.sku, name: prior.name, unit: prior.unit, quantity: i.quantity, unitPrice: prior.unitPrice };
    const p = results.get(i.productId)?.product;
    if (!p || p.status !== "active") throw new OrderError("product-inactive", "A new product on the order is unavailable");
    n += 1;
    for (const c of changes) if (c.productId === i.productId) c.sku = p.sku;
    return { lineId: `L${n}`, productId: i.productId, sku: p.sku, name: p.name, unit: p.unit, quantity: i.quantity, unitPrice: p.sellingPrice };
  });
  const totals = computeTotals(lines, data.discount);
  const amountPaid = order.amountPaid || 0;
  if (totals.total < amountPaid) throw new OrderError("below-paid", "The new total would be less than what's already been paid");

  const costLines = totals.lines.map((l) => {
    // kept original cost + whatever extra units cost today (correction_out)
    const extra = results.get(l.productId)?.costConsumed ?? 0;
    return { lineId: l.lineId, productId: l.productId, quantity: l.quantity, lineSubtotal: l.lineSubtotal, costConsumed: keptCost.get(l.productId) + extra };
  });
  const cogs = costLines.reduce((s, l) => s + l.costConsumed, 0);
  const delta = { grossSales: totals.subtotal - order.subtotal, discounts: totals.discount - order.discount, cogs: cogs - costs.cogs };

  const customerChanged = JSON.stringify(order.customer) !== JSON.stringify(data.customer) || (order.customerId ?? null) !== data.customerId;
  // Visible to everyone with orders.view: no cost figures here (they're in orderCosts).
  const entry = historyEntry("corrected", actor, {
    from: "fulfilled",
    to: "fulfilled",
    ...(why ? { reason: why } : {}),
    changes: {
      lines: changes,
      ...(data.discount !== order.discount ? { discount: { from: order.discount, to: data.discount } } : {}),
      ...(totals.total !== order.total ? { sales: { from: order.total, to: totals.total } } : {}),
      ...(customerChanged ? { customer: true } : {}),
      ...(data.source !== order.source ? { source: { from: order.source, to: data.source } } : {}),
    },
  });
  const stamp = FieldValue.serverTimestamp();
  tx.update(ref, {
    customer: data.customer,
    customerId: data.customerId,
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
    paymentStatus: paymentStatusFor({ total: totals.total, verifiedPaid: order.verifiedPaid || 0, pendingPaid: order.pendingPaid || 0 }),
    statusHistory: appendHistory(order, entry),
    revision: order.revision + 1,
    updatedBy: actor,
    updatedAt: stamp,
  });
  if (material) {
    const corrections = Array.isArray(costs.corrections) ? costs.corrections : [];
    tx.update(costsRef, {
      lines: costLines,
      grossSales: totals.subtotal,
      discount: totals.discount,
      netSales: totals.total,
      cogs,
      grossProfit: totals.total - cogs,
      corrections: [...corrections, { at: new Date(), actor, reason: why, before: { grossSales: costs.grossSales, discount: costs.discount, netSales: costs.netSales, cogs: costs.cogs }, after: { grossSales: totals.subtotal, discount: totals.discount, netSales: totals.total, cogs } }],
    });
    if (delta.grossSales || delta.discounts || delta.cogs) {
      recordDailyMetrics({ tx, tenant, FieldValue, timezone: business?.timezone ?? null, day: order.fulfilledDay, financial: delta });
    }
  }
  adjustBalanceGauges(tx, { tenant, FieldValue, order, newTotal: totals.total });
  moveCustomerStats(tx, { tenant, FieldValue, order, newCustomerId: link.data.customerId, newTotal: totals.total });
  // Report rollups: restate the original fulfilment day (before -> after).
  const rollupBefore = fulfilledOrderContribution(order, costs.lines);
  const rollupAfter = fulfilledOrderContribution({ ...order, items: totals.lines, discount: totals.discount, customerId: link.data.customerId }, costLines);
  applyRollup(tx, { tenant, FieldValue, day: order.fulfilledDay, delta: diffRollup(rollupAfter, rollupBefore) });
  if (plan) plan.commit({ actor, FieldValue });
  return { orderId, revision: order.revision + 1, total: totals.total, corrected: true, delta };
}

// ---------- Delete an accidental open order ----------

export async function deleteOrder({ db, tenant, FieldValue, orderId, reason = null, actor }) {
  const ref = orderRef(tenant, orderId);
  const why = typeof reason === "string" && reason.trim() ? reason.trim().replace(/\s+/g, " ").slice(0, 300) : "Removed accidental order";

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new OrderError("not-found", "Order not found");
    const order = snap.data();
    if (!isOpenFulfillment(order.fulfillmentStatus)) throw new OrderError("not-deletable", "Only open orders can be deleted; fulfilled orders stay in history");
    if ((order.amountPaid || 0) > 0) throw new OrderError("not-deletable", "An order with payments can't be deleted");
    const plan = await prepareMovements(tx, { tenant, items: movementsFor(order.items, "release", orderId, order.orderNumber, "order_deleted") });

    tx.delete(ref);
    tx.set(tenant.collection("auditLog").doc(), {
      type: "order.deleted",
      orderId,
      orderNumber: order.orderNumber,
      actor,
      reason: why,
      snapshot: { customer: order.customer, customerId: order.customerId ?? null, source: order.source, items: order.items, subtotal: order.subtotal, discount: order.discount, total: order.total, orderDate: order.orderDate, fulfillmentStatus: order.fulfillmentStatus, statusHistory: order.statusHistory, createdBy: order.createdBy },
      at: FieldValue.serverTimestamp(),
    });
    // It never was a real order: off the day's order count and the open /
    // unpaid exposure. Plan usage still counts it (no create/delete gaming).
    recordDailyMetrics({ tx, tenant, FieldValue, timezone: null, day: order.orderDate, operational: { orderCount: -1 } });
    adjustCurrentMetrics({ tx, tenant, FieldValue, operational: { pendingFulfillment: -1, unpaidOrders: (order.balance || 0) > 0 ? -1 : 0 }, financial: { receivablesOutstanding: -(order.balance || 0) } });
    applyCustomerStats(tx, { tenant, FieldValue, customerId: order.customerId, orders: -1, total: -order.total, balance: -(order.balance || 0) });
    plan.commit({ actor, FieldValue });
    return { orderId, deleted: true };
  }, TX_OPTIONS);
}

// ---------- Operational stage (pending / preparing / ready) ----------

// The inline Fulfillment dropdown. Only moves between OPEN stages, in any
// direction (a mistaken stage is easy to put back). Fulfilled and Cancelled
// go through fulfillOrder / cancelOrder, never through here.
export async function setFulfillmentStage({ db, tenant, FieldValue, orderId, stage, actor }) {
  if (!isOpenFulfillment(stage)) throw new OrderError("invalid-stage", "Choose Pending, Preparing or Ready (Fulfilled and Cancelled have their own steps)");
  const ref = orderRef(tenant, orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new OrderError("not-found", "Order not found");
    const order = snap.data();
    if (!isOpenFulfillment(order.fulfillmentStatus)) throw new OrderError("not-pending", `This order is already ${order.fulfillmentStatus}`);
    if (order.fulfillmentStatus === stage) return { orderId, fulfillmentStatus: stage, unchanged: true };
    // Phase 13: "Ready" is the one stage worth telling the people who
    // fulfill (not the person who set it). Other stage changes stay quiet.
    // The order's new revision makes each move to Ready its own event.
    const name = order.customer?.name ? ` for ${order.customer.name}` : "";
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: stage === "ready" ? [{ type: "order.ready", key: `${orderId}-r${order.revision + 1}`, title: "Order ready", message: `${order.orderNumber}${name} is ready for fulfillment.`, recordType: "order", recordId: orderId }] : [],
    });
    tx.update(ref, {
      fulfillmentStatus: stage,
      statusHistory: appendHistory(order, historyEntry("stage", actor, { from: order.fulfillmentStatus, to: stage })),
      revision: order.revision + 1,
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
    });
    notes.commit({ FieldValue });
    return { orderId, fulfillmentStatus: stage };
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
    if (!isOpenFulfillment(order.fulfillmentStatus)) throw new OrderError("not-pending", `This order is already ${order.fulfillmentStatus}`);

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
      statusHistory: appendHistory(order, historyEntry("fulfilled", actor, { from: order.fulfillmentStatus, to: "fulfilled" })),
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
    // Report rollups (products / customer) on the same fulfilment day.
    applyRollup(tx, { tenant, FieldValue, day, delta: fulfilledOrderContribution(order, costLines) });
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
    if (!isOpenFulfillment(order.fulfillmentStatus)) {
      throw new OrderError("not-pending", order.fulfillmentStatus === "fulfilled" ? "A fulfilled order can't be cancelled (returns will handle reversals)" : "This order is already cancelled");
    }
    if ((order.amountPaid || 0) > 0) throw new OrderError("has-payments", "This order has payments. Void them first, then cancel the order");
    const plan = await prepareMovements(tx, { tenant, items: movementsFor(order.items, "release", orderId, order.orderNumber, "order_cancelled") });
    const stamp = FieldValue.serverTimestamp();

    tx.update(ref, {
      fulfillmentStatus: "cancelled",
      cancelledBy: actor,
      cancelledAt: stamp,
      cancellationReason: why,
      balance: 0,
      statusHistory: appendHistory(order, historyEntry("cancelled", actor, { from: order.fulfillmentStatus, to: "cancelled", reason: why })),
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
      operational: { pendingFulfillment: -1, ...((order.balance || 0) > 0 ? { unpaidOrders: -1 } : {}) },
      financial: { receivablesOutstanding: -(order.balance || 0) },
    });
    // A cancelled order stops counting for its customer.
    applyCustomerStats(tx, { tenant, FieldValue, customerId: order.customerId, orders: -1, total: -order.total, balance: -(order.balance || 0) });
    plan.commit({ actor, FieldValue });
    return { orderId, cancelled: true };
  }, TX_OPTIONS);
}
