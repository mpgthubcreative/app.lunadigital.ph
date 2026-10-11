// @vitest-environment jsdom
// Phase 17: Super Admin console views. Everything goes through the operator
// API (ctx.call): the views send intent only (ids, plan id, choice, reason),
// never entitlement objects or permission lists. Plus the tenant app's
// navigation relabelled by tenant terminology.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { overviewView, businessesView, businessDetailView, createBusinessDialog, plansView } from "../../src/console/views.js";
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
  it("overview tells the money story (collected, MRR, still to collect, for verification, costs, estimated GP + margin, trend, by workspace, due) then the counts", async () => {
    const trend = Array.from({ length: 12 }, (_, i) => ({ period: `2026-${String(i + 1).padStart(2, "0")}`, revenue: i * 100000, costs: 50000, grossProfit: i * 100000 - 50000 }));
    const money = {
      period: "2026-10",
      collected: 2485000,
      mrr: 3142000,
      activeSubscriptions: 14,
      stillToCollect: 657000,
      outstanding: 1200000,
      awaiting: { count: 3, amount: 543000 },
      pastDueCount: 1,
      platformCosts: 377000,
      infraCosts: 252000,
      estimatedGrossProfit: 2108000,
      estimatedGrossMargin: 84.8,
      trend,
      revenueByWorkspace: [{ workspaceTemplateId: "distributor", revenue: 1800000, mrr: 2000000, subscriptions: 8 }, { workspaceTemplateId: "household-payroll", revenue: 420000, mrr: 450000, subscriptions: 14 }],
      revenueByPlan: [],
      dueThisMonth: [{ businessId: "abc", businessName: "ABC Trading", workspaceTemplateId: "distributor", planName: "Growth", amountDue: 199000, amountPaid: 0, status: "due", dueDate: "2026-10-07" }],
      pastDue: [],
    };
    const call = vi.fn(async (action) => (action === "money" ? { money } : { overview: { total: 8, byStatus: { active: 6, past_due: 0, suspended: 1, cancelled: 1 }, byWorkspace: { distributor: 4 }, byPlan: { growth: 5 } } }));
    overviewView(el, ctxWith(call));
    await flush();
    expect(call).toHaveBeenCalledWith("money");
    expect(call).toHaveBeenCalledWith("overview");
    const v = (id) => el.querySelector(`[data-widget="${id}"] .kpi-value`).textContent.trim();
    expect([v("collected"), v("mrr"), v("toCollect")]).toEqual(["₱24,850.00", "₱31,420.00", "₱6,570.00"]);
    expect(v("verify")).toMatch(/3 · ₱5,430\.00/);
    expect(el.querySelector('[data-widget="verify"] a').getAttribute("href")).toBe("/console/payments");
    expect([v("costs"), v("gp"), v("margin")]).toEqual(["₱3,770.00", "₱21,080.00", "84.8%"]);
    expect(el.querySelector('[data-role="profit"]').textContent).toMatch(/not net profit/);
    expect(el.querySelector('[data-section="trend"] svg.line-chart')).not.toBeNull();
    expect(el.querySelectorAll('[data-role="trend-table"] tbody tr')).toHaveLength(12);
    expect(el.querySelector('[data-row="household-payroll"]').textContent).toMatch(/14 subscriptions/);
    expect(el.querySelector('[data-role="due-list"]').textContent).toMatch(/ABC Trading/);
    expect(el.querySelector('[data-widget="total"] .stat-value').textContent).toBe("8");
    expect(el.querySelector('[data-widget="suspended"] .stat-value').textContent).toBe("1");
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
  });

  it("create business sends intent only (no entitlements, no permissions)", async () => {
    const call = vi.fn(async () => ({ businessId: "abc-test-trading", created: true }));
    const p = createBusinessDialog(ctxWith(call));
    const f = lastForm();
    for (const [k, v] of Object.entries({ name: "ABC Test Trading", businessId: " ABC-test-trading ", ownerEmail: "owner@abc.test", ownerName: "Abe" })) f.elements[k].value = v;
    submit(f);
    await p;
    const [action, body] = call.mock.calls[0];
    expect(action).toBe("createBusiness");
    expect(Object.keys(body.business).sort()).toEqual(["businessId", "name", "ownerEmail", "ownerName", "planId", "timezone", "workspaceTemplateId"]);
    expect(body.business.businessId).toBe("abc-test-trading");
  });

  it("detail: module table with selects only for the workspace's own modules; override / plan changes send id + choice + reason + revision", async () => {
    const call = vi.fn(async (action) => (action === "business" ? DETAIL : { adminRevision: 4 }));
    businessDetailView(el, ctxWith(call), "abc-test-trading");
    await flush();
    const row = (id) => el.querySelector(`[data-module="${id}"]`);
    expect(row("imports").textContent).toMatch(/Disabled/);
    expect(row("imports").querySelector("select")).not.toBeNull();
    expect(row("payroll").querySelector("select")).toBeNull();
    expect(row("payroll").textContent).toMatch(/not in this workspace/);
    const sel = row("imports").querySelector("select");
    sel.value = "default";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const f = lastForm();
    f.elements.reason.value = "Resume imports";
    submit(f);
    await flush();
    expect(call).toHaveBeenCalledWith("setModuleOverride", { businessId: "abc-test-trading", moduleId: "imports", choice: "default", reason: "Resume imports", expectedRevision: 3 });
    expect(el.querySelector('[data-member="u1"]').textContent).toMatch(/Account owner/);
    expect(el.querySelector('[data-member="u1"] [data-act="member-status"]')).toBeNull();
  });

  it("plans: grouped by workspace (each plan in its own workspace), with subscriber counts; read-only", async () => {
    plansView(el, ctxWith(vi.fn(async () => ({ subscribers: { growth: 8, "baby-plus": 3 } }))));
    await flush();
    const group = (w) => [...el.querySelectorAll(`[data-workspace="${w}"] [data-plan]`)].map((tr) => tr.dataset.plan);
    expect(group("distributor")).toEqual(["starter", "growth", "pro"]);
    expect(group("household-payroll")).toEqual(["household-basic", "household-plus"]);
    expect(group("baby-expense")).toEqual(["baby-basic", "baby-plus"]);
    expect(group("bridal-expense")).toEqual(["bridal-basic", "bridal-plus"]);
    expect(el.querySelector('[data-plan="growth"] [data-col="subscribers"]').textContent).toBe("8");
    expect(el.querySelector('[data-plan="baby-plus"]').textContent).toMatch(/₱249/);
    expect(el.querySelector('[data-plan="baby-plus"]').textContent).not.toMatch(/Orders|Inventory/);
    expect(el.querySelector("button[data-act]")).toBeNull();
  });
});

describe("tenant terminology in the business app", () => {
  it("a Distributor that calls customers Dealers sees 'Dealers' in the navigation (same path)", () => {
    const s = sessionFixture();
    s.config = resolveTenantConfig({ terminology: { customer: "dealer" } }, "distributor");
    renderShell(document.getElementById("app"), s);
    const link = [...document.querySelectorAll(".nav-link")].find((a) => a.getAttribute("href") === "/customers");
    expect(link.textContent.trim()).toBe("Dealers");
  });
});
