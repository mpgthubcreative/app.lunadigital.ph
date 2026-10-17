// @vitest-environment jsdom
// Luna Household money screens: Expenses as a household statement (Spent +
// Bills remaining only; category groups ARE the list: expenses, read-only
// payroll rows and unpaid bills under their category; bill ⋯ Paid / Edit /
// Remove, paid bill ⋯ Mark unpaid / Edit / Remove), Bills (recurring bills:
// name, amount, category, due date, repeat), Categories (no budget), loaders.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountExpenses, shiftMonth, monthRange, parseHouseholdExpense, monthRows, groupRows } from "../../src/modules/household/expenses.js";
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
  { id: "catPersonal001", name: "Personal", budget: null, status: "active", useCount: 0, revision: 1 },
  { id: "catOld0000001", name: "Old stuff", budget: null, status: "inactive", useCount: 2, revision: 1 },
];
const EXP = { id: "expense0000001", date: "2026-10-05", category: "catGroceries01", amount: 250000, payee: "SM Supermarket", method: "cash", status: "active", revision: 1, history: [] };
const EXPS = [
  { ...EXP, id: "expense0000003", date: "2026-10-17", payee: "Puregold", amount: 325000 },
  { id: "expense0000002", date: "2026-10-15", category: "catUtilities01", amount: 300000, payee: "Parking", method: "gcash", status: "active", revision: 1, history: [], scheduleId: "schedPark0001" },
  EXP,
];
const MONTH = { month: "2026-10", current: true, spent: 1431500, expensesSpent: 875000, staffPaid: 556500, staffPayments: 1, billsRemaining: 450000, billsDue: 1, payroll: [{ id: "pay1", staffName: "Loriza", amount: 556500, paidDate: "2026-10-15" }], bills: [{ id: "sched000000001", scheduleId: "sched000000001", kind: "bill", projected: false, description: "Meralco", category: "catUtilities01", amount: 450000, dueDate: "2026-10-20", repeat: { every: "month", interval: 1 } }, { id: "schedIns000001", scheduleId: "schedIns000001", kind: "scheduled", projected: false, description: "Insurance", category: "catPersonal001", amount: 250000, dueDate: "2026-10-30" }], advancesReleased: 300000, advanceCount: 1, cashOut: 1911500, categories: [], byCategory: { catGroceries01: 575000, catUtilities01: 480000 } };
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
    getBill: vi.fn(async (b, id) => (id === "schedIns000001" ? { id, kind: "scheduled", description: "Insurance", category: "catPersonal001", amount: 250000, dueDate: "2026-10-30", status: "upcoming", revision: 1 } : { ...BILL, id })),
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
    expect(data.listBills).not.toHaveBeenCalled(); // the month's bills come from /api/household-money
    expect($('[data-role="month"]').textContent).toBe("October 2026");
    expect($$('[data-role="month-summary"] .kpi-label').map((e) => e.textContent)).toEqual(["Spent", "Bills remaining"]);
    expect(flat($('[data-role="month-summary"]'))).toContain("₱14,315.00");
    expect($('input[type="search"], input[name="search"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Advances released|Cash out|By category|budget/i);
    expect($$('[data-role="month-summary"] .hx-sum-item')).toHaveLength(2);
  });

  it("categories ARE the list (plain headings, largest first); rows show the merchant / bill / payroll, never the category again", async () => {
    await mountExp();
    expect($$(".hx-group-head").map(flat)).toEqual(["Utilities", "Groceries", "Household Staff", "Personal"]);
    expect($$('[data-group="catUtilities01"] .wl-name').map((e) => e.textContent)).toEqual(["Meralco", "Parking"]);
    expect($$('[data-group="catGroceries01"] .wl-name').map((e) => e.textContent)).toEqual(["Puregold", "SM Supermarket"]);
    for (const g of $$(".hx-group")) for (const n of g.querySelectorAll(".wl-name")) expect(n.textContent).not.toBe(g.querySelector(".wl-group-title").textContent);
  });

  it("the bill and expense rows add up to Spent + Bills remaining; a scheduled expense is listed but counts in neither", async () => {
    await mountExp();
    const rows = $$(".hx-group .hx-row").filter((r) => r.dataset.kind !== "scheduled");
    expect(rows.reduce((t, r) => t + peso(r.querySelector(".hx-amt").textContent), 0)).toBe(MONTH.spent + MONTH.billsRemaining);
    const sched = $('[data-kind="scheduled"]');
    expect(flat(sched)).toMatch(/Insurance.*Scheduled Oct 30.*₱2,500\.00/);
  });

  it("payroll: one read-only row under Household Staff (no ⋯)", async () => {
    await mountExp();
    const rows = $$('[data-kind="payroll"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].closest("[data-group]").dataset.group).toBe("catStaff000001");
    expect(rows[0].querySelector(".line-menu")).toBeNull();
  });

  it("an unpaid bill: Due Oct 20, ⋯ Paid / Edit / Remove; Paid sends one idempotent mark-paid (a double tap sends once)", async () => {
    const data = await mountExp();
    const bill = $('[data-kind="bill-due"]');
    expect(flat(bill)).toMatch(/Meralco.*Due Oct 20.*₱4,500\.00/);
    expect([...bill.querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Paid", "Edit", "Remove"]);
    bill.querySelector('[data-act="bill-paid"]').click();
    bill.querySelector('[data-act="bill-paid"]').click();
    await flush();
    const calls = data.scheduleApi.mock.calls.filter(([b]) => b.action === "markPaid");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ scheduleId: "sched000000001", payment: { method: "cash", amount: 450000, paidDate: "2026-10-16", final: true } });
  });

  it("a scheduled expense: Paid / Edit / Remove; Edit = description, amount, category, scheduled date; Remove cancels it", async () => {
    const data = await mountExp();
    const r = $('[data-kind="scheduled"]');
    expect([...r.querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Paid", "Edit", "Remove"]);
    r.querySelector('[data-act="bill-edit"]').click();
    await flush();
    expect(data.getBill).toHaveBeenCalledWith(expect.any(String), "schedIns000001");
    expect([...lastForm().elements].filter((e) => e.name).map((e) => e.name)).toEqual(["description", "amount", "category", "dueDate"]);
    lastForm().querySelector('[data-action="cancel"]').click();
    $('[data-kind="scheduled"] [data-act="bill-remove"]').click();
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "cancel", scheduleId: "schedIns000001", reason: "Removed" });
  });

  it("a paid bill: Paid · Oct 15, ⋯ Mark unpaid / Edit / Remove; Mark unpaid removes its expense", async () => {
    const data = await mountExp();
    const paid = $('[data-kind="bill-paid"]');
    expect(flat(paid)).toMatch(/Parking.*Paid · Oct 15.*₱3,000\.00/);
    paid.querySelector('[data-act="bill-unpaid"]').click();
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "remove", expenseId: "expense0000002", reason: "Marked unpaid" });
  });

  it("+ Add expense: Paid now (Amount, Category, Date paid) or Schedule for later (Scheduled date; creates a scheduled expense, not an expense)", async () => {
    const data = await mountExp();
    $('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    const visible = () => [...form.querySelectorAll("input, select, textarea")].filter((e) => !e.closest("details:not([open])") && !e.closest(".field[hidden]")).map((e) => e.name);
    expect(visible()).toEqual(["when", "amount", "category", "date"]);
    expect(form.querySelector(`label[for="${form.elements.date.id}"]`).textContent).toBe("Date paid *");
    form.elements.when.value = "later";
    form.elements.when.dispatchEvent(new Event("change", { bubbles: true }));
    expect(form.querySelector(`label[for="${form.elements.date.id}"]`).textContent).toBe("Scheduled date *");
    expect(form.elements.date.max).toBe("");
    expect(form.elements.method.closest(".field").hidden).toBe(true);
    expect(form.querySelector('[data-action="submit"]').textContent).toBe("Schedule expense");
    form.elements.amount.value = "2500";
    form.elements.category.value = "Groceries";
    form.elements.payee.value = "Insurance";
    form.elements.date.value = "2026-11-25";
    submit(form);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "create", payment: { kind: "scheduled", description: "Insurance", category: "catGroceries01", amount: 250000, dueDate: "2026-11-25", payee: "Insurance" } });
    expect(data.expensesApi.mock.calls.filter(([b]) => b.action === "create")).toHaveLength(0);
  });

  it("+ Add expense (paid now) records an expense", async () => {
    const data = await mountExp();
    $('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    form.elements.amount.value = "1,299.50";
    form.elements.category.value = "Pets";
    submit(form);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", expense: { date: "2026-10-16", amount: 129950, method: "cash", category: "catNew0000001" } });
  });

  it("months: back and ahead (future months open); a projected bill in a future month: Due, ⋯ Edit bill only", async () => {
    const DEC = { ...MONTH, month: "2026-12", current: false, spent: 0, staffPaid: 0, payroll: [], billsRemaining: 480000, bills: [{ id: "sched000000001@2026-12-20", scheduleId: "sched000000001", kind: "bill", projected: true, description: "Meralco", category: "catUtilities01", amount: 480000, dueDate: "2026-12-20", changesByPeriod: true }] };
    const data = fakeData({ householdMonth: vi.fn(async (m) => (m === "2026-12" ? DEC : m === "2026-10" ? MONTH : { ...MONTH, month: m, spent: 0, staffPaid: 0, billsRemaining: 0, payroll: [], bills: [] })), listExpenses: vi.fn(async (b, f) => ({ rows: f.from.startsWith("2026-10") ? EXPS.map((e) => ({ ...e })) : [], hasMore: false })) });
    await mountExp(data);
    expect($('[data-act="month-next"]').disabled).toBe(false);
    $('[data-act="month-next"]').click();
    await flush();
    $('[data-act="month-next"]').click();
    await flush();
    expect($('[data-role="month"]').textContent).toBe("December 2026");
    const r = $('[data-kind="bill-next"]');
    expect(flat(r)).toMatch(/Meralco.*Due Dec 20.*₱4,800\.00/);
    expect([...r.querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Edit bill"]);
    for (let i = 0; i < 12; i++) {
      $('[data-act="month-prev"]').click();
      await flush();
    }
    expect($('[data-role="month"]').textContent).toBe("December 2025");
    expect($('[data-role="none"]')).toBeTruthy();
  });

  it("helpers: groups sort largest first; projected / scheduled kinds", () => {
    const g = groupRows(monthRows({ expenses: [EXP], payroll: [{ id: "p", staffName: "Ana", amount: 300000, paidDate: "2026-10-01" }], bills: [{ id: "x@2026-11-01", scheduleId: "x", kind: "bill", projected: true, description: "Rent", category: "catGroceries01", amount: 5, dueDate: "2026-11-01" }, { id: "y", kind: "scheduled", description: "Insurance", category: "catGroceries01", amount: 7, dueDate: "2026-11-02" }], categories: [CATS[0]] }));
    expect(g.map((x) => [x.key, x.total])).toEqual([["payroll", 300000], ["catGroceries01", 250012]]);
    expect(g[1].rows.map((r) => r.kind)).toEqual(["bill-next", "scheduled", "expense"]);
  });

  it("month helpers and parsing", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(() => parseHouseholdExpense({ amount: "0", date: "2026-10-01" })).toThrow(/more than ₱0/);
  });
});

describe("Bills (recurring bills)", () => {
  it("+ Add bill: Bill name, Amount, Category, Due date, Repeat up front; future amount changes under + Add future amount change", async () => {
    const data = fakeData();
    mountBills(container, home(), { data, now: NOW });
    await flush();
    $('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    const main = [...form.querySelectorAll("input, select, textarea")].filter((e) => !e.closest("details")).map((e) => e.name);
    expect(main).toEqual(["description", "amount", "category", "dueDate", "repeat"]);
    expect(form.querySelector("details summary").textContent).toBe("+ Add future amount change");
    expect([...form.elements.repeat.options].map((o) => o.textContent)).toEqual(["Doesn't repeat", "Weekly", "Every 2 weeks", "Monthly", "Every 3 months", "Every 6 months", "Yearly"]);
    form.elements.description.value = "Insurance";
    form.elements.amount.value = "2500";
    form.elements.category.value = "Utilities";
    form.elements.dueDate.value = "2026-10-25";
    form.elements.from.value = "2026-05-01";
    form.elements.futureAmount0.value = "3000";
    form.elements.futureFrom0.value = "2026-12-01";
    submit(form);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "create", payment: { description: "Insurance", amount: 250000, dueDate: "2026-10-25", repeat: { every: "month", interval: 1 }, category: "catUtilities01", amountSchedule: [{ amount: 250000, from: "2026-05-01" }, { amount: 300000, from: "2026-12-01" }] } });
  });

  it("a plain bill sends no amount schedule", async () => {
    const data = fakeData();
    mountBills(container, home(), { data, now: NOW });
    await flush();
    $('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    form.elements.description.value = "Internet";
    form.elements.amount.value = "1699";
    form.elements.dueDate.value = "2026-10-25";
    submit(form);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "create", payment: { description: "Internet", amount: 169900, dueDate: "2026-10-25", repeat: { every: "month", interval: 1 }, category: "catUtilities01" } });
  });

  it("My Bills: ONE row per bill (a reopened occurrence and the next one show once); ⋯ Edit / Remove only; scheduled expenses aren't bills", async () => {
    const BYP = { ...BILL, id: "schedIns000002", description: "Insurance", amount: 300000, amountSchedule: [{ amount: 250000, from: "2026-05-01", until: null }, { amount: 300000, from: "2026-10-01", until: null }] };
    const OLD = { ...BILL, id: "schedMer000000", dueDate: "2026-09-20", nextId: "sched000000001" }; // reopened September Meralco
    const ONE = { ...BILL, id: "schedOne000001", description: "Dentist", kind: "scheduled", repeat: null };
    const data = fakeData({ listBills: vi.fn(async () => ({ rows: [OLD, BILL, BYP, ONE], hasMore: false })) });
    mountBills(container, home(), { data, now: NOW, toast: () => {}, confirm: async () => true });
    await flush();
    expect($$("[data-bill] .wl-name").map((e) => e.textContent)).toEqual(["Insurance", "Meralco"]);
    expect(flat($('[data-bill="sched000000001"] [data-col="repeat"]'))).toBe("Monthly · next due Oct 20 · 1 unpaid");
    expect(flat($('[data-bill="schedIns000002"] [data-col="repeat"]'))).toBe("Monthly · next due Oct 20 · Amount changes by period");
    expect([...$$('[data-bill="sched000000001"] .menu-item')].map((b) => b.textContent.trim())).toEqual(["Edit", "Remove"]);
    // Remove the bill: every unpaid occurrence of it is cancelled.
    $('[data-bill="sched000000001"] [data-act="remove"]').click();
    await flush();
    const cancelled = data.scheduleApi.mock.calls.filter(([b]) => b.action === "cancel").map(([b]) => b.scheduleId).sort();
    expect(cancelled).toEqual(["sched000000001", "schedMer000000"]);
  });

  it("Sample Bills: Meralco ₱5,000 / PLDT ₱2,000 / Parking ₱3,000, Monthly; + Add opens the bill form prefilled (editable); a bill already in My Bills shows Added ✓", async () => {
    const data = fakeData();
    mountBills(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    $('[data-act="seg"][data-value="sample"]').click();
    await flush();
    expect($$('[data-role="sample-bills"] .wl-row').map(flat)).toEqual(["MeralcoMonthly · Utilities ₱5,000.00 Added ✓", "PLDTMonthly · Utilities ₱2,000.00 + Add", "ParkingMonthly · Transportation ₱3,000.00 + Add"]);
    $('[aria-label="Add PLDT"]').click();
    await flush();
    const f = lastForm();
    expect([f.elements.description.value, f.elements.amount.value, f.elements.category.value, f.elements.repeat.value]).toEqual(["PLDT", "2000.00", "Utilities", "month:1"]);
    f.elements.amount.value = "1899";
    submit(f);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "create", payment: { description: "PLDT", amount: 189900, dueDate: "2026-10-16", repeat: { every: "month", interval: 1 }, category: "catUtilities01" } });
    expect(data.scheduleApi.mock.calls).toHaveLength(1); // nothing was created before + Add
  });

  it("Edit an amount-changing bill: shows the current amount + when it started + the later change; adding a change sends the schedule only", async () => {
    const BYP = { ...BILL, id: "schedIns000002", description: "Insurance", amount: 250000, dueDate: "2026-10-25", revision: 3, amountSchedule: [{ amount: 250000, from: "2026-05-01", until: null }] };
    const data = fakeData({ listBills: vi.fn(async () => ({ rows: [BYP], hasMore: false })) });
    mountBills(container, home(), { data, now: NOW, toast: () => {} });
    await flush();
    $('[data-act="edit"]').click();
    await flush();
    const f = lastForm();
    expect(f.elements.amount.value).toBe("2500.00");
    expect(f.elements.from.value).toBe("2026-05-01");
    f.elements.futureAmount0.value = "3000";
    f.elements.futureFrom0.value = "2026-11-01";
    submit(f);
    await flush();
    expect(data.scheduleApi).toHaveBeenCalledWith({ action: "update", scheduleId: "schedIns000002", expectedRevision: 3, changes: { amountSchedule: [{ amount: 250000, from: "2026-05-01" }, { amount: 300000, from: "2026-11-01" }] } });
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
    expect($$('[data-role="categories"] .wl-name').map((e) => e.textContent.trim())).toEqual(["Groceries", "Utilities", "Household Staff", "Personal"]);
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
