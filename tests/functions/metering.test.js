// Phase 18: usage metering. Enforcement against the EFFECTIVE limit (plan
// or the operator's per-business override, read in the transaction), the
// 80% / 100% owner warnings (once per month / usage episode, never on
// refused attempts), file storage reserve -> finalize -> release / delete,
// the operator's limit overrides, the read models, GET /api/usage, and the
// recount tool. Concurrency is covered on the emulator
// (tests/emulator/metering-concurrency.test.js).

import { describe, it, expect, beforeEach } from "vitest";
import { createOrder, deleteOrder, cancelOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { recordPayment, voidPayment } from "../../netlify/functions/_lib/payments.js";
import { previewImport, commitImport } from "../../netlify/functions/_lib/imports.js";
import { addMember, setMemberStatus, ensureAuthUser, setLimitOverride, updateOverrides, assignPlan } from "../../netlify/functions/_lib/provisioning.js";
import { reserveStorage, prepareStorageFinalize, releaseStorageReservation, deleteStoredFile, storageObjectId, RESERVATION_MS } from "../../netlify/functions/_lib/storage-usage.js";
import { computeRecount, applyRecount } from "../../netlify/functions/_lib/recount.js";
import { noteLimitReached } from "../../netlify/functions/_lib/metering.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createUsageHandler } from "../../netlify/functions/usage.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { createPaymentsHandler } from "../../netlify/functions/payments.js";
import { setOperator } from "../../netlify/functions/_lib/provisioning.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request, clearInboxes } from "../helpers/tenants.js";
import { notificationId } from "../../shared/notifications.js";
import { QTY_SCALE } from "../../shared/quantity.js";

const Q = (n) => n * QTY_SCALE;
const NOW = new Date("2026-10-08T02:00:00Z"); // Oct 8, 10:00 Manila
const BIZ = { id: "biz-a", name: "Biz A", timezone: "Asia/Manila", currency: "PHP", orderPrefix: "BA" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const proof = () => ({ contentType: "image/png", dataBase64: PNG.toString("base64") });
const actor = { uid: "u-staff", name: "Staff A", email: "staff@t.test" };

let world;
let A;
let key = 0;
beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
  clearInboxes(world.db);
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "ops" });
  await setOperator({ ...world, email: op.email, reason: "test operator" });
  world.uids.ops = op.uid;
});

const docAt = (p) => world.db.docs.get(p);
const usage = (bid = "biz-a", period = "2026-10") => docAt(`businesses/${bid}/usage/${period}`) || {};
const storageDoc = (bid = "biz-a") => docAt(`businesses/${bid}/usageCurrent/storage`) || {};
const ledger = (bid = "biz-a") => [...world.db.docs.entries()].filter(([p]) => p.startsWith(`businesses/${bid}/storageObjects/`)).map(([p, d]) => ({ id: p.split("/").at(-1), ...d }));
const inbox = (uid, bid = "biz-a") => [...world.db.docs.entries()].filter(([p]) => p.startsWith(`businesses/${bid}/members/${uid}/inbox/`)).map(([p, d]) => ({ id: p.split("/").at(-1), ...d }));
const usageNotes = (uid, bid = "biz-a") => inbox(uid, bid).filter((n) => n.type === "usage.threshold").map((n) => n.eventKey).sort();
const platformAudit = (type) => [...world.db.docs.entries()].filter(([p, d]) => p.startsWith("platformAudit/") && d.type === type).map(([, d]) => d);
const ent = () => docAt("businesses/biz-a").entitlements;
const override = (limitKey, value, extra = {}) => setLimitOverride({ ...world, businessId: "biz-a", limitKey, value, actor: "ops@luna.test", reason: "test override", ...extra });

async function product(qty = 1000) {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: `P-${++key}`, name: "Item", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } });
  await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(qty), unitCost: 50, note: "count" } });
  return productId;
}
const order = (pid, { now = NOW, idem = `idem-key-${String(++key).padStart(8, "0")}` } = {}) =>
  createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: ent(), input: { customer: { name: "Juan" }, source: "phone", items: [{ productId: pid, quantity: Q(1) }] }, idempotencyKey: idem, actor, canDiscount: false, now });
const opCall = async (body, uid = world.uids.ops) => {
  const res = await createOperatorHandler({ getAdmin: async () => world })({ ...request({ uid }), httpMethod: "POST", body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

describe("monthly limits: enforced against the effective limit, read in the transaction", () => {
  it("an override replaces the plan's limit (plan 2000 -> override 5); the 6th order is refused and not counted", async () => {
    const pid = await product();
    await override("ordersPerMonth", 5);
    expect(ent().limits.ordersPerMonth).toBe(5);
    for (let i = 0; i < 5; i++) await order(pid);
    await expect(order(pid)).rejects.toMatchObject({ code: "order-limit-reached", message: "This month's order limit (5) has been reached. Contact Luna to raise it." });
    expect(usage().ordersCreated).toBe(5);
    expect(usage()).toMatchObject({ period: "2026-10", timezone: "Asia/Manila" });
  });

  it("a limit changed after the caller read its snapshot still applies (the transaction reads the business)", async () => {
    const pid = await product();
    const stale = ent(); // the request context read this before the operator lowered the limit
    await order(pid);
    await override("ordersPerMonth", 1);
    await expect(createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: stale, input: { customer: { name: "J" }, source: "phone", items: [{ productId: pid, quantity: Q(1) }] }, idempotencyKey: "idem-key-stale-0001", actor, canDiscount: false, now: NOW })).rejects.toMatchObject({ code: "order-limit-reached" });
  });

  it("deleting or cancelling orders never gives slots back (activity, not records kept)", async () => {
    const pid = await product();
    await override("ordersPerMonth", 2);
    const a = await order(pid);
    const b = await order(pid);
    await deleteOrder({ db: world.db, tenant: A, FieldValue, orderId: a.orderId, actor });
    await cancelOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, orderId: b.orderId, reason: "changed mind", actor, now: NOW });
    expect(usage().ordersCreated).toBe(2);
    await expect(order(pid)).rejects.toMatchObject({ code: "order-limit-reached" });
  });

  it("a retried request (same idempotency key) counts once", async () => {
    const pid = await product();
    await order(pid, { idem: "idem-key-retry-00001" });
    const again = await order(pid, { idem: "idem-key-retry-00001" });
    expect(again.replayed).toBe(true);
    expect(usage().ordersCreated).toBe(1);
  });

  it("a new month starts at 0 (business timezone): Oct 31 23:30 Manila is October, Nov 1 00:30 is November", async () => {
    const pid = await product();
    await override("ordersPerMonth", 1);
    await order(pid, { now: new Date("2026-10-31T15:30:00Z") });
    await order(pid, { now: new Date("2026-10-31T16:30:00Z") });
    expect(usage("biz-a", "2026-10").ordersCreated).toBe(1);
    expect(usage("biz-a", "2026-11").ordersCreated).toBe(1);
  });

  it("imports: the override applies and a refused commit isn't counted", async () => {
    await override("importsPerMonth", 1);
    const common = { db: world.db, tenant: A, FieldValue, actor, now: NOW };
    const rows = (s) => [{ n: 2, values: { sku: s, name: `Item ${s}`, unit: "pcs", sellingPrice: "1.00" } }];
    const j1 = await previewImport({ ...common, type: "products", fileName: "a.csv", rows: rows("IMP-1") });
    const j2 = await previewImport({ ...common, type: "products", fileName: "b.csv", rows: rows("IMP-2") });
    await commitImport({ ...common, business: BIZ, entitlements: ent(), jobId: j1.jobId });
    await expect(commitImport({ ...common, business: BIZ, entitlements: ent(), jobId: j2.jobId })).rejects.toMatchObject({ code: "import-limit-reached" });
    expect(usage().excelImports).toBe(1);
  });
});

describe("80% / 100% warnings: owners only, once per month / episode, never per refused attempt", () => {
  it("orders: 4 of 5 -> 80%, 5 of 5 -> 100%, to the Owner only; refused attempts add nothing", async () => {
    const pid = await product();
    await override("ordersPerMonth", 5);
    for (let i = 0; i < 3; i++) await order(pid);
    expect(usageNotes(world.uids.ownera)).toEqual([]);
    await order(pid);
    expect(usageNotes(world.uids.ownera)).toEqual(["ordersCreated-2026-10-80"]);
    await order(pid);
    for (let i = 0; i < 3; i++) await expect(order(pid)).rejects.toMatchObject({ code: "order-limit-reached" });
    expect(usageNotes(world.uids.ownera)).toEqual(["ordersCreated-2026-10-100", "ordersCreated-2026-10-80"]);
    const n = inbox(world.uids.ownera).find((x) => x.eventKey === "ordersCreated-2026-10-100");
    expect(n).toMatchObject({ title: "Orders: plan limit reached", category: "usage", module: "settings", action: { route: "/settings" } });
    for (const who of ["managera", "staffa", "multi"]) expect(usageNotes(world.uids[who]), who).toEqual([]);
    expect(docAt(`businesses/biz-a/members/${world.uids.ownera}/inboxState/summary`).unread).toBe(2);
  });

  it("a limit lowered below usage: the first refused attempt records 'limit reached' once; later refusals don't notify", async () => {
    const pid = await product();
    for (let i = 0; i < 3; i++) await order(pid);
    const r = await override("ordersPerMonth", 2);
    expect(r.warnings.join(" ")).toMatch(/Orders per month: 3 already used, at or above the new limit of 2/);
    // the lower limit itself puts usage at 100% (and 80%): warned once each
    expect(usageNotes(world.uids.ownera)).toEqual(["ordersCreated-2026-10-100", "ordersCreated-2026-10-80"]);
    for (let i = 0; i < 3; i++) await expect(order(pid)).rejects.toMatchObject({ code: "order-limit-reached" });
    expect(usageNotes(world.uids.ownera)).toHaveLength(2);
    expect(usage().ordersCreated).toBe(3);
  });

  it("a refusal at an exhausted limit with no earlier warning notifies 100% once (e.g. an inherited over-limit month)", async () => {
    const pid = await product();
    world.db.seed("businesses/biz-a/usage/2026-10", { period: "2026-10", ordersCreated: 2000 });
    for (let i = 0; i < 2; i++) await expect(order(pid)).rejects.toMatchObject({ code: "order-limit-reached" });
    expect(usageNotes(world.uids.ownera)).toEqual(["ordersCreated-2026-10-100"]);
  });

  it("'limit reached' is only recorded at or over the limit (a call below it writes nothing)", async () => {
    expect(await noteLimitReached({ db: world.db, tenant: A, FieldValue, meterId: "ordersCreated", used: 1999, limit: 2000, period: "2026-10" })).toBe(0);
    expect(await noteLimitReached({ db: world.db, tenant: A, FieldValue, meterId: "storageBytes", used: 10, limit: 100 })).toBe(0);
    expect(usageNotes(world.uids.ownera)).toEqual([]);
    expect(docAt("businesses/biz-a/usageCurrent/storage")).toBeUndefined();
  });

  it("users (a running total): 4 of 5 -> 80% once; dropping below 70% re-arms; crossing again is a new episode", async () => {
    // biz-a (Growth, 5 users) already has 4 active: the 80% warning fired during setup.
    world = await buildWorld();
    expect(usageNotes(world.uids.ownera)).toEqual(["activeUsers-e1-80"]);
    const extra = await ensureAuthUser({ auth: world.auth, email: "fifth@t.test", name: "Fifth" });
    await addMember({ ...world, businessId: "biz-a", uid: extra.uid, email: extra.email, name: "Fifth", roleTemplate: "staff" });
    expect(usageNotes(world.uids.ownera)).toEqual(["activeUsers-e1-100", "activeUsers-e1-80"]);
    await expect(addMember({ ...world, businessId: "biz-a", uid: "u-sixth", email: "sixth@t.test", name: "Sixth", roleTemplate: "staff" })).rejects.toMatchObject({ code: "user-limit-reached" });
    expect(usageNotes(world.uids.ownera)).toHaveLength(2); // the refusal doesn't notify again
    for (const who of ["staffa", "multi"]) await setMemberStatus({ ...world, businessId: "biz-a", uid: world.uids[who], status: "disabled" }); // 3 of 5 = 60%
    await setMemberStatus({ ...world, businessId: "biz-a", uid: world.uids.staffa, status: "active" }); // 4 of 5 again
    expect(usageNotes(world.uids.ownera)).toEqual(["activeUsers-e1-100", "activeUsers-e1-80", "activeUsers-e2-80"]);
  });

  it("no warnings for meter-only counters (exports, payments recorded, ...)", async () => {
    const pid = await product();
    const o = await order(pid);
    for (let i = 0; i < 5; i++) await recordPayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, orderId: o.orderId, input: { amount: 1, method: "cash" }, actor, canVerify: true, now: NOW });
    expect(usage().paymentsRecorded).toBe(5);
    expect(usageNotes(world.uids.ownera)).toEqual([]);
  });

  it("a business without in-app notifications in its package gets none (and the action still succeeds)", async () => {
    await updateOverrides({ ...world, businessId: "biz-a", set: { features: { inAppNotifications: false } }, actor: "ops", reason: "no notifications" });
    const pid = await product();
    await override("ordersPerMonth", 1);
    await order(pid);
    expect(usage().ordersCreated).toBe(1);
    expect(usageNotes(world.uids.ownera)).toEqual([]);
  });
});

describe("file storage: reserve -> upload -> finalize; release; delete; exactly once; never negative", () => {
  const pay = async (opts = {}) => {
    const pid = await product();
    const o = await order(pid);
    return recordPayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, orderId: o.orderId, input: { amount: 100, method: "gcash", reference: opts.reference ?? `REF${++key}` }, proof: proof(), actor, canVerify: true, now: NOW });
  };

  it("a screenshot is counted with the server-measured size, recorded in the ledger as stored, in the payment's transaction", async () => {
    const p = await pay();
    const payment = docAt(`businesses/biz-a/payments/${p.paymentId}`);
    expect(storageDoc()).toMatchObject({ bytes: PNG.length, reservedBytes: 0, objects: 1 });
    const [l] = ledger();
    expect(l).toMatchObject({ id: storageObjectId(payment.proof.path), path: payment.proof.path, bytes: PNG.length, state: "stored", recordType: "payment", recordId: p.paymentId, area: "payments" });
    expect(payment.proof).toMatchObject({ size: PNG.length, objectId: l.id });
  });

  it("refused BEFORE anything is stored when it would exceed the effective limit (override 40 bytes)", async () => {
    await override("storageBytes", PNG.length + 10);
    await pay();
    const filesBefore = world.storage.files.size;
    await expect(pay()).rejects.toMatchObject({ code: "storage-limit-reached" });
    expect(world.storage.files.size).toBe(filesBefore);
    expect(storageDoc()).toMatchObject({ bytes: PNG.length, reservedBytes: 0, objects: 1 });
    expect(ledger()).toHaveLength(1);
  });

  it("through the API: 409 storage-limit-reached with a clear message", async () => {
    await override("storageBytes", 1);
    const pid = await product();
    const o = await order(pid);
    const res = await createPaymentsHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid: world.uids.ownera, businessId: "biz-a" }), httpMethod: "POST", body: JSON.stringify({ action: "record", orderId: o.orderId, payment: { amount: 100, method: "gcash", reference: "REF-API1" }, proof: proof() }) });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "storage-limit-reached", message: expect.stringMatching(/storage is full/) });
  });

  it("an upload failure after the reservation gives the bytes back", async () => {
    const save = world.storage.file;
    world.storage.file = (path) => ({ ...save.call(world.storage, path), save: async () => Promise.reject(new Error("network")) });
    await expect(pay()).rejects.toThrow("network");
    world.storage.file = save;
    expect(storageDoc()).toMatchObject({ bytes: 0, reservedBytes: 0 });
    expect(ledger()[0].state).toBe("released");
  });

  it("a failed business transaction (duplicate reference) removes the object and releases the reservation", async () => {
    await pay({ reference: "SAME-REF1" });
    await expect(pay({ reference: "SAME-REF1" })).rejects.toMatchObject({ code: "duplicate-reference" });
    expect(storageDoc()).toMatchObject({ bytes: PNG.length, reservedBytes: 0, objects: 1 });
    expect(ledger().map((l) => l.state).sort()).toEqual(["released", "stored"]);
    expect(world.storage.files.size).toBe(1);
  });

  it("reserve is idempotent per path; release twice and delete twice change the totals once; never negative", async () => {
    const path = "tenants/biz-a/payments/proofs/o1/p1-aaaa.png";
    const a = await reserveStorage({ db: world.db, tenant: A, FieldValue, path, bytes: 100, area: "payments", now: NOW });
    const b = await reserveStorage({ db: world.db, tenant: A, FieldValue, path, bytes: 100, area: "payments", now: NOW });
    expect(b.replayed).toBe(true);
    expect(storageDoc().reservedBytes).toBe(100);
    await releaseStorageReservation({ db: world.db, tenant: A, FieldValue, objectId: a.objectId });
    await releaseStorageReservation({ db: world.db, tenant: A, FieldValue, objectId: a.objectId });
    expect(storageDoc().reservedBytes).toBe(0);

    const p = await pay();
    const id = docAt(`businesses/biz-a/payments/${p.paymentId}`).proof.objectId;
    expect(storageDoc().bytes).toBe(PNG.length);
    await deleteStoredFile({ db: world.db, tenant: A, FieldValue, bucket: world.bucket, objectId: id });
    await deleteStoredFile({ db: world.db, tenant: A, FieldValue, bucket: world.bucket, objectId: id });
    expect(storageDoc()).toMatchObject({ bytes: 0, objects: 0 });
    expect(world.storage.files.has(ledger().find((l) => l.id === id).path)).toBe(false);
  });

  it("a finalize retried inside the business transaction counts once", async () => {
    const path = "tenants/biz-a/payments/proofs/o1/p2-bbbb.png";
    const r = await reserveStorage({ db: world.db, tenant: A, FieldValue, path, bytes: 50, area: "payments", now: NOW });
    for (let i = 0; i < 2; i++) await world.db.runTransaction(async (tx) => (await prepareStorageFinalize(tx, { tenant: A, objectId: r.objectId })).commit({ FieldValue }));
    expect(storageDoc()).toMatchObject({ bytes: 50, reservedBytes: 0, objects: 1 });
  });

  it("an abandoned reservation (crash) expires and is swept by the next one, giving its bytes back", async () => {
    await override("storageBytes", 150);
    await reserveStorage({ db: world.db, tenant: A, FieldValue, path: "tenants/biz-a/payments/proofs/o/x-1.png", bytes: 100, area: "payments", now: NOW });
    await expect(reserveStorage({ db: world.db, tenant: A, FieldValue, path: "tenants/biz-a/payments/proofs/o/x-2.png", bytes: 100, area: "payments", now: NOW })).rejects.toMatchObject({ code: "storage-limit-reached" });
    const later = new Date(NOW.getTime() + RESERVATION_MS + 1000);
    await reserveStorage({ db: world.db, tenant: A, FieldValue, path: "tenants/biz-a/payments/proofs/o/x-3.png", bytes: 100, area: "payments", now: later });
    expect(storageDoc().reservedBytes).toBe(100);
    expect(ledger().map((l) => l.state).sort()).toEqual(["expired", "reserved"]);
  });

  it("releasing a reservation that already expired doesn't give its bytes back a second time", async () => {
    await override("storageBytes", 1000);
    const old = await reserveStorage({ db: world.db, tenant: A, FieldValue, path: "tenants/biz-a/payments/proofs/o/y-1.png", bytes: 100, area: "payments", now: NOW });
    const later = new Date(NOW.getTime() + RESERVATION_MS + 1000);
    await reserveStorage({ db: world.db, tenant: A, FieldValue, path: "tenants/biz-a/payments/proofs/o/y-2.png", bytes: 70, area: "payments", now: later }); // sweeps y-1
    expect(storageDoc().reservedBytes).toBe(70);
    expect(await releaseStorageReservation({ db: world.db, tenant: A, FieldValue, objectId: old.objectId })).toMatchObject({ released: true });
    expect(storageDoc().reservedBytes).toBe(70);
    expect(ledger().find((l) => l.id === old.objectId).state).toBe("released");
  });

  it("a late finalize of an expired reservation must fit again: refused when the room was taken, counted once when it fits", async () => {
    await override("storageBytes", 150);
    const old = await reserveStorage({ db: world.db, tenant: A, FieldValue, path: "tenants/biz-a/payments/proofs/o/z-1.png", bytes: 100, area: "payments", now: NOW });
    const later = new Date(NOW.getTime() + RESERVATION_MS + 1000);
    const other = await reserveStorage({ db: world.db, tenant: A, FieldValue, path: "tenants/biz-a/payments/proofs/o/z-2.png", bytes: 100, area: "payments", now: later });
    const finalize = (objectId) => world.db.runTransaction(async (tx) => (await prepareStorageFinalize(tx, { tenant: A, objectId })).commit({ FieldValue }));
    await expect(finalize(old.objectId)).rejects.toMatchObject({ code: "storage-limit-reached" });
    expect(storageDoc()).toMatchObject({ bytes: 0, reservedBytes: 100, objects: 0 });
    await releaseStorageReservation({ db: world.db, tenant: A, FieldValue, objectId: other.objectId });
    await finalize(old.objectId);
    expect(storageDoc()).toMatchObject({ bytes: 100, reservedBytes: 0, objects: 1 });
    expect(ledger().find((l) => l.id === old.objectId).state).toBe("stored");
  });

  it("storage warnings: 80% once per episode; repeated uploads above 80% don't re-notify; deleting below 70% re-arms", async () => {
    await override("storageBytes", PNG.length * 5);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(docAt(`businesses/biz-a/payments/${(await pay()).paymentId}`).proof.objectId); // 80%
    expect(usageNotes(world.uids.ownera)).toEqual(["storageBytes-e1-80"]);
    await deleteStoredFile({ db: world.db, tenant: A, FieldValue, bucket: world.bucket, objectId: ids[0] }); // 60%
    await pay(); // 80% again: a new episode
    expect(usageNotes(world.uids.ownera)).toEqual(["storageBytes-e1-80", "storageBytes-e2-80"]);
    await pay(); // 100%
    await expect(pay()).rejects.toMatchObject({ code: "storage-limit-reached" });
    expect(usageNotes(world.uids.ownera)).toEqual(["storageBytes-e1-100", "storageBytes-e1-80", "storageBytes-e2-80"]);
  });
});

describe("activity counters (meter only)", () => {
  it("payments recorded count even when voided later; exports count files and rows", async () => {
    const pid = await product();
    const o = await order(pid);
    const p = await recordPayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, orderId: o.orderId, input: { amount: 10, method: "cash" }, actor, canVerify: true, now: NOW });
    await voidPayment({ db: world.db, tenant: A, FieldValue, business: BIZ, paymentId: p.paymentId, reason: "mistake", actor });
    expect(usage().paymentsRecorded).toBe(1);
  });
});

describe("operator: per-business limit overrides (separate from module overrides)", () => {
  it("set -> effective changes, revision + audit (own type and summary); module overrides untouched; Default removes it", async () => {
    const before = docAt("businesses/biz-a").adminRevision ?? 0;
    const r = await opCall({ action: "setLimitOverride", businessId: "biz-a", limitKey: "ordersPerMonth", value: 2500, reason: "Seasonal peak", expectedRevision: before });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ limits: { ordersPerMonth: 2500 }, overrides: { ordersPerMonth: 2500 }, adminRevision: before + 1 });
    const b = docAt("businesses/biz-a");
    expect(b.limitOverrides).toEqual({ ordersPerMonth: 2500 });
    expect(b.moduleOverrides).toEqual({});
    const [a] = platformAudit("entitlements.limit-override-updated");
    expect(a).toMatchObject({ businessId: "biz-a", actor: "ops@luna.test", reason: "Seasonal peak", summary: "Orders per month override: plan default → 2,500" });
    const d = await opCall({ action: "setLimitOverride", businessId: "biz-a", limitKey: "ordersPerMonth", value: null, reason: "Back to plan", expectedRevision: before + 1 });
    expect(d.body.limits.ordersPerMonth).toBe(2000);
    expect(docAt("businesses/biz-a").limitOverrides).toEqual({});
  });

  it("refused: unknown limit (magicLimit), negative / fractional / huge values, a typed object, a stale revision, a non-operator", async () => {
    const rev = docAt("businesses/biz-a").adminRevision ?? 0;
    for (const body of [{ limitKey: "magicLimit", value: 999999 }, { limitKey: "ordersPerMonth", value: -1 }, { limitKey: "ordersPerMonth", value: 1.5 }, { limitKey: "ordersPerMonth", value: 1e12 }, { limitKey: "ordersPerMonth", value: "2000" }, { limitKey: "ordersPerMonth" }]) {
      const r = await opCall({ action: "setLimitOverride", businessId: "biz-a", reason: "x y z", expectedRevision: rev, ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await opCall({ action: "setLimitOverride", businessId: "biz-a", limitKey: "ordersPerMonth", value: 10, reason: "x y z", entitlements: { limits: {} } })).status).toBe(400);
    expect((await opCall({ action: "setLimitOverride", businessId: "biz-a", limitKey: "ordersPerMonth", value: 10, reason: "x y z", expectedRevision: rev + 7 })).status).toBe(409);
    expect((await opCall({ action: "setLimitOverride", businessId: "biz-a", limitKey: "ordersPerMonth", value: 10, reason: "x y z" }, world.uids.ownera)).status).toBe(403);
    expect(docAt("businesses/biz-a").limitOverrides).toEqual({});
    expect(platformAudit("entitlements.limit-override-updated")).toHaveLength(0);
  });

  it("two operators from the same page: one wins, the other is told it's stale (no lost update)", async () => {
    const rev = docAt("businesses/biz-a").adminRevision ?? 0;
    const a = await opCall({ action: "setLimitOverride", businessId: "biz-a", limitKey: "importsPerMonth", value: 10, reason: "op one", expectedRevision: rev });
    const b = await opCall({ action: "setLimitOverride", businessId: "biz-a", limitKey: "importsPerMonth", value: 20, reason: "op two", expectedRevision: rev });
    expect([a.status, b.status]).toEqual([200, 409]);
    expect(docAt("businesses/biz-a").limitOverrides).toEqual({ importsPerMonth: 10 });
  });

  it("users lowered below the active count: nobody is deactivated; adding stays blocked; a warning is returned", async () => {
    const r = await opCall({ action: "setLimitOverride", businessId: "biz-a", limitKey: "users", value: 2, reason: "test", expectedRevision: docAt("businesses/biz-a").adminRevision ?? 0 });
    expect(r.body.warnings.join(" ")).toMatch(/4 active users exceed the new limit of 2/);
    expect([...world.db.docs.entries()].filter(([p, d]) => p.startsWith("businesses/biz-a/members/") && p.split("/").length === 4 && d.status === "active")).toHaveLength(4);
    await expect(addMember({ ...world, businessId: "biz-a", uid: "u-new", email: "new@t.test", name: "New", roleTemplate: "staff" })).rejects.toMatchObject({ code: "user-limit-reached" });
  });

  it("business detail: Plan | Override | Effective | Current per limit, informational meters, storage, 12-month history (no fabricated months)", async () => {
    const pid = await product();
    await order(pid);
    await override("ordersPerMonth", 1000);
    world.db.seed("businesses/biz-a/usage/2026-08", { period: "2026-08", ordersCreated: 7 });
    const d = (await opCall({ action: "business", businessId: "biz-a" })).body;
    const orders = d.limitRows.find((l) => l.limitKey === "ordersPerMonth");
    expect(orders).toMatchObject({ plan: 2000, override: 1000, effective: 1000, current: 1, kind: "monthly", percent: 0 });
    expect(d.limitRows.find((l) => l.limitKey === "users")).toMatchObject({ plan: 5, override: null, effective: 5, current: 4, percent: 80 });
    expect(d.limitRows.find((l) => l.limitKey === "storageBytes")).toMatchObject({ kind: "running", current: 0 });
    expect(d.meters.map((m) => m.id)).toEqual(["exportsGenerated", "rowsExported", "paymentsRecorded", "expensesCreated"]);
    expect(d.historyMeters).toContain("ordersCreated");
    expect(d.historyMeters).not.toContain("payrollsReleased");
    expect(d.history).toHaveLength(12);
    const byPeriod = Object.fromEntries(d.history.map((h) => [h.period, h]));
    expect(byPeriod["2026-10"]).toMatchObject({ recorded: true, timezone: "Asia/Manila" });
    expect(byPeriod["2026-10"].values.ordersCreated).toBe(1);
    expect(byPeriod["2026-09"]).toMatchObject({ recorded: false, recordsCreated: null });
    expect(byPeriod["2026-09"].values.ordersCreated).toBeNull();
    expect(byPeriod["2026-08"].values).toMatchObject({ ordersCreated: 7, exportsGenerated: 0, paymentsRecorded: null }); // payments weren't metered before Oct 2026
  });

  it("usage overview: one page of businesses with usage vs effective limits; no global counter", async () => {
    const r = (await opCall({ action: "usageOverview" })).body;
    expect(r.rows.map((x) => x.id)).toEqual(["biz-a", "biz-b", "biz-s", "biz-x"]);
    expect(r.rows[0].limits.find((l) => l.limitKey === "users")).toMatchObject({ current: 4, effective: 5, percent: 80 });
    expect(r.next).toBeNull();
    expect([...world.db.docs.keys()].some((k) => /^(usage|platformUsage|globalUsage)/.test(k))).toBe(false);
    expect((await opCall({ action: "usageOverview" }, world.uids.ownera)).status).toBe(403);
  });
});

describe("tenant read side", () => {
  const getUsage = async (uid, businessId = "biz-a") => {
    const res = await createUsageHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId }) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  it("GET /api/usage: Owners (billing.view) only; 12 months newest first; 'no recorded usage' stays null", async () => {
    const pid = await product();
    await order(pid);
    const r = await getUsage(world.uids.ownera);
    expect(r.status).toBe(200);
    expect(r.body.history[0]).toMatchObject({ period: "2026-10", recorded: true });
    expect(r.body.history[1]).toMatchObject({ period: "2026-09", recorded: false });
    expect(r.body.current).toMatchObject({ ordersCreated: 1, activeUsers: 4, storageBytes: 0 });
    for (const who of ["managera", "staffa"]) expect((await getUsage(world.uids[who])).status, who).toBe(403);
  });

  it("session: the usage block carries every meter's value; storage is the current total", async () => {
    await recordPayment({ db: world.db, bucket: world.bucket, tenant: A, FieldValue, business: BIZ, orderId: (await order(await product())).orderId, input: { amount: 1, method: "gcash", reference: "SESS0001" }, proof: proof(), actor, canVerify: true, now: NOW });
    const res = await createSessionHandler({ getAdmin: async () => world })({ ...request({ uid: world.uids.ownera, businessId: "biz-a" }), httpMethod: "GET" });
    const u = JSON.parse(res.body).usage;
    expect(u.values).toMatchObject({ storageBytes: PNG.length, activeUsers: 4 });
    expect(u).toMatchObject({ storageBytes: PNG.length, users: 4 });
  });
});

describe("recount / repair: targeted, dry run first, audited, never lowers consumed quota", () => {
  const dry = (counter, period = "2026-10") => computeRecount({ db: world.db, bucket: world.bucket, businessId: "biz-a", counter, period, now: NOW });
  const apply = (counter, expectedCurrent, period = "2026-10") => applyRecount({ ...world, businessId: "biz-a", counter, period, actor: "ops", reason: "drift repair", expectedCurrent, now: NOW });

  it("orders: a missed count is raised from the source records (including deleted orders); applying is audited once", async () => {
    const pid = await product();
    const a = await order(pid);
    await order(pid);
    await deleteOrder({ db: world.db, tenant: A, FieldValue, orderId: a.orderId, actor });
    world.db.seed("businesses/biz-a/usage/2026-10", { ...usage(), ordersCreated: 1 }); // drift
    const r = await dry("ordersCreated");
    expect(r).toMatchObject({ current: 1, expected: 2, action: "set", details: { orders: 1, deletedOrders: 1 } });
    expect(usage().ordersCreated).toBe(1); // dry run wrote nothing
    await expect(applyRecount({ ...world, businessId: "biz-a", counter: "ordersCreated", period: "2026-10", actor: "ops", reason: "", expectedCurrent: 1 })).rejects.toMatchObject({ code: "reason-required" });
    expect(usage().ordersCreated).toBe(1);
    await apply("ordersCreated", 1);
    expect(usage().ordersCreated).toBe(2);
    expect(platformAudit("usage.recounted")).toHaveLength(1);
    expect(platformAudit("usage.recounted")[0]).toMatchObject({ businessId: "biz-a", counter: "ordersCreated", period: "2026-10", before: { value: 1 }, after: { value: 2 }, reason: "drift repair" });
  });

  it("orders / imports are never lowered (quota consumed stays consumed): report only", async () => {
    world.db.seed("businesses/biz-a/usage/2026-10", { period: "2026-10", ordersCreated: 9, excelImports: 4 });
    for (const c of ["ordersCreated", "excelImports"]) {
      const r = await dry(c);
      expect(r.action).toBe("report-only");
      await expect(apply(c, r.current)).rejects.toMatchObject({ code: "never-lower" });
    }
    expect(usage()).toMatchObject({ ordersCreated: 9, excelImports: 4 });
    expect(platformAudit("usage.recounted")).toHaveLength(0);
  });

  it("refuses when the counter changed after the dry run; unknown counters can't be recounted", async () => {
    const pid = await product();
    await order(pid);
    world.db.seed("businesses/biz-a/usage/2026-10", { period: "2026-10", ordersCreated: 0 });
    const r = await dry("ordersCreated");
    await order(pid);
    await expect(apply("ordersCreated", r.current)).rejects.toMatchObject({ code: "changed-meanwhile" });
    await expect(dry("paymentsRecorded")).rejects.toMatchObject({ code: "not-recountable" });
    await expect(dry("ordersCreated", "2026-13")).rejects.toMatchObject({ code: "invalid-period" });
  });

  it("storage first measurement: existing objects (stored before Phase 18) are found in the bucket and recorded", async () => {
    await world.storage.file("tenants/biz-a/payments/proofs/o-old/p-old-1.png").save(Buffer.alloc(300));
    await world.storage.file("tenants/biz-a/payments/proofs/o-old/p-old-2.png").save(Buffer.alloc(200));
    await world.storage.file("tenants/biz-b/payments/proofs/o/p.png").save(Buffer.alloc(999)); // another business
    const r = await computeRecount({ db: world.db, bucket: world.bucket, businessId: "biz-a", counter: "storageBytes", now: NOW });
    expect(r).toMatchObject({ current: 0, measured: false, expected: 500, action: "set" });
    expect(r.note).toMatch(/never measured/);
    await applyRecount({ ...world, businessId: "biz-a", counter: "storageBytes", actor: "ops", reason: "first measurement", expectedCurrent: 0, now: NOW });
    expect(storageDoc()).toMatchObject({ bytes: 500, objects: 2, reservedBytes: 0 });
    expect(ledger().every((l) => l.state === "stored" && l.source === "recount")).toBe(true);
    expect((await computeRecount({ db: world.db, bucket: world.bucket, businessId: "biz-a", counter: "storageBytes", now: NOW })).action).toBe("none");
    // a later upload is limited against the measured total
    await override("storageBytes", 510);
    await expect(reserveStorage({ db: world.db, tenant: A, FieldValue, path: "tenants/biz-a/payments/proofs/o/n.png", bytes: 20, area: "payments", now: NOW })).rejects.toMatchObject({ code: "storage-limit-reached" });
  });

  it("exports recount from the export audit entries (meter-only: may go either way)", async () => {
    world.db.seed("businesses/biz-a/auditLog/e1", { type: "export.generated", rowCount: 10, at: new Date("2026-10-05T02:00:00Z") });
    world.db.seed("businesses/biz-a/auditLog/e2", { type: "export.generated", rowCount: 5, at: new Date("2026-09-30T17:00:00Z") }); // Oct 1, 01:00 Manila
    world.db.seed("businesses/biz-a/usage/2026-10", { period: "2026-10", exportsGenerated: 7, rowsExported: 1 });
    expect(await dry("exportsGenerated")).toMatchObject({ current: 7, expected: 2, action: "set" });
    expect(await dry("rowsExported")).toMatchObject({ current: 1, expected: 15 });
    await apply("exportsGenerated", 7);
    expect(usage().exportsGenerated).toBe(2);
  });
});
