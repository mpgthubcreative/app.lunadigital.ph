// Dashboard — Phase 5 wires these cards to the per-day metrics document
// (businesses/{bid}/metrics/{date}); it never loads the order collection to
// compute totals. Phase 1 renders the layout with empty values.

import { html, render } from "../../lib/html.js";
import { pageHeader, statCard, card, emptyState } from "../../components/ui.js";

const CARDS = [
  { label: "Today's Sales" },
  { label: "Today's Orders" },
  { label: "Paid" },
  { label: "Unpaid" },
  { label: "For Fulfillment" },
  { label: "Low Stock" },
];

export function mount(container, session) {
  render(
    container,
    html`
      ${pageHeader({ title: "Dashboard", subtitle: `Today at ${session.business.name}` })}
      <div class="section stat-grid">
        ${CARDS.map((c) => statCard({ label: c.label, value: "—", hint: "Available in Phase 5" }))}
      </div>
      <div class="section grid grid-2">
        ${card({ title: "Recent Orders", body: emptyState({ iconName: "orders", title: "No orders yet", body: "Orders entered in Luna will appear here." }) })}
        ${card({ title: "Recent Activity", body: emptyState({ iconName: "inbox", title: "No activity yet", body: "Staff actions and alerts will appear here." }) })}
      </div>
    `
  );
}
