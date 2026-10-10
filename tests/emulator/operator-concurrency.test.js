// Phase 17 operator concurrency on the REAL Firestore emulator (Admin SDK,
// with a fake Auth for account lookups). After every race:
//   - exactly one business, one owner membership, one "business.created"
//     audit per business id;
//   - the entitlement snapshot is valid for the stored plan + overrides;
//   - a revision-checked change never silently overwrites another
//     (one wins, the other is told it's stale).

import { beforeAll, describe, it, expect, vi } from "vitest";
import { validateEntitlementsSnapshot, computeEntitlements } from "../../shared/entitlements.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

let db, admin, prov, FakeAuth;
let run = 0;
beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  ({ FakeAuth } = await import("../helpers/fake-firebase.js"));
  await prov.seedPlans({ db, admin, overwrite: true });
});

const CONTENDED = 10;
const settledOk = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}
const newId = () => `op-${Date.now().toString(36)}-${++run}`;
const request = (businessId, extra = {}) => ({ businessId, name: `Op Test ${businessId}`, workspaceTemplateId: "distributor", planId: "growth", ownerEmail: `owner-${businessId}@op.test`, ownerName: "Owner", timezone: "Asia/Manila", ...extra });
async function state(businessId) {
  const [b, members, audits] = await Promise.all([db.doc(`businesses/${businessId}`).get(), db.collection(`businesses/${businessId}/members`).get(), db.collection("platformAudit").where("businessId", "==", businessId).get()]);
  return { b: b.data(), members: members.docs.map((d) => d.data()), audits: audits.docs.map((d) => d.data()) };
}
async function validSnapshot(businessId) {
  const { b } = await state(businessId);
  expect(validateEntitlementsSnapshot(b.entitlements, b.subscription.planId, b.workspaceTemplateId).ok).toBe(true);
  const plan = (await db.doc(`plans/${b.subscription.planId}`).get()).data();
  expect(b.entitlements.modules).toEqual(computeEntitlements(plan, { modules: b.moduleOverrides, limits: b.limitOverrides, features: b.featureOverrides }, b.workspaceTemplateId).modules);
  return b;
}

describe("business creation idempotency", () => {
  it("the same Create Business 6 times at once (double clicks, retries): one business, one owner membership, one audit", async () => {
    const auth = new FakeAuth();
    const id = newId();
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => prov.provisionBusiness({ db, admin, auth, request: request(id), actor: "ops@luna.test" })));
    expectExplicit(r);
    expect(settledOk(r).length).toBeGreaterThan(0);
    // A retry after the race completes it if every racer was contended.
    await prov.provisionBusiness({ db, admin, auth, request: request(id), actor: "ops@luna.test" });
    const s = await state(id);
    expect(s.members).toHaveLength(1);
    expect(s.members[0]).toMatchObject({ roleTemplate: "owner", isAccountOwner: true });
    expect(s.audits.filter((a) => a.type === "business.created")).toHaveLength(1);
    expect((await db.doc(`provisioning/${id}`).get()).data().status).toBe("complete");
    await validSnapshot(id);
  });

  it("two DIFFERENT businesses racing for the same id: exactly one wins, the other is refused (business-exists)", async () => {
    const auth = new FakeAuth();
    const id = newId();
    const r = await Promise.allSettled([prov.provisionBusiness({ db, admin, auth, request: request(id), actor: "a" }), prov.provisionBusiness({ db, admin, auth, request: request(id, { planId: "pro", ownerEmail: `other-${id}@op.test` }), actor: "b" })]);
    expectExplicit(r, ["business-exists"]);
    const s = await state(id);
    expect(s.members.length).toBeLessThanOrEqual(1);
    expect(r.filter((x) => x.status === "rejected" && x.reason.code === "business-exists").length).toBeGreaterThanOrEqual(1);
  });

  it("the same owner for two new businesses at once: one account, one membership in each", async () => {
    const auth = new FakeAuth();
    const [a, b] = [newId(), newId()];
    const email = `shared-${a}@op.test`;
    const r = await Promise.allSettled([prov.provisionBusiness({ db, admin, auth, request: request(a, { ownerEmail: email }) }), prov.provisionBusiness({ db, admin, auth, request: request(b, { ownerEmail: email }) })]);
    expectExplicit(r);
    for (const id of [a, b]) await prov.provisionBusiness({ db, admin, auth, request: request(id, { ownerEmail: email }) });
    const [sa, sb] = [await state(a), await state(b)];
    expect(sa.members).toHaveLength(1);
    expect(sb.members).toHaveLength(1);
    expect(sa.members[0].uid).toBe(sb.members[0].uid);
  });
});

describe("plan / override / status changes", () => {
  async function fresh() {
    const id = newId();
    await prov.provisionBusiness({ db, admin, auth: new FakeAuth(), request: request(id) });
    return id;
  }

  it("two operators changing the plan from the same revision: one wins, the other is stale; snapshot valid", async () => {
    const id = await fresh();
    const r = await Promise.allSettled([prov.assignPlan({ db, admin, businessId: id, planId: "starter", actor: "a", reason: "Downgrade", expectedRevision: 0 }), prov.assignPlan({ db, admin, businessId: id, planId: "pro", actor: "b", reason: "Upgrade", expectedRevision: 0 })]);
    expectExplicit(r, ["stale"]);
    expect(settledOk(r)).toHaveLength(1);
    const b = await validSnapshot(id);
    expect(b.adminRevision).toBe(1);
  });

  it("a plan change racing an override change (no revision): both land, in some order; snapshot = plan + overrides", async () => {
    const id = await fresh();
    const r = await Promise.allSettled([prov.assignPlan({ db, admin, businessId: id, planId: "starter", actor: "a", reason: "Downgrade" }), prov.updateOverrides({ db, admin, businessId: id, set: { modules: { imports: false } }, actor: "b", reason: "Pause imports" })]);
    expectExplicit(r);
    const b = await validSnapshot(id);
    if (settledOk(r).length === 2) {
      expect(b.subscription.planId).toBe("starter");
      expect(b.entitlements.modules.imports).toBe(false);
    }
  });

  it("two operators changing the same module override from the same revision: no lost update", async () => {
    const id = await fresh();
    const r = await Promise.allSettled([prov.updateOverrides({ db, admin, businessId: id, set: { modules: { imports: false } }, actor: "a", reason: "Pause", expectedRevision: 0 }), prov.updateOverrides({ db, admin, businessId: id, set: { modules: { reports: false } }, actor: "b", reason: "Hide", expectedRevision: 0 })]);
    expectExplicit(r, ["stale"]);
    expect(settledOk(r)).toHaveLength(1);
    const b = await validSnapshot(id);
    expect(Object.keys(b.moduleOverrides)).toHaveLength(1);
  });

  it("a plan change while the business is being suspended: both apply, status kept, snapshot valid, both audited", async () => {
    const id = await fresh();
    const r = await Promise.allSettled([prov.setSubscriptionStatus({ db, admin, businessId: id, status: "suspended", actor: "a", reason: "Unpaid" }), prov.assignPlan({ db, admin, businessId: id, planId: "pro", actor: "b", reason: "Upgrade" })]);
    expectExplicit(r);
    const b = await validSnapshot(id);
    const { audits } = await state(id);
    if (settledOk(r).length === 2) {
      expect(b.subscription).toMatchObject({ status: "suspended", planId: "pro" });
      expect(audits.map((a) => a.type)).toEqual(expect.arrayContaining(["subscription.status-changed", "entitlements.plan-assigned"]));
    }
  });
});
