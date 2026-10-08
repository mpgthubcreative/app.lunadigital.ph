// @vitest-environment jsdom
// Dashboard screen: honest empty states, values only from metric documents,
// financial cards only for dashboard.financials, the business-local date,
// and no reads beyond the planned documents.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/dashboard/index.js";
import { buildRoutes } from "../../src/app/routes.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const NOW = new Date("2026-10-07T16:30:00Z"); // 2026-10-08 00:30 in Manila
const card = (id) => container.querySelector(`[data-widget="${id}"]`);
const value = (id) => card(id)?.querySelector(".stat-value").textContent.trim();

async function show(session, docs = {}, lowStock = []) {
  const fetchDocuments = vi.fn(async (_bid, documents) =>
    Object.fromEntries(documents.map((d) => [d.source, docs[`${d.collection}/${d.id}`] ? { status: "ok", data: docs[`${d.collection}/${d.id}`] } : { status: "missing", data: null }]))
  );
  const fetchLists = vi.fn(async (_bid, widgets) => Object.fromEntries(widgets.map((w) => [w.id, { status: "ok", rows: w.id === "lowStockItems" ? lowStock : [] }])));
  mount(container, session, { fetchDocuments, fetchLists, now: NOW });
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
    // Expenses and Payments don't feed metrics yet: their figures (and the
    // profit that needs expenses) stay "No data yet" even though the
    // document holds numbers, rather than implying ₱0 of expenses.
    expect(value("operatingExpenses")).toBe("No data yet");
    expect(value("estimatedOperatingProfit")).toBe("No data yet");
    expect(value("paymentsReceived")).toBe("No data yet");
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
    expect(container.querySelector('[data-section="financial"]')).toBeNull();
    expect(card("netSales")).toBeNull();
    expect(value("ordersToday")).toBe("No data yet");
    const requested = fetch.mock.calls.flatMap((c) => c[1].map((d) => d.collection));
    expect(requested).not.toContain("financialMetrics");
  });

  it("staff granted dashboard.financials see the financial section", async () => {
    await show(sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { grant: ["dashboard.financials"] }) }));
    expect(card("netSales")).not.toBeNull();
  });

  it("a module off for the business removes its cards", async () => {
    await show(sessionFixture({ overrides: { modules: { expenses: false } } }));
    expect(card("operatingExpenses")).toBeNull();
    expect(card("estimatedOperatingProfit")).toBeNull();
    expect(card("netSales")).not.toBeNull();
  });

  it("the owner's dashboard reads exactly four documents", async () => {
    const fetch = await show(sessionFixture());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("demo-distributor-a");
    expect(fetch.mock.calls[0][1].map((d) => `${d.collection}/${d.id}`).sort()).toEqual(["financialMetrics/2026-10-08", "financialMetrics/current", "metrics/2026-10-08", "metrics/current"]);
  });
});

describe("business timezone", () => {
  it("00:30 in Manila is already the 8th: the header and documents use the local day", async () => {
    const fetch = await show(sessionFixture());
    expect(container.querySelector(".page-subtitle").textContent).toMatch(/Oct 8, 2026/);
    expect(fetch.mock.calls[0][1].some((d) => d.id === "2026-10-08")).toBe(true);
  });

  it("a business in another timezone gets its own date", async () => {
    const session = sessionFixture();
    session.business.timezone = "America/Los_Angeles";
    const fetch = await show(session);
    expect(fetch.mock.calls[0][1].some((d) => d.id === "2026-10-07")).toBe(true);
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

describe("Expenses has no page yet", () => {
  it("no /expenses route even for an owner entitled to it", () => {
    expect(buildRoutes(sessionFixture()).map((r) => r.path)).not.toContain("/expenses");
  });
});
