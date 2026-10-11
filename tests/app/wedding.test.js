// @vitest-environment jsdom
// Phase 16 screens: Wedding Budget, Wedding Expenses, Wedding Suppliers
// (computed balance), Supplier Payments (Mark paid -> one expense), Wedding
// Tasks (inline status, derived overdue), Guests & RSVP (people vs
// invitations), the Wedding dashboard, navigation and the loaders.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountBudget } from "../../src/modules/wedding/budget.js";
import { mount as mountExpenses, parseWeddingExpense } from "../../src/modules/wedding/expenses.js";
import { mount as mountSuppliers, toSupplierInput, paidState } from "../../src/modules/wedding/suppliers.js";
import { mount as mountPayments } from "../../src/modules/wedding/payments.js";
import { mount as mountTasks } from "../../src/modules/wedding/tasks.js";
import { toGuestInput, mount as mountGuests, parseRsvp } from "../../src/modules/wedding/guests.js";
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
  it("Bridal owner: the wedding screens; Staff: the dashboard only", () => {
    expect(buildRoutes(wedding()).map((r) => r.label)).toEqual(expect.arrayContaining(["Wedding Dashboard", "Wedding Budget", "Wedding Expenses", "Wedding Suppliers", "Supplier Payments", "Wedding Tasks", "Guests & RSVP"]));
    for (const p of buildRoutes(wedding("staff")).map((r) => r.path)) expect(["/", "/notifications"]).toContain(p);
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

describe("Wedding Suppliers", () => {
  it("compact row: Supplier (+ service) | Agreed | Paid | Balance (computed by Luna) | Paid? | Scheduled", async () => {
    mountSuppliers(container, wedding(), { data: fakeData(), now: NOW, toast: () => {} });
    await flush();
    expect(cells("suppliers")[0].slice(0, 4)).toEqual(["ABC Photo StudioPhoto / Video", "₱80,000.00", "₱20,000.00", "₱60,000.00"]);
    const paid = container.querySelector('[data-role="paid"]');
    expect(paid.value).toBe("partly");
    const sched = container.querySelector('[data-role="scheduled"]');
    expect([...sched.options].map((o) => o.value)).toEqual(["", PAY.id, "new"]);
    expect(sched.options[0].textContent.trim()).toBe("Due Dec 1");
    expect(paidState({ paid: 0, agreedAmount: 100 })).toBe("unpaid");
    expect(paidState({ paid: 100, agreedAmount: 100 })).toBe("paid");
    expect(paidState({ paid: 5, agreedAmount: null })).toBe("paid");
    expect(toSupplierInput({ name: "X", service: "venue", agreedAmount: "", categoryId: "", contactPerson: "", phone: "", email: "", location: "", notes: "" })).toMatchObject({ agreedAmount: null, categoryId: null });
  });

  it("Paid? -> Paid records ONE expense for the unscheduled balance; Unpaid is refused", async () => {
    const data = fakeData();
    const toast = vi.fn();
    mountSuppliers(container, wedding(), { data, now: NOW, toast });
    await flush();
    const paid = container.querySelector('[data-role="paid"]');
    paid.value = "paid";
    paid.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    // Balance ₱60,000 − ₱30,000 already scheduled = ₱30,000.
    expect(lastForm().elements.amount.value).toBe("30000.00");
    submit(lastForm());
    await flush();
    expect(data.expensesApi).toHaveBeenCalledTimes(1);
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), expense: { date: "2026-10-16", category: "catPhotoVid01", amount: 3000000, supplierId: SUP.id, method: "bank_transfer" } });
    const again = container.querySelector('[data-role="paid"]');
    again.value = "unpaid";
    again.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/aren't undone here/), "danger");
    expect(data.expensesApi).toHaveBeenCalledTimes(1);
  });

  it("Scheduled -> a payment opens it (Mark paid); '+ Schedule a payment' schedules for THIS supplier", async () => {
    const data = fakeData();
    // Another supplier's payment never shows in this supplier's list.
    data.listSupplierPayments = vi.fn(async () => ({ rows: [PAY, { ...PAY, id: "payOtherSup001", supplierId: "supOtherOne01", supplierName: "Other" }], hasMore: false }));
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    const sched = container.querySelector('[data-role="scheduled"]');
    expect([...sched.options].map((o) => o.value)).toEqual(["", PAY.id, "new"]);
    sched.value = "new";
    sched.dispatchEvent(new Event("change", { bubbles: true }));
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

  it("no Scheduled column without vendorpayments.view; no Paid? dropdown without expenses.create", async () => {
    const s = wedding("manager");
    delete s.member.permissions["vendorpayments.view"];
    delete s.member.permissions["expenses.create"];
    mountSuppliers(container, s, { data: fakeData(), now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-role="scheduled"]')).toBeNull();
    expect(container.querySelector('[data-role="paid"]')).toBeNull();
    expect(cells("suppliers")[0][4]).toBe("Partly paid");
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

describe("Wedding Tasks", () => {
  it("compact rows with derived Overdue / Due soon; inline status change sends one setStatus", async () => {
    const data = fakeData();
    mountTasks(container, wedding(), { data, now: NOW, toast: () => {} });
    await flush();
    const rows = cells("tasks");
    expect(rows[0].slice(0, 4)).toEqual(["Submit church requirements", "Ceremony / Church", "Camille", "Oct 10, 2026 Overdue"]);
    expect(rows[1][3]).toBe("Oct 20, 2026 Due soon");
    expect(data.listTasks).toHaveBeenCalledWith("demo-distributor-a", { state: "open" }, { today: "2026-10-16", cursor: null });
    const sel = container.querySelector('select[data-act="status"][data-id="taskChurch001"]');
    sel.value = "completed";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.tasksApi).toHaveBeenCalledWith({ action: "setStatus", taskId: "taskChurch001", status: "completed" });
  });
});

describe("Guests & RSVP", () => {
  it("summary separates people from invitations; RSVP dropdown: Attending confirms the whole party", async () => {
    const data = fakeData();
    mountGuests(container, wedding(), { data, toast: () => {} });
    await flush();
    const v = (id) => container.querySelector(`[data-widget="${id}"] .stat-value`).textContent;
    expect([v("invited"), v("confirmed"), v("declined"), v("awaiting")]).toEqual(["9", "3", "1", "1"]);
    expect(container.querySelector('[data-widget="confirmed"] .stat-label').textContent).toMatch(/people/);
    // An older guest has no category yet (its free-text group stays as a note).
    expect(cells("guests")[0].slice(0, 4)).toEqual(["Prado Family", "—", "Groom's side", "4"]);
    const sel = container.querySelector('[data-role="rsvp"]');
    expect(sel.value).toBe("awaiting");
    sel.value = "attending";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "setRsvp", guestId: GUEST.id, rsvp: { status: "attending", confirmed: 4 } });
    const again = container.querySelector('[data-role="rsvp"]');
    again.value = "declined";
    again.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.guestsApi).toHaveBeenLastCalledWith({ action: "setRsvp", guestId: GUEST.id, rsvp: { status: "declined" } });
  });

  it("filters by category; a new guest needs a category", async () => {
    const data = fakeData();
    mountGuests(container, wedding(), { data, toast: () => {} });
    await flush();
    const f = container.querySelector('[data-role="filters"]');
    f.elements.category.value = "sponsors";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(data.listGuests).toHaveBeenLastCalledWith(expect.anything(), { category: "sponsors" }, expect.anything());
    expect(() => toGuestInput({ name: "A", category: "", side: "both", partySize: "2", contact: "", invitationSent: "", notes: "" })).toThrow(/category/);
    expect(toGuestInput({ name: "A", category: "family", side: "both", partySize: "2", contact: "", invitationSent: "", notes: "" })).toMatchObject({ category: "family" });
  });
  it("parseRsvp: confirmed only for Attending, never above the party size", () => {
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
