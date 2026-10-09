// Dashboard (Phase 12.5: Filter -> View -> Download). A period filter
// (Today, Yesterday, This week, This month, Last month, Custom) in the
// BUSINESS's timezone drives the "Selected period" cards, read from the
// same summary documents and summed by the same code as Reports, so both
// show the same figures for the same range. "Current operations" are live
// gauges (unpaid balance, low stock, ...) and are always labelled as now:
// choosing Last Month never turns them into last month's figures.
// What's shown is decided by shared/dashboard.js (permission + entitled
// modules); "No data yet" is never shown as 0.

import { html, render } from "../../lib/html.js";
import { pageHeader, statCard, card, emptyState } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport } from "../../lib/export.js";
import { DASHBOARD_SECTIONS, dashboardEmptyState, workspaceModuleLabel, snapshotWorkspaceTemplateId, reportPresets, validateRange } from "@shared/index.js";
import { dashboardPlan, buildDashboardView } from "./view.js";
import { fetchMetricDocuments, fetchDashboardLists } from "./data.js";

function listBody(l) {
  if (l.status === "loading") return emptyState({ iconName: "inbox", title: "Loading…" });
  if (l.status === "error") return emptyState({ iconName: "inbox", title: "Couldn't load", body: "Try again in a moment." });
  if (!l.rows.length) return emptyState({ iconName: "inbox", title: l.ready ? "Nothing here" : "No data yet", body: l.ready ? "All clear for now." : l.empty });
  return html`<ul class="list" data-role="rows">${l.rows.map((r) => html`<li><strong>${r.title}</strong><div class="stat-hint">${r.detail}</div></li>`)}</ul>`;
}

// The workspace names its own dashboard ("Wedding Dashboard"); Distributor
// keeps "Dashboard".
const titleOf = (session) => workspaceModuleLabel(snapshotWorkspaceTemplateId(session.entitlements), "dashboard", "Dashboard");
const rangeText = ({ from, to }) => (from === to ? formatDayId(from) : `${formatDayId(from)} – ${formatDayId(to)}`);

// options.fetchDocuments / fetchLists / now / exportDeps are injectable for tests.
export function mount(container, session, { fetchDocuments = fetchMetricDocuments, fetchLists = fetchDashboardLists, now = new Date(), toast = defaultToast, exportDeps = {} } = {}) {
  let alive = true;
  let today;
  let presets;
  let plan;
  try {
    plan = dashboardPlan(session, now);
    today = plan.day;
    presets = reportPresets(today);
  } catch (err) {
    console.error("dashboard: can't determine the business date:", err);
    render(container, html`${pageHeader({ title: titleOf(session) })}${card({ body: emptyState({ title: "Dashboard unavailable", body: "This business's timezone isn't set up correctly. Please contact Luna support." }) })}`);
    return () => {};
  }
  const state = { preset: "today", range: { from: today, to: today }, view: null, seq: 0 };
  const canDownload = mayExport(session, "dashboard") && plan.widgets.some((w) => w.kind === "stat");

  function draw() {
    if (!alive) return;
    const view = state.view;
    const empty = dashboardEmptyState(session.entitlements);
    const label = (s) => (s.id === "period" ? `${s.label} · ${presets[state.preset]?.label ?? "Custom"}, ${rangeText(state.range)}` : s.id === "current" ? `${s.label} · as of now` : s.label);
    const sections = DASHBOARD_SECTIONS.filter((s) => s.id !== "lists")
      .map((s) => ({ ...s, cards: view.cards.filter((c) => c.section === s.id) }))
      .filter((s) => s.cards.length);
    const opt = (v, l) => html`<option value="${v}" ${state.preset === v ? "selected" : ""}>${l}</option>`;
    const hasPeriod = plan.widgets.some((w) => w.section === "period");
    render(
      container,
      html`
        ${pageHeader({ title: titleOf(session), subtitle: `${session.business.name} · business time (${session.business.timezone})` })}
        ${hasPeriod
          ? html`<form class="section card filters filters-inline" data-role="period">
              <select class="select" name="preset" aria-label="Period">${Object.entries(presets).map(([k, p]) => opt(k, p.label))}${opt("custom", "Custom")}</select>
              <input class="input" type="date" name="from" value="${state.range.from}" max="${today}" aria-label="From" />
              <input class="input" type="date" name="to" value="${state.range.to}" max="${today}" aria-label="To" />
              <button type="submit" class="btn">Apply</button>
              ${canDownload ? exportButton("dashboard") : ""}
            </form>`
          : ""}
        ${sections.map(
          (s) => html`
            <section class="section" data-section="${s.id}">
              <h2 class="section-title">${label(s)}</h2>
              <div class="stat-grid">
                ${s.cards.map((c) => statCard({ id: c.id, label: c.label, value: c.value, empty: c.empty, hint: c.hint, note: c.note }))}
              </div>
            </section>
          `
        )}
        ${view.lists.length
          ? html`<div class="section grid grid-2">
              ${view.lists.map((l) => html`<div data-widget="${l.id}">${card({ title: l.label, body: listBody(l) })}</div>`)}
            </div>`
          : ""}
        ${!sections.length && !view.lists.length
          ? html`<div data-role="workspace-empty">${card({ body: emptyState({ title: empty.title, body: empty.body }) })}</div>`
          : ""}
      `
    );
  }

  // e.g. Firebase not configured / SDK failed to load: affected cards say
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
  const onChange = (event) => {
    if (event.target.name !== "preset") return;
    const p = presets[event.target.value];
    if (p) applyRange(p.from, p.to, event.target.value);
    else state.preset = "custom";
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "period") return;
    event.preventDefault();
    applyRange(event.target.elements.from.value, event.target.elements.to.value);
  };
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  // The workbook is for the period on screen.
  const unbindExport = bindExport(container, () => ({ ...state.range }), { toast, deps: exportDeps });
  load();

  return () => {
    alive = false;
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
    unbindExport();
  };
}
