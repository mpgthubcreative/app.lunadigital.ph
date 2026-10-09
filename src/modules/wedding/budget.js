// Wedding Budget (Phase 16): the overall wedding budget and one compact row
// per category (the budget primitive shared with Baby, with wedding words).
//   Total wedding budget (Edit -> Save) | Spent | Remaining | Upcoming | Supplier balance, as of now
//   Category | Budget | Spent | Remaining | % used | Upcoming | Status | Edit · Deactivate
// Luna computes Spent, Remaining and the supplier balance from the recorded
// Wedding Expenses and supplier agreements; nobody types them.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { CATEGORY_STATUSES, SUGGESTED_WEDDING_CATEGORIES, budgetLines, weddingSummary } from "@shared/index.js";
import { parseBudget } from "../baby/budget.js";
import { activityLines } from "../baby/common.js";
import * as defaultData from "./data.js";

const pesosText = (c) => (Number.isSafeInteger(c) ? String(c / 100) : "");
const money = (c, currency) => (c === null || c === undefined ? "—" : formatCentavos(c, currency));
const categoryFields = (c = {}) => [
  { name: "name", label: "Category name", value: c.name ?? "", required: true },
  { name: "budget", label: "Category budget (₱, optional)", value: pesosText(c.budget), inputmode: "decimal", hint: "Leave blank for no budget on this category." },
];

export function mount(container, session, { data = defaultData, toast = defaultToast, exportDeps = {} } = {}) {
  const canManage = session.member.permissions["budget.manage"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const state = { status: "", category: "", budget: null, categories: [], loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      [state.budget, state.categories] = await Promise.all([data.getBudget(businessId), data.listCategories(businessId)]);
      state.error = null;
    } catch (err) {
      console.error("wedding budget: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load the wedding budget.";
    }
    state.loading = false;
    draw();
  }

  function draw() {
    if (!alive) return;
    const s = weddingSummary(state.budget);
    const all = budgetLines(state.budget, state.categories);
    const lines = all.filter((l) => (!state.status || l.status === state.status) && (!state.category || l.id === state.category));
    const allocated = all.reduce((sum, l) => sum + (l.status === "active" && l.budget ? l.budget : 0), 0);
    const opt = (v, l, cur) => html`<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
    const history = activityLines((state.budget?.history || []).slice(-5).reverse(), timezone);
    render(
      container,
      html`
        ${pageHeader({ title: "Wedding Budget", subtitle: "Your wedding budget by category. Luna works out what's spent, what's left and what you still owe suppliers." })}
        ${state.error
          ? html`<section class="section card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            <section class="section" data-section="current">
              <h2 class="section-title">Wedding plan · as of now</h2>
              <div class="stat-grid">
                ${statCard({ id: "total", label: "Total wedding budget", value: s.total === null ? "Not set" : money(s.total, currency), empty: s.total === null })}
                ${statCard({ id: "spent", label: "Total spent", value: money(s.spent, currency), hint: `${s.expenseCount} expense${s.expenseCount === 1 ? "" : "s"}` })}
                ${statCard({ id: "remaining", label: "Remaining budget", value: s.remaining === null ? "—" : money(s.remaining, currency), hint: s.percentUsed === null ? "Set a total budget" : `${s.percentUsed}% used`, empty: s.remaining === null })}
                ${statCard({ id: "upcoming", label: "Upcoming payments", value: money(s.upcoming, currency), hint: "Scheduled, not yet spent" })}
                ${statCard({ id: "balance", label: "Supplier balance", value: money(s.supplierBalance, currency), hint: "Still owed on supplier agreements" })}
              </div>
              ${canManage ? html`<div class="page-actions"><button type="button" class="btn btn-primary" data-act="total">${s.total === null ? "Set wedding budget" : "Edit wedding budget"}</button></div>` : ""}
            </section>
            <form class="section card filters filters-inline" data-role="filters">
              <select class="select" name="category" aria-label="Category">${opt("", "All categories", state.category)}${state.categories.map((c) => opt(c.id, c.name, state.category))}</select>
              <select class="select" name="status" aria-label="Status">${opt("", "Active and inactive", state.status)}${Object.entries(CATEGORY_STATUSES).map(([k, v]) => opt(k, v.label, state.status))}</select>
              <button type="submit" class="btn">Apply</button>
              ${canManage ? html`<button type="button" class="btn" data-act="new-category">Add category</button>` : ""}
              ${mayExport(session, "weddingBudget") ? html`${exportButton("weddingBudget")}<span class="stat-hint">${exportHint}</span>` : ""}
            </form>
            <section class="section card">
              ${state.loading
                ? emptyState({ title: "Loading…" })
                : !state.categories.length
                  ? html`${emptyState({ iconName: "budget", title: "No categories yet", body: `Categories are your budget's lines, e.g. ${SUGGESTED_WEDDING_CATEGORIES.slice(0, 5).join(", ")}.` })}
                      ${canManage ? html`<div class="page-actions"><button type="button" class="btn btn-primary" data-act="suggested">Add suggested wedding categories</button></div>` : ""}`
                  : !lines.length
                    ? emptyState({ title: "No matching categories" })
                    : html`<div class="table-wrap"><table class="table table-compact" data-role="categories">
                        <thead><tr><th>Category</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Remaining</th><th class="num col-secondary">% used</th><th class="num col-secondary">Upcoming</th><th>Status</th><th></th></tr></thead>
                        <tbody>${lines.map(
                          (l) => html`<tr data-category="${l.id}">
                            <td>${l.name}</td>
                            <td class="num">${money(l.budget, currency)}</td>
                            <td class="num">${money(l.spent, currency)}</td>
                            <td class="num">${l.remaining === null ? "—" : l.remaining < 0 ? badge(`Over by ${money(-l.remaining, currency)}`, "danger") : money(l.remaining, currency)}</td>
                            <td class="num col-secondary">${l.percentUsed === null ? "—" : `${l.percentUsed}%`}</td>
                            <td class="num col-secondary">${l.upcoming ? money(l.upcoming, currency) : "—"}</td>
                            <td>${badge(CATEGORY_STATUSES[l.status]?.label ?? l.status, l.status === "active" ? "success" : "neutral")}</td>
                            <td class="row-actions">${canManage
                              ? html`<button type="button" class="btn btn-compact" data-act="edit" data-id="${l.id}">Edit</button>
                                  <button type="button" class="btn btn-compact" data-act="status" data-id="${l.id}">${l.status === "active" ? "Deactivate" : "Reactivate"}</button>`
                              : ""}</td>
                          </tr>`
                        )}</tbody></table></div>
                        <p class="stat-hint" data-role="allocated">Allocated to active categories: ${money(allocated, currency)}${s.total === null ? "" : ` of ${money(s.total, currency)} (${allocated > s.total ? `${money(allocated - s.total, currency)} over the total` : `${money(s.total - allocated, currency)} not allocated`})`}</p>`}
            </section>
            ${history.length ? html`<section class="section card"><h2 class="card-title">Recent budget changes</h2><ul class="list activity" data-role="budget-history">${history.map((l) => html`<li>${l}</li>`)}</ul></section>` : ""}`}
      `
    );
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    const c = state.categories.find((x) => x.id === el.dataset.id);
    try {
      let r = null;
      let message = "Saved.";
      if (el.dataset.act === "total") {
        const s = weddingSummary(state.budget);
        r = await formDialog({
          title: s.total === null ? "Set wedding budget" : "Edit wedding budget",
          intro: "Changing the budget isn't spending: Luna recalculates what's left.",
          fields: [{ name: "total", label: "Total wedding budget (₱)", value: pesosText(s.total), inputmode: "decimal", hint: "Leave blank to clear the budget." }],
          onSubmit: (v) => data.budgetApi({ action: "setTotal", total: parseBudget(v.total, "total budget"), expectedRevision: state.budget?.revision ?? 0 }),
        });
        message = "Budget saved.";
      } else if (el.dataset.act === "new-category") {
        r = await formDialog({ title: "Add category", fields: categoryFields(), onSubmit: (v) => data.budgetApi({ action: "createCategory", category: { name: v.name.trim(), budget: parseBudget(v.budget, "category budget") } }) });
        message = "Category added.";
      } else if (el.dataset.act === "suggested") {
        el.disabled = true;
        r = await data.budgetApi({ action: "setupCategories" });
        message = "Suggested categories added. Rename, budget or deactivate them as you like.";
      } else if (el.dataset.act === "edit" && c) {
        r = await formDialog({
          title: `Edit ${c.name}`,
          fields: categoryFields(c),
          onSubmit: (v) => {
            const next = { name: v.name.trim(), budget: parseBudget(v.budget, "category budget") };
            const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (c[k] ?? null) !== (val ?? null)));
            return Object.keys(changes).length ? data.budgetApi({ action: "updateCategory", categoryId: c.id, expectedRevision: c.revision, changes }) : { unchanged: true };
          },
        });
      } else if (el.dataset.act === "status" && c) {
        r = await data.budgetApi({ action: "setCategoryStatus", categoryId: c.id, status: c.status === "active" ? "inactive" : "active" });
      } else return;
      if (r && !r.unchanged) toast(message, "success");
      if (r) load();
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      load();
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    state.status = event.target.elements.status.value;
    state.category = event.target.elements.category.value;
    draw();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, () => Object.fromEntries(Object.entries({ category: state.category, status: state.status }).filter(([, v]) => v)), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
    unbindExport();
  };
}
