// Luna Household: Budget & Categories (household-payroll v3). A MONTHLY
// household budget (typed: budgets/current.total) and the household's own
// categories, editable, with this month's spending in each (expenses only;
// salaries show under Household Staff on Expenses, from Payroll).
//   Category | Monthly budget (optional) | Spent this month | Edit · Hide / Delete

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton, mobileCell, kpiStrip } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos } from "../../lib/format.js";
import { SUGGESTED_HOUSEHOLD_CATEGORIES, businessDate } from "@shared/index.js";
import { parseBudget } from "../baby/budget.js";
import { monthLabel } from "./expenses.js";
import * as defaultData from "./money-data.js";

const pesosText = (c) => (Number.isSafeInteger(c) ? String(c / 100) : "");
const categoryFields = (c = {}) => [
  { name: "name", label: "Category name", value: c.name ?? "", required: true },
  { name: "budget", label: "Monthly budget for this category (₱, optional)", value: pesosText(c.budget), inputmode: "decimal" },
];

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog, now = () => new Date() } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["budget.manage"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const month = businessDate(session.business.timezone, now()).slice(0, 7);
  const state = { categories: [], summary: null, loading: true, error: null };
  let alive = true;
  const money = (c) => (c === null || c === undefined ? "—" : formatCentavos(c, currency));

  async function load() {
    state.loading = true;
    draw();
    try {
      [state.categories, state.summary] = await Promise.all([data.listCategories(businessId), data.householdMonth(month).catch(() => null)]);
      state.error = null;
    } catch (err) {
      console.error("household budget: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load the budget.";
    }
    state.loading = false;
    draw();
  }

  function draw() {
    if (!alive) return;
    const s = state.summary;
    const spentIn = (id) => s?.byCategory?.[id] ?? 0;
    render(
      container,
      html`
        ${pageHeader({ title: "Budget & Categories", subtitle: html`Your monthly household budget and the categories you spend in. <a href="/expenses" data-link>Expenses ›</a>` })}
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            ${s
              ? kpiStrip(
                  [
                    { id: "budget", label: "Monthly budget", value: s.budget === null ? "Not set" : money(s.budget), empty: s.budget === null },
                    { id: "spent", label: `Spent · ${monthLabel(month)}`, value: money(s.spent), hint: s.staffPaid ? `incl. ${money(s.staffPaid)} staff pay` : "" },
                    { id: "left", label: "Budget left", value: s.left === null ? "—" : s.left < 0 ? `Over ${money(-s.left)}` : money(s.left), hint: s.left === null ? "" : "after bills and payroll due", hintTone: s.left !== null && s.left < 0 ? "danger" : "", empty: s.left === null },
                  ],
                  { role: "budget-summary" }
                )
              : ""}
            ${canManage ? html`<div class="page-actions"><button type="button" class="btn" data-act="set-budget">${s?.budget === null || !s ? "Set monthly budget" : "Change monthly budget"}</button><button type="button" class="btn btn-primary" data-act="new-category">Add category</button></div>` : ""}
            <section class="card">
              ${state.loading
                ? skeleton(5)
                : !state.categories.length
                  ? html`${emptyState({ iconName: "budget", title: "No categories yet", body: `e.g. ${SUGGESTED_HOUSEHOLD_CATEGORIES.slice(0, 5).join(", ")}.` })}
                      ${canManage ? html`<div class="page-actions"><button type="button" class="btn btn-primary" data-act="suggested">Add the usual household categories</button></div>` : ""}`
                  : html`<div class="table-wrap"><table class="table table-compact rows" data-role="categories">
                      <thead><tr><th class="m-only"></th><th>Category</th><th class="num">Monthly budget</th><th class="num">Spent this month</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
                      <tbody>${state.categories.map((c) => {
                        const spent = spentIn(c.id);
                        const over = Number.isSafeInteger(c.budget) && spent > c.budget;
                        return html`<tr data-category="${c.id}">${mobileCell({ title: c.name, sub: Number.isSafeInteger(c.budget) ? `${money(spent)} of ${money(c.budget)}` : `${money(spent)} spent`, end: over ? `Over ${money(spent - c.budget)}` : "" })}
                          <td>${c.name}${c.status === "active" ? "" : html` ${badge("Hidden", "neutral")}`}</td>
                          <td class="num">${money(c.budget)}</td>
                          <td class="num">${over ? badge(`${money(spent)} · over`, "danger") : money(spent)}</td>
                          <td class="row-actions" data-m="more">${canManage ? categoryActions(c) : ""}</td>
                        </tr>`;
                      })}</tbody></table></div>
                    <p class="stat-hint">A hidden category keeps its expenses; it's just not offered for new ones. Staff salaries come from Payroll (shown under Household Staff on Expenses).</p>`}
            </section>`}
      `
    );
  }

  const used = (c) => (c.useCount ?? 0) > 0;
  const categoryActions = (c) =>
    html`<button type="button" class="btn btn-compact" data-act="edit" data-id="${c.id}" aria-label="Edit ${c.name}">Edit</button>${
      used(c)
        ? html`<button type="button" class="btn btn-compact" data-act="status" data-id="${c.id}" aria-label="${c.status === "active" ? "Hide" : "Show"} ${c.name}">${c.status === "active" ? "Hide" : "Show"}</button>`
        : html`<button type="button" class="btn btn-compact btn-danger-ghost" data-act="delete" data-id="${c.id}" aria-label="Delete ${c.name}">Delete</button>`
    }`;

  const budgetDialog = () =>
    formDialog({
      title: "Monthly budget",
      intro: "What the household plans to spend in a month, staff pay and bills included.",
      fields: [{ name: "total", label: "Monthly budget (₱)", value: state.summary?.budget == null ? "" : String(state.summary.budget / 100), inputmode: "decimal", hint: "Leave blank for no budget." }],
      submitLabel: "Save budget",
      onSubmit: (v) => data.budgetApi({ action: "setTotal", total: parseBudget(v.total, "monthly budget") }),
    });

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const c = state.categories.find((x) => x.id === el.dataset.id);
    try {
      let r = null;
      let message = "Saved.";
      if (el.dataset.act === "set-budget") {
        r = await budgetDialog();
        message = "Monthly budget saved.";
      } else if (el.dataset.act === "new-category") {
        r = await formDialog({ title: "Add category", fields: categoryFields(), onSubmit: (v) => data.budgetApi({ action: "createCategory", category: { name: v.name.trim(), budget: parseBudget(v.budget, "category budget") } }) });
        message = "Category added.";
      } else if (el.dataset.act === "suggested") {
        el.disabled = true;
        r = await data.budgetApi({ action: "setupCategories" });
        message = "Categories added. Rename or delete the ones you don't need.";
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
        message = c.status === "active" ? `${c.name} hidden.` : `${c.name} is shown again.`;
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
