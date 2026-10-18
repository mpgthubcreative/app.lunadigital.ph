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
import { mount as mountExportPage } from "../../src/modules/downloads/index.js";
import { buildRoutes } from "../../src/app/routes.js";
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

// Owner-pilot: Download Excel left the everyday screens. Every workspace has
// ONE customer download, More → Download Excel: one clean workbook
// (/api/workbook). The Master Backup is Luna Super Admin only (the console);
// Reports keeps its own workbook.
describe("More → Download Excel (every workspace)", () => {
  const NOW = () => new Date("2026-10-18T04:00:00Z");
  it("Business owner: ONE Download Excel button (no Master Backup, no single lists); This month by default", async () => {
    const toast = vi.fn();
    const download = vi.fn(async () => ({ blob: new Blob(["x"]), fileName: "Luna-Business-ABC-Oct-2026.xlsx", rows: 120 }));
    const save = vi.fn();
    mountExportPage(container, session(), { toast, download, save, now: NOW });
    expect(container.querySelector("h1").textContent).toBe("Download Excel");
    expect(container.querySelector('[data-act="backup"]')).toBeNull();
    expect(container.querySelectorAll("[data-download], [data-act=export]")).toHaveLength(0);
    expect([...container.querySelectorAll("button")].filter((b) => /Download/.test(b.textContent)).map((b) => b.textContent)).toEqual(["Download Excel"]);
    expect([...container.querySelectorAll('[data-seg="range"]')].map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["This month", "true"], ["Custom range", "false"], ["All records", "false"]]);
    expect(container.querySelector('[data-role="contents"]').textContent).toMatch(/Orders, Payments, Users, Inventory and Customers/);
    container.querySelector('[data-act="download"]').click();
    await flush();
    expect(download).toHaveBeenCalledWith("workbook", { range: "month" });
    expect(save).toHaveBeenCalledWith("Luna-Business-ABC-Oct-2026.xlsx", expect.any(Blob));
    expect(toast).toHaveBeenCalledWith("Excel file downloaded.", "success");
    // All records / a custom range.
    container.querySelector('[data-seg="range"][data-value="all"]').click();
    container.querySelector('[data-act="download"]').click();
    await flush();
    expect(download).toHaveBeenLastCalledWith("workbook", { range: "all" });
    container.querySelector('[data-seg="range"][data-value="custom"]').click();
    const from = container.querySelector('[data-role="from"]');
    from.value = "2026-09-01";
    from.dispatchEvent(new Event("change", { bubbles: true }));
    container.querySelector('[data-act="download"]').click();
    await flush();
    expect(download).toHaveBeenLastCalledWith("workbook", { range: "custom", from: "2026-09-01", to: "2026-10-18" });
    // The everyday lists still carry no download button.
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    mountOrders(container, session("manager"), { data: { listOrders: page([], false) } });
    mountPayments(container, session(), { data: { listPayments: page([], false) } });
    mountCustomers(container, session("manager"), { data: { listCustomers: page([], false) } });
    mountExpenses(container, session(), { data: { listExpenses: page([], false) } });
    await flush();
    expect(container.querySelector('[data-act="export"]')).toBeNull();
  });

  it("Bridal: the whole wedding, no range; Household: its sheets", async () => {
    const download = vi.fn(async () => ({ blob: new Blob(["x"]), fileName: "Luna-Bridal-Carlo-Yanie.xlsx", rows: 9 }));
    mountExportPage(container, sessionFixture({ workspaceTemplateId: "bridal-expense" }), { toast: () => {}, download, save: vi.fn(), now: NOW });
    expect(container.querySelector('[data-seg="range"]')).toBeNull();
    expect(container.querySelector('[data-role="contents"]').textContent).toMatch(/Money, Payments, Tasks, Guests, Party Members, Seating, Roles, Crew Meals, Music & Program and Wedding Setup/);
    container.querySelector('[data-act="download"]').click();
    await flush();
    expect(download).toHaveBeenCalledWith("workbook", {});
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    mountExportPage(container, sessionFixture({ workspaceTemplateId: "household-payroll" }), { toast: () => {}, download, save: vi.fn(), now: NOW });
    expect(container.querySelector('[data-role="contents"]').textContent).toMatch(/Expenses, Payroll, Payroll Breakdown, Attendance, Advances and Grocery List/);
    expect(container.querySelector('[data-seg="range"]')).not.toBeNull();
  });

  it("who sees the page: whoever may export (Owner, Admin); staff don't; labelled Download Excel in every workspace", () => {
    expect(buildRoutes(session("manager")).some((r) => r.path === "/export")).toBe(true);
    expect(buildRoutes(session("staff")).some((r) => r.path === "/export")).toBe(false);
    expect(buildRoutes(session("manager", { revoke: ["data.export"] })).some((r) => r.path === "/export")).toBe(false);
    expect(buildRoutes(session()).find((r) => r.path === "/export")).toMatchObject({ label: "Download Excel" });
    for (const w of ["household-payroll", "baby-expense", "bridal-expense"]) expect(buildRoutes(sessionFixture({ workspaceTemplateId: w })).find((r) => r.path === "/export"), w).toMatchObject({ label: "Download Excel" });
  });

  it("Orders: a reversed range is still refused before anything is queried", async () => {
    const toast = vi.fn();
    const listOrders = page([], false);
    mountOrders(container, session(), { data: { listOrders }, toast });
    await flush();
    await submit("filters", { from: "2026-10-31", to: "2026-10-01" });
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/valid date range/), "danger");
    expect(listOrders).toHaveBeenCalledTimes(1);
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
    const download = vi.fn(async () => {
      throw new ApiError(413, "too-many-rows", "This download has too many rows. Choose a shorter range and try again.");
    });
    mountExportPage(container, session(), { toast: vi.fn(), download, save: vi.fn() });
    container.querySelector('[data-act="download"]').click();
    await flush();
    expect(container.querySelector('[data-role="error"]').textContent).toBe("This download has too many rows. Choose a shorter range and try again.");
    const btn = container.querySelector('[data-act="download"]');
    expect([btn.disabled, btn.textContent]).toEqual([false, "Download Excel"]);
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
