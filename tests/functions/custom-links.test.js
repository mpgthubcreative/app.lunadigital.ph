// Custom workspace links (2026-10-26), server side: the paid entitlement
// (Bridal: the +₱499 Premium wedding link add-on, unlocked only by a
// confirmed payment), one global name space, the Netlify alias workflow
// (mocked: pending → ready, failure → retry, no duplicate alias), renames
// keep old names as redirects, the public resolver, and the token check
// on a custom address (another workspace's token is refused).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createBusiness, addMember, ensureAuthUser, setSubscriptionStatus } from "../../netlify/functions/_lib/provisioning.js";
import { createCustomLinkHandler } from "../../netlify/functions/custom-link.js";
import { createHostHandler } from "../../netlify/functions/host.js";
import { claimCustomLink, finishCustomLinks } from "../../netlify/functions/_lib/custom-links.js";
import { submitPayment, confirmPayment } from "../../netlify/functions/_lib/billing.js";
import { CUSTOM_LINK_ALIAS_LIMIT } from "../../shared/custom-links.js";

const D = "lunadigitalsystem.com";
const ENV = { VITE_CUSTOM_LINK_DOMAIN: D, SITE_URL: "https://app.lunadigitalsystem.com" };
let world;
let owners;
let staff;
let netlify;
let ready;

function fakeNetlify() {
  const state = { aliases: [], fail: 0, adds: 0 };
  return {
    state,
    configured: true,
    site: async () => ({ primary: `app.${D}`, aliases: [...state.aliases] }),
    addAlias: vi.fn(async (host) => {
      if (state.fail > 0) {
        state.fail -= 1;
        const { NetlifyDomainsError } = await import("../../netlify/functions/_lib/netlify-domains.js");
        throw new NetlifyDomainsError("netlify-refused", "Netlify answered 500");
      }
      if (state.aliases.includes(host)) return { added: false, count: state.aliases.length };
      state.adds += 1;
      state.aliases.push(host);
      return { added: true, count: state.aliases.length };
    }),
    removeAlias: vi.fn(),
    provisionCertificate: vi.fn(async () => {}),
  };
}

async function business(businessId, planId, workspaceTemplateId, { trial = false } = {}) {
  await createBusiness({ ...world, name: businessId, planId, workspaceTemplateId, businessId, ...(trial ? { trial: true, clock: new Date() } : {}) });
  const o = await ensureAuthUser({ auth: world.auth, email: `owner@${businessId}.test`, name: "Owner" });
  await addMember({ ...world, businessId, uid: o.uid, email: o.email, name: "Owner", roleTemplate: "owner", isAccountOwner: true });
  owners[businessId] = o.uid;
}

beforeEach(async () => {
  world = await buildWorld();
  owners = {};
  await business("home-a", "household-basic", "household-payroll");
  await business("dist-b", "distributor-basic", "distributor");
  await business("wed-c", "bridal-basic", "bridal-expense");
  await business("home-t", "household-basic", "household-payroll", { trial: true });
  const s = await ensureAuthUser({ auth: world.auth, email: "staff@dist-b.test", name: "Staff" });
  await addMember({ ...world, businessId: "dist-b", uid: s.uid, email: s.email, name: "Staff", roleTemplate: "staff" });
  staff = s.uid;
  netlify = fakeNetlify();
  ready = new Set();
});

const handler = () => createCustomLinkHandler({ getAdmin: async () => world, env: ENV, domains: () => netlify, httpsReady: async (h) => ready.has(h) });
async function link(businessId, body, uid = owners[businessId]) {
  const res = await handler()({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function host(name) {
  const res = await createHostHandler({ getAdmin: async () => world, env: ENV })({ httpMethod: "POST", headers: {}, body: JSON.stringify({ name }) });
  return JSON.parse(res.body).host;
}
const doc = (p) => world.db.docs.get(p);

describe("paid entitlement", () => {
  it("a free trial sees the feature locked and can't check, claim or reserve a name", async () => {
    const g = await link("home-t", { action: "get" });
    expect(g.body.customLink).toMatchObject({ available: true, allowed: false, domain: D, lockedMessage: "Custom workspace links are available on paid plans." });
    for (const action of ["check", "claim"]) expect((await link("home-t", { action, name: "pradohousehold" })).status).toBe(403);
    expect(doc("publicLinks/pradohousehold")).toBeUndefined();
    expect(netlify.addAlias).not.toHaveBeenCalled();
  });
  it("paid Household / Distributor: included; suspended can't change it; staff can't manage it", async () => {
    expect((await link("home-a", { action: "get" })).body.customLink).toMatchObject({ allowed: true, addOn: null });
    expect((await link("dist-b", { action: "claim", name: "abcfrozenfoods" }, staff)).status).toBe(403);
    await setSubscriptionStatus({ ...world, businessId: "home-a", status: "suspended", actor: "test", reason: "testing suspension" });
    expect((await link("home-a", { action: "claim", name: "pradohousehold" })).status).toBe(403);
  });
});

describe("one global name space", () => {
  it("unique across workspace types; reserved and invalid names refused; input normalized", async () => {
    const a = await link("home-a", { action: "claim", name: "  Prado Household " });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.customLink.link).toMatchObject({ label: "prado-household", host: `prado-household.${D}` });
    const b = await link("dist-b", { action: "check", name: "prado-household" });
    expect(b.body).toMatchObject({ available: false, reason: "That link is already taken. Try another." });
    expect((await link("dist-b", { action: "claim", name: "prado-household" })).body.error).toBe("link-taken");
    for (const name of ["app", "admin", "www", "netlify"]) expect((await link("dist-b", { action: "claim", name })).body.error).toBe("invalid-link");
    for (const name of ["-abc", "a b!", "x"]) expect((await link("dist-b", { action: "claim", name })).body.error).toBe("invalid-link");
  });
  it("two workspaces claiming the same name at once: exactly one gets it", async () => {
    const out = await Promise.allSettled([claimCustomLink({ ...world, FieldValue: world.admin.firestore.FieldValue, businessId: "home-a", input: "samename", domain: D }), claimCustomLink({ ...world, FieldValue: world.admin.firestore.FieldValue, businessId: "dist-b", input: "samename", domain: D })]);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(out.find((r) => r.status === "rejected").reason.code).toBe("link-taken");
    expect(doc("publicLinkStats/summary").names).toBe(1);
  });
  it("stops new names at the site's address limit (the trigger for the wildcard plan)", async () => {
    world.db.docs.set("publicLinkStats/summary", { names: CUSTOM_LINK_ALIAS_LIMIT });
    expect((await link("home-a", { action: "claim", name: "pradohousehold" })).body.error).toBe("capacity");
  });
});

describe("Netlify alias workflow (mocked)", () => {
  it("claim → alias added once → pending until HTTPS answers → ready; never reported ready early", async () => {
    const r = await link("home-a", { action: "claim", name: "pradohousehold" });
    expect(r.body.customLink.link.setup).toBe("pending");
    expect(netlify.state.aliases).toEqual([`pradohousehold.${D}`]);
    expect(netlify.provisionCertificate).toHaveBeenCalled();
    ready.add(`pradohousehold.${D}`);
    const again = await link("home-a", { action: "retry" });
    expect(again.body.customLink.link.setup).toBe("active");
    expect(netlify.state.adds).toBe(1); // the retry didn't add it twice
    expect(doc("businesses/home-a").customLink).toMatchObject({ label: "pradohousehold", setup: "active" });
  });
  it("Netlify failure: the name stays held as pending (not released, not active); a retry finishes it", async () => {
    netlify.state.fail = 1;
    const r = await link("home-a", { action: "claim", name: "pradohousehold" });
    expect(r.status).toBe(200);
    expect(r.body.customLink.link.setup).toBe("pending");
    expect(doc("publicLinks/pradohousehold")).toMatchObject({ businessId: "home-a", setup: "pending", setupError: "netlify-refused" });
    expect((await link("dist-b", { action: "claim", name: "pradohousehold" })).body.error).toBe("link-taken");
    ready.add(`pradohousehold.${D}`);
    expect((await link("home-a", { action: "retry" })).body.customLink.link.setup).toBe("active");
  });
  it("without Netlify configured: pending with a plain note, nothing called", async () => {
    const r = await createCustomLinkHandler({ getAdmin: async () => world, env: ENV, domains: () => null })({ ...request({ uid: owners["home-a"], businessId: "home-a", method: "POST" }), body: JSON.stringify({ action: "claim", name: "pradohousehold" }) });
    expect(JSON.parse(r.body).customLink.link).toMatchObject({ setup: "pending", note: "Luna is finishing your link. It will be ready soon." });
  });
});

describe("renames keep old links", () => {
  it("the old name stays held and redirects to the new one (path and token kept by the page); 3 changes at most", async () => {
    ready.add(`carloandyanie.${D}`).add(`carloyaniewedding.${D}`);
    await link("home-a", { action: "claim", name: "carloandyanie" });
    const r = await link("home-a", { action: "claim", name: "carloyaniewedding" });
    expect(r.body.customLink.link).toMatchObject({ label: "carloyaniewedding", setup: "active", previous: ["carloandyanie"] });
    expect(doc("publicLinks/carloandyanie")).toMatchObject({ kind: "previous", current: "carloyaniewedding", businessId: "home-a" });
    expect(await host("carloandyanie")).toEqual({ status: "moved", host: `carloyaniewedding.${D}` });
    expect((await link("dist-b", { action: "claim", name: "carloandyanie" })).body.error).toBe("link-taken");
    for (const n of ["third-name", "fourth-name"]) await link("home-a", { action: "claim", name: n });
    expect((await link("home-a", { action: "claim", name: "fifth-name" })).body.error).toBe("too-many-changes");
  });
});

describe("Bridal: the Premium wedding link is a +₱499 add-on", () => {
  const FV = () => world.admin.firestore.FieldValue;
  it("paid Bridal without the add-on: offered, not claimable; buying makes a ₱499 bill that unlocks nothing and counts as no income until Luna confirms the payment", async () => {
    const g = (await link("wed-c", { action: "get" })).body.customLink;
    expect(g).toMatchObject({ allowed: false, paidPlan: true, addOn: { id: "premium-link", price: 49900, status: "none" } });
    expect((await link("wed-c", { action: "claim", name: "carloyaniewedding" })).body.error).toBe("add-on-required");
    const bought = (await link("wed-c", { action: "buy" })).body.customLink;
    expect(bought.addOn).toMatchObject({ status: "billed" });
    const inv = doc(`subscriptionInvoices/${bought.addOn.invoiceId}`);
    expect(inv).toMatchObject({ kind: "addon", amountDue: 49900, status: "due", lines: [{ kind: "addon", addOnId: "premium-link", amount: 49900 }] });
    const metrics = () => doc(`platformMetrics/${inv.period}`) || {};
    expect(metrics().verifiedRevenue ?? 0).toBe(0);
    // Buying twice: the same bill.
    expect((await link("wed-c", { action: "buy" })).body.customLink.addOn.invoiceId).toBe(bought.addOn.invoiceId);
    expect((await link("wed-c", { action: "claim", name: "carloyaniewedding" })).body.error).toBe("add-on-required");
    // The Owner pays; still locked while Luna checks it.
    const today = new Date().toISOString().slice(0, 10);
    const sent = await submitPayment({ ...world, FieldValue: FV(), businessId: "wed-c", actor: { uid: owners["wed-c"], email: "o@x" }, input: { period: inv.period, invoiceId: bought.addOn.invoiceId, amount: 49900, paymentDate: today, reference: "BDO-123" }, proof: null, idempotencyKey: "addon-pay-key-0001" });
    expect((await link("wed-c", { action: "get" })).body.customLink.addOn.status).toBe("waiting");
    const accessBefore = doc("businesses/wed-c").subscription.accessUntil;
    await confirmPayment({ ...world, FieldValue: FV(), paymentId: sent.paymentId, operator: "ops@luna.test" });
    const sub = doc("businesses/wed-c").subscription;
    expect(sub.addOnsPaid).toEqual(["premium-link"]);
    expect(sub.accessUntil).toBe(accessBefore); // access dates don't move
    expect(metrics().revenueByBillingType).toMatchObject({ addon: 49900 });
    expect(metrics().revenueByBillingType.term ?? 0).toBe(0); // never counted as access income
    ready.add(`carloyaniewedding.${D}`);
    const c = await link("wed-c", { action: "claim", name: "carloyaniewedding" });
    expect(c.body.customLink).toMatchObject({ allowed: true, link: { label: "carloyaniewedding", setup: "active" }, addOn: { status: "paid" } });
  });
  it("a trial wedding can't buy the add-on", async () => {
    await business("wed-t", "bridal-basic", "bridal-expense", { trial: true });
    expect((await link("wed-t", { action: "buy" })).status).toBe(403);
  });
});

describe("the public address", () => {
  beforeEach(async () => {
    for (const [b, n] of [["home-a", "pradohousehold"], ["dist-b", "abcfrozenfoods"]]) {
      ready.add(`${n}.${D}`);
      await link(b, { action: "claim", name: n });
    }
  });
  it("resolves only its own workspace; unknown names are 'not found' (no fallback, nothing leaked)", async () => {
    expect(await host("pradohousehold")).toEqual({ status: "live", workspace: "household-payroll", name: "home-a", storeSlug: null, appOrigin: "https://app.lunadigitalsystem.com" });
    expect(await host("abcfrozenfoods")).toMatchObject({ status: "live", workspace: "distributor" });
    for (const n of ["nobody-here", "app", "www", "../x", ""]) expect(await host(n)).toEqual({ status: "not-found" });
  });
  it("suspended: held and unavailable; cancelled: held and retired (never another tenant)", async () => {
    await setSubscriptionStatus({ ...world, businessId: "home-a", status: "suspended", actor: "test", reason: "testing suspension" });
    expect(await host("pradohousehold")).toEqual({ status: "unavailable" });
    await setSubscriptionStatus({ ...world, businessId: "home-a", status: "cancelled", actor: "test", reason: "testing cancel" });
    expect(await host("pradohousehold")).toEqual({ status: "retired" });
    expect(doc("businesses/home-a").subscription.statusChangedAt).toBeTruthy(); // the 90-day hold counts from here
    expect((await link("dist-b", { action: "claim", name: "pradohousehold" })).body.error).toBe("link-taken");
  });
  it("finishing again is harmless (already ready: nothing sent)", async () => {
    const before = netlify.state.adds;
    await finishCustomLinks({ ...world, FieldValue: world.admin.firestore.FieldValue, businessId: "home-a", domain: D, domains: netlify, httpsReady: async () => true });
    expect(netlify.state.adds).toBe(before);
  });
});
