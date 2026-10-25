// @vitest-environment jsdom
// Phase 16 screens: Wedding Budget, Wedding Expenses, Wedding Suppliers
// (computed balance), Supplier Payments (Mark paid -> one expense), Wedding
// Tasks (inline status, derived overdue), Guests & RSVP (people vs
// invitations), the Wedding dashboard, navigation and the loaders.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountBudget } from "../../src/modules/wedding/budget.js";
import { mount as mountExpenses, parseWeddingExpense } from "../../src/modules/wedding/expenses.js";
import { mount as mountSuppliers, toSupplierInput, paidState, moneySummary, shortPeso, moneyRows, moneyGroups, moneyLabel } from "../../src/modules/wedding/suppliers.js";
import { mount as mountProgram } from "../../src/modules/wedding/program.js";
import { mount as mountCrewMeals } from "../../src/modules/wedding/crew.js";
import { openInvitePreview } from "../../src/modules/wedding/invite-preview.js";
import { resolveDesign } from "../../shared/invitation-design.js";
import { renderInvitePage, inviteTokenFrom } from "../../src/app/invite.js";
import { guessService } from "../../src/modules/wedding/categories.js";
import { mount as mountDownloads } from "../../src/modules/downloads/index.js";
import { mount as mountPayments } from "../../src/modules/wedding/payments.js";
import { mount as mountTasks, sortTasks } from "../../src/modules/wedding/tasks.js";
import { toGuestInput, mount as mountGuests, parseRsvp, seatsText, groupGuests } from "../../src/modules/wedding/guests.js";
import { seatingPlan } from "../../shared/wedding-seating.js";
import { renderShell } from "../../src/app/shell.js";
import { mountBell } from "../../src/app/notification-bell.js";
import { mount as mountDashboard } from "../../src/modules/dashboard/index.js";
import { MODULE_LOADERS } from "../../src/modules/loaders.js";
import { buildRoutes } from "../../src/app/routes.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const NOW = () => new Date("2026-10-16T04:00:00Z");
const wedding = (role = "owner") => sessionFixture({ roleTemplate: role, workspaceTemplateId: "bridal-expense" });
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const cells = (role) => [...container.querySelectorAll(`[data-role="${role}"] tbody tr`)].map((tr) => [...tr.cells].filter((c) => !c.classList.contains("m-only")).map((c) => c.textContent.trim().replace(/\s+/g, " ")));

const CATS = [
  { id: "catPhotoVid01", name: "Photo / Video", budget: 8000000, status: "active", order: 50, revision: 1 },
  { id: "catVenue00001", name: "Venue", budget: 15000000, status: "active", order: 10, revision: 1 },
];
const BUDGET = { total: 50000000, spent: 2000000, expenseCount: 1, spentByCategory: { catPhotoVid01: 2000000 }, upcoming: 3000000, upcomingCount: 1, contracted: 8000000, contractedPaid: 2000000, revision: 2 };
const SUP = { id: "supABCphoto01", name: "ABC Photo Studio", service: "photo_video", agreedAmount: 8000000, paid: 2000000, upcoming: 3000000, upcomingCount: 1, nextDue: "2026-12-01", status: "active", categoryId: "catPhotoVid01", revision: 2, history: [] };
const PAY = { id: "payABCsecond1", supplierId: SUP.id, supplierName: "ABC Photo Studio", description: "Second payment", category: "catPhotoVid01", categoryName: "Photo / Video", amount: 3000000, dueDate: "2026-12-01", status: "upcoming", revision: 1, history: [] };
const TASKS = [
  { id: "taskChurch001", title: "Submit church requirements", category: "Ceremony / Church", assignee: "Camille", dueDate: "2026-10-10", priority: "high", status: "in_progress", open: true, history: [] },
  { id: "taskFitting01", title: "Gown fitting", category: "Attire", assignee: null, dueDate: "2026-10-20", priority: "normal", status: "not_started", open: true, history: [] },
];
const GUEST = { id: "guestPrado001", name: "Prado Family", group: "Groom's relatives", side: "groom", partySize: 4, rsvp: "awaiting", confirmed: 0, invitationSent: "2026-10-01", revision: 1, history: [] };
const TOTALS = { invitations: 3, invitedSeats: 9, attending: 1, attendingSeats: 3, declined: 1, declinedSeats: 2, awaiting: 1, awaitingSeats: 4, invitationsSent: 2 };

function fakeData(extra = {}) {
  return {
    getBudget: vi.fn(async () => BUDGET),
    listCategories: vi.fn(async () => CATS),
    listWeddingExpenses: vi.fn(async () => ({ rows: [{ id: "expPhoto00001", date: "2026-10-15", category: "catPhotoVid01", categoryName: "Photo / Video", amount: 2000000, payee: "ABC Photo Studio", supplierId: SUP.id, supplierPaymentId: "payABCfirst01", method: "bank_transfer", status: "active", revision: 1, history: [] }], hasMore: false })),
    activeSuppliers: vi.fn(async () => [SUP]),
    listSuppliers: vi.fn(async () => ({ rows: [SUP], hasMore: false })),
    listSupplierPayments: vi.fn(async () => ({ rows: [PAY], hasMore: false })),
    listTasks: vi.fn(async () => ({ rows: TASKS, hasMore: false })),
    listGuests: vi.fn(async () => ({ rows: [GUEST], hasMore: false })),
    getGuestTotals: vi.fn(async () => TOTALS),
    budgetApi: vi.fn(async () => ({})),
    expensesApi: vi.fn(async () => ({})),
    suppliersApi: vi.fn(async () => ({})),
    paymentsApi: vi.fn(async () => ({ expenseId: PAY.id, paid: true })),
    tasksApi: vi.fn(async () => ({})),
    guestsApi: vi.fn(async () => ({})),
    ...extra,
  };
}

describe("navigation and loaders", () => {
  it("Bridal owner (Owner-pilot UX): Expenses is home, no Dashboard route; Wedding Expenses / Payments still open; Budget is gone (old links open Expenses); Staff: the dashboard only", () => {
    const routes = buildRoutes(wedding());
    expect(routes.map((r) => r.label)).toEqual(expect.arrayContaining(["Expenses", "Tasks", "Guests", "Wedding Expenses", "Supplier Payments"]));
    expect(routes.map((r) => r.label)).not.toContain("Budget");
    expect(routes.find((r) => r.path === "/budget")).toMatchObject({ redirect: "/wedding-suppliers", moduleId: "vendors" });
    expect(buildRoutes(sessionFixture({ workspaceTemplateId: "baby-expense" })).find((r) => r.path === "/budget")).toMatchObject({ moduleId: "budget" });
    expect(routes.find((r) => r.path === "/")).toMatchObject({ redirect: "/wedding-suppliers", moduleId: "vendors" });
    expect(routes.some((r) => r.moduleId === "dashboard")).toBe(false);
    for (const p of buildRoutes(wedding("staff")).map((r) => r.path)) expect(["/", "/notifications"]).toContain(p);
  });
  it("phone: Money / Tasks / Guests + More (Budget, Users, Settings inside More)", () => {
    document.body.innerHTML = '<div id="app"></div>';
    renderShell(document.getElementById("app"), wedding());
    const tabs = [...document.querySelectorAll(".tabbar .tab-link")].map((a) => a.textContent.trim());
    expect(tabs.slice(0, 3)).toEqual(["Expenses", "Tasks", "Guests"]);
    expect(tabs).toHaveLength(4);
    expect(tabs[3]).toMatch(/More/);
  });
  it("Distributor / Household / Baby never get a Wedding screen", () => {
    for (const t of ["distributor", "household-payroll", "baby-expense"]) for (const p of ["/wedding-suppliers", "/supplier-payments", "/wedding-tasks", "/guests"]) expect(buildRoutes(sessionFixture({ workspaceTemplateId: t })).map((r) => r.path), `${t}${p}`).not.toContain(p);
  });
  it("Budget and Expenses load the Wedding screens in Bridal, Baby's in Baby", async () => {
    expect((await MODULE_LOADERS.expenses(wedding())).parseWeddingExpense).toBeTypeOf("function");
    expect((await MODULE_LOADERS.expenses(sessionFixture({ workspaceTemplateId: "baby-expense" }))).parseBabyExpense).toBeTypeOf("function");
    const wb = await MODULE_LOADERS.budget(wedding());
    const bb = await MODULE_LOADERS.budget(sessionFixture({ workspaceTemplateId: "baby-expense" }));
    expect(wb.mount).not.toBe(bb.mount);
  });
});

describe("Wedding Budget", () => {
  it("as of now: ₱500,000 / ₱20,000 spent / ₱480,000 left / ₱30,000 upcoming / ₱60,000 supplier balance", async () => {
    mountBudget(container, wedding(), { data: fakeData(), toast: () => {} });
    await flush();
    const v = (id) => container.querySelector(`[data-widget="${id}"] .stat-value`).textContent;
    expect([v("total"), v("spent"), v("remaining"), v("upcoming"), v("balance")].map((x) => x.replace(/\.00/, ""))).toEqual(["₱500,000", "₱20,000", "₱480,000", "₱30,000", "₱60,000"]);
    expect(cells("categories").map((r) => r.slice(0, 4))).toEqual([["Photo / Video", "₱80,000.00", "₱20,000.00", "₱60,000.00"], ["Venue", "₱150,000.00", "₱0.00", "₱150,000.00"]]);
  });
});

describe("Wedding Expenses", () => {
  it("rows show the supplier snapshot; the add form offers saved suppliers and sends supplierId (no typed payee)", async () => {
    const data = fakeData();
    mountExpenses(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(cells("expenses")[0].slice(0, 3)).toEqual(["Oct 15, 2026", "Photo / Video", "ABC Photo Studio"]);
    expect(parseWeddingExpense({ date: "2026-10-16", category: "c", amount: "100", supplierId: SUP.id, payee: "x", method: "cash", reference: "", notes: "", recurring: "no" })).toMatchObject({ supplierId: SUP.id, payee: undefined, amount: 10000 });
    expect(container.textContent).not.toMatch(/Operating|COGS|Profit|Baby/);
  });
});

describe("Money (Owner-pilot Bridal): ONE list of everything the wedding costs", () => {
  const OTHER = { id: "expTaxi000001", date: "2026-10-14", category: "catVenue00001", amount: 150000, payee: "Grab to venue", supplierId: null, method: "cash", status: "active", revision: 1, history: [] };
  const NOAGREE = { id: "supNoAgree001", name: "Lights Co", service: "other", agreedAmount: null, paid: 0, upcoming: 500000, upcomingCount: 1, status: "active", revision: 1, history: [] };
  const money = (extra = {}) => fakeData({ listSuppliers: vi.fn(async (_b, f) => ({ rows: f.status === "inactive" ? [] : [SUP], hasMore: false })), listWeddingExpenses: vi.fn(async () => ({ rows: [OTHER, { ...OTHER, id: "expPhoto00001", supplierId: SUP.id, payee: "ABC Photo Studio" }], hasMore: false })), ...extra });
  const rowOf = (sel) => container.querySelector(sel);
  const mountMoney = async (data = money(), session = wedding()) => {
    mountSuppliers(container, session, { data, now: NOW, toast: () => {}, confirm: async () => true });
    await flush();
    return data;
  };

  const change = (el) => el.dispatchEvent(new Event("change", { bubbles: true }));
  const shown = (f) => [...f.querySelectorAll(".field")].filter((x) => !x.hidden && !x.closest(".form-more")).map((x) => x.querySelector("input,select,textarea").name);
  const later = (f) => {
    f.querySelector('[name="when"][value="later"]').checked = true;
    change(f.querySelector('[name="when"][value="later"]'));
  };

  it("Expenses (final Bridal UX): ONE + Add Expense (no Add menu); Spent / To pay; Next payment; nothing about a budget", async () => {
    await mountMoney();
    expect(container.querySelector(".page-header h1").textContent).toBe("Expenses");
    expect([...container.querySelectorAll(".page-header .btn")].map((b) => b.textContent)).toEqual(["+ Add Expense"]);
    expect(container.querySelector('[data-role="add"]')).toBeNull();
    const k = (x) => container.querySelector(`[data-role="money-summary"] [data-k="${x}"]`);
    expect(["spent", "still"].map((x) => k(x).textContent.replace(/\s+/g, " ").trim())).toEqual(["Spent₱20k", "To pay₱60k"]);
    expect(k("still").title).toBe("₱60,000.00");
    expect(container.querySelector('[data-role="next-payment"]').textContent.replace(/\s+/g, " ").trim()).toBe("Next payment: Dec 1 · ABC Photo Studio ₱30k");
    expect(container.querySelector('[data-role="budget-line"]')).toBeNull();
    expect(container.textContent).not.toMatch(/budget|planned|sample/i);
    expect(container.querySelector('[data-role="filter"]')).toBeNull();
    expect(container.querySelector('[data-act="export"]')).toBeNull();
    expect([shortPeso(15250000), shortPeso(120000000), shortPeso(85000)]).toEqual(["₱152.5k", "₱1.2M", "₱850"]);
    expect(moneySummary(BUDGET, [SUP, NOAGREE])).toEqual({ spent: 2000000, stillToPay: 6500000 });
  });

  it("rows by category: name, then '₱80k total · ₱20k paid · ₱60k left' (each figure kept with its word), then 'Next: Dec 1'; Pay on open contracts; an old budget line makes no row", async () => {
    await mountMoney();
    const groups = [...container.querySelectorAll(".hx-group")].map((g) => [g.querySelector(".wl-group-title").textContent, [...g.querySelectorAll(".wl-money-row")].map((r) => [r.dataset.kind, r.querySelector(".wl-name").textContent, r.querySelector('[data-role="status"]').textContent.replace(/\s+/g, " ").trim(), r.querySelector('[data-role="next"]')?.textContent.trim() ?? ""])]);
    expect(groups).toEqual([
      ["Photo / Video", [["supplier", "ABC Photo Studio", "₱80k total · ₱20k paid · ₱60k left", "Next: Dec 1"]]],
      ["Venue", [["expense", "Grab to venue", "₱1.5k · Paid", ""]]],
    ]);
    expect([...rowOf('[data-supplier="supABCphoto01"] [data-role="status"]').querySelectorAll(".wl-nobr")].map((x) => x.textContent)).toEqual(["₱80k total", "₱20k paid", "₱60k left"]);
    expect(rowOf('[data-supplier="supABCphoto01"] [data-act="pay"]').textContent).toBe("Pay");
    expect(rowOf(`[data-expense="${OTHER.id}"] [data-act="pay"]`)).toBeNull();
    expect(moneyGroups([{ categoryId: null, category: "", name: "x" }])).toEqual([{ key: "none", name: "Other", rows: [{ categoryId: null, category: "", name: "x" }] }]);
    expect(moneyLabel({ kind: "expense", name: null, record: { notes: "Bridal car fuel" } })).toBe("Bridal car fuel");
    // Old Bridal data: a category's budget amount or "planned" flag stays stored, never a row.
    expect(moneyRows({ suppliers: [], categories: [{ ...CATS[1], planned: true }], expenses: [] })).toEqual([]);
  });

  it("+ Add Expense: Category (+ Add category), Supplier (+ Add supplier / No supplier), Total contract, Record payment, Paid now / Pay later; a new contract with no payment yet", async () => {
    const data = await mountMoney(money({ budgetApi: vi.fn(async () => ({ categoryId: "catFlowers001" })), suppliersApi: vi.fn(async () => ({ supplierId: "supBloom00001" })) }));
    container.querySelector('[data-act="add-expense"]').click();
    const f = lastForm();
    expect(f.closest(".modal-backdrop").querySelector("h2").textContent).toBe("Add Expense");
    expect([...f.elements.category.options].map((o) => o.textContent)).toEqual(["Select category", "Photo / Video", "Venue", "+ Add category"]);
    expect([...f.elements.supplierId.options].map((o) => o.textContent)).toEqual(["Select supplier", "ABC Photo Studio", "+ Add supplier", "No supplier (one-off expense)"]);
    expect(shown(f)).toEqual(["category", "supplierId", "agreedAmount", "amount", "when", "date"]);
    expect([...f.querySelectorAll('[name="when"]')].map((r) => r.closest("label").textContent.trim())).toEqual(["Paid now", "Pay later"]);
    f.elements.category.value = "__new";
    change(f.elements.category);
    f.elements.supplierId.value = "__new";
    change(f.elements.supplierId);
    expect(shown(f)).toEqual(["category", "newCategory", "supplierId", "newSupplier", "agreedAmount", "amount", "when", "date"]);
    f.elements.newCategory.value = "Flowers";
    f.elements.newSupplier.value = "Bloom Flowers";
    f.elements.agreedAmount.value = "45000";
    submit(f);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "createCategory", category: { name: "Flowers", budget: null } });
    expect(data.suppliersApi).toHaveBeenCalledWith({ action: "create", supplier: expect.objectContaining({ name: "Bloom Flowers", categoryId: "catFlowers001", agreedAmount: 4500000, service: "styling" }) });
    expect(data.expensesApi).not.toHaveBeenCalled();
    expect(data.paymentsApi).not.toHaveBeenCalled();
    expect(lastForm()).toBeUndefined();
    expect([guessService("Photo & Video"), guessService("Souvenirs")]).toEqual(["photo_video", "other"]);
  });

  it("+ Add Expense, new supplier with a first payment: supplier, then ONE expense; a retry after a failed payment doesn't add the supplier twice", async () => {
    let fail = true;
    const data = await mountMoney(money({ suppliersApi: vi.fn(async () => ({ supplierId: "supBloom00001" })), expensesApi: vi.fn(async () => { if (fail) throw new Error("Network down"); return { expenseId: "e9" }; }) }));
    container.querySelector('[data-act="add-expense"]').click();
    const f = lastForm();
    f.elements.category.value = "catPhotoVid01";
    f.elements.supplierId.value = "__new";
    change(f.elements.supplierId);
    f.elements.newSupplier.value = "Bloom Flowers";
    f.elements.agreedAmount.value = "45000";
    f.elements.amount.value = "50000";
    submit(f);
    await flush();
    expect(f.querySelector('[data-role="error"]').textContent).toBe("The payment is more than the ₱45,000 total contract");
    expect(data.suppliersApi).not.toHaveBeenCalled();
    f.elements.amount.value = "20000";
    submit(f);
    await flush();
    expect(f.querySelector('[data-role="error"]').textContent).toBe("Network down");
    fail = false;
    submit(f);
    await flush();
    expect(data.suppliersApi).toHaveBeenCalledTimes(1);
    expect(data.expensesApi).toHaveBeenCalledTimes(2);
    expect(data.expensesApi.mock.calls[0][0].idempotencyKey).toBe(data.expensesApi.mock.calls[1][0].idempotencyKey);
    expect(data.expensesApi).toHaveBeenLastCalledWith({ action: "create", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), expense: { date: "2026-10-16", category: "catPhotoVid01", amount: 2000000, supplierId: "supBloom00001", method: "bank_transfer" } });
  });

  it("+ Add Expense for a saved supplier: its category and total fill in; more than what's left is refused before anything is sent; a payment is ONE expense", async () => {
    const data = await mountMoney(money({ expensesApi: vi.fn(async () => ({ expenseId: "e9" })) }));
    container.querySelector('[data-act="add-expense"]').click();
    const f = lastForm();
    f.elements.supplierId.value = SUP.id;
    change(f.elements.supplierId);
    expect([f.elements.category.value, f.elements.agreedAmount.value]).toEqual(["catPhotoVid01", "80000"]);
    f.elements.amount.value = "40000"; // ₱80k − ₱20k paid − ₱30k scheduled = ₱30k open
    submit(f);
    await flush();
    expect(f.querySelector('[data-role="error"]').textContent).toBe("That's more than the ₱30,000 still to pay on this contract. Change the total contract first if it went up.");
    expect(data.expensesApi).not.toHaveBeenCalled();
    f.elements.amount.value = "10000";
    submit(f);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledTimes(1);
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), expense: { date: "2026-10-16", category: "catPhotoVid01", amount: 1000000, supplierId: SUP.id, method: "bank_transfer" } });
    expect(data.suppliersApi).not.toHaveBeenCalled();
  });

  it("+ Add Expense → Pay later: Due date replaces Payment date and a scheduled payment is created (not spent); No supplier: a one-off paid expense", async () => {
    const data = await mountMoney(money());
    container.querySelector('[data-act="add-expense"]').click();
    let f = lastForm();
    f.elements.supplierId.value = SUP.id;
    change(f.elements.supplierId);
    f.elements.amount.value = "20000";
    later(f);
    expect(shown(f)).toEqual(["category", "supplierId", "agreedAmount", "amount", "when", "dueDate"]);
    f.elements.dueDate.value = "2027-01-10";
    submit(f);
    await flush();
    expect(data.paymentsApi).toHaveBeenCalledWith({ action: "create", payment: { description: "Payment", amount: 2000000, dueDate: "2027-01-10", category: "catPhotoVid01", supplierId: SUP.id } });
    expect(data.expensesApi).not.toHaveBeenCalled();
    container.querySelector('[data-act="add-expense"]').click();
    f = lastForm();
    f.elements.category.value = "catVenue00001";
    f.elements.supplierId.value = "__none";
    change(f.elements.supplierId);
    expect(shown(f)).toEqual(["category", "supplierId", "payee", "amount", "date"]);
    f.elements.payee.value = "Van rental";
    f.elements.amount.value = "3500";
    submit(f);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", idempotencyKey: expect.any(String), expense: { date: "2026-10-16", category: "catVenue00001", amount: 350000, method: "bank_transfer", payee: "Van rental" } });
  });

  it("Pay on the row: the next scheduled payment comes first (marked paid: one expense); a new payment is Paid now or Scheduled for later; never above what's left", async () => {
    const data = await mountMoney(money({ expensesApi: vi.fn(async () => ({ expenseId: "e9" })) }));
    const open = async () => {
      rowOf('[data-supplier="supABCphoto01"] [data-act="pay"]').click();
      await flush();
      return lastForm();
    };
    let f = await open();
    expect(f.closest(".modal-backdrop").querySelector("h2").textContent).toBe("Pay ABC Photo Studio");
    expect([...f.elements.which.options].map((o) => o.textContent)).toEqual(["₱30,000 due Dec 1 · Second payment", "A new payment"]);
    expect(f.elements.amount.value).toBe("30000.00");
    expect(f.querySelector('[data-field="when"]').hidden).toBe(true); // paying a scheduled one is paying now
    submit(f);
    await flush();
    expect(data.paymentsApi).toHaveBeenCalledWith({ action: "markPaid", paymentId: PAY.id, payment: { paidDate: "2026-10-16", method: "bank_transfer" } });
    expect(data.expensesApi).not.toHaveBeenCalled();
    // A new payment, paid now.
    f = await open();
    f.elements.which.value = "__new";
    change(f.elements.which);
    expect(f.querySelector('[data-field="when"]').hidden).toBe(false);
    f.elements.amount.value = "40000";
    submit(f);
    await flush();
    expect(f.querySelector('[data-role="error"]').textContent).toMatch(/^That's more than the ₱30,000 still to pay/);
    f.elements.amount.value = "5000";
    submit(f);
    await flush();
    expect(data.expensesApi).toHaveBeenLastCalledWith({ action: "create", idempotencyKey: expect.any(String), expense: { date: "2026-10-16", category: "catPhotoVid01", amount: 500000, supplierId: SUP.id, method: "bank_transfer" } });
    // A new payment, scheduled for later.
    f = await open();
    f.elements.which.value = "__new";
    change(f.elements.which);
    later(f);
    expect(shown(f)).toEqual(["which", "amount", "when", "dueDate"]);
    f.elements.amount.value = "10000";
    f.elements.dueDate.value = "2027-02-01";
    f.elements.description.value = "Balance";
    submit(f);
    await flush();
    expect(data.paymentsApi).toHaveBeenLastCalledWith({ action: "create", payment: { description: "Balance", amount: 1000000, dueDate: "2027-02-01", category: "catPhotoVid01", supplierId: SUP.id } });
  });

  // Owner-pilot Bridal: ⋯ is just Edit / Details / Remove.
  const PAID = [{ id: "e1aaaaaaaa", date: "2026-10-01", amount: 1500000, supplierId: SUP.id, status: "active", method: "gcash", reference: "GC-1", proof: { contentType: "application/pdf" } }, { id: "e2aaaaaaaa", date: "2026-10-10", amount: 500000, supplierId: SUP.id, status: "active", method: "cash" }];
  const paidMoney = (extra = {}) => money({ listWeddingExpenses: vi.fn(async (_b, f) => ({ rows: f.supplierId ? PAID : [OTHER], hasMore: false })), attachExpenseProof: vi.fn(async () => ({ hasProof: true })), expenseProof: vi.fn(async () => ({ proof: { contentType: "image/png", dataBase64: "iVBORw0KGgo=" } })), ...extra });
  const sheet = () => document.querySelector('[data-role="money-edit"]');
  const menuOf = (sel) => [...rowOf(sel).querySelectorAll('[data-act="menu"]')].map((b) => b.textContent);

  it("every Expenses line's ⋯ is just Edit / Details / Remove (supplier, other expense)", async () => {
    await mountMoney();
    expect(menuOf('[data-supplier="supABCphoto01"]')).toEqual(["Edit", "Details", "Remove"]);
    expect(menuOf(`[data-expense="${OTHER.id}"]`)).toEqual(["Edit", "Details", "Remove"]);
    expect(rowOf('[data-supplier="supABCphoto01"] [data-role="left"]').textContent).toBe("₱60k left");
  });

  it("supplier Edit: one sheet — Category, Supplier, Total contract; Payments (paid · remaining · status, proofs, Pay); Payment schedule; Save changes", async () => {
    const data = await mountMoney(paidMoney({ budgetApi: vi.fn(async () => ({ categoryId: "catVideo00001" })), suppliersApi: vi.fn(async () => ({})) }));
    rowOf('[data-supplier="supABCphoto01"] [data-x="edit"]').click();
    await flush();
    const f = sheet().querySelector('[data-role="money-edit-form"]').elements;
    expect([f.category.value, f.name.value, f.agreedAmount.value]).toEqual(["Photo / Video", "ABC Photo Studio", "80000"]);
    expect(sheet().querySelector('[data-role="me-paid"]').textContent.replace(/\s+/g, " ")).toBe("₱20,000 paid · ₱60,000 remaining · Partial");
    expect([...sheet().querySelectorAll('[data-role="paid-list"] .slip-act')].map((x) => x.textContent.trim())).toEqual(["View proof", "Add proof"]);
    expect(sheet().querySelector('[data-role="scheduled-list"] .wl-name').textContent).toBe("Dec 1 · ₱30,000");
    expect([...sheet().querySelectorAll('[data-x="record"], [data-x="schedule"], [data-x="save"]')].map((b) => b.textContent)).toEqual(["Pay", "Save changes"]);
    // Change category (a new name is created) + total, in one Save.
    f.category.value = "Video only";
    f.agreedAmount.value = "90000";
    sheet().querySelector('[data-x="save"]').click();
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "createCategory", category: { name: "Video only", budget: null } });
    expect(data.suppliersApi).toHaveBeenCalledTimes(1);
    expect(data.suppliersApi).toHaveBeenCalledWith({ action: "update", supplierId: SUP.id, expectedRevision: 2, changes: { categoryId: "catVideo00001", agreedAmount: 9000000 } });
    expect(sheet()).toBeNull();
  });

  it("supplier Edit → Pay (a new payment) records ONE expense; the sheet comes back with fresh figures", async () => {
    const data = await mountMoney(paidMoney({ expensesApi: vi.fn(async () => ({ expenseId: "e3aaaaaaaa" })) }));
    rowOf('[data-supplier="supABCphoto01"] [data-x="edit"]').click();
    await flush();
    sheet().querySelector('[data-x="record"]').click();
    await flush();
    lastForm().elements.which.value = "__new";
    lastForm().elements.which.dispatchEvent(new Event("change", { bubbles: true }));
    lastForm().elements.amount.value = "15000";
    submit(lastForm());
    await flush();
    expect(data.expensesApi).toHaveBeenCalledTimes(1);
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), expense: { date: "2026-10-16", category: "catPhotoVid01", amount: 1500000, supplierId: SUP.id, method: "bank_transfer" } });
    await flush();
    expect(sheet()).not.toBeNull();
  });

  it("supplier Edit: Add proof on a paid line uploads to THAT expense; a failed upload after Record payment keeps the payment and says how to add it later", async () => {
    const toast = vi.fn();
    const data = paidMoney({ expensesApi: vi.fn(async () => ({ expenseId: "e3aaaaaaaa" })), attachExpenseProof: vi.fn(async () => { throw new Error("Proofs must be under 2.5 MB"); }) });
    mountSuppliers(container, wedding(), { data, now: NOW, toast, confirm: async () => true, prepareProof: vi.fn(async () => ({ contentType: "image/jpeg", dataBase64: "AAAA" })) });
    await flush();
    rowOf('[data-supplier="supABCphoto01"] [data-x="edit"]').click();
    await flush();
    sheet().querySelector('[data-x="record"]').click();
    await flush();
    lastForm().elements.amount.value = "5000";
    Object.defineProperty(lastForm().elements.proof, "files", { value: [{ name: "r.jpg", type: "image/jpeg" }], configurable: true });
    submit(lastForm());
    await flush();
    expect(toast).toHaveBeenCalledWith("Saved, but the proof didn't upload (Proofs must be under 2.5 MB). Add it from ⋯ → Add proof.", "danger");
    expect(toast).toHaveBeenCalledWith("Payment recorded.", "success");
    data.attachExpenseProof.mockImplementation(async () => ({ hasProof: true }));
    await flush();
    sheet().querySelector('[data-x="proof-add"][data-id="e2aaaaaaaa"]').click();
    await flush();
    Object.defineProperty(lastForm().elements.proof, "files", { value: [{ name: "t.pdf", type: "application/pdf" }], configurable: true });
    submit(lastForm());
    await flush();
    expect(data.attachExpenseProof).toHaveBeenLastCalledWith("e2aaaaaaaa", { contentType: "image/jpeg", dataBase64: "AAAA" });
  });

  it("supplier Details: name strongest (category · service under it, the status badge once); Total / Paid of total / Remaining; scheduled payments; payment history and activity folded; no repeated figures; Close only", async () => {
    await mountMoney(paidMoney());
    rowOf('[data-supplier="supABCphoto01"] [data-x="view"]').click();
    await flush();
    const d = document.querySelector('[data-role="details"]');
    const t = (sel) => d.querySelector(sel).textContent.replace(/\s+/g, " ").trim();
    expect(t(".dd-title")).toBe("ABC Photo Studio");
    expect(t('[data-role="subtitle"]')).toMatch(/^Photo \/ Video/);
    expect([t('[data-role="total"]'), t('[data-role="paid"]'), t('[data-role="paid-of"]'), t('[data-role="remaining"]')]).toEqual(["₱80,000", "₱20,000", "of ₱80,000", "₱60,000"]);
    // Not repeated: no Status / Scheduled / Next due fields.
    expect([...d.querySelectorAll("dt")].map((x) => x.textContent)).not.toEqual(expect.arrayContaining(["Status"]));
    expect(d.textContent).not.toMatch(/Next due|\(1 payment\)/);
    // Scheduled payments: date + amount (+ its description under it).
    const sched = [...d.querySelectorAll('[data-role="section"]')][0];
    expect(sched.closest("details")).toBeNull();
    expect([...sched.querySelectorAll(".dd-line")].map((li) => [li.querySelector(".dd-date").textContent, li.querySelector(".dd-amt").textContent])[0]).toEqual(["Dec 1", "₱30,000"]);
    // Payment history: closed by default; the toggle reads View … / Hide …; one line per payment with method · proof quiet under it.
    const fold = d.querySelector('[data-role="fold-history"]');
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary").textContent.replace(/\s+/g, " ").trim()).toBe("View payment history (2)Hide payment history");
    expect([...fold.querySelectorAll(".dd-line")].map((li) => [li.querySelector(".dd-date").textContent, li.querySelector(".dd-amt").textContent, li.querySelector(".dd-line-sub").textContent])).toEqual([["Oct 10", "₱5,000", "Cash · No proof"], ["Oct 1", "₱15,000", "GCash · Ref GC-1 · PDF proof"]]);
    expect(d.querySelector('[data-role="fold-activity"]')?.open ?? false).toBe(false);
    expect([...d.querySelectorAll(".modal-footer button")].map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("Remove: nothing recorded → deleted; with payments → off the active list, payments kept (the confirmation says so); Bring back", async () => {
    const fresh = { ...SUP, id: "supFreshOne01", name: "New Florist", paid: 0, upcoming: 0, upcomingCount: 0, nextDue: null };
    const asked = [];
    const data = fakeData({ listSuppliers: vi.fn(async (_b, f) => ({ rows: f.status === "inactive" ? [{ ...SUP, id: "supOldOne0001", name: "Old Band", status: "inactive" }] : [SUP, fresh], hasMore: false })) });
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {}, confirm: async (c) => (asked.push(c), true) });
    await flush();
    container.querySelector('[data-supplier="supFreshOne01"] [data-x="remove"]').click();
    await flush();
    expect(asked[0]).toMatchObject({ title: "Remove New Florist?", body: "It will no longer appear in your Expenses list." });
    expect(data.suppliersApi).toHaveBeenCalledWith({ action: "delete", supplierId: "supFreshOne01" });
    container.querySelector('[data-supplier="supABCphoto01"] [data-x="remove"]').click();
    await flush();
    expect(asked[1].body).toBe("It will no longer appear in your Expenses list. Its ₱20,000 in payments and scheduled payments stay in your records and history.");
    expect(data.suppliersApi).toHaveBeenCalledWith({ action: "setStatus", supplierId: SUP.id, status: "inactive" });
    expect(data.suppliersApi).not.toHaveBeenCalledWith({ action: "delete", supplierId: SUP.id });
    expect(container.querySelector(".wl-fold summary").textContent).toBe("Removed from the list (1)");
    expect(menuOf('[data-supplier="supOldOne0001"]')).toEqual(["Details", "Bring back"]);
  });

  it("other expense: Edit (fields + proof), Details read-only (View proof only), Remove in plain words (a reason is kept)", async () => {
    const withProof = { ...OTHER, proof: { contentType: "image/png" } };
    const data = money({ listWeddingExpenses: vi.fn(async () => ({ rows: [withProof], hasMore: false })), expensesApi: vi.fn(async () => ({})), attachExpenseProof: vi.fn(async () => ({})), expenseProof: vi.fn(async () => ({ proof: { contentType: "image/png", dataBase64: "iVBORw0KGgo=" } })) });
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {}, confirm: async () => true, prepareProof: vi.fn(async () => ({ contentType: "image/jpeg", dataBase64: "AAAA" })) });
    await flush();
    const visible = rowOf(`[data-expense="${OTHER.id}"]`).cloneNode(true);
    visible.querySelector("details").remove();
    expect(visible.textContent).not.toMatch(/proof/i);
    rowOf(`[data-expense="${OTHER.id}"] [data-x="edit"]`).click();
    await flush();
    const f = lastForm();
    expect(f.querySelector('label[for$="proof"]')?.textContent || f.elements.proof.labels?.[0]?.textContent).toMatch(/Replace proof/);
    f.elements.amount.value = "2000";
    Object.defineProperty(f.elements.proof, "files", { value: [{ name: "r.jpg", type: "image/jpeg" }], configurable: true });
    submit(f);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "update", expenseId: OTHER.id, expectedRevision: 1, changes: { amount: 200000 } });
    expect(data.attachExpenseProof).toHaveBeenCalledWith(OTHER.id, { contentType: "image/jpeg", dataBase64: "AAAA" });
    rowOf(`[data-expense="${OTHER.id}"] [data-x="view"]`).click();
    await flush();
    expect([...document.querySelectorAll('[data-role="details"] .modal-footer button')].map((b) => b.textContent)).toEqual(["View proof", "Close"]);
    document.querySelector('[data-role="details"] [data-act="close"]').click();
    rowOf(`[data-expense="${OTHER.id}"] [data-x="remove"]`).click();
    await flush();
    expect(document.querySelector(".modal-backdrop .card-title, .modal-backdrop h2").textContent).toBe("Remove this money item?");
    lastForm().elements.reason.value = "Entered twice";
    submit(lastForm());
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "remove", expenseId: OTHER.id, reason: "Entered twice" });
  });

  it("permissions: without expenses.create / vendorpayments.manage there is no Pay, and + Add Expense records only the contract", async () => {
    const s = wedding("manager");
    delete s.member.permissions["expenses.create"];
    delete s.member.permissions["vendorpayments.manage"];
    await mountMoney(money(), s);
    expect(container.querySelector('[data-act="pay"]')).toBeNull();
    container.querySelector('[data-act="add-expense"]').click();
    const f = lastForm();
    expect([f.elements.amount, f.elements.when, f.elements.dueDate]).toEqual([undefined, undefined, undefined]);
    expect([...f.elements.supplierId.options].map((o) => o.value)).not.toContain("__none");
  });

  it("paidState and toSupplierInput keep their rules", () => {
    expect(paidState({ paid: 0, agreedAmount: 100 })).toBe("unpaid");
    expect(paidState({ paid: 100, agreedAmount: 100 })).toBe("paid");
    expect(paidState({ paid: 5, agreedAmount: null })).toBe("paid");
    expect(toSupplierInput({ name: "X", service: "venue", agreedAmount: "", categoryId: "", contactPerson: "", phone: "", email: "", location: "", notes: "" })).toMatchObject({ agreedAmount: null, categoryId: null });
  });
});

describe("Supplier Payments", () => {
  it("Mark paid sends one markPaid; a retry answered 'already paid' says no second expense", async () => {
    const data = fakeData();
    const toast = vi.fn();
    mountPayments(container, wedding(), { data, now: NOW, toast });
    await flush();
    expect(cells("payments")[0].slice(0, 3)).toEqual(["Dec 1, 2026", "ABC Photo Studio", "Second payment"]);
    container.querySelector('[data-act="pay"]').click();
    submit(lastForm());
    await flush();
    expect(data.paymentsApi).toHaveBeenCalledTimes(1);
    expect(data.paymentsApi).toHaveBeenCalledWith({ action: "markPaid", paymentId: PAY.id, payment: { paidDate: "2026-10-16", method: "bank_transfer" } });
    data.paymentsApi.mockResolvedValueOnce({ expenseId: PAY.id, alreadyPaid: true });
    container.querySelector('[data-act="pay"]').click();
    submit(lastForm());
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/no second expense/), "success");
  });
  it("no Mark paid without expenses.create", async () => {
    const s = wedding("manager");
    delete s.member.permissions["expenses.create"];
    mountPayments(container, s, { data: fakeData(), now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-act="pay"]')).toBeNull();
  });
});

describe("Tasks (Owner-pilot Bridal UX): a compact checklist", () => {
  const MORE = [
    ...TASKS,
    { id: "taskLater0001", title: "Book honeymoon", dueDate: "2026-12-20", priority: "normal", status: "not_started", open: true, history: [] },
    { id: "taskNoDate001", title: "Choose songs", dueDate: null, priority: "normal", status: "in_progress", open: true, history: [] },
    { id: "taskDone00001", title: "Finalize invitation", dueDate: "2026-10-01", completedDate: "2026-10-02", priority: "normal", status: "completed", open: false, history: [] },
  ];
  it("ONE active list by due date (late first, no date last), no Overdue / Due soon sections; done folded under Completed (n); one line: task · status ▾ · due · ⋯", async () => {
    const data = fakeData({ listTasks: vi.fn(async () => ({ rows: MORE, hasMore: false })) });
    mountTasks(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(data.listTasks).toHaveBeenCalledWith("demo-distributor-a", { state: "all" }, { today: "2026-10-16", pageSize: 500 });
    expect(container.querySelectorAll("[data-group], .wl-group-title")).toHaveLength(0);
    expect([...container.querySelectorAll('[data-role="tasks"] > [data-task]')].map((r) => r.dataset.task)).toEqual(["taskChurch001", "taskFitting01", "taskLater0001", "taskNoDate001"]);
    expect(container.querySelector('[data-role="done"] summary').textContent).toBe("Completed (1)");
    expect(container.querySelector('[data-role="done"]').open).toBe(false);
    const row = container.querySelector('[data-task="taskChurch001"]');
    expect(row.querySelector(".wl-name").textContent).toBe("Submit church requirements");
    // Late: a quiet red date (and "Overdue" for screen readers), no section.
    const due = row.querySelector('[data-role="due"]');
    expect([due.textContent, due.classList.contains("is-over")]).toEqual(["Overdue, due Oct 10", true]);
    expect(container.querySelector('[data-task="taskFitting01"] [data-role="due"]').textContent).toBe("Oct 20");
    expect(container.querySelector('[data-act="export"]')).toBeNull();
    expect([...row.querySelectorAll('select[data-act="status"] option')].map((o) => o.textContent)).toEqual(["To do", "In progress", "Done"]);
    expect([...row.querySelectorAll(".menu-item")].map((b) => b.textContent)).toEqual(["Edit", "Change due date", "Details & history", "Delete"]);
    expect(sortTasks(MORE).done.map((x) => x.id)).toEqual(["taskDone00001"]);
  });

  it("a bell link (?task=) opens that task", async () => {
    mountTasks(container, wedding(), { data: fakeData(), now: NOW, toast: () => {}, location: { search: "?task=taskFitting01" } });
    await flush();
    expect(document.querySelector('[data-role="details"] .card-title').textContent).toBe("Gown fitting");
  });

  it("status changes from the row (one setStatus); Change due date sends one update", async () => {
    const data = fakeData();
    mountTasks(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    const sel = container.querySelector('select[data-act="status"][data-id="taskChurch001"]');
    sel.value = "completed";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.tasksApi).toHaveBeenCalledWith({ action: "setStatus", taskId: "taskChurch001", status: "completed" });
    container.querySelector('[data-task="taskFitting01"] [data-act="due"]').click();
    await flush();
    lastForm().elements.dueDate.value = "2026-11-05";
    submit(lastForm());
    await flush();
    expect(data.tasksApi).toHaveBeenLastCalledWith({ action: "update", taskId: "taskFitting01", expectedRevision: undefined, changes: { dueDate: "2026-11-05" } });
  });

  it("Add task asks only Task + Due date; the rest sits under More options", async () => {
    const data = fakeData();
    mountTasks(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    container.querySelector('[data-act="new"]').click();
    const form = lastForm();
    const main = [...form.querySelectorAll(".field")].filter((f) => !f.closest(".form-more")).map((f) => f.querySelector("input,select,textarea").name);
    expect(main).toEqual(["title", "dueDate"]);
    expect(form.querySelector(".form-more summary").textContent).toBe("More options");
    form.elements.title.value = "Book florist";
    form.elements.dueDate.value = "2026-11-05";
    submit(form);
    await flush();
    expect(data.tasksApi).toHaveBeenCalledWith({ action: "create", task: { title: "Book florist", category: null, assignee: null, dueDate: "2026-11-05", priority: "normal", notes: null, forWhom: null, source: null } });
    // Requirement details (For / Where to get it) sit under More options.
    expect(["forWhom", "source"].every((n) => form.elements[n].closest(".form-more"))).toBe(true);
  });
});

describe("Guests (Owner-pilot Bridal UX): RSVP | Seating", () => {
  const G = [
    { ...GUEST, category: "family" },
    { id: "guestSantos01", name: "Maria Santos", category: "family", side: "bride", partySize: 2, rsvp: "attending", confirmed: 2, tableId: "tA1b2c3d4", revision: 1, history: [] },
    { id: "guestReyes001", name: "Carlo Reyes", category: "friends", side: "groom", partySize: 3, rsvp: "attending", confirmed: 2, revision: 1, history: [] },
    { id: "guestCruz0001", name: "Ana Cruz", category: "friends", side: "both", partySize: 1, rsvp: "declined", confirmed: 0, revision: 1, history: [] },
    { id: "guestOld00001", name: "Old Guest", side: "both", partySize: 1, rsvp: "awaiting", confirmed: 0, revision: 1, history: [] },
  ];
  const SEATING = { tables: { tA1b2c3d4: { name: "Table 1", capacity: 2, order: 1 }, tB1b2c3d4: { name: "Table 2", capacity: 10, order: 2 } } };
  const guestsData = (extra = {}) => fakeData({ listGuests: vi.fn(async () => ({ rows: G, hasMore: false })), getSeating: vi.fn(async () => SEATING), ...extra });
  const switchTo = (v) => container.querySelector(`[data-seg="view"][data-value="${v}"]`).click();

  it("RSVP: a one-line summary in people, then guests grouped by their category with their own counts; one line: Name | Seats | RSVP | ⋯", async () => {
    const data = guestsData();
    mountGuests(container, wedding(), { data, toast: () => {} });
    await flush();
    expect(data.listGuests).toHaveBeenCalledWith("demo-distributor-a", {}, { pageSize: 1000 });
    expect(container.querySelector('[data-role="rsvp-summary"]').textContent).toBe("9 invited · 3 attending · 2 seated"); // people (2026-10-21: invited · attending · seated)
    expect(container.querySelectorAll(".stat-card")).toHaveLength(0);
    // Order: summary, RSVP | Seating, then Search + RSVP ▾ (one dropdown, no chips).
    const order = [...container.querySelectorAll('[data-role="rsvp-summary"], [data-role="seg-view"], [data-role="search"], [data-role="filter"]')].map((x) => x.dataset.role);
    expect(order).toEqual(["rsvp-summary", "seg-view", "search", "filter"]);
    expect([...container.querySelector('[data-role="filter"]').options].map((o) => o.textContent)).toEqual(["All", "Waiting", "Attending", "Declined"]);
    expect(container.querySelector('[data-role="seg-filter"]')).toBeNull();
    // Category header: "FAMILY · 2/6" = people attending / invited.
    const cats = [...container.querySelectorAll("[data-category]")].map((d) => [d.dataset.category, d.querySelector(".wl-group-title").textContent, d.querySelector('[data-role="cat-counts"]').textContent]);
    expect(cats).toEqual([
      ["family", "Family", "· 2/6"],
      ["friends", "Friends", "· 2/4"],
      ["none", "Not set", "· 0/1"],
    ]);
    // Each group's list scrolls in its own box (CSS caps it at ~6 rows).
    expect([...container.querySelectorAll('[data-role="guests"]')].every((u) => u.classList.contains("wl-scroll"))).toBe(true);
    expect(container.querySelector('[data-act="export"]')).toBeNull();
    const row = container.querySelector('[data-guest="guestReyes001"]');
    expect([row.querySelector(".wl-name").textContent, row.querySelector('[data-role="seats"]').textContent, row.querySelector('[data-role="rsvp"]').selectedOptions[0].textContent]).toEqual(["Carlo Reyes", "2/3", "Attending"]);
    expect(seatsText({ rsvp: "awaiting", partySize: 4, confirmed: 0 })).toBe("4");
    expect(groupGuests(G).map((g) => g.id)).toEqual(["family", "friends", "none"]);
  });

  it("Waiting shows only waiting guests under each category (empty categories hidden); search works across categories", async () => {
    mountGuests(container, wedding(), { data: guestsData(), toast: () => {} });
    await flush();
    const pick = (v) => {
      const sel = container.querySelector('[data-role="filter"]');
      sel.value = v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    };
    pick("awaiting");
    expect([...container.querySelectorAll("[data-category]")].map((d) => d.dataset.category)).toEqual(["family", "none"]);
    expect(container.querySelector('[data-category="family"] [data-role="cat-counts"]').textContent).toBe("· 0/4");
    const box = container.querySelector('[data-role="search"]');
    pick("all");
    const search = container.querySelector('[data-role="search"]');
    search.value = "cruz";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...container.querySelectorAll("[data-guest]")].map((r) => r.dataset.guest)).toEqual(["guestCruz0001"]);
    expect(box).not.toBeNull();
  });

  it("RSVP from the row: Waiting/Declined in one tap; Attending for a party asks how many (1..party size)", async () => {
    const data = guestsData();
    mountGuests(container, wedding(), { data, toast: () => {} });
    await flush();
    const sel = () => container.querySelector('[data-guest="guestPrado001"] [data-role="rsvp"]');
    sel().value = "declined";
    sel().dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "setRsvp", guestId: GUEST.id, rsvp: { status: "declined" } });
    sel().value = "attending";
    sel().dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(lastForm().elements.confirmed.value).toBe("4");
    lastForm().elements.confirmed.value = "3";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "setRsvp", guestId: GUEST.id, rsvp: { status: "attending", confirmed: 3 } });
  });

  it("2 invited, 1 coming: the row reads 1/2; FAMILY counts 1 attending; Seating takes 1 seat (full shown); an older whole-party record that grows is flagged over", async () => {
    const maria = { id: "guestMaria01", name: "Maria Santos", category: "family", side: "bride", partySize: 2, rsvp: "attending", confirmed: 1, tableId: "tA1b2c3d4", revision: 1, history: [] };
    const tan = { id: "guestTan0001", name: "Tan", category: "family", side: "groom", partySize: 1, rsvp: "attending", confirmed: 1, tableId: "tA1b2c3d4", revision: 1, history: [] };
    const show = async (rows) => {
      document.body.innerHTML = '<main id="content"></main>';
      container = document.getElementById("content");
      mountGuests(container, wedding(), { data: fakeData({ listGuests: vi.fn(async () => ({ rows, hasMore: false })), getSeating: vi.fn(async () => SEATING), getWeddingSetup: vi.fn(async () => null) }), toast: () => {}, confirm: async () => true });
      await flush();
    };
    await show([maria, tan]);
    expect(container.querySelector('[data-guest="guestMaria01"] [data-role="seats"]').textContent).toBe("1/2");
    expect(container.querySelector('[data-category="family"] [data-role="cat-counts"]').textContent).toBe("· 2/3");
    container.querySelector('[data-act="seg"][data-value="seating"]').click();
    await flush();
    const t1 = () => container.querySelector('[data-table="tA1b2c3d4"] [data-role="table-seats"]');
    expect([t1().textContent.trim(), t1().classList.contains("is-over")]).toEqual(["· 2/2 · full", false]);
    await show([{ ...maria, confirmed: 2 }, tan]);
    container.querySelector('[data-act="seg"][data-value="seating"]').click();
    await flush();
    expect([t1().textContent.trim(), t1().classList.contains("is-over")]).toEqual(["· 3/2 · over by 1", true]);
  });

  it("Seating: attending · seated · unassigned (people); Unassigned first, then tables with seats used / capacity", async () => {
    mountGuests(container, wedding(), { data: guestsData(), toast: () => {} });
    await flush();
    switchTo("seating");
    expect(container.querySelector('[data-role="seating-summary"]').textContent).toBe("4 attending · 2 seated · 2 unassigned");
    // Unassigned: each PERSON (2026-10-21), grouped by party with a quiet party label.
    expect([...container.querySelectorAll('[data-role="unassigned"] [data-person]')].map((r) => r.dataset.person)).toEqual(["guestReyes001|primary", "guestReyes001|u1"]);
    expect([...container.querySelectorAll('[data-role="unassigned"] .wl-name')].map((n) => n.textContent)).toEqual(["Carlo Reyes", "Member 2"]);
    expect(container.querySelector('[data-party="guestReyes001"] [data-role="party-label"]').textContent).toBe("Carlo Reyes's party");
    expect(container.querySelector('[data-role="unassigned"] [data-act="seat-person"]').textContent).toBe("Assign");
    // Tables list people.
    expect([...container.querySelectorAll('[data-table="tA1b2c3d4"] [data-person] .wl-name')].map((n) => n.textContent)).toEqual(["Maria Santos", "Member 2"]);
    expect([...container.querySelectorAll("[data-table]")].map((s) => [s.querySelector(".wl-group-title").textContent, s.querySelector('[data-role="table-seats"]').textContent])).toEqual([["Table 1", "· 2/2 · full"], ["Table 2", "· 0/10"]]);
    expect(container.querySelector('[data-act="new-table"]')).not.toBeNull();
    expect(container.querySelector('[data-role="search"]')).toBeNull();
  });

  it("assign / move / unassign one PERSON per call (the rest of the party untouched); full tables say so; + Add table creates one table", async () => {
    const data = guestsData();
    mountGuests(container, wedding(), { data, toast: () => {} });
    await flush();
    switchTo("seating");
    container.querySelector('[data-person="guestReyes001|u1"] [data-act="seat-person"]').click();
    await flush();
    // Table 1 is full (2/2): it says so, and the free table is suggested.
    expect([...lastForm().elements.tableId.options].map((o) => o.textContent)).toEqual(["Table 1 · 2/2 · full", "Table 2 · 0/10"]);
    expect(lastForm().elements.tableId.value).toBe("tB1b2c3d4");
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "seatPerson", guestId: "guestReyes001", seatKey: "u1", tableId: "tB1b2c3d4" });
    switchTo("seating");
    container.querySelector('[data-person="guestSantos01|primary"] [data-act="unseat-person"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "seatPerson", guestId: "guestSantos01", seatKey: "primary", tableId: null });
    switchTo("seating");
    container.querySelector('[data-person="guestSantos01|u1"] [data-act="seat-person"]').click();
    await flush();
    expect(lastForm().querySelector("h2, .modal-header").textContent).toMatch(/Move Member 2/);
    expect([...lastForm().elements.tableId.options].map((o) => o.value)).toEqual(["tB1b2c3d4"]); // not the table they're at
    switchTo("seating");
    container.querySelector('[data-act="new-table"]').click();
    await flush();
    expect(lastForm().elements.name.value).toBe("Table 3");
    lastForm().elements.capacity.value = "8";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "createTable", table: { name: "Table 3", capacity: 8 } });
  });

  it("seatingPlan (per person): only attending people count; a missing table means unassigned; an older whole-party record reads as all its people; over capacity is shown", () => {
    const plan = seatingPlan([...G, { id: "x", name: "X", rsvp: "attending", confirmed: 3, tableId: "tA1b2c3d4" }, { id: "y", name: "Y", rsvp: "declined", confirmed: 0, tableId: "tB1b2c3d4" }, { id: "z", name: "Z", rsvp: "attending", confirmed: 1, seats: { primary: "tGone12345" } }, { id: "w", name: "W", rsvp: "attending", confirmed: 2, partySize: 3, seats: { primary: "tB1b2c3d4" } }], SEATING);
    expect(plan.tables[0]).toMatchObject({ used: 5, capacity: 2 });
    expect(plan.tables[1].people.map((p) => p.name)).toEqual(["W"]);
    expect(plan.unassigned.map((u) => [u.guest.id, u.people.map((p) => p.key)])).toEqual([["guestReyes001", ["primary", "u1"]], ["z", ["primary"]], ["w", ["u1"]]]);
    expect([plan.attendingSeats, plan.seatedSeats, plan.unassignedSeats]).toEqual([10, 6, 4]);
  });

  it("a new guest needs a category; parseRsvp: confirmed only for Attending, never above the party size", () => {
    expect(() => toGuestInput({ name: "A", category: "", side: "both", partySize: "2", contact: "", invitationSent: "", notes: "" })).toThrow(/category/);
    expect(toGuestInput({ name: "A", category: "family", partySize: "2" })).toMatchObject({ category: "family", side: "both" });
    expect(parseRsvp({ status: "declined", confirmed: "3" }, 4)).toEqual({ status: "declined" });
    expect(() => parseRsvp({ status: "attending", confirmed: "5" }, 4)).toThrow();
    expect(() => parseRsvp({ status: "attending", confirmed: "0" }, 4)).toThrow();
  });
});

describe("Wedding Dashboard (Phase 18.5): are we on track?", () => {
  it("budget hero from budgets; tasks from taskTotals + a live overdue count; RSVP from guestTotals; total upcoming payments", async () => {
    const fetchDocuments = vi.fn(async (_b, docs) =>
      Object.fromEntries(
        docs.map((d) => [
          d.source,
          {
            status: "ok",
            data: d.source === "wedding-day" ? { spent: 2000000, count: 1, supplierPaid: 2000000 } : d.source === "wedding-current" ? BUDGET : d.source === "task-current" ? { open: 7 } : d.source === "rsvp-current" ? TOTALS : d.count ? { count: 2 } : null,
          },
        ])
      )
    );
    const fetchLists = vi.fn(async () => ({ upcomingSupplierPayments: { status: "ok", rows: [PAY] }, tasksDueSoon: { status: "ok", rows: TASKS }, recentWeddingExpenses: { status: "ok", rows: [] }, rsvpSummary: { status: "ok", rows: [{ id: "attending", row: "attending", ...TOTALS }] } }));
    mountDashboard(container, wedding(), { fetchDocuments, fetchLists, now: NOW(), toast: () => {} });
    await flush();
    const plan = fetchDocuments.mock.calls[0][1];
    expect(plan.find((d) => d.count)).toMatchObject({ source: "count:weddingOverdueTasks", collection: "weddingTasks", where: [["open", "==", true], ["dueDate", "<", "2026-10-16"]] });
    const val = (id) => container.querySelector(`[data-widget="${id}"] .kpi-value`).textContent;
    expect(val("weddingRemaining")).toMatch(/480,000/);
    expect(container.querySelector('[data-role="supplier-balance"]').textContent).toMatch(/60,000/);
    expect(container.querySelector('[data-section="tasks"] [data-count="open"] b').textContent).toBe("7");
    expect(container.querySelector('[data-section="tasks"] [data-count="overdue"] b').textContent).toBe("2");
    expect(container.querySelector('[data-section="rsvp"]').textContent).toMatch(/3 of 9 invited seats confirmed/);
    expect(container.querySelector('[data-section="rsvp"]').textContent).toContain("4 awaiting (1 invitation)");
    expect(container.querySelector('[data-section="attention"]')).toBeNull();
    expect(container.querySelector('[data-role="upcoming-total"]').textContent).toMatch(/30,000/);
    expect(container.textContent).not.toMatch(/Gross|COGS|Profit|Sales|Baby/);
  });
});

describe("Phase 18.5 corrections: Delete what was added by mistake", () => {
  const panel = () => document.querySelector('[data-role="details"]');

  it("Tasks: details → Delete asks first, then sends one delete", async () => {
    const data = fakeData();
    mountTasks(container, wedding(), { data, now: NOW, toast: () => {}, confirm: async () => true });
    await flush();
    container.querySelector('[data-task="taskChurch001"] [data-act="view"]').click();
    panel().querySelector('[data-act="delete"]').click();
    await flush();
    expect(data.tasksApi).toHaveBeenCalledWith({ action: "delete", taskId: "taskChurch001" });
  });

  it("Wedding Budget: ⋯ Delete for a never-used category (cancel sends nothing)", async () => {
    const data = fakeData();
    let answer = false;
    mountBudget(container, wedding(), { data, toast: () => {}, confirm: async () => answer });
    await flush();
    container.querySelector('[data-act="delete"][data-id="catVenue00001"]').click();
    await flush();
    expect(data.budgetApi).not.toHaveBeenCalledWith({ action: "deleteCategory", categoryId: "catVenue00001" });
    answer = true;
    container.querySelector('[data-act="delete"][data-id="catVenue00001"]').click();
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "deleteCategory", categoryId: "catVenue00001" });
  });
});

describe("Bridal More: Wedding Setup and Download Excel", () => {
  it("More holds Wedding Setup and Download Excel; Staff get neither", () => {
    expect(buildRoutes(wedding()).filter((r) => ["/wedding-setup", "/export"].includes(r.path)).map((r) => r.label)).toEqual(["Download Excel", "Wedding Setup"]);
    expect(buildRoutes(wedding("staff")).some((r) => ["/wedding-setup", "/export"].includes(r.path))).toBe(false);
  });

  const FULL = { coupleNames: "Camille & Carlo", ceremonyVenue: "Example Church", ceremonyAddress: "Taguig City", receptionVenue: "Example Garden", receptionAddress: "Pasig City", dressCode: "Formal", welcomeMessage: "Join us!", weddingDate: "2027-12-12", rsvpDeadline: "2027-11-15", ceremonyTime: "15:00", receptionTime: "17:30", ceremonyMap: "https://maps.app.goo.gl/church", receptionMap: "https://maps.app.goo.gl/garden", rsvpEnabled: true, closeAfterDeadline: false, weddingSlug: "camilleandcarloforever" };

  const guestMenuItems = () => [...container.querySelectorAll('[data-guest="guestPrado001"] .menu-item')].map((b) => b.textContent);
  it("Guest ⋯ before Wedding Setup is complete: 'complete Wedding Setup first →' links to it (not hidden)", async () => {
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: [{ ...GUEST, category: "family" }], hasMore: false })), getSeating: vi.fn(async () => null), getWeddingSetup: vi.fn(async () => ({ setup: { coupleNames: "Camille & Carlo" } })) });
    mountGuests(container, wedding(), { data, toast: () => {}, confirm: async () => true });
    await flush();
    expect(guestMenuItems()).toContain("Invitation: complete Wedding Setup first →");
    expect(guestMenuItems()).not.toContain("Create invitation link");
    const link = container.querySelector('[data-guest="guestPrado001"] [data-act="invite-setup"]');
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/wedding-setup");
    expect(link.hasAttribute("data-link")).toBe(true);
  });

  it("Guest ⋯ during the free trial: no guest links, Preview is in Wedding Setup", async () => {
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: [{ ...GUEST, category: "family", invitation: { status: "active" } }], hasMore: false })), getSeating: vi.fn(async () => null), getWeddingSetup: vi.fn(async () => ({ setup: FULL })), guestsApi: vi.fn() });
    mountGuests(container, { ...wedding(), subscription: { trial: { open: true } } }, { data, toast: () => {}, confirm: async () => true });
    await flush();
    expect(guestMenuItems()).toContain("Invitation: preview in Wedding Setup (free trial) →");
    expect(guestMenuItems()).not.toContain("Create invitation link");
    expect(guestMenuItems()).not.toContain("View invitation");
    expect(container.querySelector('[data-guest="guestPrado001"] [data-act="invite-setup"]').getAttribute("href")).toBe("/wedding-setup");
    expect(data.guestsApi).not.toHaveBeenCalled();
  });

  it("Guest ⋯ with Wedding Setup done and no link yet: Create invitation link creates, copies and refreshes", async () => {
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: [{ ...GUEST, category: "family" }], hasMore: false })), getSeating: vi.fn(async () => null), getWeddingSetup: vi.fn(async () => ({ setup: FULL })), guestsApi: vi.fn(async () => ({ path: "/invite/" + "a".repeat(32), created: true })) });
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    const toast = vi.fn();
    mountGuests(container, wedding(), { data, toast, confirm: async () => true });
    await flush();
    expect(guestMenuItems()).toContain("Create invitation link");
    expect(guestMenuItems()).not.toContain("Regenerate link");
    const loads = data.listGuests.mock.calls.length;
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-create"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "inviteLink", guestId: GUEST.id });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${location.origin}/invite/${"a".repeat(32)}`);
    expect(toast).toHaveBeenCalledWith("Copied ✓ New invitation link for Prado Family", "success");
    expect(data.listGuests.mock.calls.length).toBeGreaterThan(loads);
  });

  it("Guest ⋯ with a link: View invitation (inside Luna, Owner bar) / Copy invitation link (Copied ✓) / Share invitation / Regenerate link", async () => {
    const LINK = "/w/camilleandcarloforever/invite/" + "a".repeat(32);
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: [{ ...GUEST, category: "family", invitation: { status: "active" } }], hasMore: false })), getSeating: vi.fn(async () => null), getWeddingSetup: vi.fn(async () => ({ setup: FULL })), guestsApi: vi.fn(async () => ({ path: LINK })) });
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) }, share: vi.fn(async () => {}) });
    const toast = vi.fn();
    const preview = vi.fn(async () => ({}));
    mountGuests(container, wedding(), { data, toast, confirm: async () => true, preview });
    await flush();
    expect(guestMenuItems()).toEqual(["Edit", "View invitation", "Copy invitation link", "Share invitation", "Regenerate link", "Details", "View history", "Remove guest"]);
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-copy"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "inviteLink", guestId: GUEST.id });
    // The complete friendly link: host + /w/{wedding}/invite/{private code}.
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${location.origin}${LINK}`);
    expect(toast).toHaveBeenCalledWith("Copied ✓ Invitation link for Prado Family", "success");
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-share"]').click();
    await flush();
    expect(navigator.share).toHaveBeenCalledWith({ title: "Wedding invitation", text: "Prado Family, you're invited! Open your personal invitation to RSVP:", url: `${location.origin}${LINK}` });
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-view"]').click();
    await flush();
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ token: "a".repeat(32), actions: [{ id: "copy", label: "Copy guest link" }, { id: "share", label: "Share" }, { id: "open", label: "Open as guest ↗", href: `${location.origin}${LINK}` }] }));
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-new"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "regenerateInvite", guestId: GUEST.id });
    expect(toast).toHaveBeenCalledWith("Copied ✓ New invitation link for Prado Family (the old one no longer works)", "success");
    delete navigator.share;
  });

  it("the Owner's in-app preview: invitation + Owner-only bar; answers aren't sent; the address bar is left alone", async () => {
    const before = window.location.pathname;
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation: { wedding: FULL, hero: null, guest: { name: "Maria Santos", seats: 2, rsvp: "awaiting", confirmed: 0 }, rsvpOpen: true, path: "/w/x/invite/" + "a".repeat(32) } }) }));
    const onAction = vi.fn();
    const { close } = await openInvitePreview({ token: "a".repeat(32), fetchImpl, actions: [{ id: "copy", label: "Copy guest link" }], onAction });
    const box = document.querySelector('[data-role="invite-preview"]');
    expect(box.querySelector('[data-role="owner-bar"]').textContent).toContain("Copy guest link");
    expect(box.querySelector('[data-role="guest-name"]').textContent).toBe("Maria Santos");
    box.querySelector('[data-pv="copy"]').click();
    expect(onAction).toHaveBeenCalledWith("copy", expect.anything());
    box.querySelector('[data-act="decline"]').click();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the view
    expect(box.textContent).toContain("Preview only");
    expect(window.location.pathname).toBe(before);
    close();
    expect(document.querySelector('[data-role="invite-preview"]')).toBeNull();
  });

  it("the wedding link alone (/w/{slug}) shows only a 'personal links' note, nothing about the wedding", async () => {
    window.history.replaceState(null, "", "/w/camilleandcarloforever");
    document.body.innerHTML = '<div id="root"></div>';
    const fetchImpl = vi.fn();
    await renderInvitePage(document.getElementById("root"), { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(document.querySelector('[data-role="message"]').textContent).toBe("Wedding invitations are personal. Please open the invitation link the couple sent you.");
    window.history.replaceState(null, "", "/");
  });
});

describe("Owner-pilot Bridal: Sample Checklist (Tasks)", () => {
  it("Tasks: My Tasks | Sample Checklist; read-only groups (church + civil requirements with their notes); optional / Bride & Groom marked; already-added shown; + Add makes ONE normal task", async () => {
    const data = fakeData({ listTasks: vi.fn(async () => ({ rows: [{ ...TASKS[0], title: "CENOMAR (Certificate of No Marriage)" }], hasMore: false })), tasksApi: vi.fn(async () => ({ taskId: "t9" })) });
    mountTasks(container, wedding(), { data, now: NOW, toast: () => {}, confirm: async () => true });
    await flush();
    expect([...container.querySelectorAll('[data-role="seg-view"] .seg-btn')].map((b) => b.textContent)).toEqual(["My Tasks", "Sample Checklist"]);
    container.querySelector('[data-act="seg"][data-value="sample"]').click();
    await flush();
    const heads = [...container.querySelectorAll(".wl-sample-group .wl-group-title")].map((h) => h.textContent);
    expect(heads).toEqual(["Documents & Legal", "Church Requirements", "Civil / Marriage License", "Ceremony", "Reception", "Attire & HMUA", "Entourage", "Wedding Essentials", "Photo & Video", "Invitations", "Gifts & Souvenirs", "Prenup / Engagement Shoot"]);
    const group = (id) => container.querySelector(`[data-sample-group="${id}"]`);
    expect(group("church").querySelector('[data-role="sample-note"]').textContent).toMatch(/^Optional · requirements vary by church \/ parish/);
    expect(group("church").querySelector('[data-role="sample-sub"]').textContent).toBe("Officiating priest (if not from the parish)");
    expect(group("civil").querySelector('[data-role="sample-note"]').textContent).toBe("Requirements vary by city / municipality. Verify with your local civil registrar.");
    const line = (title) => [...container.querySelectorAll(".wl-sample")].find((li) => li.querySelector(".wl-name").textContent === title);
    expect(line("CENOMAR (Certificate of No Marriage)").querySelector('[data-role="added"]').textContent).toBe("Added ✓");
    expect([...line("Baptismal certificate (for marriage purposes)").querySelectorAll(".wl-opt")].map((x) => x.textContent)).toEqual(["Bride & Groom"]);
    expect(line("Priest's celebret / letter of good standing").querySelector(".wl-opt").textContent).toBe("Optional");
    // Duplicates merged: PSA / CENOMAR once; Veil once (the ceremony one is the sponsors' unity veil).
    const names = [...container.querySelectorAll(".wl-sample .wl-name")].map((n) => n.textContent);
    expect(names.filter((n) => /PSA|CENOMAR/.test(n))).toEqual(["PSA birth certificate", "CENOMAR (Certificate of No Marriage)"]);
    expect(names.filter((n) => n === "Veil" || n.startsWith("Unity veil"))).toEqual(["Veil", "Unity veil (veil sponsors)"]);
    expect(names.filter((n) => /^veil$/i.test(n)).length).toBe(1);
    expect(data.tasksApi).not.toHaveBeenCalled(); // nothing is added by itself
    line("Baptismal certificate (for marriage purposes)").querySelector('[data-act="sample-add"]').click();
    await flush();
    expect(data.tasksApi).toHaveBeenCalledTimes(1);
    expect(data.tasksApi).toHaveBeenCalledWith({ action: "create", task: { title: "Baptismal certificate (for marriage purposes)", category: "Church Requirements", assignee: null, dueDate: null, priority: "normal", notes: null, forWhom: "both" } });
    line("Marriage license application").querySelector('[data-act="sample-add"]').click();
    await flush();
    expect(data.tasksApi).toHaveBeenLastCalledWith({ action: "create", task: { title: "Marriage license application", category: "Civil / Marriage License", assignee: null, dueDate: null, priority: "normal", notes: null } });
    expect(container.querySelector('[data-act="seg"][data-value="sample"]').getAttribute("aria-pressed")).toBe("true"); // stays on the sample
  });

  it("a Bride & Groom requirement in My Tasks: one compact line 'Bride ✓ · Groom —'; ⋯ marks each one; details show For / Where to get it (no template note)", async () => {
    const req = { ...TASKS[1], id: "taskBapt0001", title: "Baptismal certificate", category: "Church Requirements", forWhom: "both", parts: { bride: true, groom: false }, source: "San Jose Parish", status: "in_progress", dueDate: "2026-11-01" };
    const data = fakeData({ listTasks: vi.fn(async () => ({ rows: [req], hasMore: false })), tasksApi: vi.fn(async () => ({})) });
    mountTasks(container, wedding(), { data, now: NOW, toast: () => {}, confirm: async () => true });
    await flush();
    const row = container.querySelector('[data-task="taskBapt0001"]');
    expect(row.querySelector('[data-role="for"]').textContent).toBe("Bride ✓ · Groom —");
    expect([...row.querySelectorAll(".menu-item")].slice(0, 2).map((b) => b.textContent)).toEqual(["Bride: mark not done", "Groom: mark done"]);
    row.querySelector('[data-act="part"][data-who="groom"]').click();
    await flush();
    expect(data.tasksApi).toHaveBeenCalledWith({ action: "setPart", taskId: "taskBapt0001", person: "groom", done: true });
    container.querySelector('[data-task="taskBapt0001"] .wl-main').click();
    const d = document.querySelector('[data-role="details"]');
    const field = (k) => [...d.querySelectorAll("dt")].find((x) => x.textContent === k)?.nextElementSibling.textContent;
    expect([field("For"), field("Where to get it")]).toEqual(["Bride ✓ · Groom —", "San Jose Parish"]);
    expect(d.textContent).not.toMatch(/vary by/);
  });

  it("Tasks sample: no + Add without tasks.manage", async () => {
    const s = wedding("staff");
    s.member.permissions["tasks.view"] = true;
    delete s.member.permissions["tasks.manage"];
    mountTasks(container, s, { data: fakeData(), now: NOW, toast: () => {}, confirm: async () => true });
    await flush();
    container.querySelector('[data-act="seg"][data-value="sample"]').click();
    await flush();
    expect(container.querySelectorAll(".wl-sample").length).toBeGreaterThan(50);
    expect(container.querySelector('[data-act="sample-add"]')).toBeNull();
  });

});

describe("the guest's invitation page (/invite/{token}, no login)", () => {
  const TOKEN = "Abc123_-".repeat(4);
  const INV = { wedding: { coupleNames: "Camille & Carlo", weddingDate: "2027-12-12", ceremonyTime: "15:00", ceremonyVenue: "Example Church", ceremonyAddress: "Taguig City", receptionTime: "17:30", receptionVenue: "Example Garden", receptionAddress: "Taguig City", dressCode: "Formal", welcomeMessage: "Together with our families, we invite you to celebrate our wedding day.", rsvpDeadline: "2027-11-15" }, hero: null, guest: { name: "Maria Santos", seats: 2, rsvp: "awaiting", confirmed: 0 }, rsvpOpen: true };
  const fetcher = (answer) =>
    vi.fn(async (_u, { body }) => {
      const b = JSON.parse(body);
      const out = b.action === "view" ? { success: true, invitation: INV } : answer(b);
      return { ok: !out.error, status: out.error ? 409 : 200, json: async () => (out.error ? { message: out.error } : out) };
    });

  it("shows the couple's invitation for THIS party; Accept asks how many (≤ invited seats) and sends one answer", async () => {
    expect(inviteTokenFrom(`/invite/${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFrom("/invite/short")).toBe("");
    const fetchImpl = fetcher((b) => ({ success: true, rsvp: b.rsvp.status, confirmed: b.rsvp.confirmed ?? 0, name: "Maria Santos" }));
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    await renderInvitePage(root, { token: TOKEN, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("/api/invite", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "view", token: TOKEN }) }));
    expect(root.querySelector(".inv-names").textContent).toBe("Camille & Carlo");
    expect(root.querySelector(".inv-date").textContent).toBe("December 12, 2027");
    expect(root.textContent).toContain("3:00 PM");
    expect(root.textContent).toContain("RSVP before November 15, 2027");
    expect(root.querySelector('[data-role="guest-name"]').textContent).toBe("Maria Santos");
    expect(root.querySelector('[data-role="seats"]').textContent).toBe("2 seats reserved");
    root.querySelector('[data-act="accept"]').click();
    expect([...root.querySelectorAll("[data-seats]")].map((b) => b.textContent)).toEqual(["1", "2"]);
    // Reserved seats aren't assumed: nothing picked, Confirm RSVP waits.
    expect(root.querySelector(".inv-seat.is-on")).toBeNull();
    expect(root.querySelector('[data-act="send"]').textContent).toBe("Confirm RSVP");
    expect(root.querySelector('[data-act="send"]').disabled).toBe(true);
    root.querySelector('[data-seats="1"]').click();
    expect(root.querySelector('[data-act="send"]').disabled).toBe(false);
    root.querySelector('[data-act="send"]').click();
    await flush();
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body)).toEqual({ action: "respond", token: TOKEN, rsvp: { status: "attending", confirmed: 1 } });
    expect(root.querySelector('[data-role="done"]').textContent).toContain("Thank you, Maria.");
    expect(root.querySelector('[data-role="done"]').textContent).toContain("We've saved your RSVP for 1 guest (1 of 2 reserved seats).");
  });

it("friendly link /w/{slug}/invite/{token}: the token is still required; an older address moves to the current one", async () => {
    expect(inviteTokenFrom(`/w/carlo-and-yanie-wedding/invite/${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFrom(`/w/carloyanieforever/invite/${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFrom("/w/carlo-and-yanie-wedding")).toBe("");
    expect(inviteTokenFrom("/w/carlo-and-yanie-wedding/invite/short")).toBe("");
    expect(inviteTokenFrom("/w/carlo-and-yanie-wedding/invite/")).toBe("");
    window.history.replaceState(null, "", `/invite/${TOKEN}`);
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation: { ...INV, path: `/w/carlo-and-yanie-wedding/invite/${TOKEN}` } }) }));
    await renderInvitePage(root, { token: TOKEN, fetchImpl });
    // Only the token is sent: the slug never identifies anyone.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ action: "view", token: TOKEN });
    expect(window.location.pathname).toBe(`/w/carlo-and-yanie-wedding/invite/${TOKEN}`);
    // A path for some other token is never adopted.
    window.history.replaceState(null, "", `/w/old-slug/invite/${TOKEN}`);
    document.body.innerHTML = '<div id="root"></div>';
    await renderInvitePage(document.getElementById("root"), { token: TOKEN, fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation: { ...INV, path: `/w/x-wedding/invite/${"B".repeat(32)}` } }) })) });
    expect(window.location.pathname).toBe(`/w/old-slug/invite/${TOKEN}`);
    window.history.replaceState(null, "", "/");
  });

  it("2 reserved → 2 attending: both seats confirmed (2 of 2); an earlier answer is shown as 1 of 2", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    const fetchImpl = vi.fn(async (_u, { body }) => {
      const b = JSON.parse(body);
      const out = b.action === "view" ? { success: true, invitation: { ...INV, guest: { ...INV.guest, rsvp: "attending", confirmed: 1 } } } : { success: true, rsvp: "attending", confirmed: b.rsvp.confirmed, name: "Maria Santos" };
      return { ok: true, status: 200, json: async () => out };
    });
    await renderInvitePage(root, { token: TOKEN, fetchImpl });
    expect(root.querySelector('[data-role="current"]').textContent).toContain("Attending · 1 of 2");
    root.querySelector('[data-act="accept"]').click();
    expect(root.querySelector(".inv-seat.is-on").textContent).toBe("1"); // their current answer, not every seat
    root.querySelector('[data-seats="2"]').click();
    root.querySelector('[data-act="send"]').click();
    await flush();
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body).rsvp).toEqual({ status: "attending", confirmed: 2 });
    expect(root.querySelector('[data-role="done"]').textContent).toContain("2 guests (2 of 2 reserved seats)");
  });

  it("Decline thanks them; closed RSVPs say so; a bad link explains", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    let root = document.getElementById("root");
    await renderInvitePage(root, { token: TOKEN, fetchImpl: fetcher(() => ({ success: true, rsvp: "declined", confirmed: 0 })) });
    root.querySelector('[data-act="decline"]').click();
    await flush();
    expect(root.querySelector('[data-role="done"]').textContent).toContain("You'll be missed on our special day.");
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById("root");
    const closed = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation: { ...INV, rsvpOpen: false } }) }));
    await renderInvitePage(root, { token: TOKEN, fetchImpl: closed });
    expect(root.querySelector('[data-act="accept"]')).toBeNull();
    expect(root.querySelector('[data-role="closed"]')).not.toBeNull();
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById("root");
    await renderInvitePage(root, { token: "", fetchImpl: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ message: "This invitation link isn't valid. Please ask the couple for a new one." }) })) });
    expect(root.querySelector('[data-role="message"]').textContent).toMatch(/isn't valid/);
  });
});

describe("the bell in a wedding (Owner-pilot Bridal UX): Needs attention, Money / Tasks", () => {
  it("asks /api/wedding-attention; badge = unread items; read items stay (read is not resolved)", async () => {
    document.body.innerHTML = '<div id="slot"></div>';
    const todos = [
      { id: "paymentOverdue:p1", staffId: "money", name: "Money", kind: "paymentOverdue", text: "₱10,000 to ABC Photo Studio (Downpayment) was due Oct 10.", href: "/wedding-suppliers?supplier=s1", read: false },
      { id: "taskOverdue:t1", staffId: "tasks", name: "Tasks", kind: "taskOverdue", text: '"Book florist" was due Oct 12.', href: "/wedding-tasks?task=t1", read: true },
    ];
    const api = vi.fn(async (path) => (path === "wedding-attention" ? { summary: { todos } } : {}));
    const data = { fetchUnreadCount: vi.fn(async () => 0), fetchRecent: vi.fn(async () => []), markRead: vi.fn(), markAllRead: vi.fn() };
    const slot = document.getElementById("slot");
    const bell = mountBell(slot, wedding(), { data, api });
    await flush();
    expect(api).toHaveBeenCalledWith("wedding-attention");
    expect(slot.querySelector('[data-role="bell-count"]').textContent).toBe("1");
    slot.querySelector('[data-act="bell"]').click();
    await flush();
    expect([...slot.querySelectorAll(".todo-name")].map((x) => x.textContent)).toEqual(["Money", "Tasks"]);
    // Opening re-asks (a task done a moment ago leaves the list).
    expect(api.mock.calls.filter(([p]) => p === "wedding-attention")).toHaveLength(2);
    expect([...slot.querySelectorAll('[data-role="todo-state"]')].map((x) => x.textContent)).toEqual(["New · needs attention", "Read · still needs attention"]);
    bell.stop();
    // Staff (no payments / tasks view) never ask.
    const api2 = vi.fn(async () => ({}));
    const b2 = mountBell(slot, wedding("staff"), { data, api: api2 });
    await flush();
    expect(api2).not.toHaveBeenCalledWith("wedding-attention");
    b2.stop();
  });
});

describe("Owner-pilot Bridal: Music & Program (More)", () => {
  const ITEMS = [
    { id: "p1", section: "ceremony", order: 10, moment: "Groom entrance", song: "Turning Page", durationSec: 257, person: null, notes: null },
    { id: "p2", section: "ceremony", order: 20, moment: "Bride entrance", song: "Moon River", durationSec: 177, person: "Bride & father", notes: null },
    { id: "p3", section: "ceremony", order: 30, moment: "Recessional", song: null, durationSec: null, person: null, notes: null },
    { id: "p4", section: "reception", order: 10, moment: "Guest waiting", song: "Lounge playlist", durationSec: 3600, person: null, notes: null },
  ];
  const progApi = (items = ITEMS) => vi.fn(async (_p, { body }) => (body.action === "list" ? { items } : body.action === "create" ? { itemId: "pNew" } : {}));

  it("Ceremony | Reception and My Program | Sample Program; one line per moment: Moment | Song | Duration | ⋯", async () => {
    const api = progApi();
    mountProgram(container, wedding(), { api, toast: () => {} });
    await flush();
    expect(container.querySelector(".page-header h1, .page-header .page-title")?.textContent || container.textContent).toContain("Music & Program");
    expect([...container.querySelectorAll('[data-role="seg-section"] .seg-btn')].map((b) => b.textContent)).toEqual(["Ceremony", "Reception"]);
    expect([...container.querySelectorAll('[data-role="seg-mode"] .seg-btn')].map((b) => b.textContent)).toEqual(["My Program", "Sample Program"]);
    const rows = [...container.querySelectorAll('[data-role="program"] .wl-prog')].map((r) => [r.querySelector(".wl-prog-moment").textContent, r.querySelector('[data-role="song"]').textContent, r.querySelector('[data-role="duration"]').textContent]);
    expect(rows).toEqual([["Groom entrance", "Turning Page", "4:17"], ["Bride entrance", "Moon River", "2:57"], ["Recessional", "—", "—"]]);
    expect(container.querySelectorAll('.page-header [data-act="new"]').length).toBe(1);
    // Person / notes aren't on the row.
    expect(container.querySelector('[data-item="p2"]').textContent).not.toContain("Bride & father");
    // Order: first can't move up, last can't move down.
    const items = (id) => [...container.querySelectorAll(`[data-item="${id}"] .menu-item`)].map((b) => b.textContent);
    expect(items("p1")).toEqual(["Edit", "Move down", "Delete"]);
    expect(items("p2")).toEqual(["Edit", "Move up", "Move down", "Delete"]);
    expect(items("p3")).toEqual(["Edit", "Move up", "Delete"]);
    container.querySelector('[data-item="p3"] [data-act="up"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("wedding-program", { method: "POST", body: { action: "move", itemId: "p3", direction: "up" } });
    container.querySelector('[data-act="seg"][data-seg="section"][data-value="reception"]').click();
    await flush();
    expect([...container.querySelectorAll('[data-role="program"] .wl-prog-moment')].map((x) => x.textContent)).toEqual(["Guest waiting"]);
    expect(container.querySelector('[data-item="p4"] [data-role="duration"]').textContent).toBe("1:00:00");
  });

  it("+ Add: Moment, Song, Duration up front; Person / group and Notes under More options; '4:17' is saved as seconds", async () => {
    const api = progApi();
    mountProgram(container, wedding(), { api, toast: () => {} });
    await flush();
    container.querySelector('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    expect(document.querySelector(".modal-backdrop .card-title, .modal-backdrop h2").textContent).toBe("Add ceremony moment");
    expect(["moment", "song", "duration", "person", "notes"].every((n) => form.elements[n])).toBe(true);
    form.elements.moment.value = "Signing";
    form.elements.song.value = "Love Wins All";
    form.elements.duration.value = "4:30";
    form.elements.person.value = "Principal sponsors";
    submit(form);
    await flush();
    expect(api).toHaveBeenCalledWith("wedding-program", { method: "POST", body: { action: "create", item: { section: "ceremony", moment: "Signing", song: "Love Wins All", durationSec: 270, person: "Principal sponsors", notes: null } } });
  });

  it("Sample Program: common moments without songs, nothing added by itself; + Add puts ONE moment in the current part", async () => {
    const api = progApi();
    mountProgram(container, wedding(), { api, toast: () => {} });
    await flush();
    container.querySelector('[data-act="seg"][data-seg="mode"][data-value="sample"]').click();
    await flush();
    const line = (t) => [...container.querySelectorAll(".wl-sample")].find((li) => li.querySelector(".wl-name").textContent === t);
    expect(line("Groom entrance").querySelector('[data-role="added"]').textContent).toBe("Added ✓");
    expect(api.mock.calls.filter(([, o]) => o.body.action === "create")).toEqual([]);
    line("Signing").querySelector('[data-act="sample-add"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("wedding-program", { method: "POST", body: { action: "create", item: { section: "ceremony", moment: "Signing" } } });
    container.querySelector('[data-act="seg"][data-seg="section"][data-value="reception"]').click();
    await flush();
    expect([...container.querySelectorAll(".wl-sample .wl-name")].map((n) => n.textContent)).toContain("Father & daughter dance");
  });

  it("without tasks.manage: read only (no + Add, no Move / Delete)", async () => {
    const s = wedding("manager");
    delete s.member.permissions["tasks.manage"];
    mountProgram(container, s, { api: progApi(), toast: () => {} });
    await flush();
    expect(container.querySelector('[data-act="new"]')).toBeNull();
    expect([...container.querySelectorAll('[data-item="p2"] .menu-item')].map((b) => b.textContent)).toEqual(["Details"]);
  });
});

describe("Owner-pilot Bridal: Guests → Roles", () => {
  const G2 = [
    { id: "gRyan000001", name: "Ryan Reyes", category: "sponsors", side: "groom", partySize: 2, rsvp: "attending", confirmed: 2, roles: [{ id: "principal_sponsor" }], roleKeys: ["principal_sponsor"], revision: 1, history: [] },
    { id: "gShirley001", name: "Shirley Saragcon", category: "sponsors", side: "bride", partySize: 1, rsvp: "awaiting", confirmed: 0, roles: [{ id: "principal_sponsor" }], roleKeys: ["principal_sponsor"], revision: 1, history: [] },
    { id: "gSarah00001", name: "Sarah Barnes", category: "entourage", side: "bride", partySize: 1, rsvp: "attending", confirmed: 1, roles: [{ id: "maid_of_honor" }], roleKeys: ["maid_of_honor"], revision: 1, history: [] },
    { id: "gTan0000001", name: "Tan Family", category: "friends", side: "groom", partySize: 3, rsvp: "awaiting", confirmed: 0, revision: 1, history: [] },
  ];
  const mountRoles = async (extra = {}) => {
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: G2, hasMore: false })), getSeating: vi.fn(async () => null), getWeddingSetup: vi.fn(async () => null), guestsApi: vi.fn(async () => ({ guestId: "gNew0000001" })), ...extra });
    mountGuests(container, wedding(), { data, toast: () => {}, confirm: async () => true });
    await flush();
    container.querySelector('[data-act="seg"][data-value="roles"]').click();
    await flush();
    return data;
  };

  it("RSVP | Seating | Roles; roles grouped compactly (MAID / MATRON OF HONOR · 1, PRINCIPAL SPONSORS · 2), one line per guest; the rest under 'Not assigned yet'", async () => {
    await mountRoles();
    expect([...container.querySelectorAll('[data-role="seg-view"] .seg-btn')].map((b) => b.textContent)).toEqual(["All Guests", "Seating", "Roles"]);
    const groups = [...container.querySelectorAll("[data-role-group]")].map((s) => [s.querySelector(".wl-group-title").textContent, s.querySelector(".wl-cat-counts").textContent, [...s.querySelectorAll(".wl-name")].map((n) => n.textContent)]);
    expect(groups).toEqual([["Maid / Matron of Honor", "· 1", ["Sarah Barnes"]], ["Principal Sponsors", "· 2", ["Ryan Reyes", "Shirley Saragcon"]]]);
    expect(container.querySelector('[data-role="roles-summary"]').textContent).toBe("3 people · 2 roles");
    expect(container.querySelector('.page-header [data-act="role-new"]').textContent).toBe("+ Assign role");
    expect(container.querySelector('[data-role="open-roles"] summary').textContent).toBe("Not assigned yet (1)"); // named people without a role
    const items = [...container.querySelectorAll('[data-role-guest="principal_sponsor|gRyan000001"] .menu-item')].map((b) => b.textContent);
    expect(items).toEqual(["Change person", "Change role", "View guest", "Remove role"]);
  });

  it("+ Assign role picks an EXISTING guest (no retyping); or adds a new guest and assigns (sponsors category)", async () => {
    const data = await mountRoles();
    container.querySelector('.page-header [data-act="role-new"]').click();
    let f = lastForm();
    expect([...f.elements.guestId.options].map((o) => o.textContent)).toEqual(["— Choose a person —", "Ryan Reyes", "Sarah Barnes", "Shirley Saragcon", "Tan Family", "+ Add guest and assign"]);
    f.elements.role.value = "best_man";
    f.elements.guestId.value = "gTan0000001";
    submit(f);
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "assignRole", guestId: "gTan0000001", role: { id: "best_man" } });
    container.querySelector('.page-header [data-act="role-new"]').click();
    f = lastForm();
    f.elements.role.value = "candle_sponsor";
    f.elements.guestId.value = "__new";
    f.elements.newName.value = "Kris & Kenet Yamat";
    f.elements.newSeats.value = "2";
    submit(f);
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "create", guest: expect.objectContaining({ name: "Kris & Kenet Yamat", category: "sponsors", partySize: 2 }) });
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "assignRole", guestId: "gNew0000001", role: { id: "candle_sponsor" } });
    // A custom role.
    container.querySelector('.page-header [data-act="role-new"]').click();
    f = lastForm();
    f.elements.role.value = "custom";
    f.elements.customRole.value = "Program host";
    f.elements.guestId.value = "gTan0000001";
    submit(f);
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "assignRole", guestId: "gTan0000001", role: { id: "custom", label: "Program host" } });
  });

  it("⋯ Change person / Change role / Remove role (the guest and RSVP stay); Details shows the role", async () => {
    const asked = [];
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: G2, hasMore: false })), getSeating: vi.fn(async () => null), getWeddingSetup: vi.fn(async () => null), guestsApi: vi.fn(async () => ({})) });
    mountGuests(container, wedding(), { data, toast: () => {}, confirm: async (c) => (asked.push(c), true) });
    await flush();
    container.querySelector('[data-act="seg"][data-value="roles"]').click();
    await flush();
    container.querySelector('[data-role-guest="maid_of_honor|gSarah00001"] [data-act="role-person"]').click();
    lastForm().elements.guestId.value = "gTan0000001";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "moveRole", fromGuestId: "gSarah00001", toGuestId: "gTan0000001", role: { id: "maid_of_honor" } });
    container.querySelector('[data-role-guest="principal_sponsor|gRyan000001"] [data-act="role-change"]').click();
    lastForm().elements.role.value = "veil_sponsor";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "moveRole", fromGuestId: "gRyan000001", role: { id: "principal_sponsor" }, toRole: { id: "veil_sponsor" } });
    container.querySelector('[data-role-guest="principal_sponsor|gShirley001"] [data-act="role-remove"]').click();
    await flush();
    expect(asked[0].body).toBe("Only the role is removed. The guest, their RSVP, seats and table stay.");
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "unassignRole", guestId: "gShirley001", role: { id: "principal_sponsor" } });
    expect(data.guestsApi).not.toHaveBeenCalledWith(expect.objectContaining({ action: "remove" }));
    container.querySelector('[data-role-guest="principal_sponsor|gRyan000001"] .wl-main').click();
    const d = document.querySelector('[data-role="details"]');
    expect([...d.querySelectorAll("dt")].find((x) => x.textContent === "Role").nextElementSibling.textContent).toBe("Principal Sponsor");
  });
});

describe("Owner-pilot Bridal: Crew Meals (More)", () => {
  const CREW = [
    { id: "c1", name: "HMUA team", breakfast: 3, lunch: 3, dinner: 0, location: "Hotel", supplierId: null, supplierName: null, remarks: null },
    { id: "c2", name: "Photo team", breakfast: 3, lunch: 3, dinner: 3, location: "Hotel", supplierId: SUP.id, supplierName: "ABC Photo Studio", remarks: "Halal x1" },
  ];
  const crewApi = (prices = {}) => vi.fn(async (_p, { body }) => (body.action === "list" ? { items: CREW, prices } : body.action === "create" ? { itemId: "cNew" } : {}));
  const mountCrew = async (api, session = wedding()) => {
    mountCrewMeals(container, session, { api, toast: () => {}, confirm: async () => true, activeSuppliers: async () => [SUP] });
    await flush();
  };

  it("summary Breakfast · Lunch · Dinner from the list; one compact line per crew: name | B · L · D | place | ⋯ (Edit / Details / Remove)", async () => {
    await mountCrew(crewApi());
    expect(container.querySelector('[data-role="crew-summary"]').textContent.replace(/\s+/g, " ").trim()).toBe("Breakfast 6 · Lunch 6 · Dinner 3 Meal prices");
    const rows = [...container.querySelectorAll('[data-role="crew"] .wl-crew')].map((r) => [r.querySelector(".wl-name").textContent, r.querySelector('[data-role="meals"]').textContent, r.querySelector('[data-role="place"]').textContent, r.querySelector('[data-role="sub"]').textContent]);
    expect(rows).toEqual([["HMUA team", "B 3 · L 3", "Hotel", "B 3 · L 3 · Hotel"], ["Photo team", "B 3 · L 3 · D 3", "Hotel", "B 3 · L 3 · D 3 · Hotel"]]);
    expect([...container.querySelectorAll('[data-crew="c2"] .menu-item')].map((b) => b.textContent)).toEqual(["Edit", "Details", "Remove"]);
    container.querySelector('[data-crew="c2"] [data-act="view"]').click();
    const d = document.querySelector('[data-role="details"]');
    expect([...d.querySelectorAll("dt")].find((x) => x.textContent === "Linked supplier").nextElementSibling.textContent).toBe("ABC Photo Studio");
  });

  it("+ Add: Crew / person, Breakfast, Lunch, Dinner, Location up front; supplier link and remarks under More options; optional prices give an estimate", async () => {
    const api = crewApi({ breakfast: 15000, lunch: 25000 });
    await mountCrew(api);
    expect(container.querySelector('[data-role="crew-summary"]').textContent).toContain("Est. ₱2,400");
    container.querySelector('[data-act="new"]').click();
    const f = lastForm();
    const main = [...f.querySelectorAll(".field")].filter((x) => !x.closest(".form-more")).map((x) => x.querySelector("input,select,textarea").name);
    expect(main).toEqual(["name", "breakfast", "lunch", "dinner", "location"]);
    expect([...f.elements.supplierId.options].map((o) => o.textContent)).toEqual(["— None —", "ABC Photo Studio"]);
    f.elements.name.value = "Video team";
    f.elements.breakfast.value = "4";
    f.elements.lunch.value = "4";
    f.elements.location.value = "Reception";
    f.elements.supplierId.value = SUP.id;
    submit(f);
    await flush();
    expect(api).toHaveBeenCalledWith("wedding-crew-meals", { method: "POST", body: { action: "create", item: { name: "Video team", breakfast: 4, lunch: 4, dinner: 0, location: "Reception", supplierId: SUP.id, remarks: null } } });
    container.querySelector('[data-act="prices"]').click();
    lastForm().elements.dinner.value = "300";
    submit(lastForm());
    await flush();
    expect(api).toHaveBeenCalledWith("wedding-crew-meals", { method: "POST", body: { action: "setPrices", prices: { breakfast: 15000, lunch: 25000, dinner: 30000 } } });
  });

  it("Sample list: common crews, nothing added by itself; + Add opens the form with the name filled in", async () => {
    const api = crewApi();
    await mountCrew(api);
    container.querySelector('[data-act="seg"][data-value="sample"]').click();
    await flush();
    const names = [...container.querySelectorAll(".wl-sample .wl-name")].map((x) => x.textContent);
    expect(names).toEqual(["Photo team", "Video team", "HMUA team", "Coordinator", "Lights & sounds crew", "Photobooth crew", "Host / emcee", "Drivers", "Church assistants", "Reception staff"]);
    const line = (t) => [...container.querySelectorAll(".wl-sample")].find((li) => li.querySelector(".wl-name").textContent === t);
    expect(line("Photo team").querySelector('[data-role="added"]').textContent).toBe("Added ✓");
    expect(api.mock.calls.filter(([, o]) => o.body.action === "create")).toEqual([]);
    line("Drivers").querySelector('[data-act="sample-add"]').click();
    await flush();
    expect(lastForm().elements.name.value).toBe("Drivers");
  });

  it("without vendors.manage: read only", async () => {
    const s = wedding("manager");
    delete s.member.permissions["vendors.manage"];
    await mountCrew(crewApi(), s);
    expect(container.querySelector('[data-act="new"]')).toBeNull();
    expect(container.querySelector('[data-act="prices"]')).toBeNull();
    expect([...container.querySelectorAll('[data-crew="c1"] .menu-item')].map((b) => b.textContent)).toEqual(["Details"]);
  });
});

describe("Owner-pilot Bridal: party members are real people (RSVP · Roles · Seating)", () => {
  const SANRAH = { id: "gSanrah0001", name: "Sanrah", category: "friends", side: "bride", partySize: 5, rsvp: "attending", confirmed: 3, tableId: "tA1b2c3d4", attending: true, roles: [{ id: "maid_of_honor" }], roleKeys: ["maid_of_honor", "bridesmaid"], members: [{ id: "mAnna000001", name: "Anna", roles: [{ id: "bridesmaid" }], attending: true }, { id: "mBea0000001", name: "Bea", roles: [] }], revision: 2, history: [] };
  const MIGUEL = { id: "gMiguel0001", name: "Miguel", category: "entourage", side: "groom", partySize: 1, rsvp: "awaiting", confirmed: 0, roles: [{ id: "best_man" }], roleKeys: ["best_man"], revision: 1, history: [] };
  const mountParty = async (extra = {}, confirmFn = async () => true) => {
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: [SANRAH, MIGUEL], hasMore: false })), getSeating: vi.fn(async () => ({ tables: { tA1b2c3d4: { name: "Table 5", capacity: 8, order: 1 } } })), getWeddingSetup: vi.fn(async () => null), guestsApi: vi.fn(async () => ({})), ...extra });
    mountGuests(container, wedding(), { data, toast: () => {}, confirm: confirmFn });
    await flush();
    return data;
  };

  const guestMenuItemsFor = (id) => [...container.querySelectorAll(`[data-guest="${id}"] .menu-item`)].map((b) => b.textContent);
  it("the main row stays compact (Sanrah 3/5 Attending ⋯, no companion names); Seating lists each confirmed person (marked attending first, then named): Sanrah, Anna, Bea in 3 seats", async () => {
    await mountParty();
    const row = container.querySelector('[data-guest="gSanrah0001"]');
    expect(row.querySelector('[data-role="seats"]').textContent).toBe("3/5");
    expect(row.textContent).not.toMatch(/Anna|Bea/);
    container.querySelector('[data-act="seg"][data-value="seating"]').click();
    await flush();
    expect([...container.querySelectorAll('[data-table="tA1b2c3d4"] [data-person] .wl-name')].map((n) => n.textContent)).toEqual(["Sanrah", "Anna", "Bea"]);
    expect([...container.querySelectorAll('[data-table="tA1b2c3d4"] [data-person]')].map((r) => r.dataset.person)).toEqual(["gSanrah0001|primary", "gSanrah0001|mAnna000001", "gSanrah0001|mBea0000001"]);
    expect(container.querySelector('[data-table="tA1b2c3d4"] [data-role="table-seats"]').textContent.trim()).toBe("· 3/8");
  });

  it("Details = the party sheet: each person's NAME first (bold, tap / ✎ to edit), then Primary · role · table, then actions; Member 4 / 5 can be named; ⋯ only for Remove from party", async () => {
    const data = await mountParty();
    container.querySelector('[data-guest="gSanrah0001"] .wl-main').click();
    const d = document.querySelector('[data-role="details"]');
    expect(d.querySelector(".card-title").textContent).toBe("Sanrah's Party");
    expect([...d.querySelectorAll('[data-role="party-figures"] dd')].map((x) => x.textContent)).toEqual(["5", "3"]);
    const people = () => [...document.querySelectorAll('[data-role="details"] [data-role="members"] .wl-member')].map((li) => [li.querySelector('[data-role="person-name"]').textContent, li.querySelector('[data-role="member-meta"]')?.textContent ?? ""]);
    // The name is its own element; "Primary", roles and the table are the quiet line under it.
    expect(people()).toEqual([["Sanrah", "Primary"], ["Anna", ""], ["Bea", ""], ["Member 4", ""], ["Member 5", ""]]);
    // Roles and the table are managed right on each person (the sheet is the hub).
    const chips = (key) => [...document.querySelectorAll(`[data-role="details"] [data-member="${key}"] .wl-role-chip`)].map((b) => b.textContent);
    expect([chips("primary"), chips("mAnna000001"), chips("mBea0000001"), chips("u1")]).toEqual([["Maid / Matron of Honor", "+ Role"], ["Bridesmaid", "+ Role"], ["+ Role"], []]);
    const pick = (key) => document.querySelector(`[data-role="details"] [data-member="${key}"] select[data-pa="table"]`);
    expect([pick("primary").value, pick("mAnna000001").value, pick("mBea0000001").value]).toEqual(["tA1b2c3d4", "tA1b2c3d4", "tA1b2c3d4"]);
    expect([...pick("primary").options].map((o) => o.textContent)).toEqual(["Not seated", "Table 5 · 3/8"]);
    expect(pick("u1")).toBeNull(); // Member 4 isn't confirmed (3 of 5 attending)
    expect([...d.querySelectorAll(".wl-person-name .wl-edit")]).toHaveLength(5); // every name is editable (✎)
    expect([...d.querySelectorAll('[data-pa="attend"]')].map((b) => b.textContent)).toEqual(["Attending ✓", "Attending ✓", "Mark attending"]);
    // The member ⋯ holds only the destructive action.
    expect([...d.querySelectorAll('[data-member="mAnna000001"] .menu-item')].map((b) => b.textContent)).toEqual(["Remove from party"]);
    // Tap a member's name: "Member name", Save / Cancel, in place.
    d.querySelector('[data-pa="name-member"][data-mid="mAnna000001"]').click();
    await flush();
    expect(lastForm().querySelector("label").textContent).toMatch(/^Member name/);
    expect(lastForm().elements.name.value).toBe("Anna");
    expect([...lastForm().querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(expect.arrayContaining(["Cancel", "Save"]));
    lastForm().elements.name.value = "Annabelle";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "renameMember", guestId: "gSanrah0001", memberId: "mAnna000001", name: "Annabelle" });
    expect(document.querySelector('[data-role="details"]')).not.toBeNull(); // still on Guest Details
    // Name an unnamed person ("Member 5"): that exact person (and any table) is named.
    document.querySelector('[data-role="details"] [data-pa="name-unnamed"][data-slot="2"]').click();
    await flush();
    lastForm().elements.name.value = "Carla";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "addMember", guestId: "gSanrah0001", name: "Carla", seatKey: "u2" });
    // The primary guest's name too (the guest record).
    document.querySelector('[data-role="details"] [data-pa="name-primary"]').click();
    await flush();
    lastForm().elements.name.value = "Sanrah Cruz";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "update", guestId: "gSanrah0001", expectedRevision: SANRAH.revision, changes: { name: "Sanrah Cruz" } });
    document.querySelector('[data-role="details"] [data-pa="attend"][data-mid="mBea0000001"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "setAttending", guestId: "gSanrah0001", memberId: "mBea0000001", attending: true });
  });

  it("Details is task-focused: Category, Role, RSVP date, Side, Invitation sent, Invitation link [View] [Copy]; no Activity; exactly one Remove guest; history behind ⋯ → View history", async () => {
    const data = await mountParty({ listGuests: vi.fn(async () => ({ rows: [{ ...SANRAH, invitation: { status: "active" } }, MIGUEL], hasMore: false })), getWeddingSetup: vi.fn(async () => ({ setup: FULL })) });
    container.querySelector('[data-guest="gSanrah0001"] .wl-main').click();
    const d = document.querySelector('[data-role="details"]');
    expect([...d.querySelectorAll('[data-role="fields"] dt')].map((x) => x.textContent)).toEqual(["Category", "Role", "RSVP date", "Side", "Invitation sent", "Invitation link"]);
    expect(d.querySelector('[data-role="activity"]')).toBeNull();
    expect(d.textContent).not.toMatch(/Activity|⋯ → View/);
    expect([...d.querySelectorAll("button")].filter((b) => /^Remove guest$/.test(b.textContent.trim()))).toHaveLength(1);
    expect(d.querySelector(".modal-header .menu-item[data-act='details-remove']").textContent).toBe("Remove guest"); // in the sheet's ⋯
    expect([...d.querySelectorAll(".modal-footer button")].map((b) => b.textContent)).toEqual(["Edit", "Close"]);
    expect([...d.querySelectorAll("button")].filter((b) => /^Remove$/.test(b.textContent.trim()))).toHaveLength(0); // member removal is "Remove from party", in the member's ⋯
    expect(d.querySelector('[data-role="details-rsvp"]').value).toBe("attending");
    expect(d.querySelector('[data-role="rsvp-count"]').textContent).toBe("3 of 5 · Change");
    const link = d.querySelector('[data-role="link-actions"]');
    expect([...link.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["View", "Copy"]);
    // History: a secondary action on the row.
    d.querySelector('[data-act="close"]').click();
    expect(guestMenuItemsFor("gSanrah0001")).toContain("View history");
    container.querySelector('[data-guest="gSanrah0001"] [data-act="history"]').click();
    expect(document.querySelector('[data-role="details"] .card-title').textContent).toBe("Sanrah: history");
    void data;
  });

  it("the Guest Details sheet is the hub: table per person (picker, no dialog), RSVP status / count, + Role and removing a role, history and Remove guest in the sheet's ⋯", async () => {
    const asked = [];
    const data = await mountParty({}, async (c) => (asked.push(c), true));
    container.querySelector('[data-guest="gSanrah0001"] .wl-main').click();
    const d = () => document.querySelector('[data-role="details"]');
    const change = (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    // Seat / unseat one person from the sheet.
    change(d().querySelector('[data-member="mBea0000001"] select[data-pa="table"]'), "");
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "seatPerson", guestId: "gSanrah0001", seatKey: "mBea0000001", tableId: null });
    change(d().querySelector('[data-member="primary"] select[data-pa="table"]'), "tA1b2c3d4");
    await flush();
    // RSVP: Declined straight away; Attending asks how many.
    change(d().querySelector('[data-role="details-rsvp"]'), "declined");
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "setRsvp", guestId: "gSanrah0001", rsvp: { status: "declined" } });
    d().querySelector('[data-role="rsvp-count"]')?.click();
    await flush();
    if (lastForm()?.elements.confirmed) {
      lastForm().elements.confirmed.value = "4";
      submit(lastForm());
      await flush();
      expect(data.guestsApi).toHaveBeenCalledWith({ action: "setRsvp", guestId: "gSanrah0001", rsvp: { status: "attending", confirmed: 4 } });
    }
    // + Role on a member, right here.
    d().querySelector('[data-member="mBea0000001"] [data-pa="role-add"]').click();
    await flush();
    lastForm().elements.role.value = "bridesmaid";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "assignRole", guestId: "gSanrah0001", memberId: "mBea0000001", role: { id: "bridesmaid" } });
    // Tap a role chip to remove it (asks first).
    d().querySelector('[data-member="primary"] [data-pa="role-remove"]').click();
    await flush();
    expect(asked.at(-1)).toMatchObject({ title: "Remove Maid / Matron of Honor from Sanrah?", confirmLabel: "Remove role" });
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "unassignRole", guestId: "gSanrah0001", role: { id: "maid_of_honor" } });
    // The sheet's ⋯: View history, Remove guest.
    expect([...d().querySelectorAll(".modal-header .menu-item")].map((b) => b.textContent)).toEqual(["View history", "Remove guest"]);
    d().querySelector('.modal-header [data-act="details-history"]').click();
    expect([...document.querySelectorAll('[data-role="details"] .card-title')].map((t) => t.textContent)).toContain("Sanrah: history");
  });

  it("removing a companion with a role warns with the reason first, then removes with force; without a link it just removes", async () => {
    const asked = [];
    const guestsApi = vi.fn(async (b) => {
      if (b.action === "removeMember" && b.memberId === "mAnna000001" && !b.force) throw new Error("Anna is Bridesmaid, marked attending. Remove them from this party anyway?");
      return {};
    });
    await mountParty({ guestsApi }, async (c) => (asked.push(c), true));
    container.querySelector('[data-guest="gSanrah0001"] .wl-main').click();
    document.querySelector('[data-role="details"] [data-act="member-remove"][data-id="mAnna000001"]').click();
    await flush();
    expect(asked[0]).toMatchObject({ title: "Remove Anna?", body: "Anna is Bridesmaid, marked attending. Remove them from this party anyway?" });
    expect(guestsApi).toHaveBeenCalledWith({ action: "removeMember", guestId: "gSanrah0001", memberId: "mAnna000001", force: true });
    document.querySelector('[data-role="details"] [data-act="member-remove"][data-id="mBea0000001"]').click();
    await flush();
    expect(asked.length).toBe(1);
    expect(guestsApi).toHaveBeenCalledWith({ action: "removeMember", guestId: "gSanrah0001", memberId: "mBea0000001" });
  });

  it("Roles: people incl. party members; counts are people (MAID / MATRON OF HONOR · 1, BRIDESMAIDS · 1); Not assigned yet = named people only; assign picks a party member", async () => {
    const data = await mountParty();
    container.querySelector('[data-act="seg"][data-value="roles"]').click();
    await flush();
    const groups = [...container.querySelectorAll("[data-role-group]")].map((s) => [s.querySelector(".wl-group-title").textContent, s.querySelector(".wl-cat-counts").textContent, [...s.querySelectorAll(".wl-name")].map((n) => n.textContent)]);
    expect(groups).toEqual([["Maid / Matron of Honor", "· 1", ["Sanrah"]], ["Best Man", "· 1", ["Miguel"]], ["Bridesmaids", "· 1", ["Anna"]]]);
    expect(container.querySelector('[data-role-guest="bridesmaid|gSanrah0001:mAnna000001"] [data-role="party"]').textContent).toBe("Sanrah's party");
    // Only Bea is named and without a role (the 2 unnamed seats aren't people).
    expect([...container.querySelectorAll('[data-role="open-roles"] [data-free]')].map((li) => li.querySelector(".wl-name").textContent)).toEqual(["Bea"]);
    container.querySelector('.page-header [data-act="role-new"]').click();
    const f = lastForm();
    expect([...f.elements.guestId.options].map((o) => o.textContent)).toEqual(["— Choose a person —", "Anna · Sanrah's party", "Bea · Sanrah's party", "Miguel", "Sanrah", "+ Add guest and assign"]);
    // A second Best Man: repeated assignment adds, never replaces.
    f.elements.role.value = "best_man";
    f.elements.guestId.value = "gSanrah0001:mBea0000001";
    submit(f);
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "assignRole", guestId: "gSanrah0001", memberId: "mBea0000001", role: { id: "best_man" } });
    container.querySelector('[data-role-guest="bridesmaid|gSanrah0001:mAnna000001"] [data-act="role-person"]').click();
    lastForm().elements.guestId.value = "gMiguel0001";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "moveRole", fromGuestId: "gSanrah0001", fromMemberId: "mAnna000001", toGuestId: "gMiguel0001", role: { id: "bridesmaid" } });
  });
});

describe("Luna Bridal / Luna Bridal+ invitations (one engine, per-wedding design)", () => {
  const TOKEN = "Abc123_-".repeat(4);
  const WED = { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", ceremonyTime: "15:00", ceremonyVenue: "San Agustin", receptionVenue: "Garden Pavilion", ceremonyMap: "https://maps.app.goo.gl/x", dressCode: "Formal", welcomeMessage: "Join us", story: "We met at a wedding.", faq: [{ q: "Parking?", a: "Yes" }], footerNote: "With love", rsvpDeadline: "2027-01-15" };
  const mountInvite = async (invitation) => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    await renderInvitePage(root, { token: TOKEN, fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) })) });
    return root;
  };
  const base = { wedding: WED, hero: null, guest: { name: "Sanrah", seats: 5, rsvp: "awaiting", confirmed: 0 }, rsvpOpen: true };

  it("no design (Luna Bridal / Custom not published yet): the Luna Standard page, with the couple's story, gallery, FAQ and closing line", async () => {
    const root = await mountInvite({ ...base, design: null, gallery: ["data:image/jpeg;base64,/9j/4AAQ", "data:image/jpeg;base64,/9j/4BBB"] });
    const page = root.querySelector(".inv-page");
    expect(page.classList.contains("inv-designed")).toBe(false);
    expect(page.style.getPropertyValue("--inv-accent")).toBe("");
    expect(root.querySelector(".inv-names").textContent).toBe("Carlo & Yanie");
    // 2026-10-21: nothing the couple saved is silently dropped.
    expect(root.querySelector('[data-section="story"]').textContent).toContain("We met at a wedding.");
    expect(root.querySelectorAll('[data-section="gallery"] img')).toHaveLength(2);
    expect(root.querySelector('[data-section="faq"]').textContent).toContain("Parking?");
    expect(root.querySelector('[data-section="footer"]').textContent).toContain("With love");
  });

  it("no design and none of those details: exactly the original Luna Standard page", async () => {
    const { story, faq, footerNote, ...plain } = WED;
    const root = await mountInvite({ ...base, wedding: plain, design: null, gallery: [] });
    expect(root.querySelector("[data-section]")).toBeNull();
    expect([...root.querySelector(".inv-card").children].map((el) => el.className)).toEqual(["inv-head", "inv-hero inv-hero-plain", "inv-message", "inv-venues", "inv-venue", "inv-rsvp"]);
  });

  it("a published design: its section order / visibility, colours and fonts as CSS variables, images, wording; RSVP still works by seat count", async () => {
    const config = resolveDesign({ templateId: "garden", theme: { accent: "#4f6f52", headingFont: "Playfair Display" }, layout: { align: "left" }, sections: { order: ["hero", "story", "rsvp", "ceremony", "reception", "map", "faq", "footer", "welcome", "dressCode", "entourage", "gallery"], visible: { hero: true, story: true, ceremony: true, reception: true, map: true, faq: true, footer: true, welcome: false, dressCode: false, entourage: true, gallery: true, rsvp: true } }, assets: { ornamentTop: "orn0000001" }, texts: { scriptLine: "are tying the knot", rsvpTitle: "Kindly reply" } });
    const root = await mountInvite({ ...base, design: { config, assets: { orn0000001: "data:image/png;base64,iVBORw0KGgo=" } }, gallery: ["data:image/jpeg;base64,/9j/4AAQ"], entourage: [{ label: "Principal Sponsors", names: ["Ryan", "Shirley"] }] });
    const page = root.querySelector(".inv-page");
    expect(page.classList.contains("inv-designed")).toBe(true);
    expect([page.dataset.template, page.dataset.align]).toEqual(["garden", "left"]);
    expect(page.style.getPropertyValue("--inv-accent")).toBe("#4f6f52");
    expect(page.style.getPropertyValue("--inv-heading-font")).toContain("Playfair Display");
    expect([...root.querySelectorAll("[data-section]")].map((s) => s.dataset.section)).toEqual(["hero", "story", "rsvp", "ceremony", "reception", "map", "faq", "footer", "entourage", "gallery"]);
    expect(root.querySelector(".inv-script").textContent).toBe("are tying the knot");
    expect(root.querySelector('[data-role="rsvp"] h2').textContent).toBe("Kindly reply");
    expect(root.querySelector(".inv-ornament").getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(root.querySelector(".inv-entourage").textContent).toContain("Ryan · Shirley");
    expect(root.querySelectorAll(".inv-gallery img").length).toBe(1);
    expect(root.textContent).not.toContain("Join us"); // welcome hidden by the design
    expect([...document.querySelectorAll("link[data-invite-design-font]")].some((l) => l.href.includes("Playfair+Display"))).toBe(true);
    root.querySelector('[data-act="accept"]').click();
    expect([...root.querySelectorAll("[data-seats]")].map((b) => b.textContent)).toEqual(["1", "2", "3", "4", "5"]);
  });

});
