// @vitest-environment jsdom
// Phase 7.1 screen: one Edit -> Save for every order. Fulfilled orders open
// the same editor (plus a reason) for orders.correct holders; cancel and
// delete live under "⋯ More"; the activity log reads in plain language and
// shows cost corrections only to financial users. No "reverse / fix /
// COGS adjustment" buttons anywhere.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/orders/index.js";
import { historyRows } from "../../src/modules/orders/view.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

const wings = { lineId: "L1", productId: "prodWINGS0000000001", sku: "WINGS", name: "Chicken Wings", unit: "pcs", quantity: 10000, unitPrice: 7500, lineSubtotal: 75000 };
const correctedAt = new Date("2026-10-08T02:42:00Z");
const fulfilledOrder = {
  id: "order0000000000000009",
  orderNumber: "ORD-20261008-009",
  orderDate: "2026-10-08",
  source: "messenger",
  customer: { name: "Juan" },
  items: [{ ...wings, quantity: 8000, lineSubtotal: 60000 }],
  itemCount: 1,
  subtotal: 60000,
  discount: 0,
  total: 60000,
  amountPaid: 0,
  balance: 60000,
  paymentStatus: "unpaid",
  fulfillmentStatus: "fulfilled",
  revision: 3,
  statusHistory: [
    { type: "created", at: new Date("2026-10-08T01:00:00Z"), actor: { name: "Staff A" } },
    { type: "fulfilled", at: new Date("2026-10-08T02:00:00Z"), actor: { name: "Staff A" } },
    { type: "corrected", at: correctedAt, actor: { name: "Carlo" }, reason: "Encoded 10 by mistake", changes: { lines: [{ productId: wings.productId, sku: "WINGS", from: 10000, to: 8000, inventory: 2000 }], sales: { from: 75000, to: 60000 } } },
  ],
  createdBy: { name: "Staff A" },
  createdAt: new Date("2026-10-08T01:00:00Z"),
};
const pendingOrder = { ...fulfilledOrder, id: "order0000000000000010", orderNumber: "ORD-20261008-010", fulfillmentStatus: "pending", items: [wings], statusHistory: [fulfilledOrder.statusHistory[0]], revision: 1 };
const costs = { cogs: 40000, grossProfit: 20000, lines: [{ lineId: "L1", costConsumed: 40000 }], corrections: [{ at: correctedAt, actor: { name: "Carlo" }, reason: "Encoded 10 by mistake", before: { cogs: 50000, netSales: 75000 }, after: { cogs: 40000, netSales: 60000 } }] };

function deps() {
  const rows = [pendingOrder, fulfilledOrder];
  return {
    data: {
      listOrders: vi.fn(async () => ({ rows, hasMore: false })),
      getOrder: vi.fn(async (_b, id) => rows.find((o) => o.id === id)),
      getOrderCosts: vi.fn(async () => costs),
      getProducts: vi.fn(async () => ({ [wings.productId]: { id: wings.productId, available: 50000 } })),
    },
    searchProducts: vi.fn(async () => []),
    api: vi.fn(async () => ({ success: true })),
    toast: vi.fn(),
  };
}
const session = (role, overrides) => sessionFixture({ roleTemplate: role, permissions: overrides ? resolvePermissions(role, overrides) : undefined });
async function openDetail(s, id, d = deps()) {
  mount(container, s, d);
  await flush();
  container.querySelector(`[data-act="open"][data-id="${id}"]`).click();
  await flush();
  return { d, detail: document.querySelector('[data-role="detail"]') };
}
const footer = (detail) => [...detail.querySelectorAll(".modal-footer > button, .modal-footer > .menu-wrap > button")].map((b) => b.textContent.trim());

describe("Edit -> Save on a fulfilled order", () => {
  it("owner: same Edit button; the editor explains and asks for a reason; Save sends update + reason", async () => {
    const { d, detail } = await openDetail(session("owner"), fulfilledOrder.id);
    // Phase 8 adds "Record payment" while a balance remains.
    expect(footer(detail)).toEqual(["Record payment", "Edit", "Close"]);
    detail.querySelector('[data-act="edit"]').click();
    await flush();
    const form = document.querySelector(".modal-backdrop form");
    expect(form.querySelector('[data-role="correcting"]').textContent).toMatch(/corrects stock, sales and COGS automatically/);
    form.elements["qty-0"].value = "7";
    form.elements["qty-0"].dispatchEvent(new Event("input", { bubbles: true }));
    form.elements.reason.value = "Customer ordered 7, encoded 8";
    form.elements.reason.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api.mock.calls[0][1].body).toMatchObject({ action: "update", orderId: fulfilledOrder.id, expectedRevision: 3, reason: "Customer ordered 7, encoded 8", order: { items: [{ productId: wings.productId, quantity: 7000 }] } });
  });

  it("staff (no orders.correct): no Edit on a fulfilled order", async () => {
    const { detail } = await openDetail(session("staff"), fulfilledOrder.id);
    expect(footer(detail)).toEqual(["Record payment", "Close"]); // no Edit
  });

  it("no correction / reversal / COGS buttons exist anywhere", async () => {
    const { detail } = await openDetail(session("owner"), fulfilledOrder.id);
    expect(document.body.textContent).not.toMatch(/Fix Mistake|Reverse|Financial Correction|COGS Adjustment/i);
    expect(detail.querySelectorAll(".modal-footer button").length).toBeLessThanOrEqual(4);
  });
});

describe("activity log", () => {
  it("plain language: time • person • Qty changed 10 → 8, then the automatic consequences", () => {
    const rows = historyRows(fulfilledOrder, { timezone: "Asia/Manila" });
    const corrected = rows.find((r) => r.type === "corrected");
    expect(corrected.headline).toMatch(/Oct 8, 2026.*10:42.*AM • Carlo • WINGS: Qty changed 10 → 8 · Reason: Encoded 10 by mistake/);
    expect(corrected.effects).toEqual(["Inventory corrected +2 (WINGS)", "Sales adjusted ₱750.00 → ₱600.00"]);
    expect(JSON.stringify(rows)).not.toMatch(/COGS|cost/i);
  });

  it("financial users also see the COGS side; staff never request it", async () => {
    const owner = await openDetail(session("owner"), fulfilledOrder.id);
    expect(owner.detail.querySelector('[data-role="cost-corrections"]').textContent).toMatch(/COGS adjusted ₱500.00 → ₱400.00/);
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const staff = await openDetail(session("staff"), fulfilledOrder.id);
    expect(staff.detail.querySelector('[data-role="cost-corrections"]')).toBeNull();
    expect(staff.d.data.getOrderCosts).not.toHaveBeenCalled();
  });
});

describe("⋯ More holds cancel and delete for open orders", () => {
  it("owner: More menu with Cancel order and Delete order; Delete sends action delete", async () => {
    const { d, detail } = await openDetail(session("owner"), pendingOrder.id);
    expect(footer(detail)).toEqual(["⋯ More", "Record payment", "Edit", "Mark fulfilled", "Close"]);
    const menu = detail.querySelector('[data-role="more-menu"]');
    expect(menu.hidden).toBe(true);
    detail.querySelector('[data-act="more"]').click();
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Cancel order", "Delete order"]);
    menu.querySelector('[data-act="delete"]').click();
    await flush();
    const form = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    form.elements.reason.value = "Duplicate entry";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("orders", { method: "POST", body: { action: "delete", orderId: pendingOrder.id, reason: "Duplicate entry" } });
  });

  it("staff (no orders.cancel): no More menu; fulfilled orders never offer delete", async () => {
    const staff = await openDetail(session("staff"), pendingOrder.id);
    expect(staff.detail.querySelector('[data-act="more"]')).toBeNull();
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const owner = await openDetail(session("owner"), fulfilledOrder.id);
    expect(owner.detail.querySelector('[data-act="delete"]')).toBeNull();
  });

  it("the compact list row stays the same", async () => {
    mount(container, session("owner"), deps());
    await flush();
    const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    expect(headers).toEqual(["Order #", "Time", "Customer", "Items", "Total", "Reference", "Proof", "Payment", "Fulfillment", ""]);
    expect([...container.querySelectorAll(`[data-order="${fulfilledOrder.id}"] button`)].map((b) => b.textContent.trim())).toEqual(["View details"]);
  });
});
