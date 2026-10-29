// Give an advance (Owner-pilot polish 2026-10-16), one flow wherever it's
// opened: Advances, and an employee's More actions → Give advance
// (Attendance & Pay, the payslip; 2026-10-29). Helper, Amount, Deduct on
// (Next payroll / Split repayment / No payroll deduction), with what's
// available shown and checked before sending; date (today), method (last
// used, else Cash), reference, proof and note under More options. The result
// shows what's owed now and the next deduction. The advance feeds payroll
// exactly as before (the server's repayment plan).

import { html, render } from "../../lib/html.js";
import { formDialog } from "../../components/form-dialog.js";
import { formatCentavos } from "../../lib/format.js";
import { SALARY_METHODS, parseCentavos, advanceCapacity } from "@shared/index.js";
import { prepareProof, PHOTO_OR_PDF_ACCEPT } from "../../lib/image.js";
import { editPlan, periodText, methodOptions } from "./plan.js";

// One request key per dialog: a double tap or retry records once.
const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
const METHOD_KEY = "luna.advance.method";
const lastMethod = () => {
  try {
    const m = localStorage.getItem(METHOD_KEY);
    return SALARY_METHODS[m] ? m : "cash";
  } catch {
    return "cash";
  }
};

// staff: the helpers who can get one; advances: their advances (for what's
// available under a limit); preset: the helper to start with.
// Resolves the result once the Owner closed it, or null (cancelled).
export async function giveAdvance({ staff, advances = [], preset = "", today, api, toast }) {
  if (!staff.length) {
    toast("Add household staff first.", "danger");
    return null;
  }
  const availableFor = (s) => (s && Number.isSafeInteger(s.advanceLimit) ? advanceCapacity(s, advances.filter((a) => a.staffId === s.id)).available : null);
  const first = staff.find((s) => s.id === preset) || staff[0];
  const idempotencyKey = newKey();
  const r = await formDialog({
    title: "Give an advance",
    intro: staff.length === 1 || preset ? (availableFor(first) !== null ? `Available to advance: ${formatCentavos(availableFor(first))}.` : "") : "",
    fields: [
      { name: "staffId", label: "Helper", type: "select", value: first.id, options: staff.map((s) => ({ value: s.id, label: availableFor(s) !== null ? `${s.name} · ${formatCentavos(availableFor(s))} available` : s.name })) },
      { name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" },
      { name: "plan", label: "Deduct on", type: "select", value: "next", options: [{ value: "next", label: "Next unpaid payroll" }, { value: "split", label: "Split repayment" }, { value: "none", label: "No payroll deduction" }] },
      { name: "date", label: "Date given", type: "date", value: today, max: today, more: true, default: true },
      { name: "method", label: "How", type: "select", value: lastMethod(), options: methodOptions(), more: true },
      { name: "reference", label: "Reference (optional)", more: true },
      { name: "proof", label: "Proof (screenshot or PDF, optional)", type: "file", accept: PHOTO_OR_PDF_ACCEPT, more: true },
      { name: "description", label: "Note (optional)", more: true, placeholder: "e.g. Fare home" },
    ],
    submitLabel: "Give advance",
    moreLabel: "More options",
    onSubmit: async (v) => {
      const s = staff.find((x) => x.id === v.staffId);
      const amount = parseCentavos(v.amount);
      const avail = availableFor(s);
      if (avail !== null && amount > avail) throw new Error(`Maximum available is ${formatCentavos(avail)}.`);
      const proof = v.proof ? await prepareProof(v.proof, { pdf: true }) : null;
      const res = await api({ action: "give", advance: { staffId: v.staffId, date: v.date || today, amount, method: v.method, plan: v.plan === "none" || v.plan === "split" ? "none" : "next", ...(v.description?.trim() ? { description: v.description.trim() } : {}), ...(v.reference?.trim() ? { reference: v.reference.trim() } : {}) }, ...(proof ? { proof } : {}), idempotencyKey });
      try {
        localStorage.setItem(METHOD_KEY, v.method);
      } catch {
        /* per-device convenience only */
      }
      return { ...res, amount, plan: v.plan, staff: s };
    },
  });
  if (!r) return null;
  // Split: the plan editor for this new advance (the money is already recorded).
  let schedule = r.schedule;
  if (r.plan === "split") {
    const planned = await editPlan({ advance: { id: r.advanceId, amount: r.amount, deductedAmount: 0, repaidAmount: 0, status: "paid", schedule: [] }, staff: r.staff, today, api });
    if (planned?.schedule) schedule = planned.schedule;
  }
  await quickResult({ name: r.staffName || r.staff?.name, amount: r.amount, outstanding: r.outstanding, next: (schedule || []).find((e) => e.state === "planned") || null, available: r.available });
  return r;
}

// The result at a glance (one tap to close).
function quickResult({ name, amount, outstanding, next, available }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    render(
      backdrop,
      html`<div class="modal" role="dialog" aria-modal="true" aria-label="Advance given" data-role="advance-result">
        <div class="modal-header"><h2 class="card-title">${name}</h2></div>
        <div class="modal-body">
          <dl class="adv-result">
            <dt>Advance given</dt><dd>${formatCentavos(amount)}</dd>
            <dt>Outstanding</dt><dd data-role="result-outstanding">${formatCentavos(outstanding ?? amount)}</dd>
            <dt>Next deduction</dt><dd>${next ? html`${formatCentavos(next.amount)} <small>${periodText(next)}</small>` : "None planned"}</dd>
            ${available !== null && available !== undefined ? html`<dt>Still available</dt><dd>${formatCentavos(available)}</dd>` : ""}
          </dl>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-primary" data-x="close">OK</button></div>
      </div>`
    );
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop || event.target.closest('[data-x="close"]')) {
        backdrop.remove();
        resolve();
      }
    });
  });
}
