// Payment actions shared by the Orders and Payments screens: one small
// popover each, then straight back to the list. All amounts are parsed by
// shared/quantity.js; the server derives everything else.

import { html, render } from "../../lib/html.js";
import { formDialog } from "../../components/form-dialog.js";
import { formatCentavos } from "../../lib/format.js";
import { PAYMENT_METHODS, PAYMENT_METHOD_IDS, parseCentavos, normalizeReference } from "@shared/index.js";
import { prepareProof as defaultPrepareProof, PHOTO_ACCEPT } from "../../lib/image.js";
import { bindReferenceDetection, detectReference } from "../../lib/payment-reference.js";
import { receiptHtml } from "../../components/payment-receipt.js";

const METHOD_OPTIONS = PAYMENT_METHOD_IDS.map((id) => ({ value: id, label: PAYMENT_METHODS[id].label }));
const pesos = (c) => (c / 100).toFixed(2);

export const methodLabel = (id) => PAYMENT_METHODS[id]?.label ?? id;

// GCash / Maya / bank transfer: the reference number OR a screenshot.
function checkReference(method, reference, hasProof = false) {
  const ref = normalizeReference(reference || "");
  if (PAYMENT_METHODS[method]?.referenceRequired && !ref && !hasProof) throw new Error(`${methodLabel(method)} payments need the reference number or a screenshot`);
  return ref;
}

// "Paid" / "Partially paid" from the Orders row, or Record payment in details.
export function recordPaymentDialog({ order, api, currency = "PHP", fullBalance = true, prepareProof = defaultPrepareProof, detect = detectReference }) {
  const balance = order.balance ?? order.total - (order.amountPaid || 0);
  return formDialog({
    title: `Payment for ${order.orderNumber}`,
    intro: `Balance ${formatCentavos(balance, currency)} of ${formatCentavos(order.total, currency)}.`,
    fields: [
      { name: "method", label: "Method", type: "select", options: METHOD_OPTIONS, value: "gcash" },
      { name: "amount", label: `Amount (${currency})`, value: fullBalance ? pesos(balance) : "", required: true, inputmode: "decimal" },
      { name: "proof", label: "Screenshot", type: "file", accept: PHOTO_ACCEPT, hint: "GCash, Maya and bank transfers: a screenshot or the reference number is enough." },
      { name: "reference", label: "Reference no.", hint: "Filled in from the screenshot when Luna can read it; check it." },
      { name: "note", label: "Note", type: "textarea" },
    ],
    submitLabel: "Save",
    onFormChange: (form) => bindReferenceDetection(form, { detect }),
    onSubmit: async (v) => {
      const amount = parseCentavos(v.amount);
      if (amount <= 0) throw new Error("Enter an amount");
      if (amount > balance) throw new Error(`That's more than the balance (${formatCentavos(balance, currency)})`);
      const reference = checkReference(v.method, v.reference, Boolean(v.proof));
      const proof = v.proof ? await prepareProof(v.proof) : null;
      return api("payments", {
        method: "POST",
        body: { action: "record", orderId: order.id, payment: { amount, method: v.method, ...(reference ? { reference } : {}), ...(v.note ? { note: v.note } : {}) }, ...(proof ? { proof } : {}) },
      });
    },
  });
}

// Edit -> Save for a payment (payments.verify).
export function editPaymentDialog({ payment, api, currency = "PHP", prepareProof = defaultPrepareProof, detect = detectReference }) {
  return formDialog({
    title: `Edit payment · ${payment.orderNumber}`,
    fields: [
      { name: "method", label: "Method", type: "select", options: METHOD_OPTIONS, value: payment.method },
      { name: "amount", label: `Amount (${currency})`, value: pesos(payment.amount), required: true, inputmode: "decimal" },
      { name: "reference", label: "Reference no.", value: payment.reference || "" },
      { name: "proof", label: payment.proof ? "Replace screenshot (optional)" : "Screenshot (optional)", type: "file", accept: PHOTO_ACCEPT },
      { name: "note", label: "Note", type: "textarea", value: payment.note || "" },
    ],
    submitLabel: "Save",
    onFormChange: (form) => bindReferenceDetection(form, { detect }),
    onSubmit: async (v) => {
      const changes = {};
      const amount = parseCentavos(v.amount);
      if (amount !== payment.amount) changes.amount = amount;
      if (v.method !== payment.method) changes.method = v.method;
      const reference = checkReference(v.method, v.reference, Boolean(v.proof || payment.proof));
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

// Reject / Needs correction (2026-10-22): a payment the customer sent from
// the order's payment link that doesn't check out. It stops counting (like
// Remove); the customer sees "Not accepted" and this reason on their link,
// so they can send it again correctly.
export function rejectPaymentDialog({ payment, api, currency = "PHP" }) {
  return formDialog({
    title: `Not accepted: ${formatCentavos(payment.amount, currency)}?`,
    intro: "The customer sees this on their payment link and can send the payment again. It no longer counts toward the order.",
    fields: [{ name: "reason", label: "What needs correcting", type: "textarea", required: true, placeholder: "e.g. The screenshot shows ₱900, not ₱1,000" }],
    submitLabel: "Not accepted",
    onSubmit: (v) => api("payments", { method: "POST", body: { action: "void", paymentId: payment.id, reason: v.reason } }),
  });
}

// A verified payment's receipt (the same as the customer's), with Print.
export const receiptOf = (payment, businessName) => ({ business: businessName, orderNumber: payment.orderNumber, customer: payment.customerName || "", amount: payment.amount, method: methodLabel(payment.method), reference: payment.reference || null, date: payment.receivedDay || null, status: "Verified" });
export function showReceipt({ payment, businessName, currency = "PHP" }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  document.body.appendChild(backdrop);
  render(
    backdrop,
    html`<div class="modal" role="dialog" aria-modal="true" aria-label="Payment receipt" data-role="receipt-viewer">
      <div class="modal-body">${receiptHtml(receiptOf(payment, businessName), { currency })}</div>
      <div class="modal-footer"><button type="button" class="btn" data-act="print">Print</button><button type="button" class="btn btn-primary" data-act="close">Close</button></div>
    </div>`
  );
  backdrop.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (e.target === backdrop || act === "close") backdrop.remove();
    if (act === "print") {
      const target = backdrop.querySelector('[data-role="receipt"]');
      target.classList.add("is-print-target");
      document.body.classList.add("is-printing-receipt");
      try {
        window.print();
      } finally {
        document.body.classList.remove("is-printing-receipt");
        target.classList.remove("is-print-target");
      }
    }
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
