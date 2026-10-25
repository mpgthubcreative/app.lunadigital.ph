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
  it("Latest payment inline (an older order: its latest reference + screenshot), the payment link while something is due, and the two dropdowns", async () => {
    mountOrders(container, session("owner"), deps());
    await flush();
    expect(row(paid.id).querySelector('[data-role="latest-payment"] .lp-what').textContent.trim()).toBe("Ref 918273645");
    expect(row(unpaid.id).querySelector('[data-role="latest-payment"]').textContent.trim()).toBe("Payment link · Copy");
    expect(row(paid.id).querySelector('[data-act="copy-pay-link"]')).toBeNull(); // nothing due
    expect(row(paid.id).querySelector('[data-act="lp-proof"]').textContent).toBe("View screenshot");
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
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "record", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), orderId: unpaid.id, payment: { amount: 245000, method: "gcash", reference: "918273645" } } });
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
    // GCash: the reference number OR a screenshot (one is enough).
    expect(form.querySelector('[data-role="error"]').textContent).toMatch(/need the reference number or a screenshot/);
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
    row(paid.id).querySelector('[data-act="lp-proof"]').click();
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
    row(paid.id).querySelector('[data-act="lp-proof"]').click();
    await flush();
    expect(document.querySelector('[data-role="proof-viewer"] img')).toBeNull();
    expect(document.querySelector('[data-role="proof-viewer"] .form-error')).not.toBeNull();
  });
});

describe("Orders row: the latest payment and what to do next (2026-10-22)", () => {
  const lp = (over) => ({ id: "payLAST000000000001", amount: 245000, method: "gcash", reference: "1234567891234", hasProof: true, state: "for_verification", via: "payment_link", day: "2026-10-22", ...over });
  const waiting = { ...unpaid, id: "orderWAIT0000000001", orderNumber: "ORD-2001", paymentStatus: "for_verification", balance: 0, amountPaid: 245000, paymentCount: 1, lastPayment: lp() };
  const refOnly = { ...unpaid, id: "orderREF00000000001", orderNumber: "ORD-2002", paymentStatus: "partial", balance: 145000, amountPaid: 100000, paymentCount: 1, lastPayment: lp({ amount: 100000, hasProof: false, state: "verified", via: null }) };
  const shotOnly = { ...unpaid, id: "orderSHOT0000000001", orderNumber: "ORD-2003", paymentStatus: "for_verification", balance: 145000, amountPaid: 100000, paymentCount: 1, lastPayment: lp({ amount: 100000, reference: null }) };

  it("waiting: GCash · Ref … Waiting verification, View screenshot / Verify / Not accepted; reference only (verified): Receipt + the link for the rest; screenshot only: 'Screenshot submitted'", async () => {
    mountOrders(container, session("owner"), deps([waiting, refOnly, shotOnly]));
    await flush();
    const cell = (o) => row(o.id).querySelector('[data-role="latest-payment"]');
    expect(cell(waiting).querySelector(".lp-what").textContent.replace(/\s+/g, " ").trim()).toBe("GCash · Ref 1234567891234 Waiting verification");
    expect([...cell(waiting).querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["View screenshot", "Verify", "Not accepted"]);
    expect(cell(refOnly).querySelector(".lp-what").textContent.replace(/\s+/g, " ").trim()).toBe("GCash · Ref 1234567891234 Verified");
    expect([...cell(refOnly).querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Confirmation", "Payment link · Copy"]);
    expect(cell(shotOnly).querySelector(".lp-what").textContent.replace(/\s+/g, " ").trim()).toBe("GCash · Screenshot submitted Waiting verification");
  });

  it("Verify (after the check) and Not accepted (with the customer-facing reason) act on THAT payment; Receipt shows method + reference", async () => {
    const d = deps([waiting, refOnly]);
    mountOrders(container, session("owner"), d);
    await flush();
    row(waiting.id).querySelector('[data-act="lp-verify"]').click();
    await flush();
    expect(document.querySelector(".modal-backdrop").textContent).toMatch(/GCash · Ref 1234567891234\. Check it reached your GCash \/ Maya \/ bank first\./);
    document.querySelector('[data-action="confirm"]').click();
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "verify", paymentId: "payLAST000000000001" } });
    row(waiting.id).querySelector('[data-act="lp-reject"]').click();
    await flush();
    lastForm().elements.reason.value = "Amount on the screenshot is ₱2,000";
    lastForm().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "void", paymentId: "payLAST000000000001", reason: "Amount on the screenshot is ₱2,000" } });
    row(refOnly.id).querySelector('[data-act="lp-receipt"]').click();
    const r = document.querySelector('[data-role="receipt"]');
    expect([r.querySelector('[data-role="receipt-method"]').textContent, r.querySelector('[data-role="receipt-reference"]').textContent]).toEqual(["GCash", "1234567891234"]);
  });

  it("Payment link · Copy makes / gets the link and copies it in the same tap", async () => {
    const d = deps([unpaid]);
    d.api = vi.fn(async () => ({ token: "T".repeat(32), path: `/pay/${"T".repeat(32)}` }));
    const write = vi.fn(async (items) => {
      await items[0].getType?.("text/plain");
    });
    const copied = [];
    globalThis.ClipboardItem = class {
      constructor(data) {
        this.data = data;
        copied.push(data["text/plain"]);
      }
    };
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    mountOrders(container, session("staff"), d);
    await flush();
    row(unpaid.id).querySelector('[data-act="copy-pay-link"]').click();
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "payLink", orderId: unpaid.id } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(await (await copied[0]).text()).toBe(`${location.origin}/pay/${"T".repeat(32)}`);
    expect(d.toast).toHaveBeenCalledWith(`Payment link for ${unpaid.orderNumber} copied ✓`, "success");
    delete globalThis.ClipboardItem;
  });
});

describe("Payments page (More → Payments): audit and reconciliation", () => {
  const payments = [
    { id: "pay1", orderNumber: "ORD-1042", customerName: "ABC Store", amount: 245000, method: "gcash", reference: "918273645", proof: { path: "x" }, state: "verified", receivedDay: "2026-10-08", receivedAt: new Date("2026-10-08T05:22:00Z"), verifiedBy: { name: "Marianne" }, verifiedAt: new Date("2026-10-08T05:30:00Z"), createdBy: { name: "Carlo" }, history: [{ type: "recorded", at: new Date("2026-10-08T05:22:00Z"), actor: { name: "Carlo" }, amount: 245000, method: "gcash", reference: "918273645" }, { type: "verified", at: new Date("2026-10-08T05:30:00Z"), actor: { name: "Marianne" }, label: "Payment marked verified" }, { type: "amount", at: new Date("2026-10-08T05:40:00Z"), actor: { name: "Carlo" }, label: "Payment amount changed ₱2,450.00 → ₱2,400.00" }] },
    { id: "pay2", orderNumber: "ORD-1044", customerName: "XYZ", amount: 100000, method: "maya", reference: null, proof: { path: "y" }, state: "for_verification", via: "payment_link", createdBy: { name: "Customer (payment link)" }, receivedAt: new Date("2026-10-08T06:00:00Z"), history: [] },
    { id: "pay3", orderNumber: "ORD-1045", customerName: "", amount: 50000, method: "cash", reference: null, proof: null, state: "for_verification", createdBy: { name: "Staff A" }, receivedAt: new Date("2026-10-08T07:00:00Z"), history: [] },
  ];
  const pdeps = () => ({ data: { listPayments: vi.fn(async (_b, { filters }) => ({ rows: filters.state ? payments.filter((p) => p.state === filters.state) : filters.from ? payments.slice(0, 2) : payments, hasMore: false })) }, api: vi.fn(async (_p, { body }) => (body.action === "proof" ? { contentType: "image/png", dataBase64: PNG64 } : { success: true })), toast: vi.fn() });

  it("Today line, All / Needs checking / Verified; one compact row: who · order, amount, method · ref, status, next action", async () => {
    const d = pdeps();
    mountPayments(container, session("owner"), d);
    await flush();
    expect(container.querySelector('[data-role="today"]').textContent.replace(/\s+/g, " ").trim()).toBe("Today ₱3,450.00 received · 2 waiting to check");
    expect([...container.querySelectorAll('[data-role="seg-view"] .seg-btn')].map((b) => b.textContent)).toEqual(["All", "Needs checking", "Verified"]);
    const text = (id) => [...container.querySelectorAll(`[data-payment="${id}"] .py-who, [data-payment="${id}"] .py-sub, [data-payment="${id}"] .py-amt, [data-payment="${id}"] .py-state, [data-payment="${id}"] .py-acts button`)].map((x) => x.textContent.replace(/\s+/g, " ").trim()).join(" ");
    expect(text("pay1")).toMatch(/^ABC Store · ORD-1042 GCash · Ref 918273645 · .* ₱2,450\.00 Verified View proof Confirmation$/);
    expect(text("pay2")).toMatch(/^XYZ · ORD-1044 Maya · Screenshot · from the customer · .* ₱1,000\.00 Waiting verification View proof Verify$/);
    expect(text("pay3")).toMatch(/^Walk-in · ORD-1045 Cash · .* ₱500\.00 Waiting verification Verify$/);
    expect(container.querySelector("table")).toBeNull();
    container.querySelector('[data-act="seg"][data-value="check"]').click();
    await flush();
    expect(d.data.listPayments.mock.calls.at(-3)[1].filters).toEqual({ state: "for_verification" });
  });

  it("More filters: Not accepted, method and dates go to the query; Sent by and Proof narrow the list", async () => {
    const d = pdeps();
    mountPayments(container, session("owner"), d);
    await flush();
    const form = container.querySelector('[data-role="more-form"]');
    form.elements.via.value = "customer";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect([...container.querySelectorAll("[data-payment]")].map((r) => r.dataset.payment)).toEqual(["pay2"]);
    const f2 = container.querySelector('[data-role="more-form"]');
    f2.elements.via.value = "";
    f2.elements.rejected.checked = true;
    f2.elements.method.value = "gcash";
    f2.elements.from.value = "2026-10-01";
    f2.elements.to.value = "2026-10-08";
    f2.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(d.data.listPayments.mock.calls.at(-3)[1].filters).toEqual({ state: "voided", method: "gcash", from: "2026-10-01", to: "2026-10-08" });
    expect(container.querySelector('[data-role="more-filters"] summary').textContent).toBe("More filters (4)");
  });

  it("an old ?state=for_verification link opens Needs checking", async () => {
    window.history.replaceState({}, "", "/payments?state=for_verification");
    const d = pdeps();
    mountPayments(container, session("owner"), d);
    await flush();
    expect(d.data.listPayments.mock.calls[0][1].filters).toEqual({ state: "for_verification" });
    expect(container.querySelector('[data-value="check"]').getAttribute("aria-pressed")).toBe("true");
    window.history.replaceState({}, "", "/");
  });

  it("Verify in the row is for verifiers only, behind the same confirmation", async () => {
    mountPayments(container, session("staff"), pdeps());
    await flush();
    expect(container.querySelector('[data-act="quick-verify"]')).toBeNull();
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const d = pdeps();
    mountPayments(container, session("owner"), d);
    await flush();
    container.querySelector('[data-payment="pay2"] [data-act="quick-verify"]').click();
    await flush();
    document.querySelector('[data-action="confirm"]').click();
    await flush();
    expect(d.api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "verify", paymentId: "pay2" } });
  });

  it("activity reads in plain language", () => {
    expect(paymentActivity(payments[0], { timezone: "Asia/Manila" })).toEqual([
      expect.stringMatching(/1:22.*PM • Carlo • Payment recorded ₱2,450\.00 via GCash · Reference: 918273645/),
      expect.stringMatching(/1:30.*PM • Marianne • Payment marked verified/),
      expect.stringMatching(/1:40.*PM • Carlo • Payment amount changed ₱2,450\.00 → ₱2,400\.00/),
    ]);
  });

  it("details: the facts for checking (submitted by, verified by), View receipt / screenshot; history only under ⋯ → View history", async () => {
    mountPayments(container, session("owner"), pdeps());
    await flush();
    container.querySelector('[data-payment="pay1"] [data-act="view"]').click();
    const view = document.querySelector('[data-role="payment-view"]');
    expect([...view.querySelectorAll("dt")].map((x) => x.textContent)).toEqual(["Amount", "Order", "Customer", "Method", "Reference", "Proof", "Submitted by", "Submitted", "Status", "Verified by"]);
    expect(view.querySelector('[data-role="decided"]').textContent).toMatch(/^Marianne · /);
    expect(view.querySelector('[data-role="payment-activity"]')).toBeNull();
    expect([...view.querySelectorAll(".modal-footer > button")].map((b) => b.textContent.trim())).toEqual(["View receipt", "Close"]);
    view.querySelector('[data-act="history"]').click();
    expect(document.querySelectorAll('[data-role="payment-history"] [data-role="payment-activity"] li')).toHaveLength(3);
  });

  it("a customer's waiting payment: Not accepted + Mark verified; ⋯ holds View history, Edit and Remove payment (with a reason)", async () => {
    mountPayments(container, session("staff"), pdeps());
    await flush();
    container.querySelector('[data-payment="pay2"] [data-act="view"]').click();
    expect([...document.querySelectorAll('[data-role="payment-view"] .modal-footer > button')].map((b) => b.textContent.trim())).toEqual(["Close"]);
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const d = pdeps();
    mountPayments(container, session("owner"), d);
    await flush();
    container.querySelector('[data-payment="pay2"] [data-act="view"]').click();
    const view = document.querySelector('[data-role="payment-view"]');
    expect(view.querySelector('[data-role="via"]').textContent).toBe("The customer, from the payment link");
    expect([...view.querySelectorAll(".modal-footer > button")].map((b) => b.textContent.trim())).toEqual(["Not accepted", "Mark verified", "Close"]);
    expect([...view.querySelectorAll('[data-role="more-menu"] button')].map((b) => b.textContent.trim())).toEqual(["View history", "Edit", "Remove payment"]);
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
