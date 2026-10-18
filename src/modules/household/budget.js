// Luna Household: Categories (the "budget" module's route, /budget; no
// budget amounts in Household any more: expense monitoring, not
// budgeting). The household's own expense categories, one line each:
//   Groceries                       Edit · Hide / Delete
// Owner / Admin add, rename, hide (a used category keeps its history) or
// delete one nothing used yet. Old budget figures stay stored, unshown.
// Opened from Expenses → ⋯ → Manage categories.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { SUGGESTED_HOUSEHOLD_CATEGORIES } from "@shared/index.js";
import * as defaultData from "./money-data.js";

const nameField = (c = {}) => [{ name: "name", label: "Category name", value: c.name ?? "", required: true, placeholder: "e.g. Groceries" }];

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog } = {}) {
  const canManage = session.member.permissions["budget.manage"] === true;
  const businessId = session.business.id;
  const state = { categories: [], loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = !state.categories.length;
    draw();
    try {
      state.categories = await data.listCategories(businessId);
      state.error = null;
    } catch (err) {
      console.error("household categories: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load the categories.";
    }
    state.loading = false;
    draw();
  }

  const used = (c) => (c.useCount ?? 0) > 0;
  const row = (c) => html`<li class="wl-row" data-category="${c.id}">
    <span class="wl-main"><span class="wl-name">${c.name}${c.status === "active" ? "" : html` ${badge("Hidden", "neutral")}`}</span></span>
    ${canManage
      ? html`<span class="wl-end"><button type="button" class="btn btn-compact" data-act="edit" data-id="${c.id}" aria-label="Rename ${c.name}">Rename</button>${
          used(c)
            ? html`<button type="button" class="btn btn-compact" data-act="status" data-id="${c.id}" aria-label="${c.status === "active" ? "Hide" : "Show"} ${c.name}">${c.status === "active" ? "Hide" : "Show"}</button>`
            : html`<button type="button" class="btn btn-compact btn-danger-ghost" data-act="delete" data-id="${c.id}" aria-label="Delete ${c.name}">Delete</button>`
        }</span>`
      : ""}
  </li>`;

  function draw() {
    if (!alive) return;
    const active = state.categories.filter((c) => c.status === "active");
    const hidden = state.categories.filter((c) => c.status !== "active");
    render(
      container,
      html`
        ${pageHeader({ title: "Categories", subtitle: html`<a href="/expenses" data-link>‹ Expenses</a>`, actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add category</button>` : "" })}
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : state.loading
            ? skeleton(5)
            : !state.categories.length
              ? html`${emptyState({ iconName: "budget", title: "No categories yet", body: `e.g. ${SUGGESTED_HOUSEHOLD_CATEGORIES.slice(0, 5).join(", ")}.` })}
                  ${canManage ? html`<div class="page-actions"><button type="button" class="btn btn-primary" data-act="suggested">Add the usual household categories</button></div>` : ""}`
              : html`<ul class="wl-list wl-section" data-role="categories">${active.map(row)}</ul>
                  ${hidden.length ? html`<details class="wl-fold" data-role="hidden"><summary>Hidden (${hidden.length})</summary><ul class="wl-list">${hidden.map(row)}</ul></details>` : ""}
`}
      `
    );
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const c = state.categories.find((x) => x.id === el.dataset.id);
    try {
      let r = null;
      let message = "Saved.";
      if (el.dataset.act === "new") {
        r = await formDialog({ title: "Add category", fields: nameField(), submitLabel: "Add category", onSubmit: (v) => data.budgetApi({ action: "createCategory", category: { name: v.name.trim(), budget: null } }) });
        message = "Category added.";
      } else if (el.dataset.act === "suggested") {
        el.disabled = true;
        r = await data.budgetApi({ action: "setupCategories" });
        message = "Categories added. Rename or delete the ones you don't need.";
      } else if (el.dataset.act === "edit" && c) {
        r = await formDialog({ title: `Rename ${c.name}`, fields: nameField(c), onSubmit: (v) => (v.name.trim() === c.name ? { unchanged: true } : data.budgetApi({ action: "updateCategory", categoryId: c.id, expectedRevision: c.revision, changes: { name: v.name.trim() } })) });
      } else if (el.dataset.act === "status" && c) {
        r = await data.budgetApi({ action: "setCategoryStatus", categoryId: c.id, status: c.status === "active" ? "inactive" : "active" });
        message = c.status === "active" ? `${c.name} hidden. Its expenses stay.` : `${c.name} is shown again.`;
      } else if (el.dataset.act === "delete" && c) {
        if (!(await confirm({ title: `Delete ${c.name}?`, body: "Nothing uses this category yet, so it can be deleted.", confirmLabel: "Delete", danger: true }))) return;
        r = await data.budgetApi({ action: "deleteCategory", categoryId: c.id });
        message = "Category deleted.";
      } else return;
      if (r && !r.unchanged) toast(message, "success");
      if (r) load();
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      load();
    }
  };
  container.addEventListener("click", onClick);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
  };
}
