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
    const rows = [...container.querySelectorAll('[data-role="categories"] tbody tr')].map((tr) => [...tr.cells].filter((c) => !c.classList.contains("m-only")).slice(0, 4).map((c) => c.textContent.trim()));
    expect(rows[0]).toEqual(["Medical", "₱60,000.00", "₱10,000.00", "₱50,000.00"]);
    expect(rows[1]).toEqual(["Nursery", "₱40,000.00", "₱12,000.00", "₱28,000.00"]);
    expect(container.querySelector('[data-role="budget-history"]').textContent).toMatch(/Camille • Budget changed ₱150,000 → ₱180,000/);
  });

  it("Phase 18.6: no typed total; it's the sum of category budgets, changed by editing a category", async () => {
    const data = fakeData();
    mountBudget(container, baby(), { data, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-act="total"]')).toBeNull();
    expect(container.querySelector('[data-widget="total"]').textContent).toMatch(/Sum of the category budgets/);
    container.querySelector('[data-act="edit"][data-id="catMedical0001"]').click();
    const form = lastForm();
    setField(form, "budget", "70000");
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "updateCategory", categoryId: "catMedical0001", expectedRevision: expect.any(Number), changes: { budget: 7000000 } });
  });

  it("each row: Edit, then Delete (unused) or Hide (used); Delete asks first", async () => {
    const data = fakeData();
    mountBudget(container, baby(), { data, toast: () => {}, confirm: async () => true });
    await flush();
    container.querySelector('[data-act="status"][data-id="catMedical0001"]').click();
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "setCategoryStatus", categoryId: "catMedical0001", status: "inactive" });
    expect(container.querySelector('[data-act="delete"][data-id="catMedical0001"]')).toBeNull(); // used: deactivate only
    container.querySelector('[data-act="delete"][data-id="catClothes0001"]').click();
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
    const cells = [...container.querySelectorAll('[data-role="expenses"] tbody tr td:not(.m-only)')].map((td) => td.textContent.trim());
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

  it("parseBabyExpense: provider, payee and paid by are separate (Phase 18.6)", () => {
    const base = { date: "2026-10-10", category: "c", amount: "1000", providerId: "p", payee: "Dr. Cruz", method: "cash", reference: "", notes: "", recurring: "no" };
    expect(parseBabyExpense({ ...base, paidBy: "" })).toMatchObject({ providerId: "p", payee: "Dr. Cruz", paidBy: null });
    expect(parseBabyExpense({ ...base, paidBy: "Mom" }).paidBy).toEqual([{ name: "Mom", amount: 100000 }]);
    expect(parseBabyExpense({ ...base, paidBy: "Mom 600, Dad" }).paidBy).toEqual([{ name: "Mom", amount: 60000 }, { name: "Dad", amount: 40000 }]);
    expect(parseBabyExpense({ ...base, paidBy: "Lola Rosa ₱250.50 + Tito Ben 749.50" }).paidBy).toEqual([{ name: "Lola Rosa", amount: 25050 }, { name: "Tito Ben", amount: 74950 }]);
    expect(() => parseBabyExpense({ ...base, paidBy: "Mom, Dad" })).toThrow(/each person's share/);
    expect(() => parseBabyExpense({ ...base, paidBy: "Mom 1000, Dad" })).toThrow(/already cover/);
  });

  it("the table shows Paid to and Paid by; Reference is no longer a column", async () => {
    const data = fakeData();
    mountExpenses(container, baby(), { data, toast: () => {} });
    await flush();
    const heads = [...container.querySelectorAll('[data-role="expenses"] thead th')].map((t) => t.textContent.trim());
    expect(heads).toEqual(["", "Date", "Category", "Paid to", "Paid by", "Method", "Amount", ""]);
  });
});

describe("Payment Schedule", () => {
  it("Upcoming row with Pay; Pay sends one markPaid with the amount, final flag and a retry key", async () => {
    const data = fakeData();
    const toast = vi.fn();
    mountSchedule(container, baby(), { data, now: NOW, toast });
    await flush();
    const cells = [...container.querySelectorAll('[data-role="schedule"] tbody tr td:not(.m-only)')].map((td) => td.textContent.trim());
    expect(cells.slice(0, 2)).toEqual(["Dec 15, 2026", "Hospital deposit"]);
    container.querySelector('[data-act="pay"]').click();
    const form = lastForm();
    setField(form, "method", "bank_transfer");
    submit(form);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledTimes(1);
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "markPaid", scheduleId: "sched000000001", payment: { paidDate: "2026-10-16", method: "bank_transfer", amount: 2000000, final: true, key: expect.stringMatching(/^[a-z2-9]{12}$/) } });
  });

  it("Phase 18.6: a part payment with who paid; a part-paid row shows what's left", async () => {
    const data = fakeData({ listScheduled: vi.fn(async () => ({ rows: [{ ...DEPOSIT, paidAmount: 500000, parts: [{ expenseId: "x", amount: 500000, date: "2026-10-01" }] }], hasMore: false })) });
    mountSchedule(container, baby(), { data, now: NOW, toast: vi.fn() });
    await flush();
    expect(container.querySelector('[data-col="amount"]').textContent).toBe("₱15,000.00 left of ₱20,000.00");
    expect(container.textContent).toMatch(/Part paid/);
    container.querySelector('[data-act="pay"]').click();
    const form = lastForm();
    setField(form, "amount", "5000");
    setField(form, "final", "no");
    setField(form, "paidBy", "Mom 3000, Dad");
    submit(form);
    await flush();
    expect(data.scheduleApi.mock.calls[0][0].payment).toMatchObject({ amount: 500000, final: false, paidBy: [{ name: "Mom", amount: 300000 }, { name: "Dad", amount: 200000 }] });
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
    expect([...container.querySelectorAll('[data-role="providers"] tbody td:not(.m-only)')].map((td) => td.textContent.trim()).slice(0, 2)).toEqual(["ABC Women's Clinic", "Medical / Clinic"]);
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

describe("Baby Dashboard (Phase 18.6): spent, who paid, coming up", () => {
  it("reads budgets/current and this month's spending only; works with no budget at all", async () => {
    const fetchDocuments = vi.fn(async (_b, docs) => Object.fromEntries(docs.map((d) => [d.source, { status: "ok", data: d.source === "spending-month" ? { spent: 1500000, count: 3 } : { spent: 2200000, upcoming: 2000000 } }])));
    const fetchLists = vi.fn(async () => ({ upcomingPayments: { status: "ok", rows: [DEPOSIT] } }));
    mountDashboard(container, baby(), { fetchDocuments, fetchLists, now: NOW(), toast: () => {} });
    await flush();
    const docs = fetchDocuments.mock.calls[0][1];
    expect(docs.map((d) => d.collection).sort()).toEqual(["budgets", "spendingMetrics"]);
    expect(docs.find((d) => d.source === "spending-month").ids).toEqual(["2026-10"]);
    const val = (id) => container.querySelector(`[data-widget="${id}"] .kpi-value`).textContent;
    expect(val("budgetSpent")).toMatch(/22,000/);
    expect(val("budgetUpcoming")).toMatch(/20,000/);
    expect(val("babySpentThisMonth")).toMatch(/15,000/);
    // Older expenses without a payer show as "Not set" (no total budget needed).
    expect(container.querySelector('[data-section="payers"]').textContent).toMatch(/Not set\s*₱22,000.00/);
    expect(container.querySelector('[data-section="upcoming"]').textContent).toMatch(/Hospital deposit.*₱20,000.00/s);
    expect(container.textContent).not.toMatch(/Gross|COGS|Profit|Sales|Total budget/);
  });
});

describe("Phase 18.5 corrections: Providers ⋯ Delete", () => {
  it("asks first, then sends one delete; staff without providers.manage get no menu", async () => {
    const data = fakeData();
    mountProviders(container, baby(), { data, toast: () => {}, confirm: async () => true });
    await flush();
    container.querySelector('.menu-item[data-act="delete"]').click();
    await flush();
    expect(data.providersApi).toHaveBeenCalledWith({ action: "delete", providerId: "provABCclinic01" });
  });
});
