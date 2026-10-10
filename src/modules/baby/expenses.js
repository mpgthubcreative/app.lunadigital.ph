// Baby Expenses (Phase 15): the Expenses Core with the Baby profile, one
// compact row per expense.
//   Date | Category | Paid to | Paid by | Method | Amount | View details
// Phase 18.6: Provider (who supplied it, a saved directory entry), Payee
// (who received the money) and Paid by (who funded it, possibly shared)
// are separate. Reference / recurring live under "More details".
// Categories are the family's own (Budget & Categories); an expense may be
// paid to a saved provider (its name is kept on the expense). Completed
// spending only: future dates are refused (money still to be paid belongs
// in the Payment Schedule). Edit -> Save; "Remove" keeps it in history and
// it stops counting. Luna updates Spent / Remaining itself.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, rowMenu, bindRowMenus, filterBar } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { EXPENSE_METHODS, EXPENSE_METHOD_IDS, parseCentavos, businessDate, parsePaidByText, paidByText } from "@shared/index.js";
import * as defaultData from "./data.js";
import { categoryName, optionsOf, activityLines, detailsDialog } from "./common.js";

const methodLabel = (id) => EXPENSE_METHODS[id]?.label ?? id;
const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const YES_NO = [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }];

// What the provider snapshot reads as on an older expense (before 18.6 the
// payee held the provider's name).
export const providerNameOf = (e) => (e?.providerId ? e.providerName ?? e.payee ?? "Saved provider" : null);
// "Paid to": the payee, else the provider.
export const paidToOf = (e) => e?.payee || providerNameOf(e) || "—";
export const paidByOf = (e) => (Array.isArray(e?.paidBy) && e.paidBy.length ? e.paidBy.map((p) => p.name).join(" + ") : "Not set");

function fields(e, { today, categories, providers, payers }) {
  const active = categories.filter((c) => c.status === "active");
  return [
    { name: "date", label: "Date paid", type: "date", value: e?.date ?? today, max: today, required: true, hint: "Not paid yet? Add it to the Payment Schedule instead." },
    { name: "amount", label: "Amount (PHP)", value: e ? (e.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
    { name: "category", label: "Category", type: "select", options: optionsOf(active, { include: e ? { value: e.category, label: `${categoryName(new Map(categories.map((c) => [c.id, c.name])), e)} (hidden)` } : null }), value: e?.category ?? active[0]?.id ?? "" },
    { name: "paidBy", label: "Paid by", value: paidByText(e?.paidBy), placeholder: "e.g. Mom   or   Mom 600, Dad 400", suggestions: payers, hint: "Who paid. Shared it? Write each person's share." },
    { name: "providerId", label: "Provider (clinic, shop, service)", type: "select", options: optionsOf(providers, { blank: "— None —", include: e?.providerId ? { value: e.providerId, label: providerNameOf(e) } : null }), value: e?.providerId ?? "" },
    { name: "payee", label: "Paid to", value: e ? (e.payee && e.payee !== providerNameOf(e) ? e.payee : "") : "", placeholder: "Leave blank if you paid the provider", hint: "Who received the money, if not the provider." },
    { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: e?.method ?? "cash" },
    { name: "notes", label: "What was it for?", type: "textarea", value: e?.notes ?? "", placeholder: "e.g. Monthly check-up, crib, diapers" },
    { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: e?.reference ?? "", more: true },
    { name: "recurring", label: "Recurring", type: "select", options: YES_NO, value: e?.recurring ? "yes" : "no", more: true },
  ];
}

export function parseBabyExpense(v) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.category) throw new Error("Choose a category (add categories on the Budget screen)");
  const providerId = v.providerId || null;
  const paidBy = parsePaidByText(v.paidBy, amount);
  return { date: v.date, category: v.category, amount, providerId, payee: v.payee.trim() || null, paidBy, method: v.method, reference: v.reference.trim() || null, notes: v.notes.trim() || null, recurring: v.recurring === "yes" };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const can = { create: perms["expenses.create"] === true, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "active" }, cursors: [], rows: [], hasMore: false, categories: [], providers: [], payers: [], loading: true, error: null };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, provs, page, budget] = await Promise.all([
        state.categories.length ? state.categories : data.listCategories(businessId),
        state.providers.length || !perms["providers.view"] ? state.providers : data.activeProviders(businessId).catch(() => []),
        data.listBabyExpenses(businessId, state.filters, { cursor: state.cursors.at(-1) || null }),
        // Known payer names, for the Paid by suggestions (budget.view only).
        state.payers.length || !perms["budget.view"] ? null : data.getBudget(businessId).catch(() => null),
      ]);
      state.categories = cats;
      state.providers = provs;
      if (budget?.payerNames) state.payers = [...new Set(Object.values(budget.payerNames))].sort();
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
        ${filterBar({
          fields: [
            { name: "search", label: "Paid to or reference", type: "search", primary: true, value: f.search },
            { name: "category", label: "Category", type: "select", primary: true, options: state.categories.map((c) => [c.id, c.name]), value: f.category, all: "Any category" },
            { name: "providerId", label: "Provider", type: "select", primary: false, options: state.providers.map((p) => [p.id, p.name]), value: f.providerId, all: "Any provider" },
            { name: "method", label: "Method", type: "select", primary: false, options: METHOD_OPTIONS.map((m) => [m.value, m.label]), value: f.method, all: "Any method" },
            { name: "from", label: "From", type: "date", value: f.from },
            { name: "to", label: "To", type: "date", value: f.to },
            { name: "status", label: "Show", type: "select", primary: false, options: [["active", "Active"], ["removed", "Removed"]], value: f.status || "active", def: "active" },
          ],
          end: mayExport(session, "babyExpenses") && (f.status || "active") === "active" ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("babyExpenses")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "budget", title: "No expenses", body: state.categories.length ? "Expenses you add count against your budget right away." : "Add your budget categories on the Budget screen first." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="expenses">
                    <thead><tr><th class="m-only"></th><th>Date</th><th>Category</th><th>Paid to</th><th>Paid by</th><th class="col-secondary">Method</th><th class="num">Amount</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (e) => html`<tr data-expense="${e.id}" data-open>${mobileCell({ title: e.payee || providerNameOf(e) || categoryName(n, e), sub: `${categoryName(n, e)} · ${formatDayId(e.date)} · ${paidByOf(e)}`, end: formatCentavos(e.amount, currency) })}
                        <td>${formatDayId(e.date)}</td><td>${categoryName(n, e)}</td><td>${paidToOf(e)}</td><td data-col="paidBy">${paidByOf(e)}</td>
                        <td class="col-secondary">${methodLabel(e.method)}</td>
                        <td class="num">${formatCentavos(e.amount, currency)}</td>
                        <td class="row-actions" data-m="more">${openButton(e.id, "View details", { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>`}
        </section>`
    );
  }

  const ctx = () => ({ today: today(), categories: state.categories, providers: state.providers, payers: state.payers });

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
        // A blank "Paid to" on a provider expense means the provider was paid.
        if (next.payee === null && next.providerId && next.providerId === e.providerId && e.payee === providerNameOf(e)) next.payee = e.payee;
        const was = { ...e, paidBy: e.paidBy ? e.paidBy.map(({ name, amount }) => ({ name, amount })) : null };
        for (const [k, val] of Object.entries(next)) {
          if (val === undefined) continue;
          if (k === "recurring" ? Boolean(e.recurring) !== val : JSON.stringify(was[k] ?? null) !== JSON.stringify(val ?? null)) changes[k] = val;
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
        ["Paid by", Array.isArray(e.paidBy) && e.paidBy.length > 1 ? e.paidBy.map((p) => `${p.name} ${formatCentavos(p.amount, currency)}`).join(" + ") : paidByOf(e)],
        ["Provider", providerNameOf(e) || "—"],
        ["Paid to", paidToOf(e)],
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
        // No budget needed to track spending (Phase 18.6): with no categories
        // yet, someone who can manage the budget gets the suggested ones
        // (no budget amounts) and goes straight on to the expense.
        if (!state.categories.some((c) => c.status === "active")) {
          if (perms["budget.manage"] !== true) {
            toast("Ask the owner to add expense categories first.", "danger");
            return undefined;
          }
          try {
            await data.budgetApi({ action: "setupCategories" });
            state.categories = await data.listCategories(businessId);
          } catch (err) {
            toast(err.message || "Couldn't add the categories", "danger");
            return undefined;
          }
          if (!state.categories.some((c) => c.status === "active")) return undefined;
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
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindMenus = bindRowMenus(container);
  // Active expenses only (removed ones are not exported).
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
