// Track Inventory (2026-11-01) on the REAL Firestore emulator (Admin SDK):
// many orders at once on an untracked product all go through without
// touching stock; turning tracking ON while orders arrive never leaves stock
// set aside that no order holds (reserved = Σ tracked open lines) and never
// oversells. Every failure is explicit.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { QTY_SCALE } from "../../shared/quantity.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "demo-luna.appspot.com";
vi.setConfig({ testTimeout: 180000 });

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "conc-track", name: "Concurrency", email: "" };
const NOW = new Date("2026-10-15T02:00:00Z");
let db, FieldValue, inv, orders, tenantDb, computeEntitlements, PLAN_SEED;
let run = 0;
let keySeq = 0;
const key = () => `trk-conc-${Date.now().toString(36)}-${++keySeq}`.padEnd(20, "x");
const CONTENDED = 10;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  inv = await import("../../netlify/functions/_lib/inventory.js");
  orders = await import("../../netlify/functions/_lib/orders.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  ({ computeEntitlements, PLAN_SEED } = await import("../../shared/index.js"));
});

async function world() {
  run += 1;
  const id = `trkc-${Date.now().toString(36)}-${run}`;
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila", orderPrefix: "TK" };
  const entitlements = computeEntitlements(PLAN_SEED.growth, {}, "distributor");
  const { productId } = await inv.quickAddProduct({ db, tenant, FieldValue, input: { name: "Nipple Tape", sellingPrice: 25000 }, actor });
  const sale = (qty = 1) => orders.createOrder({ db, tenant, FieldValue, business, entitlements, input: { customer: { name: "Marian" }, source: "phone", items: [{ productId, quantity: Q(qty) }] }, idempotencyKey: key(), actor, canDiscount: false, now: NOW });
  return { tenant, business, productId, sale };
}
const product = async (w) => (await w.tenant.doc("products", w.productId).get()).data();
const openLines = async (w) => (await w.tenant.collection("orders").get()).docs.map((d) => d.data()).filter((o) => o.fulfillmentStatus === "pending").flatMap((o) => o.items);

describe("untracked products under concurrency", () => {
  it("ten orders at once on an untracked product: all recorded, no stock moved", async () => {
    const w = await world();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => w.sale(3)));
    for (const r of results) if (r.status === "rejected") expect(r.reason?.code, String(r.reason?.message)).toBe(CONTENDED);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    expect(okCount).toBeGreaterThan(0);
    const p = await product(w);
    expect(p).toMatchObject({ onHand: 0, reserved: 0, movementCount: 0, orderUses: okCount });
    expect((await openLines(w)).every((l) => l.untracked === true)).toBe(true);
  });

  it("tracking turned ON (stock 5) while orders arrive: reserved = Σ tracked open lines; never oversold", async () => {
    const w = await world();
    const results = await Promise.allSettled([
      w.sale(2),
      w.sale(2),
      inv.setTrackInventory({ db, tenant: w.tenant, FieldValue, productId: w.productId, track: true, stock: Q(5), actor }),
      w.sale(2),
      w.sale(2),
      w.sale(2),
    ]);
    for (const r of results) if (r.status === "rejected") expect([CONTENDED, "insufficient-stock"], String(r.reason?.message)).toContain(r.reason?.code);
    const p = await product(w);
    expect(p.trackInventory).toBe(true);
    const tracked = (await openLines(w)).filter((l) => l.untracked !== true).reduce((t, l) => t + l.quantity, 0);
    expect(p.reserved).toBe(tracked);
    expect(p.onHand).toBe(Q(5));
    expect(p.reserved).toBeLessThanOrEqual(p.onHand);
    expect(p.available).toBe(p.onHand - p.reserved);
  });
});
