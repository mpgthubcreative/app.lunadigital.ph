// Phase 13: Notifications Core on the server. Events -> rules -> recipients
// (active, permitted, module + feature on, preferences) -> one notification
// per recipient per event (deterministic ids), the unread counter, read /
// read-all / preferences through POST /api/notifications, resolution when
// the item is dealt with, and isolation.

import { describe, it, expect, beforeEach } from "vitest";
import { recordPayment, verifyPayment, voidPayment } from "../../netlify/functions/_lib/payments.js";
import { createOrder, fulfillOrder, setFulfillmentStage } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement, updateProduct, setProductStatus } from "../../netlify/functions/_lib/inventory.js";
import { prepareNotifications, markRead, markAllRead } from "../../netlify/functions/_lib/notifications.js";
import { createNotificationsHandler } from "../../netlify/functions/notifications.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { createBusiness, addMember, ensureAuthUser, updateOverrides } from "../../netlify/functions/_lib/provisioning.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request, clearInboxes } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";
import { isEligibleRecipient, canFollowNotification, notificationId, validatePreferences, NOTIFICATION_TYPES, wantsChannel } from "../../shared/notifications.js";
import { resolvePermissions } from "../../shared/permissions.js";

const Q = (n) => n * QTY_SCALE;
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
const NOW = new Date("2026-10-08T05:22:00Z");
let world;
let A;
let k = 0;
let staff;
let owner;

beforeEach(async () => {
  world = await buildWorld();
  clearInboxes(world.db);
  A = tenantDb(world.db, "biz-a");
  staff = { uid: world.uids.staffa, name: "staffa", email: "staffa@t.test" };
  owner = { uid: world.uids.ownera, name: "ownera", email: "ownera@t.test" };
});

const docAt = (p) => world.db.docs.get(p);
const inboxOf = (uid, bid = "biz-a") =>
  [...world.db.docs.entries()].filter(([p]) => p.startsWith(`businesses/${bid}/members/${uid}/inbox/`)).map(([p, d]) => ({ id: p.split("/").at(-1), ...d }));
const unreadOf = (uid, bid = "biz-a") => docAt(`businesses/${bid}/members/${uid}/inboxState/summary`)?.unread ?? 0;
const allNotifications = (bid = "biz-a") => [...world.db.docs.keys()].filter((p) => p.startsWith(`businesses/${bid}/members/`) && p.includes("/inbox/"));

async function product({ level = 5, opening = 12, name = "Chicken Wings" } = {}) {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor: owner, input: { sku: `N-${++k}`, name, unit: "pcs", sellingPrice: 1000000, reorderLevel: Q(level) } });
  if (opening) await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor: owner, movement: { type: "opening", quantity: Q(opening), unitCost: 5000, note: "count" } });
  return productId;
}
const move = (productId, type, qty, actor = owner) => recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type, quantity: Q(qty), ...(type === "receipt" ? { unitCost: 5000 } : { reason: "damaged" }) } });
async function orderOf(productId, qty = 1) {
  const { orderId } = await createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { customer: { name: "ABC Store" }, source: "viber", items: [{ productId, quantity: Q(qty) }] }, idempotencyKey: `ntf-key-${String(++k).padStart(10, "0")}`, actor: staff, canDiscount: false, now: NOW });
  return orderId;
}
const pay = (orderId, payment, { canVerify = false, actor = staff } = {}) => recordPayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, orderId, input: payment, actor, canVerify, now: NOW });

async function call(uid, body, businessId) {
  const res = await createNotificationsHandler({ getAdmin: async () => world })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe("A. payment awaiting verification", () => {
  it("staff records a GCash payment: Owner and Manager are told, Staff and disabled members aren't; safe content", async () => {
    const orderId = await orderOf(await product());
    const { paymentId } = await pay(orderId, { amount: 400000, method: "gcash", reference: "G-1045" });
    const id = notificationId("payment.awaiting_verification", paymentId);
    for (const who of ["ownera", "managera"]) {
      const [n] = inboxOf(world.uids[who]);
      expect(n).toMatchObject({
        id,
        businessId: "biz-a",
        recipientUid: world.uids[who],
        type: "payment.awaiting_verification",
        category: "payments",
        module: "payments",
        title: "Payment awaiting verification",
        message: `₱4,000.00 GCash received for ${docAt(`businesses/biz-a/orders/${orderId}`).orderNumber}.`,
        recordType: "payment",
        recordId: paymentId,
        action: { label: "Review payment", route: "/payments" },
        read: false,
        resolved: false,
        actorName: "staffa",
        delivery: { inApp: "delivered", email: "not_sent", push: "not_sent" },
      });
      expect(unreadOf(world.uids[who])).toBe(1);
    }
    for (const who of ["staffa", "multi", "disableda"]) expect(inboxOf(world.uids[who]), who).toEqual([]);
    expect(JSON.stringify(allNotifications().map((p) => docAt(p)))).not.toMatch(/proof|tenants\//);
  });

  it("the notification exists exactly when the STORED payment state is For Verification (every method, both recorders)", async () => {
    const orderId = await orderOf(await product());
    const cases = [];
    for (const method of ["cash", "cod", "gcash", "maya", "bank_transfer", "other"]) {
      for (const canVerify of [false, true]) {
        const reference = ["gcash", "maya", "bank_transfer"].includes(method) ? `ST${method.slice(0, 2).toUpperCase()}${canVerify ? 1 : 0}${++k}` : undefined;
        const { paymentId } = await pay(orderId, { amount: 100, method, ...(reference ? { reference } : {}) }, { canVerify, actor: canVerify ? owner : staff });
        cases.push(paymentId);
      }
    }
    for (const paymentId of cases) {
      const state = docAt(`businesses/biz-a/payments/${paymentId}`).state;
      const notified = Boolean(docAt(`businesses/biz-a/members/${world.uids.ownera}/inbox/${notificationId("payment.awaiting_verification", paymentId)}`));
      expect(notified, `${paymentId}: ${state}`).toBe(state === "for_verification");
    }
    expect(unreadOf(world.uids.ownera)).toBe(cases.filter((p) => docAt(`businesses/biz-a/payments/${p}`).state === "for_verification").length);
  });

  it("Phase 8 policy unchanged: Staff Cash (no reference, no screenshot) is For Verification and notifies; Owner Cash is Verified and doesn't", async () => {
    const orderId = await orderOf(await product());
    const staffCash = await pay(orderId, { amount: 100, method: "cash" });
    expect(staffCash.state).toBe("for_verification");
    expect(inboxOf(world.uids.ownera).map((n) => n.recordId)).toEqual([staffCash.paymentId]);
    const ownerCash = await pay(orderId, { amount: 100, method: "cash" }, { canVerify: true, actor: owner });
    expect(ownerCash.state).toBe("verified");
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
  });

  it("a payment recorded by someone who can verify is verified at once: nobody is notified", async () => {
    const orderId = await orderOf(await product());
    await pay(orderId, { amount: 1000, method: "gcash", reference: "OWN-1" }, { canVerify: true, actor: owner });
    expect(allNotifications()).toEqual([]);
  });

  it("verifying resolves every recipient's copy and clears it from their unread count", async () => {
    const orderId = await orderOf(await product());
    const { paymentId } = await pay(orderId, { amount: 1000, method: "gcash", reference: "VER-1" });
    await markRead({ db: world.db, tenant: A, uid: world.uids.managera, notificationId: notificationId("payment.awaiting_verification", paymentId), FieldValue });
    await verifyPayment({ db: world.db, tenant: A, FieldValue, paymentId, actor: owner });
    for (const who of ["ownera", "managera"]) {
      expect(inboxOf(world.uids[who])[0]).toMatchObject({ resolved: true, read: true });
      expect(unreadOf(world.uids[who]), who).toBe(0);
    }
    // removing a payment that awaited verification resolves too
    const { paymentId: p2 } = await pay(orderId, { amount: 1000, method: "maya", reference: "VER-2" });
    expect(unreadOf(world.uids.ownera)).toBe(1);
    await voidPayment({ db: world.db, tenant: A, FieldValue, business: BIZ, paymentId: p2, reason: "wrong order", actor: owner });
    expect(unreadOf(world.uids.ownera)).toBe(0);
    expect(inboxOf(world.uids.ownera).every((n) => n.resolved)).toBe(true);
  });

  it("a retried request (same reference) can't notify twice; concurrent retries neither", async () => {
    const orderId = await orderOf(await product());
    const body = { amount: 1000, method: "gcash", reference: "RETRY-1" };
    const results = await Promise.allSettled([pay(orderId, body), pay(orderId, body), pay(orderId, body)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    expect(unreadOf(world.uids.ownera)).toBe(1);
  });

  it("the same event can't create a second copy (deterministic id, checked in the transaction)", async () => {
    const event = { type: "payment.awaiting_verification", key: "abcdef123456", title: "t", message: "m" };
    for (let i = 0; i < 3; i++) {
      await world.db.runTransaction(async (tx) => (await prepareNotifications(tx, { tenant: A, events: [event, event] })).commit({ FieldValue }));
    }
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    expect(unreadOf(world.uids.ownera)).toBe(1);
  });

  it("a member with malformed data is skipped; the payment still succeeds", async () => {
    world.db.docs.get(`businesses/biz-a/members/${world.uids.managera}`).permissions = "everything";
    const orderId = await orderOf(await product());
    await expect(pay(orderId, { amount: 1000, method: "gcash", reference: "BAD-1" })).resolves.toMatchObject({ state: "for_verification" });
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    expect(inboxOf(world.uids.managera)).toEqual([]);
  });
});

describe("B. low stock: one alert per crossing", () => {
  it("12 -> 5 (level 5) alerts once; 5 -> 4 doesn't; back above then below alerts again", async () => {
    const id = await product({ level: 5, opening: 12 });
    expect(allNotifications()).toEqual([]); // creating / stocking never alerts
    await move(id, "adjustment_decrease", 7); // available 5 <= 5
    let mine = inboxOf(world.uids.ownera);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: "inventory.low_stock", title: "Low stock", message: "Chicken Wings is down to 5 pcs available (reorder level 5).", recordId: id, action: { label: "View inventory", route: "/inventory" } });
    await move(id, "adjustment_decrease", 1); // 4: still low
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    await move(id, "receipt", 10); // 14: not low
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    await move(id, "adjustment_decrease", 11); // 3: low again
    mine = inboxOf(world.uids.ownera);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((n) => n.id)).size).toBe(2);
    expect(unreadOf(world.uids.ownera)).toBe(2);
    expect(docAt(`businesses/biz-a/products/${id}`).lowStockEpisode).toBe(2);
  });

  it("goes to people who can restock (inventory.receive): Owner, Manager; not Staff", async () => {
    const id = await product({ level: 5, opening: 6 });
    await move(id, "adjustment_decrease", 1);
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    expect(inboxOf(world.uids.managera)).toHaveLength(1);
    expect(inboxOf(world.uids.staffa)).toEqual([]);
    expect(inboxOf(world.uids.multi)).toEqual([]);
  });

  it("orders crossing the level alert (reservation counts: it lowers what's available)", async () => {
    const id = await product({ level: 5, opening: 8 });
    const orderId = await orderOf(id, 3); // reserved 3 -> available 5
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    await fulfillOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId, actor: staff, now: NOW }); // still low
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
  });

  it("raising the reorder level, or reactivating a product at its level, is a crossing too", async () => {
    const id = await product({ level: 2, opening: 6 });
    await updateProduct({ db: world.db, tenant: A, FieldValue, productId: id, changes: { reorderLevel: Q(10) }, actor: owner });
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    const id2 = await product({ level: 5, opening: 3, name: "Pork" }); // low from the start: no alert
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    await setProductStatus({ db: world.db, tenant: A, FieldValue, productId: id2, status: "inactive", actor: owner });
    await setProductStatus({ db: world.db, tenant: A, FieldValue, productId: id2, status: "active", actor: owner });
    expect(inboxOf(world.uids.ownera).map((n) => n.recordId).sort()).toEqual([id, id2].sort());
  });

  it("a recipient who switched Low stock off isn't told; others still are", async () => {
    expect((await call(world.uids.managera, { action: "preferences", preferences: { inventory: { inApp: false } } })).status).toBe(200);
    const id = await product({ level: 5, opening: 6 });
    await move(id, "adjustment_decrease", 2);
    expect(inboxOf(world.uids.managera)).toEqual([]);
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
  });
});

describe("C. order ready", () => {
  it("moving to Ready tells the people who fulfill, not the person who did it; other stages are quiet", async () => {
    const orderId = await orderOf(await product());
    await setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "preparing", actor: staff });
    expect(allNotifications()).toEqual([]);
    await setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "ready", actor: staff });
    const number = docAt(`businesses/biz-a/orders/${orderId}`).orderNumber;
    for (const who of ["ownera", "managera", "multi"]) expect(inboxOf(world.uids[who])[0], who).toMatchObject({ type: "order.ready", message: `${number} for ABC Store is ready for fulfillment.`, recordId: orderId });
    expect(inboxOf(world.uids.staffa)).toEqual([]);
    // Ready again (retry): unchanged, no second notification
    await setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "ready", actor: staff });
    expect(inboxOf(world.uids.ownera)).toHaveLength(1);
    // back to preparing and Ready again: a new event
    await setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "preparing", actor: owner });
    await setFulfillmentStage({ db: world.db, tenant: A, FieldValue, orderId, stage: "ready", actor: owner });
    expect(inboxOf(world.uids.ownera)).toHaveLength(1); // owner did it this time
    expect(inboxOf(world.uids.managera)).toHaveLength(2);
    expect(inboxOf(world.uids.staffa)).toHaveLength(1);
  });

  it("there is no 'payment overdue' rule (no due dates exist)", () => {
    expect(Object.keys(NOTIFICATION_TYPES).sort()).toEqual(["budget.threshold", "household.advance_request", "household.attendance_request", "inventory.low_stock", "order.ready", "payment.awaiting_verification", "payroll.receipt_confirmed", "payroll.salary_disputed", "supplierpayment.paid", "usage.threshold"]);
  });
});

describe("read / read all / unread counter (POST /api/notifications)", () => {
  async function threeFor() {
    const id = await product({ level: 5, opening: 20 });
    const orderId = await orderOf(id);
    const out = [];
    for (let i = 0; i < 3; i++) out.push((await pay(orderId, { amount: 100, method: "gcash", reference: `REF${++k}X${i}` })).paymentId);
    return out.map((p) => notificationId("payment.awaiting_verification", p));
  }

  it("read one: -1 for that user only; again: unchanged; read all: 0; another user's state is independent", async () => {
    const [n1] = await threeFor();
    expect(unreadOf(world.uids.ownera)).toBe(3);
    expect(await call(world.uids.ownera, { action: "read", notificationId: n1 })).toMatchObject({ status: 200, body: { unread: 2 } });
    expect(await call(world.uids.ownera, { action: "read", notificationId: n1 })).toMatchObject({ status: 200, body: { unread: 2, unchanged: true } });
    expect(unreadOf(world.uids.managera)).toBe(3);
    expect(inboxOf(world.uids.managera).every((n) => !n.read)).toBe(true);
    expect(await call(world.uids.ownera, { action: "readAll" })).toMatchObject({ status: 200, body: { marked: 2, unread: 0 } });
    expect(unreadOf(world.uids.ownera)).toBe(0);
    expect(unreadOf(world.uids.managera)).toBe(3);
  });

  it("a notification created after read-all is still unread and counted", async () => {
    await threeFor();
    await call(world.uids.ownera, { action: "readAll" });
    const orderId = await orderOf(await product());
    await pay(orderId, { amount: 100, method: "gcash", reference: "AFTER-1" });
    expect(unreadOf(world.uids.ownera)).toBe(1);
  });

  it("read-all repairs a drifted counter and never goes negative", async () => {
    await threeFor();
    world.db.docs.get(`businesses/biz-a/members/${world.uids.ownera}/inboxState/summary`).unread = -7;
    await call(world.uids.ownera, { action: "readAll" });
    expect(unreadOf(world.uids.ownera)).toBe(0);
    world.db.docs.get(`businesses/biz-a/members/${world.uids.ownera}/inboxState/summary`).unread = 0;
    const [n] = (await threeFor()).slice(-1);
    world.db.docs.get(`businesses/biz-a/members/${world.uids.ownera}/inboxState/summary`).unread = 0;
    expect((await call(world.uids.ownera, { action: "read", notificationId: n })).body.unread).toBe(0);
  });

  it("read-all works through more than one chunk", async () => {
    const event = (i) => ({ type: "payment.awaiting_verification", key: `bulk${i}`, title: "t", message: "m" });
    await world.db.runTransaction(async (tx) => (await prepareNotifications(tx, { tenant: A, events: Array.from({ length: 450 }, (_, i) => event(i)) })).commit({ FieldValue }));
    expect(unreadOf(world.uids.ownera)).toBe(450);
    expect(await markAllRead({ db: world.db, tenant: A, uid: world.uids.ownera, FieldValue })).toEqual({ marked: 450, unread: 0 });
    expect(inboxOf(world.uids.ownera).every((n) => n.read)).toBe(true);
  });

  it("the caller's uid comes from the token: unknown ids are 404, bad ids 400, unknown fields 400", async () => {
    await threeFor();
    expect((await call(world.uids.staffa, { action: "read", notificationId: notificationId("payment.awaiting_verification", "nope12345678") })).status).toBe(404);
    expect((await call(world.uids.ownera, { action: "read", notificationId: "../x" })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "read", notificationId: "a", uid: world.uids.managera })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "delete" })).status).toBe(400);
  });

  it("401 without a token; B can't touch A's inbox; a disabled member can't; staff can use their own", async () => {
    expect((await createNotificationsHandler({ getAdmin: async () => world })({ ...request({ method: "POST" }), body: "{}" })).statusCode).toBe(401);
    expect((await call(world.uids.ownerb, { action: "readAll" }, "biz-a")).status).toBe(403);
    expect((await call(world.uids.disableda, { action: "readAll" }, "biz-a")).status).toBe(403);
    expect((await call(world.uids.staffa, { action: "readAll" })).status).toBe(200);
  });

  it("a cancelled account (export-only) can't use notifications", async () => {
    expect((await call(world.uids.ownerx, { action: "readAll" }, "biz-x")).status).toBe(403);
  });
});

describe("preferences", () => {
  it("only known optional categories, in-app only, booleans; mandatory ones can't be switched off", async () => {
    expect((await call(world.uids.managera, { action: "preferences", preferences: { payments: { inApp: false } } })).body.error).toBe("mandatory-notification");
    expect((await call(world.uids.managera, { action: "preferences", preferences: { marketing: { inApp: true } } })).status).toBe(400);
    expect((await call(world.uids.managera, { action: "preferences", preferences: { inventory: { email: true } } })).status).toBe(400);
    expect((await call(world.uids.managera, { action: "preferences", preferences: { inventory: { inApp: "no" } } })).status).toBe(400);
    expect((await call(world.uids.managera, { action: "preferences", preferences: { orders: { inApp: false } } })).body.preferences).toEqual({ orders: { inApp: false } });
    expect(docAt(`businesses/biz-a/members/${world.uids.managera}`).notificationPreferences).toEqual({ orders: { inApp: false } });
    expect(() => validatePreferences([])).toThrow();
    expect(wantsChannel({ payments: { inApp: false } }, "payments", "inApp")).toBe(true);
    expect(wantsChannel({}, "inventory", "email")).toBe(false);
  });

  it("re-adding a member keeps their choices", async () => {
    await call(world.uids.managera, { action: "preferences", preferences: { inventory: { inApp: false } } });
    await addMember({ db: world.db, admin: world.admin, businessId: "biz-a", uid: world.uids.managera, email: "managera@t.test", name: "managera", roleTemplate: "manager" });
    expect(docAt(`businesses/biz-a/members/${world.uids.managera}`).notificationPreferences).toEqual({ inventory: { inApp: false } });
  });
});

describe("isolation, workspaces, permissions", () => {
  it("B's events never reach A's members, and the reverse", async () => {
    const orderId = await orderOf(await product());
    await pay(orderId, { amount: 100, method: "gcash", reference: "ISO-1" });
    expect(allNotifications("biz-b")).toEqual([]);
    expect(inboxOf(world.uids.multi, "biz-b")).toEqual([]); // multi is a B manager, but the event is A's
  });

  it("a Bridal / Payroll / Baby workspace is never eligible for Distributor rules", async () => {
    for (const tpl of ["bridal-expense", "household-payroll", "baby-expense"]) {
      await createBusiness({ ...world, name: tpl, planId: "pro", workspaceTemplateId: tpl, businessId: `biz-${tpl}` });
      const entitlements = docAt(`businesses/biz-${tpl}`).entitlements;
      const member = { status: "active", permissions: resolvePermissions("owner") };
      for (const type of ["payment.awaiting_verification", "inventory.low_stock", "order.ready"]) expect(isEligibleRecipient(type, { entitlements, member }), `${tpl}/${type}`).toBe(false);
      // Phase 14: payroll notifications exist only where Payroll does.
      expect(isEligibleRecipient("payroll.receipt_confirmed", { entitlements, member }), tpl).toBe(tpl === "household-payroll");
    }
    const distributor = docAt("businesses/biz-a").entitlements;
    expect(isEligibleRecipient("payroll.receipt_confirmed", { entitlements: distributor, member: { status: "active", permissions: resolvePermissions("owner") } })).toBe(false);
    expect(Object.keys(NOTIFICATION_TYPES)).toContain("payroll.receipt_confirmed");
  });

  it("a business without in-app notifications in its package, or with the module off, gets none", async () => {
    world.db.docs.get("businesses/biz-a").entitlements.features.inAppNotifications = false;
    const id = await product({ level: 5, opening: 6 });
    await move(id, "adjustment_decrease", 2);
    expect(allNotifications()).toEqual([]);
    world.db.docs.get("businesses/biz-a").entitlements.features.inAppNotifications = true;
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { payments: false } }, actor: "t", reason: "off" });
    const orderId = await orderOf(await product());
    await world.db.runTransaction(async (tx) => (await prepareNotifications(tx, { tenant: A, events: [{ type: "payment.awaiting_verification", key: "offmodule1", title: "t", message: "m" }] })).commit({ FieldValue }));
    expect(allNotifications().filter((p) => p.includes("payment"))).toEqual([]);
    expect(orderId).toBeTruthy();
  });

  it("losing a permission later: the old notification's link is no longer followable", async () => {
    const ent = docAt("businesses/biz-a").entitlements;
    const n = { type: "payment.awaiting_verification" };
    expect(canFollowNotification(n, { entitlements: ent, permissions: resolvePermissions("manager") })).toBe(true);
    expect(canFollowNotification(n, { entitlements: ent, permissions: resolvePermissions("manager", { revoke: ["payments.verify"] }) })).toBe(false);
    expect(canFollowNotification({ type: "made.up" }, { entitlements: ent, permissions: resolvePermissions("owner") })).toBe(false);
  });

  it("a new member added later doesn't get earlier notifications; a disabled one gets no new ones", async () => {
    const orderId = await orderOf(await product());
    await pay(orderId, { amount: 100, method: "gcash", reference: "LATE-1" });
    const u = await ensureAuthUser({ auth: world.auth, email: "late@t.test", name: "late" });
    await updateOverrides({ ...world, businessId: "biz-a", set: { limits: { users: 20 } }, actor: "t", reason: "room" });
    await addMember({ ...world, businessId: "biz-a", uid: u.uid, email: u.email, name: "late", roleTemplate: "manager" });
    expect(inboxOf(u.uid)).toEqual([]);
    await addMember({ ...world, businessId: "biz-a", uid: u.uid, email: u.email, name: "late", roleTemplate: "manager", status: "disabled" });
    await pay(orderId, { amount: 100, method: "gcash", reference: "LATE-2" });
    expect(inboxOf(u.uid)).toEqual([]);
  });
});
