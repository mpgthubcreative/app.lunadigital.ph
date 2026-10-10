// Wedding Expenses (Phase 16): the Expenses Core with the Bridal profile,
// one compact row per expense.
//   Date | Category | Supplier / Payee | Method | Reference | Amount | View details
// Categories are the couple's own (Wedding Budget); an expense may be paid
// to a saved supplier (its name is kept on the expense, and it counts as
// paid to that supplier). Completed spending only: future dates are
// refused (money still to be paid belongs in Supplier Payments).

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, rowMenu, bindRowMenus, filterBar } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { EXPENSE_METHODS, EXPENSE_METHOD_IDS, parseCentavos, businessDate } from "@shared/index.js";
import { categoryName, optionsOf, activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";

const methodLabel = (id) => EXPENSE_METHODS[id]?.label ?? id;
const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const YES_NO = [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }];

function fields(e, { today, categories, suppliers }) {
  const active = categories.filter((c) => c.status === "active");
  const linked = Boolean(e?.supplierPaymentId);
  return [
    { name: "date", label: "Date paid", type: "date", value: e?.date ?? today, max: today, required: true, hint: "Not paid yet? Schedule it under Supplier Payments instead." },
    { name: "category", label: "Category", type: "select", options: optionsOf(active, { include: e ? { value: e.category, label: `${categoryName(new Map(categories.map((c) => [c.id, c.name])), e)} (inactive)` } : null }), value: e?.category ?? active[0]?.id ?? "" },
    { name: "amount", label: "Amount (PHP)", value: e ? (e.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
    { name: "supplierId", label: linked ? "Supplier (from a supplier payment)" : "Supplier (saved)", type: "select", disabled: linked, options: optionsOf(suppliers, { blank: "— None —", include: e?.supplierId ? { value: e.supplierId, label: e.payee || "Saved supplier" } : null }), value: e?.supplierId ?? "" },
    { name: "payee", label: "Or payee name", value: e && !e.supplierId ? e.payee ?? "" : "", hint: "Used when no saved supplier is chosen." },
    { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: e?.method ?? "cash" },
    { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: e?.reference ?? "" },
    { name: "recurring", label: "Recurring", type: "select", options: YES_NO, value: e?.recurring ? "yes" : "no" },
    { name: "notes", label: "Notes", type: "textarea", value: e?.notes ?? "" },
  ];
}

export function parseWeddingExpense(v, current = null) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.category) throw new Error("Choose a category (add categories on the Wedding Budget screen)");
  // A disabled select isn't submitted: keep the current supplier.
  const supplierId = v.supplierId === undefined ? current?.supplierId ?? null : v.supplierId || null;
  return { date: v.date, category: v.category, amount, supplierId, payee: supplierId ? undefined : (v.payee || "").trim() || null, method: v.method, reference: (v.reference || "").trim() || null, notes: (v.notes || "").trim() || null, recurring: v.recurring === "yes" };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const can = { create: perms["expenses.create"] === true, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "active" }, cursors: [], rows: [], hasMore: false, categories: [], suppliers: [], loading: true, error: null };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, sups, page] = await Promise.all([
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        state.suppliers.length || !perms["vendors.view"] ? state.suppliers : data.activeSuppliers(businessId).catch(() => []),
        data.listWeddingExpenses(businessId, state.filters, { cursor: state.cursors.at(-1) || null }),
      ]);
      state.categories = cats;
      state.suppliers = sups;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("wedding expenses: load failed:", err && (err.code || err.message));
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
        ${pageHeader({ title: "Wedding Expenses", subtitle: "What you've paid for the wedding. Payments to a saved supplier count toward its balance.", actions: can.create ? html`<button type="button" class="btn btn-primary" data-act="new">Add expense</button>` : "" })}
        ${filterBar({
          fields: [
            { name: "search", label: "Payee or reference", type: "search", primary: true, value: f.search },
            { name: "category", label: "Category", type: "select", primary: true, options: state.categories.map((c) => [c.id, c.name]), value: f.category, all: "Any category" },
            { name: "supplierId", label: "Supplier", type: "select", primary: false, options: state.suppliers.map((s) => [s.id, s.name]), value: f.supplierId, all: "Any supplier" },
            { name: "method", label: "Method", type: "select", primary: false, options: METHOD_OPTIONS.map((m) => [m.value, m.label]), value: f.method, all: "Any method" },
            { name: "from", label: "From", type: "date", value: f.from },
            { name: "to", label: "To", type: "date", value: f.to },
            { name: "status", label: "Show", type: "select", primary: false, options: [["active", "Active"], ["removed", "Removed"]], value: f.status || "active", def: "active" },
          ],
          end: mayExport(session, "weddingExpenses") && (f.status || "active") === "active" ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("weddingExpenses")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "budget", title: "No expenses", body: state.categories.length ? "Expenses you add count against your wedding budget right away." : "Add your wedding budget categories first." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="expenses">
                    <thead><tr><th class="m-only"></th><th>Date</th><th>Category</th><th>Supplier / Payee</th><th class="col-secondary">Method</th><th class="col-secondary">Reference</th><th class="num">Amount</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (e) => html`<tr data-expense="${e.id}" data-open>${mobileCell({ title: e.payee || categoryName(n, e), sub: `${categoryName(n, e)} · ${formatDayId(e.date)}`, end: formatCentavos(e.amount, currency) })}
                        <td>${formatDayId(e.date)}</td><td>${categoryName(n, e)}</td><td>${e.payee || "—"}</td>
                        <td class="col-secondary">${methodLabel(e.method)}</td><td class="col-secondary">${e.reference || "—"}</td>
                        <td class="num">${formatCentavos(e.amount, currency)}</td>
                        <td class="row-actions" data-m="more">${openButton(e.id, "View details", { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>`}
        </section>`
    );
  }

  const ctx = () => ({ today: today(), categories: state.categories, suppliers: state.suppliers });
  const addDialog = () =>
    formDialog({
      title: "Add wedding expense",
      fields: fields(null, ctx()),
      onSubmit: (v) => {
        const e = parseWeddingExpense(v);
        for (const k of Object.keys(e)) if (e[k] === null || e[k] === undefined) delete e[k];
        return data.expensesApi({ action: "create", expense: e });
      },
    });
  const editDialog = (e) =>
    formDialog({
      title: "Edit expense",
      fields: fields(e, ctx()),
      onSubmit: (v) => {
        const next = parseWeddingExpense(v, e);
        const changes = {};
        for (const [k, val] of Object.entries(next)) {
          if (val === undefined) continue; // payee comes from the saved supplier
          if (k === "recurring" ? Boolean(e.recurring) !== val : (e[k] ?? null) !== (val ?? null)) changes[k] = val;
        }
        if (!Object.keys(changes).length) return { unchanged: true };
        return data.expensesApi({ action: "update", expenseId: e.id, expectedRevision: e.revision, changes });
      },
    });
  const removeDialog = (e) =>
    formDialog({
      title: `Remove ${formatCentavos(e.amount, currency)} expense?`,
      intro: e.supplierPaymentId ? "It stays in the history but no longer counts as spent or as paid to the supplier. Its supplier payment goes back to Upcoming." : "Use this for an expense entered by mistake. It stays in the history but no longer counts as spent.",
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
        ["Supplier / payee", e.payee || "—"],
        ["Payment method", methodLabel(e.method)],
        ["Reference", e.reference || "—"],
        ["Recurring", e.recurring ? "Yes" : "No"],
        ["From a supplier payment", e.supplierPaymentId ? "Yes" : null],
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
    if (!el || !container.contains(el) || el.dataset.act === "export") return undefined;
    switch (el.dataset.act) {
      case "new":
        if (!state.categories.some((c) => c.status === "active")) {
          toast("Add a wedding budget category first (Wedding Budget).", "danger");
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
      [["status", el.status.value], ["from", el.from.value], ["to", el.to.value], ["category", el.category.value], ["supplierId", el.supplierId.value], ["method", el.method.value], ["search", el.search.value.trim()]].filter(([, v]) => v)
    );
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindMenus = bindRowMenus(container);
  const unbindExport = bindExport(container, () => ({ ...state.filters, status: "active" }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    unbindFilters();
    unbindRows();
    unbindMenus();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
