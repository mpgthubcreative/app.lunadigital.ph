// Custom workspace links on real Firestore transactions (2026-10-26): many
// workspaces claiming one name at once → exactly one owner, a correct name
// count; one workspace racing renames → every older name points to its
// final name; the Bridal add-on bill made twice at once → one bill.
import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });
const D = "lunadigitalsystem.com";
let db, admin, FieldValue, cl, prov, billing;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  FieldValue = admin.firestore.FieldValue;
  cl = await import("../../netlify/functions/_lib/custom-links.js");
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  billing = await import("../../netlify/functions/_lib/billing.js");
  await prov.seedPlans({ db, admin, overwrite: true });
});

async function business(planId = "household-basic", workspaceTemplateId = "household-payroll") {
  run += 1;
  const id = `cl-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `CL ${run}`, planId, workspaceTemplateId, businessId: id });
  return id;
}

describe("one name, many claims at once", () => {
  it("8 workspaces claim the same name: exactly one gets it; the others are told it's taken", async () => {
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await business());
    const name = `race-${Date.now().toString(36)}`;
    const before = (await db.doc("publicLinkStats/summary").get()).data()?.names ?? 0;
    const r = await Promise.allSettled(ids.map((businessId) => cl.claimCustomLink({ db, FieldValue, businessId, input: name, domain: D })));
    const won = r.filter((x) => x.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const x of r.filter((y) => y.status === "rejected")) expect(["link-taken", 10]).toContain(x.reason.code); // 10 = contended, a retry says taken
    const reg = (await db.doc(`publicLinks/${name}`).get()).data();
    expect(ids).toContain(reg.businessId);
    expect((await db.doc("publicLinkStats/summary").get()).data().names).toBe(before + 1);
  });
  it("one workspace racing renames: one current name; every older one points to it", async () => {
    const id = await business();
    const base = `ren-${Date.now().toString(36)}`;
    await cl.claimCustomLink({ db, FieldValue, businessId: id, input: `${base}-a`, domain: D });
    await Promise.allSettled([`${base}-b`, `${base}-c`].map((n) => cl.claimCustomLink({ db, FieldValue, businessId: id, input: n, domain: D })));
    const docs = (await db.collection("publicLinks").where("businessId", "==", id).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    const current = docs.filter((d) => d.kind === "current");
    expect(current).toHaveLength(1);
    expect((await db.doc(`businesses/${id}`).get()).data().customLink.label).toBe(current[0].id);
    for (const d of docs.filter((x) => x.kind === "previous")) expect(d.current).toBe(current[0].id);
  });
});

describe("Bridal Premium wedding link bill", () => {
  it("bought twice at once: one ₱499 bill, nothing unlocked, no income", async () => {
    const id = await business("bridal-basic", "bridal-expense");
    const r = await Promise.allSettled([1, 2, 3].map(() => billing.createAddOnBill({ db, FieldValue, businessId: id, addOnId: "premium-link" })));
    const ok = r.filter((x) => x.status === "fulfilled").map((x) => x.value.invoiceId);
    expect(new Set(ok).size).toBe(1);
    const bills = (await db.collection("subscriptionInvoices").where("businessId", "==", id).where("kind", "==", "addon").get()).docs;
    expect(bills).toHaveLength(1);
    expect(bills[0].data()).toMatchObject({ amountDue: 49900, status: "due" });
    expect((await db.doc(`businesses/${id}`).get()).data().subscription.addOnsPaid ?? []).toEqual([]);
  });
});
