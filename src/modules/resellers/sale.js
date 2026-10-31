// Reseller Package (2026-10-31): one order's reseller and commission, in the
// order's View details (Orders): who sold it and the final commission
// ("Adjusted from ₱300" when the Owner changed it), and the Owner's one
// "Reseller & commission" edit: Direct sale or a reseller, the selling
// prices (open orders), and the final commission (blank = calculated).

import { html } from "../../lib/html.js";
import { formDialog } from "../../components/form-dialog.js";
import { formatCentavos } from "../../lib/format.js";
import { parseCentavos } from "@shared/index.js";

export function resellerBlock(order, money) {
  const c = order.commission;
  if (!order.resellerId) return html`<p class="od-note" data-role="reseller"><span class="od-k">Reseller</span> Direct sale · no commission</p>`;
  return html`<dl class="od-totals od-reseller" data-role="reseller">
    <div><dt>Reseller</dt><dd data-role="reseller-name">${order.reseller?.name ?? ""}</dd></div>
    <div><dt>Commission</dt><dd data-role="commission">${money(c?.final ?? 0)}${c?.adjusted ? html` <small class="stat-hint" data-role="adjusted">Adjusted from ${money(c.calculated)}</small>` : ""}</dd></div>
  </dl>`;
}

const toMoney = (v) => (v === null || v === undefined ? "" : String(v / 100));

// The Owner's edit. Commission figures come back from the server.
export async function editResellerSaleDialog({ order, api, currency = "PHP" }) {
  const money = (c) => formatCentavos(c, currency);
  const list = (await api("resellers", { method: "POST", body: { action: "list" } })).resellers || [];
  const choices = list.filter((r) => r.status === "active" || r.id === order.resellerId);
  const open = order.fulfillmentStatus !== "fulfilled";
  const c = order.commission;
  const fields = [
    { name: "resellerId", label: "Sold by", type: "select", value: order.resellerId || "", options: [{ value: "", label: "Direct sale (no reseller)" }, ...choices.map((r) => ({ value: r.id, label: r.status === "active" ? r.name : `${r.name} (inactive)` }))] },
    ...(open && order.resellerId
      ? order.items.map((l) => ({ name: `price_${l.lineId}`, label: `${l.name}: selling price (${currency === "PHP" ? "₱" : currency})`, value: toMoney(l.unitPrice), inputmode: "decimal", hint: Number.isSafeInteger(l.basePrice) ? `Owner price ${money(l.basePrice)}` : "" }))
      : []),
    { name: "finalCommission", label: "Final commission (₱)", value: c?.adjusted ? toMoney(c.final) : "", inputmode: "decimal", hint: c ? `Leave blank to use the calculated commission (${money(c.calculated)}).` : "Leave blank to use the calculated commission." },
  ];
  return formDialog({
    title: `${order.orderNumber}: reseller & commission`,
    intro: open ? "The reseller can't change the final commission; only you can. The calculated commission stays on record beside yours." : "This order is fulfilled: selling prices are booked. You can still change who sold it and the final commission.",
    fields,
    submitLabel: "Save",
    onSubmit: (v) => {
      const body = { action: "editSale", orderId: order.id, expectedRevision: order.revision };
      const nextId = v.resellerId || null;
      if (nextId !== (order.resellerId || null)) body.resellerId = nextId;
      if (open && order.resellerId && nextId) {
        const prices = {};
        for (const l of order.items) {
          const typed = String(v[`price_${l.lineId}`] ?? "").trim();
          if (!typed) continue;
          const price = parseCentavos(typed);
          if (price !== l.unitPrice) prices[l.lineId] = price;
        }
        if (Object.keys(prices).length) body.prices = prices;
      }
      const typed = String(v.finalCommission ?? "").trim();
      if (nextId) {
        if (typed) body.finalCommission = parseCentavos(typed); // ₱0 is a valid commission
        else if (c?.adjusted) body.finalCommission = null; // back to the calculated one
      }
      return api("resellers", { method: "POST", body });
    },
  });
}
