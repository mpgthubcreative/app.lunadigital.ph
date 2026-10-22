// An order's payment page (2026-10-22): /pay/{token}. No login, no Luna
// navigation; one column, phone first.
//   Business name
//   Order BA-20261022-001 · Ana Reyes
//   Total ₱5,000 · Paid ₱2,000 · Waiting for verification ₱0
//   Amount due ₱3,000
//   How to pay (the business's instructions)
//   Payment method  (GCash) (Maya) (Bank transfer)
//   Amount · Payment screenshot · Reference number · [Submit payment]
//   Your payments: waiting / verified (receipt) / not accepted (why)
// A screenshot is converted in the browser (HEIC → JPEG, turned upright,
// shrunk: src/lib/image.js), then Luna tries to read the reference from it
// and fills it in for the customer to check and correct. A screenshot OR
// the reference number is enough. The server (/api/pay) checks everything
// again; a payment counts only when the business verifies it.

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";
import { formatCentavos, formatDayId } from "../lib/format.js";
import { receiptHtml } from "../components/payment-receipt.js";
import { prepareProof as defaultPrepareProof, PHOTO_ACCEPT } from "../lib/image.js";
import { detectReference as defaultDetect, warmReader } from "../lib/payment-reference.js";
import { parseCentavos, normalizeReference, payTokenFrom } from "@shared/index.js";

const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
const STATE = { for_verification: "Waiting for verification", verified: "Verified", not_accepted: "Not accepted" };

async function call(body, fetchImpl) {
  const res = await fetchImpl("/api/pay", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || "Something went wrong. Please try again."), { status: res.status, code: data.error });
  return data;
}
const blobOf = (proof) => {
  const bytes = Uint8Array.from(atob(proof.dataBase64), (c) => c.charCodeAt(0));
  return new File([bytes], "screenshot.jpg", { type: proof.contentType });
};

export function renderPayPage(root, { token = payTokenFrom(window.location.pathname), fetchImpl = (...a) => window.fetch(...a), prepareProof = defaultPrepareProof, detect = defaultDetect, warm = warmReader } = {}) {
  const state = { status: "loading", message: "", view: null, method: "gcash", amount: "", reference: "", refAuto: false, refHint: "", proof: null, proofName: "", proofBusy: false, website: "", key: newKey(), busy: false, error: "", sent: "" };
  const money = (c) => formatCentavos(c, state.view?.currency || "PHP");

  function paymentsList(list) {
    if (!list.length) return "";
    return html`<section class="pay-card" data-role="payments"><h2 class="pay-h2">Your payments</h2>
      <ul class="pay-list">${list.map(
        (p) => html`<li class="pay-item" data-state="${p.state}">
          <div class="pay-item-row"><span class="pay-item-what">${money(p.amount)} · ${p.method}${p.reference ? html` · <span class="pay-ref">${p.reference}</span>` : ""}</span><span class="pay-chip" data-state="${p.state}">${STATE[p.state] ?? p.state}</span></div>
          <div class="pay-item-sub">${p.date ? formatDayId(p.date) : ""}${p.state === "not_accepted" && p.reason ? html` · <span data-role="reason">${p.reason}</span>` : ""}</div>
          ${p.receipt ? html`<details class="pay-receipt-fold"><summary>View receipt</summary>${receiptHtml(p.receipt, { currency: state.view.currency })}</details>` : ""}
        </li>`
      )}</ul></section>`;
  }

  function form(v) {
    return html`<form class="pay-card pay-form" data-role="pay-form" novalidate>
      <h2 class="pay-h2">Send your payment</h2>
      <fieldset class="pay-methods"><legend>Payment method</legend>
        ${v.methods.map((m) => html`<label class="pay-method${state.method === m.id ? " is-on" : ""}"><input type="radio" name="method" value="${m.id}" ${state.method === m.id ? "checked" : ""} /> ${m.label}</label>`)}
      </fieldset>
      <div class="field"><label for="pay-amount">Amount (₱)</label><input class="input" id="pay-amount" name="amount" inputmode="decimal" autocomplete="off" value="${state.amount}" /><div class="stat-hint">Up to ${money(v.order.due)}. You can pay part now and the rest later.</div></div>
      <div class="field"><span class="pay-label">Payment screenshot</span>
        <div class="pay-file-row">${state.proof ? html`<img class="pay-thumb" data-role="proof-thumb" alt="Your screenshot" src="data:${state.proof.contentType};base64,${state.proof.dataBase64}" />` : ""}<label class="btn pay-file">${state.proof ? "Change screenshot" : "Choose screenshot"}<input class="pay-file-input" id="pay-proof" name="proof" type="file" accept="${PHOTO_ACCEPT}" /></label></div>
        <div class="stat-hint" data-role="proof-state">${state.proofBusy ? "Preparing the screenshot…" : state.proof ? `Added ✓ ${state.proofName}` : "A screenshot of the GCash, Maya or bank confirmation."}</div></div>
      <div class="field"><label for="pay-ref">Reference number</label><input class="input" id="pay-ref" name="reference" autocomplete="off" autocapitalize="characters" value="${state.reference}" /><div class="stat-hint" data-role="ref-hint">${state.refHint || "The screenshot or the reference number is enough."}</div></div>
      <div class="pay-trap" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off" value="" /></label></div>
      <p class="form-error" role="alert" data-role="pay-error" ${state.error ? "" : "hidden"}>${state.error}</p>
      <button type="submit" class="btn btn-primary pay-submit" ${state.busy || state.proofBusy ? "disabled" : ""}>${state.busy ? "Sending…" : "Submit payment"}</button>
    </form>`;
  }

  function draw() {
    const v = state.view;
    render(
      root,
      html`<div class="pay-page">
        <header class="pay-top">${v ? html`<span class="pay-business" data-role="business">${v.business.name}</span>` : ""}</header>
        <main class="pay-main">
          ${state.status === "loading"
            ? html`<p class="pay-note">Loading…</p>`
            : state.status === "error"
              ? html`<section class="pay-card"><h1 class="pay-h1">Payment link</h1><p class="pay-note" data-role="pay-problem">${state.message}</p></section>`
              : html`
                <section class="pay-card" data-role="summary">
                  <h1 class="pay-h1">Order ${v.order.orderNumber}</h1>
                  ${v.order.customer ? html`<p class="pay-note" data-role="customer">${v.order.customer}</p>` : ""}
                  <dl class="pay-sum">
                    <dt>Order total</dt><dd data-role="total">${money(v.order.total)}</dd>
                    <dt>Paid</dt><dd data-role="paid">${money(v.order.paid)}</dd>
                    ${v.order.pending ? html`<dt>Waiting for verification</dt><dd data-role="pending">${money(v.order.pending)}</dd>` : ""}
                  </dl>
                  <p class="pay-due" data-role="due"><span>Amount due</span><b>${money(v.order.due)}</b></p>
                  ${v.order.cancelled ? html`<p class="pay-note" data-role="cancelled">This order was cancelled. Please message ${v.business.name} if you have questions.</p>` : !v.order.payable ? html`<p class="pay-done" data-role="paid-full">${v.order.pending ? "Thank you! Your payment is waiting for verification." : "Fully paid. Thank you!"}</p>` : ""}
                </section>
                ${state.sent ? html`<p class="pay-sent" role="status" data-role="sent">${state.sent}</p>` : ""}
                ${v.order.payable && v.instructions ? html`<section class="pay-card" data-role="instructions"><h2 class="pay-h2">How to pay</h2><p class="pay-instructions">${v.instructions}</p></section>` : ""}
                ${v.order.payable ? form(v) : ""}
                ${paymentsList(v.payments)}`}
        </main>
        <footer class="pay-foot">${lunaMark()}<span>Payments by Luna</span></footer>
      </div>`
    );
  }

  async function load() {
    try {
      state.view = await call({ action: "view", token }, fetchImpl);
      state.status = "ready";
      if (!state.amount) state.amount = state.view.order.due ? (state.view.order.due / 100).toFixed(2) : "";
    } catch (err) {
      state.status = "error";
      state.message = err.status === 404 || !token ? "This payment link isn't valid. Ask the business for the current link." : err.message;
    }
    draw();
  }

  // A screenshot: convert it, keep it, then try to read its reference.
  async function onProof(file) {
    state.error = "";
    if (!file) {
      state.proof = null;
      state.proofName = "";
      return draw();
    }
    state.proofBusy = true;
    draw();
    try {
      state.proof = await prepareProof(file);
      state.proofName = file.name || "screenshot";
    } catch (err) {
      state.proof = null;
      state.proofName = "";
      state.error = err.message || "That file couldn't be used. Choose a screenshot.";
    }
    state.proofBusy = false;
    if (state.proof && (!state.reference.trim() || state.refAuto)) {
      state.refHint = "Reading the reference from the screenshot…";
      draw();
      const ref = await detect(blobOf(state.proof)).catch(() => null);
      // Never overwrite what the customer typed meanwhile.
      if (ref && (!state.reference.trim() || state.refAuto)) {
        state.reference = ref;
        state.refAuto = true;
        state.refHint = "Read from the screenshot: check it and correct it if needed.";
      } else if (!ref) state.refHint = "Couldn't read a reference. The screenshot alone is enough, or type the reference.";
    }
    draw();
  }

  async function onSubmit() {
    const v = state.view;
    state.error = "";
    let payment;
    try {
      let amount;
      try {
        amount = parseCentavos(state.amount);
      } catch {
        throw new Error("Enter the amount you paid, e.g. 2500 or 2,500.50");
      }
      if (!(amount > 0)) throw new Error("Enter the amount you paid");
      if (amount > v.order.due) throw new Error(`That's more than the amount due (${money(v.order.due)})`);
      let reference = "";
      try {
        reference = normalizeReference(state.reference);
      } catch {
        throw new Error("Check the reference number: 4 to 40 letters or digits");
      }
      if (!reference && !state.proof) throw new Error("Add the payment screenshot or the reference number");
      payment = { amount, method: state.method, ...(reference ? { reference } : {}) };
    } catch (err) {
      state.error = err.message;
      return draw();
    }
    state.busy = true;
    draw();
    try {
      await call({ action: "submit", token, idempotencyKey: state.key, payment, ...(state.proof ? { proof: state.proof } : {}), website: state.website }, fetchImpl);
      state.sent = `Payment sent ✓ ${money(payment.amount)} via ${v.methods.find((m) => m.id === payment.method)?.label}. ${v.business.name} will verify it; this page shows it once verified.`;
      Object.assign(state, { key: newKey(), amount: "", reference: "", refAuto: false, refHint: "", proof: null, proofName: "" });
      state.busy = false;
      await load();
      return undefined;
    } catch (err) {
      state.busy = false;
      state.error = err.message;
      return draw();
    }
  }

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "method") {
      state.method = t.value;
      draw();
    } else if (t.name === "proof") onProof(t.files?.[0] ?? null);
  });
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.name === "amount") state.amount = t.value;
    if (t.name === "reference") {
      state.reference = t.value;
      state.refAuto = false; // the customer's own correction stays
    }
    if (t.name === "website") state.website = t.value;
  });
  // Start loading the reader while they pick a screenshot.
  root.addEventListener("click", (e) => {
    if (e.target.name === "proof") warm();
  });
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    onSubmit();
  });
  draw();
  return load();
}
