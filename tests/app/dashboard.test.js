// @vitest-environment jsdom
// Dashboard = Monitor (Phase 18.5). Honest empty states, values only from
// metric documents / small list queries, money only for dashboard.financials,
// the business-local date and no reads beyond the planned documents. The
// Business Dashboard is the checkout (Owner pilot). Each workspace layout
// answers its own question.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/dashboard/index.js";
import { buildRoutes } from "../../src/app/routes.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";
import { combineDashboardDocs } from "../../shared/dashboard.js";

let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const NOW = new Date("2026-10-07T16:30:00Z"); // 2026-10-08 00:30 in Manila
const widget = (id) => container.querySelector(`[data-widget="${id}"]`);
const value = (id) => widget(id)?.querySelector(".kpi-value").textContent.trim();
const sectionOf = (id) => container.querySelector(`[data-section="${id}"]`);

// Like data.js: every planned document id, combined (summed for a period);
// count queries answered from `counts` keyed by "count:<widgetId>".
const fakeFetch = (docs, counts = {}) =>
  vi.fn(async (_bid, documents) =>
    Object.fromEntries(
      documents.map((d) => {
        if (d.count) return [d.source, d.source in counts ? { status: "ok", data: { count: counts[d.source] } } : { status: "ok", data: { count: 0 } }];
        const data = combineDashboardDocs(d.source, d.ids.map((id) => docs[`${d.collection}/${id}`] ?? null));
        return [d.source, data ? { status: "ok", data } : { status: "missing", data: null }];
      })
    )
  );
async function show(session, docs = {}, lists = {}, extra = {}, counts = {}) {
  const fetchDocuments = fakeFetch(docs, counts);
  const fetchLists = vi.fn(async (_bid, widgets) => Object.fromEntries(widgets.map((w) => [w.id, { status: "ok", rows: lists[w.id] ?? [] }])));
  mount(container, session, { fetchDocuments, fetchLists, now: NOW, ...extra });
  fetchDocuments.fetchLists = fetchLists;
  await flush();
  return fetchDocuments;
}

const DOCS = {
  "financialMetrics/2026-10-07": { grossSales: 200000, discounts: 0, returns: 0, cogs: 120000, operatingExpenses: 0, paymentsReceived: 50000 },
  "financialMetrics/2026-10-08": { grossSales: 1234550, discounts: 34550, returns: 0, cogs: 700000, operatingExpenses: 150000, paymentsReceived: 900000 },
  "financialMetrics/current": { receivablesOutstanding: 300000 },
  "metrics/2026-10-07": { orderCount: 2, fulfilledOrders: 2, cancelledOrders: 0 },
  "metrics/2026-10-08": { orderCount: 12, fulfilledOrders: 3, cancelledOrders: 1 },
  "metrics/current": { pendingFulfillment: 4, unpaidOrders: 2, lowStockProducts: 5 },
};
const RICE = { id: "p1", sku: "RICE-25", name: "Rice 25kg", unit: "sack", available: 3000, reserved: 1000, reorderLevel: 5000, isLowStock: true };
const ORDER = { id: "o1", orderNumber: "ORD-1058", customer: { name: "ABC Store" }, itemCount: 2, total: 450000, balance: 450000, paymentStatus: "unpaid", fulfillmentStatus: "preparing" };

const COLA = { id: "p2", sku: "COLA-1L", name: "Cola 1L", unit: "pcs", available: 10000, reserved: 0, sellingPrice: 7500, status: "active" };
const RICE_P = { ...RICE, sellingPrice: 125000, status: "active" };
const OUT = { id: "p3", sku: "OIL-1", name: "Oil 1L", unit: "bottle", available: 0, sellingPrice: 9000, status: "active" };
const products = () => vi.fn(async () => [COLA, RICE_P, OUT]);
const co = (sel) => container.querySelector(`[data-role="checkout"] ${sel}`);
const rowOf = (id) => co(`[data-product="${id}"]`);
const tap = async (id, act, n = 1) => {
  for (let i = 0; i < n; i += 1) rowOf(id).querySelector(`[data-act="co-${act}"]`).click();
  await flush();
};
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

describe("Distributor: the Dashboard is the checkout", () => {
  it("top figures: Total sales, Total orders (with fulfilled), Gross profit (no Unpaid)", async () => {
    await show(sessionFixture(), DOCS, {}, { listActiveProducts: products() });
    expect([...container.querySelectorAll('[data-role="kpis"] [data-widget]')].map((e) => e.dataset.widget)).toEqual(["netSales", "ordersToday", "grossProfit"]);
    expect(value("netSales")).toBe("₱12,000.00");
    expect(value("ordersToday")).toBe("12");
    expect(widget("ordersToday").textContent).toMatch(/3 fulfilled/);
    expect(value("grossProfit")).toBe("₱5,000.00");
    expect(container.textContent).not.toMatch(/Unpaid/);
  });

  it("no Needs attention, Inventory summary or Orders summary; no list queries, no live counts", async () => {
    const fetch = await show(sessionFixture(), DOCS, {}, { listActiveProducts: products() });
    for (const id of ["attention", "inventory", "orders"]) expect(sectionOf(id), id).toBeNull();
    expect(fetch.fetchLists).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].filter((d) => d.count)).toEqual([]);
  });

  it("with no metric documents every figure says No data yet", async () => {
    await show(sessionFixture(), {}, {}, { listActiveProducts: vi.fn(async () => []) });
    for (const id of ["netSales", "ordersToday", "grossProfit"]) expect(value(id), id).toBe("No data yet");
    expect(container.textContent).not.toMatch(/\b0\.00\b/);
    expect(co('[data-role="co-products"]').textContent).toMatch(/No products yet/);
  });

  it("products: name, SKU · price · what is left, and − qty + ; search by name or SKU; Create order disabled while empty", async () => {
    await show(sessionFixture(), DOCS, {}, { listActiveProducts: products() });
    expect([...container.querySelectorAll('[data-role="checkout"] [data-product]')].map((li) => li.dataset.product)).toEqual(["p2", "p3", "p1"]); // by name
    expect(text(rowOf("p2").querySelector(".co-sub"))).toBe("COLA-1L · ₱75 · 10 pcs left");
    expect(text(rowOf("p3").querySelector(".co-sub"))).toMatch(/Out of stock/);
    expect(rowOf("p3").querySelector('[data-act="co-inc"]').disabled).toBe(true);
    expect(rowOf("p2").querySelector('[data-act="co-dec"]').disabled).toBe(true);
    expect(co('[data-act="co-create"]').disabled).toBe(true);
    const search = co('[data-role="co-search"]');
    search.value = "rice-";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...container.querySelectorAll('[data-role="checkout"] [data-product]')].map((li) => li.dataset.product)).toEqual(["p1"]);
  });

  it("tapping builds the summary: line subtotals, total items, total; stock left follows; + stops at what is available", async () => {
    await show(sessionFixture(), DOCS, {}, { listActiveProducts: products() });
    await tap("p2", "inc", 5);
    await tap("p2", "dec");
    await tap("p1", "inc", 4); // only 3 sacks left
    expect(rowOf("p2").querySelector(".co-num").value).toBe("4");
    expect(text(rowOf("p2").querySelector('[data-role="left"]'))).toBe("6 pcs left");
    expect(rowOf("p1").querySelector(".co-num").value).toBe("3");
    expect(rowOf("p1").querySelector('[data-act="co-inc"]').disabled).toBe(true);
    const lines = [...container.querySelectorAll('[data-role="co-lines"] .co-line')].map((li) => [text(li.querySelector(".co-name")), text(li.querySelector(".co-sub")), text(li.querySelector(".co-amt"))]);
    expect(lines).toEqual([["Cola 1L", "4 pcs × ₱75", "₱300"], ["Rice 25kg", "3 sack × ₱1,250", "₱3,750"]]);
    expect(text(co('[data-role="co-items"]'))).toBe("7");
    expect(text(co('[data-role="co-total"]'))).toBe("₱4,050");
    expect(co('[data-act="co-create"]').disabled).toBe(false);
  });

  it("a typed quantity counts too; an invalid one blocks Create order", async () => {
    await show(sessionFixture(), DOCS, {}, { listActiveProducts: products() });
    const box = rowOf("p2").querySelector(".co-num");
    box.value = "12";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(text(co('[data-role="co-total"]'))).toBe("₱900");
    box.value = "1.5";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(co('[data-act="co-create"]').disabled).toBe(true);
    const why = rowOf("p2").querySelector('[data-role="co-qty-error"]');
    expect(why.hidden).toBe(false); // the reason shows while typing
    expect(why.textContent).not.toBe("");
    box.value = "2";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(why.hidden).toBe(true);
  });

  it("Create order: ONE order through the same orders create action (walk-in, not fulfilled); a double tap sends once; the cart resets and the figures reload", async () => {
    let resolve;
    const api = vi.fn(() => new Promise((r) => (resolve = r)));
    const toast = vi.fn();
    const fetch = await show(sessionFixture(), DOCS, {}, { listActiveProducts: products(), api, toast });
    await tap("p2", "inc", 5);
    co('[data-act="co-create"]').click();
    co('[data-act="co-create"]').click();
    expect(api).toHaveBeenCalledTimes(1);
    const [path, { method, body }] = api.mock.calls[0];
    expect([path, method, body.action]).toEqual(["orders", "POST", "create"]);
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(body.order).toEqual({ customer: { name: "Walk-in", phone: "", notes: "" }, source: "walk_in", sourceNote: "", deliveryAddress: "", items: [{ productId: "p2", quantity: 5000 }], notes: "" });
    expect(Object.keys(body)).not.toContain("fulfill");
    resolve({ success: true, orderId: "o9", orderNumber: "ORD-1060" });
    await flush();
    await flush();
    expect(toast).toHaveBeenCalledWith("Order ORD-1060 created", "success");
    expect(co('[data-role="co-none"]')).not.toBeNull();
    expect(co('[data-act="co-create"]').disabled).toBe(true);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    // The next order gets its own key.
    await tap("p2", "inc");
    co('[data-act="co-create"]').click();
    expect(api.mock.calls[1][1].body.idempotencyKey).not.toBe(body.idempotencyKey);
  });

  it("optional customer: name, source and note are sent when given", async () => {
    const api = vi.fn(async () => ({ orderNumber: "ORD-1061" }));
    await show(sessionFixture(), DOCS, {}, { listActiveProducts: products(), api, toast: vi.fn() });
    await tap("p1", "inc");
    const set = (c, v) => {
      const el = co(`[data-c="${c}"]`);
      el.value = v;
      el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    };
    set("name", "ABC Store");
    set("source", "messenger");
    set("note", "Pick up at 3pm");
    co('[data-act="co-create"]').click();
    await flush();
    expect(api.mock.calls[0][1].body.order).toMatchObject({ customer: { name: "ABC Store" }, source: "messenger", notes: "Pick up at 3pm", items: [{ productId: "p1", quantity: 1000 }] });
    expect(co('[data-role="co-customer"]').open).toBe(false); // secondary: folded by default
  });

  it("a server refusal shows on the checkout and keeps the cart", async () => {
    const api = vi.fn(async () => {
      throw new Error("Only 2 sack of Rice 25kg available");
    });
    await show(sessionFixture(), DOCS, {}, { listActiveProducts: products(), api, toast: vi.fn() });
    await tap("p1", "inc", 3);
    co('[data-act="co-create"]').click();
    await flush();
    expect(co('[data-role="co-error"]').hidden).toBe(false);
    expect(co('[data-role="co-error"]').textContent).toMatch(/Only 2 sack/);
    expect(rowOf("p1").querySelector(".co-num").value).toBe("3");
  });

  it("a read error shows Couldn't load on just the affected figures", async () => {
    mount(container, sessionFixture(), {
      now: NOW,
      listActiveProducts: products(),
      fetchLists: async () => ({}),
      fetchDocuments: async (_b, docs) => Object.fromEntries(docs.map((d) => [d.source, d.collection === "financialMetrics" ? { status: "error" } : { status: "missing" }])),
    });
    await flush();
    expect(value("netSales")).toBe("Couldn't load");
    expect(value("ordersToday")).toBe("No data yet");
  });
});

describe("who sees what", () => {
  it("staff: operations only, and the financial documents are never requested", async () => {
    const fetch = await show(sessionFixture({ roleTemplate: "staff" }), {}, {}, { listActiveProducts: vi.fn(async () => []) });
    expect(widget("netSales")).toBeNull();
    expect(widget("grossProfit")).toBeNull();
    expect(container.textContent).not.toMatch(/₱/);
    expect(value("ordersToday")).toBe("No data yet");
    const requested = fetch.mock.calls.flatMap((c) => c[1].map((d) => d.collection));
    expect(requested).not.toContain("financialMetrics");
  });

  it("staff granted dashboard.financials see Total sales", async () => {
    await show(sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { grant: ["dashboard.financials"] }) }));
    expect(widget("netSales")).not.toBeNull();
  });

  it("a module off for the business removes what depends on it (Gross profit needs Inventory)", async () => {
    await show(sessionFixture({ overrides: { modules: { inventory: false } } }), DOCS, {}, { listActiveProducts: vi.fn(async () => []) });
    expect(widget("grossProfit")).toBeNull();
    expect(widget("netSales")).not.toBeNull();
  });

  it("no orders.create: no checkout, a pointer to Orders instead", async () => {
    await show(sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { revoke: ["orders.create"] }) }));
    expect(container.querySelector('[data-role="checkout"]')).toBeNull();
    expect(container.querySelector('a[href="/orders"]')).not.toBeNull();
  });

  it("the owner's dashboard for Today reads exactly two documents and no live counts", async () => {
    const fetch = await show(sessionFixture());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("demo-distributor-a");
    const plan = fetch.mock.calls[0][1];
    expect(plan.filter((d) => !d.count).flatMap((d) => d.ids.map((id) => `${d.collection}/${id}`)).sort()).toEqual(["financialMetrics/2026-10-08", "metrics/2026-10-08"]);
    expect(plan.filter((d) => d.count)).toEqual([]);
  });
});

describe("business timezone", () => {
  it("00:30 in Manila is already the 8th: the header and documents use the local day", async () => {
    const fetch = await show(sessionFixture());
    expect(container.querySelector(".page-subtitle").textContent).toMatch(/Today: Oct 8, 2026/);
    expect(fetch.mock.calls[0][1].some((d) => d.ids?.includes("2026-10-08"))).toBe(true);
  });

  it("a business in another timezone gets its own date", async () => {
    const session = sessionFixture();
    session.business.timezone = "America/Los_Angeles";
    const fetch = await show(session);
    expect(fetch.mock.calls[0][1].some((d) => d.ids?.includes("2026-10-07"))).toBe(true);
  });

  it("an invalid timezone shows an error instead of guessing", async () => {
    const session = sessionFixture();
    session.business.timezone = "Nowhere/City";
    const fetchDocuments = vi.fn();
    mount(container, session, { fetchDocuments, now: NOW });
    expect(container.textContent).toMatch(/timezone isn't set up/);
    expect(fetchDocuments).not.toHaveBeenCalled();
  });
});

describe("period filter: period figures vs live 'now' figures", () => {
  const choose = async (preset) => {
    const sel = container.querySelector('select[name="preset"]');
    sel.value = preset;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  };

  it("Yesterday / This week change the period figures (sales, orders, gross profit)", async () => {
    const fetch = await show(sessionFixture(), DOCS);
    await choose("yesterday");
    expect(fetch.mock.calls.at(-1)[1].find((d) => d.source === "financial-day").ids).toEqual(["2026-10-07"]);
    expect(value("netSales")).toBe("₱2,000.00");
    expect(value("ordersToday")).toBe("2");
    expect(value("grossProfit")).toBe("₱800.00");
    await choose("thisWeek"); // Mon Oct 5 .. Thu Oct 8
    expect(fetch.mock.calls.at(-1)[1].find((d) => d.source === "operational-day").ids).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(value("ordersToday")).toBe("14");
  });

  it("Last month with no summaries says No data yet (never ₱0); the header names the range", async () => {
    await show(sessionFixture(), DOCS);
    await choose("lastMonth");
    expect(container.querySelector(".page-subtitle").textContent).toMatch(/Last month: Sep 1, 2026 – Sep 30, 2026/);
    expect(value("netSales")).toBe("No data yet");
    expect(value("ordersToday")).toBe("No data yet");
    expect(value("grossProfit")).toBe("No data yet");
  });

  it("custom: inclusive, business-local; future ranges are refused", async () => {
    const toast = vi.fn();
    const fetch = await show(sessionFixture(), DOCS, {}, { toast });
    await choose("custom");
    const form = container.querySelector('[data-role="period"]');
    expect(form.querySelector(".dash-dates").hidden).toBe(false);
    form.elements.from.value = "2026-10-07";
    form.elements.to.value = "2026-10-08";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(value("netSales")).toBe("₱14,000.00");
    const calls = fetch.mock.calls.length;
    const form2 = container.querySelector('[data-role="period"]');
    form2.elements.from.value = "2026-10-07";
    form2.elements.to.value = "2026-10-09";
    form2.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/after today/), "danger");
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("Owner-pilot: no Download Excel on the dashboard (More → Export & Backup)", async () => {
    await show(sessionFixture(), DOCS);
    await choose("yesterday");
    expect(container.querySelector('[data-act="export"]')).toBeNull();
  });
});

describe("Household: the payroll pulse", () => {
  const H = () => sessionFixture({ workspaceTemplateId: "household-payroll" });
  const draft = (id, name, start, end, net, extra = {}) => ({ id, staffName: name, periodStart: start, periodEnd: end, netPay: net, present: 12, officialLeave: 1, absent: 2, notMarked: 0, ...extra });

  it("ready-to-release salaries come first; the current period shows each person's pay so far with P / L / A", async () => {
    await show(H(), {}, {
      payrollsToRelease: [draft("a", "Maria", "2026-09-16", "2026-09-30", 770000), draft("b", "Ana", "2026-10-01", "2026-10-15", 400000, { present: 6, absent: 1, officialLeave: 0 })],
      awaitingReceipt: [{ id: "c", staffName: "Liza", salary: { paidDate: "2026-10-01", amount: 350000 } }],
      attendanceToday: [{ id: "x" }],
      advancesNotPaid: [],
      advancesToDeduct: [{ id: "d", amount: 150000, deducted: false }],
    }, {}, { "count:activeStaff": 3 });
    expect(value("nextPayroll")).toBe("₱7,700.00");
    expect(widget("nextPayroll").textContent).toMatch(/Ready to release/);
    expect(value("activeStaff")).toBe("3");
    expect(widget("activeStaff").textContent).toMatch(/2 not marked today/);
    expect(value("advancesToDeduct")).toBe("₱1,500.00");
    const att = [...sectionOf("attention").querySelectorAll("[data-attention]")].map((li) => li.dataset.attention);
    expect(att).toEqual(["release", "receipt", "attendance"]);
    const period = sectionOf("period");
    expect(period.textContent).toMatch(/Ana/);
    expect(period.textContent).toMatch(/6 present · 0 leave · 1 absent/);
    expect(period.textContent).not.toMatch(/Maria/); // the ended period isn't "current"
  });
});

describe("Household: a period ending today", () => {
  it("is the current period (in progress), not 'ready to release'", async () => {
    const s0 = sessionFixture({ workspaceTemplateId: "household-payroll" });
    await show(s0, {}, { payrollsToRelease: [{ id: "a", staffName: "Maria", periodStart: "2026-09-23", periodEnd: "2026-10-08", netPay: 500000, present: 10, officialLeave: 0, absent: 0 }], awaitingReceipt: [], attendanceToday: [], advancesNotPaid: [], advancesToDeduct: [] }, {}, { "count:activeStaff": 1 });
    expect(container.querySelector('[data-attention="release"]')).toBeNull();
    expect(widget("nextPayroll").textContent).toMatch(/Next payroll/);
    expect(sectionOf("period").textContent).toMatch(/Maria/);
  });
});

describe("Baby: how much have we spent, who paid, and what's coming up? (Phase 18.6)", () => {
  const B = () => sessionFixture({ workspaceTemplateId: "baby-expense" });
  it("three money cards, a card per payer (shared purchases counted once), and Coming up with the unpaid part", async () => {
    const fetch = await show(
      B(),
      {
        "budgets/current": { total: 15000000, spent: 2450000, upcoming: 1500000, spentByPayer: { mom: 1400000, dad: 850000 }, payerNames: { mom: "Mom", dad: "Dad" } },
        "spendingMetrics/2026-10": { spent: 600000, count: 3 },
      },
      { upcomingPayments: [{ id: "s1", description: "Hospital deposit", amount: 2000000, paidAmount: 500000, dueDate: "2026-10-12", status: "upcoming" }] }
    );
    expect(value("budgetSpent")).toBe("₱24,500.00");
    expect(value("budgetUpcoming")).toBe("₱15,000.00");
    expect(value("babySpentThisMonth")).toBe("₱6,000.00");
    // No budget card, no expense count, no recent list, no "needs attention".
    for (const gone of ["budgetTotal", "budgetRemaining", "babyExpenseCount"]) expect(widget(gone)).toBeFalsy();
    for (const gone of ["attention", "recent", "categories", "budget"]) expect(sectionOf(gone)).toBeNull();
    const payers = [...sectionOf("payers").querySelectorAll("[data-payer]")].map((p) => `${p.querySelector(".payer-name").textContent} ${p.querySelector(".payer-amount").textContent}`);
    expect(payers).toEqual(["Mom ₱14,000.00", "Dad ₱8,500.00", "Not set ₱2,000.00"]);
    const up = sectionOf("upcoming").textContent.replace(/\s+/g, " ");
    expect(up).toMatch(/Hospital deposit/);
    expect(up).toMatch(/₱5,000.00 already paid/);
    expect(up).toMatch(/₱15,000.00/);
    // Only this month's spending document is read (no period filter).
    expect(fetch.mock.calls[0][1].find((d) => d.collection === "spendingMetrics").ids).toEqual(["2026-10"]);
    expect(container.querySelector('[data-role="period"]')).toBeNull();
    expect(container.textContent).not.toMatch(/COGS|Gross profit/);
  });
});

describe("Bridal: are we on track?", () => {
  const W = () => sessionFixture({ workspaceTemplateId: "bridal-expense" });
  it("budget hero, total upcoming payments (no Needs attention), tasks, RSVP and supplier summary", async () => {
    await show(W(), { "budgets/current": { total: 50000000, spent: 18450000, upcoming: 12500000 }, "guestTotals/current": { invitations: 12, invitedSeats: 30, attending: 7, attendingSeats: 16, declined: 2, declinedSeats: 5, awaiting: 3, awaitingSeats: 9 } }, {
      upcomingSupplierPayments: [{ id: "p1", supplierName: "Grand Table Catering", description: "Second payment", amount: 4000000, dueDate: "2026-10-14" }],
      tasksDueSoon: [{ id: "t1", title: "Final guest count", dueDate: "2026-10-05", status: "in_progress" }, { id: "t2", title: "Food tasting", dueDate: "2026-10-15", status: "not_started" }],
      rsvpSummary: [{ id: "attending", row: "attending", invitations: 12, invitedSeats: 30, attending: 7, attendingSeats: 16, declined: 2, declinedSeats: 5, awaiting: 3, awaitingSeats: 9, byCategory: { sponsors: { invitations: 2, invitedSeats: 4, attending: 2, attendingSeats: 4 }, family: { invitations: 3, invitedSeats: 8, awaiting: 3, awaitingSeats: 8 } } }],
      supplierSummary: [{ id: "s1", name: "Grand Table Catering", agreedAmount: 15000000, paid: 5000000, balance: 10000000 }],
    }, {}, { "count:weddingOverdueTasks": 1 });
    expect(value("weddingRemaining")).toBe("₱315,500.00");
    expect(sectionOf("attention")).toBeNull();
    const up = sectionOf("upcoming");
    expect(up.querySelector('[data-role="upcoming-total"]').textContent).toMatch(/Total upcoming payments.*₱125,000\.00/s);
    expect(up.textContent).toMatch(/Grand Table Catering/);
    expect(sectionOf("rsvp").textContent).toMatch(/16 of 30 invited seats confirmed/);
    // Guest list by category (people), then Not set for guests without one.
    const cat = [...sectionOf("rsvp").querySelectorAll('[data-role="rsvp-categories"] tbody tr')].map((tr) => [tr.dataset.category, ...[...tr.cells].slice(1).map((c) => c.textContent)]);
    expect(cat).toEqual([["family", "0", "0", "8"], ["sponsors", "4", "0", "0"], ["unset", "12", "5", "1"]]);
    expect(sectionOf("suppliers").querySelector('[data-supplier="s1"]').textContent).toMatch(/₱100,000.00/);
    expect(sectionOf("tasks").querySelector('[data-count="overdue"] b').textContent).toBe("1");
  });
});

describe("Expenses page (Phase 10)", () => {
  it("owner and manager get the route; staff (no expenses.view) don't", () => {
    expect(buildRoutes(sessionFixture()).map((r) => r.path)).toContain("/expenses");
    expect(buildRoutes(sessionFixture({ roleTemplate: "manager" })).map((r) => r.path)).toContain("/expenses");
    expect(buildRoutes(sessionFixture({ roleTemplate: "staff" })).map((r) => r.path)).not.toContain("/expenses");
  });

  it("Luna Household (v3), Baby (15) and Bridal (16) each have Expenses as their own screen", () => {
    for (const t of ["household-payroll", "baby-expense", "bridal-expense"]) expect(buildRoutes(sessionFixture({ workspaceTemplateId: t })).map((r) => r.path), t).toContain("/expenses");
  });
});

describe("Household (Owner-pilot polish): one money card for this cutoff, Employee filter, compact list", () => {
  const summary = {
    today: "2026-10-16",
    totalToPay: 0,
    nextCutoff: null,
    overdueTotal: 0,
    pending: { attendance: 0, advances: 0, byStaff: [{ staffId: "s1", name: "Loriza Ibanez", items: { salaryConfirmation: 1, advanceConfirmation: 1 }, total: 2 }, { staffId: "s2", name: "Ana", items: { correction: 1 }, total: 1 }] },
    staff: [
      { staffId: "s1", name: "Loriza Ibanez", period: { start: "2026-10-01", end: "2026-10-15" }, estimatedNet: 556500, overdue: [], money: { salaryPaid: 556500, prepaid: 82200, stillToPay: 0, advancesOutstanding: 110000, advanceAvailable: 340000 }, confirmation: { state: "waiting" } },
      { staffId: "s2", name: "Ana", period: { start: "2026-10-01", end: "2026-10-15" }, estimatedNet: 300000, overdue: [], money: { salaryPaid: 0, prepaid: 0, stillToPay: 300000, advancesOutstanding: 0, advanceAvailable: null }, confirmation: null },
    ],
  };
  const fig = () => Object.fromEntries([...container.querySelectorAll('[data-role="money-summary"] dd')].map((dd) => [dd.dataset.k, dd.textContent]));

  it("Everyone: paid / still to pay / prepaid (inside paid, not added) / advances outstanding; attention grouped by helper; one short line each", async () => {
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary } : {}));
    await show(sessionFixture({ workspaceTemplateId: "household-payroll" }), {}, {}, { api });
    expect(container.querySelector('[data-role="cutoff"]').textContent).toBe("Oct 1–15");
    expect(fig()).toEqual({ salaryPaid: "₱5,565.00", stillToPay: "₱3,000.00", prepaid: "₱822.00", advancesOutstanding: "₱1,100.00" });
    expect(sectionOf("money").textContent).toMatch(/Prepaid salary\s*included in salary paid/);
    expect([...container.querySelectorAll('[data-role="hh-staff"] option')].map((o) => o.textContent)).toEqual(["Everyone", "Loriza Ibanez", "Ana"]);
    expect(container.querySelectorAll('[data-role="pending-by-helper"] li')).toHaveLength(2);
    const rows = [...container.querySelectorAll('[data-role="staff-pay"] li')];
    expect(rows[0].textContent.replace(/\s+/g, " ")).toMatch(/Loriza Ibanez\s*Paid ₱5,565\.00 · Prepaid ₱822\.00 Not yet confirmed ›/);
    expect(rows[0].querySelector("a").getAttribute("href")).toBe("/payroll?staff=s1");
    expect(rows[1].textContent.replace(/\s+/g, " ")).toMatch(/Ana\s*To pay ₱3,000\.00 so far[\s\S]*Not paid yet/);
    expect(container.querySelector('[data-role="give-advance"]').getAttribute("href")).toBe("/advances?give=1");
  });

  it("one helper selected: only that helper's numbers, attention items and line; Give advance preselects them", async () => {
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary: { ...summary, staff: summary.staff.map((s, i) => (i === 0 ? { ...s, confirmation: { state: "confirmed", at: "2026-10-15T03:00:00.000Z" } } : s)) } } : {}));
    await show(sessionFixture({ workspaceTemplateId: "household-payroll" }), {}, {}, { api });
    const pick = container.querySelector('[data-role="hh-staff"]');
    pick.value = "s1";
    pick.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(fig()).toEqual({ salaryPaid: "₱5,565.00", stillToPay: "₱0.00", prepaid: "₱822.00", advancesOutstanding: "₱1,100.00" });
    expect(container.querySelectorAll('[data-role="pending-by-helper"] li')).toHaveLength(1);
    expect([...container.querySelectorAll('[data-role="staff-pay"] li')]).toHaveLength(1);
    expect(container.querySelector('[data-role="confirmation"]').textContent).toMatch(/Confirmed by Loriza on Oct 15/);
    expect(container.querySelector('[data-role="give-advance"]').getAttribute("href")).toBe("/advances?give=1&staff=s1");
  });
});

describe("Household (Owner-pilot simplification): what needs attention, per helper", () => {
  it("only helpers with something: name, how many, what; a tap opens the right page focused on them", async () => {
    const summary = {
      today: "2026-10-12",
      totalToPay: 0,
      nextCutoff: null,
      overdueTotal: 0,
      pending: {
        attendance: 0,
        advances: 0,
        byStaff: [
          { staffId: "staffYanie0001", name: "Yanie", items: { correction: 1, salaryConfirmation: 1 }, total: 2 },
          { staffId: "staffRiza00001", name: "Riza", items: { advanceConfirmation: 1 }, total: 1 },
        ],
      },
      staff: [],
    };
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary } : {}));
    await show(sessionFixture({ workspaceTemplateId: "household-payroll" }), {}, {}, { api });
    expect(container.querySelector('[data-section="waiting"] .card-title').textContent).toBe("Needs your attention");
    const rows = [...container.querySelectorAll('[data-role="pending-by-helper"] .helper-pending-row')];
    expect(rows.map((r) => r.textContent.replace(/\s+/g, " ").trim())).toEqual(["YanieAttendance correction 1 · Salary not confirmed yet 1 2 items ›", "RizaAdvance not confirmed yet 1 1 item ›"]);
    expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/attendance?staff=staffYanie0001", "/advances?staff=staffRiza00001"]);
  });

  it("nothing needs attention: no box (no anonymous counts)", async () => {
    const summary = { today: "2026-10-12", totalToPay: 0, nextCutoff: null, overdueTotal: 0, pending: { attendance: 0, advances: 0, byStaff: [] }, staff: [] };
    await show(sessionFixture({ workspaceTemplateId: "household-payroll" }), {}, {}, { api: vi.fn(async () => ({ summary })) });
    expect(container.querySelector('[data-section="waiting"]')).toBeNull();
  });
});
