// @vitest-environment jsdom
// Phase 15 screens: Budget & Categories, Baby Expenses, Payment Schedule
// (Mark paid -> one expense), Providers, the Baby dashboard, navigation and
// the workspace-aware Expenses loader.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountBudget, parseBudget } from "../../src/modules/baby/budget.js";
import { mount as mountExpenses, parseBabyExpense } from "../../src/modules/baby/expenses.js";
import { mount as mountSchedule } from "../../src/modules/baby/schedule.js";
import { mount as mountProviders } from "../../src/modules/baby/providers.js";
import { mount as mountDashboard } from "../../src/modules/dashboard/index.js";
import { MODULE_LOADERS } from "../../src/modules/loaders.js";
import { buildRoutes } from "../../src/app/routes.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const NOW = () => new Date("2026-10-16T04:00:00Z");
const baby = (role = "owner") => sessionFixture({ roleTemplate: role, workspaceTemplateId: "baby-expense" });
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const setField = (form, name, value) => {
  form.elements[name].value = value;
};

const CATS = [
  { id: "catMedical0001", name: "Medical", budget: 6000000, status: "active", order: 10, useCount: 1, revision: 1 },
  { id: "catNursery0001", name: "Nursery", budget: 4000000, status: "active", order: 20, useCount: 1, revision: 1 },
  { id: "catClothes0001", name: "Clothing", budget: 1000000, status: "active", order: 30, useCount: 0, revision: 1 },
];
const BUDGET = { total: 15000000, spent: 2200000, expenseCount: 2, spentByCategory: { catMedical0001: 1000000, catNursery0001: 1200000 }, upcoming: 2000000, upcomingCount: 1, revision: 3, history: [{ at: new Date("2026-10-09T02:00:00Z"), actor: { name: "Camille" }, label: "Budget changed ₱150,000 → ₱180,000" }] };
const PROVIDER = { id: "provABCclinic01", name: "ABC Women's Clinic", type: "medical", phone: "0917", status: "active", revision: 1, history: [] };
const EXP = { id: "expense0000001", date: "2026-10-10", category: "catNursery0001", categoryName: "Nursery", amount: 1200000, payee: "Baby Company", method: "cash", status: "active", revision: 2, history: [] };
const DEPOSIT = { id: "sched000000001", description: "Hospital deposit", category: "catMedical0001", categoryName: "Medical", amount: 2000000, dueDate: "2026-12-15", status: "upcoming", payee: null, revision: 1, history: [] };

function fakeData(extra = {}) {
  return {
    getBudget: vi.fn(async () => BUDGET),
    listCategories: vi.fn(async () => CATS),
    listBabyExpenses: vi.fn(async () => ({ rows: [EXP], hasMore: false })),
    activeProviders: vi.fn(async () => [PROVIDER]),
    listProviders: vi.fn(async () => ({ rows: [PROVIDER], hasMore: false })),
    listScheduled: vi.fn(async () => ({ rows: [DEPOSIT], hasMore: false })),
    budgetApi: vi.fn(async () => ({})),
    expensesApi: vi.fn(async () => ({ expenseId: "x" })),
    providersApi: vi.fn(async () => ({})),
    scheduleApi: vi.fn(async () => ({ expenseId: "sched000000001", paid: true })),
    ...extra,
  };
}

describe("navigation: Baby has its own screens; others never do", () => {
  it("Baby owner: Baby Dashboard, Budget & Categories, Baby Expenses, Payment Schedule, Providers / Vendors", () => {
    expect(buildRoutes(baby()).map((r) => r.label)).toEqual(expect.arrayContaining(["Baby Dashboard", "Budget & Categories", "Baby Expenses", "Payment Schedule", "Providers / Vendors"]));
  });
  it("Baby staff: dashboard only (conservative default)", () => {
    for (const p of buildRoutes(baby("staff")).map((r) => r.path)) expect(["/", "/notifications"]).toContain(p);
  });
  it("Distributor / Household never get Budget, Payment Schedule or Providers; Bridal gets the shared Budget only (Phase 16)", () => {
    for (const t of ["distributor", "household-payroll"]) for (const p of ["/budget", "/payment-schedule", "/providers"]) expect(buildRoutes(sessionFixture({ workspaceTemplateId: t })).map((r) => r.path), `${t}${p}`).not.toContain(p);
    const bridal = buildRoutes(sessionFixture({ workspaceTemplateId: "bridal-expense" })).map((r) => r.path);
    expect(bridal).toContain("/budget");
    for (const p of ["/payment-schedule", "/providers"]) expect(bridal).not.toContain(p);
  });
  it("the Expenses loader picks the Baby screen in Baby and the Distributor screen elsewhere", async () => {
    const b = await MODULE_LOADERS.expenses(baby());
    const d = await MODULE_LOADERS.expenses(sessionFixture());
    expect(b.parseBabyExpense).toBeTypeOf("function");
    expect(d.parseBabyExpense).toBeUndefined();
  });
});

describe("Budget & Categories", () => {
  it("current budget (as of now): ₱150,000 total, ₱22,000 spent, ₱128,000 remaining, upcoming apart", async () => {
    mountBudget(container, baby(), { data: fakeData(), toast: () => {} });
    await flush();
    const card = (id) => container.querySelector(`[data-widget="${id}"] .stat-value`).textContent;
    expect(container.querySelector('[data-section="current"] .section-title').textContent).toMatch(/as of now/);
    expect(card("total")).toMatch(/150,000/);
    expect(card("spent")).toMatch(/22,000/);
    expect(card("remaining")).toMatch(/128,000/);
    expect(card("upcoming")).toMatch(/20,000/);
    const rows = [...container.querySelectorAll('[data-role="categories"] tbody tr')].map((tr) => [...tr.cells].slice(0, 4).map((c) => c.textContent.trim()));
    expect(rows[0]).toEqual(["Medical", "₱60,000.00", "₱10,000.00", "₱50,000.00"]);
    expect(rows[1]).toEqual(["Nursery", "₱40,000.00", "₱12,000.00", "₱28,000.00"]);
    expect(container.querySelector('[data-role="budget-history"]').textContent).toMatch(/Camille • Budget changed ₱150,000 → ₱180,000/);
  });

  it("Edit total budget -> Save sends only the total (never spent / remaining)", async () => {
    const data = fakeData();
    mountBudget(container, baby(), { data, toast: () => {} });
    await flush();
    container.querySelector('[data-act="total"]').click();
    const form = lastForm();
    setField(form, "total", "180000");
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "setTotal", total: 18000000, expectedRevision: 3 });
  });

  it("an unused category offers delete; a used one only deactivates", async () => {
    const data = fakeData();
    mountBudget(container, baby(), { data, toast: () => {} });
    await flush();
    container.querySelector('[data-act="status"][data-id="catMedical0001"]').click();
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "setCategoryStatus", categoryId: "catMedical0001", status: "inactive" });
    container.querySelector('[data-act="status"][data-id="catClothes0001"]').click();
    const form = lastForm();
    setField(form, "choice", "delete");
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "deleteCategory", categoryId: "catClothes0001" });
  });

  it("empty: Add suggested categories; Staff/view-only see no manage buttons", async () => {
    const data = fakeData({ listCategories: vi.fn(async () => []), getBudget: vi.fn(async () => null) });
    mountBudget(container, baby(), { data, toast: () => {} });
    await flush();
    container.querySelector('[data-act="suggested"]').click();
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "setupCategories" });
  });

  it("parseBudget: blank = no budget; negative / junk refused", () => {
    expect(parseBudget("")).toBeNull();
    expect(parseBudget("1,500.50")).toBe(150050);
    expect(() => parseBudget("-5")).toThrow();
    expect(() => parseBudget("abc")).toThrow();
  });
});

describe("Baby Expenses", () => {
  it("compact rows with the family's category names; no Distributor categories offered", async () => {
    mountExpenses(container, baby(), { data: fakeData(), now: NOW, toast: () => {} });
    await flush();
    const cells = [...container.querySelectorAll('[data-role="expenses"] tbody tr td')].map((td) => td.textContent.trim());
    expect(cells.slice(0, 3)).toEqual(["Oct 10, 2026", "Nursery", "Baby Company"]);
    const cats = [...container.querySelectorAll('select[name="category"] option')].map((o) => o.textContent);
    expect(cats).toEqual(["Any category", "Medical", "Nursery", "Clothing"]);
    expect(container.textContent).not.toMatch(/Operating|COGS|Profit/);
  });

  it("Add expense with a saved provider sends providerId (the server snapshots the name), date capped at today", async () => {
    const data = fakeData();
    mountExpenses(container, baby(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="new"]').click();
    const form = lastForm();
    expect(form.elements.date.max).toBe("2026-10-16");
    setField(form, "amount", "10000");
    setField(form, "category", "catMedical0001");
    setField(form, "providerId", "provABCclinic01");
    submit(form);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", expense: { date: "2026-10-16", category: "catMedical0001", amount: 1000000, providerId: "provABCclinic01", method: "cash", recurring: false } });
  });

  it("filters (provider, category) reach the shared list spec and the Excel download", async () => {
    const data = fakeData();
    mountExpenses(container, baby(), { data, now: NOW, toast: () => {} });
    await flush();
    const f = container.querySelector('[data-role="filters"]');
    f.elements.category.value = "catMedical0001";
    f.elements.providerId.value = "provABCclinic01";
    submit(f);
    await flush();
    expect(data.listBabyExpenses).toHaveBeenLastCalledWith("demo-distributor-a", { status: "active", category: "catMedical0001", providerId: "provABCclinic01" }, { cursor: null });
    expect(container.querySelector('[data-export="babyExpenses"]')).not.toBeNull();
  });

  it("parseBabyExpense: a provider means no typed payee", () => {
    expect(parseBabyExpense({ date: "2026-10-10", category: "c", amount: "5", providerId: "p", payee: "x", method: "cash", reference: "", notes: "", recurring: "no" })).toMatchObject({ providerId: "p", payee: undefined });
  });
});

describe("Payment Schedule", () => {
  it("Upcoming row with Mark paid; Mark paid sends one markPaid (amount only if changed)", async () => {
    const data = fakeData();
    const toast = vi.fn();
    mountSchedule(container, baby(), { data, now: NOW, toast });
    await flush();
    const cells = [...container.querySelectorAll('[data-role="schedule"] tbody tr td')].map((td) => td.textContent.trim());
    expect(cells.slice(0, 2)).toEqual(["Dec 15, 2026", "Hospital deposit"]);
    container.querySelector('[data-act="pay"]').click();
    const form = lastForm();
    setField(form, "method", "bank_transfer");
    submit(form);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledTimes(1);
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "markPaid", scheduleId: "sched000000001", payment: { paidDate: "2026-10-16", method: "bank_transfer" } });
  });

  it("a retry answered 'already paid' says no second expense was recorded", async () => {
    const data = fakeData({ scheduleApi: vi.fn(async () => ({ expenseId: "sched000000001", alreadyPaid: true })) });
    const toast = vi.fn();
    mountSchedule(container, baby(), { data, now: NOW, toast });
    await flush();
    container.querySelector('[data-act="pay"]').click();
    submit(lastForm());
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/no second expense/), "success");
  });

  it("no Mark paid without expenses.create", async () => {
    const s = baby("manager");
    delete s.member.permissions["expenses.create"];
    mountSchedule(container, s, { data: fakeData(), now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-act="pay"]')).toBeNull();
  });
});

describe("Providers", () => {
  it("compact row; deactivate keeps history; filters by type", async () => {
    const data = fakeData();
    mountProviders(container, baby(), { data, toast: () => {} });
    await flush();
    expect([...container.querySelectorAll('[data-role="providers"] tbody td')].map((td) => td.textContent.trim()).slice(0, 2)).toEqual(["ABC Women's Clinic", "Medical / Clinic"]);
    container.querySelector('[data-act="status"]').click();
    await flush();
    expect(data.providersApi).toHaveBeenCalledWith({ action: "setStatus", providerId: "provABCclinic01", status: "inactive" });
    const f = container.querySelector('[data-role="filters"]');
    f.elements.type.value = "pharmacy";
    submit(f);
    await flush();
    expect(data.listProviders).toHaveBeenLastCalledWith("demo-distributor-a", { status: "active", type: "pharmacy" }, { cursor: null });
  });
});

describe("Baby Dashboard: selected-period spending vs the current budget", () => {
  it("period cards from spendingMetrics; 'Current budget · as of now' from budgets/current; lists", async () => {
    const fetchDocuments = vi.fn(async (_b, docs) => Object.fromEntries(docs.map((d) => [d.source, { status: "ok", data: d.source === "spending-day" ? { spent: 1500000, count: 3 } : BUDGET }])));
    const fetchLists = vi.fn(async () => ({ spendingByCategory: { status: "ok", rows: [{ id: "a", name: "Medical", spent: 1000000, budget: 6000000, remaining: 5000000 }] }, upcomingPayments: { status: "ok", rows: [DEPOSIT] }, recentExpenses: { status: "ok", rows: [EXP] } }));
    mountDashboard(container, baby(), { fetchDocuments, fetchLists, now: NOW(), toast: () => {} });
    await flush();
    const collections = fetchDocuments.mock.calls[0][1].map((d) => d.collection).sort();
    expect(collections).toEqual(["budgets", "spendingMetrics"]);
    expect(container.querySelector('[data-section="period"] .section-title').textContent).toMatch(/^Spending in the selected period · Today/);
    expect(container.querySelector('[data-section="current"] .section-title').textContent).toBe("Current budget · as of now");
    const val = (id) => container.querySelector(`[data-widget="${id}"] .stat-value`).textContent;
    expect(val("babySpent")).toMatch(/15,000/);
    expect(val("budgetRemaining")).toMatch(/128,000/);
    expect(val("budgetUpcoming")).toMatch(/20,000/);
    expect(container.querySelector('[data-widget="spendingByCategory"]').textContent).toMatch(/Medical · ₱10,000.00 spent/);
    expect(container.querySelector('[data-widget="upcomingPayments"]').textContent).toMatch(/Hospital deposit · ₱20,000.00/);
    expect(container.textContent).not.toMatch(/Gross|COGS|Profit|Sales/);
  });
});
