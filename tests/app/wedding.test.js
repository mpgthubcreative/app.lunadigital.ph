// @vitest-environment jsdom
// Phase 16 screens: Wedding Budget, Wedding Expenses, Wedding Suppliers
// (computed balance), Supplier Payments (Mark paid -> one expense), Wedding
// Tasks (inline status, derived overdue), Guests & RSVP (people vs
// invitations), the Wedding dashboard, navigation and the loaders.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountBudget } from "../../src/modules/wedding/budget.js";
import { mount as mountExpenses, parseWeddingExpense } from "../../src/modules/wedding/expenses.js";
import { mount as mountSuppliers, toSupplierInput, paidState, moneySummary } from "../../src/modules/wedding/suppliers.js";
import { mount as mountPayments } from "../../src/modules/wedding/payments.js";
import { mount as mountTasks, groupTasks } from "../../src/modules/wedding/tasks.js";
import { toGuestInput, mount as mountGuests, parseRsvp, seatsText, groupGuests } from "../../src/modules/wedding/guests.js";
import { seatingPlan } from "../../shared/wedding.js";
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
  it("Bridal owner (Owner-pilot UX): Money is home, no Dashboard route; Expenses / Payments / Budget still open; Staff: the dashboard only", () => {
    const routes = buildRoutes(wedding());
    expect(routes.map((r) => r.label)).toEqual(expect.arrayContaining(["Money", "Tasks", "Guests", "Budget", "Wedding Expenses", "Supplier Payments"]));
    expect(routes.find((r) => r.path === "/")).toMatchObject({ redirect: "/wedding-suppliers", moduleId: "vendors" });
    expect(routes.some((r) => r.moduleId === "dashboard")).toBe(false);
    for (const p of buildRoutes(wedding("staff")).map((r) => r.path)) expect(["/", "/notifications"]).toContain(p);
  });
  it("phone: Money / Tasks / Guests + More (Budget, Users, Settings inside More)", () => {
    document.body.innerHTML = '<div id="app"></div>';
    renderShell(document.getElementById("app"), wedding());
    const tabs = [...document.querySelectorAll(".tabbar .tab-link")].map((a) => a.textContent.trim());
    expect(tabs.slice(0, 3)).toEqual(["Money", "Tasks", "Guests"]);
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

describe("Money (Owner-pilot Bridal UX): budget, suppliers and other expenses on one page", () => {
  const OTHER = { id: "expTaxi000001", date: "2026-10-14", category: "catVenue00001", amount: 150000, payee: "Grab to venue", supplierId: null, method: "cash", status: "active", revision: 1, history: [] };
  const NOAGREE = { id: "supNoAgree001", name: "Lights Co", service: "other", agreedAmount: null, paid: 0, upcoming: 500000, upcomingCount: 1, status: "active", revision: 1, history: [] };
  const money = (extra = {}) => fakeData({ listSuppliers: vi.fn(async (_b, f) => ({ rows: f.status === "inactive" ? [] : [SUP], hasMore: false })), listWeddingExpenses: vi.fn(async () => ({ rows: [OTHER, { ...OTHER, id: "expPhoto00001", supplierId: SUP.id, payee: "ABC Photo Studio" }], hasMore: false })), ...extra });
  const rowOf = (id) => container.querySelector(`[data-supplier="${id}"]`);

  it("one compact summary: budget ₱500,000 · spent ₱20,000 · still to pay ₱60,000 · remaining ₱420,000 (no double counting)", async () => {
    const data = money();
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    const k = (x) => container.querySelector(`[data-role="money-summary"] [data-k="${x}"]`).textContent.trim().replace(/\.00/g, "");
    expect([k("budget"), k("spent"), k("still"), k("remaining")]).toEqual(["₱500,000", "₱20,000", "₱60,000", "₱420,000"]);
    expect(container.querySelectorAll(".stat-card")).toHaveLength(0);
    // A supplier without an agreement adds what's scheduled to it.
    expect(moneySummary(BUDGET, [SUP, NOAGREE])).toEqual({ budget: 50000000, spent: 2000000, stillToPay: 6500000, remaining: 41500000 });
    expect(moneySummary(null, [])).toMatchObject({ budget: null, remaining: null });
    expect(data.listSuppliers).toHaveBeenCalledWith("demo-distributor-a", { status: "active" }, { pageSize: 200 });
  });

  it("supplier row: name, status and amount due on one sub-line (phone), Pay and ⋯; Pay pays the next scheduled payment (one markPaid)", async () => {
    const data = money();
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    const row = rowOf(SUP.id);
    expect(row.querySelector(".wl-name").textContent).toBe("ABC Photo Studio");
    expect(row.querySelector('[data-role="sub"]').textContent.replace(/\.00/g, "")).toBe("Partly paid · ₱60,000 due");
    expect([...row.querySelectorAll('[data-act="menu"]')].map((b) => b.textContent)).toEqual(["Record another payment", "Due Dec 1 · ₱30,000.00", "Schedule a payment", "View details", "Edit"]);
    row.querySelector('[data-act="pay"]').click();
    await flush();
    submit(lastForm());
    await flush();
    expect(data.paymentsApi).toHaveBeenCalledTimes(1);
    expect(data.paymentsApi).toHaveBeenCalledWith({ action: "markPaid", paymentId: PAY.id, payment: { paidDate: "2026-10-16", method: "bank_transfer" } });
  });

  it("⋯ Record payment / Paid in full record ONE Wedding Expense for the supplier (nothing typed twice)", async () => {
    const data = money({ listSupplierPayments: vi.fn(async () => ({ rows: [], hasMore: false })) });
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    rowOf(SUP.id).querySelector('[data-x="full"]').click();
    await flush();
    expect(lastForm().elements.amount.value).toBe("60000.00");
    submit(lastForm());
    await flush();
    expect(data.expensesApi).toHaveBeenCalledTimes(1);
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), expense: { date: "2026-10-16", category: "catPhotoVid01", amount: 6000000, supplierId: SUP.id, method: "bank_transfer" } });
  });

  it("⋯ Schedule a payment schedules for THIS supplier", async () => {
    const data = money();
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    rowOf(SUP.id).querySelector('[data-x="schedule"]').click();
    await flush();
    const form = lastForm();
    expect(form.elements.supplierId).toBeUndefined();
    form.elements.description.value = "Balance";
    form.elements.amount.value = "10000";
    form.elements.dueDate.value = "2027-01-10";
    submit(form);
    await flush();
    expect(data.paymentsApi).toHaveBeenCalledWith({ action: "create", payment: expect.objectContaining({ supplierId: SUP.id, amount: 1000000, dueDate: "2027-01-10", category: "catPhotoVid01" }) });
  });

  it("All / Unpaid / Partly paid / Paid filter the list; search matches anywhere in the name", async () => {
    const paidOne = { ...SUP, id: "supVenue00001", name: "Garden Venue", agreedAmount: 1000000, paid: 1000000 };
    const fresh = { ...SUP, id: "supFlorist001", name: "Florist", paid: 0, upcoming: 0, upcomingCount: 0 };
    const data = money({ listSuppliers: vi.fn(async (_b, f) => ({ rows: f.status === "active" ? [SUP, paidOne, fresh] : [], hasMore: false })) });
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    const ids = () => [...container.querySelectorAll('[data-role="suppliers"] [data-supplier]')].map((r) => r.dataset.supplier);
    expect(ids()).toEqual([SUP.id, paidOne.id, fresh.id]);
    container.querySelector('[data-seg="filter"][data-value="unpaid"]').click();
    expect(ids()).toEqual([fresh.id]);
    container.querySelector('[data-seg="filter"][data-value="paid"]').click();
    expect(ids()).toEqual([paidOne.id]);
    expect(rowOf(paidOne.id).querySelector('[data-act="pay"]')).toBeNull(); // nothing due
    container.querySelector('[data-seg="filter"][data-value="all"]').click();
    expect(rowOf(fresh.id).querySelector('[data-act="pay"]')).not.toBeNull();
  });

  it("Other expenses: only those not paid to a saved supplier, + Add expense; links to the full pages", async () => {
    const data = money();
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    const other = [...container.querySelectorAll('[data-role="other-expenses"] [data-expense]')].map((r) => r.dataset.expense);
    expect(other).toEqual([OTHER.id]);
    container.querySelector('[data-act="add-expense"]').click();
    await flush();
    expect(lastForm().elements.amount).toBeDefined();
    expect([...container.querySelectorAll(".wl-links a")].map((a) => a.getAttribute("href"))).toEqual(["/expenses", "/supplier-payments", "/budget"]);
  });

  it("no Pay / record without expenses.create; no schedule without vendorpayments.manage; nothing hidden is offered", async () => {
    const s = wedding("manager");
    delete s.member.permissions["expenses.create"];
    delete s.member.permissions["vendorpayments.manage"];
    mountSuppliers(container, s, { data: money(), now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-act="pay"]')).toBeNull();
    expect(container.querySelector('[data-x="record"]')).toBeNull();
    expect(container.querySelector('[data-x="schedule"]')).toBeNull();
    expect(container.querySelector('[data-act="add-expense"]')).toBeNull();
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
  it("order: Overdue, Due soon, Later, No due date; done folded under Completed (n); one line each: task · status ▾ · due · ⋯", async () => {
    const data = fakeData({ listTasks: vi.fn(async () => ({ rows: MORE, hasMore: false })) });
    mountTasks(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    expect(data.listTasks).toHaveBeenCalledWith("demo-distributor-a", { state: "all" }, { today: "2026-10-16", pageSize: 500 });
    const groups = [...container.querySelectorAll("[data-group]")].map((s) => [s.dataset.group, [...s.querySelectorAll("[data-task]")].map((r) => r.dataset.task)]);
    expect(groups).toEqual([["overdue", ["taskChurch001"]], ["soon", ["taskFitting01"]], ["later", ["taskLater0001"]], ["nodate", ["taskNoDate001"]]]);
    expect(container.querySelector('[data-role="done"] summary').textContent).toBe("Completed (1)");
    expect(container.querySelector('[data-role="done"]').open).toBe(false);
    expect(container.querySelector('[data-role="task-count"]').textContent).toBe("4 to do · 1 overdue");
    const row = container.querySelector('[data-task="taskChurch001"]');
    expect(row.querySelector(".wl-name").textContent).toBe("Submit church requirements");
    expect(row.querySelector('[data-role="due"]').textContent).toBe("Oct 10");
    expect([...row.querySelectorAll('select[data-act="status"] option')].map((o) => o.textContent)).toEqual(["To do", "In progress", "Done"]);
    expect([...row.querySelectorAll(".menu-item")].map((b) => b.textContent)).toEqual(["Edit", "Change due date", "Details & history", "Delete"]);
    expect(groupTasks(MORE, "2026-10-16").done.map((x) => x.id)).toEqual(["taskDone00001"]);
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
    expect(data.tasksApi).toHaveBeenCalledWith({ action: "create", task: { title: "Book florist", category: null, assignee: null, dueDate: "2026-11-05", priority: "normal", notes: null } });
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
    expect(container.querySelector('[data-role="rsvp-summary"]').textContent).toBe("9 invited · 3 attending · 4 waiting · 2 declined");
    expect(container.querySelectorAll(".stat-card")).toHaveLength(0);
    const cats = [...container.querySelectorAll("[data-category]")].map((d) => [d.dataset.category, d.querySelector(".wl-group-title").textContent, d.querySelector('[data-role="cat-counts"]').textContent]);
    expect(cats).toEqual([
      ["family", "Family", "6 invited · 2 attending · 4 waiting"],
      ["friends", "Friends", "4 invited · 2 attending · 0 waiting · 1 declined"],
      ["none", "Not set", "1 invited · 0 attending · 1 waiting"],
    ]);
    const row = container.querySelector('[data-guest="guestReyes001"]');
    expect([row.querySelector(".wl-name").textContent, row.querySelector('[data-role="seats"]').textContent, row.querySelector('[data-role="rsvp"]').selectedOptions[0].textContent]).toEqual(["Carlo Reyes", "2/3", "Attending"]);
    expect(seatsText({ rsvp: "awaiting", partySize: 4, confirmed: 0 })).toBe("4");
    expect(groupGuests(G).map((g) => g.id)).toEqual(["family", "friends", "none"]);
  });

  it("Waiting shows only waiting guests under each category (empty categories hidden); search works across categories", async () => {
    mountGuests(container, wedding(), { data: guestsData(), toast: () => {} });
    await flush();
    container.querySelector('[data-seg="filter"][data-value="awaiting"]').click();
    expect([...container.querySelectorAll("[data-category]")].map((d) => d.dataset.category)).toEqual(["family", "none"]);
    const box = container.querySelector('[data-role="search"]');
    container.querySelector('[data-seg="filter"][data-value="all"]').click();
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

  it("Seating: attending · seated · unassigned (people); Unassigned first, then tables with seats used / capacity", async () => {
    mountGuests(container, wedding(), { data: guestsData(), toast: () => {} });
    await flush();
    switchTo("seating");
    expect(container.querySelector('[data-role="seating-summary"]').textContent).toBe("4 attending · 2 seated · 2 unassigned");
    expect([...container.querySelectorAll('[data-role="unassigned"] [data-guest]')].map((r) => r.dataset.guest)).toEqual(["guestReyes001"]);
    expect([...container.querySelectorAll("[data-table]")].map((s) => [s.querySelector(".wl-group-title").firstChild.textContent.trim(), s.querySelector('[data-role="table-seats"]').textContent])).toEqual([["Table 1", "2/2 seats"], ["Table 2", "0/10 seats"]]);
    expect(container.querySelector('[data-act="new-table"]')).not.toBeNull();
    expect(container.querySelector('[data-role="search"]')).toBeNull();
  });

  it("assign / move / unassign send one seat call each; + Add table creates one table", async () => {
    const data = guestsData();
    mountGuests(container, wedding(), { data, toast: () => {} });
    await flush();
    switchTo("seating");
    container.querySelector('[data-guest="guestReyes001"] [data-act="seat"]').click();
    await flush();
    // Table 1 is full (2/2): the free table is suggested.
    expect(lastForm().elements.tableId.value).toBe("tB1b2c3d4");
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "seat", guestId: "guestReyes001", tableId: "tB1b2c3d4" });
    switchTo("seating");
    container.querySelector('[data-guest="guestSantos01"] [data-act="unseat"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "seat", guestId: "guestSantos01", tableId: null });
    switchTo("seating");
    container.querySelector('[data-act="new-table"]').click();
    await flush();
    expect(lastForm().elements.name.value).toBe("Table 3");
    lastForm().elements.capacity.value = "8";
    submit(lastForm());
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "createTable", table: { name: "Table 3", capacity: 8 } });
  });

  it("seatingPlan: only attending guests count; a missing table means unassigned; over capacity is shown", () => {
    const plan = seatingPlan([...G, { id: "x", rsvp: "attending", confirmed: 3, tableId: "tA1b2c3d4" }, { id: "y", rsvp: "declined", confirmed: 0, tableId: "tB1b2c3d4" }, { id: "z", rsvp: "attending", confirmed: 1, tableId: "tGone12345" }], SEATING);
    expect(plan.tables[0]).toMatchObject({ used: 5, capacity: 2 });
    expect(plan.tables[1].used).toBe(0);
    expect(plan.unassigned.map((g) => g.id)).toEqual(["guestReyes001", "z"]);
    expect([plan.attendingSeats, plan.seatedSeats, plan.unassignedSeats]).toEqual([8, 5, 3]);
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

  it("Suppliers: Delete is offered only when nothing was paid or scheduled (the server re-checks)", async () => {
    const fresh = { ...SUP, id: "supFreshOne01", name: "New Florist", paid: 0, upcoming: 0, upcomingCount: 0, nextDue: null };
    const data = fakeData({ listSuppliers: vi.fn(async () => ({ rows: [SUP, fresh], hasMore: false })) });
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {}, confirm: async () => true });
    await flush();
    container.querySelector('[data-supplier="supABCphoto01"] [data-act="view"]').click();
    expect(panel().querySelector('[data-act="delete"]')).toBeNull(); // has payments: deactivate only
    panel().querySelector('[data-act="close"]').click();
    container.querySelector('[data-supplier="supFreshOne01"] [data-act="view"]').click();
    panel().querySelector('[data-act="delete"]').click();
    await flush();
    expect(data.suppliersApi).toHaveBeenCalledWith({ action: "delete", supplierId: "supFreshOne01" });
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
