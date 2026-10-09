// Phase 13 notification concurrency on the REAL Firestore emulator (Admin
// SDK, real transactions and contention). Invariants after every race:
//   - one notification per recipient per event (no duplicates);
//   - each user's unread counter equals the number of unread notifications
//     in their inbox, and is never negative;
//   - the business operation's own results are unaffected.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";
import { notificationId, canFollowNotification } from "../../shared/notifications.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "demo-luna.appspot.com";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const NOW = new Date("2026-10-08T02:00:00Z");
let db, admin, bucket, FieldValue, inv, orders, pay, notes, prov, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, bucket, admin } = await fa.getAdmin());
  FieldValue = admin.firestore.FieldValue;
  inv = await import("../../netlify/functions/_lib/inventory.js");
  orders = await import("../../netlify/functions/_lib/orders.js");
  pay = await import("../../netlify/functions/_lib/payments.js");
  notes = await import("../../netlify/functions/_lib/notifications.js");
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  await prov.seedPlans({ db, admin, overwrite: true });
});

const CONTENDED = 10;
const ok = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}

// A real Distributor business with Owner, two Managers and Staff.
async function world() {
  run += 1;
  const id = `ntfc-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `Notif ${run}`, planId: "growth", workspaceTemplateId: "distributor", businessId: id });
  const uids = {};
  for (const [key, role] of [["owner", "owner"], ["manager", "manager"], ["manager2", "manager"], ["staff", "staff"]]) {
    uids[key] = `${key}-${id}`;
    await prov.addMember({ db, admin, businessId: id, uid: uids[key], email: `${key}.${run}@ntf.test`, name: key, roleTemplate: role, isAccountOwner: key === "owner" });
  }
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila", orderPrefix: "NT" };
  const actor = (key) => ({ uid: uids[key], name: key, email: "" });
  return { id, tenant, business, uids, actor };
}

async function product(w, { level = 5, opening = 100 } = {}) {
  const { productId } = await inv.createProduct({ db, tenant: w.tenant, FieldValue, actor: w.actor("owner"), input: { sku: `N-${Date.now().toString(36)}-${++run}`, name: "Wings", unit: "pcs", sellingPrice: 100000, reorderLevel: Q(level) } });
  if (opening) await inv.recordMovement({ db, tenant: w.tenant, FieldValue, productId, actor: w.actor("owner"), movement: { type: "opening", quantity: Q(opening), unitCost: 100, note: "count" } });
  return productId;
}

async function order(w, productId, qty = 1) {
  const { orderId } = await orders.createOrder({ db, tenant: w.tenant, FieldValue, business: w.business, entitlements: { limits: { ordersPerMonth: 100000 } }, input: { customer: { name: "Racer" }, source: "phone", items: [{ productId, quantity: Q(qty) }] }, idempotencyKey: `ntfc-key-${w.id}-${++run}`.padEnd(20, "x"), actor: w.actor("staff"), canDiscount: false, now: NOW });
  return orderId;
}

const record = (w, orderId, input) => pay.recordPayment({ db, bucket, tenant: w.tenant, FieldValue, business: w.business, orderId, input, actor: w.actor("staff"), canVerify: false, now: NOW });

async function inboxOf(w, key) {
  const snap = await w.tenant.member(w.uids[key]).collection("inbox").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function counter(w, key) {
  const s = await w.tenant.member(w.uids[key]).collection("inboxState").doc("summary").get();
  return s.exists ? s.data().unread : 0;
}
// THE invariant: the counter is exactly the unread notifications.
async function consistent(w, key) {
  const items = await inboxOf(w, key);
  const unread = items.filter((n) => n.read !== true).length;
  const c = await counter(w, key);
  expect(c, `${key} counter`).toBe(unread);
  expect(c).toBeGreaterThanOrEqual(0);
  return { items, unread };
}

describe("the same payment request retried concurrently", () => {
  it("8 parallel retries with one reference: one payment, one notification per verifier, counters exact", async () => {
    const w = await world();
    const orderId = await order(w, await product(w));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => record(w, orderId, { amount: 1000, method: "gcash", reference: "RETRY 0001" })));
    expectExplicit(results, ["duplicate-reference"]);
    expect(ok(results)).toHaveLength(1);
    const paymentId = ok(results)[0].value.paymentId;
    for (const key of ["owner", "manager", "manager2"]) {
      const { items } = await consistent(w, key);
      expect(items.map((n) => n.id), key).toEqual([notificationId("payment.awaiting_verification", paymentId)]);
    }
    expect(await inboxOf(w, "staff")).toEqual([]);
  });

  it("8 different payments at once: 8 notifications per verifier, each exactly once", async () => {
    const w = await world();
    const orderId = await order(w, await product(w));
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => record(w, orderId, { amount: 1000, method: "gcash", reference: `PAR ${i}000` })));
    expectExplicit(results);
    const ids = ok(results).map((r) => notificationId("payment.awaiting_verification", r.value.paymentId)).sort();
    for (const key of ["owner", "manager", "manager2"]) {
      const { items } = await consistent(w, key);
      expect(items.map((n) => n.id).sort(), key).toEqual(ids);
    }
  });
});

describe("the same low-stock crossing caused by concurrent inventory actions", () => {
  it("10 parallel decreases across the level: ONE alert per recipient, episode 1, stock exact", async () => {
    const w = await world();
    const id = await product(w, { level: 5, opening: 12 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => inv.recordMovement({ db, tenant: w.tenant, FieldValue, productId: id, actor: w.actor("manager"), movement: { type: "adjustment_decrease", quantity: Q(1), reason: "damaged" } })));
    expectExplicit(results, ["insufficient-stock"]);
    const p = (await w.tenant.doc("products", id).get()).data();
    expect(p.onHand).toBe(Q(12 - ok(results).length));
    expect(p.isLowStock).toBe(true);
    expect(p.lowStockEpisode).toBe(1);
    for (const key of ["owner", "manager", "manager2"]) {
      const { items } = await consistent(w, key);
      expect(items.filter((n) => n.type === "inventory.low_stock"), key).toHaveLength(1);
    }
    expect(await inboxOf(w, "staff")).toEqual([]);
  });

  it("parallel orders reserving across the level: one alert", async () => {
    const w = await world();
    const id = await product(w, { level: 5, opening: 10 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => order(w, id, 1)));
    expectExplicit(results);
    expect(ok(results).length).toBeGreaterThanOrEqual(5);
    const { items } = await consistent(w, "owner");
    expect(items.filter((n) => n.type === "inventory.low_stock")).toHaveLength(1);
  });
});

describe("read state racing new notifications", () => {
  it("marking read while new payments create notifications: counter = unread, never negative", async () => {
    const w = await world();
    const orderId = await order(w, await product(w));
    const first = [];
    for (let i = 0; i < 4; i++) first.push((await record(w, orderId, { amount: 100, method: "gcash", reference: `FIRST ${i}00` })).paymentId);
    const reads = first.map((p) => notes.markRead({ db, tenant: w.tenant, uid: w.uids.owner, notificationId: notificationId("payment.awaiting_verification", p), FieldValue }));
    const creates = Array.from({ length: 4 }, (_, i) => record(w, orderId, { amount: 100, method: "gcash", reference: `SECOND ${i}00` }));
    const results = await Promise.allSettled([...reads, ...creates]);
    expectExplicit(results);
    const { unread } = await consistent(w, "owner");
    expect(unread).toBe(4 - ok(results.slice(0, 4)).length + ok(results.slice(4)).length);
    // the other manager's state is untouched by the owner's reads
    expect((await consistent(w, "manager")).unread).toBe(4 + ok(results.slice(4)).length);
  });

  it("mark-all-read racing new notifications: everything older read, newer ones counted, exact", async () => {
    const w = await world();
    const orderId = await order(w, await product(w));
    for (let i = 0; i < 6; i++) await record(w, orderId, { amount: 100, method: "gcash", reference: `OLD ${i}000` });
    const results = await Promise.allSettled([
      notes.markAllRead({ db, tenant: w.tenant, uid: w.uids.owner, FieldValue }),
      ...Array.from({ length: 5 }, (_, i) => record(w, orderId, { amount: 100, method: "gcash", reference: `NEW ${i}000` })),
      notes.markAllRead({ db, tenant: w.tenant, uid: w.uids.owner, FieldValue }),
    ]);
    expectExplicit(results);
    const { items } = await consistent(w, "owner");
    expect(items.length).toBe(6 + ok(results.slice(1, 6)).length);
    // A final read-all leaves exactly zero.
    await notes.markAllRead({ db, tenant: w.tenant, uid: w.uids.owner, FieldValue });
    expect((await consistent(w, "owner")).unread).toBe(0);
  });

  it("verify (resolution) racing mark-read and mark-all: counters exact for every recipient", async () => {
    const w = await world();
    const orderId = await order(w, await product(w));
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await record(w, orderId, { amount: 100, method: "gcash", reference: `RES ${i}000` })).paymentId);
    const results = await Promise.allSettled([
      ...ids.map((paymentId) => pay.verifyPayment({ db, tenant: w.tenant, FieldValue, paymentId, actor: w.actor("owner") })),
      notes.markRead({ db, tenant: w.tenant, uid: w.uids.manager, notificationId: notificationId("payment.awaiting_verification", ids[0]), FieldValue }),
      notes.markAllRead({ db, tenant: w.tenant, uid: w.uids.manager2, FieldValue }),
    ]);
    expectExplicit(results);
    for (const key of ["owner", "manager", "manager2"]) await consistent(w, key);
  });
});

describe("membership / permission changes after a notification exists", () => {
  it("revoking payments.verify: no new notifications; the old one can't be followed; verify still resolves it", async () => {
    const w = await world();
    const orderId = await order(w, await product(w));
    const { paymentId } = await record(w, orderId, { amount: 100, method: "gcash", reference: "REV 1000" });
    await prov.addMember({ db, admin, businessId: w.id, uid: w.uids.manager, email: `manager.r${run}@ntf.test`, name: "manager", roleTemplate: "manager", permissionOverrides: { revoke: ["payments.verify"] } });
    const member = (await w.tenant.member(w.uids.manager).get()).data();
    const ent = (await w.tenant.ref.get()).data().entitlements;
    expect(canFollowNotification({ type: "payment.awaiting_verification" }, { entitlements: ent, permissions: member.permissions })).toBe(false);
    await record(w, orderId, { amount: 100, method: "gcash", reference: "REV 2000" });
    expect((await inboxOf(w, "manager")).map((n) => n.recordId)).toEqual([paymentId]);
    await pay.verifyPayment({ db, tenant: w.tenant, FieldValue, paymentId, actor: w.actor("owner") });
    const [old] = await inboxOf(w, "manager");
    expect(old).toMatchObject({ resolved: true, read: true });
    await consistent(w, "manager");
  });

  it("a disabled member gets nothing new and their counter stays exact when an old item resolves", async () => {
    const w = await world();
    const orderId = await order(w, await product(w));
    const { paymentId } = await record(w, orderId, { amount: 100, method: "gcash", reference: "DIS 1000" });
    await prov.setMemberStatus({ db, admin, businessId: w.id, uid: w.uids.manager2, status: "disabled" });
    await record(w, orderId, { amount: 100, method: "gcash", reference: "DIS 2000" });
    expect(await inboxOf(w, "manager2")).toHaveLength(1);
    await pay.verifyPayment({ db, tenant: w.tenant, FieldValue, paymentId, actor: w.actor("owner") });
    expect((await consistent(w, "manager2")).unread).toBe(0);
  });
});
