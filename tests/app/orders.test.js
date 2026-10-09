// @vitest-environment jsdom
// Orders screen: the fast new-order flow (sends ids + scaled quantities +
// one idempotency key, never prices or totals), discount only with
// orders.discount, actions per permission, COGS only for
// dashboard.financials, filters and pagination.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/orders/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const Q = (n) => n * 1000;
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

const wings = { id: "prodWINGS0000000001", sku: "WINGS", name: "Chicken Wings", unit: "kg", sellingPrice: 30000, available: 40000, status: "active" };
const fries = { id: "prodFRIES0000000001", sku: "FRIES", name: "Fries", unit: "case", sellingPrice: 90000, available: Q(8), status: "active" };
const pendingOrder = {
  id: "order0000000000000001",
  orderNumber: "ORD-20261008-001",
  orderDate: "2026-10-08",
  source: "messenger",
  customer: { name: "Juan Dela Cruz", phone: "0917" },
  items: [{ lineId: "L1", productId: wings.id, sku: "WINGS", name: "Chicken Wings", unit: "kg", quantity: 5000, unitPrice: 30000, lineSubtotal: 150000 }],
  itemCount: 1,
  subtotal: 150000,
  discount: 0,
  total: 150000,
  amountPaid: 0,
  balance: 150000,
  paymentStatus: "unpaid",
  fulfillmentStatus: "pending",
  revision: 1,
  statusHistory: [{ type: "created", at: new Date("2026-10-08T02:00:00Z"), actor: { name: "Staff A" }, to: "pending" }],
  createdBy: { name: "Staff A" },
  createdAt: new Date("2026-10-08T02:00:00Z"),
};
const fulfilledOrder = { ...pendingOrder, id: "order0000000000000002", orderNumber: "ORD-20261008-002", fulfillmentStatus: "fulfilled", statusHistory: [...pendingOrder.statusHistory, { type: "fulfilled", at: new Date(), actor: { name: "Staff A" } }] };

function deps({ rows = [pendingOrder, fulfilledOrder], hasMore = false } = {}) {
  return {
    data: {
      listOrders: vi.fn(async () => ({ rows, hasMore })),
      getOrder: vi.fn(async (_b, id) => rows.find((o) => o.id === id) || null),
      getOrderCosts: vi.fn(async () => ({ cogs: 100000, grossProfit: 50000, lines: [{ lineId: "L1", costConsumed: 100000 }] })),
      getProducts: vi.fn(async () => ({ [wings.id]: wings })),
    },
    searchProducts: vi.fn(async () => [wings, fries]),
    api: vi.fn(async () => ({ success: true, orderId: "newOrder000000000001", orderNumber: "ORD-20261008-003" })),
    toast: vi.fn(),
  };
}
const session = (role, overrides) => sessionFixture({ roleTemplate: role, permissions: overrides ? resolvePermissions(role, overrides) : undefined });
async function show(s, d = deps()) {
  mount(container, s, d);
  await flush();
  return d;
}
const modal = () => document.querySelector(".modal-backdrop");

async function composeOrder() {
  container.querySelector('[data-act="new"]').click();
  await flush();
  const form = modal().querySelector("form");
  const type = (name, value) => {
    form.elements[name].value = value;
    form.elements[name].dispatchEvent(new Event("input", { bubbles: true }));
  };
  type("name", "Maria Santos");
  type("phone", "0918 555 0000");
  form.elements.source.value = "viber";
  form.elements.source.dispatchEvent(new Event("change", { bubbles: true }));
  form.elements.search.value = "wing";
  modal().querySelector('[data-act="search"]').click();
  await flush();
  modal().querySelector(`[data-act="add"][data-id="${wings.id}"]`).click();
  modal().querySelector(`[data-act="add"][data-id="${fries.id}"]`).click();
  type("qty-0", "2.5");
  type("qty-1", "3");
  return { form, type };
}

describe("new order flow", () => {
  it("shows live preview totals and sends only ids, scaled quantities and an idempotency key", async () => {
    const d = await show(session("staff"));
    const { form } = await composeOrder();
    expect(modal().querySelector('[data-total="subtotal"]').textContent).toBe("₱3,450.00"); // 2.5 kg x 300 + 3 x 900
    expect(modal().querySelector('[data-total="total"]').textContent).toBe("₱3,450.00");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const body = d.api.mock.calls[0][1].body;
    expect(body.action).toBe("create");
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(body.order).toEqual({
      customer: { name: "Maria Santos", phone: "0918 555 0000", notes: "" },
      source: "viber",
      sourceNote: "",
      items: [{ productId: wings.id, quantity: 2500 }, { productId: fries.id, quantity: Q(3) }],
      notes: "",
    });
    expect(JSON.stringify(body)).not.toMatch(/unitPrice|sellingPrice|subtotal|total|cost/);
  });

  it("a retry after a failure reuses the SAME idempotency key", async () => {
    const d = deps();
    d.api = vi.fn().mockRejectedValueOnce(new Error("Network error")).mockResolvedValue({ success: true, orderNumber: "X" });
    await show(session("staff"), d);
    const { form } = await composeOrder();
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(modal().querySelector('[data-role="error"]').textContent).toMatch(/Network error/);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledTimes(2);
    expect(d.api.mock.calls[0][1].body.idempotencyKey).toBe(d.api.mock.calls[1][1].body.idempotencyKey);
  });

  it("invalid quantities stop the submit with a message", async () => {
    const d = await show(session("staff"));
    const { form, type } = await composeOrder();
    type("qty-1", "1.5"); // cases are whole units
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).not.toHaveBeenCalled();
    expect(modal().querySelector('[data-role="error"]').textContent).toMatch(/Fries/);
  });

  it("discount field only with orders.discount", async () => {
    await show(session("staff"));
    container.querySelector('[data-act="new"]').click();
    await flush();
    expect(modal().querySelector('[name="discount"]')).toBeNull();
    // Fresh page for the second user (the first mount keeps its listeners).
    document.body.innerHTML = "<main id=\"content\"></main>";
    container = document.getElementById("content");
    const d = await show(session("owner"));
    const { form, type } = await composeOrder();
    type("discount", "450");
    expect(modal().querySelector('[data-total="total"]').textContent).toBe("₱3,000.00");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api.mock.calls[0][1].body.order.discount).toBe(45000);
  });

  it("no New order button without orders.create", async () => {
    await show(session("staff", { revoke: ["orders.create"] }));
    expect(container.querySelector('[data-act="new"]')).toBeNull();
  });
});

describe("order detail", () => {
  const open = async (id) => {
    container.querySelector(`[data-act="open"][data-id="${id}"]`).click();
    await flush();
    return document.querySelector('[data-role="detail"]');
  };

  it("staff: items, totals, history, actions they hold; no COGS ever requested", async () => {
    const d = await show(session("staff"));
    const detail = await open(pendingOrder.id);
    expect(detail.querySelector('[data-role="items"]').textContent).toMatch(/2.5 kg|5 kg/);
    expect(detail.querySelector('[data-role="totals"]').textContent).toMatch(/₱1,500.00/);
    expect(detail.querySelector('[data-role="history"]').textContent).toMatch(/Order created/);
    expect(detail.querySelector('[data-act="fulfill"]')).not.toBeNull();
    expect(detail.querySelector('[data-act="edit"]')).not.toBeNull();
    expect(detail.querySelector('[data-act="cancel"]')).toBeNull(); // staff lack orders.cancel
    expect(d.data.getOrderCosts).not.toHaveBeenCalled();
    modal().remove();
    const done = await open(fulfilledOrder.id);
    expect(done.querySelector('[data-role="cogs"]')).toBeNull();
    expect(d.data.getOrderCosts).not.toHaveBeenCalled();
  });

  it("owner sees COGS and gross profit on fulfilled orders", async () => {
    await show(session("owner"));
    const detail = await open(fulfilledOrder.id);
    expect(detail.querySelector('[data-role="cogs"]').textContent).toBe("₱1,000.00");
    expect(detail.querySelector('[data-role="profit"]').textContent).toBe("₱500.00");
    expect(detail.querySelector('[data-act="fulfill"]')).toBeNull(); // not pending
  });

  it("fulfill asks to confirm, then calls the API with just the order id", async () => {
    const d = await show(session("staff"));
    const detail = await open(pendingOrder.id);
    detail.querySelector('[data-act="fulfill"]').click();
    await flush();
    document.querySelector('[data-action="confirm"]').click();
    await flush();
    expect(d.api).toHaveBeenCalledWith("orders", { method: "POST", body: { action: "fulfill", orderId: pendingOrder.id } });
  });

  it("cancel requires a reason (owner)", async () => {
    const d = await show(session("owner"));
    const detail = await open(pendingOrder.id);
    detail.querySelector('[data-act="cancel"]').click();
    await flush();
    const form = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    form.elements.reason.value = "Customer cancelled on Messenger";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("orders", { method: "POST", body: { action: "cancel", orderId: pendingOrder.id, reason: "Customer cancelled on Messenger" } });
  });

  it("edit keeps the line's price snapshot and sends the expected revision", async () => {
    const d = await show(session("staff"));
    const detail = await open(pendingOrder.id);
    detail.querySelector('[data-act="edit"]').click();
    await flush();
    const form = modal().querySelector("form");
    expect(form.textContent).toMatch(/₱300.00/);
    form.elements["qty-0"].value = "4";
    form.elements["qty-0"].dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api.mock.calls[0][1].body).toMatchObject({ action: "update", orderId: pendingOrder.id, expectedRevision: 1, order: { items: [{ productId: wings.id, quantity: 4000 }] } });
  });
});

describe("list", () => {
  it("columns, filters and cursor pagination", async () => {
    const d = await show(session("staff"), deps({ hasMore: true }));
    const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    expect(headers).toEqual(["Order #", "Time", "Customer", "Items", "Total", "Reference", "Proof", "Payment", "Fulfillment", ""]);
    expect(container.querySelector(`[data-order="${pendingOrder.id}"] [data-act="open"]`).textContent).toBe("View details");
    expect(container.textContent).toMatch(/Chicken Wings × 5 kg/);
    container.querySelector('[data-act="next"]').click();
    await flush();
    expect(d.data.listOrders.mock.calls[1][1].cursor).toMatchObject({ id: fulfilledOrder.id });
    const form = container.querySelector('[data-role="filters"]');
    form.elements.fulfillmentStatus.value = "pending";
    form.elements.source.value = "viber";
    form.elements.from.value = "2026-10-01";
    form.elements.to.value = "2026-10-08";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(d.data.listOrders.mock.calls.at(-1)[1]).toMatchObject({ filters: { fulfillmentStatus: "pending", source: "viber", from: "2026-10-01", to: "2026-10-08" }, cursor: null });
  });
});
