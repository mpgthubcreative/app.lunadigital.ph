// @vitest-environment jsdom
// Luna Household money screens: Expenses as a household statement (Spent +
// Bills remaining only; category groups ARE the list: expenses, read-only
// payroll rows and unpaid bills under their category; bill ⋯ Paid / Edit /
// Remove, paid bill ⋯ Mark unpaid / Edit / Remove), Bills (recurring bills:
// name, amount, category, due date, repeat), Categories (no budget), loaders.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountExpenses, shiftMonth, monthRange, parseHouseholdExpense, monthRows, groupRows, dueBills } from "../../src/modules/household/expenses.js";
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
  { id: "expense0000002", date: "2026-10-15", category: "catUtilities01", amount: 300000, payee: "Parking", method: "gcash", status: "active", revision: 1, history: [], scheduleId: "schedPark0001" },
  EXP,
];
const MONTH = { month: "2026-10", current: true, spent: 1431500, expensesSpent: 875000, staffPaid: 556500, staffPayments: 1, billsRemaining: 450000, billsDue: 1, payroll: [{ id: "pay1", staffName: "Loriza", amount: 556500, paidDate: "2026-10-15" }], advancesReleased: 300000, advanceCount: 1, cashOut: 1911500, categories: [], byCategory: { catGroceries01: 575000, catUtilities01: 480000 } };
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
const flat = (el) => el.textContent.replace(/\s+/g, " ").trim();
const mountExp = async (data = fakeData()) => {
  mountExpenses(container, home(), { data, now: NOW, location: { search: "" }, confirm: async () => true, toast: () => {} });
  await flush();
  return data;
};
const group = (key) => $(`[data-group="${key}"]`);
const peso = (t) => Math.round(Number(t.replace(/[₱,]/g, "")) * 100);

describe("Expenses (household statement)", () => {
  it("top: the month and only Spent + Bills remaining; no search, advances, cash out, By category or separate Expenses list", async () => {
    const data = await mountExp();
    expect(data.listExpenses).toHaveBeenCalledWith(expect.any(String), { status: "active", from: "2026-10-01", to: "2026-10-31" }, expect.objectContaining({ pageSize: 500 }));
    expect(data.listBills).toHaveBeenCalledWith(expect.any(String), { status: "upcoming", to: "2026-10-31" }, expect.anything());
    expect($('[data-role="month"]').textContent).toBe("October 2026");
    expect($$('[data-role="month-summary"] .kpi-label').map((e) => e.textContent)).toEqual(["Spent", "Bills remaining"]);
    expect(flat($('[data-role="month-summary"]'))).toContain("₱14,315.00");
    expect($('input[type="search"], input[name="search"]')).toBeNull();
    expect($('select[name="category"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Advances released|Cash out|By category|budget/i);
    expect($('[data-role="category-totals"]')).toBeNull();
    expect($('[data-role="expenses"]')).toBeNull();
  });

  it("categories ARE the list: groups by total (largest first), each with its rows; the category isn't repeated in rows", async () => {
    await mountExp();
    const heads = $$(".hx-group-head").map(flat);
    expect(heads).toEqual(["Utilities₱7,500.00", "Groceries₱5,750.00", "Household Staff₱5,565.00"]);
    expect($$('[data-group="catUtilities01"] .wl-name').map((e) => e.textContent)).toEqual(["Meralco", "Parking"]);
    expect($$('[data-group="catGroceries01"] .wl-name').map((e) => e.textContent)).toEqual(["Puregold", "SM Supermarket"]);
    for (const r of $$(".hx-row")) expect(r.querySelector(".wl-name").textContent).not.toMatch(/^(Utilities|Groceries)$/);
  });

  it("each group total = the sum of its visible rows; all groups = Spent + Bills remaining", async () => {
    await mountExp();
    let all = 0;
    for (const g of $$(".hx-group")) {
      const rows = [...g.querySelectorAll(".hx-amt")].reduce((t, e) => t + peso(e.textContent), 0);
      expect(peso(g.querySelector('[data-role="group-total"]').textContent), g.dataset.group).toBe(rows);
      all += rows;
    }
    expect(all).toBe(MONTH.spent + MONTH.billsRemaining);
  });

  it("payroll: one read-only row under Household Staff (no ⋯)", async () => {
    await mountExp();
    const rows = $$('[data-kind="payroll"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].closest("[data-group]").dataset.group).toBe("catStaff000001");
    expect(flat(rows[0])).toMatch(/Payroll · Loriza.*Oct 15.*₱5,565\.00/);
    expect(rows[0].querySelector(".line-menu")).toBeNull();
  });

  it("an unpaid bill sits under its category: Due Oct 20, ⋯ Paid / Edit / Remove; Paid records it once (cash, today, full, a key)", async () => {
    const data = await mountExp();
    const bill = $('[data-kind="bill-due"]');
    expect(flat(bill)).toMatch(/Meralco.*Due Oct 20.*₱4,500\.00/);
    expect([...bill.querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Paid", "Edit", "Remove"]);
    bill.querySelector('[data-act="bill-paid"]').click();
    bill.querySelector('[data-act="bill-paid"]').click(); // a double tap sends once
    await flush();
    const calls = data.scheduleApi.mock.calls.filter(([b]) => b.action === "markPaid");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ action: "markPaid", scheduleId: "sched000000001", payment: { method: "cash", amount: 450000, paidDate: "2026-10-16", final: true } });
    expect(calls[0][0].payment.key).toMatch(/^[a-z2-9]{12}$/);
  });

  it("a paid bill: Paid · Oct 15, ⋯ Mark unpaid / Edit / Remove; Mark unpaid removes its expense (the bill reopens)", async () => {
    const data = await mountExp();
    const paid = $('[data-kind="bill-paid"]');
    expect(flat(paid)).toMatch(/Parking.*Paid · Oct 15.*₱3,000\.00/);
    expect([...paid.querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Mark unpaid", "Edit", "Remove"]);
    paid.querySelector('[data-act="bill-unpaid"]').click();
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "remove", expenseId: "expense0000002", reason: "Marked unpaid" });
  });

  it("Remove on an unpaid bill cancels it; Edit uses the bill fields", async () => {
    const data = await mountExp();
    $('[data-kind="bill-due"] [data-act="bill-remove"]').click();
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "cancel", scheduleId: "sched000000001", reason: "Removed" });
    $('[data-kind="bill-due"] [data-act="bill-edit"]').click();
    await flush();
    expect([...lastForm().elements].filter((e) => e.name).map((e) => e.name)).toEqual(["description", "amount", "category", "dueDate", "repeat"]);
  });

  it("a normal expense: ⋯ Edit / Details / Remove, no Paid / Unpaid", async () => {
    const data = await mountExp();
    const r = $('[data-row="expense0000003"]');
    expect([...r.querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Edit", "Details", "Remove"]);
    r.querySelector('[data-act="edit"]').click();
    await flush();
    const f = lastForm();
    f.elements.amount.value = "3300";
    submit(f);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "update", expenseId: "expense0000003", expectedRevision: 1, changes: { amount: 330000 } });
  });

  it("+ Add expense: Amount, Category, Date up front; payee, method, reference, notes, receipt under More details", async () => {
    const data = await mountExp();
    $('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    expect([...form.querySelectorAll("input, select, textarea")].filter((e) => !e.closest("details:not([open])")).map((e) => e.name)).toEqual(["amount", "category", "date"]);
    expect([...form.querySelectorAll("details input, details select, details textarea")].map((e) => e.name)).toEqual(["payee", "method", "reference", "notes", "proof"]);
    form.elements.amount.value = "1,299.50";
    form.elements.category.value = "Pets";
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "createCategory", category: { name: "Pets", budget: null } });
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", expense: { date: "2026-10-16", amount: 129950, method: "cash", category: "catNew0000001" } });
  });

  it("⋯ → Manage categories; previous month reloads it (bills due by its end, not later ones)", async () => {
    const data = await mountExp();
    expect($('[data-role="manage-categories"]').getAttribute("href")).toBe("/budget");
    $('[data-act="month-prev"]').click();
    await flush();
    expect(data.householdMonth).toHaveBeenLastCalledWith("2026-09");
    expect(data.listBills).toHaveBeenLastCalledWith(expect.any(String), { status: "upcoming", to: "2026-09-30" }, expect.anything());
  });

  it("helpers: dueBills follows Bills remaining (current month incl. overdue; past month only its own); groups sort largest first", () => {
    const b = (id, dueDate, extra = {}) => ({ id, dueDate, status: "upcoming", amount: 100, ...extra });
    const bills = [b("a", "2026-09-20"), b("b", "2026-10-20"), b("c", "2026-11-02"), b("d", "2026-10-05", { status: "paid" }), b("e", "2026-10-06", { paidAmount: 100 })];
    expect(dueBills(bills, "2026-10", "2026-10-16").map((x) => x.id)).toEqual(["a", "b"]);
    expect(dueBills(bills, "2026-09", "2026-10-16").map((x) => x.id)).toEqual(["a"]);
    const g = groupRows(monthRows({ expenses: [EXP], payroll: [{ id: "p", staffName: "Ana", amount: 300000, paidDate: "2026-10-01" }], bills: [], categories: [CATS[0]] }));
    expect(g.map((x) => [x.key, x.total])).toEqual([["payroll", 300000], ["catGroceries01", 250000]]);
  });

  it("month helpers and parsing", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(() => parseHouseholdExpense({ amount: "0", date: "2026-10-01" })).toThrow(/more than ₱0/);
  });
});

describe("Bills (recurring bills)", () => {
  it("+ Add bill: Bill name, Amount, Category, Due date, Repeat only; monthly by default", async () => {
    const data = fakeData();
    mountBills(container, home(), { data, now: NOW });
    await flush();
    $('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    expect([...form.elements].filter((e) => e.name).map((e) => e.name)).toEqual(["description", "amount", "category", "dueDate", "repeat"]);
    expect([...form.elements.repeat.options].map((o) => o.textContent)).toEqual(["Doesn't repeat", "Weekly", "Every 2 weeks", "Monthly", "Every 3 months", "Every 6 months", "Yearly"]);
    form.elements.description.value = "Internet";
    form.elements.amount.value = "1699";
    form.elements.dueDate.value = "2026-10-25";
    submit(form);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "create", payment: { description: "Internet", amount: 169900, dueDate: "2026-10-25", repeat: { every: "month", interval: 1 }, category: "catUtilities01" } });
  });

  it("an unpaid bill: Due · Monthly, ⋯ Paid / Edit / Remove; Paid needs no payment form", async () => {
    const data = fakeData();
    mountBills(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(flat($('[data-col="repeat"]'))).toBe("Due Oct 20 · Monthly");
    expect([...$$('[data-bill] .menu-item')].map((b) => b.textContent.trim())).toEqual(["Paid", "Edit", "Remove"]);
    $('[data-act="paid"]').click();
    await flush();
    expect(document.querySelector(".modal-backdrop form")).toBeNull();
    expect(data.scheduleApi).toHaveBeenCalledWith(expect.objectContaining({ action: "markPaid", scheduleId: "sched000000001", payment: expect.objectContaining({ method: "cash", amount: 450000, final: true }) }));
  });

  it("Paid tab: ⋯ Mark unpaid / Remove", async () => {
    const PAID = { ...BILL, id: "schedPaid0001", status: "paid", paidDate: "2026-10-15", paidAmount: 450000, expenseId: "expBill000001" };
    const data = fakeData({ listBills: vi.fn(async (b, f) => ({ rows: f.status === "paid" ? [PAID] : [BILL], hasMore: false })) });
    mountBills(container, home(), { data, now: NOW, confirm: async () => true, toast: () => {} });
    await flush();
    $('[data-act="seg"][data-value="paid"]').click();
    await flush();
    expect([...$$('[data-bill] .menu-item')].map((b) => b.textContent.trim())).toEqual(["Mark unpaid", "Remove"]);
    $('[data-act="unpaid"]').click();
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "remove", expenseId: "expBill000001", reason: "Marked unpaid" });
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
