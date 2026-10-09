// Baby Expenses (Phase 15): the Expenses Core with the Baby profile, one
// compact row per expense.
//   Date | Category | Provider / Payee | Method | Reference | Amount | View details
// Categories are the family's own (Budget & Categories); an expense may be
// paid to a saved provider (its name is kept on the expense). Completed
// spending only: future dates are refused (money still to be paid belongs
// in the Payment Schedule). Edit -> Save; "Remove" keeps it in history and
// it stops counting. Luna updates Spent / Remaining itself.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { EXPENSE_METHODS, EXPENSE_METHOD_IDS, parseCentavos, businessDate } from "@shared/index.js";
import * as defaultData from "./data.js";
import { categoryName, optionsOf, activityLines, detailsDialog } from "./common.js";

const methodLabel = (id) => EXPENSE_METHODS[id]?.label ?? id;
const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const YES_NO = [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }];

function fields(e, { today, categories, providers }) {
  const active = categories.filter((c) => c.status === "active");
  return [
    { name: "date", label: "Date paid", type: "date", value: e?.date ?? today, max: today, required: true, hint: "Not paid yet? Add it to the Payment Schedule instead." },
    { name: "category", label: "Category", type: "select", options: optionsOf(active, { include: e ? { value: e.category, label: `${categoryName(new Map(categories.map((c) => [c.id, c.name])), e)} (inactive)` } : null }), value: e?.category ?? active[0]?.id ?? "" },
    { name: "amount", label: "Amount (PHP)", value: e ? (e.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
    { name: "providerId", label: "Provider / vendor (saved)", type: "select", options: optionsOf(providers, { blank: "— None —", include: e?.providerId ? { value: e.providerId, label: e.payee || "Saved provider" } : null }), value: e?.providerId ?? "" },
    { name: "payee", label: "Or payee name", value: e && !e.providerId ? e.payee ?? "" : "", hint: "Used when no saved provider is chosen." },
    { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: e?.method ?? "cash" },
    { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: e?.reference ?? "" },
    { name: "recurring", label: "Recurring", type: "select", options: YES_NO, value: e?.recurring ? "yes" : "no" },
    { name: "notes", label: "Notes", type: "textarea", value: e?.notes ?? "" },
  ];
}

export function parseBabyExpense(v) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.category) throw new Error("Choose a category (add categories on the Budget screen)");
  const providerId = v.providerId || null;
  return { date: v.date, category: v.category, amount, providerId, payee: providerId ? undefined : v.payee.trim() || null, method: v.method, reference: v.reference.trim() || null, notes: v.notes.trim() || null, recurring: v.recurring === "yes" };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const can = { create: perms["expenses.create"] === true, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "active" }, cursors: [], rows: [], hasMore: false, categories: [], providers: [], loading: true, error: null };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, provs, page] = await Promise.all([
        state.categories.length ? state.categories : data.listCategories(businessId),
        state.providers.length || !perms["providers.view"] ? state.providers : data.activeProviders(businessId).catch(() => []),
        data.listBabyExpenses(businessId, state.filters, { cursor: state.cursors.at(-1) || null }),
      ]);
      state.categories = cats;
      state.providers = provs;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("baby expenses: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load expenses.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;

  function draw() {
    if (!alive) return;
    const f = state.filters;
    const n = names();
    render(
      container,
      html`
        ${pageHeader({ title: "Baby Expenses", subtitle: "What you've paid for: check-ups, nursery, clothes, feeding and more.", actions: can.create ? html`<button type="button" class="btn btn-primary" data-act="new">Add expense</button>` : "" })}
        <form class="section card filters filters-inline" data-role="filters">
          <input class="input" type="date" name="from" value="${f.from || ""}" aria-label="From" />
          <input class="input" type="date" name="to" value="${f.to || ""}" aria-label="To" />
          <select class="select" name="category" aria-label="Category">${opt("", "Any category", f.category || "")}${state.categories.map((c) => opt(c.id, c.name, f.category))}</select>
          <select class="select" name="providerId" aria-label="Provider">${opt("", "Any provider", f.providerId || "")}${state.providers.map((p) => opt(p.id, p.name, f.providerId))}</select>
          <select class="select" name="method" aria-label="Method">${opt("", "Any method", f.method || "")}${METHOD_OPTIONS.map((m) => opt(m.value, m.label, f.method))}</select>
          <input class="input" name="search" placeholder="Payee or reference" value="${f.search || ""}" autocomplete="off" aria-label="Search payee or reference" />
          <select class="select" name="status" aria-label="Show">${opt("active", "Active", f.status)}${opt("removed", "Removed", f.status)}</select>
          <button type="submit" class="btn">Apply</button>
          ${mayExport(session, "babyExpenses") && (f.status || "active") === "active" ? html`${exportButton("babyExpenses")}<span class="stat-hint">${exportHint}</span>` : ""}
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !state.rows.length
                ? emptyState({ iconName: "budget", title: "No expenses", body: state.categories.length ? "Expenses you add count against your budget right away." : "Add your budget categories on the Budget screen first." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="expenses">
                    <thead><tr><th>Date</th><th>Category</th><th>Provider / Payee</th><th class="col-secondary">Method</th><th class="col-secondary">Reference</th><th class="num">Amount</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (e) => html`<tr data-expense="${e.id}">
                        <td>${formatDayId(e.date)}</td><td>${categoryName(n, e)}</td><td>${e.payee || "—"}</td>
                        <td class="col-secondary">${methodLabel(e.method)}</td><td class="col-secondary">${e.reference || "—"}</td>
                        <td class="num">${formatCentavos(e.amount, currency)}</td>
                        <td class="row-actions"><button type="button" class="btn btn-compact" data-act="view" data-id="${e.id}">View details</button></td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>`
    );
  }

  const ctx = () => ({ today: today(), categories: state.categories, providers: state.providers });

  const addDialog = () =>
    formDialog({
      title: "Add baby expense",
      fields: fields(null, ctx()),
      onSubmit: (v) => {
        const e = parseBabyExpense(v);
        for (const k of Object.keys(e)) if (e[k] === null || e[k] === undefined) delete e[k];
        return data.expensesApi({ action: "create", expense: e });
      },
    });

  const editDialog = (e) =>
    formDialog({
      title: "Edit expense",
      fields: fields(e, ctx()),
      onSubmit: (v) => {
        const next = parseBabyExpense(v);
        const changes = {};
        for (const [k, val] of Object.entries(next)) {
          if (val === undefined) continue; // payee comes from the saved provider
          if (k === "recurring" ? Boolean(e.recurring) !== val : (e[k] ?? null) !== (val ?? null)) changes[k] = val;
        }
        if (!Object.keys(changes).length) return { unchanged: true };
        return data.expensesApi({ action: "update", expenseId: e.id, expectedRevision: e.revision, changes });
      },
    });

  const removeDialog = (e) =>
    formDialog({
      title: `Remove ${formatCentavos(e.amount, currency)} expense?`,
      intro: e.scheduleId ? "It stays in the history but no longer counts as spent. Its scheduled payment goes back to Upcoming." : "Use this for an expense entered by mistake. It stays in the history but no longer counts as spent.",
      fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
      submitLabel: "Remove expense",
      onSubmit: (v) => data.expensesApi({ action: "remove", expenseId: e.id, reason: v.reason }),
    });

  const done = (message) => (result) => {
    if (!result) return false;
    if (!result.unchanged) toast(message, "success");
    load();
    return true;
  };

  function openView(e) {
    const active = e.status === "active";
    detailsDialog({
      title: `${formatCentavos(e.amount, currency)} · ${categoryName(names(), e)}`,
      badgeHtml: active ? "" : badge("Removed", "neutral"),
      rows: [
        ["Date paid", formatDayId(e.date)],
        ["Amount", formatCentavos(e.amount, currency)],
        ["Category", categoryName(names(), e)],
        ["Provider / payee", e.payee || "—"],
        ["Payment method", methodLabel(e.method)],
        ["Reference", e.reference || "—"],
        ["Recurring", e.recurring ? "Yes" : "No"],
        ["From payment schedule", e.scheduleId ? "Yes" : null],
        ["Notes", e.notes],
      ],
      activity: activityLines(e.history, timezone),
      actions: [...(active && can.remove ? [{ act: "remove", label: "Remove expense", danger: true }] : []), ...(active && can.update ? [{ act: "edit", label: "Edit" }] : [])],
      onAction: async (act) => {
        try {
          if (act === "edit") return done("Expense updated")(await editDialog(e));
          if (act === "remove") return done("Expense removed")(await removeDialog(e));
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    switch (el.dataset.act) {
      case "new":
        if (!state.categories.some((c) => c.status === "active")) {
          toast("Add a budget category first (Budget & Categories).", "danger");
          return undefined;
        }
        return done("Expense added")(await addDialog());
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
    if (el.from.value && el.to.value && el.from.value > el.to.value) {
      toast("Choose a valid date range (the start can't be after the end).", "danger");
      return;
    }
    state.filters = Object.fromEntries(
      [["status", el.status.value], ["from", el.from.value], ["to", el.to.value], ["category", el.category.value], ["providerId", el.providerId.value], ["method", el.method.value], ["search", el.search.value.trim()]].filter(([, v]) => v)
    );
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  // Active expenses only (removed ones are not exported).
  const unbindExport = bindExport(container, () => ({ ...state.filters, status: "active" }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
