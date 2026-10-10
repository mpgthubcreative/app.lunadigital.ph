// Budget & Categories (Phase 15): the overall Baby budget and one compact
// row per category (the budget's lines).
//   Overall:   Total budget | Spent | Remaining | Still to pay, as of now
//   Category | Budget | Spent | Remaining | % used | Still to pay | Edit · Delete / Hide
// Phase 18.6: the Total budget is the sum of the category budgets (the
// server keeps it; nobody types it). Each row has plain Edit and Delete
// buttons; a category with expenses or payments can't be deleted, so it
// offers Hide instead (kept for its history, not offered for new entries).
// Luna computes Spent and Remaining from the recorded Baby Expenses.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, bindRowMenus } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { SUGGESTED_CATEGORIES, budgetSummary, budgetLines, parseCentavos } from "@shared/index.js";
import * as defaultData from "./data.js";
import { activityLines } from "./common.js";

const pesosText = (c) => (Number.isSafeInteger(c) ? String(c / 100) : "");
const money = (c, currency) => (c === null || c === undefined ? "—" : formatCentavos(c, currency));

// "" -> null (no budget); otherwise centavos >= 0.
export function parseBudget(text, what = "budget") {
  if (text === undefined || text === null || String(text).trim() === "") return null;
  const c = parseCentavos(text);
  if (!Number.isSafeInteger(c) || c < 0) throw new Error(`Enter a valid ${what} (₱0 or more), or leave it blank`);
  return c;
}

const categoryFields = (c = {}) => [
  { name: "name", label: "Category name", value: c.name ?? "", required: true },
  { name: "budget", label: "Category budget (₱, optional)", value: pesosText(c.budget), inputmode: "decimal", hint: "Leave blank for no budget on this category." },
];

export function mount(container, session, { data = defaultData, toast = defaultToast, exportDeps = {}, confirm = confirmDialog } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["budget.manage"] === true;
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
      console.error("budget: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load the budget.";
    }
    state.loading = false;
    draw();
  }

  function draw() {
    if (!alive) return;
    const s = budgetSummary(state.budget);
    const all = budgetLines(state.budget, state.categories);
    const lines = all.filter((l) => (!state.status || l.status === state.status) && (!state.category || l.id === state.category));
    const opt = (v, l, cur) => html`<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
    const history = activityLines((state.budget?.history || []).slice(-5).reverse(), timezone);
    render(
      container,
      html`
        ${pageHeader({ title: "Budget & Categories", subtitle: "Your baby budget. Luna works out what's spent and what's left from the expenses you record." })}
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            <section class="section" data-section="current">
              <h2 class="section-title">Your budget · as of now</h2>
              <div class="stat-grid">
                ${statCard({ id: "total", label: "Total budget", value: s.total === null ? "No budget yet" : money(s.total, currency), hint: "Sum of the category budgets", empty: s.total === null })}
                ${statCard({ id: "spent", label: "Money spent", value: money(s.spent, currency) })}
                ${statCard({ id: "remaining", label: "Budget left", value: s.remaining === null ? "—" : money(s.remaining, currency), hint: s.percentUsed === null ? "Give a category a budget" : `${s.percentUsed}% used`, empty: s.remaining === null })}
                ${statCard({ id: "upcoming", label: "Still to pay", value: money(s.upcoming, currency), hint: "Scheduled, not spent yet" })}
              </div>
            </section>
            <form class="filter-form toolbar filter-toolbar" data-role="filters" data-auto-apply>
              <select class="select" name="category" aria-label="Category">${opt("", "All categories", state.category)}${state.categories.map((c) => opt(c.id, c.name, state.category))}</select>
              <select class="select" name="status" aria-label="Show">${opt("", "Shown and hidden", state.status)}${opt("active", "Shown", state.status)}${opt("inactive", "Hidden", state.status)}</select>
              <button type="submit" class="visually-hidden" tabindex="-1">Apply</button>
              ${canManage ? html`<button type="button" class="btn btn-primary" data-act="new-category">Add category</button>` : ""}
              ${mayExport(session, "budget") ? html`<span class="toolbar-end">${exportButton("budget")}<span class="visually-hidden">${exportHint}</span></span>` : ""}
            </form>
            <section class="card">
              ${state.loading
                ? skeleton(5)
                : !state.categories.length
                  ? html`${emptyState({ iconName: "budget", title: "No categories yet", body: `Categories are your budget's lines, e.g. ${SUGGESTED_CATEGORIES.slice(0, 4).join(", ")}.` })}
                      ${canManage ? html`<div class="page-actions"><button type="button" class="btn btn-primary" data-act="suggested">Add suggested categories</button></div>` : ""}`
                  : !lines.length
                    ? emptyState({ title: "No matching categories" })
                    : html`<div class="table-wrap"><table class="table table-compact rows" data-role="categories">
                        <thead><tr><th class="m-only"></th><th>Category</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Remaining</th><th class="num col-secondary">% used</th><th class="num col-secondary">Still to pay</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
                        <tbody>${lines.map(
                          (l) => html`<tr data-category="${l.id}">${mobileCell({ title: l.name, sub: l.budget === null || l.budget === undefined ? `${money(l.spent, currency)} spent · no budget` : `${money(l.spent, currency)} of ${money(l.budget, currency)}${l.upcoming ? ` · ${money(l.upcoming, currency)} scheduled` : ""}`, end: l.remaining === null ? "—" : l.remaining < 0 ? `Over ${money(-l.remaining, currency)}` : money(l.remaining, currency), endSub: l.remaining === null ? "" : l.remaining < 0 ? "" : "left" })}
                            <td>${l.name}${l.status === "active" ? "" : html` ${badge("Hidden", "neutral")}`}</td>
                            <td class="num">${money(l.budget, currency)}</td>
                            <td class="num">${money(l.spent, currency)}</td>
                            <td class="num">${l.remaining === null ? "—" : l.remaining < 0 ? badge(`Over by ${money(-l.remaining, currency)}`, "danger") : money(l.remaining, currency)}</td>
                            <td class="num col-secondary">${l.percentUsed === null ? "—" : `${l.percentUsed}%`}</td>
                            <td class="num col-secondary">${l.upcoming ? money(l.upcoming, currency) : "—"}</td>
                            <td class="row-actions" data-m="more">${canManage ? categoryActions(l) : ""}</td>
                          </tr>`
                        )}</tbody></table></div>
                        <p class="stat-hint" data-role="allocated">Total budget = the category budgets added up${s.total === null ? "" : ` (${money(s.total, currency)})`}. Hidden categories still count: their spending is real.</p>`}
            </section>
            ${history.length ? html`<section class="card"><h2 class="card-title">Recent budget changes</h2><ul class="list activity" data-role="budget-history">${history.map((l) => html`<li>${l}</li>`)}</ul></section>` : ""}`}
      `
    );
  }

  // Edit, then Delete for a category nothing used yet, otherwise Hide /
  // Show (a used category keeps its history).
  const used = (id) => (state.categories.find((x) => x.id === id)?.useCount ?? 0) > 0;
  const categoryActions = (l) =>
    html`<button type="button" class="btn btn-compact" data-act="edit" data-id="${l.id}" aria-label="Edit ${l.name}">Edit</button>${
      used(l.id)
        ? html`<button type="button" class="btn btn-compact" data-act="status" data-id="${l.id}" aria-label="${l.status === "active" ? "Hide" : "Show"} ${l.name}">${l.status === "active" ? "Hide" : "Show"}</button>`
        : html`<button type="button" class="btn btn-compact btn-danger-ghost" data-act="delete" data-id="${l.id}" aria-label="Delete ${l.name}">Delete</button>`
    }`;

  async function editCategory(c) {
    const line = state.categories.find((x) => x.id === c.id);
    return formDialog({
      title: `Edit ${line.name}`,
      fields: categoryFields(line),
      onSubmit: (v) => {
        const next = { name: v.name.trim(), budget: parseBudget(v.budget, "category budget") };
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (line[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? data.budgetApi({ action: "updateCategory", categoryId: line.id, expectedRevision: line.revision, changes }) : { unchanged: true };
      },
    });
  }

  // Deactivate / reactivate. (Phase 18.5: deleting a never-used category is
  // its own ⋯ action, below, instead of a choice hidden in this dialog.)
  const categoryStatus = (c) => data.budgetApi({ action: "setCategoryStatus", categoryId: c.id, status: c.status === "active" ? "inactive" : "active" });

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    const c = state.categories.find((x) => x.id === el.dataset.id);
    try {
      let r = null;
      let message = "Saved.";
      if (el.dataset.act === "new-category") {
        r = await formDialog({ title: "Add category", fields: categoryFields(), onSubmit: (v) => data.budgetApi({ action: "createCategory", category: { name: v.name.trim(), budget: parseBudget(v.budget, "category budget") } }) });
        message = "Category added.";
      } else if (el.dataset.act === "suggested") {
        el.disabled = true;
        r = await data.budgetApi({ action: "setupCategories" });
        message = "Suggested categories added. Rename them, give them budgets, or delete the ones you don't need.";
      } else if (el.dataset.act === "edit" && c) {
        r = await editCategory(c);
      } else if (el.dataset.act === "status" && c) {
        r = await categoryStatus(c);
        message = c.status === "active" ? `${c.name} hidden. Its expenses stay; it's no longer offered for new ones.` : `${c.name} is shown again.`;
      } else if (el.dataset.act === "delete" && c) {
        // Only a category nothing ever used (created by mistake); the server re-checks.
        if (!(await confirm({ title: `Delete ${c.name}?`, body: "Nothing uses this category yet, so it can be deleted. Its budget leaves the total.", confirmLabel: "Delete", danger: true }))) return;
        r = await data.budgetApi({ action: "deleteCategory", categoryId: c.id });
        message = `${c.name} deleted.`;
        message = r?.deleted ? "Category deleted." : "Saved.";
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
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindMenus = bindRowMenus(container);
  const unbindExport = bindExport(container, () => Object.fromEntries(Object.entries({ category: state.category, status: state.status }).filter(([, v]) => v)), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
    unbindExport();
    unbindFilters();
    unbindRows();
    unbindMenus();
  };
}
