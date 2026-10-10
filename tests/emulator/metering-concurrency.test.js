// Phase 18 metering concurrency on the REAL Firestore emulator (Admin SDK).
// After every race: no quota overshoot, no double count, no negative
// storage, no duplicate threshold notification, no lost override update.
// Every outcome must be explicit (success, a domain refusal, or
// contention) and the stored state must match exactly what succeeded.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "conc-meter", name: "Metering", email: "" };
const NOW = new Date("2026-10-08T02:00:00Z");
let db, admin, FieldValue, prov, orders, inv, imp, store, tenantDb;
let run = 0;
let keySeq = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  FieldValue = admin.firestore.FieldValue;
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  orders = await import("../../netlify/functions/_lib/orders.js");
  inv = await import("../../netlify/functions/_lib/inventory.js");
  imp = await import("../../netlify/functions/_lib/imports.js");
  store = await import("../../netlify/functions/_lib/storage-usage.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  await prov.seedPlans({ db, admin, overwrite: true });
});

const CONTENDED = 10;
const settle = (p) => Promise.allSettled(p);
const ok = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}
const key = () => `meter-key-${Date.now().toString(36)}-${++keySeq}`.padEnd(20, "x");

// A real business (plan snapshot) with an Owner, and its limits overridden.
async function business(limits = {}) {
  run += 1;
  const id = `meter-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `Meter ${run}`, planId: "growth", workspaceTemplateId: "distributor", businessId: id });
  await prov.addMember({ db, admin, businessId: id, uid: `owner-${id}`, email: `owner-${run}@meter.test`, name: "Owner", roleTemplate: "owner", isAccountOwner: true });
  for (const [k, v] of Object.entries(limits)) await prov.setLimitOverride({ db, admin, businessId: id, limitKey: k, value: v, actor: "ops", reason: "concurrency test" });
  const tenant = tenantDb(db, id);
  const b = (await tenant.ref.get()).data();
  return { id, tenant, business: { id, name: b.name, timezone: b.timezone, orderPrefix: "MT" }, owner: `owner-${id}` };
}
const entitlementsOf = async (w) => (await w.tenant.ref.get()).data().entitlements;
async function product(w) {
  const { productId } = await inv.createProduct({ db, tenant: w.tenant, FieldValue, actor, input: { sku: `M-${++run}`, name: "Item", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } });
  await inv.recordMovement({ db, tenant: w.tenant, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(1000), unitCost: 50, note: "count" } });
  return productId;
}
const createOrder = async (w, pid) => orders.createOrder({ db, tenant: w.tenant, FieldValue, business: w.business, entitlements: await entitlementsOf(w), input: { customer: { name: "Racer" }, source: "phone", items: [{ productId: pid, quantity: Q(1) }] }, idempotencyKey: key(), actor, canDiscount: false, now: NOW });
const usage = async (w) => (await w.tenant.doc("usage", "2026-10").get()).data() || {};
const storage = async (w) => (await w.tenant.doc("usageCurrent", "storage").get()).data() || {};
const usageNotes = async (w) => (await w.tenant.member(w.owner).collection("inbox").where("type", "==", "usage.threshold").get()).docs.map((d) => d.data().eventKey).sort();
const orderCount = async (w) => (await w.tenant.collection("orders").get()).size;

describe("monthly quotas", () => {
  it("the last two orders at once with one slot left: exactly one is created and counted", async () => {
    const w = await business({ ordersPerMonth: 3 });
    const pid = await product(w);
    await createOrder(w, pid);
    await createOrder(w, pid);
    const r = await settle([createOrder(w, pid), createOrder(w, pid)]);
    expectExplicit(r, ["order-limit-reached"]);
    expect(ok(r)).toHaveLength(1);
    expect((await usage(w)).ordersCreated).toBe(3);
    expect(await orderCount(w)).toBe(3);
  });

  it("the last two imports at once with one slot left: one commits and is counted", async () => {
    const w = await business({ importsPerMonth: 1 });
    const rows = (p) => [{ n: 2, values: { sku: `${p}-1`, name: "Imported", unit: "pcs", sellingPrice: "1" } }];
    const jobs = [];
    for (const p of ["IA", "IB"]) jobs.push((await imp.previewImport({ db, tenant: w.tenant, FieldValue, type: "products", fileName: `${p}.csv`, rows: rows(p), actor, now: NOW })).jobId);
    const ent = await entitlementsOf(w);
    const r = await settle(jobs.map((jobId) => imp.commitImport({ db, tenant: w.tenant, FieldValue, business: w.business, entitlements: ent, jobId, actor, now: NOW })));
    expectExplicit(r, ["import-limit-reached"]);
    expect((await usage(w)).excelImports).toBe(1);
    const started = (await w.tenant.collection("imports").get()).docs.filter((d) => ["committing", "completed"].includes(d.data().status));
    expect(started).toHaveLength(1);
  });

  it("the limit is lowered while orders are being created: never more than the effective limit at each commit", async () => {
    const w = await business({ ordersPerMonth: 3 });
    const pid = await product(w);
    await createOrder(w, pid);
    await createOrder(w, pid);
    const rev = (await w.tenant.ref.get()).data().adminRevision;
    const r = await settle([prov.setLimitOverride({ db, admin, businessId: w.id, limitKey: "ordersPerMonth", value: 2, actor: "ops", reason: "lower", expectedRevision: rev }), createOrder(w, pid), createOrder(w, pid), createOrder(w, pid)]);
    expectExplicit(r, ["order-limit-reached"]);
    const n = (await usage(w)).ordersCreated;
    expect(n).toBeLessThanOrEqual(3);
    expect(await orderCount(w)).toBe(n);
    expect((await w.tenant.ref.get()).data().entitlements.limits.ordersPerMonth).toBe(2);
    await expect(createOrder(w, pid)).rejects.toMatchObject({ code: "order-limit-reached" });
  });

  it("thresholds crossed by concurrent orders notify exactly once each (80% and 100%)", async () => {
    const w = await business({ ordersPerMonth: 5 });
    const pid = await product(w);
    const r = await settle(Array.from({ length: 7 }, () => createOrder(w, pid)));
    expectExplicit(r, ["order-limit-reached"]);
    for (let i = (await usage(w)).ordersCreated; i < 5; i++) await createOrder(w, pid); // top up if some lost to contention
    expect((await usage(w)).ordersCreated).toBe(5);
    expect(await usageNotes(w)).toEqual(["ordersCreated-2026-10-100", "ordersCreated-2026-10-80"]);
    expect((await w.tenant.member(w.owner).collection("inboxState").doc("summary").get()).data().unread).toBe(2);
  });
});

describe("file storage", () => {
  const path = (w, n) => `tenants/${w.id}/payments/proofs/o/${n}.png`;
  const reserve = (w, n, bytes, now = NOW) => store.reserveStorage({ db, tenant: w.tenant, FieldValue, path: path(w, n), bytes, area: "payments", now });
  const finalize = (w, objectId) => db.runTransaction(async (tx) => (await store.prepareStorageFinalize(tx, { tenant: w.tenant, objectId })).commit({ FieldValue }));

  it("two uploads near the limit at once: only one reservation passes", async () => {
    const w = await business({ storageBytes: 150 });
    const r = await settle([reserve(w, "a", 100), reserve(w, "b", 100)]);
    expectExplicit(r, ["storage-limit-reached"]);
    expect(ok(r)).toHaveLength(1);
    expect(await storage(w)).toMatchObject({ bytes: 0, reservedBytes: 100 });
  });

  it("an upload that fails after reserving gives the bytes back (released once even if retried concurrently)", async () => {
    const w = await business({ storageBytes: 1000 });
    const { objectId } = await reserve(w, "f", 400);
    await settle([1, 2, 3].map(() => store.releaseStorageReservation({ db, tenant: w.tenant, FieldValue, objectId })));
    expect(await storage(w)).toMatchObject({ bytes: 0, reservedBytes: 0 });
    expect((await store.storageLedgerRef(w.tenant, objectId).get()).data().state).toBe("released");
  });

  it("a duplicated / retried upload of the same object reserves and finalizes once", async () => {
    const w = await business({ storageBytes: 1000 });
    const r = await settle(Array.from({ length: 5 }, () => reserve(w, "dup", 300)));
    expectExplicit(r);
    expect(ok(r).length).toBeGreaterThan(0);
    expect((await storage(w)).reservedBytes).toBe(300);
    const objectId = ok(r)[0].value.objectId;
    await settle(Array.from({ length: 4 }, () => finalize(w, objectId)));
    expect(await storage(w)).toMatchObject({ bytes: 300, reservedBytes: 0, objects: 1 });
  });

  it("a delete racing another upload's finalize: both apply exactly once; never negative", async () => {
    const w = await business({ storageBytes: 1000 });
    const a = await reserve(w, "old", 200);
    await finalize(w, a.objectId);
    const b = await reserve(w, "new", 300);
    const r = await settle([store.deleteStoredFile({ db, tenant: w.tenant, FieldValue, bucket: async () => ({ file: () => ({ delete: async () => {} }) }), objectId: a.objectId }), finalize(w, b.objectId), store.deleteStoredFile({ db, tenant: w.tenant, FieldValue, bucket: async () => ({ file: () => ({ delete: async () => {} }) }), objectId: a.objectId })]);
    expectExplicit(r);
    expect(await storage(w)).toMatchObject({ bytes: 300, reservedBytes: 0, objects: 1 });
  });
});

describe("operator limit overrides", () => {
  it("two operators change the same limit from the same page: one wins, the other is told it's stale", async () => {
    const w = await business();
    const rev = (await w.tenant.ref.get()).data().adminRevision;
    const r = await settle([10, 20].map((v) => prov.setLimitOverride({ db, admin, businessId: w.id, limitKey: "importsPerMonth", value: v, actor: `op${v}`, reason: "same page", expectedRevision: rev })));
    expectExplicit(r, ["stale"]);
    expect(ok(r)).toHaveLength(1);
    const b = (await w.tenant.ref.get()).data();
    expect(b.limitOverrides.importsPerMonth).toBe(ok(r)[0].value.overrides.limits.importsPerMonth);
    expect(b.adminRevision).toBe(rev + 1);
    const audits = await db.collection("platformAudit").where("businessId", "==", w.id).get();
    expect(audits.docs.filter((d) => d.data().type === "entitlements.limit-override-updated" && d.data().reason === "same page")).toHaveLength(1);
  });
});
