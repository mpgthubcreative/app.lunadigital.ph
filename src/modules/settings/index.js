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
// Phase 18.6: the figures were the ones captured at sign-in, so an Excel
// download (counted by the server) didn't show until the page was
// reloaded. Settings now asks the server for the CURRENT usage every time
// it opens and redraws the meters.
// 2026-10-21: Data → Download Excel, and Data Management → Reset Workspace
// Data (the account owner; type RESET; the server checks and records it).
// What it removes and keeps is listed here (shared/reset.js).

import { isModuleLaunched, accessPolicy, MODULES, FEATURE_DEFINITIONS, LIMIT_KEYS, LIMIT_METER, LIMIT_DEFINITIONS, METERS, MONTHLY_METER_IDS, isEnforced, meterApplies, isHiddenMeter, isHiddenLimit, isNoLimit } from "@shared/index.js";
import { html, render } from "../../lib/html.js";
import { pageHeader, card, meter, badge } from "../../components/ui.js";
import { canArrange, mountArrangeNav } from "./arrange-nav.js";
import { formatBytes, formatNumber } from "../../lib/format.js";
import { api } from "../../lib/api.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast } from "../../components/feedback.js";
import { resetPlanFor, RESET_KEEPS, RESET_CONFIRM_WORD } from "@shared/reset.js";
import { showExportPage } from "../../app/routes.js";

const STATUS_TONE = { active: "success", past_due: "warning", suspended: "danger", cancelled: "danger" };
const STATUS_LABEL = { active: "Active", past_due: "Past due", suspended: "Suspended", cancelled: "Cancelled" };
const fmtFor = (unit) => (unit === "bytes" ? formatBytes : formatNumber);

function featureValue(key, value) {
  const def = FEATURE_DEFINITIONS[key];
  if (def.type === "boolean") return value === true ? badge("Included", "success") : badge("Not on your package", "neutral");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Informational monthly counters that mean something for this business.
// A module not launched to customers (Excel import) shows no meter or limit here.
const launchedMeter = (id) => !isHiddenMeter(id) && (METERS[id]?.module == null || isModuleLaunched(METERS[id].module));
const activityMeters = (entitlements) => MONTHLY_METER_IDS.filter((id) => !isEnforced(id) && meterApplies(id, entitlements) && launchedMeter(id));
// Monthly columns of the history table: limited ones first, then activity.
const historyMeters = (entitlements) => MONTHLY_METER_IDS.filter((id) => meterApplies(id, entitlements) && launchedMeter(id));

function historyTable(rows, entitlements) {
  const ids = historyMeters(entitlements);
  const cell = (v, id) => (v === null ? html`<span class="stat-hint">—</span>` : fmtFor(METERS[id].unit)(v));
  return html`<div class="table-wrap"><table class="table table-compact" data-role="usage-history">
    <thead><tr><th>Month</th>${ids.map((id) => html`<th class="num">${METERS[id].label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) =>
      r.recorded
        ? html`<tr data-period="${r.period}"><td>${r.period}</td>${ids.map((id) => html`<td class="num">${cell(r.values[id], id)}</td>`)}</tr>`
        : html`<tr data-period="${r.period}"><td>${r.period}</td><td colspan="${ids.length}" class="stat-hint">No recorded usage</td></tr>`
    )}</tbody></table></div>
    <p class="stat-hint">— = not measured that month. File storage and active users are current totals (above), not monthly.</p>`;
}

const ACTIVITY_TEXT = { exportsGenerated: (n) => `${formatNumber(n)} this month`, rowsExported: (n) => `${formatNumber(n)} rows this month`, exportBytes: (n) => `${formatBytes(n)} this month` };

function packageCards(session, fresh = null) {
  const { modules, limits, features } = session.entitlements;
  const values = fresh?.current || session.usage?.values || {};
  // Sellable, built modules only; core modules are in every package.
  const sellable = MODULES.filter((m) => m.available && !m.core && isModuleLaunched(m.id));
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
          ${LIMIT_KEYS.filter((key) => !isHiddenLimit(key) && launchedMeter(LIMIT_METER[key])).map((key) => {
            const meterId = LIMIT_METER[key];
            const m = METERS[meterId];
            const label = m.kind === "monthly" ? `${LIMIT_DEFINITIONS[key].label} (this month)` : LIMIT_DEFINITIONS[key].label;
            // No commercial limit (orders today): the count only.
            if (isNoLimit(key, limits[key])) return html`<div data-limit="${key}"><dl class="dl dl-compact"><dt>${m.label}${m.kind === "monthly" ? " this month" : ""}</dt><dd>${fmtFor(m.unit)(values[meterId] ?? 0)} <span class="stat-hint">No limit</span></dd></dl></div>`;
            return html`<div data-limit="${key}">${meter({ label, used: values[meterId] ?? 0, limit: limits[key], format: fmtFor(m.unit), showPercent: true })}</div>`;
          })}
        </div>
        ${session.usage?.period ? html`<p class="stat-hint">Monthly limits reset each calendar month (${session.usage.period}, business time). To raise a limit, contact Luna.</p>` : ""}
      `,
    })}
    ${activity.length
      ? card({
          title: "Activity this month",
          body: html`<dl class="dl" data-role="activity">${activity.map((id) => html`<dt title="${METERS[id].definition}">${METERS[id].label}</dt><dd data-meter="${id}">${(ACTIVITY_TEXT[id] || formatNumber)(values[id] ?? 0)}</dd>`)}</dl>
            <p class="stat-hint">For information only: no limit on your package. ${fresh ? "Up to date." : "Updating…"}</p>`,
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

function dataCard(session) {
  const owner = session.member.isAccountOwner === true;
  const plan = resetPlanFor(session.workspace?.templateId ?? session.entitlements?.workspaceTemplateId);
  const canExport = showExportPage(session);
  if (!canExport && !(owner && plan)) return "";
  return card({
    title: "Data",
    body: html`<div data-role="data">
      ${canExport ? html`<p class="stat-note">Download all your records as one Excel workbook.</p><a class="btn btn-compact" href="/export" data-link>Download Excel</a>` : ""}
      ${owner && plan
        ? html`<div class="data-management" data-role="reset">
            <h3 class="section-title">Data Management</h3>
            <p class="cell-strong">Reset Workspace Data</p>
            <p class="stat-note">Start again in this same workspace: everyday records are permanently deleted. Download Excel first if you want a copy.</p>
            <details class="form-more"><summary>What a reset removes and keeps</summary>
              <p class="stat-hint">Removes</p><ul class="plain-list" data-role="reset-removes">${plan.summary.map((x) => html`<li>${x}</li>`)}</ul>
              <p class="stat-hint">Keeps</p><ul class="plain-list" data-role="reset-keeps">${[...RESET_KEEPS, ...(plan.keeps || [])].map((x) => html`<li>${x}</li>`)}</ul>
            </details>
            <button type="button" class="btn btn-danger btn-compact" data-act="reset-data">Reset workspace data…</button>
          </div>`
        : ""}
    </div>`,
  });
}

async function resetDialog(session) {
  return formDialog({
    title: "Reset workspace data?",
    intro: `This permanently deletes ${session.business.name}'s everyday records and files. Your workspace, members, settings and subscription stay. This can't be undone.`,
    fields: [{ name: "confirm", label: `Type ${RESET_CONFIRM_WORD} to confirm`, required: true, placeholder: RESET_CONFIRM_WORD }],
    submitLabel: "Reset workspace data",
    armMs: 600,
    onSubmit: async (v) => {
      if (v.confirm.trim() !== RESET_CONFIRM_WORD) throw new Error(`Type ${RESET_CONFIRM_WORD} (in capital letters) to confirm`);
      return api("reset-data", { method: "POST", body: { action: "reset", confirm: v.confirm.trim() } });
    },
  });
}

export function mount(container, session) {
  const status = session.subscription.status;
  const policy = accessPolicy(status);
  const seesPackage = session.member.permissions["billing.view"] === true && Boolean(session.plan && session.entitlements.limits);

  render(
    container,
    html`
      ${pageHeader({ title: "Settings", subtitle: "Business configuration and subscription." })}
      <div data-role="arrange-host"></div>
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
        ${dataCard(session)}
        <div data-role="package" class="grid-span">${seesPackage ? packageCards(session) : ""}</div>
      </div>
    `
  );
  // Settings → Arrange navigation (this person's phone tabs).
  const arrangeHost = container.querySelector('[data-role="arrange-host"]');
  if (arrangeHost && canArrange(session)) mountArrangeNav(arrangeHost, session);
  // Fresh figures from the server (an export or upload since sign-in shows now).
  if (seesPackage)
    Promise.resolve()
      .then(() => api("usage"))
      .then((r) => {
        if (!r || !r.current) return;
        const box = container.querySelector('[data-role="package"]');
        if (box) render(box, packageCards(session, r));
      })
      .catch(() => {
        /* keep the sign-in figures */
      });

  container.onclick = async (e) => {
    if (e.target.closest("[data-act]")?.dataset.act === "reset-data") {
      try {
        const r = await resetDialog(session);
        if (!r) return;
        toast(`Workspace data reset: ${r.records} records removed.`, "success");
        window.dispatchEvent(new CustomEvent("luna:session-changed"));
      } catch (err) {
        toast(err.message || "Couldn't reset the data", "danger");
      }
      return;
    }
    if (e.target.closest("[data-act]")?.dataset.act !== "history") return;
    const box = container.querySelector('[data-role="history"]');
    render(box, html`<p class="stat-hint">Loading…</p>`);
    try {
      const r = await api("usage");
      render(box, historyTable(r.history, session.entitlements));
    } catch (err) {
      render(box, html`<p class="stat-hint">Couldn't load the history: ${err.message || "try again"}.</p><button type="button" class="btn btn-compact" data-act="history">Try again</button>`);
    }
  };
}
