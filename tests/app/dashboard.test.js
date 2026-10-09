// @vitest-environment jsdom
// Dashboard screen: honest empty states, values only from metric documents,
// financial cards only for dashboard.financials, the business-local date,
// and no reads beyond the planned documents.

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
const card = (id) => container.querySelector(`[data-widget="${id}"]`);
const value = (id) => card(id)?.querySelector(".stat-value").textContent.trim();

// Like data.js: every planned document id, combined (summed for a period).
const fakeFetch = (docs) =>
  vi.fn(async (_bid, documents) =>
    Object.fromEntries(
      documents.map((d) => {
        const data = combineDashboardDocs(d.source, d.ids.map((id) => docs[`${d.collection}/${id}`] ?? null));
        return [d.source, data ? { status: "ok", data } : { status: "missing", data: null }];
      })
    )
  );
async function show(session, docs = {}, lowStock = [], extra = {}) {
  const fetchDocuments = fakeFetch(docs);
  const fetchLists = vi.fn(async (_bid, widgets) => Object.fromEntries(widgets.map((w) => [w.id, { status: "ok", rows: w.id === "lowStockItems" ? lowStock : [] }])));
  mount(container, session, { fetchDocuments, fetchLists, now: NOW, ...extra });
  fetchDocuments.fetchLists = fetchLists;
  await flush();
  return fetchDocuments;
}

describe("no fabricated values", () => {
  it("with no metric documents every card says No data yet, and no peso amount appears", async () => {
    await show(sessionFixture());
    for (const id of ["netSales", "grossProfit", "operatingExpenses", "estimatedOperatingProfit", "ordersToday", "pendingFulfillment", "lowStock"]) {
      expect(value(id), id).toBe("No data yet");
    }
    expect(container.textContent).not.toMatch(/₱|PHP\s?\d/);
    expect(container.textContent).not.toMatch(/\b0\.00\b/);
  });

  it("lists without data sources stay empty states with no query; orders and low stock are queried", async () => {
    const fetch = await show(sessionFixture());
    expect(card("recentActivity").textContent).toMatch(/No data yet/);
    expect(card("lowStockItems").textContent).toMatch(/Nothing here/);
    expect(card("recentOrders").textContent).toMatch(/Nothing here/);
    for (const call of fetch.mock.calls) for (const d of call[1]) expect(["metrics", "financialMetrics"]).toContain(d.collection);
    expect(fetch.fetchLists.mock.calls[0][1].map((w) => w.id)).toEqual(["recentOrders", "lowStockItems"]);
  });

  it("shows real low-stock products (quantities only, no costs)", async () => {
    await show(sessionFixture(), {}, [{ id: "p1", sku: "RICE-25", name: "Rice 25kg", unit: "sack", available: 3000, reorderLevel: 5000, isLowStock: true }]);
    const text = card("lowStockItems").textContent;
    expect(text).toMatch(/Rice 25kg/);
    expect(text).toMatch(/3 sack available · reorder at 5/);
    expect(text).not.toMatch(/₱/);
  });
});

describe("values come from the documents through shared/finance.js", () => {
  it("renders computed figures in centavos-correct pesos", async () => {
    await show(sessionFixture(), {
      "financialMetrics/2026-10-08": { grossSales: 1234550, discounts: 34550, returns: 0, cogs: 700000, operatingExpenses: 150000, paymentsReceived: 900000 },
      "financialMetrics/current": { receivablesOutstanding: 300000 },
      "metrics/2026-10-08": { orderCount: 12, fulfilledOrders: 3, cancelledOrders: 1 },
      "metrics/current": { pendingFulfillment: 4, unpaidOrders: 2, lowStockProducts: 5 },
    });
    expect(value("netSales")).toBe("₱12,000.00");
    expect(value("grossProfit")).toBe("₱5,000.00");
    // Expenses feed metrics since Phase 10: Operating expenses and the
    // Estimated operating profit (gross profit − expenses) are real.
    expect(value("operatingExpenses")).toBe("₱1,500.00");
    expect(value("estimatedOperatingProfit")).toBe("₱3,500.00");
    // Payments feed metrics since Phase 8: "Paid today" is real.
    expect(value("paymentsReceived")).toBe("₱9,000.00");
    expect(value("receivablesOutstanding")).toBe("₱3,000.00");
    expect(value("ordersToday")).toBe("12");
    expect(value("pendingFulfillment")).toBe("4");
  });

  it("a component that is missing makes its dependents No data yet, not a wrong number", async () => {
    await show(sessionFixture(), { "financialMetrics/2026-10-08": { grossSales: 100000, discounts: 0, returns: 0 } });
    expect(value("netSales")).toBe("₱1,000.00");
    expect(value("grossProfit")).toBe("No data yet");
    expect(value("estimatedOperatingProfit")).toBe("No data yet");
  });

  it("explains what the estimate excludes", async () => {
    await show(sessionFixture());
    expect(card("estimatedOperatingProfit").querySelector(".stat-note").textContent).toMatch(/taxes, depreciation, financing costs/);
    // No figure is labelled net income / net profit (the note may say what it isn't).
    const labels = [...container.querySelectorAll(".stat-label, .card-title, .section-title")].map((el) => el.textContent).join(" | ");
    expect(labels).not.toMatch(/net income|net profit/i);
  });

  it("a read error shows Couldn't load on just the affected cards", async () => {
    mount(container, sessionFixture(), {
      now: NOW,
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
    expect(card("netSales")).toBeNull();
    expect(card("receivablesOutstanding")).toBeNull();
    expect(container.textContent).not.toMatch(/₱/);
    expect(value("ordersToday")).toBe("No data yet");
    const requested = fetch.mock.calls.flatMap((c) => c[1].map((d) => d.collection));
    expect(requested).not.toContain("financialMetrics");
  });

  it("staff granted dashboard.financials see the financial section", async () => {
    await show(sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { grant: ["dashboard.financials"] }) }));
    expect(card("netSales")).not.toBeNull();
  });

  it("a module off for the business removes its cards", async () => {
    await show(sessionFixture({ overrides: { modules: { inventory: false } } }));
    expect(card("grossProfit")).toBeNull();
    expect(card("lowStock")).toBeNull();
    expect(card("netSales")).not.toBeNull();
  });

  it("Distributor: Expenses is operational (v3); a day with activity but no expenses shows ₱0, not 'No data yet'", async () => {
    const s = sessionFixture();
    expect(s.entitlements.modules.expenses).toBe(true);
    await show(s, { "financialMetrics/2026-10-08": { grossSales: 1000000, discounts: 0, returns: 0, cogs: 600000, operatingExpenses: 0, paymentsReceived: 0 } });
    expect(value("operatingExpenses")).toBe("₱0.00");
    expect(value("estimatedOperatingProfit")).toBe("₱4,000.00");
  });

  it("the owner's dashboard for Today reads exactly four documents", async () => {
    const fetch = await show(sessionFixture());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("demo-distributor-a");
    expect(fetch.mock.calls[0][1].flatMap((d) => d.ids.map((id) => `${d.collection}/${id}`)).sort()).toEqual(["financialMetrics/2026-10-08", "financialMetrics/current", "metrics/2026-10-08", "metrics/current"]);
  });
});

describe("business timezone", () => {
  it("00:30 in Manila is already the 8th: the header and documents use the local day", async () => {
    const fetch = await show(sessionFixture());
    expect(container.querySelector('[data-section="period"] .section-title').textContent).toMatch(/Today, Oct 8, 2026/);
    expect(fetch.mock.calls[0][1].some((d) => d.ids.includes("2026-10-08"))).toBe(true);
  });

  it("a business in another timezone gets its own date", async () => {
    const session = sessionFixture();
    session.business.timezone = "America/Los_Angeles";
    const fetch = await show(session);
    expect(fetch.mock.calls[0][1].some((d) => d.ids.includes("2026-10-07"))).toBe(true);
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

describe("period filter (Phase 12.5): Selected period vs Current operations", () => {
  const DOCS = {
    "financialMetrics/2026-10-07": { grossSales: 200000, discounts: 0, returns: 0, cogs: 120000, operatingExpenses: 0, paymentsReceived: 50000 },
    "financialMetrics/2026-10-08": { grossSales: 1000000, discounts: 0, returns: 0, cogs: 600000, operatingExpenses: 150000, paymentsReceived: 900000 },
    "financialMetrics/current": { receivablesOutstanding: 300000 },
    "metrics/2026-10-07": { orderCount: 2, fulfilledOrders: 2, cancelledOrders: 0 },
    "metrics/2026-10-08": { orderCount: 12, fulfilledOrders: 3, cancelledOrders: 1 },
    "metrics/current": { pendingFulfillment: 4, unpaidOrders: 2, lowStockProducts: 5 },
  };
  const choose = async (preset) => {
    const sel = container.querySelector('select[name="preset"]');
    sel.value = preset;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  };

  it("labels: period cards under Selected period, live gauges under Current operations (as of now)", async () => {
    await show(sessionFixture(), DOCS);
    const period = container.querySelector('[data-section="period"]');
    const current = container.querySelector('[data-section="current"]');
    expect(period.querySelector(".section-title").textContent).toMatch(/Selected period · Today/);
    expect(current.querySelector(".section-title").textContent).toMatch(/Current operations · as of now/);
    expect([...period.querySelectorAll("[data-widget]")].map((e) => e.dataset.widget)).toEqual(["netSales", "cogs", "grossProfit", "operatingExpenses", "estimatedOperatingProfit", "paymentsReceived", "ordersToday"]);
    expect([...current.querySelectorAll("[data-widget]")].map((e) => e.dataset.widget)).toEqual(["receivablesOutstanding", "unpaidOrders", "pendingFulfillment", "lowStock"]);
    expect(value("cogs")).toBe("₱6,000.00");
  });

  it("Yesterday / This week change the period figures; current gauges stay the same", async () => {
    const fetch = await show(sessionFixture(), DOCS);
    await choose("yesterday");
    expect(fetch.mock.calls.at(-1)[1].find((d) => d.source === "financial-day").ids).toEqual(["2026-10-07"]);
    expect(value("netSales")).toBe("₱2,000.00");
    expect(value("ordersToday")).toBe("2");
    expect(value("receivablesOutstanding")).toBe("₱3,000.00");
    expect(value("lowStock")).toBe("5");
    await choose("thisWeek"); // Mon Oct 5 .. Thu Oct 8
    expect(fetch.mock.calls.at(-1)[1].find((d) => d.source === "operational-day").ids).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(value("netSales")).toBe("₱12,000.00");
    expect(value("ordersToday")).toBe("14");
    expect(fetch.mock.calls.at(-1)[1].find((d) => d.source === "operational-current").ids).toEqual(["current"]);
  });

  it("Last month with no summaries says No data yet (never ₱0); current gauges unchanged", async () => {
    await show(sessionFixture(), DOCS);
    await choose("lastMonth");
    expect(container.querySelector('[data-section="period"] .section-title').textContent).toMatch(/Last month, Sep 1, 2026 – Sep 30, 2026/);
    expect(value("netSales")).toBe("No data yet");
    expect(value("ordersToday")).toBe("No data yet");
    expect(value("receivablesOutstanding")).toBe("₱3,000.00");
  });

  it("custom: inclusive, business-local; future ranges are refused", async () => {
    const toast = vi.fn();
    const fetch = await show(sessionFixture(), DOCS, [], { toast });
    const form = container.querySelector('[data-role="period"]');
    form.elements.from.value = "2026-10-07";
    form.elements.to.value = "2026-10-08";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(value("netSales")).toBe("₱12,000.00");
    const calls = fetch.mock.calls.length;
    const form2 = container.querySelector('[data-role="period"]');
    form2.elements.from.value = "2026-10-07";
    form2.elements.to.value = "2026-10-09";
    form2.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/after today/), "danger");
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("Download Excel sends the period on screen; staff (no data.export) get no button", async () => {
    const download = vi.fn(async () => ({ blob: new Blob(["x"]), fileName: "Luna_Dashboard_2026-10-07.xlsx", rows: 3 }));
    const save = vi.fn();
    await show(sessionFixture(), DOCS, [], { exportDeps: { download, save } });
    await choose("yesterday");
    container.querySelector('[data-act="export"]').click();
    await flush();
    expect(download).toHaveBeenCalledWith("exports", { dataset: "dashboard", filters: { from: "2026-10-07", to: "2026-10-07" } });
    expect(save).toHaveBeenCalledWith("Luna_Dashboard_2026-10-07.xlsx", expect.any(Blob));
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    await show(sessionFixture({ roleTemplate: "staff" }));
    expect(container.querySelector('[data-act="export"]')).toBeNull();
  });
});
