// Imports under concurrency on the REAL Firestore emulator (Admin SDK):
// a job committed by several callers at once creates each row exactly
// once; two jobs racing for the last import of the month start at most
// one; an import racing a manual create of the same SKU never duplicates.

import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const actor = { uid: "conc-imp", name: "Concurrency", email: "" };
const NOW = new Date("2026-10-08T06:00:00Z");
let db, FieldValue, imp, inv, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const admin = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin: { firestore: { FieldValue } } } = await admin.getAdmin());
  imp = await import("../../netlify/functions/_lib/imports.js");
  inv = await import("../../netlify/functions/_lib/inventory.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
});

function world(limit = 100) {
  run += 1;
  const id = `impc-${Date.now().toString(36)}-${run}`;
  return { tenant: tenantDb(db, id), business: { id, timezone: "Asia/Manila" }, entitlements: { limits: { importsPerMonth: limit } } };
}
const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ n: i + 2, values: { sku: `${prefix}-${i}`, name: `Item ${i}`, unit: "pcs", sellingPrice: "10" } }));
const preview = (w, r) => imp.previewImport({ db, tenant: w.tenant, FieldValue, type: "products", fileName: "p.csv", rows: r, actor, now: NOW });
const commit = (w, jobId) => imp.commitImport({ db, tenant: w.tenant, FieldValue, business: w.business, entitlements: w.entitlements, jobId, actor, now: NOW });
async function commitAll(w, jobId) {
  for (let i = 0; i < 50; i++) {
    const r = await commit(w, jobId);
    if (r.done) return r;
  }
  throw new Error("never finished");
}

describe("imports on the real emulator", () => {
  it("4 callers committing the same job at once: every row created exactly once", async () => {
    const w = world();
    const p = await preview(w, rows("X", 25));
    const results = await Promise.allSettled([commitAll(w, p.jobId), commitAll(w, p.jobId), commitAll(w, p.jobId), commitAll(w, p.jobId)]);
    for (const r of results) if (r.status === "rejected") expect(r.reason.code).toBe(10); // contention only
    const products = (await w.tenant.collection("products").get()).docs.map((d) => d.data().sku);
    expect(products.sort()).toEqual(rows("X", 25).map((r) => r.values.sku).sort());
    const job = (await w.tenant.doc("imports", p.jobId).get()).data();
    expect(job.status).toBe("completed");
    expect(job.result).toEqual({ created: 25, skipped: 0, failed: 0, notImported: 0 });
  });

  it("two jobs racing for the month's last import: only one starts", async () => {
    const w = world(1);
    const a = await preview(w, rows("A", 2));
    const b = await preview(w, rows("B", 2));
    const results = await Promise.allSettled([commit(w, a.jobId), commit(w, b.jobId)]);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason.code).toBe("import-limit-reached");
    expect((await w.tenant.doc("usage", "2026-10").get()).data().excelImports).toBe(1);
  });

  it("an import racing a manual create of the same SKU never duplicates it", async () => {
    const w = world();
    const p = await preview(w, rows("R", 3));
    await Promise.allSettled([commitAll(w, p.jobId), inv.createProduct({ db, tenant: w.tenant, FieldValue, actor, input: { sku: "R-1", name: "Manual", unit: "pcs", sellingPrice: 5, reorderLevel: 0 } })]);
    const skus = (await w.tenant.collection("products").get()).docs.map((d) => d.data().sku);
    expect(skus.filter((s) => s === "R-1")).toHaveLength(1);
    expect(skus.sort()).toEqual(["R-0", "R-1", "R-2"]);
    const r = await commitAll(w, p.jobId);
    expect(r.result.created + r.result.skipped).toBe(3);
  });
});
