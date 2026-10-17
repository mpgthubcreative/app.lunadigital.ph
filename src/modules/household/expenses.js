// Luna Household: Expenses (household-payroll v3). One month at a time:
//   Spent | Bills remaining | Payroll due | Budget left   (/api/household-money)
//   By category (salaries paid show under "Household Staff", from Payroll)
//   This month's expenses, one compact row each (Date | Category | Paid to | Method | Amount)
// + Add expense: Amount, Category, Date; More details: paid to, method,
// reference, notes, proof. A category is typed (the household's own, then
// the usual ones); a new name becomes a category on save. Payroll stays the
// record for salaries: they're never entered here, so nothing counts twice.
// Cash advances aren't spending (they're repaid through payroll).

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton, mobileCell, openButton, bindRowOpen, kpiStrip, barRows, section } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { EXPENSE_METHODS, EXPENSE_METHOD_IDS, SUGGESTED_HOUSEHOLD_CATEGORIES, parseCentavos, businessDate } from "@shared/index.js";
import { categoryName, activityLines, detailsDialog } from "../baby/common.js";
import { categoryField, categoryNameOf, resolveCategory } from "../wedding/categories.js";
import { proofField, proofLine } from "../wedding/expenses.js";
import { prepareProof as defaultPrepareProof } from "../../lib/image.js";
import { viewProof } from "../../components/proof-viewer.js";
import * as defaultData from "./money-data.js";

const methodLabel = (id) => EXPENSE_METHODS[id]?.label ?? id;
const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const PAGE = 25;

// "2026-10" -> "October 2026"; shiftMonth("2026-01", -1) -> "2025-12".
export const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
export function shiftMonth(m, by) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export const monthRange = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return { from: `${m}-01`, to: `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}` };
};

export const householdCategoryField = (categories, opts = {}) => categoryField(categories, { placeholder: "e.g. Groceries", suggested: SUGGESTED_HOUSEHOLD_CATEGORIES, hint: "Pick one or type a new one.", ...opts });

export function parseHouseholdExpense(v) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.date) throw new Error("Choose the date paid");
  return { date: v.date, amount, payee: (v.payee || "").trim() || null, method: v.method || "cash", reference: (v.reference || "").trim() || null, notes: (v.notes || "").trim() || null };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), prepareProof = defaultPrepareProof, location: loc = globalThis.location } = {}) {
  // From the Grocery List ("Record grocery expense"): open + Add expense
  // with Groceries and today; the Owner types the trip's real total.
  let groceryTrip = new URLSearchParams(loc?.search || "").get("add") === "groceries";
  const perms = session.member.permissions;
  const can = { create: perms["expenses.create"] === true, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true, category: perms["budget.manage"] === true, bills: perms["schedule.view"] === true };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { month: today().slice(0, 7), summary: null, rows: [], cursors: [], hasMore: false, categories: [], loading: true, error: null };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));
  const money = (c) => formatCentavos(c ?? 0, currency);

  async function load() {
    state.loading = true;
    draw();
    try {
      const { from, to } = monthRange(state.month);
      const [summary, cats, page] = await Promise.all([
        perms["budget.view"] ? data.householdMonth(state.month).catch(() => null) : null,
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        data.listExpenses(businessId, { status: "active", from, to }, { cursor: state.cursors.at(-1) || null, pageSize: PAGE }),
      ]);
      state.summary = summary;
      state.categories = cats;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
      if (groceryTrip && can.create) {
        groceryTrip = false;
        try {
          globalThis.history?.replaceState?.({}, "", "/expenses");
        } catch {}
        queueMicrotask(async () => done("Grocery expense recorded")(await addDialog({ category: "Groceries" })));
      }
    } catch (err) {
      console.error("household expenses: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load expenses.";
    }
    state.loading = false;
    draw();
  }

  function summaryHtml() {
    const s = state.summary;
    if (!s) return state.loading ? skeleton(2) : "";
    const over = s.left !== null && s.left < 0;
    return html`${kpiStrip(
      [
        { id: "spent", label: "Spent", value: money(s.spent), hint: s.staffPaid ? `incl. ${money(s.staffPaid)} staff pay` : "" },
        { id: "bills", label: "Bills remaining", value: money(s.billsRemaining), hint: s.billsDue ? `${s.billsDue} bill${s.billsDue === 1 ? "" : "s"} to pay` : "None due" },
        { id: "payroll", label: "Payroll due", value: s.current ? money(s.payrollDue) : "—", hint: s.current ? "Next payday" : "", empty: !s.current },
        { id: "left", label: "Budget left", value: s.budget === null ? "No budget" : over ? `Over ${money(-s.left)}` : money(s.left), hint: s.budget === null ? "" : `of ${money(s.budget)}`, hintTone: over ? "danger" : "", empty: s.budget === null },
      ],
      { role: "month-summary" }
    )}
    <p class="stat-hint" data-role="cash-flow">Spent ${money(s.spent)} · Advances released ${money(s.advancesReleased ?? 0)} · <strong>Cash out ${money(s.cashOut ?? s.spent)}</strong>${s.advancesReleased ? " (advances are repaid through payroll, so they aren't spending)" : ""}</p>
    ${can.category ? html`<div class="page-actions"><button type="button" class="btn btn-compact" data-act="set-budget">${s.budget === null ? "Set monthly budget" : "Change monthly budget"}</button><a class="btn btn-compact btn-ghost" href="/budget" data-link>Categories</a></div>` : ""}`;
  }

  function categoriesHtml() {
    const s = state.summary;
    if (!s || !s.categories.length) return "";
    const top = Math.max(...s.categories.map((c) => c.amount), 1);
    return section({ id: "by-category", title: "By category", body: barRows(s.categories.map((c, i) => ({ id: `c${i}`, label: c.payroll ? `${c.name} (incl. payroll)` : c.name, value: money(c.amount), pct: (c.amount / top) * 100 })), { role: "category-bars" }) });
  }

  function draw() {
    if (!alive) return;
    const n = names();
    const isNow = state.month === today().slice(0, 7);
    render(
      container,
      html`
        ${pageHeader({ title: "Expenses", subtitle: "Household spending, bills and payroll for the month.", actions: can.create ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add expense</button>` : "" })}
        <div class="toolbar month-nav" data-role="month-nav">
          <button type="button" class="btn btn-compact btn-ghost" data-act="month-prev" aria-label="Previous month">‹</button>
          <strong data-role="month">${monthLabel(state.month)}</strong>
          <button type="button" class="btn btn-compact btn-ghost" data-act="month-next" aria-label="Next month" ${isNow ? "disabled" : ""}>›</button>
          ${can.bills ? html`<a class="btn btn-compact btn-ghost" href="/payment-schedule" data-link>Bills ›</a>` : ""}
        </div>
        ${state.error ? "" : summaryHtml()}
        ${state.error ? "" : categoriesHtml()}
        ${section({ id: "list", title: "Expenses this month", body: html`${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(4)
              : !state.rows.length
                ? emptyState({ iconName: "budget", title: "No expenses this month", body: "Add what you paid for: groceries, utilities, repairs and more. Salaries come from Payroll on their own." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="expenses">
                    <thead><tr><th class="m-only"></th><th>Date</th><th>Category</th><th>Paid to</th><th class="col-secondary">Method</th><th class="num">Amount</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (e) => html`<tr data-expense="${e.id}" data-open>${mobileCell({ title: e.payee || categoryName(n, e), sub: `${categoryName(n, e)} · ${formatDayId(e.date)}${e.scheduleId ? " · Bill" : ""}`, end: money(e.amount) })}
                        <td>${formatDayId(e.date)}</td><td>${categoryName(n, e)}${e.scheduleId ? html` ${badge("Bill", "neutral")}` : ""}</td><td>${e.payee || "—"}</td>
                        <td class="col-secondary">${methodLabel(e.method)}</td>
                        <td class="num">${money(e.amount)}</td>
                        <td class="row-actions" data-m="more">${openButton(e.id, "View details", { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  ${state.cursors.length || state.hasMore ? html`<div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>` : ""}`}` })}`
    );
  }

  // ---- Proof (one per expense) ----
  const sendProof = async (expenseId, file) => data.attachExpenseProof(expenseId, await prepareProof(file, { pdf: true }));
  const attachAfter = async (result, file) => {
    if (!file || !result?.expenseId || result.alreadyRecorded) return;
    try {
      await sendProof(result.expenseId, file);
    } catch (err) {
      toast(`Saved, but the proof didn't upload (${err.message || "error"}). Add it from View details.`, "danger");
    }
  };
  const showProof = (e) => viewProof({ title: `Proof · ${money(e.amount)}${e.payee ? ` · ${e.payee}` : ""}`, load: async () => (await data.expenseProof(e.id)).proof });

  const expenseFields = (e = null, prefill = {}) => {
    const day = today();
    return [
      { name: "amount", label: "Amount (₱)", value: e ? (e.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
      householdCategoryField(state.categories, { value: e ? categoryNameOf(state.categories, e.category) || e.categoryName || "" : prefill.category || "" }),
      { name: "date", label: "Date paid", type: "date", value: e?.date ?? day, max: day, required: true, hint: e ? "" : "Not paid yet? Add it under Bills." },
      { name: "payee", label: "Paid to", value: e?.payee ?? "", placeholder: "e.g. Meralco, SM Supermarket", more: true },
      { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: e?.method ?? "cash", more: true },
      { name: "reference", label: "Reference (OR no., bill account, transfer ref)", value: e?.reference ?? "", more: true },
      { name: "notes", label: "Notes", type: "textarea", value: e?.notes ?? "", more: true },
      ...(!e || e.status === "active" ? [proofField(e?.proof ? "Replace proof (photo or PDF)" : "Proof: receipt photo or PDF (optional)")] : []),
    ];
  };
  const category = (text) => resolveCategory(text, { categories: state.categories, data, canCreate: can.category });

  const addDialog = (prefill = {}) =>
    formDialog({
      title: prefill.category === "Groceries" ? "Record grocery expense" : "Add expense",
      intro: prefill.category === "Groceries" ? "Enter the total you paid for this grocery trip." : "",
      fields: expenseFields(null, prefill),
      moreLabel: "More details",
      submitLabel: "Add expense",
      onSubmit: async (v) => {
        const p = parseHouseholdExpense(v);
        const e = { date: p.date, amount: p.amount, method: p.method, category: await category(v.category) };
        for (const k of ["payee", "reference", "notes"]) if (p[k]) e[k] = p[k];
        const r = await data.expensesApi({ action: "create", expense: e });
        await attachAfter(r, v.proof);
        return r;
      },
    });

  const editDialog = (e) =>
    formDialog({
      title: "Edit expense",
      fields: expenseFields(e),
      moreLabel: "More details",
      submitLabel: "Save changes",
      onSubmit: async (v) => {
        const p = parseHouseholdExpense(v);
        const next = { ...p, category: await category(v.category) };
        const changes = {};
        for (const [k, val] of Object.entries(next)) if ((e[k] ?? null) !== (val ?? null)) changes[k] = val;
        const r = Object.keys(changes).length ? await data.expensesApi({ action: "update", expenseId: e.id, expectedRevision: e.revision, changes }) : null;
        if (v.proof) await sendProof(e.id, v.proof);
        return r || (v.proof ? { proof: true } : { unchanged: true });
      },
    });

  const removeDialog = (e) =>
    formDialog({
      title: `Remove ${money(e.amount)} expense?`,
      intro: e.scheduleId ? "It stays in the history but no longer counts as spent. Its bill goes back to unpaid." : "Use this for an expense entered by mistake. It stays in the history but no longer counts as spent.",
      fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
      submitLabel: "Remove expense",
      onSubmit: (v) => data.expensesApi({ action: "remove", expenseId: e.id, reason: v.reason }),
    });

  const budgetDialog = () => {
    const current = state.summary?.budget ?? null;
    return formDialog({
      title: "Monthly budget",
      intro: "What the household plans to spend in a month, staff pay and bills included. Luna shows what's left as you go.",
      fields: [{ name: "total", label: "Monthly budget (₱)", value: current === null ? "" : String(current / 100), inputmode: "decimal", hint: "Leave blank for no budget." }],
      submitLabel: "Save budget",
      onSubmit: (v) => {
        const text = (v.total || "").trim();
        const total = text ? parseCentavos(text) : null;
        if (total !== null && !(Number.isSafeInteger(total) && total >= 0)) throw new Error("Enter a valid amount (₱0 or more), or leave it blank");
        return data.budgetApi({ action: "setTotal", total });
      },
    });
  };

  const done = (message) => (result) => {
    if (!result) return false;
    if (!result.unchanged) toast(message, "success");
    load();
    return true;
  };

  function openView(e) {
    const active = e.status === "active";
    detailsDialog({
      title: `${money(e.amount)} · ${categoryName(names(), e)}`,
      badgeHtml: active ? "" : badge("Removed", "neutral"),
      rows: [
        ["Date paid", formatDayId(e.date)],
        ["Amount", money(e.amount)],
        ["Category", categoryName(names(), e)],
        ["Paid to", e.payee || "—"],
        ["Payment method", methodLabel(e.method)],
        ["Reference", e.reference || "—"],
        ["From a bill", e.scheduleId ? "Yes" : null],
        ["Notes", e.notes],
        ["Proof", proofLine(e.proof, timezone)],
      ],
      activity: activityLines(e.history, timezone),
      actions: [
        ...(active && can.remove ? [{ act: "remove", label: "Remove", danger: true }] : []),
        ...(e.proof ? [{ act: "proof-view", label: "View proof" }] : []),
        ...(active && can.update ? [{ act: "edit", label: "Edit" }] : []),
      ],
      onAction: async (act) => {
        try {
          if (act === "proof-view") {
            showProof(e);
            return false;
          }
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
    try {
      switch (el.dataset.act) {
        case "new":
          return done("Expense added")(await addDialog());
        case "set-budget":
          return done("Monthly budget saved")(await budgetDialog());
        case "view":
          return openView(state.rows.find((r) => r.id === el.dataset.id));
        case "month-prev":
        case "month-next":
          state.month = shiftMonth(state.month, el.dataset.act === "month-prev" ? -1 : 1);
          state.cursors = [];
          return load();
        case "next":
          state.cursors.push(state.rows.at(-1));
          return load();
        case "prev":
          state.cursors.pop();
          return load();
        default:
          return undefined;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      return undefined;
    }
  };
  container.addEventListener("click", onClick);
  const unbindRows = bindRowOpen(container, { act: "view" });
  load();
  return () => {
    alive = false;
    unbindRows();
    container.removeEventListener("click", onClick);
  };
}
