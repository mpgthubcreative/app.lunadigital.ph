// Public salary receipt page (Phase 14): /receipt#<token>. No login: the
// employee opens the link their employer sent, sees what was paid, and taps
// "I received it". The token comes from the URL fragment (never sent to
// the server as part of the page URL) and is posted to /api/receipt, which
// shows only this payment and accepts the confirmation once.

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";
import { formatCentavos, formatDayId } from "../lib/format.js";

async function call(action, token, fetchImpl) {
  const res = await fetchImpl("/api/receipt", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ action, token }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || "This link isn't valid. Ask your employer for a new one."), { status: res.status });
  return body.receipt;
}

export function renderReceiptPage(root, { token = window.location.hash.slice(1), fetchImpl = (...a) => window.fetch(...a) } = {}) {
  const state = { status: "loading", receipt: null, message: "" };
  // Don't keep the credential in the address bar / history longer than needed.
  try {
    window.history.replaceState(null, "", "/receipt");
  } catch {
    /* not important */
  }
  document.title = "Salary receipt · Luna";

  function draw() {
    const r = state.receipt;
    render(
      root,
      html`<main class="receipt-page" data-role="receipt-page">
        <div class="card receipt-card">
          <div class="brand">${lunaMark()}<span class="brand-text">Luna</span></div>
          ${state.status === "loading"
            ? html`<p>Loading…</p>`
            : state.status === "error"
              ? html`<h1 class="card-title">Link not valid</h1><p data-role="message">${state.message}</p>`
              : html`<h1 class="card-title">${r.confirmed || r.receiptStatus === "confirmed" ? "Thank you, receipt confirmed" : "Confirm your salary"}</h1>
                  <dl class="dl dl-compact">
                    <dt>From</dt><dd>${r.businessName}</dd>
                    <dt>For</dt><dd>${r.employeeName}</dd>
                    <dt>Pay period</dt><dd>${formatDayId(r.period.start)} – ${formatDayId(r.period.end)}</dd>
                    <dt>Amount</dt><dd><strong data-role="amount">${formatCentavos(r.amount)}</strong></dd>
                    ${r.paidDate ? html`<dt>Paid</dt><dd>${formatDayId(r.paidDate)}${r.method ? ` · ${r.method}` : ""}</dd>` : ""}
                  </dl>
                  ${r.receiptStatus === "confirmed"
                    ? html`<p data-role="message">Your confirmation was recorded. You can close this page.</p>`
                    : r.expired
                      ? html`<p data-role="message">This link has expired. Ask your employer for a new one.</p>`
                      : html`<p>Only tap this if you received the full amount.</p><button type="button" class="btn btn-primary" data-act="confirm">I received my salary</button>`}`}
        </div>
      </main>`
    );
  }

  root.addEventListener("click", async (event) => {
    if (!event.target.closest('[data-act="confirm"]')) return;
    event.target.disabled = true;
    try {
      state.receipt = await call("confirm", token, fetchImpl);
    } catch (err) {
      state.status = "error";
      state.message = err.message;
    }
    draw();
  });

  draw();
  if (!token) {
    state.status = "error";
    state.message = "This link isn't valid. Ask your employer for a new one.";
    draw();
    return Promise.resolve();
  }
  return call("view", token, fetchImpl)
    .then((r) => {
      state.status = "ok";
      state.receipt = r;
    })
    .catch((err) => {
      state.status = "error";
      state.message = err.message;
    })
    .then(draw);
}
