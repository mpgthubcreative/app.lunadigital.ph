// @vitest-environment jsdom
// Phase 11 screen: business-timezone presets drive GET /api/reports; the
// page only renders what the server returned (no money for non-financial
// users because the server never sent it); null = "No data yet"; CSV is
// formula-injection safe and gated by reports.export.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, toCsv, reportTables, NO_DATA } from "../../src/modules/reports/index.js";
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
  range: { from: "2026-10-01", to: "2026-10-09", granularity: "day" },
  access: { financials: true },
  overview: { ordersCreated: 2, fulfilledOrders: 2, cancelledOrders: 0, netSales: 1500000, cogs: 900000, grossProfit: 600000, grossMarginPct: 40, operatingExpenses: 150000, estimatedOperatingProfit: 450000, paymentsReceived: 1200000, averageOrderValue: 750000 },
  series: [{ period: "2026-10-08", ordersCreated: 2, fulfilledOrders: 2, netSales: 1500000, grossProfit: 600000, operatingExpenses: 150000, paymentsReceived: 1200000 }],
  payments: { methods: [{ method: "gcash", count: 1, amount: 1000000 }], unpaidOrdersNow: 1, unpaidBalanceNow: 300000 },
  products: { rows: [{ productId: "p1", sku: "WINGS", name: "=HYPERLINK(\"x\")", unit: "pcs", qty: 10000, netSales: 1000000, cogs: 600000, grossProfit: 400000 }], total: 1 },
  customers: { rows: [{ customerId: "c1", walkIn: false, name: "ABC Store", orders: 1, netSales: 1000000, outstandingBalanceNow: 0, lastOrderNumber: "BA-1" }, { customerId: null, walkIn: true, name: null, orders: 1, netSales: 500000, outstandingBalanceNow: null, lastOrderNumber: null }], total: 2 },
  expenses: { categories: [{ key: "packaging", count: 1, amount: 150000 }], methods: [{ key: "cash", count: 1, amount: 150000 }] },
  lowStock: [],
  sections: ["payments", "products", "customers", "expenses", "inventory"],
};
const OPS = {
  success: true,
  range: FIN.range,
  access: { financials: false },
  overview: { ordersCreated: 2, fulfilledOrders: 2, cancelledOrders: 0 },
  series: [{ period: "2026-10-08", ordersCreated: 2, fulfilledOrders: 2 }],
  payments: { methods: [{ method: "gcash", count: 1 }], unpaidOrdersNow: 1 },
  products: { rows: [{ productId: "p1", sku: "WINGS", name: "Wings", unit: "pcs", qty: 10000 }], total: 1 },
  sections: ["payments", "products"],
};

describe("Reports page", () => {
  it("presets use the business's today (Manila Oct 9 while UTC is Oct 8) and call the API with that range", async () => {
    const api = vi.fn(async () => FIN);
    mount(container, sessionFixture(), { api, now: NOW });
    await flush();
    expect(api).toHaveBeenCalledWith("reports?from=2026-10-01&to=2026-10-09");
    const sel = container.querySelector('select[name="preset"]');
    sel.value = "yesterday";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(api).toHaveBeenLastCalledWith("reports?from=2026-10-08&to=2026-10-08");
  });

  it("overview shows the server's figures, with Estimated (not net) operating profit", async () => {
    mount(container, sessionFixture(), { api: vi.fn(async () => FIN), now: NOW });
    await flush();
    const text = container.querySelector('[data-role="profit"]').textContent;
    expect(text).toMatch(/Net sales\s*₱15,000\.00.*COGS\s*₱9,000\.00.*Gross profit\s*₱6,000\.00.*Gross margin 40\.0%.*Operating expenses\s*₱1,500\.00.*Estimated operating profit\s*₱4,500\.00/s);
    const labels = [...container.querySelectorAll(".kpi-label")].map((l) => l.textContent);
    expect(labels).toContain("Estimated operating profit");
    expect(labels.join("|")).not.toMatch(/Net income|Net profit/i);
    expect(container.querySelector('[data-role="payments"]').textContent).toMatch(/Payments received\s*₱12,000\.00.*Unpaid balance \(now\)\s*₱3,000\.00/s);
  });

  it("a non-financial user sees counts only (the server sent no money)", async () => {
    mount(container, sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { grant: ["reports.view"] }) }), { api: vi.fn(async () => OPS), now: NOW });
    await flush();
    expect(container.querySelector('[data-role="profit"]')).toBeNull();
    expect(container.textContent).not.toMatch(/₱/);
    expect([...container.querySelectorAll('[data-role="tabs"] [data-act="tab"]')].map((b) => b.textContent.trim())).toEqual(["Overview", "Sales", "Products", "Payments"]);
  });

  it("tabs show compact tables; walk-ins are their own row", async () => {
    mount(container, sessionFixture(), { api: vi.fn(async () => FIN), now: NOW });
    await flush();
    container.querySelector('[data-tab="customers"]').click();
    const rows = [...container.querySelectorAll('table[data-table="customers"] tbody tr')].map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent.trim()));
    expect(rows).toEqual([["ABC Store", "1", "₱10,000.00", "₱0.00", "BA-1"], ["Walk-in orders", "1", "₱5,000.00", "—", "—"]]);
    container.querySelector('[data-tab="expenses"]').click();
    expect(container.querySelector('table[data-table="expenseCategories"]').textContent).toMatch(/Packaging.*1.*₱1,500\.00/s);
  });

  it("null from the server is 'No data yet', not ₱0", async () => {
    const empty = { ...FIN, overview: { ...FIN.overview, netSales: null, estimatedOperatingProfit: null }, products: { rows: null, total: 0 } };
    mount(container, sessionFixture(), { api: vi.fn(async () => empty), now: NOW });
    await flush();
    expect(container.querySelector('[data-role="profit"]').textContent).toMatch(new RegExp(`Net sales\\s*${NO_DATA}`));
    container.querySelector('[data-tab="products"]').click();
    expect(container.querySelector('[data-section="products"]').textContent).toMatch(/No data yet/);
  });

  it("CSV: reports.export only; formula-looking cells are neutralised", async () => {
    const download = vi.fn();
    mount(container, sessionFixture(), { api: vi.fn(async () => FIN), now: NOW, download });
    await flush();
    container.querySelector('[data-tab="products"]').click();
    container.querySelector('[data-act="csv"][data-table="products"]').click();
    const [name, text] = download.mock.calls[0];
    expect(name).toBe("luna-products-2026-10-01_to_2026-10-09.csv");
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(toCsv(["a"], [["+1"], ["-2"], ["@x"], ["ok"]])).toBe(`"a"\r\n"'+1"\r\n"'-2"\r\n"'@x"\r\n"ok"`);
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    mount(container, sessionFixture({ permissions: resolvePermissions("owner", { revoke: ["reports.export"] }) }), { api: vi.fn(async () => FIN), now: NOW, download });
    await flush();
    container.querySelector('[data-tab="products"]').click();
    expect(container.querySelector('[data-act="csv"]')).toBeNull();
  });

  it("an invalid custom range is caught before calling the API", async () => {
    const api = vi.fn(async () => FIN);
    mount(container, sessionFixture(), { api, now: NOW });
    await flush();
    const form = container.querySelector('[data-role="range"]');
    form.elements.from.value = "2026-10-08";
    form.elements.to.value = "2026-10-01";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/start date is after the end date/);
  });

  it("Overview tells the money story as charts: waterfall, sales split into COGS + gross profit, rankings, payments by method", async () => {
    const two = { ...FIN, series: [{ period: "2026-10-07", ordersCreated: 1, fulfilledOrders: 1, netSales: 500000, cogs: 300000, grossProfit: 200000 }, FIN.series[0]] };
    mount(container, sessionFixture(), { api: vi.fn(async () => two), now: NOW });
    await flush();
    const wf = container.querySelector('[data-chart="waterfall"]');
    expect(wf.querySelector("svg").getAttribute("aria-label")).toMatch(/Sales ₱15,000.00, COGS ₱9,000.00, Gross profit ₱6,000.00, Operating expenses ₱1,500.00, Est. op. profit ₱4,500.00/);
    expect(wf.textContent).toMatch(/Of every ₱100 of sales, ₱60 paid for the goods and ₱30 is left/);
    expect(container.querySelector('[data-chart="trend"] .chart svg').querySelectorAll("rect.fill-cost")).toHaveLength(2);
    expect(container.querySelector('[data-chart="products"]').textContent).toMatch(/₱10,000.00/);
    expect(container.querySelector('[data-chart="expenses"]').textContent).toMatch(/Packaging/);
    expect(container.querySelector('[data-chart="payments"]').textContent).toMatch(/GCash ₱10,000.00/);
    // "Details ›" opens the matching detailed table.
    container.querySelector('[data-chart="products"] [data-act="tab"]').click();
    expect(container.querySelector('table[data-table="products"]')).not.toBeNull();
  });

  it("charts never render money for a non-financial viewer", async () => {
    mount(container, sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { grant: ["reports.view"] }) }), { api: vi.fn(async () => OPS), now: NOW });
    await flush();
    expect(container.querySelector('[data-chart="waterfall"]')).toBeNull();
    expect(container.querySelector('[data-chart="trend"]')).toBeNull();
    expect(container.querySelector('[data-chart="products"]').textContent).toMatch(/Top products by quantity/);
    expect(container.textContent).not.toMatch(/₱/);
  });

  it("table definitions never include money columns without financials", () => {
    for (const t of reportTables(OPS)) expect(t.headers.join(" ")).not.toMatch(/Sales|COGS|profit|Amount|Total|balance/i);
  });
});
