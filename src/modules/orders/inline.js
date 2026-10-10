// The inline Payment ▾ / Fulfillment ▾ controls of an order row, shared by
// the Orders screen and the Dashboard's recent orders (Phase 18.5: moved
// here unchanged so both behave identically).
//   Payment ▾       Paid / Partially paid open a small "record payment"
//                   popover; on a "For verification" order, Paid = verify.
//                   The status itself is always derived by the server.
//   Fulfillment ▾   Pending / Preparing / Ready change the stage; Fulfilled
//                   and Cancelled go through the protected fulfil / cancel
//                   engines (stock, Sales, COGS), never a bare status write.
// Permissions decide every control; the server re-checks all of it.

import { html } from "../../lib/html.js";
import { badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog } from "../../components/feedback.js";
import { formatCentavos } from "../../lib/format.js";
import { FULFILLMENT_STATUSES, PAYMENT_STATUSES, isOpenFulfillment } from "@shared/index.js";
import { fulfillmentLabel, paymentLabel, FULFILLMENT_TONE, PAYMENT_TONE } from "./view.js";
import { recordPaymentDialog } from "../payments/actions.js";

export function orderPermissions(perms) {
  return {
    create: perms["orders.create"] === true,
    update: perms["orders.update"] === true,
    fulfill: perms["orders.fulfill"] === true,
    cancel: perms["orders.cancel"] === true,
    correct: perms["orders.correct"] === true,
    financials: perms["dashboard.financials"] === true,
    viewPayments: perms["payments.view"] === true,
    recordPayment: perms["payments.record"] === true,
    verifyPayment: perms["payments.verify"] === true,
  };
}

export function paymentCell(o, can) {
  if (!can.recordPayment || o.fulfillmentStatus === "cancelled") return badge(paymentLabel(o.paymentStatus), PAYMENT_TONE[o.paymentStatus] || "neutral");
  return html`<select class="select select-compact select-chip" data-act="payment" data-id="${o.id}" data-tone="${PAYMENT_TONE[o.paymentStatus] || "neutral"}" aria-label="Payment status of ${o.orderNumber}">
    ${Object.entries(PAYMENT_STATUSES).map(([k, v]) => html`<option value="${k}" ${o.paymentStatus === k ? "selected" : ""}>${v.label}</option>`)}
  </select>`;
}

export function fulfillmentCell(o, can) {
  if (!can.fulfill || !isOpenFulfillment(o.fulfillmentStatus)) return badge(fulfillmentLabel(o.fulfillmentStatus), FULFILLMENT_TONE[o.fulfillmentStatus] || "neutral");
  const choices = Object.entries(FULFILLMENT_STATUSES).filter(([k]) => k !== "cancelled" || can.cancel);
  return html`<select class="select select-compact select-chip" data-act="fulfillment" data-id="${o.id}" data-tone="${FULFILLMENT_TONE[o.fulfillmentStatus] || "neutral"}" aria-label="Fulfillment of ${o.orderNumber}">
    ${choices.map(([k, v]) => html`<option value="${k}" ${o.fulfillmentStatus === k ? "selected" : ""}>${v.label}</option>`)}
  </select>`;
}

// deps: { can, api, toast, currency, businessId, listOrderPayments, reload }
export function inlineOrderActions({ can, api, toast, currency, businessId, listOrderPayments, reload }) {
  const cancelDialog = (order) =>
    formDialog({
      title: `Cancel ${order.orderNumber}`,
      intro: "Reserved stock is released. The order stays in history.",
      fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
      submitLabel: "Cancel order",
      onSubmit: (v) => api("orders", { method: "POST", body: { action: "cancel", orderId: order.id, reason: v.reason } }),
    });

  // Payment ▾: Paid / Partially paid record a payment; Paid on a
  // for-verification order verifies its pending payments.
  async function onPaymentChoice(o, choice, select) {
    const reset = () => {
      if (select) select.value = o.paymentStatus;
    };
    try {
      if (choice === "paid" && o.paymentStatus === "for_verification" && can.verifyPayment) {
        const pending = (await listOrderPayments(businessId, o.id)).filter((p) => p.state === "for_verification");
        const total = pending.reduce((s, p) => s + p.amount, 0);
        const ok = await confirmDialog({ title: `Verify payment for ${o.orderNumber}?`, body: `${pending.length} payment(s), ${formatCentavos(total, currency)}${pending[0]?.reference ? `, ref ${pending[0].reference}` : ""}.`, confirmLabel: "Mark verified" });
        if (!ok) return reset();
        for (const p of pending) await api("payments", { method: "POST", body: { action: "verify", paymentId: p.id } });
        toast("Payment verified", "success");
        return reload();
      }
      if ((choice === "paid" || choice === "partial") && (o.balance ?? o.total) > 0) {
        const result = await recordPaymentDialog({ order: o, api, currency, fullBalance: choice === "paid" });
        if (!result) return reset();
        toast("Payment recorded", "success");
        return reload();
      }
      toast("Payment status follows the recorded payments. Open the order to change a payment.", "neutral");
      return reset();
    } catch (err) {
      toast(err.message || "Couldn't update the payment.", "danger");
      return reset();
    }
  }

  // Fulfillment ▾
  async function onFulfillmentChoice(o, choice, select) {
    const reset = () => {
      if (select) select.value = o.fulfillmentStatus;
    };
    try {
      if (isOpenFulfillment(choice)) {
        await api("orders", { method: "POST", body: { action: "stage", orderId: o.id, stage: choice } });
        toast(`${o.orderNumber}: ${fulfillmentLabel(choice)}`, "success");
        return reload();
      }
      if (choice === "fulfilled") {
        const ok = await confirmDialog({ title: `Fulfill ${o.orderNumber}?`, body: "Stock leaves inventory and the sale counts toward today.", confirmLabel: "Mark fulfilled" });
        if (!ok) return reset();
        await api("orders", { method: "POST", body: { action: "fulfill", orderId: o.id } });
        toast("Order fulfilled", "success");
        return reload();
      }
      if (choice === "cancelled") {
        const result = await cancelDialog(o);
        if (!result) return reset();
        toast("Order cancelled", "success");
        return reload();
      }
      return reset();
    } catch (err) {
      toast(err.message || "Couldn't update the order.", "danger");
      return reset();
    }
  }

  return { onPaymentChoice, onFulfillmentChoice, cancelDialog };
}
