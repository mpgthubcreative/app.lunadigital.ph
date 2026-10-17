// @vitest-environment jsdom
// Phase 16 screens: Wedding Budget, Wedding Expenses, Wedding Suppliers
// (computed balance), Supplier Payments (Mark paid -> one expense), Wedding
// Tasks (inline status, derived overdue), Guests & RSVP (people vs
// invitations), the Wedding dashboard, navigation and the loaders.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountBudget } from "../../src/modules/wedding/budget.js";
import { mount as mountExpenses, parseWeddingExpense } from "../../src/modules/wedding/expenses.js";
import { mount as mountSuppliers, toSupplierInput, paidState, moneySummary, shortPeso, moneyRows } from "../../src/modules/wedding/suppliers.js";
import { mount as mountSetup } from "../../src/modules/wedding/setup.js";
import { renderInvitePage, inviteTokenFrom } from "../../src/app/invite.js";
import { guessService } from "../../src/modules/wedding/categories.js";
import { mount as mountDownloads } from "../../src/modules/downloads/index.js";
import { mount as mountPayments } from "../../src/modules/wedding/payments.js";
import { mount as mountTasks, sortTasks } from "../../src/modules/wedding/tasks.js";
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

  it("one small line: Budget ₱500k · Spent ₱20k · To pay ₱60k · Left ₱420k (no double counting); one + Add (Expense / Supplier / Budget item); no Download", async () => {
    await mountMoney();
    const k = (x) => container.querySelector(`[data-role="money-summary"] [data-k="${x}"]`);
    expect(["budget", "spent", "still", "remaining"].map((x) => [...k(x).children].map((c) => c.textContent).join(" "))).toEqual(["Budget ₱500k", "Spent ₱20k", "To pay ₱60k", "Left ₱420k"]);
    expect(k("remaining").title).toBe("₱420,000.00");
    expect([shortPeso(15250000), shortPeso(120000000), shortPeso(85000)]).toEqual(["₱152.5k", "₱1.2M", "₱850"]);
    expect([...container.querySelectorAll('[data-role="add"] .menu-item')].map((b) => b.textContent)).toEqual(["Expense", "Supplier", "Budget item"]);
    expect(container.querySelectorAll(".page-header .btn-primary")).toHaveLength(1);
    expect(container.querySelector('[data-act="export"]')).toBeNull();
    expect(moneySummary(BUDGET, [SUP, NOAGREE])).toEqual({ budget: 50000000, spent: 2000000, stillToPay: 6500000, remaining: 41500000 });
  });

  it("rows: supplier (Category | Supplier | Total | Partial | left), planned budget line without a supplier, expense paid to no supplier; one list, budget-category order", async () => {
    await mountMoney();
    const rows = [...container.querySelectorAll('[data-role="money"] > li')].map((r) => [r.dataset.kind, r.querySelector(".wl-name").textContent, r.querySelector('[data-role="sub"]').textContent, r.querySelector('[data-role="status"] .wl-chip').textContent, r.querySelector('[data-role="left"]').textContent]);
    // CATS order: Photo / Video (₱80k, has ABC), Venue (₱150k budget, no supplier -> Planned; and the Grab expense).
    expect(rows).toEqual([
      ["supplier", "ABC Photo Studio", "Photo / Video · ₱80k", "Partial", "₱60k left"],
      ["planned", "Venue", "No supplier yet · ₱150k", "Planned", "₱150k left"],
      ["expense", "Grab to venue", "Venue · ₱1.5k", "Paid", "₱0 left"],
    ]);
    // Desktop columns carry the category and total.
    expect(rowOf('[data-supplier="supABCphoto01"] .wl-cat-col').textContent).toBe("Photo / Video");
    expect(rowOf('[data-supplier="supABCphoto01"] [data-role="total"]').textContent).toBe("₱80k");
    // Adding a supplier in Venue replaces the planned line (no duplicate).
    const after = moneyRows({ suppliers: [SUP, { ...SUP, id: "supVenue00001", name: "Palazzo", categoryId: "catVenue00001", agreedAmount: 12000000, paid: 0 }], categories: CATS, budget: BUDGET, expenses: [] });
    expect(after.map((r) => [r.kind, r.name])).toEqual([["supplier", "ABC Photo Studio"], ["supplier", "Palazzo"]]);
  });

  it("supplier ⋯: Record payment, View payments, Edit, Change category, Payment schedule, Details, Archive; Record payment records ONE expense", async () => {
    const data = await mountMoney(money({ listSupplierPayments: vi.fn(async () => ({ rows: [], hasMore: false })) }));
    const row = rowOf('[data-supplier="supABCphoto01"]');
    expect([...row.querySelectorAll('[data-act="menu"]')].map((b) => b.textContent)).toEqual(["Record payment", "View payments", "Edit", "Change category", "Payment schedule", "Details", "Archive"]);
    row.querySelector('[data-x="record"]').click();
    await flush();
    lastForm().elements.amount.value = "15000";
    submit(lastForm());
    await flush();
    expect(data.expensesApi).toHaveBeenCalledTimes(1);
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), expense: { date: "2026-10-16", category: "catPhotoVid01", amount: 1500000, supplierId: SUP.id, method: "bank_transfer" } });
  });

  it("⋯ Payment schedule schedules for THIS supplier; ⋯ Change category moves it (a new name is created)", async () => {
    const data = await mountMoney(money({ budgetApi: vi.fn(async () => ({ categoryId: "catVideo00001" })), suppliersApi: vi.fn(async () => ({})) }));
    rowOf('[data-supplier="supABCphoto01"] [data-x="schedule"]').click();
    await flush();
    const form = lastForm();
    expect(form.elements.supplierId).toBeUndefined();
    form.elements.description.value = "Balance";
    form.elements.amount.value = "10000";
    form.elements.dueDate.value = "2027-01-10";
    submit(form);
    await flush();
    expect(data.paymentsApi).toHaveBeenCalledWith({ action: "create", payment: expect.objectContaining({ supplierId: SUP.id, amount: 1000000, dueDate: "2027-01-10", category: "catPhotoVid01" }) });
    rowOf('[data-supplier="supABCphoto01"] [data-x="category"]').click();
    lastForm().elements.category.value = "Video only";
    submit(lastForm());
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "createCategory", category: { name: "Video only", budget: null } });
    expect(data.suppliersApi).toHaveBeenCalledWith({ action: "update", supplierId: SUP.id, expectedRevision: 2, changes: { categoryId: "catVideo00001" } });
  });

  it("one dropdown filter (All / Unpaid / Partial / Paid / Planned)", async () => {
    await mountMoney();
    const pick = (v) => {
      const sel = container.querySelector('[data-role="filter"]');
      sel.value = v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const kinds = () => [...container.querySelectorAll('[data-role="money"] > li')].map((r) => r.dataset.kind);
    expect([...container.querySelector('[data-role="filter"]').options].map((o) => o.textContent)).toEqual(["All", "Unpaid", "Partial", "Paid", "Planned"]);
    pick("planned");
    expect(kinds()).toEqual(["planned"]);
    pick("paid");
    expect(kinds()).toEqual(["expense"]);
    pick("partly");
    expect(kinds()).toEqual(["supplier"]);
  });

  it("+ Add → Expense: Amount, Supplier / Payee, Category, Date (rest under More options); a NEW category is created on the spot, no budget needed", async () => {
    const data = await mountMoney(money({ budgetApi: vi.fn(async () => ({ categoryId: "catNewFlower1" })) }));
    container.querySelector('[data-act="add"][data-x="expense"]').click();
    const form = lastForm();
    const main = [...form.querySelectorAll(".field")].filter((f) => !f.closest(".form-more")).map((f) => f.querySelector("input,select,textarea").name);
    expect(main).toEqual(["amount", "payee", "category", "date"]);
    expect(form.querySelector(".form-more summary").textContent).toBe("More options");
    form.elements.amount.value = "1200";
    form.elements.payee.value = "Petal Shop";
    form.elements.category.value = "Flowers";
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "createCategory", category: { name: "Flowers", budget: null } });
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", expense: { date: "2026-10-16", category: "catNewFlower1", amount: 120000, method: "cash", payee: "Petal Shop" } });
  });

  it("an existing category (any case) is reused; a saved supplier's name links the expense to it; a blank category is Miscellaneous", async () => {
    const data = await mountMoney(money({ budgetApi: vi.fn(async () => ({ categoryId: "catMisc000001" })) }));
    container.querySelector('[data-act="add"][data-x="expense"]').click();
    let form = lastForm();
    form.elements.amount.value = "500";
    form.elements.payee.value = "abc photo studio";
    form.elements.category.value = "photo / video";
    submit(form);
    await flush();
    expect(data.budgetApi).not.toHaveBeenCalled();
    expect(data.expensesApi).toHaveBeenLastCalledWith({ action: "create", expense: { date: "2026-10-16", category: "catPhotoVid01", amount: 50000, method: "cash", supplierId: SUP.id } });
    container.querySelector('[data-act="add"][data-x="expense"]').click();
    form = lastForm();
    form.elements.amount.value = "80";
    submit(form);
    await flush();
    expect(data.budgetApi).toHaveBeenCalledWith({ action: "createCategory", category: { name: "Miscellaneous", budget: null } });
  });

  it("+ Add → Supplier: name, category, total; the category is created if new and the service follows it", async () => {
    const data = await mountMoney(money({ budgetApi: vi.fn(async () => ({ categoryId: "catHmua000001" })), suppliersApi: vi.fn(async () => ({ supplierId: "x" })) }));
    container.querySelector('[data-act="add"][data-x="supplier"]').click();
    const form = lastForm();
    expect([...form.querySelectorAll(".field")].filter((f) => !f.closest(".form-more")).map((f) => f.querySelector("input,select,textarea").name)).toEqual(["name", "category", "agreedAmount"]);
    form.elements.name.value = "Glam by Jo";
    form.elements.category.value = "HMUA";
    form.elements.agreedAmount.value = "15000";
    submit(form);
    await flush();
    expect(data.suppliersApi).toHaveBeenCalledWith({ action: "create", supplier: { name: "Glam by Jo", service: "hair_makeup", agreedAmount: 1500000, categoryId: "catHmua000001", contactPerson: null, phone: null, email: null, location: null, notes: null } });
    expect([guessService("Photo & Video"), guessService("Souvenirs")]).toEqual(["photo_video", "other"]);
  });

  it("+ Add → Budget item: a new item with an amount (the planned line appears); planned ⋯ Add supplier pre-fills its category", async () => {
    const data = await mountMoney(money({ budgetApi: vi.fn(async () => ({ categoryId: "catGown000001" })) }));
    container.querySelector('[data-act="add"][data-x="budget"]').click();
    lastForm().elements.category.value = "Wedding gown";
    lastForm().elements.budget.value = "80000";
    submit(lastForm());
    await flush();
    expect(data.budgetApi).toHaveBeenNthCalledWith(1, { action: "createCategory", category: { name: "Wedding gown", budget: null } });
    expect(data.budgetApi).toHaveBeenNthCalledWith(2, { action: "updateCategory", categoryId: "catGown000001", changes: { budget: 8000000 } });
    rowOf('[data-planned="catVenue00001"] [data-x="supplier"]').click();
    expect(lastForm().elements.category.value).toBe("Venue");
  });

  it("⋯ View payments lists what was paid and what's scheduled (open a scheduled one to pay / edit it)", async () => {
    const data = money({ listWeddingExpenses: vi.fn(async (_b, f) => ({ rows: f.supplierId ? [{ id: "e1", date: "2026-10-01", amount: 1500000, supplierId: SUP.id }, { id: "e2", date: "2026-10-10", amount: 500000, supplierId: SUP.id }] : [], hasMore: false })) });
    await mountMoney(data);
    rowOf('[data-supplier="supABCphoto01"] [data-x="payments"]').click();
    await flush();
    const box = document.querySelector('[data-role="supplier-payments"]');
    expect(data.listWeddingExpenses).toHaveBeenCalledWith("demo-distributor-a", { status: "active", supplierId: SUP.id }, { pageSize: 100 });
    expect([...box.querySelectorAll('[data-role="paid-list"] .slip-what')].map((x) => x.textContent)).toEqual(["₱15,000 paid Oct 1", "₱5,000 paid Oct 10"]);
    expect(box.querySelector('[data-role="scheduled-list"] .wl-name').textContent).toBe("₱30,000 due Dec 1");
    box.querySelector('[data-x="scheduled"]').click();
    expect(document.querySelector('[data-role="details"] .card-title').textContent).toContain("Second payment");
  });

  // Owner-pilot Bridal fix pass: proof (receipt photo or PDF) under ⋯, never a column.
  const PREP = { contentType: "image/jpeg", dataBase64: "AAAA" };
  const pickFile = (form, file = { name: "receipt.jpg", type: "image/jpeg" }) => Object.defineProperty(form.elements.proof, "files", { value: [file], configurable: true });
  const proofMoney = (extra = {}) => money({ attachExpenseProof: vi.fn(async () => ({ hasProof: true })), expenseProof: vi.fn(async () => ({ proof: { contentType: "image/png", dataBase64: "iVBORw0KGgo=" } })), ...extra });
  const mountProofMoney = async (data) => {
    mountSuppliers(container, wedding(), { data, now: NOW, toast: () => {}, confirm: async () => true, prepareProof: vi.fn(async () => PREP) });
    await flush();
    return data;
  };

  it("expense ⋯: Add proof uploads a photo / PDF to THAT expense; with a proof: View proof / Replace proof; the row stays one line (no proof column)", async () => {
    const data = await mountProofMoney(proofMoney());
    const items = () => [...container.querySelectorAll(`[data-expense="${OTHER.id}"] .menu-item`)].map((b) => b.textContent);
    expect(items()).toEqual(["Details", "Add proof", "Change category", "Remove"]);
    const visible = container.querySelector(`[data-expense="${OTHER.id}"]`).cloneNode(true);
    visible.querySelector("details").remove();
    expect(visible.textContent).not.toMatch(/proof/i);
    rowOf(`[data-expense="${OTHER.id}"] [data-x="proof-add"]`).click();
    await flush();
    const form = lastForm();
    expect(form.elements.proof.getAttribute("accept")).toBe("image/jpeg,image/png,image/webp,application/pdf");
    pickFile(form);
    submit(form);
    await flush();
    expect(data.attachExpenseProof).toHaveBeenCalledWith(OTHER.id, PREP);

    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const withProof = { ...OTHER, proof: { contentType: "image/png", size: 200 } };
    const d2 = await mountProofMoney(proofMoney({ listWeddingExpenses: vi.fn(async () => ({ rows: [withProof], hasMore: false })) }));
    expect(items()).toEqual(["Details", "View proof", "Replace proof", "Change category", "Remove"]);
    rowOf(`[data-expense="${OTHER.id}"] [data-x="proof-view"]`).click();
    await flush();
    expect(d2.expenseProof).toHaveBeenCalledWith(OTHER.id);
    expect(document.querySelector('[data-role="proof-viewer"] img').getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("supplier ⋯ View payments: each paid line has View proof / Add proof; Record payment takes an optional proof (More options)", async () => {
    const data = proofMoney({
      listWeddingExpenses: vi.fn(async (_b, f) => ({ rows: f.supplierId ? [{ id: "e1aaaaaaaa", date: "2026-10-01", amount: 1500000, supplierId: SUP.id, status: "active", proof: { contentType: "application/pdf" } }, { id: "e2aaaaaaaa", date: "2026-10-10", amount: 500000, supplierId: SUP.id, status: "active" }] : [], hasMore: false })),
      expensesApi: vi.fn(async () => ({ expenseId: "e3aaaaaaaa" })),
    });
    await mountProofMoney(data);
    rowOf('[data-supplier="supABCphoto01"] [data-x="payments"]').click();
    await flush();
    const box = document.querySelector('[data-role="supplier-payments"]');
    expect([...box.querySelectorAll('[data-role="paid-list"] .slip-act')].map((x) => x.textContent.trim())).toEqual(["View proof", "Add proof"]);
    box.querySelector('[data-x="proof-add"][data-id="e2aaaaaaaa"]').click();
    await flush();
    pickFile(lastForm(), { name: "transfer.pdf", type: "application/pdf" });
    submit(lastForm());
    await flush();
    expect(data.attachExpenseProof).toHaveBeenCalledWith("e2aaaaaaaa", PREP);

    rowOf('[data-supplier="supABCphoto01"] [data-x="record"]').click();
    await flush();
    const form = lastForm();
    form.elements.amount.value = "5000";
    pickFile(form);
    submit(form);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith(expect.objectContaining({ action: "create", expense: expect.objectContaining({ amount: 500000, supplierId: SUP.id }) }));
    expect(data.attachExpenseProof).toHaveBeenLastCalledWith("e3aaaaaaaa", PREP);
  });

  it("a failed proof upload after Record payment keeps the payment and says how to add the proof later", async () => {
    const toast = vi.fn();
    const data = proofMoney({ expensesApi: vi.fn(async () => ({ expenseId: "e3aaaaaaaa" })), attachExpenseProof: vi.fn(async () => { throw new Error("Proofs must be under 2.5 MB"); }) });
    mountSuppliers(container, wedding(), { data, now: NOW, toast, confirm: async () => true, prepareProof: vi.fn(async () => PREP) });
    await flush();
    rowOf('[data-supplier="supABCphoto01"] [data-x="record"]').click();
    await flush();
    lastForm().elements.amount.value = "5000";
    pickFile(lastForm());
    submit(lastForm());
    await flush();
    expect(toast).toHaveBeenCalledWith("Saved, but the proof didn't upload (Proofs must be under 2.5 MB). Add it from ⋯ → Add proof.", "danger");
    expect(toast).toHaveBeenCalledWith("Payment recorded.", "success");
  });

  it("permissions: no record / schedule / add expense without the right; no hidden action is offered", async () => {
    const s = wedding("manager");
    delete s.member.permissions["expenses.create"];
    delete s.member.permissions["vendorpayments.manage"];
    await mountMoney(money(), s);
    expect(container.querySelector('[data-x="record"]')).toBeNull();
    expect(container.querySelector('[data-x="schedule"]')).toBeNull();
    expect(container.querySelector('[data-act="add"][data-x="expense"]')).toBeNull();
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

  it("Seating: attending · seated · unassigned (people); Unassigned first, then tables with seats used / capacity", async () => {
    mountGuests(container, wedding(), { data: guestsData(), toast: () => {} });
    await flush();
    switchTo("seating");
    expect(container.querySelector('[data-role="seating-summary"]').textContent).toBe("4 attending · 2 seated · 2 unassigned");
    expect([...container.querySelectorAll('[data-role="unassigned"] [data-guest]')].map((r) => r.dataset.guest)).toEqual(["guestReyes001"]);
    // Unassigned rows: Name | Seats | Assign (a visible button).
    expect(container.querySelector('[data-role="unassigned"] [data-act="seat"]').textContent).toBe("Assign");
    expect([...container.querySelectorAll("[data-table]")].map((s) => [s.querySelector(".wl-group-title").textContent, s.querySelector('[data-role="table-seats"]').textContent])).toEqual([["Table 1", "· 2/2"], ["Table 2", "· 0/10"]]);
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
    container.querySelector('[data-supplier="supABCphoto01"] [data-act="open"]').click();
    expect(panel().querySelector('[data-act="delete"]')).toBeNull(); // has payments: archive only
    panel().querySelector('[data-act="close"]').click();
    expect(container.querySelector('[data-supplier="supABCphoto01"] [data-x="delete"]')).toBeNull();
    container.querySelector('[data-supplier="supFreshOne01"] [data-x="delete"]').click();
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

describe("Bridal More: Wedding Setup and Export & Backup", () => {
  it("More holds Wedding Setup and Export & Backup; Staff get neither", () => {
    expect(buildRoutes(wedding()).filter((r) => ["/wedding-setup", "/export"].includes(r.path)).map((r) => r.label)).toEqual(["Export & Backup", "Wedding Setup"]);
    expect(buildRoutes(wedding("staff")).some((r) => ["/wedding-setup", "/export"].includes(r.path))).toBe(false);
  });

  it("Wedding Setup saves the controlled invitation fields and the RSVP rules", async () => {
    const api = vi.fn(async (_p, { body }) => (body.action === "get" ? { setup: { coupleNames: "Camille & Carlo", rsvpEnabled: true }, hasHero: false } : { saved: true }));
    mountSetup(container, wedding(), { api, toast: () => {} });
    await flush();
    const f = container.querySelector('[data-role="setup"]');
    expect(f.elements.coupleNames.value).toBe("Camille & Carlo");
    f.elements.weddingDate.value = "2027-12-12";
    f.elements.ceremonyTime.value = "15:00";
    f.elements.ceremonyVenue.value = "Example Church";
    f.elements.rsvpDeadline.value = "2027-11-15";
    f.elements.dressCode.value = "Formal";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(api).toHaveBeenLastCalledWith("wedding-setup", { method: "POST", body: { action: "save", setup: expect.objectContaining({ coupleNames: "Camille & Carlo", weddingDate: "2027-12-12", ceremonyTime: "15:00", ceremonyVenue: "Example Church", rsvpDeadline: "2027-11-15", dressCode: "Formal", rsvpEnabled: true, closeAfterDeadline: true }) } });
  });

  const FULL = { coupleNames: "Camille & Carlo", ceremonyVenue: "Example Church", ceremonyAddress: "Taguig City", receptionVenue: "Example Garden", receptionAddress: "Pasig City", dressCode: "Formal", welcomeMessage: "Join us!", weddingDate: "2027-12-12", rsvpDeadline: "2027-11-15", ceremonyTime: "15:00", receptionTime: "17:30", ceremonyMap: "https://maps.app.goo.gl/church", receptionMap: "https://maps.app.goo.gl/garden", rsvpEnabled: true, closeAfterDeadline: false };
  const fill = (f, v) => {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "boolean") f.elements[k].checked = x;
      else f.elements[k].value = x;
      f.elements[k].dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  it("Wedding Setup: every field is sent; Saving… then Saved ✓ shows what the server stored (read back)", async () => {
    let release;
    const api = vi.fn(async (_p, { body }) => {
      if (body.action === "get") return { setup: {}, hasHero: false };
      await new Promise((r) => (release = r));
      return { saved: true, setup: { ...body.setup, coupleNames: "Camille & Carlo (stored)" } };
    });
    mountSetup(container, wedding(), { api, toast: () => {} });
    await flush();
    const f = container.querySelector('[data-role="setup"]');
    fill(f, FULL);
    expect(container.querySelector('[data-role="save-state"]').dataset.state).toBe("dirty");
    submit(f);
    await flush();
    const btn = container.querySelector('[data-role="setup"] button[type="submit"]');
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Saving…");
    expect(container.querySelector('[data-role="save-state"]').textContent).toBe("Saving…");
    expect(api).toHaveBeenLastCalledWith("wedding-setup", { method: "POST", body: { action: "save", setup: FULL } });
    release();
    await flush();
    expect(container.querySelector('[data-role="save-state"]').dataset.state).toBe("saved");
    expect(container.querySelector('[data-role="save-state"]').textContent).toMatch(/Saved ✓/);
    expect(container.querySelector('[data-role="setup"]').elements.coupleNames.value).toBe("Camille & Carlo (stored)");
    expect(container.querySelector('[data-role="setup"] button[type="submit"]').disabled).toBe(false);
  });

  it("Wedding Setup: choosing a cover photo keeps what was typed (the pilot bug: Save then stored blanks)", async () => {
    const api = vi.fn(async (_p, { body }) => (body.action === "get" ? { setup: {}, hasHero: false } : body.action === "hero" ? { hero: true } : { saved: true, setup: body.setup }));
    mountSetup(container, wedding(), { api, toast: () => {}, shrink: async () => "data:image/jpeg;base64,AAAA" });
    await flush();
    const f = container.querySelector('[data-role="setup"]');
    fill(f, FULL);
    container.querySelector('[data-role="hero"]').dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(api).toHaveBeenCalledWith("wedding-setup", { method: "POST", body: { action: "hero", dataUrl: "data:image/jpeg;base64,AAAA" } });
    expect(container.querySelector('[data-role="hero-state"]').textContent).toBe("A photo is set.");
    const same = container.querySelector('[data-role="setup"]');
    expect(same.elements.coupleNames.value).toBe("Camille & Carlo");
    expect(same.elements.weddingDate.value).toBe("2027-12-12");
    submit(same);
    await flush();
    expect(api).toHaveBeenLastCalledWith("wedding-setup", { method: "POST", body: { action: "save", setup: FULL } });
  });

  it("Wedding Setup: a failed save says so (role=alert), keeps the typed values and lets the Owner retry; a bad map link isn't sent", async () => {
    let fail = true;
    const toast = vi.fn();
    const api = vi.fn(async (_p, { body }) => {
      if (body.action === "get") return { setup: {}, hasHero: false };
      if (fail) throw new Error("Network error");
      return { saved: true, setup: body.setup };
    });
    mountSetup(container, wedding(), { api, toast });
    await flush();
    const f = container.querySelector('[data-role="setup"]');
    fill(f, { ...FULL, ceremonyMap: "maps.google.com/x" });
    submit(f);
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"][data-role="save-state"]').textContent).toMatch(/ceremony map link must start with https:\/\//);
    fill(f, { ceremonyMap: FULL.ceremonyMap });
    submit(f);
    await flush();
    expect(container.querySelector('[role="alert"][data-role="save-state"]').textContent).toMatch(/Not saved: Network error/);
    expect(toast).toHaveBeenCalledWith("Network error", "danger");
    expect(container.querySelector('[data-role="setup"]').elements.coupleNames.value).toBe("Camille & Carlo");
    expect(container.querySelector('[data-role="setup"] button[type="submit"]').disabled).toBe(false);
    fail = false;
    submit(container.querySelector('[data-role="setup"]'));
    await flush();
    expect(container.querySelector('[data-role="save-state"]').dataset.state).toBe("saved");
  });

  it("Wedding Setup: reopening the page (reload / next sign-in) shows every saved value", async () => {
    const api = vi.fn(async () => ({ setup: FULL, hasHero: true }));
    mountSetup(container, wedding(), { api, toast: () => {} });
    await flush();
    const f = container.querySelector('[data-role="setup"]');
    for (const [k, v] of Object.entries(FULL)) expect(typeof v === "boolean" ? f.elements[k].checked : f.elements[k].value, k).toBe(v);
    expect(container.querySelector('[data-role="hero-state"]').textContent).toBe("A photo is set.");
  });

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

  it("Guest ⋯ with Wedding Setup done and no link yet: Create invitation link creates, copies and refreshes", async () => {
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: [{ ...GUEST, category: "family" }], hasMore: false })), getSeating: vi.fn(async () => null), getWeddingSetup: vi.fn(async () => ({ setup: FULL })), guestsApi: vi.fn(async () => ({ path: "/invite/" + "a".repeat(32), created: true })) });
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    const toast = vi.fn();
    mountGuests(container, wedding(), { data, toast, confirm: async () => true });
    await flush();
    expect(guestMenuItems()).toContain("Create invitation link");
    expect(guestMenuItems()).not.toContain("Regenerate invitation link");
    const loads = data.listGuests.mock.calls.length;
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-create"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "inviteLink", guestId: GUEST.id });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${location.origin}/invite/${"a".repeat(32)}`);
    expect(toast).toHaveBeenCalledWith("Invitation link for Prado Family created and copied.", "success");
    expect(data.listGuests.mock.calls.length).toBeGreaterThan(loads);
  });

  it("Guest ⋯ with a link: View invitation / Copy invitation link / Regenerate invitation link", async () => {
    const data = fakeData({ listGuests: vi.fn(async () => ({ rows: [{ ...GUEST, category: "family", invitation: { status: "active" } }], hasMore: false })), getSeating: vi.fn(async () => null), getWeddingSetup: vi.fn(async () => ({ setup: FULL })), guestsApi: vi.fn(async () => ({ path: "/invite/" + "a".repeat(32) })) });
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    const toast = vi.fn();
    mountGuests(container, wedding(), { data, toast, confirm: async () => true });
    await flush();
    expect(guestMenuItems()).toEqual(expect.arrayContaining(["View invitation", "Copy invitation link", "Regenerate invitation link"]));
    expect(guestMenuItems()).not.toContain("Create invitation link");
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-copy"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "inviteLink", guestId: GUEST.id });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${location.origin}/invite/${"a".repeat(32)}`);
    const win = { location: { href: "" } };
    const open = vi.spyOn(window, "open").mockReturnValue(win);
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-view"]').click();
    await flush();
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(win.location.href).toBe(`${location.origin}/invite/${"a".repeat(32)}`);
    open.mockRestore();
    container.querySelector('[data-guest="guestPrado001"] [data-act="invite-new"]').click();
    await flush();
    expect(data.guestsApi).toHaveBeenCalledWith({ action: "regenerateInvite", guestId: GUEST.id });
    expect(toast).toHaveBeenCalledWith("New link for Prado Family copied.", "success");
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
    root.querySelector('[data-seats="1"]').click();
    root.querySelector('[data-act="send"]').click();
    await flush();
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body)).toEqual({ action: "respond", token: TOKEN, rsvp: { status: "attending", confirmed: 1 } });
    expect(root.querySelector('[data-role="done"]').textContent).toContain("Thank you, Maria.");
    expect(root.querySelector('[data-role="done"]').textContent).toContain("We've saved your RSVP for 1 guest.");
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
