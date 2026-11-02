// One-off backfill (2026-11-03): past orders typed with a customer's name
// before customers were saved automatically get a Customers record, with the
// SAME rules New Order uses now (./customers.js findOrderCustomer), replayed
// oldest order first:
//   "Walk-in" / no name                         -> skipped
//   nobody with that name                       -> a new customer (savedFrom
//                                                  "backfill"), the order linked
//   same name + same phone, or + same address,
//   exactly one active customer                 -> linked to that customer
//                                                  (its phone filled if it had none)
//   same name only / several / inactive         -> left unlinked, reported
//                                                  for the Owner to link by hand
// A customer created earlier in the same run counts as existing for later
// orders, exactly as it would have live. Stats follow the counting rules in
// ./customers.js (cancelled orders link but don't count). Orders already
// linked are never touched; order snapshots, totals and payments never
// change. Reads and writes are ONE transaction per business, so an order
// linked or edited at the same moment is never overwritten. apply = false:
// report only. Every applied run leaves one auditLog entry.

import { phoneKey, addressKey, validateCustomerInput, CUSTOMER_SCHEMA_VERSION, EMPTY_CUSTOMER_STATS } from "../../../shared/customers.js";

const MAX_ORDERS = 5000;
const MAX_WRITES = 450;
const nameKey = (name) => (typeof name === "string" ? name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en") : "");
const millis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : t instanceof Date ? t.getTime() : 0);
const balanceOf = (o) => (Number.isSafeInteger(o.balance) ? o.balance : (o.total || 0) - (o.amountPaid || 0));
const byAge = (a, b) => (a.orderDate < b.orderDate ? -1 : a.orderDate > b.orderDate ? 1 : millis(a.createdAt) - millis(b.createdAt) || String(a.orderNumber).localeCompare(String(b.orderNumber)));

export async function backfillOrderCustomers({ db, tenant, FieldValue, apply = false, actor }) {
  return db.runTransaction(async (tx) => {
    const [orderSnap, customerSnap] = await Promise.all([tx.get(tenant.collection("orders").limit(MAX_ORDERS + 1)), tx.get(tenant.collection("customers").limit(MAX_ORDERS + 1))]);
    if (orderSnap.docs.length > MAX_ORDERS || customerSnap.docs.length > MAX_ORDERS) throw new Error(`More than ${MAX_ORDERS} orders or customers: not backfilled`);
    const pool = customerSnap.docs.map((d) => ({ id: d.id, ref: d.ref, data: d.data(), isNew: false, orders: [], addPhone: null }));
    const orders = orderSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() })).filter((o) => !o.customerId).sort(byAge);
    const skipped = [];
    for (const o of orders) {
      const key = nameKey(o.customer?.name);
      if (!key || /^walk-?in$/.test(key)) {
        skipped.push({ orderNumber: o.orderNumber, name: o.customer?.name ?? "", reason: "walk-in" });
        continue;
      }
      const pk = phoneKey(o.customer?.phone);
      const ak = addressKey(o.deliveryAddress);
      const same = pool.filter((c) => c.data.nameLower === key);
      if (!same.length) {
        let data;
        try {
          data = validateCustomerInput({ name: o.customer.name, ...(o.customer.phone ? { phone: o.customer.phone } : {}), ...(o.deliveryAddress ? { address: o.deliveryAddress } : {}) });
        } catch {
          skipped.push({ orderNumber: o.orderNumber, name: o.customer?.name ?? "", reason: "invalid" });
          continue;
        }
        const ref = tenant.collection("customers").doc();
        pool.push({ id: ref.id, ref, isNew: true, orders: [o], addPhone: null, data: { name: data.name, nameLower: data.name.toLocaleLowerCase("en"), phone: data.phone ?? null, phoneKey: phoneKey(data.phone), address: data.address ?? null, status: "active" } });
        continue;
      }
      const strong = same.filter((c) => (pk && c.data.phoneKey === pk) || (ak && addressKey(c.data.address) === ak));
      if (strong.length !== 1 || strong[0].data.status !== "active") {
        skipped.push({ orderNumber: o.orderNumber, name: o.customer.name, reason: strong.length === 1 ? "inactive" : "same-name" });
        continue;
      }
      const c = strong[0];
      c.orders.push(o);
      if (pk && !c.data.phoneKey) {
        // A phone on the order fills a record that has none (never replaces one).
        if (c.isNew) Object.assign(c.data, { phone: o.customer.phone, phoneKey: pk });
        else c.addPhone = o.customer.phone;
        c.data.phoneKey = pk;
      }
    }

    const touched = pool.filter((c) => c.orders.length);
    const linked = touched.flatMap((c) => c.orders.map((o) => ({ orderNumber: o.orderNumber, name: o.customer.name, customer: c.data.name, customerId: c.id, how: c.isNew ? "new" : "matched", counted: o.fulfillmentStatus !== "cancelled" })));
    const report = {
      orders: orderSnap.docs.length,
      created: touched.filter((c) => c.isNew).map((c) => ({ customerId: c.id, name: c.data.name, phone: c.data.phone ?? null, orders: c.orders.map((o) => o.orderNumber) })),
      matched: touched.filter((c) => !c.isNew).map((c) => ({ customerId: c.id, name: c.data.name, orders: c.orders.map((o) => o.orderNumber), phoneAdded: c.addPhone })),
      linked,
      skipped,
      applied: false,
    };
    if (!apply || !touched.length) return report;
    if (linked.length + touched.length + 1 > MAX_WRITES) throw new Error(`Too many changes for one run (${linked.length} orders): not backfilled`);

    const stamp = FieldValue.serverTimestamp();
    for (const c of touched) {
      const live = c.orders.filter((o) => o.fulfillmentStatus !== "cancelled");
      const last = [...live].sort((a, b) => millis(b.createdAt) - millis(a.createdAt) || byAge(b, a))[0] ?? null;
      const numbers = c.orders.map((o) => o.orderNumber).join(", ");
      const total = live.reduce((t, o) => t + (o.total || 0), 0);
      const balance = live.reduce((t, o) => t + balanceOf(o), 0);
      if (c.isNew) {
        tx.create(c.ref, {
          schemaVersion: CUSTOMER_SCHEMA_VERSION,
          name: c.data.name,
          nameLower: c.data.nameLower,
          company: null,
          phone: c.data.phone ?? null,
          phoneKey: c.data.phoneKey ?? null,
          email: null,
          address: c.data.address ?? null,
          notes: null,
          status: "active",
          stats: { ...EMPTY_CUSTOMER_STATS, orderCount: live.length, totalOrdered: total, outstandingBalance: balance, lastOrderAt: last?.createdAt ?? null, lastOrderNumber: last?.orderNumber ?? null },
          history: [{ type: "created", at: new Date(), actor, label: `Saved from past ${c.orders.length === 1 ? "order" : "orders"} ${numbers}` }],
          savedFrom: "backfill",
          revision: 1,
          createdBy: actor,
          createdAt: stamp,
          updatedBy: actor,
          updatedAt: stamp,
        });
      } else {
        const update = {
          history: [...(Array.isArray(c.data.history) ? c.data.history : []), { type: "edited", at: new Date(), actor, label: `Past ${c.orders.length === 1 ? "order" : "orders"} ${numbers} linked${c.addPhone ? ` · Phone added ${c.addPhone}` : ""}`, ...(c.addPhone ? { changes: { phone: { from: null, to: c.addPhone } } } : {}) }],
          revision: (c.data.revision || 1) + 1,
          updatedBy: actor,
          updatedAt: stamp,
        };
        if (live.length) update["stats.orderCount"] = FieldValue.increment(live.length);
        if (total) update["stats.totalOrdered"] = FieldValue.increment(total);
        if (balance) update["stats.outstandingBalance"] = FieldValue.increment(balance);
        if (last && millis(last.createdAt) > millis(c.data.stats?.lastOrderAt)) Object.assign(update, { "stats.lastOrderAt": last.createdAt, "stats.lastOrderNumber": last.orderNumber });
        if (c.addPhone) Object.assign(update, { phone: c.addPhone, phoneKey: phoneKey(c.addPhone) });
        tx.update(c.ref, update);
      }
      // The order's revision moves so an editor opened before this reloads
      // instead of saving the old (unlinked) customer back.
      for (const o of c.orders) tx.update(o.ref, { customerId: c.id, revision: (o.revision || 1) + 1, updatedAt: stamp });
    }
    tx.set(tenant.collection("auditLog").doc(), { type: "customers.backfilled", created: report.created.length, matched: report.matched.length, linked: linked.map((l) => ({ orderNumber: l.orderNumber, customerId: l.customerId, how: l.how })), skipped, actor, at: stamp });
    return { ...report, applied: true };
  });
}
