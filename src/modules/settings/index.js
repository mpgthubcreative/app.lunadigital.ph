// Settings: subscription status for anyone with settings.view, and the
// package (plan, modules, features, limits vs usage) only for members with
// billing.view, normally the owner. Everything shown comes from the
// session the server resolved; no plan, price or limit is hard-coded here.
// Billing and plan changes are Luna operations (Super Admin, Phase 13).

import { accessPolicy, MODULES, FEATURE_DEFINITIONS, LIMIT_DEFINITIONS } from "@shared/index.js";
import { html, render } from "../../lib/html.js";
import { pageHeader, card, meter, badge } from "../../components/ui.js";
import { formatBytes, formatNumber } from "../../lib/format.js";

const STATUS_TONE = { active: "success", past_due: "warning", suspended: "danger", cancelled: "danger" };
const STATUS_LABEL = { active: "Active", past_due: "Past due", suspended: "Suspended", cancelled: "Cancelled" };

// usage field for each limit key
const USAGE_FOR_LIMIT = { users: "users", ordersPerMonth: "ordersThisMonth", storageBytes: "storageBytes", importsPerMonth: "importsThisMonth" };

function featureValue(key, value) {
  const def = FEATURE_DEFINITIONS[key];
  if (def.type === "boolean") return value === true ? badge("Included", "success") : badge("Not on your package", "neutral");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function packageCards(session) {
  const { modules, limits, features } = session.entitlements;
  const usage = session.usage || {};
  // Sellable, built modules only; core modules are in every package.
  const sellable = MODULES.filter((m) => m.available && !m.core);

  return html`
    ${card({
      title: "Modules",
      body: html`
        <dl class="dl" id="packageModules">
          ${sellable.map(
            (m) => html`<dt>${m.label}</dt><dd>${modules[m.id] === true ? badge("Included", "success") : badge("Not on your package", "neutral")}</dd>`
          )}
        </dl>
      `,
    })}
    ${card({
      title: "Usage this month",
      body: html`
        ${Object.entries(LIMIT_DEFINITIONS).map(([key, def]) =>
          meter({ label: def.label, used: usage[USAGE_FOR_LIMIT[key]] ?? 0, limit: limits[key], format: def.unit === "bytes" ? formatBytes : formatNumber })
        )}
      `,
    })}
    ${card({
      title: "Features",
      body: html`
        <dl class="dl" id="packageFeatures">
          ${Object.entries(FEATURE_DEFINITIONS).map(([key, def]) => html`<dt>${def.label}</dt><dd>${featureValue(key, features[key])}</dd>`)}
        </dl>
      `,
    })}
  `;
}

export function mount(container, session) {
  const status = session.subscription.status;
  const policy = accessPolicy(status);
  const seesPackage = session.member.permissions["billing.view"] === true && Boolean(session.plan && session.entitlements.limits);

  render(
    container,
    html`
      ${pageHeader({ title: "Settings", subtitle: "Business configuration and subscription." })}
      <div class="grid grid-2">
        ${card({
          title: "Subscription",
          body: html`
            <dl class="dl">
              ${seesPackage ? html`<dt>Plan</dt><dd id="packagePlan">${session.plan.name}</dd>` : ""}
              <dt>Status</dt><dd>${badge(STATUS_LABEL[status] || status, STATUS_TONE[status] || "neutral")}</dd>
              <dt>Access</dt><dd>${policy.canWrite ? "Full access" : "Read-only"}</dd>
            </dl>
            ${seesPackage ? html`<p class="stat-hint">To change your package, contact Luna.</p>` : ""}
          `,
        })}
        ${seesPackage ? packageCards(session) : ""}
      </div>
    `
  );
}
