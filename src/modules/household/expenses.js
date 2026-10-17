// Luna Household: Expenses ("Bridal Money for the household": easy expense
// monitoring, not budgeting). One month at a time, one list:
//   ‹ October 2026 ›                                   + Add expense  ⋯
//   Spent · Bills remaining · Advances released · Cash out   (/api/household-money)
//   By category     Groceries ₱14,200 ›   (tap = the list filtered to it)
//   Expenses        Groceries | Puregold | ₱3,250 | Oct 17 | ⋯ (Edit / Details / Remove)
//                   Household Staff | Payroll · Loriza | ₱3,860 | Oct 15   (read-only)
// The month's expenses are loaded once; Category, Search and the category
// drill-down only filter that list, so the totals always match the rows.
// Salaries come from Payroll (read-only rows under Household Staff, never
// expense records); cash advances are cash out, not spending.
// + Add expense: Amount, Category, Date; More details: paid to, method,
// reference, notes, proof. Categories are managed from ⋯ → Manage categories.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton, kpiStrip } from "../../components/ui.js";
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
// One month of a household is small; the list is filtered in the browser.
const MONTH_LIMIT = 500;
export const PAYROLL_KEY = "payroll";
export const STAFF_CATEGORY = "Household Staff";

// "2026-10" -> "October 2026"; shiftMonth("2026-01", -1) -> "2025-12".
export const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
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

// The list's rows: the month's expenses plus its released salaries (read-only,
// under the Household Staff category when there is one). key = category id,
// or PAYROLL_KEY for salaries when no Household Staff category exists.
export function monthRows(expenses, payroll, categories) {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const staff = categories.find((c) => c.name.toLocaleLowerCase("en") === STAFF_CATEGORY.toLocaleLowerCase("en"));
  const rows = expenses.map((e) => ({ kind: "expense", id: e.id, key: e.category, category: categoryName(names, e), payee: e.payee || "", amount: e.amount, date: e.date, record: e }));
  for (const p of payroll || []) rows.push({ kind: "payroll", id: `payroll-${p.id}`, key: staff ? staff.id : PAYROLL_KEY, category: staff ? staff.name : STAFF_CATEGORY, payee: `Payroll${p.staffName ? ` · ${p.staffName}` : ""}`, amount: p.amount, date: p.paidDate });
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.kind === b.kind ? 0 : a.kind === "payroll" ? 1 : -1));
}
// By category, from the same rows (largest first).
export function categoryTotals(rows) {
  const by = new Map();
  for (const r of rows) {
    const c = by.get(r.key) || { key: r.key, name: r.category, amount: 0, count: 0 };
    c.amount += r.amount;
    c.count += 1;
    by.set(r.key, c);
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}
export const matchesSearch = (r, term) => {
  const t = term.trim().toLocaleLowerCase("en");
  if (!t) return true;
  const e = r.record || {};
  return [r.payee, r.category, e.notes, e.reference].some((x) => typeof x === "string" && x.toLocaleLowerCase("en").includes(t));
};

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), prepareProof = defaultPrepareProof, location: loc = globalThis.location } = {}) {
  const perms = session.member.permissions;
  const can = { create: perms["expenses.create"] === true, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true, category: perms["budget.manage"] === true, bills: perms["schedule.view"] === true };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  // From the Grocery List ("Record grocery expense"): open + Add expense
  // with Groceries and today; the Owner types the trip's real total.
  let groceryTrip = new URLSearchParams(loc?.search || "").get("add") === "groceries";
  const state = { month: today().slice(0, 7), summary: null, expenses: [], categories: [], category: "", search: "", truncated: false, loading: true, error: null };
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
        data.listExpenses(businessId, { status: "active", from, to }, { pageSize: MONTH_LIMIT }),
      ]);
      state.summary = summary;
      state.categories = cats;
      state.expenses = page.rows;
      state.truncated = page.hasMore === true;
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
    if (!s) return state.loading ? skeleton(1) : "";
    return kpiStrip(
      [
        { id: "spent", label: "Spent", value: money(s.spent), hint: s.staffPaid ? `incl. ${money(s.staffPaid)} payroll` : "" },
        { id: "bills", label: "Bills remaining", value: money(s.billsRemaining), hint: s.billsDue ? `${s.billsDue} to pay` : "None due" },
        { id: "advances", label: "Advances released", value: money(s.advancesReleased), hint: s.advancesReleased ? "Repaid through payroll" : "" },
        { id: "cashout", label: "Cash out", value: money(s.cashOut ?? s.spent), hint: "Spent + advances" },
      ],
      { role: "month-summary" }
    );
  }

  const rowMenu = (r) =>
    html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${r.payee || r.category} ${money(r.amount)}">⋯</summary><div class="line-menu-list" role="menu">
      ${can.update ? html`<button type="button" class="menu-item" role="menuitem" data-act="edit" data-id="${r.id}">Edit</button>` : ""}
      <button type="button" class="menu-item" role="menuitem" data-act="view" data-id="${r.id}">Details</button>
      ${can.remove ? html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item menu-danger" role="menuitem" data-act="remove" data-id="${r.id}">Remove</button>` : ""}
    </div></details>`;
  const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");
  const row = (r) => html`<li class="wl-row hx-row" data-kind="${r.kind}" data-row="${r.id}">
    <span class="hx-cat">${r.category}</span>
    <span class="wl-main hx-main"><span class="wl-name">${r.payee || r.category}</span><span class="wl-sub hx-sub">${r.category}</span></span>
    <span class="wl-amt hx-amt">${money(r.amount)}</span>
    <span class="wl-due hx-date">${short(r.date)}</span>
    ${r.kind === "expense" ? rowMenu(r) : html`<span class="wl-menu-gap" aria-hidden="true"></span>`}
  </li>`;

  function listHtml(all) {
    const cat = state.category;
    const rows = all.filter((r) => (!cat || r.key === cat) && matchesSearch(r, state.search));
    const catName = cat ? all.find((r) => r.key === cat)?.category ?? categoryNameOf(state.categories, cat) ?? "Category" : "";
    const total = rows.reduce((t, r) => t + r.amount, 0);
    return html`<section class="wl-section" data-section="list">
      ${cat
        ? html`<div class="hx-drill" data-role="drill"><button type="button" class="btn btn-compact btn-ghost" data-act="clear-cat">‹ All expenses</button><h2 class="section-title" data-role="drill-title">${catName} — ${monthName(state.month)}</h2><p class="hx-drill-total" data-role="drill-total"><b>${money(total)}</b> total</p></div>`
        : html`<h2 class="wl-cat-head"><span class="wl-group-title">Expenses</span>${state.search ? html`<span class="wl-cat-counts">· ${rows.length} found</span>` : ""}</h2>`}
      ${!rows.length
        ? html`<p class="stat-hint wl-none" data-role="none">${state.search || cat ? "No expenses match." : "No expenses this month yet."}</p>`
        : html`<ul class="wl-list" data-role="expenses">${rows.map(row)}</ul>`}
      ${state.truncated ? html`<p class="stat-hint">Showing the first ${MONTH_LIMIT} expenses of the month.</p>` : ""}
    </section>`;
  }

  function draw() {
    if (!alive) return;
    const isNow = state.month === today().slice(0, 7);
    const all = monthRows(state.expenses, state.summary?.payroll ?? [], state.categories);
    const totals = categoryTotals(all);
    render(
      container,
      html`
        ${pageHeader({
          title: "Expenses",
          actions: html`${can.create ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add expense</button>` : ""}${can.category || can.bills
            ? html`<details class="line-menu hx-page-menu"><summary class="btn btn-ghost" aria-label="More expense actions">⋯</summary><div class="line-menu-list" role="menu">
                ${can.category ? html`<a class="menu-item" role="menuitem" href="/budget" data-link data-role="manage-categories">Manage categories</a>` : ""}
                ${can.bills ? html`<a class="menu-item" role="menuitem" href="/payment-schedule" data-link>Bills</a>` : ""}
              </div></details>`
            : ""}`,
        })}
        <form class="hx-tools" data-role="filters">
          <div class="hx-month" data-role="month-nav">
            <button type="button" class="btn btn-compact btn-ghost" data-act="month-prev" aria-label="Previous month">‹</button>
            <strong data-role="month">${monthLabel(state.month)}</strong>
            <button type="button" class="btn btn-compact btn-ghost" data-act="month-next" aria-label="Next month" ${isNow ? "disabled" : ""}>›</button>
          </div>
          <select class="select hx-filter" name="category" aria-label="Category" data-act="filter-cat">
            <option value="">All categories</option>
            ${totals.map((c) => html`<option value="${c.key}" ${c.key === state.category ? "selected" : ""}>${c.name}</option>`)}
          </select>
          <input class="input hx-filter hx-search" type="search" name="search" value="${state.search}" placeholder="Search payee, notes, ref" aria-label="Search expenses">
        </form>
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            ${summaryHtml()}
            ${state.loading
              ? skeleton(4)
              : html`
                ${!state.category && totals.length
                  ? html`<section class="wl-section" data-section="by-category"><h2 class="wl-cat-head"><span class="wl-group-title">By category</span></h2>
                      <ul class="wl-list" data-role="category-totals">${totals.map(
                        (c) => html`<li class="wl-row hx-cat-row"><button type="button" class="wl-main hx-cat-btn" data-act="cat" data-cat="${c.key}" aria-label="${c.name}: ${money(c.amount)}, show these expenses"><span class="wl-name">${c.name}</span><span class="hx-cat-amt">${money(c.amount)}</span><span class="hx-go" aria-hidden="true">›</span></button></li>`
                      )}</ul></section>`
                  : ""}
                ${listHtml(all)}`}`}`
    );
    const search = container.querySelector(".hx-search");
    if (search && state.focusSearch) {
      search.focus();
      search.setSelectionRange?.(search.value.length, search.value.length);
    }
  }

  // ---- Proof (one per expense) ----
  const sendProof = async (expenseId, file) => data.attachExpenseProof(expenseId, await prepareProof(file, { pdf: true }));
  const attachAfter = async (result, file) => {
    if (!file || !result?.expenseId || result.alreadyRecorded) return;
    try {
      await sendProof(result.expenseId, file);
    } catch (err) {
      toast(`Saved, but the proof didn't upload (${err.message || "error"}). Add it from Edit.`, "danger");
    }
  };
  const showProof = (e) => viewProof({ title: `Proof · ${money(e.amount)}${e.payee ? ` · ${e.payee}` : ""}`, load: async () => (await data.expenseProof(e.id)).proof });

  const expenseFields = (e = null, prefill = {}) => {
    const day = today();
    return [
      { name: "amount", label: "Amount (₱)", value: e ? (e.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
      householdCategoryField(state.categories, { value: e ? categoryNameOf(state.categories, e.category) || e.categoryName || "" : prefill.category || "" }),
      { name: "date", label: "Date paid", type: "date", value: e?.date ?? day, max: day, required: true, hint: e ? "" : "Not paid yet? Add it under Bills." },
      { name: "payee", label: "Payee / merchant", value: e?.payee ?? "", placeholder: "e.g. Puregold, Meralco", more: true },
      { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: e?.method ?? "cash", more: true },
      { name: "reference", label: "Reference (OR no., bill account, transfer ref)", value: e?.reference ?? "", more: true },
      { name: "notes", label: "Notes", type: "textarea", value: e?.notes ?? "", more: true },
      ...(!e || e.status === "active" ? [proofField(e?.proof ? "Replace receipt / proof (photo or PDF)" : "Receipt / proof (photo or PDF, optional)")] : []),
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
        ["Payee / merchant", e.payee || "—"],
        ["Payment method", methodLabel(e.method)],
        ["Reference", e.reference || "—"],
        ["From a bill", e.scheduleId ? "Yes" : null],
        ["Notes", e.notes],
        ["Receipt / proof", proofLine(e.proof, timezone)],
      ],
      activity: activityLines(e.history, timezone),
      actions: [...(e.proof ? [{ act: "proof-view", label: "View proof" }] : [])],
      onAction: async (act) => {
        if (act === "proof-view") showProof(e);
        return false;
      },
    });
  }

  const expenseOf = (id) => state.expenses.find((r) => r.id === id);
  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "filter-cat") return undefined;
    el.closest("details.line-menu")?.removeAttribute("open");
    try {
      switch (el.dataset.act) {
        case "new":
          return done("Expense added")(await addDialog());
        case "view": {
          const e = expenseOf(el.dataset.id);
          return e ? openView(e) : undefined;
        }
        case "edit": {
          const e = expenseOf(el.dataset.id);
          return e ? done("Expense updated")(await editDialog(e)) : undefined;
        }
        case "remove": {
          const e = expenseOf(el.dataset.id);
          return e ? done("Expense removed")(await removeDialog(e)) : undefined;
        }
        case "cat":
          state.category = el.dataset.cat;
          draw();
          return container.querySelector('[data-role="drill"]')?.scrollIntoView?.({ block: "start" });
        case "clear-cat":
          state.category = "";
          return draw();
        case "month-prev":
        case "month-next":
          state.month = shiftMonth(state.month, el.dataset.act === "month-prev" ? -1 : 1);
          return load();
        default:
          return undefined;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      return undefined;
    }
  };
  const onChange = (event) => {
    if (event.target.name === "category") {
      state.category = event.target.value;
      draw();
    }
  };
  const onInput = (event) => {
    if (event.target.name !== "search") return;
    state.search = event.target.value;
    state.focusSearch = true;
    draw();
    state.focusSearch = false;
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role === "filters") event.preventDefault();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("input", onInput);
  container.addEventListener("submit", onSubmit);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("input", onInput);
    container.removeEventListener("submit", onSubmit);
  };
}
