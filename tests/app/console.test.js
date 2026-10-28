// @vitest-environment jsdom
// Phase 17: Super Admin console views. Everything goes through the operator
// API (ctx.call): the views send intent only (ids, plan id, choice, reason),
// never entitlement objects or permission lists. Plus the tenant app's
// navigation relabelled by tenant terminology.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { overviewView, businessesView, businessDetailView, createBusinessDialog, plansView } from "../../src/console/views.js";
import { subscriptionMenu, runSubscriptionAction } from "../../src/console/actions.js";
import { render } from "../../src/lib/html.js";
import { renderShell } from "../../src/app/shell.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
import { creatableWorkspaces, moduleTable } from "../../shared/operators.js";
import { resolveTenantConfig } from "../../shared/tenant-config.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
let el;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><main id="content"></main>';
  el = document.getElementById("content");
});
const plans = Object.values(PLAN_SEED);
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (f) => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const ctxWith = (call, extra = {}) => ({ base: "/console", call, toast: vi.fn(), workspaces: creatableWorkspaces(), plans, workspaceName: (id) => id, planName: (id) => id, moduleLabel: (id) => id, navigate: vi.fn(), search: "", ...extra });

const DETAIL = {
  business: { id: "abc-test-trading", name: "ABC Test Trading", timezone: "Asia/Manila", workspaceTemplateId: "distributor", workspaceName: "Distributor", workspaceTemplateVersion: 5, planId: "growth", planName: "Growth", status: "active", createdAt: "2026-10-10T00:00:00Z", adminRevision: 3, entitlementsValid: true, entitlementProblems: [] },
  modules: moduleTable({ templateId: "distributor", plan: PLAN_SEED.growth, overrides: { imports: false } }).map((m) => ({ ...m, effective: m.computed })),
  members: [{ uid: "u1", email: "owner@abc.test", name: "Abe", roleTemplate: "owner", status: "active", isAccountOwner: true }, { uid: "u2", email: "mia@abc.test", name: "Mia", roleTemplate: "manager", status: "active", isAccountOwner: false }],
  usage: { period: "2026-10", activeUsers: 2, userLimit: 5, ordersThisMonth: 4, importsThisMonth: 1, exportsGenerated: 2, rowsExported: 40 },
  limits: { importsPerMonth: 5 },
  config: resolveTenantConfig(null, "distributor"),
  terms: [{ id: "customer", label: "What do you call your customers?", options: [{ id: "customer", label: "Customer" }, { id: "dealer", label: "Dealer" }] }],
  audit: [{ type: "business.created", summary: "Business created: ABC", actor: "ops@luna.test", at: "2026-10-10T00:00:00Z" }],
};

describe("console views", () => {
  it("Overview: active, free trials, 6 / 12-month income (+ older monthly), Needs Attention (real dates, trials ending, ⋯ actions), Income by Workspace; no cost, profit or subscription mixes", async () => {
    const overview = {
      period: "2026-10",
      today: "2026-10-19",
      activeAccess: 14,
      trials: { active: 5, endingSoon: 2, ended: 1 },
      recurringIncome: 1200000,
      annualIncomeThisMonth: 1297000,
      collectedThisMonth: 2485000,
      awaiting: { count: 2, amount: 89800 },
      needsAttention: [
        { id: "abc", name: "ABC Frozen Foods", workspaceTemplateId: "distributor", planId: "distributor-plus", planName: "Distributor+", status: "active", state: "active", billingType: "monthly", amount: 89900, dueDate: "2026-10-12", attention: { kind: "overdue", date: "2026-10-12", days: 7, label: "7 days overdue", what: "Due", tone: "danger" } },
        { id: "hk", name: "Hayst Kopi", workspaceTemplateId: "distributor", planId: "distributor-basic", planName: "Luna Distributor", status: "active", state: "active", billingType: "annual", amount: 239000, dueDate: "2026-10-25", attention: { kind: "due", date: "2026-10-25", days: 6, label: "Due soon", what: "Payment due", tone: "warning" } },
        { id: "sh", name: "Santos Home", workspaceTemplateId: "household-payroll", planId: "household-basic", planName: "Luna Household", status: "active", state: "trial", billingType: "annual", amount: 239000, trial: { status: "trial_active", open: true, endsAt: "2026-10-22", daysLeft: 3, conversion: null }, attention: { kind: "trial", date: "2026-10-22", days: 3, label: "Trial ends soon", what: "Trial ends", tone: "warning" } },
        { id: "cy", name: "Carlo & Yanie", workspaceTemplateId: "bridal-expense", planId: "bridal-plus", planName: "Luna Bridal+", status: "active", state: "expiring", billingType: "term", amount: 399000, accessUntil: "2026-11-02", paidThrough: "2026-11-02", attention: { kind: "expiring", date: "2026-11-02", days: 14, label: "Expiring soon", what: "Access ends", tone: "warning" } },
      ],
      incomeByWorkspace: [
        { workspaceTemplateId: "distributor", billingType: "annual", collected: 900000, recurring: null, active: 20 },
        { workspaceTemplateId: "household-payroll", billingType: "annual", collected: 400000, recurring: null, active: 4 },
        { workspaceTemplateId: "bridal-expense", billingType: "term", collected: 897000, recurring: null, active: 3 },
      ],
    };
    const call = vi.fn(async (action) => (action === "overview" ? { overview } : { sent: 1 }));
    const ctx = ctxWith(call, { workspaceName: (id) => ({ distributor: "Distributor", "household-payroll": "Household", "bridal-expense": "Bridal" })[id] });
    overviewView(el, ctx);
    await flush();
    expect(call).toHaveBeenCalledWith("overview");
    const kpis = [...el.querySelectorAll('[data-role="kpis"] .kpi')].map((k) => `${k.querySelector(".kpi-label").textContent}: ${k.querySelector(".kpi-value").textContent}`);
    expect(kpis).toEqual(["Active subscriptions: 14", "Free trials: 5", "Collected this month: ₱24,850", "Recurring income: ₱12,000"]);
    expect(el.querySelector('[data-role="kpis"]').textContent).toMatch(/2 ending this week · 1 ended/);
    const rows = [...el.querySelectorAll('[data-role="attention-rows"] tbody tr')];
    expect(rows.map((r) => [...r.querySelector('[data-role="when"]').childNodes].map((n) => n.textContent.trim()).filter(Boolean).join(" | "))).toEqual(["Due Oct 12, 2026 | 7 days overdue", "Payment due Oct 25, 2026", "Trial ends Oct 22, 2026", "Access ends Nov 2, 2026"]);
    expect(rows.map((r) => r.querySelector("td:nth-child(4) .badge").textContent)).toEqual(["7 days overdue", "Due soon", "Trial ends soon", "Expiring soon"]);
    const income = [...el.querySelectorAll('[data-role="income"] li')].map((li) => li.textContent.replace(/\s+/g, " ").trim());
    expect(income[0]).toMatch(/^Distributor ?6 \/ 12-month access collected this month · 20 active ₱9,000$/);
    expect(income[1]).toMatch(/^Household ?6 \/ 12-month access collected this month · 4 active ₱4,000$/);
    expect(income[2]).toMatch(/^Bridal ?Wedding access collected this month · 3 active ₱8,970$/);
    expect(el.textContent).not.toMatch(/profit|margin|operating cost|Subscription mix|Total businesses/i);
    // ⋯ → Send notification on a row.
    rows[0].querySelector('[data-act="row-menu"]').click();
    rows[0].querySelector('[data-act="s-remind"]').click();
    await flush();
    submit(lastForm());
    await flush();
    expect(call).toHaveBeenCalledWith("sendReminder", { businessId: "abc" });
  });

  it("businesses: compact rows from listBusinesses; filters are sent as filters; Manage opens the detail", async () => {
    const call = vi.fn(async () => ({ rows: [{ id: "abc-test-trading", name: "ABC Test Trading", workspaceTemplateId: "distributor", workspaceTemplateVersion: 5, planId: "growth", status: "active", owner: { email: "owner@abc.test" }, createdAt: null, usage: { orders: 4, imports: 1, exports: 2 } }], next: null }));
    businessesView(el, ctxWith(call));
    await flush();
    expect(el.querySelector('[data-business="abc-test-trading"] a').getAttribute("href")).toBe("/console/businesses?b=abc-test-trading");
    const f = el.querySelector('[data-role="filters"]');
    f.elements.status.value = "suspended";
    submit(f);
    await flush();
    expect(call).toHaveBeenLastCalledWith("listBusinesses", { filters: { status: "suspended" }, after: null });
    // Plan filter: only sold plans, following the chosen workspace (no Starter / Growth / Pro).
    const g = el.querySelector('[data-role="filters"]');
    expect([...g.elements.planId.options].map((o) => o.textContent)).not.toContain("Growth");
    g.elements.workspaceTemplateId.value = "bridal-expense";
    g.elements.workspaceTemplateId.dispatchEvent(new Event("change", { bubbles: true }));
    // Luna Bridal is the one Bridal product (Custom is legacy since 2026-10-25).
    expect([...g.elements.planId.options].map((o) => o.textContent)).toEqual(["All plans", "Luna Bridal"]);
    g.elements.planId.value = "bridal-basic";
    g.elements.status.value = "";
    submit(g);
    await flush();
    expect(call).toHaveBeenLastCalledWith("listBusinesses", { filters: { workspaceTemplateId: "bridal-expense", planId: "bridal-basic" }, after: null });
  });

  it("Create business: Product → Term → name → owner; terms follow the product (Best Value default); the ID made from the name; sends intent only", async () => {
    const call = vi.fn(async () => ({ businessId: "prado-home", created: true }));
    const p = createBusinessDialog(ctxWith(call));
    const f = lastForm();
    expect([...f.querySelectorAll(".field label")].slice(0, 6).map((l) => l.textContent.replace(" *", ""))).toEqual(["Product", "Term", "Start", "Business / workspace name", "Owner name", "Owner email"]);
    // Sold products only: no Distributor+ / Household+ / Starter / Growth / Pro.
    // ... and no Luna Bridal Custom (legacy since 2026-10-25).
    expect([...f.elements.planId.options].map((o) => o.textContent)).toEqual(["Luna Distributor", "Luna Household", "Baby Basic", "Baby Plus", "Luna Bridal"]);
    expect([...f.elements.termMonths.options].map((o) => o.textContent)).toEqual(["6 months · ₱1,299", "12 months · ₱2,390 · Best Value"]);
    // The 30-day free trial is the default start.
    expect(f.elements.start.value).toBe("trial");
    expect(f.elements.start.closest(".field").hidden).toBe(false);
    f.elements.planId.value = "household-basic";
    f.elements.planId.dispatchEvent(new Event("change", { bubbles: true }));
    expect([...f.elements.termMonths.options].map((o) => o.textContent)).toEqual(["6 months · ₱1,299", "12 months · ₱2,390 · Best Value"]);
    expect(f.elements.termMonths.value).toBe("12");
    expect(f.elements.planId.closest(".field").querySelector(".stat-hint").textContent).toBe("₱2,390 / 12 months · 1 user · 500 MB");
    f.elements.termMonths.value = "6";
    for (const [k, v] of Object.entries({ name: "Prado Home", ownerEmail: "mon@prado.test", ownerName: "Mon Prado" })) f.elements[k].value = v;
    f.elements.name.dispatchEvent(new Event("change", { bubbles: true }));
    expect(f.elements.businessId.value).toBe("prado-home");
    submit(f);
    await p;
    const [action, body] = call.mock.calls[0];
    expect(action).toBe("createBusiness");
    expect(body.business).toEqual({ name: "Prado Home", businessId: "prado-home", workspaceTemplateId: "household-payroll", planId: "household-basic", termMonths: 6, trial: true, ownerName: "Mon Prado", ownerEmail: "mon@prado.test", timezone: "Asia/Manila" });
    // Bridal (2026-10-26): one product, 3 or 6 months (3 by default), the free trial by default.
    const p2 = createBusinessDialog(ctxWith(call));
    const g = lastForm();
    g.elements.planId.value = "bridal-basic";
    g.elements.planId.dispatchEvent(new Event("change", { bubbles: true }));
    expect(g.elements.termMonths.closest(".field").hidden).toBe(false);
    expect([...g.elements.termMonths.options].map((o) => o.value)).toEqual(["3", "6"]);
    for (const [k, v] of Object.entries({ name: "Carlo & Yanie", ownerEmail: "c@y.test", ownerName: "Carlo" })) g.elements[k].value = v;
    g.elements.name.dispatchEvent(new Event("change", { bubbles: true }));
    submit(g);
    await p2;
    expect(call.mock.calls[1][1].business).toMatchObject({ planId: "bridal-basic", workspaceTemplateId: "bridal-expense", termMonths: 3, businessId: "carlo-yanie" });
  });

  it("Change access: term, paid through, add-ons and price, sent as changes only; the product menu only where there's a choice", async () => {
    const r = { id: "home", name: "Prado Home", workspaceTemplateId: "household-payroll", planId: "household-basic", status: "active", billingType: "annual", termMonths: 6, amount: 129900, paidThrough: "2026-12-31", addOns: [], priceOverride: null };
    const call = vi.fn(async () => ({ warnings: [], limits: { users: 2 } }));
    const ctx = ctxWith(call);
    const menu = (row) => { const d = document.createElement("div"); render(d, subscriptionMenu(row, { ctx })); return [...d.querySelectorAll("[data-act]")].map((b) => b.dataset.act); };
    expect(menu(r)).toContain("s-access");
    expect(menu(r)).not.toContain("s-plan"); // Luna Household is the only product
    expect(menu({ ...r, planId: "household-plus" })).toContain("s-plan"); // off an older "+" plan
    expect(menu({ ...r, id: "w", workspaceTemplateId: "bridal-expense", planId: "bridal-basic", billingType: "term" })).not.toContain("s-plan"); // Luna Bridal is the only product
    expect(menu({ ...r, id: "w", workspaceTemplateId: "bridal-expense", planId: "bridal-plus", billingType: "term" })).toContain("s-plan"); // off legacy Custom
    const p = runSubscriptionAction(ctx, "s-access", r);
    const f = lastForm();
    expect([...f.elements.termMonths.options].map((o) => o.value)).toEqual(["6", "12"]);
    f.elements.termMonths.value = "12";
    f.elements["addon-user"].value = "1";
    f.elements.reason.value = "Family plan";
    submit(f);
    await p;
    expect(call).toHaveBeenCalledWith("setAccess", { businessId: "home", changes: { termMonths: 12, addOns: { user: 1, storage: 0 } }, reason: "Family plan" });
  });

  it("detail: state first (plan, billing, the date, usage), members with ⋯ Remove (confirmed); modules and limits under Advanced", async () => {
    const detail = { ...DETAIL, billing: { id: "abc-test-trading", status: "active", state: "active", billingType: "monthly", amount: 89900, startDate: "2026-10-12", dueDate: "2026-11-12", attention: null }, current: { users: 2, storageBytes: 184 * 1024 * 1024, downloads: 3, transferBytes: 24 * 1024 * 1024, orders: 532 }, limits: { users: 4, storageBytes: 1024 ** 3, ordersPerMonth: 1000000 }, plan: PLAN_SEED["distributor-plus"], members: DETAIL.members.map((m) => ({ ...m, seat: true })) };
    const call = vi.fn(async (action) => (action === "business" ? detail : { adminRevision: 4, removed: true }));
    businessDetailView(el, ctxWith(call), "abc-test-trading");
    await flush();
    expect(el.querySelector('[data-role="subscription"]').textContent.replace(/\s+/g, " ")).toMatch(/Product ?Growth.*older plan.*Term ?Monthly ?₱899 per bill.*Next ?Due Nov 12, 2026/);
    const usage = Object.fromEntries([...el.querySelectorAll("[data-usage]")].map((d) => [d.dataset.usage, d.textContent]));
    expect(usage).toEqual({ users: "2 of 4", storage: "184 MB of 1.0 GB", downloads: "3", transfer: "24 MB", orders: "532" });
    expect(el.querySelector('[data-role="advanced"]').open).toBe(false);
    const row = (id) => el.querySelector(`[data-module="${id}"]`);
    expect(row("imports").textContent).toMatch(/Off/);
    expect(row("payroll")).toBeNull();
    const sel = row("imports").querySelector("select");
    sel.value = "default";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const f = lastForm();
    f.elements.reason.value = "Resume imports";
    submit(f);
    await flush();
    expect(call).toHaveBeenCalledWith("setModuleOverride", { businessId: "abc-test-trading", moduleId: "imports", choice: "default", reason: "Resume imports", expectedRevision: 3 });
    // The account owner has no Remove; another member does, after a confirmation.
    expect(el.querySelector('[data-member="u1"] [data-act="m-remove"]')).toBeNull();
    el.querySelector('[data-member="u2"] [data-act="row-menu"]').click();
    el.querySelector('[data-member="u2"] [data-act="m-remove"]').click();
    await flush();
    expect(document.querySelector(".modal-backdrop").textContent).toMatch(/Remove Mia from ABC Test Trading\?/);
    document.querySelector('.modal-backdrop [data-action="confirm"]').click();
    await flush();
    expect(call).toHaveBeenCalledWith("removeMember", { businessId: "abc-test-trading", uid: "u2" });
  });

  it("customer data is support access: no records or Master Backup on the business page; Open workspace as support asks for a reason", async () => {
    const call = vi.fn(async (action) => (action === "supportStart" ? { sessionId: "sup000000000000000000000001", mode: "read-only" } : { ...DETAIL, support: null }));
    const ctx = ctxWith(call);
    businessDetailView(el, ctx, "abc-test-trading");
    await flush();
    expect(el.querySelector('[data-act="backup"]')).toBeNull();
    expect(el.querySelector('[data-role="support"]').textContent).toMatch(/Managing this business doesn't show its records/);
    el.querySelector('[data-act="support-start"]').click();
    await flush();
    const f = lastForm();
    expect(f.querySelector("label").textContent).toMatch(/Support reason/);
    f.elements.reason.value = "Owner reports a wrong balance (ticket 12)";
    submit(f);
    await flush();
    expect(call).toHaveBeenCalledWith("supportStart", { businessId: "abc-test-trading", reason: "Owner reports a wrong balance (ticket 12)" });
    expect(ctx.navigate).toHaveBeenCalledWith("/businesses?b=abc-test-trading&support=1");
  });

  it("support view: read-only banner, areas read one at a time, Master Backup inside the session, Exit ends it", async () => {
    const support = { sessionId: "sup000000000000000000000001", mode: "read-only", reason: "Owner reports a wrong balance", expiresAt: "2026-10-20T10:30:00Z" };
    const call = vi.fn(async (action) => (action === "business" ? { ...DETAIL, support } : action === "supportAreas" ? { areas: [{ id: "orders", label: "Orders" }, { id: "customers", label: "Customers" }] } : action === "supportRead" ? { area: "orders", rows: [{ id: "o1", orderNumber: "BA-1", total: 1000 }], more: false } : { ended: true }));
    const download = vi.fn(async () => ({ blob: new Blob(["x"]), fileName: "ABC-Master-Backup.xlsx" }));
    const save = vi.fn();
    const ctx = ctxWith(call, { download, save, search: "?b=abc-test-trading&support=1" });
    businessesView(el, ctx);
    await flush();
    expect(el.querySelector('[data-role="support-banner"]').textContent).toMatch(/read-only.*Owner reports a wrong balance/);
    expect(call).not.toHaveBeenCalledWith("supportRead", expect.anything());
    el.querySelector('[data-act="support-area"][data-id="orders"]').click();
    await flush();
    expect(call).toHaveBeenCalledWith("supportRead", { sessionId: support.sessionId, businessId: "abc-test-trading", area: "orders" });
    expect(el.querySelector('[data-role="support-rows"]').textContent).toMatch(/BA-1/);
    el.querySelector('[data-act="support-backup"]').click();
    await flush();
    expect(download).toHaveBeenCalledWith("backup", { businessId: "abc-test-trading", supportSessionId: support.sessionId });
    expect(save).toHaveBeenCalled();
    el.querySelector('[data-act="support-exit"]').click();
    await flush();
    expect(call).toHaveBeenCalledWith("supportEnd", { sessionId: support.sessionId });
    expect(ctx.navigate).toHaveBeenCalledWith("/businesses?b=abc-test-trading");
  });

  it("a Bridal business: the Invitation card (couple, Custom, status, last updated) with Preview / Edit / Publish / View published; nothing else of the wedding", async () => {
    const invitation = { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", type: "custom", productName: "Luna Bridal Custom", status: "published", live: "custom", publishedVersion: 2, unpublishedChanges: true, lastUpdated: "2026-10-20T03:00:00Z" };
    const wed = { ...DETAIL, business: { ...DETAIL.business, id: "wed-1", name: "Carlo & Yanie", workspaceTemplateId: "bridal-expense" }, invitation, support: null };
    businessDetailView(el, ctxWith(vi.fn(async () => wed)), "wed-1");
    await flush();
    const card = el.querySelector('[data-role="invitation"]');
    expect(card.textContent.replace(/\s+/g, " ")).toMatch(/Carlo & Yanie.*Custom.*Luna Bridal Custom.*Custom design v2.*Draft changes not published yet/);
    expect(card.querySelector(".badge").textContent).toBe("Published");
    expect([...card.querySelectorAll('[data-role="inv-actions"] [data-act], [data-role="inv-actions"] a')].map((x) => x.textContent.trim())).toEqual(["Preview draft", "Edit design", "Publish", "View published invitation"]);
    expect(card.textContent).toMatch(/sample guest/);
    expect(el.textContent).not.toMatch(/RSVP|guest list/i);
  });

  it("Bridal ⋯ → Access: exactly Free Trial / 3 Months — ₱499 / 6 Months — ₱799 (no 12 months); saving sends setTermAccess", async () => {
    const call = vi.fn(async () => ({ access: 3, amountDue: 49900 }));
    const ctx = ctxWith(call);
    const r = { id: "yanie", name: "Yanie Bridal", workspaceTemplateId: "bridal-expense", planId: "bridal-basic", status: "active", state: "trial", billingType: "term", trial: { open: true, endsAt: "2026-11-23" } };
    const p = runSubscriptionAction(ctx, "s-access", r);
    const f = lastForm();
    expect([...f.elements.access.options].map((o) => o.textContent)).toEqual(["Free Trial", "3 Months — ₱499", "6 Months — ₱799"]);
    expect(f.textContent).toMatch(/Access is not payment/);
    f.elements.access.value = "3";
    f.elements.reason.value = "Paid by GCash";
    submit(f);
    await p;
    expect(call).toHaveBeenCalledWith("setTermAccess", { businessId: "yanie", access: 3, reason: "Paid by GCash" });
  });

  it("Overview → Payments to review: only payments waiting for verification, named by their bill; Review payment opens that payment", async () => {
    const toReview = [{ id: "spY", businessId: "yanie", businessName: "Yanie Bridal", workspaceTemplateId: "bridal-expense", planName: "Luna Bridal", amountSubmitted: 49900, amountDue: 49900, method: "gcash", paymentDate: "2026-10-28", submittedAt: "2026-10-28T02:00:00.000Z", status: "for_verification", product: { kind: "access", label: "Luna Bridal — 3 Months", months: 3, does: "activate" } }];
    const overview = { period: "2026-10", activeAccess: 1, trials: { active: 0, endingSoon: 0, ended: 0 }, collectedThisMonth: 29900, awaiting: { count: 1, amount: 49900 }, toReview, needsAttention: [], incomeByWorkspace: [] };
    const call = vi.fn(async (action) => (action === "overview" ? { overview } : action === "payment" ? { payment: { ...toReview[0], hasProof: false, reference: "GC-77" }, product: toReview[0].product, access: null, invoice: null, history: [] } : { customLinks: { rows: [] } }));
    overviewView(el, ctxWith(call));
    await flush();
    const row = el.querySelector('[data-role="to-review"] [data-payment="spY"]');
    expect(row.textContent.replace(/\s+/g, " ").trim()).toMatch(/^Yanie Bridal ?Luna Bridal — 3 Months · GCash · Submitted Oct 28, 2026 ?₱499 ?Review payment$/);
    // A paid payment isn't "to collect": the KPI stays on paid records only.
    expect(el.querySelector('[data-role="kpis"]').textContent).toMatch(/Collected this month\s*₱299/);
    row.querySelector('[data-act="review-payment"]').click();
    await flush();
    expect(call).toHaveBeenCalledWith("payment", { paymentId: "spY" });
    expect(document.querySelector('[data-role="payment-review"]').dataset.payment).toBe("spY");
    // Nothing waiting: no queue at all (no feed of finished items).
    el.innerHTML = "";
    overview.toReview = [];
    overview.awaiting = { count: 0, amount: 0 };
    overviewView(el, ctxWith(call));
    await flush();
    expect(el.querySelector('[data-role="to-review"]')).toBeNull();
  });

  it("Business detail shows the latest payment beside Subscription: received → Review; verified → whether the access is active", async () => {
    const pending = { id: "spY", status: "for_verification", amountSubmitted: 49900, paymentDate: "2026-10-28", planName: "Luna Bridal", product: { kind: "access", label: "Luna Bridal — 3 Months", months: 3 } };
    const wed = { ...DETAIL, business: { ...DETAIL.business, id: "yanie", name: "Yanie Bridal", workspaceTemplateId: "bridal-expense" }, billing: { id: "yanie", status: "active", state: "trial", billingType: "term", termMonths: 3, amount: 49900, trial: { open: true, endsAt: "2026-11-23" } }, latestPayment: pending, invitation: null, support: null };
    const call = vi.fn(async (action) => (action === "business" ? wed : { payment: { ...pending, businessId: "yanie", businessName: "Yanie Bridal", hasProof: false }, product: pending.product, access: null, invoice: null, history: [] }));
    businessDetailView(el, ctxWith(call), "yanie");
    await flush();
    const line = el.querySelector('[data-role="latest-payment"]');
    expect(line.textContent.replace(/\s+/g, " ")).toMatch(/Payment received ?₱499 · Oct 28, 2026 · Luna Bridal — 3 Months · Pending verification ?Review/);
    line.querySelector('[data-act="review-payment"]').click();
    await flush();
    expect(call).toHaveBeenCalledWith("payment", { paymentId: "spY" });
    document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove());
    el.innerHTML = "";
    businessDetailView(el, ctxWith(vi.fn(async () => ({ ...wed, billing: { ...wed.billing, state: "active", trial: null, paidThrough: "2027-01-27", accessUntil: "2027-01-27" }, latestPayment: { ...pending, status: "paid" } }))), "yanie");
    await flush();
    expect(el.querySelector('[data-role="latest-payment"]').textContent.replace(/\s+/g, " ")).toMatch(/Payment verified ✓ ?₱499 · Oct 28, 2026 · Luna Bridal — 3 Months ?Access active/);
  });

  it("products: one per workspace (Custom is legacy), legacy hidden; what it's for, terms, included + add-ons, active count; Edit saves term and add-on prices", async () => {
    const call = vi.fn(async (action) => (action === "plans" ? { plans, subscribers: { "distributor-basic": 8, "baby-plus": 3 } } : { plan: {} }));
    plansView(el, ctxWith(call));
    await flush();
    expect(el.querySelector("h1").textContent).toBe("Products");
    const group = (w) => [...el.querySelectorAll(`[data-workspace="${w}"] tbody [data-plan]`)].map((tr) => tr.dataset.plan);
    expect(group("distributor")).toEqual(["distributor-basic"]);
    expect(group("household-payroll")).toEqual(["household-basic"]);
    expect(group("bridal-expense")).toEqual(["bridal-basic"]);
    expect(el.querySelector('[data-plan="distributor-basic"] [data-col="subscribers"]').textContent).toBe("8");
    const row = (id) => el.querySelector(`[data-plan="${id}"]`).textContent.replace(/\s+/g, " ");
    expect(row("household-basic")).toMatch(/₱2,390 \/ 12 months.*kasambahay.*6 months · ₱1,299.*12 months · ₱2,390 · Best Value.*Additional family\/admin user · ₱199 \/ 12 months/);
    expect(row("distributor-basic")).toMatch(/Luna Distributor.*₱2,390 \/ 12 months \+ ₱250 setup/);
    expect(el.querySelector('[data-plan="bridal-plus"]')).toBeNull();
    el.querySelector('[data-plan="distributor-basic"] [data-act="edit"]').click();
    const f = lastForm();
    f.elements["term-6"].value = "1399";
    f.elements["addon-users"].value = "159";
    f.elements.users.value = "3";
    submit(f);
    await flush();
    expect(call).toHaveBeenCalledWith("savePlan", { planId: "distributor-basic", changes: { name: "Luna Distributor", tagline: PLAN_SEED["distributor-basic"].tagline, termPrices: { 6: 139900, 12: 239000 }, addOnPrices: { users: 15900, storage: 9900 }, setupFee: 25000, users: 3, storageMb: 500, priceIsMinimum: false } });
  });
});

describe("tenant terminology in the business app", () => {
  it("Customers is back in Business (2026-10-20) and follows the customer terminology", () => {
    const s = sessionFixture();
    s.config = resolveTenantConfig({ terminology: { customer: "dealer" } }, "distributor");
    renderShell(document.getElementById("app"), s);
    const labels = [...document.querySelectorAll(".nav-link")].map((a) => a.textContent.trim());
    expect([...document.querySelectorAll(".nav-link")].some((a) => a.getAttribute("href") === "/customers")).toBe(true);
    expect(labels).toContain("Dealers");
    expect(labels).not.toContain("Customers");
  });
});
