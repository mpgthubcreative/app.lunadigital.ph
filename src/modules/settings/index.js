// Settings: subscription status for anyone with settings.view, and the
// package (plan, modules, features, limits vs usage) only for members with
// billing.view, normally the owner. Everything shown comes from the
// session the server resolved; no plan, price or limit is hard-coded here.
// Billing and plan changes are Luna operations (Super Admin, Phase 14).
//
// Phase 18: usage comes from the shared metering registry
// (shared/metering.js). Plan limits are meters with a bar and a
// percentage; informational counters are plain numbers (no fake bars);
// file storage is a current total; history (last 12 months) is loaded on
// request from GET /api/usage.

import { accessPolicy, MODULES, FEATURE_DEFINITIONS, LIMIT_KEYS, LIMIT_METER, LIMIT_DEFINITIONS, METERS, MONTHLY_METER_IDS, isEnforced, meterApplies } from "@shared/index.js";
import { html, render } from "../../lib/html.js";
import { pageHeader, card, meter, badge } from "../../components/ui.js";
import { formatBytes, formatNumber } from "../../lib/format.js";
import { api } from "../../lib/api.js";

const STATUS_TONE = { active: "success", past_due: "warning", suspended: "danger", cancelled: "danger" };
const STATUS_LABEL = { active: "Active", past_due: "Past due", suspended: "Suspended", cancelled: "Cancelled" };
const fmtFor = (unit) => (unit === "bytes" ? formatBytes : formatNumber);

function featureValue(key, value) {
  const def = FEATURE_DEFINITIONS[key];
  if (def.type === "boolean") return value === true ? badge("Included", "success") : badge("Not on your package", "neutral");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Informational monthly counters that mean something for this business.
const activityMeters = (entitlements) => MONTHLY_METER_IDS.filter((id) => !isEnforced(id) && meterApplies(id, entitlements));
// Monthly columns of the history table: limited ones first, then activity.
const historyMeters = (entitlements) => MONTHLY_METER_IDS.filter((id) => meterApplies(id, entitlements));

function historyTable(rows, entitlements) {
  const ids = historyMeters(entitlements);
  const cell = (v) => (v === null ? html`<span class="stat-hint">—</span>` : formatNumber(v));
  return html`<div class="table-wrap"><table class="table table-compact" data-role="usage-history">
    <thead><tr><th>Month</th>${ids.map((id) => html`<th class="num">${METERS[id].label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) =>
      r.recorded
        ? html`<tr data-period="${r.period}"><td>${r.period}</td>${ids.map((id) => html`<td class="num">${cell(r.values[id])}</td>`)}</tr>`
        : html`<tr data-period="${r.period}"><td>${r.period}</td><td colspan="${ids.length}" class="stat-hint">No recorded usage</td></tr>`
    )}</tbody></table></div>
    <p class="stat-hint">— = not measured that month. File storage and active users are current totals (above), not monthly.</p>`;
}

function packageCards(session) {
  const { modules, limits, features } = session.entitlements;
  const values = session.usage?.values || {};
  // Sellable, built modules only; core modules are in every package.
  const sellable = MODULES.filter((m) => m.available && !m.core);
  const activity = activityMeters(session.entitlements);

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
      title: "Plan limits",
      body: html`
        <div data-role="limits">
          ${LIMIT_KEYS.map((key) => {
            const meterId = LIMIT_METER[key];
            const m = METERS[meterId];
            const label = m.kind === "monthly" ? `${LIMIT_DEFINITIONS[key].label} (this month)` : LIMIT_DEFINITIONS[key].label;
            return html`<div data-limit="${key}">${meter({ label, used: values[meterId] ?? 0, limit: limits[key], format: fmtFor(m.unit), showPercent: true })}</div>`;
          })}
        </div>
        ${session.usage?.period ? html`<p class="stat-hint">Monthly limits reset each calendar month (${session.usage.period}, business time). To raise a limit, contact Luna.</p>` : ""}
      `,
    })}
    ${activity.length
      ? card({
          title: "Activity this month",
          body: html`<dl class="dl" data-role="activity">${activity.map((id) => html`<dt title="${METERS[id].definition}">${METERS[id].label}</dt><dd>${formatNumber(values[id] ?? 0)}</dd>`)}</dl>
            <p class="stat-hint">For information only: these aren't limits on your package.</p>`,
        })
      : ""}
    ${card({
      title: "Usage history",
      body: html`<div data-role="history"><button type="button" class="btn btn-compact" data-act="history">Show the last 12 months</button></div>`,
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

  container.onclick = async (e) => {
    if (e.target.closest("[data-act]")?.dataset.act !== "history") return;
    const box = container.querySelector('[data-role="history"]');
    render(box, html`<p class="stat-hint">Loading…</p>`);
    try {
      const r = await api("/api/usage");
      render(box, historyTable(r.history, session.entitlements));
    } catch (err) {
      render(box, html`<p class="stat-hint">Couldn't load the history: ${err.message || "try again"}.</p><button type="button" class="btn btn-compact" data-act="history">Try again</button>`);
    }
  };
}
