// @vitest-environment jsdom
// Example empty states for Distributor and Household (2026-10-25): while a
// page has no real record it shows a few example rows, each marked
// "Example", drawn on screen only. They are never sent to the server (no
// write, no ID), never part of a figure on the page, and they disappear as
// soon as a real record exists (or when a filter / search is active).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountOrders, ORDER_EXAMPLES } from "../../src/modules/orders/index.js";
import { mount as mountCustomers, CUSTOMER_EXAMPLES } from "../../src/modules/customers/index.js";
import { mount as mountInventory, PRODUCT_EXAMPLES } from "../../src/modules/inventory/index.js";
import { mount as mountPayments, PAYMENT_EXAMPLES } from "../../src/modules/payments/index.js";
import { mount as mountReports } from "../../src/modules/reports/index.js";
import { mount as mountStaff, STAFF_EXAMPLES } from "../../src/modules/household/index.js";
import { mount as mountAttendance } from "../../src/modules/attendance/index.js";
import { mount as mountPayroll, PAYROLL_EXAMPLES } from "../../src/modules/payroll/index.js";
import { mount as mountAdvances, ADVANCE_EXAMPLES } from "../../src/modules/advances/index.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const NOW = () => new Date("2026-10-25T04:00:00Z");
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const empty = { rows: [], hasMore: false };
const dist = (role = "owner") => sessionFixture({ roleTemplate: role, workspaceTemplateId: "distributor" });
const home = (role = "owner") => sessionFixture({ roleTemplate: role, workspaceTemplateId: "household-payroll" });
const ex = (role) => container.querySelector(`[data-role="${role}"]`);
const names = (role) => [...container.querySelectorAll(`[data-role="${role}"] [data-example] .wl-name`)].map((x) => x.textContent);
// Every example is marked, none can be opened, none has a record id.
function expectExamples(role, list) {
  const box = ex(role);
  expect(box, role).not.toBeNull();
  const rows = [...box.querySelectorAll("[data-example]")];
  expect(rows.map((r) => r.querySelector(".wl-name").textContent)).toEqual(list.map((x) => x.name));
  for (const r of rows) {
    expect(r.querySelector(".ex-tag").textContent).toBe("Example");
    expect(r.querySelector("button, a, input, select")).toBeNull();
    expect([...r.attributes].map((a) => a.name).filter((n) => /^data-(order|customer|product|payment|staff|payroll|advance|id)$/.test(n))).toEqual([]);
  }
}
// The data layer's write functions: never called by showing examples.
const WRITES = ["ordersApi", "customersApi", "productsApi", "inventoryApi", "paymentsApi", "staffApi", "setAttendance", "setAttendanceMany", "decideAttendanceMany", "advancesApi", "resolveCorrection"];
const writes = () => Object.fromEntries(WRITES.map((k) => [k, vi.fn(async () => ({}))]));
const noWrites = (d) => {
  for (const k of WRITES) expect(d[k], k).not.toHaveBeenCalled();
};

describe("Distributor: examples while a page is empty", () => {
  it("Orders: three example orders, no table, nothing written; a filter shows the plain message; a real order replaces them", async () => {
    const data = { listOrders: vi.fn(async () => empty), getProducts: vi.fn(async () => ({})), ...writes() };
    const api = vi.fn(async () => ({}));
    mountOrders(container, dist(), { data, api, toast: () => {} });
    await flush();
    expectExamples("order-examples", ORDER_EXAMPLES);
    expect(container.textContent).toMatch(/Maria's Mini Mart[\s\S]*₱950 balance[\s\S]*For fulfillment/);
    expect(container.querySelector('[data-role="orders"]')).toBeNull();
    expect(container.textContent).toMatch(/Tap \+ New order/);
    expect(api).not.toHaveBeenCalled();
    noWrites(data);
    // A real order: the examples are gone.
    container.replaceChildren();
    mountOrders(container, dist(), { data: { ...data, listOrders: vi.fn(async () => ({ rows: [{ id: "o1", orderNumber: "ORD-0001", customer: { name: "Aling Nena" }, items: [], total: 100000, paymentStatus: "unpaid", fulfillmentStatus: "new", createdAt: new Date() }], hasMore: false })) }, api, toast: () => {} });
    await flush();
    expect(ex("order-examples")).toBeNull();
  });
  it("Customers / Products: examples only when nothing exists at all (inactive records count; a search never shows examples)", async () => {
    const data = { listCustomers: vi.fn(async (_b, { status }) => (status === "inactive" ? empty : empty)), ...writes() };
    mountCustomers(container, dist(), { data, toast: () => {} });
    await flush();
    expectExamples("customer-examples", CUSTOMER_EXAMPLES);
    expect(container.textContent).toMatch(/Owes ₱950[\s\S]*No balance[\s\S]*Owes ₱1,850/);
    noWrites(data);
    container.replaceChildren();
    mountCustomers(container, dist(), { data: { ...data, listCustomers: vi.fn(async (_b, { status }) => (status === "inactive" ? { rows: [{ id: "c1", name: "Old buyer" }], hasMore: false } : empty)) }, toast: () => {} });
    await flush();
    expect(ex("customer-examples")).toBeNull();

    container.replaceChildren();
    const inv = { listProducts: vi.fn(async () => empty), loadCostDocs: vi.fn(async () => ({})), ...writes() };
    mountInventory(container, dist(), { data: inv, toast: () => {} });
    await flush();
    expectExamples("product-examples", PRODUCT_EXAMPLES);
    expect(container.textContent).toMatch(/Available 24[\s\S]*Available 8 · Low stock[\s\S]*Out of stock/);
    // No stock, no movement: only reads.
    expect(inv.listProducts.mock.calls.map(([, f]) => f.status)).toEqual(["active", "inactive"]);
    noWrites(inv);
    container.replaceChildren();
    mountInventory(container, dist(), { data: { ...inv, listProducts: vi.fn(async (_b, f) => (f.status === "inactive" ? { rows: [{ id: "p1" }], hasMore: false } : empty)) }, toast: () => {} });
    await flush();
    expect(ex("product-examples")).toBeNull();
  });
  it("Payments: GCash / bank transfer / partial examples on the full list only; Needs checking keeps its own message", async () => {
    const data = { listPayments: vi.fn(async () => empty), ...writes() };
    mountPayments(container, dist(), { data, toast: () => {}, now: NOW });
    await flush();
    expectExamples("payment-examples", PAYMENT_EXAMPLES);
    expect(container.textContent).toMatch(/GCash[\s\S]*Partial payment[\s\S]*Bank transfer/);
    // The real "today" line stays the real figure.
    expect(container.querySelector('[data-role="today"]')?.textContent ?? "").not.toMatch(/1,500|6,200|1,850/);
    container.querySelector('[data-seg="view"][data-value="check"]').click();
    await flush();
    expect(ex("payment-examples")).toBeNull();
    expect(container.textContent).toMatch(/Nothing to check/);
    noWrites(data);
  });
  it("Reports: no orders in the period → what this page will show, never example figures", async () => {
    const report = { access: { financials: true }, range: { from: "2026-10-01", to: "2026-10-25", granularity: "day" }, overview: { grossSales: 0, ordersCreated: 0, fulfilledOrders: 0, estimatedOperatingProfit: 0 }, series: [], skuMargins: null };
    mountReports(container, dist(), { api: vi.fn(async () => report), now: NOW });
    await flush();
    expect(container.querySelector('[data-role="report-empty"]')).not.toBeNull();
    // A brand-new workspace has no figures at all yet (null), same note.
    container.replaceChildren();
    mountReports(container, dist(), { api: vi.fn(async () => ({ ...report, overview: { ...report.overview, grossSales: null, ordersCreated: null } })), now: NOW });
    await flush();
    expect(container.querySelector('[data-role="report-empty"]').textContent).toMatch(/No orders in this period yet/);
    expect(container.querySelectorAll("[data-example]").length).toBe(0);
    container.replaceChildren();
    mountReports(container, dist(), { api: vi.fn(async () => ({ ...report, overview: { ...report.overview, grossSales: 500000, ordersCreated: 2 } })), now: NOW });
    await flush();
    expect(container.querySelector('[data-role="report-empty"]')).toBeNull();
  });
});

describe("Household: examples while a page is empty", () => {
  const hh = (o = {}) => ({ listStaff: vi.fn(async () => empty), activeStaff: vi.fn(async () => []), listAttendance: vi.fn(async () => empty), attendanceReview: vi.fn(async () => ({ corrections: [], requests: [], confirmation: null })), listAdvances: vi.fn(async () => empty), payrollApi: vi.fn(async (b) => (b.action === "period" ? { view: { periods: [], period: null, rows: [] } } : {})), ...writes(), ...o });
  it("Staff: two example helpers (Kasambahay, Yaya); inactive staff or a real helper → none", async () => {
    const data = hh();
    mountStaff(container, home(), { data, toast: () => {} });
    await flush();
    expectExamples("staff-examples", STAFF_EXAMPLES);
    expect(container.textContent).toMatch(/Kasambahay[\s\S]*Yaya/);
    expect(data.staffApi.mock.calls.every(([b]) => b.action === "settings")).toBe(true);
    container.replaceChildren();
    mountStaff(container, home(), { data: hh({ listStaff: vi.fn(async (_b, f) => (f.status === "inactive" ? { rows: [{ id: "s1", name: "Old" }], hasMore: false } : empty)) }), toast: () => {} });
    await flush();
    expect(ex("staff-examples")).toBeNull();
  });
  it("Attendance / Payroll / Advances: example rows only; nothing marked, no payroll made, nothing deducted", async () => {
    const data = hh();
    mountAttendance(container, home(), { data, toast: () => {}, now: NOW });
    await flush();
    expect(names("attendance-examples")).toEqual(["Maria Santos", "Ana Reyes", "Maria Santos"]);
    expect(ex("attendance-examples").textContent).toMatch(/Present[\s\S]*Rest Day/);
    container.replaceChildren();
    mountPayroll(container, home(), { data, toast: () => {}, now: NOW });
    await flush();
    expectExamples("payroll-examples", PAYROLL_EXAMPLES);
    expect(ex("payroll-examples").textContent).toMatch(/Basic pay ₱8,000 · Advance deduction −₱1,000[\s\S]*Net ₱7,000[\s\S]*Bonus ₱500[\s\S]*Net ₱9,500/);
    expect(ex("payroll-examples").textContent).toMatch(/GCash or a bank transfer, the screenshot[\s\S]*cash\? Your helper confirms/);
    expect(data.payrollApi.mock.calls.map(([b]) => b.action)).toEqual(["period"]);
    container.replaceChildren();
    mountAdvances(container, home(), { data, toast: () => {}, now: NOW });
    await flush();
    expectExamples("advance-examples", ADVANCE_EXAMPLES);
    expect(ex("advance-examples").textContent).toMatch(/Deduct next cutoff/);
    noWrites(data);
  });
});

describe("examples never become data", () => {
  it("no server code reads the example lists, so exports, usage, reports and totals can't include them", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const server = [...walk("netlify/functions"), ...walk("shared")].filter((f) => f.endsWith(".js"));
    for (const f of server) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/components\/examples\.js|_EXAMPLES\b|Maria's Mini Mart|Juan Store|Pork Tocino|Beef Tapa/);
    }
  });
});
