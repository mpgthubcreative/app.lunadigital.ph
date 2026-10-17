// @vitest-environment jsdom
// Luna Household money screens: Expenses ("Bridal Money for the household":
// month summary Spent / Bills remaining / Advances released / Cash out, By
// category with drill-down, one compact list incl. read-only payroll rows,
// ⋯ Edit / Details / Remove, Month / Category / Search), Bills (repeat,
// Pay -> expense + next bill), Categories (no budget anywhere), loaders.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountExpenses, shiftMonth, monthRange, parseHouseholdExpense, monthRows, categoryTotals } from "../../src/modules/household/expenses.js";
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
  { id: "catGroceries01", name: "Groceries", budget: null, status: "active", useCount: 3, revision: 1 },
  { id: "catUtilities01", name: "Utilities", budget: 600000, status: "active", useCount: 0, revision: 1 },
  { id: "catStaff000001", name: "Household Staff", budget: null, status: "active", useCount: 0, revision: 1 },
  { id: "catOld0000001", name: "Old stuff", budget: null, status: "inactive", useCount: 2, revision: 1 },
];
const EXP = { id: "expense0000001", date: "2026-10-05", category: "catGroceries01", amount: 250000, payee: "SM Supermarket", method: "cash", status: "active", revision: 1, history: [] };
const EXPS = [
  { ...EXP, id: "expense0000003", date: "2026-10-17", payee: "Puregold", amount: 325000 },
  { id: "expense0000002", date: "2026-10-15", category: "catUtilities01", amount: 480000, payee: "Meralco", method: "gcash", status: "active", revision: 1, history: [], scheduleId: "sched1" },
  EXP,
];
const MONTH = { month: "2026-10", current: true, spent: 1611500, expensesSpent: 1055000, staffPaid: 556500, staffPayments: 1, billsRemaining: 450000, billsDue: 1, payroll: [{ id: "pay1", staffName: "Loriza", amount: 556500, paidDate: "2026-10-15" }], advancesReleased: 300000, advanceCount: 1, cashOut: 1911500, categories: [], byCategory: { catGroceries01: 575000, catUtilities01: 480000 } };
const BILL = { id: "sched000000001", description: "Meralco", category: "catUtilities01", amount: 450000, dueDate: "2026-10-20", status: "upcoming", repeat: { every: "month", interval: 1 }, revision: 1, history: [] };

function fakeData(extra = {}) {
  return {
    householdMonth: vi.fn(async () => MONTH),
    listCategories: vi.fn(async () => CATS.map((c) => ({ ...c }))),
    listExpenses: vi.fn(async () => ({ rows: EXPS.map((e) => ({ ...e })), hasMore: false })),
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
  it("Luna Household owner: Expenses, Bills, Categories routes; no Providers; no Budget in the navigation; the loaders pick the Household screens", async () => {
    expect(buildRoutes(home()).map((r) => r.label).join(" ")).not.toMatch(/Budget/);
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

const $ = (sel) => container.querySelector(sel);
const $$ = (sel) => [...container.querySelectorAll(sel)];
const rowTexts = () => $$('[data-role="expenses"] .wl-row').map((r) => r.textContent.replace(/\s+/g, " ").trim());
const mountExp = async (data = fakeData()) => {
  mountExpenses(container, home(), { data, now: NOW, location: { search: "" } });
  await flush();
  return data;
};

describe("Expenses", () => {
  it("month summary: Spent, Bills remaining, Advances released, Cash out; no budget anywhere", async () => {
    const data = await mountExp();
    expect(data.listExpenses).toHaveBeenCalledWith(expect.any(String), { status: "active", from: "2026-10-01", to: "2026-10-31" }, expect.objectContaining({ pageSize: 500 }));
    const kpis = $('[data-role="month-summary"]').textContent.replace(/\s+/g, " ");
    for (const t of ["Spent ₱16,115", "incl. ₱5,565.00 payroll", "Bills remaining ₱4,500", "Advances released ₱3,000", "Cash out ₱19,115"]) expect(kpis).toContain(t);
    expect(container.textContent).not.toMatch(/budget/i);
    expect($('[data-act="set-budget"]')).toBeNull();
    expect($('[data-role="month"]').textContent).toBe("October 2026");
    expect($('[data-act="month-next"]').disabled).toBe(true);
  });

  it("one compact list, newest first: expense rows with ⋯ (Edit / Details / Remove), the salary as a read-only Household Staff · Payroll row", async () => {
    await mountExp();
    const rows = $$('[data-role="expenses"] .wl-row');
    expect(rows.map((r) => r.dataset.kind)).toEqual(["expense", "expense", "payroll", "expense"]);
    expect(rowTexts()[0]).toMatch(/Groceries.*Puregold.*₱3,250\.00.*Oct 17/);
    expect(rowTexts()[2]).toMatch(/Household Staff.*Payroll · Loriza.*₱5,565\.00.*Oct 15/);
    expect(rows[2].querySelector(".line-menu")).toBeNull();
    expect([...rows[0].querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Edit", "Details", "Remove"]);
  });

  it("By category: totals from the same rows (expenses + payroll; advances never), largest first", async () => {
    await mountExp();
    const cats = $$('[data-role="category-totals"] .hx-cat-btn').map((b) => b.textContent.replace(/\s+/g, " ").trim());
    expect(cats).toEqual(["Groceries₱5,750.00›", "Household Staff₱5,565.00›", "Utilities₱4,800.00›"]);
    expect(container.querySelector('[data-role="category-totals"]').textContent).not.toMatch(/Advance/);
  });

  it("tapping Groceries filters to October's grocery expenses with the total; ‹ All expenses restores the full list", async () => {
    await mountExp();
    $('[data-act="cat"][data-cat="catGroceries01"]').click();
    expect($('[data-role="drill-title"]').textContent).toBe("Groceries — October");
    expect($('[data-role="drill-total"]').textContent.replace(/\s+/g, " ")).toBe("₱5,750.00 total");
    expect(rowTexts().map((t) => t.match(/(Puregold|SM Supermarket)/)[1])).toEqual(["Puregold", "SM Supermarket"]);
    expect($('[data-role="category-totals"]')).toBeNull();
    expect($('select[name="category"]').value).toBe("catGroceries01");
    $('[data-act="clear-cat"]').click();
    expect($$('[data-role="expenses"] .wl-row')).toHaveLength(4);
    expect($('[data-role="drill"]')).toBeNull();
  });

  it("Household Staff drill-down shows the payroll row; the Category filter and Search narrow the same list", async () => {
    await mountExp();
    $('[data-act="cat"][data-cat="catStaff000001"]').click();
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toMatch(/Payroll · Loriza/);
    $('[data-act="clear-cat"]').click();
    const sel = $('select[name="category"]');
    sel.value = "catUtilities01";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(rowTexts()).toHaveLength(1);
    $('[data-act="clear-cat"]').click();
    const search = $('input[name="search"]');
    search.value = "pure";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toMatch(/Puregold/);
  });

  it("monthRows / categoryTotals: no Household Staff category -> payroll gets its own Household Staff group", () => {
    const rows = monthRows([EXP], [{ id: "p", staffName: "Ana", amount: 100, paidDate: "2026-10-01" }], [CATS[0]]);
    expect(categoryTotals(rows)).toEqual([{ key: "catGroceries01", name: "Groceries", amount: 250000, count: 1 }, { key: "payroll", name: "Household Staff", amount: 100, count: 1 }]);
  });

  it("+ Add expense: Amount, Category, Date up front; payee, method, reference, notes, proof under More details", async () => {
    const data = await mountExp();
    $('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    const visible = [...form.querySelectorAll("input, select, textarea")].filter((e) => !e.closest("details:not([open])")).map((e) => e.name);
    expect(visible).toEqual(["amount", "category", "date"]);
    expect([...form.querySelectorAll("details input, details select, details textarea")].map((e) => e.name)).toEqual(["payee", "method", "reference", "notes", "proof"]);
    form.elements.amount.value = "1,299.50";
    form.elements.category.value = "Pets";
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "createCategory", category: { name: "Pets", budget: null } });
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", expense: { date: "2026-10-16", amount: 129950, method: "cash", category: "catNew0000001" } });
  });

  it("⋯ Edit and Remove work on the row's expense; Details is read-only", async () => {
    const data = await mountExp();
    $('[data-row="expense0000003"] [data-act="edit"]').click();
    await flush();
    const f = lastForm();
    f.elements.amount.value = "3300";
    submit(f);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "update", expenseId: "expense0000003", expectedRevision: 1, changes: { amount: 330000 } });
    $('[data-row="expense0000003"] [data-act="view"]').click();
    expect(document.querySelector('[data-role="details"]').textContent).toContain("Puregold");
    expect(document.querySelector('[data-role="details"] [data-act="edit"]')).toBeNull();
  });

  it("⋯ → Manage categories (no Budget); previous month reloads that month", async () => {
    const data = await mountExp();
    expect($('[data-role="manage-categories"]').getAttribute("href")).toBe("/budget");
    expect($('[data-role="manage-categories"]').textContent).toBe("Manage categories");
    $('[data-act="month-prev"]').click();
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

describe("Categories", () => {
  it("names only: add, rename, hide a used one, delete an unused one; hidden ones folded; no budget figures", async () => {
    const data = fakeData();
    mountBudget(container, home(), { data, confirm: async () => true });
    await flush();
    expect($('h1, .page-title')?.textContent ?? container.textContent).toMatch(/Categories/);
    expect(container.textContent).not.toMatch(/budget|₱/i);
    expect($$('[data-role="categories"] .wl-name').map((e) => e.textContent.trim())).toEqual(["Groceries", "Utilities", "Household Staff"]);
    expect($('[data-role="hidden"] summary').textContent).toBe("Hidden (1)");
    expect($('[data-category="catGroceries01"] [data-act="status"]').textContent).toBe("Hide");
    $('[data-category="catUtilities01"] [data-act="delete"]').click();
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "deleteCategory", categoryId: "catUtilities01" });
    $('[data-category="catGroceries01"] [data-act="edit"]').click();
    await flush();
    const f = lastForm();
    f.elements.name.value = "Groceries & Market";
    submit(f);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "updateCategory", categoryId: "catGroceries01", expectedRevision: 1, changes: { name: "Groceries & Market" } });
    $('[data-act="new"]').click();
    await flush();
    const n = lastForm();
    expect([...n.elements].filter((e) => e.name).map((e) => e.name)).toEqual(["name"]);
  });
});
