// The inline Payment ▾ / Fulfillment ▾ controls of an order row, shared by
// the Orders screen and the Dashboard's recent orders (Phase 18.5: moved
// here unchanged so both behave identically).
//   Payment ▾       Paid / Partially paid open a small "record payment"
//                   popover; on a "For verification" order, Paid = verify.
//                   The status itself is always derived by the server.
//   Fulfillment ▾   Pending / Preparing / Ready change the stage; Fulfilled
//                   and Cancelled go through the protected fulfil / cancel
//                   engines (stock, Sales, COGS), never a bare status write.
//                   A fulfilled order (2026-11-03, orders.correct) can go back
//                   to Pending / Preparing / Ready ("Reverse fulfillment",
//                   with a reason) or be cancelled: stock, sales and COGS are
//                   reversed by the server, not just relabelled.
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

// Latest payment, inline on the order row (2026-10-22): what came in and
// what to do next, without opening Payments.
//   GCash · Ref 1234567891234   Waiting verification
//   [View screenshot] [Verify] [Not accepted]      (verified: [Receipt])
//   Payment link · Copy                            (while something is due)
// From order.lastPayment (server-written); older orders fall back to their
// latest reference / screenshot.
const LP_STATE = { for_verification: ["Waiting verification", "warning"], verified: ["Verified", "success"], voided: ["Not accepted", "danger"] };
export function latestPaymentCell(o, can) {
  const lp = o.lastPayment || (o.lastPaymentRef || o.lastProofPaymentId ? { id: o.lastProofPaymentId || null, reference: o.lastPaymentRef || null, hasProof: Boolean(o.lastProofPaymentId), state: null, method: null } : null);
  const due = o.fulfillmentStatus !== "cancelled" && (o.balance ?? o.total - (o.amountPaid || 0)) > 0;
  const link = due && can.recordPayment ? html`<button type="button" class="btn btn-compact lp-link" data-act="copy-pay-link" data-id="${o.id}" aria-label="Copy the payment link for ${o.orderNumber}">Payment link · Copy</button>` : "";
  if (!lp) return html`<div class="lp" data-role="latest-payment">${link || html`<span class="cell-sub">—</span>`}</div>`;
  const what = [lp.method ? methodText(lp.method) : "", lp.reference ? `Ref ${lp.reference}` : lp.hasProof ? "Screenshot submitted" : ""].filter(Boolean).join(" · ");
  const [word, tone] = LP_STATE[lp.state] || [];
  const acts = [
    lp.hasProof && lp.id && can.viewPayments ? html`<button type="button" class="btn-linklike" data-act="lp-proof" data-id="${o.id}">View screenshot</button>` : "",
    lp.state === "for_verification" && can.verifyPayment ? html`<button type="button" class="btn btn-compact" data-act="lp-verify" data-id="${o.id}">Verify</button>` : "",
    lp.state === "for_verification" && can.verifyPayment && lp.via === "payment_link" ? html`<button type="button" class="btn-linklike lp-reject" data-act="lp-reject" data-id="${o.id}">Not accepted</button>` : "",
    lp.state === "verified" ? html`<button type="button" class="btn-linklike" data-act="lp-receipt" data-id="${o.id}">Confirmation</button>` : "",
  ].filter(Boolean);
  return html`<div class="lp" data-role="latest-payment">
    <span class="lp-what">${what || "Payment"}${word ? html` <span class="lp-state" data-tone="${tone}">${word}</span>` : ""}</span>
    ${acts.length ? html`<span class="lp-acts">${acts}</span>` : ""}
    ${link}
  </div>`;
}
const methodText = (m) => ({ gcash: "GCash", maya: "Maya", bank_transfer: "Bank transfer", cash: "Cash", cod: "COD", other: "Other" })[m] ?? m;

// Copies text that is still being fetched (the order's payment link), inside
// the same tap: Safari only allows clipboard writes started by the gesture.
export async function copyPending(textPromise, { clipboard = globalThis.navigator?.clipboard, ClipboardItemCtor = globalThis.ClipboardItem } = {}) {
  if (clipboard?.write && ClipboardItemCtor) {
    await clipboard.write([new ClipboardItemCtor({ "text/plain": Promise.resolve(textPromise).then((t) => new Blob([t], { type: "text/plain" })) })]);
    return textPromise;
  }
  const text = await textPromise;
  await clipboard.writeText(text);
  return text;
}

export const canReverse = (o, can) => o.fulfillmentStatus === "fulfilled" && can.correct && can.fulfill;
export function fulfillmentCell(o, can) {
  if (!can.fulfill || !(isOpenFulfillment(o.fulfillmentStatus) || canReverse(o, can))) return badge(fulfillmentLabel(o.fulfillmentStatus), FULFILLMENT_TONE[o.fulfillmentStatus] || "neutral");
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
      intro: order.fulfillmentStatus === "fulfilled" ? "This order is fulfilled. Cancelling reverses it: tracked stock comes back, and its sales and COGS leave the day it was fulfilled. Payments must be removed first. The order and its history stay." : "Reserved stock is released. The order stays in history.",
      fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
      submitLabel: "Cancel order",
      onSubmit: (v) => api("orders", { method: "POST", body: { action: "cancel", orderId: order.id, reason: v.reason } }),
    });
  // Fulfilled -> an open stage: the fulfillment is reversed (stock back and
  // set aside again; sales and COGS off the fulfillment day).
  const reverseDialog = (order, stage = null) =>
    formDialog({
      title: `Reverse fulfillment of ${order.orderNumber}`,
      intro: "Tracked stock comes back and is set aside for this order again, and its sales and COGS leave the day it was fulfilled. Payments and commission stay as they are. You can fulfill it again later.",
      fields: [
        { name: "stage", label: "Move it back to", type: "select", value: stage || "ready", options: ["pending", "preparing", "ready"].map((k) => ({ value: k, label: FULFILLMENT_STATUSES[k].label })) },
        { name: "reason", label: "Reason", type: "textarea", required: true, placeholder: "e.g. Marked fulfilled by mistake; not picked up yet" },
      ],
      submitLabel: "Reverse fulfillment",
      onSubmit: (v) => api("orders", { method: "POST", body: { action: "reopen", orderId: order.id, stage: v.stage, reason: v.reason, expectedRevision: order.revision } }),
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
      if (o.fulfillmentStatus === "fulfilled" && isOpenFulfillment(choice)) {
        const result = await reverseDialog(o, choice);
        if (!result) return reset();
        toast(`${o.orderNumber}: fulfillment reversed (${fulfillmentLabel(result.fulfillmentStatus ?? choice)})`, "success");
        return reload();
      }
      if (isOpenFulfillment(choice)) {
        await api("orders", { method: "POST", body: { action: "stage", orderId: o.id, stage: choice } });
        toast(`${o.orderNumber}: ${fulfillmentLabel(choice)}`, "success");
        return reload();
      }
      if (choice === "fulfilled") {
        if (o.fulfillmentStatus === "fulfilled") return reset();
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

  return { onPaymentChoice, onFulfillmentChoice, cancelDialog, reverseDialog };
}
