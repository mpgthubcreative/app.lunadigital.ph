// Phase 12: Distributor imports on the server. Preview statuses and
// duplicate detection, commit = exactly the previewed rows (once, however
// many times / concurrently it's called), resumable batches, plan limit,
// expiry / cancel, commit-time duplicates, permissions, tenant and
// workspace isolation, and payload limits.

import { describe, it, expect, beforeEach } from "vitest";
import { previewImport, commitImport, cancelImport } from "../../netlify/functions/_lib/imports.js";
import { createProduct } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer, setCustomerStatus } from "../../netlify/functions/_lib/customers.js";
import { createImportsHandler } from "../../netlify/functions/imports.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { createBusiness, addMember, ensureAuthUser, updateOverrides } from "../../netlify/functions/_lib/provisioning.js";
import { autoMap, mapRows, convertRow, IMPORT_MAX_ROWS } from "../../shared/imports.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";

const actor = { uid: "u-carlo", name: "Carlo", email: "c@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila" };
const NOW = new Date("2026-10-08T06:00:00Z");
let world;
let A;

beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});

const docAt = (p) => world.db.docs.get(p);
const all = (prefix) => [...world.db.docs.entries()].filter(([p]) => p.startsWith(prefix) && p.split("/").length === prefix.split("/").length).map(([, d]) => d);
const products = () => all("businesses/biz-a/products/");
const customers = () => all("businesses/biz-a/customers/");
const common = () => ({ db: world.db, tenant: A, FieldValue, actor, now: NOW });
const ent = () => docAt("businesses/biz-a").entitlements;
const prow = (n, sku, extra = {}) => ({ n, values: { sku, name: `Item ${sku}`, unit: "pcs", sellingPrice: "100.00", ...extra } });
const crow = (n, name, phone = "", extra = {}) => ({ n, values: { name, ...(phone ? { phone } : {}), ...extra } });
const preview = (type, rows, fileName = `${type}.xlsx`) => previewImport({ ...common(), type, fileName, rows });
const commit = (jobId, opts = {}) => commitImport({ ...common(), business: BIZ, entitlements: ent(), jobId, ...opts });
async function commitAll(jobId, opts = {}) {
  for (let i = 0; i < 100; i++) {
    const r = await commit(jobId, opts);
    if (r.done) return r;
  }
  throw new Error("never finished");
}

describe("mapping helpers", () => {
  it("guesses columns from common header names and maps rows (blank rows dropped)", () => {
    const headers = ["Item Code", "Description", "UOM", "SRP", "Group"];
    const m = autoMap("products", headers);
    expect(m).toEqual({ sku: 0, name: 1, category: 4, unit: 2, sellingPrice: 3, reorderLevel: null });
    expect(mapRows("products", [["A1", "Wings", "pcs", "10", "Frozen"], ["", "", "", "", ""]], m)).toEqual([{ n: 2, values: { sku: "A1", name: "Wings", category: "Frozen", unit: "pcs", sellingPrice: "10" } }]);
  });
  it("converts with the same validators as the screens", () => {
    expect(convertRow("products", { sku: "a-1", name: "W", unit: "KG", sellingPrice: "PHP 1,250.5", reorderLevel: "2.5" }).input).toMatchObject({ sku: "A-1", unit: "kg", sellingPrice: 125050, reorderLevel: 2500 });
    expect(convertRow("products", { sku: "a 1", name: "W", unit: "pcs", sellingPrice: "1" }).errors[0]).toMatch(/SKU/);
    expect(convertRow("products", { sku: "A", name: "W", unit: "pcs", sellingPrice: "-5" }).errors[0]).toMatch(/Selling price/);
    expect(convertRow("customers", { name: "X", email: "bad" }).errors[0]).toMatch(/email/);
    expect(convertRow("customers", { name: "X", stats: "1" }).errors[0]).toMatch(/Unknown field/);
  });
});

describe("preview: Ready / Warning / Error", () => {
  it("products: errors, in-file duplicates, existing SKUs skipped; nothing written to products", async () => {
    await createProduct({ ...common(), input: { sku: "OLD-1", name: "Old", unit: "pcs", sellingPrice: 100, reorderLevel: 0 } });
    const p = await preview("products", [prow(2, "NEW-1"), prow(3, "BAD SKU"), prow(4, "NEW-1"), prow(5, "old-1"), prow(6, "NEW-2", { unit: "bags" })]);
    expect(p.rows).toEqual([
      { n: 2, status: "ready", action: "create", messages: [] },
      { n: 3, status: "error", action: "none", messages: [expect.stringMatching(/SKU/)] },
      { n: 4, status: "error", action: "none", messages: ["SKU NEW-1 is also on row 2 of this file"] },
      { n: 5, status: "warning", action: "skip", messages: [expect.stringMatching(/OLD-1 already exists in Luna — skipped/)] },
      { n: 6, status: "error", action: "none", messages: [expect.stringMatching(/Unit "bags"/)] },
    ]);
    expect(p.counts).toEqual({ total: 5, ready: 1, warning: 1, error: 3, warningToCreate: 0, toSkip: 1 });
    expect(products()).toHaveLength(1); // preview writes nothing to products
    expect(docAt(`businesses/biz-a/imports/${p.jobId}`)).toMatchObject({ status: "previewed", type: "products", fileName: "products.xlsx" });
  });

  it("customers: exact existing match skipped, same phone / same name flagged, in-file duplicates", async () => {
    await createCustomer({ ...common(), input: { name: "ABC Store", phone: "0917 123 4567" } });
    await createCustomer({ ...common(), input: { name: "XYZ Mart" } });
    const p = await preview("customers", [
      crow(2, "ABC Store", "+63 917 123 4567"), // exact existing -> skip
      crow(3, "ABC Branch", "0917-123-4567"), // same phone -> warning, importable
      crow(4, "xyz mart", "0920 333 4444"), // same name, different phone -> warning
      crow(5, "New Shop", "0918 000 0000"),
      crow(6, "New Shop", "0918 000 0000"), // same as row 5 -> skip
      crow(7, ""), // missing name -> error
    ]);
    expect(p.rows.map((r) => [r.n, r.status, r.action])).toEqual([[2, "warning", "skip"], [3, "warning", "create"], [4, "warning", "create"], [5, "ready", "create"], [6, "warning", "skip"], [7, "error", "none"]]);
    expect(p.rows[1].messages.join(" · ")).toMatch(/Same phone as existing customer ABC Store/);
    expect(p.rows[2].messages[0]).toMatch(/A customer named XYZ Mart already exists/);
    // Same name and both without a phone = the same customer: skipped.
    expect((await preview("customers", [crow(2, "xyz MART")])).rows[0]).toMatchObject({ status: "warning", action: "skip" });
    expect(p.counts).toMatchObject({ ready: 1, warning: 4, error: 1, warningToCreate: 2, toSkip: 2 });
  });

  it("limits and strict rows: >2,000 rows, unknown fields, non-text values, bad file names", async () => {
    await expect(preview("products", Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => prow(i + 2, `S${i}`)))).rejects.toMatchObject({ code: "too-many-rows" });
    expect((await preview("products", [{ n: 2, values: { sku: "A", name: "B", unit: "pcs", sellingPrice: "1", onHand: "999" } }])).rows[0].status).toBe("error");
    expect((await preview("products", [{ n: 2, values: { sku: "A", name: "B", unit: "pcs", sellingPrice: 1 } }])).rows[0].status).toBe("error");
    await expect(preview("products", [prow(2, "A")], "../../etc/passwd")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(preview("products", [])).rejects.toMatchObject({ code: "empty" });
  });
});

describe("commit", () => {
  it("creates exactly the Ready rows (warnings only when asked), then completes with an audit entry", async () => {
    await createCustomer({ ...common(), input: { name: "ABC Store", phone: "0917 123 4567" } });
    const p = await preview("customers", [crow(2, "ABC Store", "0917 123 4567"), crow(3, "ABC Branch", "09171234567"), crow(4, "New Shop", "0918 000 0000"), crow(5, "")]);
    const r = await commitAll(p.jobId);
    expect(r.result).toEqual({ created: 1, skipped: 1, failed: 0, notImported: 2 });
    expect(customers().map((c) => c.name).sort()).toEqual(["ABC Store", "New Shop"]);
    expect(docAt(`businesses/biz-a/imports/${p.jobId}`)).toMatchObject({ status: "completed", includeWarnings: false, result: r.result });
    expect(all("businesses/biz-a/auditLog/").find((a) => a.type === "import.completed")).toMatchObject({ importId: p.jobId, importType: "customers", result: r.result });
    // A second preview with warnings included imports the flagged row too.
    const p2 = await preview("customers", [crow(2, "ABC Branch", "09171234567")]);
    expect((await commitAll(p2.jobId, { includeWarnings: true })).result).toMatchObject({ created: 1 });
  });

  it("idempotent: calling commit again, or twice at once, never creates a row twice", async () => {
    const p = await preview("products", [prow(2, "A1"), prow(3, "A2"), prow(4, "A3")]);
    const [x, y] = await Promise.all([commitAll(p.jobId), commitAll(p.jobId)]);
    expect(products()).toHaveLength(3);
    expect(x.result ?? y.result).toMatchObject({ created: 3 });
    expect(await commit(p.jobId)).toMatchObject({ done: true, status: "completed" });
    expect(products()).toHaveLength(3);
  });

  it("resumable in time-boxed batches (Netlify's request limit)", async () => {
    const p = await preview("products", Array.from({ length: 7 }, (_, i) => prow(i + 2, `B${i}`)));
    const first = await commit(p.jobId, { budgetMs: -1 });
    expect(first).toMatchObject({ done: false, processed: 0, remaining: 7 });
    expect(products()).toHaveLength(0);
    const r = await commitAll(p.jobId);
    expect(r.result.created).toBe(7);
  });

  it("a duplicate created between preview and commit is skipped, not doubled", async () => {
    const p = await preview("products", [prow(2, "RACE-1"), prow(3, "RACE-2")]);
    await createProduct({ ...common(), input: { sku: "RACE-1", name: "Someone else's", unit: "pcs", sellingPrice: 1, reorderLevel: 0 } });
    const c = await preview("customers", [crow(2, "Late Shop", "0919 111 2222")]);
    await createCustomer({ ...common(), input: { name: "Late Shop", phone: "0919 111 2222" } });
    expect((await commitAll(p.jobId)).result).toEqual({ created: 1, skipped: 1, failed: 0, notImported: 0 });
    expect(products().filter((x) => x.sku === "RACE-1")).toHaveLength(1);
    expect((await commitAll(c.jobId)).result).toMatchObject({ created: 0, skipped: 1 });
    expect(customers().filter((x) => x.name === "Late Shop")).toHaveLength(1);
  });

  it("existing records are never changed by an import", async () => {
    const { customerId } = await createCustomer({ ...common(), input: { name: "Keep Me", phone: "0917 555 0000", email: "keep@x.ph" } });
    await setCustomerStatus({ ...common(), customerId, status: "inactive" });
    const p = await preview("customers", [crow(2, "Keep Me", "0917 555 0000", { email: "changed@x.ph" })]);
    await commitAll(p.jobId);
    expect(docAt(`businesses/biz-a/customers/${customerId}`)).toMatchObject({ email: "keep@x.ph", status: "inactive", revision: 2 });
  });

  it("plan limit: importsPerMonth counted once per committed job; previews and cancels don't count", async () => {
    // biz-b is on Starter: 1 import per month.
    const B = tenantDb(world.db, "biz-b");
    const pb = (rows) => previewImport({ db: world.db, tenant: B, FieldValue, actor, now: NOW, type: "products", fileName: "b.csv", rows });
    const cb = (jobId) => commitImport({ db: world.db, tenant: B, FieldValue, business: { id: "biz-b", timezone: "Asia/Manila" }, entitlements: docAt("businesses/biz-b").entitlements, jobId, actor, now: NOW });
    const cancelled = await pb([prow(2, "C0")]);
    await cancelImport({ db: world.db, tenant: B, FieldValue, jobId: cancelled.jobId, actor });
    const one = await pb([prow(2, "C1")]);
    const two = await pb([prow(2, "C2")]);
    await cb(one.jobId);
    await cb(one.jobId); // resume / repeat: not counted again
    expect(docAt("businesses/biz-b/usage/2026-10").excelImports).toBe(1);
    await expect(cb(two.jobId)).rejects.toMatchObject({ code: "import-limit-reached" });
    expect(docAt(`businesses/biz-b/imports/${two.jobId}`).status).toBe("previewed");
  });

  it("previews older than 24 hours expire; cancelled imports can't be committed", async () => {
    const p = await preview("products", [prow(2, "E1")]);
    await expect(commitImport({ ...common(), business: BIZ, entitlements: ent(), jobId: p.jobId, now: new Date(NOW.getTime() + 25 * 3600 * 1000) })).rejects.toMatchObject({ code: "expired" });
    const q = await preview("products", [prow(2, "E2")]);
    await cancelImport({ ...common(), jobId: q.jobId });
    await expect(commit(q.jobId)).rejects.toMatchObject({ code: "cancelled" });
    await expect(cancelImport({ ...common(), jobId: q.jobId })).rejects.toMatchObject({ code: "not-cancellable" });
    expect(products()).toHaveLength(0);
  });
});

describe("POST /api/imports", () => {
  const call = async (uid, body, businessId) => {
    const res = await createImportsHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const pv = (type = "products", rows = [prow(2, "API-1")]) => ({ action: "preview", type, fileName: "f.csv", rows });

  it("401 first; staff (no imports.run) 403; manager previews and commits", async () => {
    expect((await createImportsHandler({ getAdmin: async () => world })({ ...request({ method: "POST" }), body: "{x" })).statusCode).toBe(401);
    expect((await call(world.uids.staffa, pv())).status).toBe(403);
    const p = await call(world.uids.managera, pv());
    expect(p).toMatchObject({ status: 201, body: { counts: { ready: 1 } } });
    expect((await call(world.uids.managera, { action: "commit", jobId: p.body.jobId })).body).toMatchObject({ done: true, result: { created: 1 } });
  });

  it("the target module + manage permission are required too", async () => {
    const u = await ensureAuthUser({ auth: world.auth, email: "imp@t.test", name: "Importer" });
    await addMember({ ...world, businessId: "biz-a", uid: u.uid, email: u.email, name: "Importer", roleTemplate: "manager", permissionOverrides: { revoke: ["products.manage"] } });
    expect((await call(u.uid, pv("products"))).body.error).toBe("not-allowed");
    expect((await call(u.uid, pv("customers", [crow(2, "OK Shop")]))).status).toBe(201);
    // A job previewed by someone allowed can't be committed by someone who isn't.
    const p = await call(world.uids.managera, pv());
    expect((await call(u.uid, { action: "commit", jobId: p.body.jobId })).body.error).toBe("not-allowed");
    await updateOverrides({ ...world, businessId: "biz-a", set: { modules: { customers: false } }, actor: "t", reason: "customers off" });
    expect((await call(world.uids.ownera, pv("customers", [crow(2, "X")]))).body.error).toBe("not-allowed");
  });

  it("strict payloads", async () => {
    expect((await call(world.uids.ownera, { ...pv(), extra: 1 })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "preview", type: "orders", fileName: "o.csv", rows: [] })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "commit", jobId: "../x" })).status).toBe(400);
    expect((await call(world.uids.ownera, { action: "commit", jobId: "abcdefgh12345678", includeWarnings: "yes" })).status).toBe(400);
  });

  it("cross-tenant: B's import can't be committed, cancelled or seen from A", async () => {
    const B = tenantDb(world.db, "biz-b");
    const pb = await previewImport({ db: world.db, tenant: B, FieldValue, actor, now: NOW, type: "products", fileName: "b.csv", rows: [prow(2, "BX")] });
    for (const uid of [world.uids.ownera, world.uids.managera]) {
      expect((await call(uid, { action: "commit", jobId: pb.jobId })).status).toBe(404);
      expect((await call(uid, { action: "cancel", jobId: pb.jobId })).status).toBe(404);
      expect((await call(uid, pv(), "biz-b")).body.error).toBe("business-access-denied");
    }
    expect(docAt(`businesses/biz-b/imports/${pb.jobId}`).status).toBe("previewed");
  });

  it("a bridal workspace has no Imports, even with a forged snapshot", async () => {
    await createBusiness({ ...world, name: "Wedding", planId: "pro", workspaceTemplateId: "bridal-expense", businessId: "biz-w" });
    const u = await ensureAuthUser({ auth: world.auth, email: "bride3@t.test", name: "Bride" });
    await addMember({ ...world, businessId: "biz-w", uid: u.uid, email: u.email, name: "Bride", roleTemplate: "owner", isAccountOwner: true });
    expect((await call(u.uid, pv(), "biz-w")).status).toBe(403);
    docAt("businesses/biz-w").entitlements.modules.imports = true;
    expect((await call(u.uid, pv(), "biz-w")).status).toBe(503);
  });

  it("suspended businesses can't import (write)", async () => {
    expect((await call(world.uids.owners, pv(), "biz-s")).body.error).toBe("read-only");
  });
});
