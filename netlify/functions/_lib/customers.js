// Distributor customers (Phase 9), server side.
//
// Contact details change only through these functions (customers.manage).
// The statistics on each customer (stats.orderCount, totalOrdered,
// outstandingBalance, lastOrderAt, lastOrderNumber) are maintained by
// applyCustomerStats(), called INSIDE the same transaction as the order or
// payment that changes them (orders.js / payments.js), so a customer's
// balance always equals the sum of its open orders' balances.
//
// Counting rules: an order counts while it isn't cancelled or deleted.
// totalOrdered is the sum of those orders' totals (pending included);
// outstandingBalance the sum of their balances.

import { validateCustomerInput, phoneKey, isValidCustomerId, CustomerError, CUSTOMER_SCHEMA_VERSION, EMPTY_CUSTOMER_STATS } from "../../../shared/customers.js";
// Contention on a hot customer is retried like orders and payments.
const TX_OPTIONS = { maxAttempts: 10 };

const MAX_HISTORY_ENTRIES = 200;
const LABELS = { name: "Name", company: "Company", phone: "Phone", email: "Email", address: "Address", notes: "Notes" };

const customerRef = (tenant, id) => {
  if (!isValidCustomerId(id)) throw new CustomerError("invalid-customer", "Invalid customer");
  return tenant.doc("customers", id);
};

function append(history, entry) {
  const list = Array.isArray(history) ? history : [];
  if (list.length >= MAX_HISTORY_ENTRIES) throw new CustomerError("history-full", "Too many changes on this record");
  return [...list, entry];
}

// Another customer with the same phone, if any (a hint, never a block).
async function possibleDuplicate(tenant, key, exceptId = null) {
  if (!key) return null;
  const snap = await tenant.collection("customers").where("phoneKey", "==", key).limit(2).get();
  const other = snap.docs.find((d) => d.id !== exceptId);
  return other ? { customerId: other.id, name: other.data().name } : null;
}

// ---------- Contact records (customers.manage) ----------

export async function createCustomer({ db, tenant, FieldValue, input, actor }) {
  const data = validateCustomerInput(input);
  const ref = tenant.collection("customers").doc();
  const stamp = FieldValue.serverTimestamp();
  const key = phoneKey(data.phone);
  const duplicate = await possibleDuplicate(tenant, key);
  await db.runTransaction(async (tx) => {
    tx.create(ref, {
      schemaVersion: CUSTOMER_SCHEMA_VERSION,
      name: data.name,
      nameLower: data.name.toLocaleLowerCase("en"),
      company: data.company ?? null,
      phone: data.phone ?? null,
      phoneKey: key,
      email: data.email ?? null,
      address: data.address ?? null,
      notes: data.notes ?? null,
      status: "active",
      stats: { ...EMPTY_CUSTOMER_STATS },
      history: [{ type: "created", at: new Date(), actor }],
      revision: 1,
      createdBy: actor,
      createdAt: stamp,
      updatedBy: actor,
      updatedAt: stamp,
    });
  }, TX_OPTIONS);
  return { customerId: ref.id, possibleDuplicate: duplicate };
}

// Edit -> Save. Only the fields sent change; the activity log records
// "Phone changed A -> B". Past orders keep their own customer snapshot.
export async function updateCustomer({ db, tenant, FieldValue, customerId, changes, expectedRevision = null, actor }) {
  const data = validateCustomerInput(changes, { partial: true });
  const ref = customerRef(tenant, customerId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new CustomerError("not-found", "Customer not found");
    const c = snap.data();
    if (expectedRevision !== null && expectedRevision !== c.revision) throw new CustomerError("stale-customer", "This customer was changed by someone else. Reload and try again");
    const diff = {};
    for (const [k, v] of Object.entries(data)) if ((c[k] ?? null) !== (v ?? null)) diff[k] = { from: c[k] ?? null, to: v ?? null };
    if (!Object.keys(diff).length) return { customerId, unchanged: true, revision: c.revision };
    const update = { ...Object.fromEntries(Object.keys(diff).map((k) => [k, data[k] ?? null])) };
    if (diff.name) update.nameLower = data.name.toLocaleLowerCase("en");
    if (diff.phone) update.phoneKey = phoneKey(data.phone);
    const labels = Object.keys(diff).map((k) => (k === "notes" || k === "address" ? `${LABELS[k]} updated` : `${LABELS[k]} changed ${diff[k].from ?? "—"} → ${diff[k].to ?? "—"}`));
    tx.update(ref, {
      ...update,
      history: append(c.history, { type: "edited", at: new Date(), actor, changes: diff, label: labels.join(" · ") }),
      revision: c.revision + 1,
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { customerId, revision: c.revision + 1, phoneChanged: Boolean(diff.phone) };
  }, TX_OPTIONS);
  if (result.phoneChanged) result.possibleDuplicate = await possibleDuplicate(tenant, phoneKey(data.phone), customerId);
  delete result.phoneChanged;
  return result;
}

// ⋯ More -> Deactivate / Reactivate. Inactive customers keep their history
// and balances but can't be picked for new orders.
export async function setCustomerStatus({ db, tenant, FieldValue, customerId, status, actor }) {
  if (!["active", "inactive"].includes(status)) throw new CustomerError("invalid-input", "Status must be active or inactive");
  const ref = customerRef(tenant, customerId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new CustomerError("not-found", "Customer not found");
    const c = snap.data();
    if (c.status === status) return { customerId, status, unchanged: true };
    tx.update(ref, {
      status,
      history: append(c.history, { type: status === "active" ? "reactivated" : "deactivated", at: new Date(), actor, label: status === "active" ? "Customer reactivated" : "Customer deactivated" }),
      revision: c.revision + 1,
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { customerId, status };
  }, TX_OPTIONS);
}

// ⋯ More -> Delete: only for a customer no order has ever referenced (a
// mistaken entry). Anyone with order history is deactivated instead, so
// orders, balances and reports never lose their customer.
export async function deleteCustomer({ db, tenant, FieldValue, customerId, reason = null, actor }) {
  const ref = customerRef(tenant, customerId);
  const why = typeof reason === "string" && reason.trim() ? reason.trim().replace(/\s+/g, " ").slice(0, 300) : "Removed mistaken customer";
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new CustomerError("not-found", "Customer not found");
    const c = snap.data();
    const used = await tx.get(tenant.collection("orders").where("customerId", "==", customerId).limit(1));
    if (!used.empty || (c.stats?.orderCount ?? 0) > 0) throw new CustomerError("has-orders", "This customer has orders. Deactivate them instead");
    tx.delete(ref);
    tx.set(tenant.collection("auditLog").doc(), {
      type: "customer.deleted",
      customerId,
      actor,
      reason: why,
      snapshot: { name: c.name, company: c.company ?? null, phone: c.phone ?? null, email: c.email ?? null, address: c.address ?? null, notes: c.notes ?? null, status: c.status, history: c.history ?? [] },
      at: FieldValue.serverTimestamp(),
    });
    return { customerId, deleted: true };
  }, TX_OPTIONS);
}

// ---------- Used inside order / payment transactions ----------

// Reads a customer an order is being linked to (call before any write in
// the transaction). Returns the customer data.
export async function readCustomerForOrder(tx, tenant, customerId, { requireActive = true } = {}) {
  const snap = await tx.get(customerRef(tenant, customerId));
  if (!snap.exists) throw new CustomerError("customer-not-found", "That customer no longer exists");
  const c = snap.data();
  if (requireActive && c.status !== "active") throw new CustomerError("customer-inactive", `${c.name} is inactive. Reactivate them or choose another customer`);
  return c;
}

// Moves a customer's statistics by the given deltas (no read needed). The
// customer document always exists here: a customer with orders can't be
// deleted, and new links read it first.
export function applyCustomerStats(tx, { tenant, FieldValue, customerId, orders = 0, total = 0, balance = 0, lastOrder = null }) {
  if (!customerId || (!orders && !total && !balance && !lastOrder)) return;
  const update = {};
  if (orders) update["stats.orderCount"] = FieldValue.increment(orders);
  if (total) update["stats.totalOrdered"] = FieldValue.increment(total);
  if (balance) update["stats.outstandingBalance"] = FieldValue.increment(balance);
  if (lastOrder) {
    update["stats.lastOrderAt"] = FieldValue.serverTimestamp();
    update["stats.lastOrderNumber"] = lastOrder;
  }
  tx.update(tenant.doc("customers", customerId), update);
}

export { CustomerError };
