// Pure presentation helpers for the inventory screen. No arithmetic beyond
// shared/quantity.js formatting; balances and costs come from the server.

import { formatQuantity, costUnitsToCentavos, inventoryValue, UNITS, MOVEMENT_TYPES, ADJUSTMENT_REASONS } from "@shared/index.js";
import { formatCentavos } from "../../lib/format.js";

export const unitLabel = (unit) => (UNITS[unit] ? UNITS[unit].label : unit);
export const qty = (scaled, unit) => `${formatQuantity(scaled)} ${unitLabel(unit)}`;
const signed = (scaled, unit) => `${scaled > 0 ? "+" : scaled < 0 ? "−" : "±"}${formatQuantity(Math.abs(scaled))} ${unitLabel(unit)}`;
const avg = (costUnits, currency) => (costUnits === null || costUnits === undefined ? "—" : formatCentavos(costUnitsToCentavos(costUnits), currency));

export function productRow(p, costs, { seesCosts, currency = "PHP" }) {
  const row = {
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category || "—",
    unit: unitLabel(p.unit),
    onHand: formatQuantity(p.onHand),
    reserved: formatQuantity(p.reserved),
    available: formatQuantity(p.available),
    reorderLevel: formatQuantity(p.reorderLevel),
    price: formatCentavos(p.sellingPrice, currency),
    status: p.status,
    isLowStock: p.isLowStock === true,
    hasMovements: (p.movementCount || 0) > 0,
  };
  if (seesCosts) {
    row.avgCost = costs ? avg(costs.avgCostUnits, currency) : "—";
    const hasCost = Boolean(costs) && costs.avgCostUnits !== null && costs.avgCostUnits !== undefined;
    row.value = hasCost ? formatCentavos(inventoryValue(p.onHand, costs.avgCostUnits), currency) : "—";
    // Phase 18.6: estimated profit per unit at today's price and average
    // cost. An estimate only: an order's real COGS is the cost snapshot
    // taken when it was fulfilled, never re-priced with a later cost.
    const unitCost = hasCost ? costUnitsToCentavos(costs.avgCostUnits) : null;
    row.profitPerUnit = hasCost ? formatCentavos(p.sellingPrice - unitCost, currency) : "—";
    row.margin = hasCost && p.sellingPrice > 0 ? `${Math.round(((p.sellingPrice - unitCost) * 1000) / p.sellingPrice) / 10}%` : "—";
    row.isLoss = hasCost && p.sellingPrice < unitCost;
  }
  return row;
}

function when(at) {
  const date = at && typeof at.toDate === "function" ? at.toDate() : at instanceof Date ? at : null;
  return date ? new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(date) : "";
}

// "Received +50 pcs", "Adjustment −3 pcs", "Opening balance +100 pcs",
// "Reserved +2 pcs" (reservations move reserved, not on hand).
export function historyRow(t, cost, { seesCosts, currency = "PHP" }) {
  const def = MOVEMENT_TYPES[t.type] || { label: t.label || t.type };
  const movesReserved = t.type === "reservation" || t.type === "release";
  const label = `${def.label} ${signed(movesReserved ? t.reservedDelta : t.onHandDelta, t.unit)}`;
  const reason = t.reason && ADJUSTMENT_REASONS[t.reason] ? ADJUSTMENT_REASONS[t.reason] : "";
  const row = {
    id: t.id,
    seq: t.seq,
    label,
    when: when(t.at),
    actor: (t.actor && (t.actor.name || t.actor.email)) || "—",
    reason,
    note: t.note || "",
    reference: t.referenceId || "",
    balance: `In stock ${formatQuantity(t.onHandBefore)} → ${formatQuantity(t.onHandAfter)} · Set aside ${formatQuantity(t.reservedBefore)} → ${formatQuantity(t.reservedAfter)}`,
  };
  if (seesCosts && cost) {
    const parts = [];
    if (cost.unitCost !== null && cost.unitCost !== undefined) parts.push(`@ ${formatCentavos(cost.unitCost, currency)}`);
    parts.push(`avg ${avg(cost.avgCostBefore, currency)} → ${avg(cost.avgCostAfter, currency)}`);
    if (cost.costConsumed) parts.push(`cost ${formatCentavos(cost.costConsumed, currency)}`);
    row.cost = parts.join(" · ");
  }
  return row;
}
