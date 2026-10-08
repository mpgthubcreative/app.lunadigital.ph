// Dashboard: today's figures for the business, in its own timezone.
// What's shown is decided by shared/dashboard.js (permission + entitled
// modules); values come from the metric documents (data.js) through the
// pure view model (view.js). Until Orders, Inventory, Payments and
// Expenses exist, every card honestly reads "No data yet".

import { html, render } from "../../lib/html.js";
import { pageHeader, statCard, card, emptyState } from "../../components/ui.js";
import { formatDayId } from "../../lib/format.js";
import { DASHBOARD_SECTIONS, dashboardEmptyState, workspaceModuleLabel, snapshotWorkspaceTemplateId } from "@shared/index.js";
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

function renderView(container, session, day, view) {
  const empty = dashboardEmptyState(session.entitlements);
  const sections = DASHBOARD_SECTIONS.filter((s) => s.id !== "lists")
    .map((s) => ({ ...s, cards: view.cards.filter((c) => c.section === s.id) }))
    .filter((s) => s.cards.length);

  render(
    container,
    html`
      ${pageHeader({ title: titleOf(session), subtitle: `Today, ${formatDayId(day)} · ${session.business.name}` })}
      ${sections.map(
        (s) => html`
          <section class="section" data-section="${s.id}">
            <h2 class="section-title">${s.label}</h2>
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

// options.fetchDocuments / options.now are injectable for tests.
export function mount(container, session, { fetchDocuments = fetchMetricDocuments, fetchLists = fetchDashboardLists, now = new Date() } = {}) {
  let cancelled = false;
  let plan;
  try {
    plan = dashboardPlan(session, now);
  } catch (err) {
    console.error("dashboard: can't determine the business date:", err);
    render(container, html`${pageHeader({ title: titleOf(session) })}${card({ body: emptyState({ title: "Dashboard unavailable", body: "This business's timezone isn't set up correctly. Please contact Luna support." }) })}`);
    return () => {};
  }

  const loading = Object.fromEntries(plan.documents.map((d) => [d.source, { status: "loading" }]));
  renderView(container, session, plan.day, buildDashboardView({ session, widgets: plan.widgets, docs: loading }));

  const failed = () => Object.fromEntries(plan.documents.map((d) => [d.source, { status: "error" }]));
  const readyLists = plan.widgets.filter((w) => w.kind === "list" && w.ready);
  const failedLists = () => Object.fromEntries(readyLists.map((w) => [w.id, { status: "error", rows: [] }]));
  // e.g. Firebase not configured / SDK failed to load: affected cards say
  // "Couldn't load" rather than leaving a rejected promise behind.
  const safe = (fn, fallback) =>
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.error("dashboard: loading failed:", err && (err.code || err.message));
        return fallback();
      });
  Promise.all([
    safe(() => fetchDocuments(session.business.id, plan.documents), failed),
    readyLists.length ? safe(() => fetchLists(session.business.id, readyLists), failedLists) : {},
  ]).then(([docs, lists]) => {
    if (cancelled) return;
    renderView(container, session, plan.day, buildDashboardView({ session, widgets: plan.widgets, docs, lists }));
  });

  return () => {
    cancelled = true;
  };
}
