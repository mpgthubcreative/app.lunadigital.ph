// Super Admin consolidation (2026-10-19): the usage meter (Excel downloads
// and bytes), two plans per workspace with users / storage limits, paid
// seats (a kasambahay login and wedding guests never use one), billing by
// workspace (monthly / annual / 12-month access, no fake MRR), the short
// Overview + Action Center, subscription actions, member removal and a
// recoverable business delete, and plan pricing edited in Super Admin.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createWorkbookHandler } from "../../netlify/functions/workbook.js";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { ensureAuthUser, setOperator, createBusiness, addMember } from "../../netlify/functions/_lib/provisioning.js";
import { lunaOverview } from "../../netlify/functions/_lib/platform.js";
import { recordOperatorPayment, billFor } from "../../netlify/functions/_lib/billing.js";
import { readCurrentUsage } from "../../netlify/functions/_lib/metering.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { PLAN_SEED, isCatalogPlan, planWorkspace } from "../../shared/plans.seed.js";
import { planBilling, priceLabel, subscriptionTerms, attentionOf, accessState, newSubscriptionTerms, UNLIMITED } from "../../shared/plan-billing.js";
import { limitRows } from "../../shared/metering.js";
import { SUBSCRIPTION_ACTIONS, businessIdFromName } from "../../shared/operators.js";
import { accessPolicy } from "../../shared/subscription.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const OCT19 = new Date("2026-10-19T04:00:00Z"); // Oct 19, 12:00 Manila
let world, opUid;

beforeEach(async () => {
  world = await buildWorld();
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "Ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  opUid = op.uid;
});

const FV = () => world.admin.firestore.FieldValue;
const biz = (id) => world.db.docs.get(`businesses/${id}`);
const op = async (body, uid = opUid) => {
  const res = await createOperatorHandler({ getAdmin: async () => world })({ ...request({ uid }), httpMethod: "POST", body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const ok = (r) => {
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body;
};
async function owned(businessId, planId, workspaceTemplateId, { clock = OCT19, founding = false, name = businessId } = {}) {
  await createBusiness({ ...world, name, planId, workspaceTemplateId, businessId, clock, founding });
  const o = await ensureAuthUser({ auth: world.auth, email: `owner@${businessId}.test`, name: `Owner ${businessId}` });
  await addMember({ ...world, businessId, uid: o.uid, email: o.email, name: `Owner ${businessId}`, roleTemplate: "owner", isAccountOwner: true });
  return o.uid;
}

describe("plans: two per workspace, users and storage limits, billing by workspace", () => {
  it("the sold catalog; Starter / Growth / Pro are legacy (hidden, still valid)", () => {
    const sold = Object.values(PLAN_SEED).filter(isCatalogPlan);
    const by = (w) => sold.filter((p) => planWorkspace(p) === w).map((p) => [p.name, priceLabel(p), p.limits.users, p.limits.storageBytes]);
    expect(by("distributor")).toEqual([["Distributor", "₱499 / month + ₱999 setup", 2, 500 * MB], ["Distributor+", "₱899 / month + ₱999 setup", 4, 1 * GB]]);
    expect(by("household-payroll")).toEqual([["Luna Household", "₱1,190 / year", 1, 500 * MB], ["Luna Household+", "₱1,990 / year", 3, 1 * GB]]);
    expect(by("bridal-expense")).toEqual([["Luna Bridal", "₱1,490 / 12 months", 1, 500 * MB], ["Luna Bridal+", "Starting at ₱3,990 / 12 months", 3, 1 * GB]]);
    expect(["starter", "growth", "pro"].map((id) => PLAN_SEED[id].legacy)).toEqual([true, true, true]);
    // Billing types and founding prices are data, not code.
    expect(["distributor-basic", "household-basic", "bridal-basic"].map((id) => planBilling(PLAN_SEED[id]).type)).toEqual(["monthly", "annual", "term"]);
    expect(planBilling(PLAN_SEED["bridal-plus"])).toMatchObject({ autoRenew: false, termMonths: 12, founding: { price: 299000 } });
    expect(planBilling(PLAN_SEED["distributor-basic"]).founding).toMatchObject({ price: 39900, months: 12 });
    // No order limit for now; imports aren't shown anywhere.
    expect(PLAN_SEED["distributor-plus"].limits.ordersPerMonth).toBe(UNLIMITED);
    const rows = limitRows({ entitlements: { limits: PLAN_SEED["distributor-basic"].limits }, usage: { ordersCreated: 532 } });
    expect(rows.map((r) => r.limitKey)).toEqual(["users", "ordersPerMonth", "storageBytes"]);
    expect(rows.find((r) => r.limitKey === "ordersPerMonth")).toMatchObject({ unlimited: true, atOrOver: false, percent: null });
    // Recurring income only for monthly plans (never a yearly or 12-month price).
    expect(PLAN_SEED["household-plus"].pricing.monthly).toBe(0);
    expect(PLAN_SEED["bridal-basic"].pricing.monthly).toBe(0);
  });
});

describe("usage: Excel downloads and transfer", () => {
  it("every Download Excel counts once with its bytes, keeps a download record, and Super Admin sees it", async () => {
    const download = () => createWorkbookHandler({ getAdmin: async () => world, now: () => OCT19 })({ ...request({ uid: world.uids.ownera, businessId: "biz-a", method: "POST" }), body: JSON.stringify({ range: "month" }) });
    const r1 = await download();
    const r2 = await download();
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    const bytes = Buffer.from(r1.body, "base64").length + Buffer.from(r2.body, "base64").length;
    const usage = world.db.docs.get("businesses/biz-a/usage/2026-10");
    expect(usage).toMatchObject({ exportsGenerated: 2, exportBytes: bytes });
    const records = [...world.db.docs.entries()].filter(([k, v]) => k.startsWith("businesses/biz-a/auditLog/") && v.type === "export.generated").map(([, v]) => v);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ businessId: "biz-a", workspaceTemplateId: "distributor", dataset: "workbook" });
    expect(records[0].bytes).toBeGreaterThan(1000);
    expect(records[0].at).toBeTruthy();
    // Super Admin: the business page and the Usage page read the same server values.
    const d = ok(await op({ action: "business", businessId: "biz-a" }));
    expect(d.current).toMatchObject({ downloads: 2, transferBytes: bytes });
    const u = ok(await op({ action: "usageOverview" })).rows.find((x) => x.id === "biz-a");
    expect(u.usage).toMatchObject({ downloads: 2, transferBytes: bytes });
    // Imports are not launched: no import usage anywhere in Super Admin.
    expect(JSON.stringify(d.limitRows)).not.toMatch(/importsPerMonth|Spreadsheet imports/);
    expect(d.meters.map((m) => m.id)).not.toContain("excelImports");
    expect(d.historyMeters).not.toContain("excelImports");
  });
});

describe("seats: a kasambahay login and wedding guests never use a paid seat", () => {
  it("Luna Household (1 paid user): the owner plus a kasambahay login fit; a second family member doesn't", async () => {
    const owner = await owned("home-1", "household-basic", "household-payroll");
    const staff = await createHouseholdStaffHandler({ getAdmin: async () => world, now: () => OCT19 })({ ...request({ uid: owner, businessId: "home-1", method: "POST" }), body: JSON.stringify({ action: "create", staff: { name: "Loriza Ibanez", dailyWage: 60000, payCycle: "semi_monthly" } }) });
    const staffId = JSON.parse(staff.body).staffId;
    const login = await createHouseholdStaffHandler({ getAdmin: async () => world, now: () => OCT19 })({ ...request({ uid: owner, businessId: "home-1", method: "POST" }), body: JSON.stringify({ action: "createLogin", staffId }) });
    expect(login.statusCode, login.body).toBe(201);
    const current = await readCurrentUsage(tenantDb(world.db, "home-1"), "Asia/Manila", OCT19);
    expect(current.values.activeUsers).toBe(1);
    const spouse = await ensureAuthUser({ auth: world.auth, email: "spouse@home1.test", name: "Spouse" });
    await expect(addMember({ ...world, businessId: "home-1", uid: spouse.uid, email: spouse.email, name: "Spouse", roleTemplate: "manager" })).rejects.toMatchObject({ code: "user-limit-reached" });
  });

  it("Luna Bridal (1 planning user): guests aren't users", async () => {
    const owner = await owned("wed-1", "bridal-basic", "bridal-expense");
    for (const name of ["Santos Family", "Reyes Family", "Cruz Family"]) {
      const r = await createGuestsHandler({ getAdmin: async () => world, now: () => OCT19 })({ ...request({ uid: owner, businessId: "wed-1", method: "POST" }), body: JSON.stringify({ action: "create", guest: { name, side: "bride", partySize: 4 } }) });
      expect(r.statusCode, r.body).toBe(201);
    }
    expect((await readCurrentUsage(tenantDb(world.db, "wed-1"), "Asia/Manila", OCT19)).values.activeUsers).toBe(1);
  });
});

describe("billing by workspace", () => {
  it("Distributor: monthly from the start date; Record payment covers a month; overdue shows its days", async () => {
    await owned("dist-1", "distributor-basic", "distributor", { clock: new Date("2026-09-12T04:00:00Z") });
    expect(biz("dist-1").subscription).toMatchObject({ billingType: "monthly", amount: 49900, setupFee: 99900, startDate: "2026-09-12", monthlyAmount: 49900 });
    let t = subscriptionTerms(biz("dist-1").subscription);
    expect(attentionOf(t, { today: "2026-10-19" })).toMatchObject({ kind: "overdue", date: "2026-09-12", days: 37, label: "37 days overdue", what: "Due" });
    expect(billFor(biz("dist-1"), "2026-10")).toMatchObject({ dueDate: "2026-10-12", amountDue: 49900, coverFrom: "2026-10-12", coverTo: "2026-11-11" });
    const paid = await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "dist-1", input: { amount: 49900, paymentDate: "2026-10-18", reference: "Cash" }, operator: "ops@luna.test", now: OCT19 });
    expect(paid).toMatchObject({ status: "paid", paidThrough: "2026-10-11" });
    t = subscriptionTerms(biz("dist-1").subscription);
    expect(t.dueDate).toBe("2026-10-12");
    expect(attentionOf(t, { today: "2026-10-19" })).toMatchObject({ kind: "overdue", days: 7, label: "7 days overdue" });
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "dist-1", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    t = subscriptionTerms(biz("dist-1").subscription);
    expect([t.paidThrough, t.dueDate]).toEqual(["2026-11-11", "2026-11-12"]);
    expect(attentionOf(t, { today: "2026-10-19" })).toBeNull();
    expect(attentionOf(t, { today: "2026-11-06" })).toMatchObject({ kind: "due", label: "Due soon" });
    expect(world.db.docs.get("platformMetrics/2026-10").revenueByBillingType).toMatchObject({ monthly: 99800 });
  });

  it("founding price: the Distributor founding price for its first 12 months", () => {
    const t = newSubscriptionTerms(PLAN_SEED["distributor-basic"], "2026-10-19", { founding: true });
    expect(t).toMatchObject({ amount: 49900, monthlyAmount: 39900, founding: { price: 39900, until: "2027-10-19" } });
  });

  it("Household: annual access, first payment at the start, then 'Renewal due' a year later", async () => {
    await owned("home-2", "household-plus", "household-payroll");
    expect(biz("home-2").subscription).toMatchObject({ billingType: "annual", amount: 199000, startDate: "2026-10-19", monthlyAmount: 0, autoRenew: true });
    expect(attentionOf(subscriptionTerms(biz("home-2").subscription), { today: "2026-10-19" })).toMatchObject({ kind: "due", what: "Payment due", label: "Due today" });
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "home-2", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    const t = subscriptionTerms(biz("home-2").subscription);
    expect(t).toMatchObject({ paidThrough: "2027-10-18", dueDate: "2027-10-19", renewal: true });
    expect(attentionOf(t, { today: "2026-10-19" })).toBeNull();
    expect(attentionOf(t, { today: "2027-10-01" })).toMatchObject({ kind: "due", what: "Renewal due", date: "2027-10-19" });
    expect(world.db.docs.get("platformMetrics/2026-10").revenueByBillingType).toMatchObject({ annual: 199000 });
  });

  it("Bridal: 12-month access bought once, no renewal; Expiring soon / Expired / Extended, never Past Due", async () => {
    await owned("wed-2", "bridal-plus", "bridal-expense");
    expect(biz("wed-2").subscription).toMatchObject({ billingType: "term", amount: 399000, autoRenew: false, startDate: "2026-10-19", accessUntil: "2027-10-18", monthlyAmount: 0 });
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "wed-2", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    let t = subscriptionTerms(biz("wed-2").subscription);
    expect(t).toMatchObject({ dueDate: null, accessUntil: "2027-10-18" });
    expect(attentionOf(t, { today: "2027-09-25" })).toMatchObject({ kind: "expiring", label: "Expiring soon", what: "Access ends" });
    expect(attentionOf(t, { today: "2027-10-20" })).toMatchObject({ kind: "expired", label: "Expired" });
    expect(accessState(t, { status: "active", today: "2027-10-20" })).toBe("expired");
    // Nothing more is billed after the purchase.
    expect(billFor(biz("wed-2"), "2027-10")).toBeNull();
    ok(await op({ action: "setBillingDate", businessId: "wed-2", date: "2027-12-31", reason: "Wedding moved to December" }));
    t = subscriptionTerms(biz("wed-2").subscription);
    expect(t).toMatchObject({ accessUntil: "2027-12-31", extended: true });
    expect(accessState(t, { status: "active", today: "2027-10-20" })).toBe("extended");
    expect(world.db.docs.get("platformMetrics/2026-10").revenueByBillingType).toMatchObject({ term: 399000 });
  });
});

describe("Overview + Action Center", () => {
  it("active access, recurring income (monthly only), annual / 12-month income, Needs Attention with dates, Income by Workspace; no cost or profit", async () => {
    await owned("dist-2", "distributor-plus", "distributor", { clock: new Date("2026-10-12T04:00:00Z"), name: "ABC Frozen Foods" });
    await owned("home-3", "household-basic", "household-payroll", { name: "Prado Home" });
    await owned("wed-3", "bridal-basic", "bridal-expense", { name: "Carlo & Yanie" });
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "home-3", input: { paymentDate: "2026-10-19" }, operator: "ops", now: OCT19 });
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "wed-3", input: { paymentDate: "2026-10-19" }, operator: "ops", now: OCT19 });
    // A wedding from before billing types: still on its old monthly terms, never recurring income.
    await owned("wed-old", "bridal-plus", "bridal-expense", { name: "Older Wedding" });
    world.db.docs.set("businesses/wed-old", { ...biz("wed-old"), subscription: { planId: "bridal-plus", status: "active", monthlyAmount: 39900, paidThrough: null, nextRenewal: null } });
    const o = await lunaOverview({ db: world.db, FieldValue: FV(), now: OCT19 });
    expect(Object.keys(o)).not.toEqual(expect.arrayContaining(["estimatedGrossProfit"]));
    expect(JSON.stringify(o)).not.toMatch(/GrossProfit|platformCosts|margin/i);
    // Distributor+ ₱899 is recurring; the household and wedding payments aren't monthly income.
    expect(o.recurringIncome).toBe(89900 + 199000 + 99000); // + biz-a growth (₱1,990) and biz-b starter (₱990), legacy monthly
    expect(o.annualIncomeThisMonth).toBe(119000 + 149000);
    const abc = o.needsAttention.find((r) => r.id === "dist-2");
    expect(abc).toMatchObject({ name: "ABC Frozen Foods", planName: "Distributor+", billingType: "monthly", attention: { kind: "overdue", date: "2026-10-12", days: 7, label: "7 days overdue" } });
    expect(o.needsAttention.map((r) => r.id)).not.toContain("home-3");
    expect(o.needsAttention.map((r) => r.id)).not.toContain("wed-3");
    const ws = Object.fromEntries(o.incomeByWorkspace.map((w) => [w.workspaceTemplateId, w]));
    expect(ws["household-payroll"]).toMatchObject({ billingType: "annual", collected: 119000, recurring: null });
    expect(ws["bridal-expense"]).toMatchObject({ billingType: "term", collected: 149000, recurring: null });
    expect(ws.distributor).toMatchObject({ billingType: "monthly" });
  });

  it("subscription actions: clear labels; Send notification reaches the owners; suspend / reactivate / cancel keep the data", async () => {
    expect(SUBSCRIPTION_ACTIONS).toEqual({ past_due: "Mark as past due", suspended: "Suspend access", cancelled: "Cancel subscription", active: "Reactivate subscription" });
    expect([accessPolicy("past_due").canWrite, accessPolicy("suspended").canWrite, accessPolicy("suspended").canRead, accessPolicy("cancelled").exportOnly]).toEqual([true, false, true, true]);
    const owner = await owned("dist-3", "distributor-basic", "distributor");
    const r = ok(await op({ action: "sendReminder", businessId: "dist-3" }));
    expect(r.message).toMatch(/Due 2026-10-19|Payment due 2026-10-19/);
    const inbox = [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/dist-3/members/${owner}/inbox/`));
    expect(inbox.length).toBe(1);
    const orders = world.db.docs.size;
    for (const status of ["suspended", "active", "cancelled", "active"]) ok(await op({ action: "setStatus", businessId: "dist-3", status, reason: "test" }));
    expect(biz("dist-3").subscription.status).toBe("active");
    expect(world.db.docs.size).toBeGreaterThanOrEqual(orders);
  });

  it("Change plan only offers the workspace's plans; the new price applies", async () => {
    await owned("home-4", "household-basic", "household-payroll");
    expect((await op({ action: "changePlan", businessId: "home-4", planId: "distributor-plus", reason: "wrong" })).body.error).toBe("plan-wrong-workspace");
    ok(await op({ action: "changePlan", businessId: "home-4", planId: "household-plus", reason: "upgrade" }));
    expect(biz("home-4").subscription).toMatchObject({ planId: "household-plus", billingType: "annual", amount: 199000, startDate: "2026-10-19" });
    expect(biz("home-4").entitlements.limits).toMatchObject({ users: 3, storageBytes: 1 * GB });
  });
});

describe("members and businesses", () => {
  it("Super Admin removes a member (audited); never the account owner; a non-operator can't", async () => {
    const owner = await owned("home-5", "household-plus", "household-payroll", { name: "Prado Home" });
    const maria = await ensureAuthUser({ auth: world.auth, email: "maria@home5.test", name: "Maria Santos" });
    await addMember({ ...world, businessId: "home-5", uid: maria.uid, email: maria.email, name: "Maria Santos", roleTemplate: "manager" });
    expect((await op({ action: "removeMember", businessId: "home-5", uid: maria.uid }, owner)).status).toBe(403);
    expect((await op({ action: "removeMember", businessId: "home-5", uid: owner })).body.error).toBe("owner-protected");
    ok(await op({ action: "removeMember", businessId: "home-5", uid: maria.uid }));
    expect(world.db.docs.get(`businesses/home-5/members/${maria.uid}`)).toBeUndefined();
    const audit = [...world.db.docs.entries()].find(([k, v]) => k.startsWith("platformAudit/") && v.type === "member.removed")[1];
    expect(audit).toMatchObject({ businessId: "home-5", actor: "ops@luna.test", member: { uid: maria.uid, email: "maria@home5.test" } });
    expect(audit.at).toBeTruthy();
  });

  it("Delete business: typed name, recoverable, access off at once, audited; Restore brings it back", async () => {
    const owner = await owned("dist-4", "distributor-basic", "distributor", { name: "Hayst Kopi" });
    expect((await op({ action: "deleteBusiness", businessId: "dist-4", confirmName: "Hayst" })).body.error).toBe("confirm-mismatch");
    expect(biz("dist-4").subscription.status).toBe("active");
    const r = ok(await op({ action: "deleteBusiness", businessId: "dist-4", confirmName: "Hayst Kopi" }));
    expect(r).toMatchObject({ deleted: true });
    expect(biz("dist-4")).toMatchObject({ subscription: { status: "deleted" }, deletion: { deletedBy: "ops@luna.test", prior: { status: "active", planId: "distributor-basic" } } });
    expect(biz("dist-4").deletion.purgeAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Nothing is erased; the owner can't get in.
    expect(world.db.docs.get(`businesses/dist-4/members/${owner}`)).toBeTruthy();
    const s = await createSessionHandler({ getAdmin: async () => world })({ ...request({ uid: owner, businessId: "dist-4" }), httpMethod: "GET" });
    expect(s.statusCode).toBe(403);
    const audit = [...world.db.docs.entries()].find(([k, v]) => k.startsWith("platformAudit/") && v.type === "business.deleted")[1];
    expect(audit).toMatchObject({ businessId: "dist-4", businessName: "Hayst Kopi", actor: "ops@luna.test", before: { status: "active", planId: "distributor-basic" } });
    // Hidden from the list unless asked for.
    expect(ok(await op({ action: "listBusinesses", filters: {} })).rows.map((x) => x.id)).not.toContain("dist-4");
    expect(ok(await op({ action: "listBusinesses", filters: { status: "deleted" } })).rows.map((x) => x.id)).toContain("dist-4");
    ok(await op({ action: "restoreBusiness", businessId: "dist-4" }));
    expect(biz("dist-4").subscription.status).toBe("active");
    expect(biz("dist-4").deletion).toBeNull();
  });

  it("Create Business: workspace + plan + name; the ID is made from the name", async () => {
    expect(businessIdFromName("Carlo & Yanie’s Wedding")).toBe("carlo-yanies-wedding");
    const r = ok(await op({ action: "createBusiness", business: { workspaceTemplateId: "household-payroll", planId: "household-plus", name: "Prado Home", ownerName: "Mon Prado", ownerEmail: "mon@prado.test", businessId: businessIdFromName("Prado Home"), founding: true } }));
    expect(r.businessId).toBe("prado-home");
    expect(biz("prado-home").subscription).toMatchObject({ billingType: "annual", amount: 199000, founding: { price: 169000 } });
    expect((await op({ action: "createBusiness", business: { workspaceTemplateId: "bridal-expense", planId: "household-basic", name: "X Wedding", ownerName: "X", ownerEmail: "x@x.test", businessId: "x-wedding" } })).body.error).toBe("plan-wrong-workspace");
  });
});

describe("plans are edited in Super Admin", () => {
  it("price, setup fee, duration and limits change for NEW businesses; existing ones keep theirs; audited; validated", async () => {
    await world.db.collection("plans").doc("distributor-basic").set(structuredClone(PLAN_SEED["distributor-basic"]));
    await owned("dist-5", "distributor-basic", "distributor");
    const r = ok(await op({ action: "savePlan", planId: "distributor-basic", changes: { price: 54900, setupFee: 0, users: 3, storageMb: 750 } }));
    expect(r.plan.pricing).toMatchObject({ price: 54900, monthly: 54900, setupFee: 0, billingType: "monthly" });
    expect(r.plan.limits).toMatchObject({ users: 3, storageBytes: 750 * MB, ordersPerMonth: UNLIMITED });
    expect(biz("dist-5").subscription.amount).toBe(49900);
    expect(biz("dist-5").entitlements.limits.users).toBe(2);
    await owned("dist-6", "distributor-basic", "distributor");
    expect(biz("dist-6").subscription.amount).toBe(54900);
    expect(biz("dist-6").entitlements.limits.users).toBe(3);
    expect([...world.db.docs.values()].some((v) => v.type === "plan.changed" && v.planId === "distributor-basic")).toBe(true);
    for (const bad of [{ price: 0 }, { users: 0 }, { billingType: "weekly" }, { termMonths: 99, billingType: "annual" }, { secret: 1 }]) expect((await op({ action: "savePlan", planId: "distributor-basic", changes: bad })).status, JSON.stringify(bad)).toBe(400);
  });
});
