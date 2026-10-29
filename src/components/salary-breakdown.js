// The helper's salary breakdown (2026-10-29), the same on the receipt link
// and in their own Luna (My Salary): every line on its own, never folded
// away, from what was saved at payment (netlify/functions/_lib/payroll.js
// receiptBreakdown):
//   Basic pay            Earned through Oct 29          ₱5,754
//   Advance deduction    Oct 12                         − ₱500
//   Bonus                Oct 25 · Performance bonus     + ₱300
//   Other deduction      Oct 26 · Uniform               − ₱150
//   Prepaid salary       2 upcoming days                ₱600
//   Total paid                                          ₱6,004

import { html } from "../lib/html.js";
import { formatCentavos, formatDayId } from "../lib/format.js";

const shortDay = (d) => formatDayId(d).replace(/, \d{4}$/, "");

// What the line is for, in words: "Earned through Oct 29", "Oct 25 · Performance bonus".
export const lineNote = (r) => [r.earnedThrough ? `Earned through ${shortDay(r.earnedThrough)}` : null, r.date ? shortDay(r.date) : null, r.detail || null].filter(Boolean).join(" · ");
const signed = (r, money) => (r.amount < 0 ? `− ${money(-r.amount)}` : r.key === "addition" ? `+ ${money(r.amount)}` : money(r.amount));

export function salaryBreakdown(rows, total, { money = (c) => formatCentavos(c), totalLabel = "Total paid" } = {}) {
  return html`<ul class="slip slip-full" data-role="breakdown">${rows.map((r) => {
      const note = lineNote(r);
      return html`<li data-line="${r.key}"><span class="slip-what">${r.label}${note ? html`<small>${note}</small>` : ""}</span><span class="slip-amt">${signed(r, money)}</span></li>`;
    })}</ul>
    <ul class="slip slip-total slip-total-paid"><li><span class="slip-what"><strong>${totalLabel}</strong></span><span class="slip-amt"><strong class="receipt-net" data-role="net">${money(total)}</strong></span></li></ul>`;
}
