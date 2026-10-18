// @vitest-environment jsdom
// Reports (Luna Business, Owner pilot 2026-10-19): a simple owner summary.
// Business-timezone presets drive GET /api/reports; the page shows exactly
// three totals (Total Sales, Total Net Sales, Total Net Margin), ONE Net
// Profit bar graph and one product table (Total Sales, Net Margin), and
// renders only what the server returned (no money for non-financial users).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, presetsFor, NO_DATA } from "../../src/modules/reports/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
// 23:30 on Oct 8 in UTC is already Oct 9 in Manila: the business day wins.
const NOW = () => new Date("2026-10-08T16:30:00Z");

const FIN = {
  success: true,
  range: { from: "2026-07-01", to: "2026-10-09", granularity: "month" },
  access: { financials: true },
  overview: { ordersCreated: 9, fulfilledOrders: 8, cancelledOrders: 0, grossSales: 8000000, discounts: 300000, returns: 0, netSales: 7700000, cogs: 4000000, grossProfit: 3700000, operatingExpenses: 1200000, estimatedOperatingProfit: 2500000, paymentsReceived: 7000000 },
  series: [
    { period: "2026-07", netProfit: 1800000 },
    { period: "2026-08", netProfit: 2400000 },
    { period: "2026-09", netProfit: -200000 },
    { period: "2026-10", netProfit: 3100000 },
  ],
  payments: { methods: [{ method: "gcash", count: 1, amount: 1000000 }], unpaidOrdersNow: 1, unpaidBalanceNow: 300000 },
  products: {
    rows: [
      { productId: "p1", sku: "KOPI", name: "Hayst Kopi", unit: "pcs", qty: 600000, netSales: 4500000, cogs: 2580000, grossProfit: 1920000 },
      { productId: "p2", sku: "CHOCO", name: "Hayst Choco", unit: "pcs", qty: 400000, netSales: 3200000, cogs: 1750000, grossProfit: 1450000 },
    ],
    total: 2,
  },
  customers: { rows: [], total: 0 },
  expenses: { categories: [], methods: [] },
  sections: ["payments", "products", "customers", "expenses"],
};
const OPS = { success: true, range: FIN.range, access: { financials: false }, overview: { ordersCreated: 9, fulfilledOrders: 8, cancelledOrders: 0 }, series: [{ period: "2026-10", ordersCreated: 2 }], products: { rows: [{ productId: "p1", name: "Hayst Kopi", qty: 1000 }], total: 1 }, sections: ["products"] };

describe("Reports page", () => {
  it("presets use the business's today (Manila Oct 9 while UTC is Oct 8); multi-month presets exist", async () => {
    const api = vi.fn(async () => FIN);
    mount(container, sessionFixture(), { api, now: NOW });
    await flush();
    expect(api).toHaveBeenCalledWith("reports?from=2026-10-01&to=2026-10-09");
    const sel = container.querySelector('select[name="preset"]');
    expect([...sel.options].map((o) => o.textContent)).toEqual(["This month", "Last month", "Last 3 months", "Last 6 months", "This year", "This week", "Today", "Custom dates"]);
    sel.value = "last6Months";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(api).toHaveBeenLastCalledWith("reports?from=2026-05-01&to=2026-10-09");
    expect(presetsFor("2026-10-09").thisYear).toMatchObject({ from: "2026-01-01", to: "2026-10-09" });
  });

  it("exactly three totals: Total Sales, Total Net Sales, Total Net Margin (= net sales − COGS − operating expenses); no other KPI cards", async () => {
    mount(container, sessionFixture(), { api: vi.fn(async () => FIN), now: NOW });
    await flush();
    const totals = [...container.querySelectorAll("[data-total]")].map((t) => [t.querySelector(".rp-label").textContent, t.querySelector(".rp-value").textContent]);
    expect(totals).toEqual([["Total Sales", "₱80,000.00"], ["Total Net Sales", "₱77,000.00"], ["Total Net Margin", "₱25,000.00"]]);
    expect(FIN.overview.netSales - FIN.overview.cogs - FIN.overview.operatingExpenses).toBe(FIN.overview.estimatedOperatingProfit);
    expect(container.querySelector('[data-total="net-margin"]').classList.contains("is-main")).toBe(true);
    expect(container.querySelectorAll(".kpi, .kpis")).toHaveLength(0);
  });

  it("ONE graph: Net Profit, one bar per month (a loss below the line); no other charts", async () => {
    mount(container, sessionFixture(), { api: vi.fn(async () => FIN), now: NOW });
    await flush();
    expect([...container.querySelectorAll("[data-chart]")].map((c) => c.dataset.chart)).toEqual(["net-profit"]);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    const svg = container.querySelector('[data-chart="net-profit"] svg');
    expect(svg.querySelectorAll("rect.fill-profit")).toHaveLength(3);
    expect(svg.querySelectorAll("rect.fill-loss")).toHaveLength(1);
    expect(svg.getAttribute("aria-label")).toMatch(/Jul ₱18,000\.00, Aug ₱24,000\.00, Sep -?₱-?2,000\.00, Oct ₱31,000\.00/);
    expect([...svg.querySelectorAll("text.chart-value")].map((t) => t.textContent)).toEqual(["₱18k", "₱24k", "−₱2k", "₱31k"]);
  });

  it("Products: one row each, Product | Total Sales | Net Margin, highest sales first", async () => {
    mount(container, sessionFixture(), { api: vi.fn(async () => FIN), now: NOW });
    await flush();
    const t = container.querySelector('[data-table="products"]');
    expect([...t.querySelectorAll("th")].map((h) => h.textContent)).toEqual(["Product", "Total Sales", "Net Margin"]);
    expect([...t.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((d) => d.textContent))).toEqual([
      ["Hayst Kopi", "₱45,000.00", "₱19,200.00"],
      ["Hayst Choco", "₱32,000.00", "₱14,500.00"],
    ]);
  });

  it("no tabs, CSV or extra downloads on the page (More → Download Excel is the one download)", async () => {
    mount(container, sessionFixture(), { api: vi.fn(async () => FIN), now: NOW });
    await flush();
    expect(container.querySelector('[data-role="tabs"], [data-act="csv"], [data-act="export"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Customers|Payments received|Download/);
  });

  it("null from the server is 'No data yet', not ₱0; an empty period says so", async () => {
    const r = { ...FIN, overview: { ...FIN.overview, grossSales: null, netSales: null, estimatedOperatingProfit: null }, series: [{ period: "2026-10", netProfit: null }], products: { rows: [], total: 0 } };
    mount(container, sessionFixture(), { api: vi.fn(async () => r), now: NOW });
    await flush();
    expect([...container.querySelectorAll(".rp-value")].map((v) => v.textContent)).toEqual([NO_DATA, NO_DATA, NO_DATA]);
    expect(container.querySelector('[data-chart="net-profit"]').textContent).toMatch(/No sales or costs recorded/);
    expect(container.querySelector('[data-section="products"]').textContent).toMatch(/No products sold/);
  });

  it("a member without sales figures sees no money (the server sent none)", async () => {
    mount(container, sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { grant: ["reports.view"] }) }), { api: vi.fn(async () => OPS), now: NOW });
    await flush();
    expect(container.querySelector('[data-role="totals"]')).toBeNull();
    expect(container.textContent).not.toMatch(/₱/);
    expect(container.textContent).toMatch(/Sales figures are for the Owner/);
  });
});
