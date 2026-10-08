// @vitest-environment jsdom
// Phase 8 screens: inline Payment ▾ / Fulfillment ▾ in the compact Orders
// row, "View screenshot" in place, and the compact Payments page.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountOrders } from "../../src/modules/orders/index.js";
import { mount as mountPayments, paymentActivity } from "../../src/modules/payments/index.js";
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

const base = {
  orderDate: "2026-10-08",
  source: "viber",
  customer: { name: "ABC Store" },
  items: [{ lineId: "L1", productId: "prodWINGS0000000001", sku: "WINGS", name: "Wings", unit: "pcs", quantity: 5000, unitPrice: 49000, lineSubtotal: 245000 }],
  itemCount: 1,
  subtotal: 245000,
  discount: 0,
  total: 245000,
  revision: 1,
  statusHistory: [],
  createdBy: { name: "Staff A" },
  createdAt: new Date("2026-10-08T02:42:00Z"),
};
const unpaid = { ...base, id: "orderUNPAID000000001", orderNumber: "ORD-1042", amountPaid: 0, balance: 245000, paymentStatus: "unpaid", fulfillmentStatus: "pending", paymentCount: 0 };
const paid = { ...base, id: "orderPAID00000000001", orderNumber: "ORD-1043", amountPaid: 245000, balance: 0, paymentStatus: "paid", fulfillmentStatus: "preparing", paymentCount: 2, lastPaymentRef: "918273645", lastProofPaymentId: "payPROOF00000000001" };
const forVerification = { ...base, id: "orderVERIFY00000001", orderNumber: "ORD-1044", amountPaid: 245000, balance: 0, paymentStatus: "for_verification", fulfillmentStatus: "ready", paymentCount: 1, lastPaymentRef: "555666777" };
const PNG64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function deps(rows = [unpaid, paid, forVerification]) {
  return {
    data: {
      listOrders: vi.fn(async () => ({ rows, hasMore: false })),
      getOrder: vi.fn(async (_b, id) => rows.find((o) => o.id === id)),
      getOrderCosts: vi.fn(async () => null),
      getProducts: vi.fn(async () => ({})),
    },
    payments: { listOrderPayments: vi.fn(async (_b, id) => (id === forVerification.id ? [{ id: "payPENDING000000001", orderId: id, amount: 245000, method: "gcash", reference: "555666777", state: "for_verification" }] : [])) },
    searchProducts: vi.fn(async () => []),
    api: vi.fn(async (_p, { body }) => (body.action === "proof" ? { contentType: "image/png", dataBase64: PNG64 } : { success: true })),
    toast: vi.fn(),
  };
}
const session = (role, overrides) => sessionFixture({ roleTemplate: role, permissions: overrides ? resolvePermissions(role, overrides) : undefined });
const row = (id) => container.querySelector(`[data-order="${id}"]`);
const choose = async (select, value) => {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
};
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);

describe("compact Orders row after Phase 8", () => {
  it("shows reference (+N), View screenshot, and the two separate dropdowns", async () => {
    mountOrders(container, session("owner"), deps());
    await flush();
    expect(row(paid.id).querySelector('[data-col="reference"]').textContent.trim()).toBe("918273645 (+1)");
    expect(row(unpaid.id).querySelector('[data-col="reference"]').textContent.trim()).toBe("—");
    expect(row(paid.id).querySelector('[data-act="proof"]').textContent).toBe("View screenshot");
    expect(row(paid.id).querySelector('select[data-act="payment"]').value).toBe("paid");
    expect(row(paid.id).querySelector('select[data-act="fulfillment"]').value).toBe("preparing");
    expect([...row(unpaid.id).querySelector('select[data-act="fulfillment"]').options].map((o) => o.value)).toEqual(["pending", "preparing", "ready", "fulfilled", "cancelled"]);
  });

  it("without payment / fulfil permissions the cells are read-only badges", async () => {
    mountOrders(container, session("staff", { revoke: ["payments.record", "orders.fulfill"] }), deps());
    await flush();
    expect(row(unpaid.id).querySelector("select")).toBeNull();
    expect(row(unpaid.id).querySelector('[data-col="payment"]').textContent.trim()).toBe("Unpaid");
  });
});

describe("Payment ▾", () => {
  it("Paid opens one small popover with the balance prefilled; Save records it and returns to the list", async () => {
    const d = deps();
    mountOrders(container, session("staff"), d);
    await flush();
    await choose(row(unpaid.id).querySelector('select[data-act="payment"]'), "paid");
    const form = lastForm();
    expect(form.elements.amount.value).toBe("2450.00");
    form.elements.method.value = "gcash";
    form.elements.reference.value = "9182 7364 5";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "record", orderId: unpaid.id, payment: { amount: 245000, method: "gcash", reference: "918273645" } } });
    expect(document.querySelector(".modal-backdrop")).toBeNull();
    expect(d.data.listOrders).toHaveBeenCalledTimes(2); // back on the refreshed list
  });

  it("GCash without a reference and overpayment are caught in the popover", async () => {
    const d = deps();
    mountOrders(container, session("staff"), d);
    await flush();
    await choose(row(unpaid.id).querySelector('select[data-act="payment"]'), "partial");
    const form = lastForm();
    expect(form.elements.amount.value).toBe("");
    form.elements.amount.value = "100";
    form.elements.method.value = "gcash";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(form.querySelector('[data-role="error"]').textContent).toMatch(/need a reference/);
    form.elements.amount.value = "3000";
    form.elements.method.value = "cash";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(form.querySelector('[data-role="error"]').textContent).toMatch(/more than the balance/);
    expect(d.api).not.toHaveBeenCalled();
  });

  it("cancelling the popover puts the dropdown back", async () => {
    mountOrders(container, session("staff"), deps());
    await flush();
    const select = row(unpaid.id).querySelector('select[data-act="payment"]');
    await choose(select, "paid");
    lastForm().querySelector('[data-action="cancel"]').click();
    await flush();
    expect(select.value).toBe("unpaid");
  });

  it("Paid on a 'for verification' order verifies (payments.verify)", async () => {
    const d = deps();
    mountOrders(container, session("owner"), d);
    await flush();
    await choose(row(forVerification.id).querySelector('select[data-act="payment"]'), "paid");
    document.querySelector('[data-action="confirm"]').click();
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "verify", paymentId: "payPENDING000000001" } });
  });

  it("picking Unpaid doesn't write anything; it explains", async () => {
    const d = deps();
    mountOrders(container, session("owner"), d);
    await flush();
    const select = row(paid.id).querySelector('select[data-act="payment"]');
    await choose(select, "unpaid");
    expect(d.api).not.toHaveBeenCalled();
    expect(select.value).toBe("paid");
    expect(d.toast).toHaveBeenCalledWith(expect.stringMatching(/follows the recorded payments/), "neutral");
  });
});

describe("Fulfillment ▾", () => {
  it("open stages call the stage action; Fulfilled confirms then calls the fulfil engine; Cancelled asks a reason", async () => {
    const d = deps();
    mountOrders(container, session("owner"), d);
    await flush();
    await choose(row(unpaid.id).querySelector('select[data-act="fulfillment"]'), "preparing");
    expect(d.api).toHaveBeenLastCalledWith("orders", { method: "POST", body: { action: "stage", orderId: unpaid.id, stage: "preparing" } });
    await choose(row(paid.id).querySelector('select[data-act="fulfillment"]'), "fulfilled");
    document.querySelector('[data-action="confirm"]').click();
    await flush();
    expect(d.api).toHaveBeenLastCalledWith("orders", { method: "POST", body: { action: "fulfill", orderId: paid.id } });
    await choose(row(unpaid.id).querySelector('select[data-act="fulfillment"]'), "cancelled");
    const form = lastForm();
    form.elements.reason.value = "Customer cancelled";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenLastCalledWith("orders", { method: "POST", body: { action: "cancel", orderId: unpaid.id, reason: "Customer cancelled" } });
  });

  it("declining the fulfil confirmation puts the dropdown back", async () => {
    mountOrders(container, session("owner"), deps());
    await flush();
    const select = row(paid.id).querySelector('select[data-act="fulfillment"]');
    await choose(select, "fulfilled");
    document.querySelector('[data-action="cancel"]').click();
    await flush();
    expect(select.value).toBe("preparing");
  });
});

describe("View screenshot", () => {
  it("opens in place through the server, never by public URL", async () => {
    const d = deps();
    mountOrders(container, session("staff"), d);
    await flush();
    row(paid.id).querySelector('[data-act="proof"]').click();
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "proof", paymentId: "payPROOF00000000001" } });
    const img = document.querySelector('[data-role="proof-viewer"] img');
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(container.querySelector('[data-role="orders"]')).not.toBeNull(); // still on the list
  });

  it("a non-image response is refused", async () => {
    const d = deps();
    d.api = vi.fn(async () => ({ contentType: "text/html", dataBase64: "PGgxPg==" }));
    mountOrders(container, session("staff"), d);
    await flush();
    row(paid.id).querySelector('[data-act="proof"]').click();
    await flush();
    expect(document.querySelector('[data-role="proof-viewer"] img')).toBeNull();
    expect(document.querySelector('[data-role="proof-viewer"] .form-error')).not.toBeNull();
  });
});

describe("Payments page", () => {
  const payments = [
    { id: "pay1", orderNumber: "ORD-1042", customerName: "ABC Store", amount: 245000, method: "gcash", reference: "918273645", proof: { path: "x" }, state: "verified", receivedAt: new Date("2026-10-08T05:22:00Z"), history: [{ type: "recorded", at: new Date("2026-10-08T05:22:00Z"), actor: { name: "Carlo" }, amount: 245000, method: "gcash", reference: "918273645" }, { type: "verified", at: new Date("2026-10-08T05:30:00Z"), actor: { name: "Marianne" }, label: "Payment marked verified" }, { type: "amount", at: new Date("2026-10-08T05:40:00Z"), actor: { name: "Carlo" }, label: "Payment amount changed ₱2,450.00 → ₱2,400.00" }] },
    { id: "pay2", orderNumber: "ORD-1044", customerName: "XYZ", amount: 100000, method: "cash", reference: null, proof: null, state: "for_verification", receivedAt: new Date("2026-10-08T06:00:00Z"), history: [] },
  ];
  const pdeps = () => ({ data: { listPayments: vi.fn(async () => ({ rows: payments, hasMore: false })) }, api: vi.fn(async () => ({ success: true })), toast: vi.fn() });

  it("one compact row per payment with the standard columns", async () => {
    mountPayments(container, session("staff"), pdeps());
    await flush();
    expect([...container.querySelectorAll("thead th")].map((th) => th.textContent.trim())).toEqual(["Date/Time", "Order #", "Customer", "Amount", "Method", "Reference", "Proof", "Status", ""]);
    expect(container.querySelector('[data-payment="pay1"]').textContent).toMatch(/ORD-1042.*ABC Store.*₱2,450\.00.*GCash.*918273645.*View screenshot.*Verified/s);
  });

  it("activity reads in plain language", () => {
    expect(paymentActivity(payments[0], { timezone: "Asia/Manila" })).toEqual([
      expect.stringMatching(/1:22.*PM • Carlo • Payment recorded ₱2,450\.00 via GCash · Reference: 918273645/),
      expect.stringMatching(/1:30.*PM • Marianne • Payment marked verified/),
      expect.stringMatching(/1:40.*PM • Carlo • Payment amount changed ₱2,450\.00 → ₱2,400\.00/),
    ]);
  });

  it("staff View: activity only; owner View: Edit, Mark verified, ⋯ More → Remove payment", async () => {
    mountPayments(container, session("staff"), pdeps());
    await flush();
    container.querySelector('[data-payment="pay2"] [data-act="view"]').click();
    expect([...document.querySelectorAll('[data-role="payment-view"] .modal-footer button')].map((b) => b.textContent.trim())).toEqual(["Close"]);
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const d = pdeps();
    mountPayments(container, session("owner"), d);
    await flush();
    container.querySelector('[data-payment="pay2"] [data-act="view"]').click();
    const view = document.querySelector('[data-role="payment-view"]');
    expect([...view.querySelectorAll(".modal-footer > button, .modal-footer > .menu-wrap > button")].map((b) => b.textContent.trim())).toEqual(["⋯ More", "Edit", "Mark verified", "Close"]);
    view.querySelector('[data-act="remove"]').click();
    await flush();
    const form = lastForm();
    form.elements.reason.value = "Entered twice";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "void", paymentId: "pay2", reason: "Entered twice" } });
  });

  it("Edit sends only what changed, with the reference normalized", async () => {
    const d = pdeps();
    mountPayments(container, session("owner"), d);
    await flush();
    container.querySelector('[data-payment="pay1"] [data-act="view"]').click();
    document.querySelector('[data-role="payment-view"] [data-act="edit"]').click();
    await flush();
    const form = lastForm();
    form.elements.reference.value = "9182-7364-6";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "update", paymentId: "pay1", changes: { reference: "918273646" } } });
  });
});
