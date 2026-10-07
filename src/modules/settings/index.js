// Settings — Phase 1 shows the subscription summary and usage meters, all
// read from the session's entitlements (never from hard-coded numbers).
// Business configuration forms arrive with the phases that need them.

import { accessPolicy } from "@shared/index.js";
import { html, render } from "../../lib/html.js";
import { pageHeader, card, meter, badge } from "../../components/ui.js";
import { formatBytes, formatNumber } from "../../lib/format.js";

const STATUS_TONE = { active: "success", past_due: "warning", suspended: "danger", cancelled: "danger" };
const STATUS_LABEL = { active: "Active", past_due: "Past due", suspended: "Suspended", cancelled: "Cancelled" };

export function mount(container, session) {
  const { limits } = session.entitlements;
  const usage = session.usage;
  const status = session.subscription.status;
  const policy = accessPolicy(status);

  render(
    container,
    html`
      ${pageHeader({ title: "Settings", subtitle: "Business configuration and subscription." })}
      <div class="grid grid-2">
        ${card({
          title: "Subscription",
          body: html`
            <dl class="dl">
              <dt>Plan</dt><dd>${session.plan.name}</dd>
              <dt>Status</dt><dd>${badge(STATUS_LABEL[status] || status, STATUS_TONE[status] || "neutral")}</dd>
              <dt>Access</dt><dd>${policy.canWrite ? "Full access" : "Read-only"}</dd>
            </dl>
          `,
        })}
        ${card({
          title: "Usage this month",
          body: html`
            ${meter({ label: "Orders", used: usage.ordersThisMonth, limit: limits.ordersPerMonth, format: formatNumber })}
            ${meter({ label: "Users", used: usage.users, limit: limits.users, format: formatNumber })}
            ${meter({ label: "Storage", used: usage.storageBytes, limit: limits.storageBytes, format: formatBytes })}
            ${meter({ label: "Imports", used: usage.importsThisMonth, limit: limits.importsPerMonth, format: formatNumber })}
          `,
        })}
      </div>
    `
  );
}
