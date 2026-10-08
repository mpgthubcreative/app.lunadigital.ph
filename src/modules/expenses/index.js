// Expenses (Phase 10): one expense per compact row.
//   Date | Category | Vendor / Payee | Method | Reference | Amount | Recurring | View details
// "Add expense" is one small form. View details holds the record and its
// activity; Edit -> Save changes it (Luna moves the operating-expense
// figures itself); "⋯ More" -> Remove expense (reason required, kept in
// history). The server keeps every metric; nothing here computes one.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { DEFAULT_EXPENSE_CATEGORIES, EXPENSE_METHODS, EXPENSE_METHOD_IDS, expenseCategoryLabel, parseCentavos, businessDate, workspaceModuleLabel, snapshotWorkspaceTemplateId } from "@shared/index.js";
import * as defaultData from "./data.js";
import { when } from "../orders/view.js";

const methodLabel = (id) => EXPENSE_METHODS[id]?.label ?? id;
const pesos = (c) => (c / 100).toFixed(2);
const CATEGORY_OPTIONS = DEFAULT_EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));
const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const YES_NO = [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }];

export function expenseRow(e, { currency = "PHP" } = {}) {
  return {
    id: e.id,
    date: formatDayId(e.date),
    category: expenseCategoryLabel(e.category),
    payee: e.payee || "—",
    method: methodLabel(e.method),
    reference: e.reference || "—",
    amount: formatCentavos(e.amount, currency),
    recurring: e.recurring ? "Yes" : "No",
  };
}

// "Oct 8, 2:15 PM • Carlo • Amount changed ₱2,000 → ₱1,500".
export function expenseActivity(e, { timezone } = {}) {
  return (e.history || []).map((h) => [when(h.at, timezone), h.actor?.name ?? "", (h.label || h.type) + (h.reason ? ` · Reason: ${h.reason}` : "")].filter(Boolean).join(" • "));
}

const FIELDS = (e, today) => [
  { name: "date", label: "Date", type: "date", value: e?.date ?? today, max: today, required: true },
  { name: "category", label: "Category", type: "select", options: CATEGORY_OPTIONS, value: e?.category ?? "misc" },
  { name: "amount", label: "Amount (PHP)", value: e ? pesos(e.amount) : "", inputmode: "decimal", required: true },
  { name: "payee", label: "Vendor / payee", value: e?.payee ?? "" },
  { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: e?.method ?? "cash" },
  { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: e?.reference ?? "" },
  { name: "recurring", label: "Recurring", type: "select", options: YES_NO, value: e?.recurring ? "yes" : "no" },
  { name: "notes", label: "Notes", type: "textarea", value: e?.notes ?? "" },
];

function parse(v) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  return { date: v.date, category: v.category, amount, payee: v.payee || null, method: v.method, reference: v.reference || null, notes: v.notes || null, recurring: v.recurring === "yes" };
}

export function addExpenseDialog({ api, today }) {
  return formDialog({
    title: "Add expense",
    fields: FIELDS(null, today),
    submitLabel: "Save",
    onSubmit: (v) => {
      const e = parse(v);
      for (const k of ["payee", "reference", "notes"]) if (e[k] === null) delete e[k];
      return api("expenses", { method: "POST", body: { action: "create", expense: e } });
    },
  });
}

export function editExpenseDialog({ expense, api, today }) {
  return formDialog({
    title: "Edit expense",
    fields: FIELDS(expense, today),
    submitLabel: "Save",
    onSubmit: (v) => {
      const next = parse(v);
      // Only what changed is sent.
      const changes = {};
      for (const [k, val] of Object.entries(next)) if ((expense[k] ?? null) !== (val ?? null) && !(k === "recurring" && Boolean(expense.recurring) === val)) changes[k] = val;
      if (!Object.keys(changes).length) return { unchanged: true };
      return api("expenses", { method: "POST", body: { action: "update", expenseId: expense.id, expectedRevision: expense.revision, changes } });
    },
  });
}

export function removeExpenseDialog({ expense, api, currency = "PHP" }) {
  return formDialog({
    title: `Remove ${formatCentavos(expense.amount, currency)} expense?`,
    intro: "Use this for an expense entered by mistake. It stays in the history but no longer counts in Operating Expenses.",
    fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
    submitLabel: "Remove expense",
    onSubmit: (v) => api("expenses", { method: "POST", body: { action: "remove", expenseId: expense.id, reason: v.reason } }),
  });
}

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast, now = () => new Date() } = {}) {
  const perms = session.member.permissions;
  const can = { create: perms["expenses.create"] === true, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const title = workspaceModuleLabel(snapshotWorkspaceTemplateId(session.entitlements), "expenses", "Expenses");
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "active" }, cursors: [], rows: [], hasMore: false, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      const page = await data.listExpenses(businessId, { filters: state.filters, cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("expenses: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load expenses.";
    }
    state.loading = false;
    if (alive) draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;

  function draw() {
    if (!alive) return;
    const f = state.filters;
    const rows = state.rows.map((e) => expenseRow(e, { currency }));
    render(
      container,
      html`
        ${pageHeader({ title, subtitle: "Rent, utilities, delivery, salaries and the other costs of running the business.", actions: can.create ? html`<button type="button" class="btn btn-primary" data-act="new">Add expense</button>` : "" })}
        <form class="section card filters filters-inline" data-role="filters">
          <input class="input" type="date" name="from" value="${f.from || ""}" aria-label="From" />
          <input class="input" type="date" name="to" value="${f.to || ""}" aria-label="To" />
          <select class="select" name="category" aria-label="Category">${opt("", "Any category", f.category || "")}${CATEGORY_OPTIONS.map((c) => opt(c.value, c.label, f.category))}</select>
          <select class="select" name="method" aria-label="Method">${opt("", "Any method", f.method || "")}${METHOD_OPTIONS.map((m) => opt(m.value, m.label, f.method))}</select>
          <input class="input" name="search" placeholder="Payee or reference" value="${f.search || ""}" autocomplete="off" aria-label="Search payee or reference" />
          <select class="select" name="status" aria-label="Show">${opt("active", "Active", f.status)}${opt("removed", "Removed", f.status)}</select>
          <button type="submit" class="btn">Apply</button>
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !rows.length
                ? emptyState({ iconName: "expenses", title: "No expenses", body: "Expenses you add appear here and in the dashboard's Operating expenses." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="expenses">
                    <thead><tr><th>Date</th><th>Category</th><th>Vendor / Payee</th><th class="col-secondary">Method</th><th class="col-secondary">Reference</th><th class="num">Amount</th><th class="col-secondary">Recurring</th><th></th></tr></thead>
                    <tbody>${rows.map(
                      (r) => html`<tr data-expense="${r.id}">
                        <td>${r.date}</td><td>${r.category}</td><td>${r.payee}</td>
                        <td class="col-secondary">${r.method}</td><td class="col-secondary">${r.reference}</td>
                        <td class="num">${r.amount}</td><td class="col-secondary">${r.recurring}</td>
                        <td class="row-actions"><button type="button" class="btn btn-compact" data-act="view" data-id="${r.id}">View details</button></td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>`
    );
  }

  const done = (message) => (result) => {
    if (!result) return false;
    if (!result.unchanged) toast(message, "success");
    load();
    return true;
  };

  function openView(e) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const active = e.status === "active";
    render(
      backdrop,
      html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Expense" data-role="expense-view">
        <div class="modal-header"><h2 class="card-title">${formatCentavos(e.amount, currency)} · ${expenseCategoryLabel(e.category)}</h2>
          ${active ? "" : html`<div class="page-actions">${badge("Removed", "neutral")}</div>`}</div>
        <div class="modal-body">
          <dl class="dl dl-compact" data-role="expense-fields">
            <dt>Date</dt><dd>${formatDayId(e.date)}</dd>
            <dt>Amount</dt><dd>${formatCentavos(e.amount, currency)}</dd>
            <dt>Category</dt><dd>${expenseCategoryLabel(e.category)}</dd>
            <dt>Vendor / payee</dt><dd>${e.payee || "—"}</dd>
            <dt>Payment method</dt><dd>${methodLabel(e.method)}</dd>
            <dt>Reference</dt><dd>${e.reference || "—"}</dd>
            <dt>Recurring</dt><dd>${e.recurring ? "Yes" : "No"}</dd>
            ${e.notes ? html`<dt>Notes</dt><dd>${e.notes}</dd>` : ""}
            <dt>Added</dt><dd>${e.createdBy?.name ?? ""} · ${when(e.createdAt, timezone)}</dd>
            <dt>Last changed</dt><dd>${e.updatedBy?.name ?? ""} · ${when(e.updatedAt, timezone)}</dd>
          </dl>
          <h3 class="section-title">Activity</h3>
          <ul class="list activity" data-role="expense-activity">${expenseActivity(e, { timezone }).map((line) => html`<li>${line}</li>`)}</ul>
        </div>
        <div class="modal-footer">
          ${active && can.remove ? html`<div class="menu-wrap"><button type="button" class="btn" data-act="more">⋯ More</button><div class="menu" data-role="more-menu" hidden><button type="button" class="menu-item menu-danger" data-act="remove">Remove expense</button></div></div>` : ""}
          ${active && can.update ? html`<button type="button" class="btn" data-act="edit">Edit</button>` : ""}
          <button type="button" class="btn" data-act="close">Close</button>
        </div>
      </div>`
    );
    backdrop.addEventListener("click", async (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (ev.target === backdrop || act === "close") return close();
      if (act === "more") {
        const menu = backdrop.querySelector('[data-role="more-menu"]');
        menu.hidden = !menu.hidden;
        return undefined;
      }
      if (act === "edit" && done("Expense updated")(await editExpenseDialog({ expense: e, api, today: today() }))) close();
      if (act === "remove" && done("Expense removed")(await removeExpenseDialog({ expense: e, api, currency }))) close();
      return undefined;
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    switch (el.dataset.act) {
      case "new":
        return done("Expense added")(await addExpenseDialog({ api, today: today() }));
      case "view":
        return openView(state.rows.find((r) => r.id === el.dataset.id));
      case "next":
        state.cursors.push(state.rows.at(-1));
        return load();
      case "prev":
        state.cursors.pop();
        return load();
      default:
        return undefined;
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const el = event.target.elements;
    state.filters = Object.fromEntries(
      [["status", el.status.value], ["from", el.from.value], ["to", el.to.value], ["category", el.category.value], ["method", el.method.value], ["search", el.search.value.trim()]].filter(([, v]) => v)
    );
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
