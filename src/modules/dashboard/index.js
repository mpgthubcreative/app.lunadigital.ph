// Dashboard = Monitor (Phase 18.5). Each workspace has its own layout
// (./layouts.js) answering one question; the data and its rules are
// unchanged from Phase 12.5:
//   - A period filter (Today, Yesterday, This week, This month, Last month,
//     Custom) in the BUSINESS's timezone drives the period figures, read
//     from the same summary documents and summed by the same code as
//     Reports. Live gauges (unpaid, low stock, order status counts) are
//     always "now": choosing Last month never turns them into last month's.
//   - What's shown is decided by shared/dashboard.js (permission + entitled
//     modules); "No data yet" is never shown as 0.
//   - Download Excel exports the period on screen.
// The Dashboard summarizes; the module that owns the records holds the
// full list (every summary links there).

import { html, render } from "../../lib/html.js";
import { pageHeader, card, emptyState, bindRowMenus } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport } from "../../lib/export.js";
import { api as defaultApi } from "../../lib/api.js";
import { dashboardEmptyState, workspaceModuleLabel, snapshotWorkspaceTemplateId, reportPresets, validateRange } from "@shared/index.js";
import { dashboardPlan, buildDashboardView } from "./view.js";
import { fetchMetricDocuments, fetchDashboardLists } from "./data.js";
import { LAYOUTS } from "./layouts.js";
import { orderPermissions, inlineOrderActions } from "../orders/inline.js";
import { listOrderPayments as defaultListOrderPayments } from "../payments/data.js";

// The workspace names its own dashboard ("Wedding Dashboard"); Distributor
// keeps "Dashboard".
const titleOf = (session) => workspaceModuleLabel(snapshotWorkspaceTemplateId(session.entitlements), "dashboard", "Dashboard");
const rangeText = ({ from, to }) => (from === to ? formatDayId(from) : `${formatDayId(from)} – ${formatDayId(to)}`);
// Budget workspaces look at the month; the store looks at today.
const DEFAULT_PRESET = { "baby-expense": "thisMonth", "bridal-expense": "thisMonth" };

// options.fetchDocuments / fetchLists / now / exportDeps / api are injectable for tests.
export function mount(container, session, { fetchDocuments = fetchMetricDocuments, fetchLists = fetchDashboardLists, now = new Date(), toast = defaultToast, exportDeps = {}, api = defaultApi, listOrderPayments = defaultListOrderPayments } = {}) {
  let alive = true;
  let today;
  let presets;
  let plan;
  const templateId = snapshotWorkspaceTemplateId(session.entitlements);
  try {
    plan = dashboardPlan(session, now);
    today = plan.day;
    presets = reportPresets(today);
  } catch (err) {
    console.error("dashboard: can't determine the business date:", err);
    render(container, html`${pageHeader({ title: titleOf(session) })}${card({ body: emptyState({ title: "Dashboard unavailable", body: "This business's timezone isn't set up correctly. Please contact Luna support." }) })}`);
    return () => {};
  }
  const start = presets[DEFAULT_PRESET[templateId]] ? DEFAULT_PRESET[templateId] : "today";
  const state = { preset: start, range: start === "today" ? { from: today, to: today } : { from: presets[start].from, to: presets[start].to }, view: null, seq: 0, lists: null };
  const canDownload = mayExport(session, "dashboard") && plan.widgets.some((w) => w.kind === "stat");
  const can = orderPermissions(session.member.permissions);
  const currency = session.business.currency || "PHP";
  const layout = LAYOUTS[templateId];

  const periodLabel = () => (presets[state.preset] ? presets[state.preset].label : rangeText(state.range));

  function header() {
    const hasPeriod = plan.widgets.some((w) => w.section === "period");
    const opt = (v, l) => html`<option value="${v}" ${state.preset === v ? "selected" : ""}>${l}</option>`;
    const custom = state.preset === "custom";
    const actions = html`
      ${hasPeriod
        ? html`<form class="dash-head-actions" data-role="period">
            <select class="select" name="preset" aria-label="Period">${Object.entries(presets).map(([k, p]) => opt(k, p.label))}${opt("custom", "Custom dates")}</select>
            <span class="dash-dates" ${custom ? "" : "hidden"}>
              <input class="input" type="date" name="from" value="${state.range.from}" max="${today}" aria-label="From" />
              <input class="input" type="date" name="to" value="${state.range.to}" max="${today}" aria-label="To" />
              <button type="submit" class="btn">Apply</button>
            </span>
            ${canDownload ? exportButton("dashboard", "Download Excel") : ""}
          </form>`
        : canDownload
          ? exportButton("dashboard", "Download Excel")
          : ""}`;
    return pageHeader({ title: titleOf(session), subtitle: `${session.business.name} · ${hasPeriod ? `${periodLabel()}: ${rangeText(state.range)}` : formatDayId(today)} · business time (${session.business.timezone})`, actions });
  }

  function draw() {
    if (!alive) return;
    const view = state.view;
    const empty = dashboardEmptyState(session.entitlements);
    const nothing = !view.cards.length && !view.lists.length;
    const body = nothing || !layout ? html`<div data-role="workspace-empty">${card({ body: emptyState({ title: empty.title, body: empty.body }) })}</div>` : layout({ session, view, can, currency, today, periodLabel: periodLabel(), range: state.range });
    render(container, html`${header()}<div class="dashboard" data-workspace-layout="${templateId || ""}">${body}</div>`);
    for (const btn of container.querySelectorAll('[data-act="export"]')) btn.classList.add("btn-ghost");
  }

  // e.g. Firebase not configured / SDK failed to load: affected figures say
  // "Couldn't load" rather than leaving a rejected promise behind.
  const safe = (fn, fallback) =>
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.error("dashboard: loading failed:", err && (err.code || err.message));
        return fallback();
      });

  let listsOnce = null; // lists don't depend on the period: load them once
  function load() {
    plan = dashboardPlan(session, now, state.range);
    const seq = ++state.seq;
    const loading = Object.fromEntries(plan.documents.map((d) => [d.source, { status: "loading" }]));
    state.view = buildDashboardView({ session, widgets: plan.widgets, docs: loading, lists: state.lists || {} });
    draw();
    const failed = () => Object.fromEntries(plan.documents.map((d) => [d.source, { status: "error" }]));
    const readyLists = plan.widgets.filter((w) => w.kind === "list" && w.ready);
    const failedLists = () => Object.fromEntries(readyLists.map((w) => [w.id, { status: "error", rows: [] }]));
    listsOnce = listsOnce || (readyLists.length ? safe(() => fetchLists(session.business.id, readyLists, { today }), failedLists) : Promise.resolve({}));
    Promise.all([safe(() => fetchDocuments(session.business.id, plan.documents), failed), listsOnce]).then(([docs, lists]) => {
      if (!alive || seq !== state.seq) return;
      state.lists = lists;
      state.view = buildDashboardView({ session, widgets: plan.widgets, docs, lists });
      draw();
    });
  }
  const reloadAll = () => {
    listsOnce = null;
    load();
  };

  const applyRange = (from, to, preset) => {
    try {
      validateRange({ from, to }, today);
    } catch (err) {
      toast(err.message, "danger");
      return;
    }
    state.range = { from, to };
    state.preset = preset ?? Object.entries(presets).find(([, p]) => p.from === from && p.to === to)?.[0] ?? "custom";
    load();
  };

  // Recent orders keep the same inline Payment ▾ / Fulfillment ▾ as Orders.
  const inline = inlineOrderActions({ can, api, toast, currency, businessId: session.business.id, listOrderPayments, reload: reloadAll });
  const recentOrder = (id) => state.lists?.recentOrders?.rows?.find((o) => o.id === id) || null;

  const onChange = (event) => {
    const el = event.target;
    if (el.dataset.act === "payment" || el.dataset.act === "fulfillment") {
      const o = recentOrder(el.dataset.id);
      if (!o) return;
      if (el.dataset.act === "payment") inline.onPaymentChoice(o, el.value, el);
      else inline.onFulfillmentChoice(o, el.value, el);
      return;
    }
    if (el.name !== "preset") return;
    const p = presets[el.value];
    if (p) applyRange(p.from, p.to, el.value);
    else {
      state.preset = "custom";
      draw();
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "period") return;
    event.preventDefault();
    applyRange(event.target.elements.from.value, event.target.elements.to.value);
  };
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  const unbindMenus = bindRowMenus(container);
  // The workbook is for the period on screen.
  const unbindExport = bindExport(container, () => ({ ...state.range }), { toast, deps: exportDeps });
  load();

  return () => {
    alive = false;
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
    unbindMenus();
    unbindExport();
  };
}
