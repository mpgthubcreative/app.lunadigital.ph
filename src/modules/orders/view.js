// Pure presentation helpers for orders. Totals shown while composing an
// order use shared/orders.js computeTotals for a preview only; the server
// recomputes everything from trusted product documents.

import { ORDER_SOURCES, FULFILLMENT_STATUSES, PAYMENT_STATUSES, formatQuantity, UNITS } from "@shared/index.js";
import { formatCentavos } from "../../lib/format.js";

export const sourceLabel = (id) => ORDER_SOURCES[id]?.label ?? id;
export const fulfillmentLabel = (id) => FULFILLMENT_STATUSES[id]?.label ?? id;
export const paymentLabel = (id) => PAYMENT_STATUSES[id]?.label ?? id;
export const qtyText = (scaled, unit) => `${formatQuantity(scaled)} ${UNITS[unit]?.label ?? unit}`;

export const FULFILLMENT_TONE = { pending: "warning", fulfilled: "success", cancelled: "neutral" };
export const PAYMENT_TONE = { unpaid: "danger", partial: "warning", paid: "success" };

function toDate(at) {
  if (!at) return null;
  if (typeof at.toDate === "function") return at.toDate();
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function when(at, timezone) {
  const d = toDate(at);
  return d ? new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: timezone || "Asia/Manila" }).format(d) : "";
}

export function orderRow(o, { currency = "PHP", timezone } = {}) {
  return {
    id: o.id,
    number: o.orderNumber,
    // Latest reference, with "+N" when the order has more payments.
    reference: o.lastPaymentRef ? `${o.lastPaymentRef}${o.paymentCount > 1 ? ` (+${o.paymentCount - 1})` : ""}` : o.paymentCount > 1 ? `${o.paymentCount} payments` : "—",
    proofPaymentId: o.lastProofPaymentId || null,
    when: when(o.createdAt, timezone) || o.orderDate,
    customer: o.customer?.name ?? "",
    source: sourceLabel(o.source),
    items: o.items?.length === 1 ? `${o.items[0].name} × ${qtyText(o.items[0].quantity, o.items[0].unit)}` : `${o.itemCount} items`,
    total: formatCentavos(o.total, currency),
    paymentStatus: o.paymentStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    createdBy: o.createdBy?.name ?? "",
  };
}

const HISTORY_LABEL = { created: "Order created", edited: "Order edited", corrected: "Order corrected", fulfilled: "Fulfilled", cancelled: "Cancelled" };
const signedQty = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatQuantity(Math.abs(n))}`;

// "Oct 8, 2026, 10:42 AM • Carlo • Qty changed 10 → 8" plus the automatic
// consequences ("Inventory corrected +2", "Sales ₱750.00 → ₱600.00").
// Cost figures never appear here; they live in orderCosts (financials only).
export function historyRows(order, { currency = "PHP", timezone } = {}) {
  return (order.statusHistory || []).map((h) => {
    const lines = [];
    for (const l of h.changes?.lines || []) {
      const what = l.from === 0 ? `${l.sku ?? "Item"} added (${formatQuantity(l.to)})` : l.to === 0 ? `${l.sku ?? "Item"} removed (was ${formatQuantity(l.from)})` : `${l.sku ?? "Item"}: Qty changed ${formatQuantity(l.from)} → ${formatQuantity(l.to)}`;
      lines.push(what);
    }
    const effects = [];
    for (const l of h.changes?.lines || []) if (h.type === "corrected" && l.inventory) effects.push(`Inventory corrected ${signedQty(l.inventory)}${l.sku ? ` (${l.sku})` : ""}`);
    if (h.changes?.sales) effects.push(`Sales adjusted ${formatCentavos(h.changes.sales.from, currency)} → ${formatCentavos(h.changes.sales.to, currency)}`);
    if (h.changes?.total) effects.push(`Total ${formatCentavos(h.changes.total.from, currency)} → ${formatCentavos(h.changes.total.to, currency)}`);
    if (h.changes?.discount) lines.push(`Discount ${formatCentavos(h.changes.discount.from, currency)} → ${formatCentavos(h.changes.discount.to, currency)}`);
    if (h.changes?.customer) lines.push("Customer details changed");
    if (h.changes?.source) lines.push(`Source ${sourceLabel(h.changes.source.from)} → ${sourceLabel(h.changes.source.to)}`);
    if (h.reason) lines.push(`Reason: ${h.reason}`);
    const actor = h.actor?.name ?? "";
    const stamp = when(h.at, timezone);
    const summary = lines.length && (h.type === "edited" || h.type === "corrected") ? lines.join(" · ") : HISTORY_LABEL[h.type] || h.type;
    return { type: h.type, label: HISTORY_LABEL[h.type] || h.type, actor, when: stamp, headline: [stamp, actor, summary].filter(Boolean).join(" • "), effects, details: lines.join(" · ") };
  });
}

// Financial users: the COGS side of each correction, from orderCosts.
export function costCorrectionRows(costs, { currency = "PHP", timezone } = {}) {
  return (costs?.corrections || []).map((c) => ({
    headline: [when(c.at, timezone), c.actor?.name ?? ""].filter(Boolean).join(" • "),
    text: `COGS adjusted ${formatCentavos(c.before.cogs, currency)} → ${formatCentavos(c.after.cogs, currency)} · Net sales ${formatCentavos(c.before.netSales, currency)} → ${formatCentavos(c.after.netSales, currency)}`,
  }));
}
