// @vitest-environment jsdom
// Phase 12.5 screens: Filter -> View -> Download. Every list's "Download
// Excel" sends the filters the list has APPLIED (not page 2's cursor, not
// unapplied form edits) to POST /api/exports; who sees the button follows
// the export permission model; failures show the server's message.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountOrders } from "../../src/modules/orders/index.js";
import { mount as mountPayments } from "../../src/modules/payments/index.js";
import { mount as mountInventory } from "../../src/modules/inventory/index.js";
import { mount as mountCustomers } from "../../src/modules/customers/index.js";
import { mount as mountExpenses } from "../../src/modules/expenses/index.js";
import { mount as mountReports } from "../../src/modules/reports/index.js";
import { ApiError } from "../../src/lib/api.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { ordersQuery, productsQuery, expensesQuery, ID } from "../../shared/list-queries.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

const session = (role = "owner", overrides) => sessionFixture({ roleTemplate: role, permissions: overrides ? resolvePermissions(role, overrides) : undefined });
const exporter = () => {
  const download = vi.fn(async () => ({ blob: new Blob(["x"]), fileName: "Luna_X.xlsx", rows: 42 }));
  return { download, save: vi.fn() };
};
const page = (rows = [{ id: "r1" }], hasMore = true) => vi.fn(async () => ({ rows, hasMore }));
const submit = async (role, values) => {
  const form = container.querySelector(`[data-role="${role}"]`);
  for (const [k, v] of Object.entries(values)) form.elements[k].value = v;
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await flush();
};
const clickExport = async (dataset) => {
  container.querySelector(`[data-act="export"][data-export="${dataset}"]`).click();
  await flush();
};

describe("lists send their applied filters (all pages, not the current page)", () => {
  it("Orders: payment + fulfillment + date range; going to page 2 doesn't change the export", async () => {
    const ex = exporter();
    const toast = vi.fn();
    const listOrders = page([{ id: "o1", orderNumber: "ORD-1", customer: { name: "A" }, items: [], total: 0, paymentStatus: "paid", fulfillmentStatus: "fulfilled", createdAt: new Date() }]);
    mountOrders(container, session("manager"), { data: { listOrders }, toast, exportDeps: ex });
    await flush();
    await submit("filters", { paymentStatus: "paid", fulfillmentStatus: "fulfilled", from: "2026-10-01", to: "2026-10-31" });
    container.querySelector('[data-act="next"]')?.click();
    await flush();
    // An edit that wasn't applied isn't exported.
    container.querySelector('[data-role="filters"]').elements.source.value = "viber";
    await clickExport("orders");
    expect(ex.download).toHaveBeenCalledWith("exports", { dataset: "orders", filters: { paymentStatus: "paid", fulfillmentStatus: "fulfilled", from: "2026-10-01", to: "2026-10-31" } });
    expect(ex.save).toHaveBeenCalledWith("Luna_X.xlsx", expect.any(Blob));
    expect(toast).toHaveBeenCalledWith("Downloaded 42 rows.", "success");
    expect(container.querySelector('[data-role="export-hint"]').textContent).toMatch(/every row that matches these filters, not just this page/);
  });

  it("Orders: a reversed range is refused before anything is queried", async () => {
    const toast = vi.fn();
    const listOrders = page([], false);
    mountOrders(container, session(), { data: { listOrders }, toast, exportDeps: exporter() });
    await flush();
    await submit("filters", { from: "2026-10-31", to: "2026-10-01" });
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/valid date range/), "danger");
    expect(listOrders).toHaveBeenCalledTimes(1);
  });

  it("Payments: status, method, received-date range", async () => {
    const ex = exporter();
    mountPayments(container, session(), { data: { listPayments: page([], false) }, exportDeps: ex });
    await flush();
    await submit("filters", { state: "verified", method: "gcash", from: "2026-10-01", to: "2026-10-08" });
    await clickExport("payments");
    expect(ex.download).toHaveBeenCalledWith("exports", { dataset: "payments", filters: { state: "verified", method: "gcash", from: "2026-10-01", to: "2026-10-08" } });
  });

  it("Inventory: two downloads (product list, stock levels) with search / category / low stock", async () => {
    const ex = exporter();
    const listProducts = page([], false);
    mountInventory(container, session(), { data: { listProducts, loadCostDocs: vi.fn(async () => ({})) }, exportDeps: ex });
    await flush();
    await submit("filters", { search: "wi", category: "Frozen", low: "low" });
    expect(listProducts.mock.calls.at(-1)[1]).toMatchObject({ search: "wi", category: "Frozen", lowOnly: true });
    await clickExport("products");
    await clickExport("inventory");
    const want = { status: "active", lowOnly: true, search: "wi", category: "Frozen" };
    expect(ex.download.mock.calls.map((c) => c[1])).toEqual([{ dataset: "products", filters: want }, { dataset: "inventory", filters: want }]);
  });

  it("Customers: status + search", async () => {
    const ex = exporter();
    mountCustomers(container, session("manager"), { data: { listCustomers: page([], false) }, exportDeps: ex });
    await flush();
    await submit("filters", { search: "abc", status: "inactive" });
    await clickExport("customers");
    expect(ex.download).toHaveBeenCalledWith("exports", { dataset: "customers", filters: { status: "inactive", search: "abc" } });
  });

  it("Expenses: active only — no button while viewing removed expenses", async () => {
    const ex = exporter();
    mountExpenses(container, session(), { data: { listExpenses: page([], false) }, exportDeps: ex });
    await flush();
    await submit("filters", { category: "rent", from: "2026-10-01", to: "2026-10-31" });
    await clickExport("expenses");
    expect(ex.download).toHaveBeenCalledWith("exports", { dataset: "expenses", filters: { status: "active", category: "rent", from: "2026-10-01", to: "2026-10-31" } });
    await submit("filters", { status: "removed" });
    expect(container.querySelector('[data-act="export"]')).toBeNull();
  });

  it("Reports: one workbook for the range on screen; CSV downloads stay", async () => {
    const ex = exporter();
    const report = { success: true, range: { from: "2026-10-01", to: "2026-10-08", granularity: "day" }, access: { financials: true }, overview: { ordersCreated: 1, fulfilledOrders: 1, cancelledOrders: 0 }, series: [{ period: "2026-10-01", ordersCreated: 1, fulfilledOrders: 1 }], sections: [] };
    mountReports(container, session(), { api: vi.fn(async () => report), now: () => new Date("2026-10-08T06:00:00Z"), exportDeps: ex });
    await flush();
    await clickExport("reports");
    expect(ex.download).toHaveBeenCalledWith("exports", { dataset: "reports", filters: { from: "2026-10-01", to: "2026-10-08" } });
    container.querySelector('[data-act="tab"][data-tab="sales"]').click();
    expect(container.querySelector('[data-act="csv"]')).not.toBeNull();
  });
});

describe("who gets the button; errors are explained", () => {
  it("staff have no export permission: no buttons anywhere", async () => {
    mountOrders(container, session("staff"), { data: { listOrders: page([], false) } });
    mountPayments(container, session("staff"), { data: { listPayments: page([], false) } });
    mountInventory(container, session("staff"), { data: { listProducts: page([], false), loadCostDocs: vi.fn() } });
    mountCustomers(container, session("staff"), { data: { listCustomers: page([], false) } });
    await flush();
    expect(container.querySelector('[data-act="export"]')).toBeNull();
  });

  it("Reports: reports.export, not data.export, decides (Phase 11 behaviour)", async () => {
    const report = { success: true, range: { from: "2026-10-01", to: "2026-10-08", granularity: "day" }, access: { financials: false }, overview: {}, series: [], sections: [] };
    mountReports(container, session("manager", { revoke: ["data.export"] }), { api: vi.fn(async () => report), now: () => new Date("2026-10-08T06:00:00Z") });
    await flush();
    expect(container.querySelector('[data-export="reports"]')).not.toBeNull();
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    mountReports(container, session("manager", { revoke: ["reports.export"] }), { api: vi.fn(async () => report), now: () => new Date("2026-10-08T06:00:00Z") });
    await flush();
    expect(container.querySelector('[data-export="reports"]')).toBeNull();
  });

  it("too many rows: the server's message is shown and the button comes back", async () => {
    const toast = vi.fn();
    const download = vi.fn(async () => {
      throw new ApiError(413, "too-many-rows", "This export contains too many rows. Narrow your filters and try again.");
    });
    mountOrders(container, session(), { data: { listOrders: page([], false) }, toast, exportDeps: { download, save: vi.fn() } });
    await flush();
    await clickExport("orders");
    expect(toast).toHaveBeenCalledWith("This export contains too many rows. Narrow your filters and try again.", "danger");
    const btn = container.querySelector('[data-act="export"]');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Download Excel");
  });
});

describe("one query definition for the list and the export (shared/list-queries.js)", () => {
  it("orders: date range orders by order date then creation; a single day uses equality", () => {
    expect(ordersQuery({ paymentStatus: "paid", from: "2026-10-01", to: "2026-10-31" }).parts[0]).toEqual({
      where: [["paymentStatus", "==", "paid"], ["orderDate", ">=", "2026-10-01"], ["orderDate", "<=", "2026-10-31"]],
      orderBy: [["orderDate", "desc"], ["createdAt", "desc"]],
    });
    expect(ordersQuery({ from: "2026-10-08", to: "2026-10-08" }).parts[0].where).toEqual([["orderDate", "==", "2026-10-08"]]);
  });
  it("products: category is case-insensitive; id tiebreak; a search is name prefix OR exact SKU, filtered afterwards", () => {
    expect(productsQuery({ category: " Frozen " }).parts[0]).toEqual({ where: [["status", "==", "active"], ["categoryLower", "==", "frozen"]], orderBy: [["nameLower", "asc"], [ID, "asc"]] });
    const s = productsQuery({ search: "wi", lowOnly: true });
    expect(s.parts).toHaveLength(2);
    expect(s.keep({ status: "active", isLowStock: false })).toBe(false);
  });
  it("expenses: a search still honours category / method / dates", () => {
    const s = expensesQuery({ search: "land", category: "rent", from: "2026-10-01" });
    expect(s.keep({ category: "rent", date: "2026-10-02" })).toBe(true);
    expect(s.keep({ category: "rent", date: "2026-09-30" })).toBe(false);
    expect(s.keep({ category: "fuel", date: "2026-10-02" })).toBe(false);
  });
});
