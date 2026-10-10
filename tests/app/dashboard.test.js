// @vitest-environment jsdom
// Dashboard = Monitor (Phase 18.5). Honest empty states, values only from
// metric documents / small list queries, money only for dashboard.financials,
// the business-local date, no reads beyond the planned documents, and no
// profitability analysis (that lives in Reports). Each workspace layout
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

describe("Distributor: the store pulse", () => {
  it("top figures: Total sales, Total orders (with fulfilled), Unpaid (balance + count, as of now)", async () => {
    await show(sessionFixture(), DOCS);
    expect([...container.querySelectorAll('[data-role="kpis"] [data-widget]')].map((e) => e.dataset.widget)).toEqual(["netSales", "ordersToday", "receivablesOutstanding"]);
    expect(value("netSales")).toBe("₱12,000.00");
    expect(value("ordersToday")).toBe("12");
    expect(widget("ordersToday").textContent).toMatch(/3 fulfilled/);
    expect(value("receivablesOutstanding")).toBe("₱3,000.00");
    expect(widget("receivablesOutstanding").textContent).toMatch(/2 orders · as of now/);
  });

  it("profitability is NOT on the Dashboard (it lives in Reports)", async () => {
    const fetch = await show(sessionFixture(), DOCS);
    for (const id of ["cogs", "grossProfit", "operatingExpenses", "estimatedOperatingProfit", "paymentsReceived"]) expect(widget(id), id).toBeNull();
    expect(container.textContent).not.toMatch(/COGS|Gross profit|Operating profit|Gross margin/i);
    // The sales figure still comes from the same financial day documents as Reports.
    expect(fetch.mock.calls[0][1].find((d) => d.source === "financial-day").ids).toEqual(["2026-10-08"]);
  });

  it("with no metric documents every figure says No data yet, and no peso amount appears", async () => {
    await show(sessionFixture());
    for (const id of ["netSales", "ordersToday", "receivablesOutstanding"]) expect(value(id), id).toBe("No data yet");
    expect(container.textContent).not.toMatch(/₱|PHP\s?\d/);
    expect(container.textContent).not.toMatch(/\b0\.00\b/);
  });

  it("Needs attention lists only real items, each linking to where the work happens", async () => {
    await show(sessionFixture(), DOCS, { lowStockItems: [RICE] }, {}, { "count:paymentsToVerify": 3, "count:ordersReady": 6, "count:ordersPending": 0 });
    const items = [...sectionOf("attention").querySelectorAll("[data-attention]")];
    expect(items.map((li) => li.dataset.attention)).toEqual(["verify", "lowStock", "ready"]);
    expect(items[0].textContent).toMatch(/3 payments need verification/);
    expect(items[0].querySelector("a").getAttribute("href")).toBe("/payments?state=for_verification");
    expect(items[1].textContent).toMatch(/5 SKUs are low in stock.*Rice 25kg/s);
    expect(items[2].querySelector("a").getAttribute("href")).toBe("/orders?fulfillmentStatus=ready");
  });

  it("nothing waiting = All clear (never a fabricated 0 item)", async () => {
    await show(sessionFixture(), { "metrics/current": { pendingFulfillment: 0, unpaidOrders: 0, lowStockProducts: 0 } });
    expect(sectionOf("attention").querySelector('[data-role="all-clear"]')).not.toBeNull();
    expect(sectionOf("attention").querySelectorAll("[data-attention]")).toHaveLength(0);
  });

  it("order status: live counts per stage + fulfilled in the period", async () => {
    await show(sessionFixture(), DOCS, {}, {}, { "count:ordersPending": 12, "count:ordersPreparing": 8, "count:ordersReady": 6 });
    const tiles = Object.fromEntries([...sectionOf("orders").querySelectorAll("[data-count]")].map((t) => [t.dataset.count, t.querySelector("b").textContent]));
    expect(tiles).toEqual({ pending: "12", preparing: "8", ready: "6", fulfilled: "3" });
  });

  it("inventory summary: quantities and status only, never costs; links to Inventory", async () => {
    await show(sessionFixture(), DOCS, { inventorySummary: [RICE] });
    const inv = sectionOf("inventory");
    expect(inv.textContent).toMatch(/Rice 25kg/);
    expect(inv.querySelector('[data-product="p1"]').textContent).toMatch(/3 sack/);
    expect(inv.textContent).toMatch(/Low/);
    expect(inv.textContent).not.toMatch(/₱/);
    expect(inv.querySelector(".link-more").getAttribute("href")).toBe("/inventory");
  });

  it("recent orders keep the inline Fulfillment ▾ / Payment ▾ controls (same engine as Orders)", async () => {
    const api = vi.fn(async () => ({ success: true }));
    const fetch = await show(sessionFixture(), DOCS, { recentOrders: [ORDER] }, { api, toast: vi.fn() });
    const sel = container.querySelector('select[data-act="fulfillment"][data-id="o1"]');
    expect(container.querySelector('select[data-act="payment"][data-id="o1"]')).not.toBeNull();
    sel.value = "ready";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(api).toHaveBeenCalledWith("orders", { method: "POST", body: { action: "stage", orderId: "o1", stage: "ready" } });
    expect(fetch.fetchLists).toHaveBeenCalledTimes(2); // refreshed after the change
  });

  it("lists: one small query each (inventory summary, recent orders, low stock)", async () => {
    const fetch = await show(sessionFixture());
    expect(fetch.fetchLists.mock.calls[0][1].map((w) => w.id)).toEqual(["inventorySummary", "recentOrders", "lowStockItems"]);
    expect(sectionOf("orders").textContent).toMatch(/No orders yet/);
  });

  it("a read error shows Couldn't load on just the affected figures", async () => {
    mount(container, sessionFixture(), {
      now: NOW,
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
    const fetch = await show(sessionFixture({ roleTemplate: "staff" }));
    expect(widget("netSales")).toBeNull();
    expect(widget("receivablesOutstanding")).toBeNull();
    expect(container.textContent).not.toMatch(/₱/);
    expect(value("ordersToday")).toBe("No data yet");
    const requested = fetch.mock.calls.flatMap((c) => c[1].map((d) => d.collection));
    expect(requested).not.toContain("financialMetrics");
  });

  it("staff granted dashboard.financials see Total sales", async () => {
    await show(sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { grant: ["dashboard.financials"] }) }));
    expect(widget("netSales")).not.toBeNull();
  });

  it("a module off for the business removes what depends on it", async () => {
    await show(sessionFixture({ overrides: { modules: { inventory: false } } }), DOCS);
    expect(sectionOf("inventory")).toBeNull();
    expect(container.querySelector('[data-attention="lowStock"]')).toBeNull();
    expect(widget("netSales")).not.toBeNull();
  });

  it("the owner's dashboard for Today reads exactly four documents plus four live counts", async () => {
    const fetch = await show(sessionFixture());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("demo-distributor-a");
    const plan = fetch.mock.calls[0][1];
    expect(plan.filter((d) => !d.count).flatMap((d) => d.ids.map((id) => `${d.collection}/${id}`)).sort()).toEqual(["financialMetrics/2026-10-08", "financialMetrics/current", "metrics/2026-10-08", "metrics/current"]);
    expect(plan.filter((d) => d.count).map((d) => `${d.collection}:${d.where.map((w) => w.join("")).join()}`).sort()).toEqual(["orders:fulfillmentStatus==pending", "orders:fulfillmentStatus==preparing", "orders:fulfillmentStatus==ready", "payments:state==for_verification"]);
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

  it("Yesterday / This week change the period figures; Unpaid (as of now) stays the same", async () => {
    const fetch = await show(sessionFixture(), DOCS);
    await choose("yesterday");
    expect(fetch.mock.calls.at(-1)[1].find((d) => d.source === "financial-day").ids).toEqual(["2026-10-07"]);
    expect(value("netSales")).toBe("₱2,000.00");
    expect(value("ordersToday")).toBe("2");
    expect(value("receivablesOutstanding")).toBe("₱3,000.00");
    await choose("thisWeek"); // Mon Oct 5 .. Thu Oct 8
    expect(fetch.mock.calls.at(-1)[1].find((d) => d.source === "operational-day").ids).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(value("ordersToday")).toBe("14");
    expect(fetch.mock.calls.at(-1)[1].find((d) => d.source === "operational-current").ids).toEqual(["current"]);
  });

  it("Last month with no summaries says No data yet (never ₱0); the header names the range", async () => {
    await show(sessionFixture(), DOCS);
    await choose("lastMonth");
    expect(container.querySelector(".page-subtitle").textContent).toMatch(/Last month: Sep 1, 2026 – Sep 30, 2026/);
    expect(value("netSales")).toBe("No data yet");
    expect(value("ordersToday")).toBe("No data yet");
    expect(value("receivablesOutstanding")).toBe("₱3,000.00");
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

  it("Download Excel (a quiet secondary action) sends the period on screen; staff (no data.export) get no button", async () => {
    const download = vi.fn(async () => ({ blob: new Blob(["x"]), fileName: "Luna_Dashboard_2026-10-07.xlsx", rows: 3 }));
    const save = vi.fn();
    await show(sessionFixture(), DOCS, {}, { exportDeps: { download, save } });
    await choose("yesterday");
    const btn = container.querySelector('[data-act="export"]');
    expect(btn.classList.contains("btn-ghost")).toBe(true);
    btn.click();
    await flush();
    expect(download).toHaveBeenCalledWith("exports", { dataset: "dashboard", filters: { from: "2026-10-07", to: "2026-10-07" } });
    expect(save).toHaveBeenCalledWith("Luna_Dashboard_2026-10-07.xlsx", expect.any(Blob));
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    await show(sessionFixture({ roleTemplate: "staff" }));
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
      rsvpSummary: [{ id: "attending", row: "attending", invitations: 12, invitedSeats: 30, attending: 7, attendingSeats: 16, declined: 2, declinedSeats: 5, awaiting: 3, awaitingSeats: 9 }],
      supplierSummary: [{ id: "s1", name: "Grand Table Catering", agreedAmount: 15000000, paid: 5000000, balance: 10000000 }],
    }, {}, { "count:weddingOverdueTasks": 1 });
    expect(value("weddingRemaining")).toBe("₱315,500.00");
    expect(sectionOf("attention")).toBeNull();
    const up = sectionOf("upcoming");
    expect(up.querySelector('[data-role="upcoming-total"]').textContent).toMatch(/Total upcoming payments.*₱125,000\.00/s);
    expect(up.textContent).toMatch(/Grand Table Catering/);
    expect(sectionOf("rsvp").textContent).toMatch(/16 of 30 invited seats confirmed/);
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

  it("household never gets it, even with the permission; Baby (15) and Bridal (16) have it as their own Expenses", () => {
    expect(buildRoutes(sessionFixture({ workspaceTemplateId: "household-payroll" })).map((r) => r.path)).not.toContain("/expenses");
    for (const t of ["baby-expense", "bridal-expense"]) expect(buildRoutes(sessionFixture({ workspaceTemplateId: t })).map((r) => r.path), t).toContain("/expenses");
  });
});

describe("Household (Phase 18.6): total salary to pay at the next cutoff, per person", () => {
  it("shows the server's total, one row per person, and what's waiting for the Owner", async () => {
    const summary = {
      today: "2026-12-18",
      totalToPay: 260000,
      nextCutoff: "2026-12-31",
      overdueTotal: 0,
      pending: { attendance: 2, advances: 1 },
      staff: [
        { staffId: "s1", name: "Lito", period: { start: "2026-12-16", end: "2026-12-31" }, prepared: false, estimatedNet: 80000, advanceToDeduct: 40000, payment: "not_paid", overdue: [], lastSalary: null },
        { staffId: "s2", name: "Maria", period: { start: "2026-12-16", end: "2026-12-31" }, prepared: false, estimatedNet: 180000, advanceToDeduct: 0, payment: "not_paid", overdue: [], lastSalary: { receipt: "waiting", netPay: 600000 } },
      ],
    };
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary } : {}));
    await show(sessionFixture({ workspaceTemplateId: "household-payroll" }), {}, {}, { api });
    expect(api).toHaveBeenCalledWith("household-summary");
    expect(container.querySelector('[data-role="total-to-pay"]').textContent).toBe("₱2,600.00");
    expect(sectionOf("to-pay").textContent).toMatch(/next cutoff Dec 31/);
    const rows = [...container.querySelectorAll('[data-role="staff-pay"] tbody tr')];
    expect(rows.map((r) => r.querySelector('[data-col="net"] strong').textContent)).toEqual(["₱800.00", "₱1,800.00"]);
    expect(rows[0].querySelector('[data-col="advance"]').textContent).toBe("₱400.00");
    expect(rows[1].querySelector('[data-col="last"]').textContent).toBe("Not confirmed");
    expect(container.querySelector('[data-role="waiting-attendance"]').textContent).toMatch(/2 attendance \/ leave requests/);
    expect(container.querySelector('[data-role="waiting-advances"]').textContent).toMatch(/1 advance request/);
  });
});
