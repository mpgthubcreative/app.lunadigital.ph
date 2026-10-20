// Super Admin consolidation (2026-10-19) and the final pricing model
// (2026-10-20: one product per workspace, terms, add-ons): the usage meter
// (Excel downloads and bytes), users / storage limits, paid
// seats (a kasambahay login and wedding guests never use one), billing by
// workspace (monthly / annual / 12-month access, no fake MRR), the short
// Overview + Action Center, subscription actions, member removal and a
// recoverable business delete, and plan pricing edited in Super Admin.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request, roomForTeam } from "../helpers/tenants.js";
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
import { planBilling, priceLabel, termLabel, subscriptionTerms, attentionOf, accessState, newSubscriptionTerms, UNLIMITED } from "../../shared/plan-billing.js";
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
async function owned(businessId, planId, workspaceTemplateId, { clock = OCT19, termMonths = null, priceOverride = null, name = businessId } = {}) {
  await createBusiness({ ...world, name, planId, workspaceTemplateId, businessId, clock, termMonths, priceOverride });
  const o = await ensureAuthUser({ auth: world.auth, email: `owner@${businessId}.test`, name: `Owner ${businessId}` });
  await addMember({ ...world, businessId, uid: o.uid, email: o.email, name: `Owner ${businessId}`, roleTemplate: "owner", isAccountOwner: true });
  return o.uid;
}

describe("products: one per workspace, terms, add-ons, users and storage limits", () => {
  it("the sold catalog: Luna Household, Distributor, Luna Bridal, Luna Bridal Custom; the + plans and Starter / Growth / Pro are legacy", () => {
    const sold = Object.values(PLAN_SEED).filter(isCatalogPlan);
    const by = (w) => sold.filter((p) => planWorkspace(p) === w).map((p) => [p.name, priceLabel(p), p.limits.users, p.limits.storageBytes]);
    expect(by("distributor")).toEqual([["Distributor", "₱499 / month + ₱999 setup", 2, 500 * MB]]);
    expect(by("household-payroll")).toEqual([["Luna Household", "₱1,190 / 12 months", 1, 500 * MB]]);
    expect(by("bridal-expense")).toEqual([["Luna Bridal", "₱1,490 / 12 months", 1, 500 * MB], ["Luna Bridal Custom", "Starting at ₱2,990 / 12 months", 1, 500 * MB]]);
    expect(["distributor-plus", "household-plus", "starter", "growth", "pro"].map((id) => PLAN_SEED[id].legacy)).toEqual([true, true, true, true, true]);
    // Terms are data on the product, not separate plans.
    const h = PLAN_SEED["household-basic"];
    expect(planBilling(h).terms.map((t) => termLabel(h, t.months))).toEqual(["1 month · ₱149 · Paid trial", "3 months · ₱349 · Paid trial", "12 months · ₱1,190 · Best Value"]);
    expect(planBilling(h).defaultTermMonths).toBe(12);
    const d = PLAN_SEED["distributor-basic"];
    expect(planBilling(d).terms.map((t) => termLabel(d, t.months))).toEqual(["1 month · ₱499 / month", "3 months · ₱1,290 · Prepaid starter"]);
    expect(planBilling(PLAN_SEED["bridal-basic"]).terms.map((t) => t.months)).toEqual([12]);
    expect(planBilling(PLAN_SEED["bridal-plus"])).toMatchObject({ autoRenew: false, priceIsMinimum: true, terms: [{ months: 12, price: 299000 }] });
    // Add-ons: Household per year, Distributor per month; Bridal: Super Admin overrides.
    expect(planBilling(h).addOns.map((a) => [a.id, a.users, a.storageMb, a.price, a.perMonths])).toEqual([["user", 1, 0, 19900, 12], ["storage", 0, 500, 19900, 12]]);
    expect(planBilling(d).addOns.map((a) => [a.id, a.users, a.storageMb, a.price, a.perMonths])).toEqual([["users", 2, 0, 14900, 1], ["storage", 0, 1024, 9900, 1]]);
    expect(planBilling(PLAN_SEED["bridal-plus"]).addOns).toEqual([]);
    expect(PLAN_SEED["household-basic"].tagline).toMatch(/kasambahay/);
    // No order limit for now; imports aren't shown anywhere.
    expect(PLAN_SEED["distributor-basic"].limits.ordersPerMonth).toBe(UNLIMITED);
    const rows = limitRows({ entitlements: { limits: PLAN_SEED["distributor-basic"].limits }, usage: { ordersCreated: 532 } });
    expect(rows.map((r) => r.limitKey)).toEqual(["users", "ordersPerMonth", "storageBytes"]);
    expect(rows.find((r) => r.limitKey === "ordersPerMonth")).toMatchObject({ unlimited: true, atOrOver: false, percent: null });
    // Recurring income only for monthly products (never a prepaid or 12-month price).
    expect(PLAN_SEED["household-basic"].pricing.monthly).toBe(0);
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
    // The first bill carries the one-time setup fee: ₱499 + ₱999 = ₱1,498.
    expect(billFor(biz("dist-1"), "2026-09")).toMatchObject({ dueDate: "2026-09-12", amountDue: 149800, lines: [{ kind: "base", label: "Distributor · Monthly access", amount: 49900 }, { kind: "setup", label: "One-time setup fee", amount: 99900 }] });
    const paid = await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "dist-1", input: { paymentDate: "2026-10-18", reference: "Cash" }, operator: "ops@luna.test", now: OCT19 });
    expect(paid).toMatchObject({ status: "paid", paidThrough: "2026-10-11" });
    // Billed once: tracked, never on a later bill.
    expect(biz("dist-1").subscription.setupFeeBilled).toBe(true);
    expect(billFor(biz("dist-1"), "2026-10")).toMatchObject({ dueDate: "2026-10-12", amountDue: 49900, coverFrom: "2026-10-12", coverTo: "2026-11-11" });
    expect(billFor(biz("dist-1"), "2026-10").lines.map((l) => l.kind)).toEqual(["base"]);
    t = subscriptionTerms(biz("dist-1").subscription);
    expect(t.dueDate).toBe("2026-10-12");
    expect(attentionOf(t, { today: "2026-10-19" })).toMatchObject({ kind: "overdue", days: 7, label: "7 days overdue" });
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "dist-1", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    t = subscriptionTerms(biz("dist-1").subscription);
    expect([t.paidThrough, t.dueDate]).toEqual(["2026-11-11", "2026-11-12"]);
    expect(attentionOf(t, { today: "2026-10-19" })).toBeNull();
    expect(attentionOf(t, { today: "2026-11-06" })).toMatchObject({ kind: "due", label: "Due soon" });
    expect(world.db.docs.get("platformMetrics/2026-10").revenueByBillingType).toMatchObject({ monthly: 149800 + 49900 });
  });

  it("Distributor 3-month prepaid starter: one ₱1,290 bill covering 3 months (no bills in between), then ₱499 monthly; not recurring income until monthly", async () => {
    await owned("dist-pre", "distributor-basic", "distributor", { termMonths: 3 });
    expect(biz("dist-pre").subscription).toMatchObject({ billingType: "monthly", amount: 49900, prepaidTerm: { months: 3, price: 129000 }, startDate: "2026-10-19", monthlyAmount: 49900 });
    // 3-month access ₱1,290 + one-time setup fee ₱999 = ₱2,289.
    expect(billFor(biz("dist-pre"), "2026-10")).toMatchObject({ dueDate: "2026-10-19", amountDue: 228900, months: 3, prepaid: true, coverTo: "2027-01-18" });
    expect(billFor(biz("dist-pre"), "2026-11")).toBeNull();
    expect(billFor(biz("dist-pre"), "2026-12")).toBeNull();
    const paid = await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "dist-pre", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    expect(paid).toMatchObject({ status: "paid", paidThrough: "2027-01-18" });
    expect(biz("dist-pre").subscription.prepaidTerm).toBeNull();
    const t = subscriptionTerms(biz("dist-pre").subscription);
    expect([t.dueDate, t.amount, t.prepaidNext]).toEqual(["2027-01-19", 49900, false]);
    expect(billFor(biz("dist-pre"), "2026-12")).toBeNull();
    expect(billFor(biz("dist-pre"), "2027-01")).toMatchObject({ dueDate: "2027-01-19", amountDue: 49900, months: 1 });
  });

  it("Household paid trial: 1 month for ₱149 → 'Access until', then 'Renewal due' a week before", async () => {
    await owned("home-trial", "household-basic", "household-payroll", { termMonths: 1 });
    expect(biz("home-trial").subscription).toMatchObject({ billingType: "annual", amount: 14900, termMonths: 1, monthlyAmount: 0 });
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "home-trial", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    const t = subscriptionTerms(biz("home-trial").subscription);
    expect(t).toMatchObject({ paidThrough: "2026-11-18", accessUntil: "2026-11-18", dueDate: "2026-11-19", renewal: true });
    expect(attentionOf(t, { today: "2026-11-01" })).toBeNull();
    expect(attentionOf(t, { today: "2026-11-14" })).toMatchObject({ kind: "due", what: "Renewal due", date: "2026-11-19" });
    expect(world.db.docs.get("platformMetrics/2026-10").revenueByBillingType).toMatchObject({ annual: 14900 });
    // A term the product doesn't sell is refused.
    await expect(createBusiness({ ...world, name: "X", planId: "household-basic", workspaceTemplateId: "household-payroll", businessId: "home-x", termMonths: 6 })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(createBusiness({ ...world, name: "Y", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: "wed-y", termMonths: 3 })).rejects.toMatchObject({ code: "invalid-input" });
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
    await owned("wed-2", "bridal-plus", "bridal-expense", { priceOverride: 349000 });
    // Luna Bridal Custom: "starting at ₱2,990"; this wedding's design was quoted ₱3,490.
    expect(biz("wed-2").subscription).toMatchObject({ billingType: "term", amount: 299000, priceOverride: 349000, autoRenew: false, startDate: "2026-10-19", accessUntil: "2027-10-18", monthlyAmount: 0 });
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
    expect(world.db.docs.get("platformMetrics/2026-10").revenueByBillingType).toMatchObject({ term: 349000 });
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

  it("Change product: Luna Bridal → Luna Bridal Custom keeps the wedding, its dates and data; a product from another workspace is refused", async () => {
    await owned("wed-up", "bridal-basic", "bridal-expense");
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "wed-up", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    const before = biz("wed-up").subscription;
    expect((await op({ action: "changePlan", businessId: "wed-up", planId: "household-basic", reason: "wrong" })).body.error).toBe("plan-wrong-workspace");
    ok(await op({ action: "changePlan", businessId: "wed-up", planId: "bridal-plus", reason: "custom invitation" }));
    expect(biz("wed-up").subscription).toMatchObject({ planId: "bridal-plus", billingType: "term", amount: 299000, startDate: before.startDate, accessUntil: before.accessUntil, paidThrough: before.paidThrough });
    expect(biz("wed-up").entitlements.planName).toBe("Luna Bridal Custom");
  });

  it("Change access (Household): term, paid through, add-ons (+1 family user, +500 MB) and an agreed price; the product stays; audited", async () => {
    await owned("home-acc", "household-basic", "household-payroll", { termMonths: 3 });
    expect(biz("home-acc").entitlements.limits).toMatchObject({ users: 1, storageBytes: 500 * MB });
    const r = ok(await op({ action: "setAccess", businessId: "home-acc", changes: { termMonths: 12, paidThrough: "2026-12-31", addOns: { user: 1, storage: 2 } }, reason: "family plan" }));
    expect(r.limits).toMatchObject({ users: 2, storageBytes: 1500 * MB });
    const sub = biz("home-acc").subscription;
    expect(sub).toMatchObject({ planId: "household-basic", termMonths: 12, amount: 119000, paidThrough: "2026-12-31" });
    expect(sub.addOns.map((a) => [a.id, a.qty, a.price])).toEqual([["user", 1, 19900], ["storage", 2, 19900]]);
    // The next bill: the 12-month price + the add-ons for 12 months.
    const t = subscriptionTerms(sub);
    expect([t.dueDate, t.amount]).toEqual(["2027-01-01", 119000 + 19900 + 2 * 19900]);
    expect(billFor(biz("home-acc"), "2027-01")).toMatchObject({ amountDue: 178700, months: 12, coverTo: "2027-12-31" });
    // The extra seat really is a seat: a second family member fits now.
    const spouse = await ensureAuthUser({ auth: world.auth, email: "spouse@acc.test", name: "Spouse" });
    await addMember({ ...world, businessId: "home-acc", uid: spouse.uid, email: spouse.email, name: "Spouse", roleTemplate: "manager" });
    ok(await op({ action: "setAccess", businessId: "home-acc", changes: { priceOverride: 99000 }, reason: "agreed" }));
    expect(subscriptionTerms(biz("home-acc").subscription).amount).toBe(99000 + 19900 + 2 * 19900);
    // Removing an add-on: limits go back; nobody is removed.
    const back = ok(await op({ action: "setAccess", businessId: "home-acc", changes: { addOns: { user: 0, storage: 0 }, priceOverride: null }, reason: "back" }));
    expect(back.limits.users).toBe(1);
    expect(back.warnings.join(" ")).toMatch(/exceed/);
    expect(world.db.docs.get(`businesses/home-acc/members/${spouse.uid}`)).toBeTruthy();
    const audits = [...world.db.docs.entries()].filter(([k, v]) => k.startsWith("platformAudit/") && v.type === "entitlements.access-changed").map(([, v]) => v.summary);
    expect(audits[0]).toMatch(/term 12 months; paid through 2026-12-31; add-ons 1 × Additional family\/admin user, 2 × Additional 500 MB storage/);
    // Refused: a term not sold, an add-on not offered, a legacy plan.
    expect((await op({ action: "setAccess", businessId: "home-acc", changes: { termMonths: 6 }, reason: "test" })).status).toBe(400);
    expect((await op({ action: "setAccess", businessId: "home-acc", changes: { addOns: { users: 2 } }, reason: "test" })).status).toBe(400);
    expect((await op({ action: "setAccess", businessId: "biz-a", changes: { termMonths: 1 }, reason: "test" })).body.error).toBe("legacy-plan");
  });

  it("Change access (Distributor): +2 users / +1 GB per month raise the limits and the monthly bill (recurring income)", async () => {
    await owned("dist-acc", "distributor-basic", "distributor");
    ok(await op({ action: "setAccess", businessId: "dist-acc", changes: { addOns: { users: 1, storage: 1 } }, reason: "growing" }));
    expect(biz("dist-acc").entitlements.limits).toMatchObject({ users: 4, storageBytes: (500 + 1024) * MB });
    expect(biz("dist-acc").subscription.monthlyAmount).toBe(49900 + 14900 + 9900);
    expect(billFor(biz("dist-acc"), "2026-11", { setup: false })).toMatchObject({ amountDue: 74700, months: 1 });
    expect(billFor(biz("dist-acc"), "2026-11", { setup: false }).lines.map((l) => [l.label, l.amount])).toEqual([["Distributor · Monthly access", 49900], ["1 × +2 users", 14900], ["1 × +1 GB storage", 9900]]);
    // Next bill as a 3-month prepaid term (add-ons for 3 months too).
    ok(await op({ action: "setAccess", businessId: "dist-acc", changes: { termMonths: 3 }, reason: "prepay" }));
    expect(subscriptionTerms(biz("dist-acc").subscription)).toMatchObject({ prepaidNext: true, termMonths: 3, amount: 129000 + 3 * (14900 + 9900) });
  });
});

describe("bills: setup fee, discounts / credits, Bridal upgrade, frozen history", () => {
  const nextBill = (id) => [...world.db.docs.entries()].filter(([k, v]) => k.startsWith("subscriptionInvoices/") && v.businessId === id).map(([k, v]) => ({ id: k.split("/")[1], ...v }));

  it("a waived setup fee still shows: the fee, then 'Setup fee waived'", async () => {
    await createBusiness({ ...world, name: "Waived", planId: "distributor-basic", workspaceTemplateId: "distributor", businessId: "dist-w", clock: OCT19, waiveSetupFee: true });
    const paid = await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "dist-w", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    expect(paid.status).toBe("paid");
    const [inv] = nextBill("dist-w");
    expect(inv.lines.map((l) => [l.kind, l.amount])).toEqual([["base", 49900], ["setup", 99900]]);
    expect(inv.adjustments).toEqual([{ id: "setup-waived", type: "setup_waived", description: "Setup fee waived", amount: 99900 }]);
    expect([inv.amountDue, inv.amountPaid]).toEqual([49900, 49900]);
    expect([...world.db.docs.values()].some((v) => v.type === "billing.setup-fee-waived" && v.businessId === "dist-w")).toBe(true);
  });

  it("+ Add discount / deduction: negative lines (Founding −₱300, Referral −₱100 → ₱1,098); removable before payment; never below ₱0; locked once paid", async () => {
    await owned("dist-d", "distributor-basic", "distributor");
    const a = ok(await op({ action: "addAdjustment", businessId: "dist-d", adjustment: { type: "discount", description: "Founding discount", amount: 30000 } }));
    const b = ok(await op({ action: "addAdjustment", businessId: "dist-d", adjustment: { type: "credit", description: "Referral credit", amount: 10000 } }));
    expect([a.amountDue, b.amountDue]).toEqual([119800, 109800]);
    const [inv] = nextBill("dist-d");
    expect(inv.lines.map((l) => l.amount)).toEqual([49900, 99900]);
    expect(inv.adjustments.map((x) => [x.type, x.description, x.amount])).toEqual([["discount", "Founding discount", 30000], ["credit", "Referral credit", 10000]]);
    // The product's price is untouched.
    expect(biz("dist-d").subscription.amount).toBe(49900);
    ok(await op({ action: "removeAdjustment", businessId: "dist-d", invoiceId: inv.id, adjustmentId: inv.adjustments[1].id }));
    expect(nextBill("dist-d")[0].amountDue).toBe(119800);
    const big = ok(await op({ action: "addAdjustment", businessId: "dist-d", adjustment: { type: "credit", description: "Loyalty credit", amount: 500000 } }));
    expect(big.amountDue).toBe(0);
    const paid = ok(await op({ action: "recordPayment", businessId: "dist-d", payment: { paymentDate: "2026-10-19" } }));
    expect(paid.status).toBe("paid");
    // After payment the breakdown is frozen.
    expect((await op({ action: "addAdjustment", businessId: "dist-d", invoiceId: inv.id, adjustment: { type: "discount", description: "Late promo", amount: 100 } })).body.error).toBe("bill-locked");
    expect((await op({ action: "removeAdjustment", businessId: "dist-d", invoiceId: inv.id, adjustmentId: inv.adjustments[0].id })).body.error).toBe("bill-locked");
    expect((await op({ action: "addAdjustment", businessId: "dist-d", adjustment: { type: "discount", description: "x", amount: 0 } })).status).toBe(400);
    const audits = [...world.db.docs.values()].filter((v) => v.type === "billing.adjustment-added" && v.businessId === "dist-d");
    expect(audits[0]).toMatchObject({ actor: "ops@luna.test", amount: 30000 });
    expect(audits[0].summary).toMatch(/Founding discount −₱300\.00/);
  });

  it("a later price change never rewrites a bill: the paid bill keeps its lines; only new businesses get the new price", async () => {
    await world.db.collection("plans").doc("distributor-basic").set(structuredClone(PLAN_SEED["distributor-basic"]));
    await owned("dist-h", "distributor-basic", "distributor");
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "dist-h", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    const before = structuredClone(nextBill("dist-h")[0]);
    ok(await op({ action: "savePlan", planId: "distributor-basic", changes: { termPrices: { 1: 59900 }, setupFee: 150000 } }));
    const after = nextBill("dist-h")[0];
    expect([after.lines, after.amountDue, after.amountPaid]).toEqual([before.lines, before.amountDue, before.amountPaid]);
    expect(billFor(biz("dist-h"), "2026-11").amountDue).toBe(49900);
  });

  it("Luna Bridal → Custom on paid access: only the difference (₱2,990 − ₱1,490 = ₱1,500), discount allowed, access end kept; a downgrade bills nothing", async () => {
    await owned("wed-u", "bridal-basic", "bridal-expense");
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "wed-u", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    const accessUntil = biz("wed-u").subscription.accessUntil;
    const r = ok(await op({ action: "changePlan", businessId: "wed-u", planId: "bridal-plus", reason: "custom invitation", agreedPrice: 299000 }));
    expect(r.upgradeDue).toBe(150000);
    const sub = biz("wed-u").subscription;
    expect(sub).toMatchObject({ planId: "bridal-plus", accessUntil, priceOverride: 299000, upgradeDue: { amount: 150000 } });
    const t = subscriptionTerms(sub);
    expect(attentionOf(t, { today: "2026-10-19" })).toMatchObject({ what: "Upgrade due", kind: "due" });
    const up = nextBill("wed-u").find((i) => i.kind === "upgrade");
    expect(up.lines).toEqual([{ kind: "upgrade", label: "Upgrade to Luna Bridal Custom (₱2,990.00 − ₱1,490.00 already paid)", amount: 150000 }]);
    const disc = ok(await op({ action: "addAdjustment", businessId: "wed-u", adjustment: { type: "discount", description: "Loyalty discount", amount: 30000 } }));
    expect(disc).toMatchObject({ invoiceId: up.id, amountDue: 120000 });
    const paid = ok(await op({ action: "recordPayment", businessId: "wed-u", payment: { paymentDate: "2026-10-19" } }));
    expect(paid.status).toBe("paid");
    expect(biz("wed-u").subscription).toMatchObject({ upgradeDue: null, accessUntil, paidThrough: accessUntil });
    expect(attentionOf(subscriptionTerms(biz("wed-u").subscription), { today: "2026-10-19" })).toBeNull();
    // Down again: no refund, no bill.
    const down = ok(await op({ action: "changePlan", businessId: "wed-u", planId: "bridal-basic", reason: "back to standard" }));
    expect(down.upgradeDue ?? 0).toBe(0);
    expect(nextBill("wed-u").filter((i) => i.kind === "upgrade")).toHaveLength(1);
    expect([...world.db.docs.values()].some((v) => v.type === "billing.upgrade-billed" && v.businessId === "wed-u" && v.amount === 150000)).toBe(true);
  });

  it("the agreed price set after the product change: the unpaid upgrade bill follows it (₱3,990 − ₱1,490 = ₱2,500)", async () => {
    await owned("wed-late", "bridal-basic", "bridal-expense");
    await recordOperatorPayment({ db: world.db, FieldValue: FV(), businessId: "wed-late", input: { paymentDate: "2026-10-19" }, operator: "ops@luna.test", now: OCT19 });
    expect(ok(await op({ action: "changePlan", businessId: "wed-late", planId: "bridal-plus", reason: "custom" })).upgradeDue).toBe(150000);
    ok(await op({ action: "setAccess", businessId: "wed-late", changes: { priceOverride: 399000 }, reason: "design quote" }));
    const up = nextBill("wed-late").find((i) => i.kind === "upgrade");
    expect([up.amountDue, up.lines[0].amount]).toEqual([250000, 250000]);
    expect(biz("wed-late").subscription.upgradeDue.amount).toBe(250000);
    ok(await op({ action: "addAdjustment", businessId: "wed-late", adjustment: { type: "discount", description: "Loyalty", amount: 50000 } }));
    expect(biz("wed-late").subscription.upgradeDue.amount).toBe(200000);
  });

  it("an unpaid wedding changing product: its open bill is re-priced (no upgrade bill)", async () => {
    await owned("wed-n", "bridal-basic", "bridal-expense");
    ok(await op({ action: "addAdjustment", businessId: "wed-n", adjustment: { type: "discount", description: "Promo", amount: 10000 } }));
    ok(await op({ action: "changePlan", businessId: "wed-n", planId: "bridal-plus", reason: "custom", agreedPrice: 349000 }));
    const bills = nextBill("wed-n");
    expect(bills).toHaveLength(1);
    expect(bills[0].lines[0]).toMatchObject({ amount: 349000 });
    expect(bills[0].amountDue).toBe(349000 - 10000);
  });

  it("an older wedding over its included users keeps everyone; only a new invitation waits for capacity", async () => {
    const owner = await owned("wed-cap", "bridal-basic", "bridal-expense");
    await roomForTeam(world, "wed-cap", 3);
    for (const n of ["Planner Two", "Planner Three"]) {
      const x = await ensureAuthUser({ auth: world.auth, email: `${n.replace(" ", ".").toLowerCase()}@cap.test`, name: n });
      await addMember({ ...world, businessId: "wed-cap", uid: x.uid, email: x.email, name: n, roleTemplate: "manager" });
    }
    ok(await op({ action: "setLimitOverride", businessId: "wed-cap", limitKey: "users", value: null, reason: "back to the product's 1 planner" }));
    expect(biz("wed-cap").entitlements.limits.users).toBe(1);
    expect([...world.db.docs.keys()].filter((k) => k.split("/").length === 4 && k.startsWith("businesses/wed-cap/members/")).length).toBe(3);
    const x = await ensureAuthUser({ auth: world.auth, email: "planner4@cap.test", name: "Planner Four" });
    await expect(addMember({ ...world, businessId: "wed-cap", uid: x.uid, email: x.email, name: "Planner Four", roleTemplate: "manager" })).rejects.toThrow("3 of 1 planning users are active. Existing members keep access; add capacity to invite more.");
    void owner;
  });

  it("Create Business (Advanced): add-ons from the start raise the limits and the first bill; a custom setup fee", async () => {
    ok(await op({ action: "createBusiness", business: { workspaceTemplateId: "distributor", planId: "distributor-basic", name: "Big Start", ownerName: "B", ownerEmail: "b@big.test", businessId: "big-start", addOns: { users: 1 }, setupFee: 50000 } }));
    expect(biz("big-start").entitlements.limits.users).toBe(4);
    expect(billFor(biz("big-start"), "2026-10").lines.map((l) => [l.kind, l.amount])).toEqual([["base", 49900], ["addon", 14900], ["setup", 50000]]);
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
    const r = ok(await op({ action: "createBusiness", business: { workspaceTemplateId: "household-payroll", planId: "household-basic", termMonths: 3, name: "Prado Home", ownerName: "Mon Prado", ownerEmail: "mon@prado.test", businessId: businessIdFromName("Prado Home") } }));
    expect(r.businessId).toBe("prado-home");
    expect(biz("prado-home").subscription).toMatchObject({ billingType: "annual", amount: 34900, termMonths: 3 });
    // Bridal Custom with the quoted price; the default term (12 months).
    ok(await op({ action: "createBusiness", business: { workspaceTemplateId: "bridal-expense", planId: "bridal-plus", priceOverride: 399000, name: "Carlo & Yanie", ownerName: "Carlo", ownerEmail: "carlo@wed.test", businessId: "carlo-yanie" } }));
    expect(biz("carlo-yanie").subscription).toMatchObject({ billingType: "term", amount: 299000, priceOverride: 399000, termMonths: 12 });
    expect((await op({ action: "createBusiness", business: { workspaceTemplateId: "household-payroll", planId: "household-basic", founding: true, name: "Z", ownerName: "Z", ownerEmail: "z@z.test", businessId: "z-home" } })).status).toBe(400);
    expect((await op({ action: "createBusiness", business: { workspaceTemplateId: "bridal-expense", planId: "household-basic", name: "X Wedding", ownerName: "X", ownerEmail: "x@x.test", businessId: "x-wedding" } })).body.error).toBe("plan-wrong-workspace");
  });
});

describe("products are edited in Super Admin", () => {
  it("term prices, add-on prices, setup fee and included limits change for NEW businesses; existing ones keep theirs; audited; validated", async () => {
    await world.db.collection("plans").doc("distributor-basic").set(structuredClone(PLAN_SEED["distributor-basic"]));
    await owned("dist-5", "distributor-basic", "distributor");
    const r = ok(await op({ action: "savePlan", planId: "distributor-basic", changes: { termPrices: { 1: 54900, 3: 139000 }, addOnPrices: { users: 15900 }, setupFee: 0, users: 3, storageMb: 750, tagline: "Orders, stock and money in one place." } }));
    expect(r.plan.pricing).toMatchObject({ price: 54900, monthly: 54900, setupFee: 0, billingType: "monthly" });
    expect(r.plan.pricing.terms.map((t) => [t.months, t.price])).toEqual([[1, 54900], [3, 139000]]);
    expect(r.plan.pricing.addOns.find((a) => a.id === "users").price).toBe(15900);
    expect(r.plan.limits).toMatchObject({ users: 3, storageBytes: 750 * MB, ordersPerMonth: UNLIMITED });
    expect(r.plan.tagline).toBe("Orders, stock and money in one place.");
    expect(biz("dist-5").subscription.amount).toBe(49900);
    expect(biz("dist-5").entitlements.limits.users).toBe(2);
    await owned("dist-6", "distributor-basic", "distributor");
    expect(biz("dist-6").subscription.amount).toBe(54900);
    expect(biz("dist-6").entitlements.limits.users).toBe(3);
    expect([...world.db.docs.values()].some((v) => v.type === "plan.changed" && v.planId === "distributor-basic")).toBe(true);
    for (const bad of [{ termPrices: { 1: 0 } }, { termPrices: { 6: 10000 } }, { addOnPrices: { nope: 100 } }, { users: 0 }, { billingType: "weekly" }, { secret: 1 }]) expect((await op({ action: "savePlan", planId: "distributor-basic", changes: bad })).status, JSON.stringify(bad)).toBe(400);
  });
});
