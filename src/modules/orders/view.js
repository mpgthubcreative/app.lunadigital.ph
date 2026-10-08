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

// Payment reference / proof arrive with Payments (Phase 8): "—" until then.
export function orderRow(o, { currency = "PHP", timezone } = {}) {
  return {
    id: o.id,
    number: o.orderNumber,
    reference: o.paymentReference || "—",
    proof: o.paymentProof ? "Attached" : "—",
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

const HISTORY_LABEL = { created: "Created", edited: "Edited", fulfilled: "Fulfilled", cancelled: "Cancelled" };

export function historyRows(order, { currency = "PHP", timezone } = {}) {
  return (order.statusHistory || []).map((h) => {
    const details = [];
    if (h.reason) details.push(`Reason: ${h.reason}`);
    for (const l of h.changes?.lines || []) details.push(`${l.sku ?? "Item"}: ${formatQuantity(l.from)} → ${formatQuantity(l.to)}`);
    if (h.changes?.discount) details.push(`Discount ${formatCentavos(h.changes.discount.from, currency)} → ${formatCentavos(h.changes.discount.to, currency)}`);
    if (h.changes?.total) details.push(`Total ${formatCentavos(h.changes.total.from, currency)} → ${formatCentavos(h.changes.total.to, currency)}`);
    if (h.changes?.customer) details.push("Customer details changed");
    if (h.changes?.source) details.push(`Source ${sourceLabel(h.changes.source.from)} → ${sourceLabel(h.changes.source.to)}`);
    return { label: HISTORY_LABEL[h.type] || h.type, actor: h.actor?.name ?? "", when: when(h.at, timezone), details: details.join(" · ") };
  });
}
