// @vitest-environment jsdom
// Luna Household money screens (household-payroll v3): Expenses (the month
// summary, categories incl. payroll under Household Staff, + Add expense),
// Bills (repeat, Pay -> expense + next bill) and Budget & Categories, and
// the workspace-aware loaders.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountExpenses, shiftMonth, monthRange, parseHouseholdExpense } from "../../src/modules/household/expenses.js";
import { mount as mountBills, parseRepeat, repeatValue } from "../../src/modules/household/bills.js";
import { mount as mountBudget } from "../../src/modules/household/budget.js";
import { MODULE_LOADERS } from "../../src/modules/loaders.js";
import { buildRoutes } from "../../src/app/routes.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const NOW = () => new Date("2026-10-16T04:00:00Z");
const home = (role = "owner") => sessionFixture({ roleTemplate: role, workspaceTemplateId: "household-payroll" });
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const click = (sel) => container.querySelector(sel).click();

const CATS = [
  { id: "catGroceries01", name: "Groceries", budget: null, status: "active", useCount: 1, revision: 1 },
  { id: "catUtilities01", name: "Utilities", budget: 600000, status: "active", useCount: 0, revision: 1 },
];
const EXP = { id: "expense0000001", date: "2026-10-05", category: "catGroceries01", amount: 250000, payee: "SM Supermarket", method: "cash", status: "active", revision: 1, history: [] };
const MONTH = { month: "2026-10", current: true, spent: 806500, expensesSpent: 250000, staffPaid: 556500, staffPayments: 1, billsRemaining: 450000, billsDue: 1, payrollDue: 500000, budget: 3000000, left: 1243500, categories: [{ name: "Household Staff", amount: 556500, payroll: 556500 }, { name: "Groceries", amount: 250000 }], byCategory: { catGroceries01: 250000 } };
const BILL = { id: "sched000000001", description: "Meralco", category: "catUtilities01", amount: 450000, dueDate: "2026-10-20", status: "upcoming", repeat: { every: "month", interval: 1 }, revision: 1, history: [] };

function fakeData(extra = {}) {
  return {
    householdMonth: vi.fn(async () => MONTH),
    listCategories: vi.fn(async () => CATS.map((c) => ({ ...c }))),
    listExpenses: vi.fn(async () => ({ rows: [EXP], hasMore: false })),
    listBills: vi.fn(async () => ({ rows: [BILL], hasMore: false })),
    budgetApi: vi.fn(async () => ({ categoryId: "catNew0000001" })),
    expensesApi: vi.fn(async () => ({ expenseId: "expNew0000001" })),
    scheduleApi: vi.fn(async () => ({ expenseId: "expBill000001", paid: true, nextScheduleId: "schedNext00001" })),
    attachExpenseProof: vi.fn(async () => ({})),
    expenseProof: vi.fn(async () => ({ proof: null })),
    ...extra,
  };
}

describe("navigation", () => {
  it("Luna Household owner: Expenses, Bills, Budget & Categories routes; no Providers; the loaders pick the Household screens", async () => {
    const paths = buildRoutes(home()).map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/expenses", "/payment-schedule", "/budget"]));
    expect(paths).not.toContain("/providers");
    expect((await MODULE_LOADERS.expenses(home())).mount).toBe(mountExpenses);
    expect((await MODULE_LOADERS.schedule(home())).mount).toBe(mountBills);
    expect((await MODULE_LOADERS.budget(home())).mount).toBe(mountBudget);
  });
  it("a kasambahay's account gets none of the money screens", () => {
    const paths = buildRoutes(home("household_staff")).map((r) => r.path);
    for (const p of ["/expenses", "/payment-schedule", "/budget"]) expect(paths).not.toContain(p);
  });
});

describe("Expenses", () => {
  it("shows the month: Spent (incl. staff pay), Bills remaining, Payroll due, Budget left; payroll under Household Staff; this month's expenses", async () => {
    const data = fakeData();
    mountExpenses(container, home(), { data, now: NOW });
    await flush();
    expect(data.listExpenses).toHaveBeenCalledWith(expect.any(String), { status: "active", from: "2026-10-01", to: "2026-10-31" }, expect.anything());
    const kpis = container.querySelector('[data-role="month-summary"]').textContent;
    for (const t of ["Spent", "₱8,065", "staff pay", "Bills remaining", "₱4,500", "Payroll due", "₱5,000", "Budget left", "₱12,435", "of ₱30,000"]) expect(kpis).toContain(t);
    expect(container.querySelector('[data-role="category-bars"]').textContent).toContain("Household Staff (incl. payroll)");
    expect(container.querySelector('[data-role="expenses"]').textContent).toContain("SM Supermarket");
    expect(container.querySelector('[data-role="month"]').textContent).toBe("October 2026");
    expect(container.querySelector('[data-act="month-next"]').disabled).toBe(true);
  });

  it("+ Add expense: Amount, Category, Date up front; a new category name is created on save", async () => {
    const data = fakeData();
    mountExpenses(container, home(), { data, now: NOW });
    await flush();
    click('[data-act="new"]');
    await flush();
    const form = lastForm();
    form.elements.amount.value = "1,299.50";
    form.elements.category.value = "Pets";
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "createCategory", category: { name: "Pets", budget: null } });
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", expense: { date: "2026-10-16", amount: 129950, method: "cash", category: "catNew0000001" } });
  });

  it("previous month reloads that month", async () => {
    const data = fakeData();
    mountExpenses(container, home(), { data, now: NOW });
    await flush();
    click('[data-act="month-prev"]');
    await flush();
    expect(data.householdMonth).toHaveBeenLastCalledWith("2026-09");
    expect(data.listExpenses).toHaveBeenLastCalledWith(expect.any(String), { status: "active", from: "2026-09-01", to: "2026-09-30" }, expect.anything());
  });

  it("month helpers and parsing", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(() => parseHouseholdExpense({ amount: "0", date: "2026-10-01" })).toThrow(/more than ₱0/);
  });
});

describe("Bills", () => {
  it("lists bills with their repeat; Pay records the expense and says the next one is added", async () => {
    const data = fakeData();
    mountBills(container, home(), { data, now: NOW });
    await flush();
    expect(container.querySelector('[data-col="repeat"]').textContent).toBe("Every month");
    click('[data-act="pay"]');
    await flush();
    const form = lastForm();
    expect(form.closest(".modal").textContent).toContain("the next one (every month) is added");
    submit(form);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "markPaid", scheduleId: "sched000000001", payment: expect.objectContaining({ amount: 450000, final: true, method: "cash", paidDate: "2026-10-16" }) });
  });

  it("+ Add bill defaults to monthly and sends the repeat", async () => {
    const data = fakeData();
    mountBills(container, home(), { data, now: NOW });
    await flush();
    click('[data-act="new"]');
    await flush();
    const form = lastForm();
    form.elements.description.value = "Internet";
    form.elements.amount.value = "1699";
    form.elements.dueDate.value = "2026-10-25";
    submit(form);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "create", payment: { description: "Internet", amount: 169900, dueDate: "2026-10-25", repeat: { every: "month", interval: 1 }, category: "catUtilities01" } });
  });

  it("repeat helpers", () => {
    expect(parseRepeat("")).toBeNull();
    expect(parseRepeat("month:3")).toEqual({ every: "month", interval: 3 });
    expect(repeatValue({ every: "week", interval: 2 })).toBe("week:2");
  });
});

describe("Budget & Categories", () => {
  it("monthly budget and this month's spending per category; Set monthly budget sends setTotal", async () => {
    const data = fakeData();
    mountBudget(container, home(), { data, now: NOW });
    await flush();
    expect(container.querySelector('[data-role="budget-summary"]').textContent).toContain("₱30,000");
    expect(container.querySelector('[data-category="catGroceries01"]').textContent).toContain("₱2,500");
    click('[data-act="set-budget"]');
    await flush();
    const form = lastForm();
    form.elements.total.value = "35000";
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "setTotal", total: 3500000 });
  });
});
