// Payment actions shared by the Orders and Payments screens: one small
// popover each, then straight back to the list. All amounts are parsed by
// shared/quantity.js; the server derives everything else.

import { html, render } from "../../lib/html.js";
import { formDialog } from "../../components/form-dialog.js";
import { formatCentavos } from "../../lib/format.js";
import { PAYMENT_METHODS, PAYMENT_METHOD_IDS, parseCentavos, normalizeReference } from "@shared/index.js";
import { prepareProof as defaultPrepareProof } from "../../lib/image.js";

const METHOD_OPTIONS = PAYMENT_METHOD_IDS.map((id) => ({ value: id, label: PAYMENT_METHODS[id].label }));
const pesos = (c) => (c / 100).toFixed(2);

export const methodLabel = (id) => PAYMENT_METHODS[id]?.label ?? id;

function checkReference(method, reference) {
  const ref = normalizeReference(reference || "");
  if (PAYMENT_METHODS[method]?.referenceRequired && !ref) throw new Error(`${methodLabel(method)} payments need a reference number`);
  return ref;
}

// "Paid" / "Partially paid" from the Orders row, or Record payment in details.
export function recordPaymentDialog({ order, api, currency = "PHP", fullBalance = true, prepareProof = defaultPrepareProof }) {
  const balance = order.balance ?? order.total - (order.amountPaid || 0);
  return formDialog({
    title: `Payment for ${order.orderNumber}`,
    intro: `Balance ${formatCentavos(balance, currency)} of ${formatCentavos(order.total, currency)}.`,
    fields: [
      { name: "method", label: "Method", type: "select", options: METHOD_OPTIONS, value: "gcash" },
      { name: "amount", label: `Amount (${currency})`, value: fullBalance ? pesos(balance) : "", required: true, inputmode: "decimal" },
      { name: "reference", label: "Reference no.", hint: "Required for GCash, Maya and bank transfers." },
      { name: "proof", label: "Screenshot (optional)", type: "file", accept: "image/jpeg,image/png,image/webp" },
      { name: "note", label: "Note", type: "textarea" },
    ],
    submitLabel: "Save",
    onSubmit: async (v) => {
      const amount = parseCentavos(v.amount);
      if (amount <= 0) throw new Error("Enter an amount");
      if (amount > balance) throw new Error(`That's more than the balance (${formatCentavos(balance, currency)})`);
      const reference = checkReference(v.method, v.reference);
      const proof = v.proof ? await prepareProof(v.proof) : null;
      return api("payments", {
        method: "POST",
        body: { action: "record", orderId: order.id, payment: { amount, method: v.method, ...(reference ? { reference } : {}), ...(v.note ? { note: v.note } : {}) }, ...(proof ? { proof } : {}) },
      });
    },
  });
}

// Edit -> Save for a payment (payments.verify).
export function editPaymentDialog({ payment, api, currency = "PHP", prepareProof = defaultPrepareProof }) {
  return formDialog({
    title: `Edit payment · ${payment.orderNumber}`,
    fields: [
      { name: "method", label: "Method", type: "select", options: METHOD_OPTIONS, value: payment.method },
      { name: "amount", label: `Amount (${currency})`, value: pesos(payment.amount), required: true, inputmode: "decimal" },
      { name: "reference", label: "Reference no.", value: payment.reference || "" },
      { name: "proof", label: payment.proof ? "Replace screenshot (optional)" : "Screenshot (optional)", type: "file", accept: "image/jpeg,image/png,image/webp" },
      { name: "note", label: "Note", type: "textarea", value: payment.note || "" },
    ],
    submitLabel: "Save",
    onSubmit: async (v) => {
      const changes = {};
      const amount = parseCentavos(v.amount);
      if (amount !== payment.amount) changes.amount = amount;
      if (v.method !== payment.method) changes.method = v.method;
      const reference = checkReference(v.method, v.reference);
      if ((reference || null) !== (payment.reference || null)) changes.reference = reference;
      if ((v.note || null) !== (payment.note || null)) changes.note = v.note;
      const proof = v.proof ? await prepareProof(v.proof) : null;
      if (!Object.keys(changes).length && !proof) return { unchanged: true };
      return api("payments", { method: "POST", body: { action: "update", paymentId: payment.id, changes, ...(proof ? { proof } : {}) } });
    },
  });
}

// ⋯ More -> Remove payment (kept in history, stops counting).
export function removePaymentDialog({ payment, api, currency = "PHP" }) {
  return formDialog({
    title: `Remove ${formatCentavos(payment.amount, currency)} payment?`,
    intro: "Use this only for a payment entered by mistake. It stays in the history but no longer counts toward the order.",
    fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
    submitLabel: "Remove payment",
    onSubmit: (v) => api("payments", { method: "POST", body: { action: "void", paymentId: payment.id, reason: v.reason } }),
  });
}

// "View screenshot": fetched through the server, shown in place.
export async function showProof({ api, paymentId, title = "Payment screenshot" }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  const paint = (body) =>
    render(
      backdrop,
      html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${title}" data-role="proof-viewer">
        <div class="modal-header"><h2 class="card-title">${title}</h2></div>
        <div class="modal-body proof-body">${body}</div>
        <div class="modal-footer"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>
      </div>`
    );
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest('[data-act="close"]')) close();
  });
  paint(html`<p class="stat-hint">Loading…</p>`);
  try {
    const proof = await api("payments", { method: "POST", body: { action: "proof", paymentId } });
    if (!/^image\/(jpeg|png|webp)$/.test(proof.contentType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof.dataBase64 || "")) throw new Error("Unexpected file");
    paint(html`<img class="proof-image" alt="${title}" src="data:${proof.contentType};base64,${proof.dataBase64}" />`);
  } catch (err) {
    paint(html`<p class="form-error">${err.message || "Couldn't load the screenshot."}</p>`);
  }
}
