// Dashboard: today's figures for the business, in its own timezone.
// What's shown is decided by shared/dashboard.js (permission + entitled
// modules); values come from the metric documents (data.js) through the
// pure view model (view.js). Until Orders, Inventory, Payments and
// Expenses exist, every card honestly reads "No data yet".

import { html, render } from "../../lib/html.js";
import { pageHeader, statCard, card, emptyState } from "../../components/ui.js";
import { formatDayId } from "../../lib/format.js";
import { DASHBOARD_SECTIONS } from "@shared/index.js";
import { dashboardPlan, buildDashboardView } from "./view.js";
import { fetchMetricDocuments } from "./data.js";

function renderView(container, session, day, view) {
  const sections = DASHBOARD_SECTIONS.filter((s) => s.id !== "lists")
    .map((s) => ({ ...s, cards: view.cards.filter((c) => c.section === s.id) }))
    .filter((s) => s.cards.length);

  render(
    container,
    html`
      ${pageHeader({ title: "Dashboard", subtitle: `Today, ${formatDayId(day)} · ${session.business.name}` })}
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
            ${view.lists.map((l) => html`<div data-widget="${l.id}">${card({ title: l.label, body: emptyState({ iconName: "inbox", title: "No data yet", body: l.empty }) })}</div>`)}
          </div>`
        : ""}
      ${!sections.length && !view.lists.length
        ? card({ body: emptyState({ title: "Nothing to show yet", body: "Your dashboard fills in as your business uses Luna." }) })
        : ""}
    `
  );
}

// options.fetchDocuments / options.now are injectable for tests.
export function mount(container, session, { fetchDocuments = fetchMetricDocuments, now = new Date() } = {}) {
  let cancelled = false;
  let plan;
  try {
    plan = dashboardPlan(session, now);
  } catch (err) {
    console.error("dashboard: can't determine the business date:", err);
    render(container, html`${pageHeader({ title: "Dashboard" })}${card({ body: emptyState({ title: "Dashboard unavailable", body: "This business's timezone isn't set up correctly. Please contact Luna support." }) })}`);
    return () => {};
  }

  const loading = Object.fromEntries(plan.documents.map((d) => [d.source, { status: "loading" }]));
  renderView(container, session, plan.day, buildDashboardView({ session, widgets: plan.widgets, docs: loading }));

  const failed = () => Object.fromEntries(plan.documents.map((d) => [d.source, { status: "error" }]));
  Promise.resolve()
    .then(() => fetchDocuments(session.business.id, plan.documents))
    .catch((err) => {
      // e.g. Firebase not configured / SDK failed to load: every card says
      // "Couldn't load" rather than leaving a rejected promise behind.
      console.error("dashboard: loading metrics failed:", err && (err.code || err.message));
      return failed();
    })
    .then((docs) => {
      if (cancelled) return;
      renderView(container, session, plan.day, buildDashboardView({ session, widgets: plan.widgets, docs }));
    });

  return () => {
    cancelled = true;
  };
}
