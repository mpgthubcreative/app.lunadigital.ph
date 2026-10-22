// A verified payment's receipt (2026-10-22), the same on the customer's
// payment page (/pay/{token}) and in Luna (Payments → Receipt):
//   Business · Order number · Customer · Amount · Method · Reference ·
//   Payment date · Status
// Method and reference stand out: they're what the customer and the
// business check against their GCash / Maya / bank app.
// r: { business, orderNumber, customer, amount (centavos), method (label),
//      reference, date (YYYY-MM-DD), status }

import { html } from "../lib/html.js";
import { formatCentavos, formatDayId } from "../lib/format.js";

export function receiptHtml(r, { currency = "PHP" } = {}) {
  return html`<section class="pay-receipt" data-role="receipt" aria-label="Payment receipt">
    <header class="pay-receipt-head"><span class="pay-receipt-title">Payment receipt</span><span class="pay-receipt-status" data-role="receipt-status">✓ ${r.status || "Verified"}</span></header>
    <p class="pay-receipt-amount" data-role="receipt-amount">${formatCentavos(r.amount, currency)}</p>
    <dl class="pay-receipt-list">
      <dt>Business</dt><dd>${r.business}</dd>
      <dt>Order</dt><dd>${r.orderNumber}</dd>
      ${r.customer ? html`<dt>Customer</dt><dd>${r.customer}</dd>` : ""}
      <dt>Method</dt><dd class="pay-receipt-key" data-role="receipt-method">${r.method}</dd>
      <dt>Reference</dt><dd class="pay-receipt-key" data-role="receipt-reference">${r.reference || "—"}</dd>
      <dt>Payment date</dt><dd>${r.date ? formatDayId(r.date) : "—"}</dd>
    </dl>
  </section>`;
}
