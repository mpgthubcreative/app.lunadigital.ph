// Luna Household: Expenses, a simple household statement.
//   Open Expenses -> see total spent -> see unpaid bills -> see where it went.
//   ‹ October 2026 ›                                   + Add expense  ⋯
//   Spent ₱14,803          Bills remaining ₱0          (/api/household-money)
//   UTILITIES                                  ₱9,238
//     Meralco            Due Oct 25            ₱3,000   ⋯ (Paid / Edit / Remove)
//     Parking            Paid · Oct 15         ₱3,000   ⋯ (Mark unpaid / Edit / Remove)
//     Internet           Oct 3                 ₱3,238   ⋯ (Edit / Details / Remove)
//   HOUSEHOLD STAFF                            ₱5,565
//     Payroll · Loriza   Oct 15                ₱5,565      (read-only, from Payroll)
// Categories ARE the list (largest total first; empty ones hidden). A group
// holds the month's expenses, its released salaries and the bills still to
// pay that count in Bills remaining, so the group totals always add up to
// Spent + Bills remaining. Bills: "Paid" records ONE expense through the
// idempotent mark-paid (a repeating bill gets its next one once); "Mark
// unpaid" removes that expense (the bill goes back to unpaid). Salaries are
// never expense records; advances aren't shown here (Payroll / Advances).
// + Add expense: Amount, Category, Date; More details: payee / merchant,
// method, reference, notes, receipt.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { EXPENSE_METHODS, EXPENSE_METHOD_IDS, SUGGESTED_HOUSEHOLD_CATEGORIES, parseCentavos, businessDate, upcomingPart } from "@shared/index.js";
import { categoryName, activityLines, detailsDialog } from "../baby/common.js";
import { categoryField, categoryNameOf, resolveCategory } from "../wedding/categories.js";
import { proofField, proofLine } from "../wedding/expenses.js";
import { prepareProof as defaultPrepareProof } from "../../lib/image.js";
import { viewProof } from "../../components/proof-viewer.js";
import { billFields, parseBill, partKey } from "./bills.js";
import * as defaultData from "./money-data.js";

const methodLabel = (id) => EXPENSE_METHODS[id]?.label ?? id;
const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
// One month of a household is small: everything is loaded and grouped here.
const MONTH_LIMIT = 500;
export const PAYROLL_KEY = "payroll";
export const STAFF_CATEGORY = "Household Staff";

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

// The bills still to pay that the month's Bills remaining counts (same rule
// as /api/household-money): due by the month's end; for the current month
// overdue ones from earlier months too.
export function dueBills(bills, month, today) {
  const { from, to } = monthRange(month);
  const current = month === today.slice(0, 7);
  return bills.filter((s) => s.status === "upcoming" && typeof s.dueDate === "string" && s.dueDate <= to && (current || s.dueDate >= from) && upcomingPart(s) > 0);
}

// Rows for the month: expenses (a paid bill's expense carries its
// scheduleId), released salaries (read-only) and unpaid bills, each with its
// category key (a category id, or PAYROLL_KEY for salaries when there's no
// Household Staff category).
export function monthRows({ expenses, payroll = [], bills = [], categories }) {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const staff = categories.find((c) => c.name.toLocaleLowerCase("en") === STAFF_CATEGORY.toLocaleLowerCase("en"));
  const rows = expenses.map((e) => ({ kind: e.scheduleId ? "bill-paid" : "expense", id: e.id, key: e.category, category: categoryName(names, e), title: e.payee || e.notes || "Expense", amount: e.amount, date: e.date, record: e }));
  for (const p of payroll) rows.push({ kind: "payroll", id: `payroll-${p.id}`, key: staff ? staff.id : PAYROLL_KEY, category: staff ? staff.name : STAFF_CATEGORY, title: `Payroll${p.staffName ? ` · ${p.staffName}` : ""}`, amount: p.amount, date: p.paidDate });
  for (const s of bills) rows.push({ kind: "bill-due", id: s.id, key: s.category, category: names.get(s.category) ?? s.categoryName ?? "—", title: s.description, amount: upcomingPart(s), date: s.dueDate, record: s });
  return rows;
}
// Category groups: total = the sum of its rows; largest first; inside a
// group, bills still to pay first (by due date), then the newest records.
export function groupRows(rows) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.key) || { key: r.key, name: r.category, total: 0, rows: [] };
    g.total += r.amount;
    g.rows.push(r);
    by.set(r.key, g);
  }
  const order = (a, b) => (a.kind === "bill-due") !== (b.kind === "bill-due") ? (a.kind === "bill-due" ? -1 : 1) : a.kind === "bill-due" ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date) || a.title.localeCompare(b.title);
  return [...by.values()].map((g) => ({ ...g, rows: g.rows.sort(order) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog, now = () => new Date(), prepareProof = defaultPrepareProof, location: loc = globalThis.location } = {}) {
  const perms = session.member.permissions;
  const can = { create: perms["expenses.create"] === true, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true, category: perms["budget.manage"] === true, bills: perms["schedule.view"] === true, billsManage: perms["schedule.manage"] === true };
  can.pay = can.billsManage && can.create;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  // From the Grocery List ("Record grocery expense"): open + Add expense
  // with Groceries and today; the Owner types the trip's real total.
  let groceryTrip = new URLSearchParams(loc?.search || "").get("add") === "groceries";
  const state = { month: today().slice(0, 7), summary: null, expenses: [], bills: [], categories: [], truncated: false, loading: true, error: null, busy: new Set() };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));
  const money = (c) => formatCentavos(c ?? 0, currency);
  const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");

  async function load() {
    state.loading = !state.expenses.length && !state.summary;
    draw();
    try {
      const { from, to } = monthRange(state.month);
      const [summary, cats, page, bills] = await Promise.all([
        perms["budget.view"] ? data.householdMonth(state.month).catch(() => null) : null,
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        data.listExpenses(businessId, { status: "active", from, to }, { pageSize: MONTH_LIMIT }),
        can.bills ? data.listBills(businessId, { status: "upcoming", to }, { pageSize: MONTH_LIMIT }).catch(() => ({ rows: [] })) : { rows: [] },
      ]);
      state.summary = summary;
      state.categories = cats;
      state.expenses = page.rows;
      state.bills = bills.rows;
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

  const menu = (r, items) =>
    items.length
      ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${r.title} ${money(r.amount)}">⋯</summary><div class="line-menu-list" role="menu">
          ${items.map((i) => (i.sep ? html`<div class="menu-sep" role="separator"></div>` : html`<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="${i.act}" data-kind="${r.kind}" data-id="${r.id}">${i.label}</button>`))}
        </div></details>`
      : html`<span class="wl-menu-gap" aria-hidden="true"></span>`;
  const rowItems = (r) => {
    if (r.kind === "payroll") return [];
    if (r.kind === "bill-due") return [...(can.pay ? [{ act: "bill-paid", label: "Paid" }] : []), ...(can.billsManage ? [{ act: "bill-edit", label: "Edit" }, { sep: true }, { act: "bill-remove", label: "Remove", danger: true }] : [])];
    if (r.kind === "bill-paid") return [...(can.remove ? [{ act: "bill-unpaid", label: "Mark unpaid" }] : []), ...(can.update ? [{ act: "edit", label: "Edit" }] : []), ...(can.remove && can.billsManage ? [{ sep: true }, { act: "bill-remove-paid", label: "Remove", danger: true }] : [])];
    return [...(can.update ? [{ act: "edit", label: "Edit" }] : []), { act: "view", label: "Details" }, ...(can.remove ? [{ sep: true }, { act: "remove", label: "Remove", danger: true }] : [])];
  };
  const quiet = (r) => (r.kind === "bill-due" ? html`<span class="hx-due${r.date < today() ? " is-over" : ""}">Due ${short(r.date)}</span>` : r.kind === "bill-paid" ? `Paid · ${short(r.date)}` : short(r.date));
  const row = (r) => html`<li class="wl-row hx-row" data-kind="${r.kind}" data-row="${r.id}">
    <span class="wl-main hx-main"><span class="wl-name">${r.title}</span><span class="wl-sub hx-sub">${quiet(r)}</span></span>
    <span class="wl-amt hx-amt">${money(r.amount)}</span>
    ${menu(r, rowItems(r))}
  </li>`;

  function draw() {
    if (!alive) return;
    const isNow = state.month === today().slice(0, 7);
    const s = state.summary;
    const groups = groupRows(monthRows({ expenses: state.expenses, payroll: s?.payroll ?? [], bills: dueBills(state.bills, state.month, today()), categories: state.categories }));
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
        <div class="hx-month" data-role="month-nav">
          <button type="button" class="btn btn-compact btn-ghost" data-act="month-prev" aria-label="Previous month">‹</button>
          <strong data-role="month">${monthLabel(state.month)}</strong>
          <button type="button" class="btn btn-compact btn-ghost" data-act="month-next" aria-label="Next month" ${isNow ? "disabled" : ""}>›</button>
        </div>
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            ${s ? html`<div class="hx-sum" data-role="month-summary"><div class="hx-sum-item" data-widget="spent"><span class="kpi-label">Spent</span><b class="kpi-value">${money(s.spent)}</b></div><div class="hx-sum-item" data-widget="bills"><span class="kpi-label">Bills remaining</span><b class="kpi-value">${money(s.billsRemaining)}</b></div></div>` : state.loading ? skeleton(1) : ""}
            ${state.loading
              ? skeleton(4)
              : !groups.length
                ? html`<p class="stat-hint wl-none" data-role="none">No expenses this month yet.</p>`
                : groups.map(
                    (g) => html`<section class="wl-section hx-group" data-group="${g.key}">
                      <h2 class="wl-cat-head hx-group-head"><span class="wl-group-title">${g.name}</span></h2>
                      <ul class="wl-list" data-role="group-rows">${g.rows.map(row)}</ul>
                    </section>`
                  )}
            ${state.truncated ? html`<p class="stat-hint">Showing the first ${MONTH_LIMIT} expenses of the month.</p>` : ""}`}`
    );
  }

  // ---- Proof (one per expense) ----
  const sendProof = async (expenseId, file) => data.attachExpenseProof(expenseId, await prepareProof(file, { pdf: true }));
  const attachAfter = async (result, file) => {
    if (!file || !result?.expenseId || result.alreadyRecorded) return;
    try {
      await sendProof(result.expenseId, file);
    } catch (err) {
      toast(`Saved, but the receipt didn't upload (${err.message || "error"}). Add it from Edit.`, "danger");
    }
  };
  const showProof = (e) => viewProof({ title: `Receipt · ${money(e.amount)}${e.payee ? ` · ${e.payee}` : ""}`, load: async () => (await data.expenseProof(e.id)).proof });

  const expenseFields = (e = null, prefill = {}) => {
    const day = today();
    return [
      { name: "amount", label: "Amount (₱)", value: e ? (e.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
      householdCategoryField(state.categories, { value: e ? categoryNameOf(state.categories, e.category) || e.categoryName || "" : prefill.category || "" }),
      { name: "date", label: "Date paid", type: "date", value: e?.date ?? day, max: day, required: true },
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
      intro: "Use this for an expense entered by mistake. It stays in the history but no longer counts as spent.",
      fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
      submitLabel: "Remove expense",
      onSubmit: (v) => data.expensesApi({ action: "remove", expenseId: e.id, reason: v.reason }),
    });

  const billEditDialog = (b) =>
    formDialog({
      title: `Edit ${b.description}`,
      fields: billFields(b, state.categories, today()),
      submitLabel: "Save changes",
      onSubmit: async (v) => {
        const next = await parseBill(v, { categories: state.categories, data, canCategory: can.category });
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => JSON.stringify(b[k] ?? null) !== JSON.stringify(val ?? null)));
        return Object.keys(changes).length ? data.scheduleApi({ action: "update", scheduleId: b.id, expectedRevision: b.revision, changes }) : { unchanged: true };
      },
    });

  const done = (message) => (result) => {
    if (!result) return false;
    if (!result.unchanged) toast(message, "success");
    load();
    return true;
  };

  function openView(e) {
    detailsDialog({
      title: `${money(e.amount)} · ${categoryName(names(), e)}`,
      badgeHtml: e.status === "active" ? "" : badge("Removed", "neutral"),
      rows: [
        ["Date paid", formatDayId(e.date)],
        ["Amount", money(e.amount)],
        ["Category", categoryName(names(), e)],
        ["Payee / merchant", e.payee || "—"],
        ["Payment method", methodLabel(e.method)],
        ["Reference", e.reference || "—"],
        ["Notes", e.notes],
        ["Receipt / proof", proofLine(e.proof, timezone)],
      ],
      activity: activityLines(e.history, timezone),
      actions: e.proof ? [{ act: "proof-view", label: "View receipt" }] : [],
      onAction: async (act) => {
        if (act === "proof-view") showProof(e);
        return false;
      },
    });
  }

  // Bills from the list: one tap each; the server keeps it to ONE expense.
  async function billPaid(b) {
    const r = await data.scheduleApi({ action: "markPaid", scheduleId: b.id, payment: { method: "cash", amount: upcomingPart(b), paidDate: today(), final: true, key: partKey() } });
    return done(r?.alreadyPaid ? "Already paid." : r?.nextScheduleId ? `${b.description} paid. The next one is scheduled.` : `${b.description} paid.`)(r);
  }
  async function billUnpaid(e) {
    if (!(await confirm({ title: `Mark ${e.payee || "this bill"} unpaid?`, body: `${money(e.amount)} no longer counts as spent and the bill goes back to Bills remaining.`, confirmLabel: "Mark unpaid" }))) return false;
    return done("Marked unpaid.")(await data.expensesApi({ action: "remove", expenseId: e.id, reason: "Marked unpaid" }));
  }
  async function billRemove(b) {
    if (!(await confirm({ title: `Remove ${b.description}?`, body: `It leaves Bills remaining${b.repeat ? " and won't repeat. Add it again under Bills if it should" : ""}.`, confirmLabel: "Remove bill", danger: true }))) return false;
    return done("Bill removed.")(await data.scheduleApi({ action: "cancel", scheduleId: b.id, reason: "Removed" }));
  }
  async function billRemovePaid(e) {
    if (!(await confirm({ title: `Remove ${e.payee || "this bill"}?`, body: `Its ${money(e.amount)} payment no longer counts as spent and this bill is removed. Later bills already scheduled stay.`, confirmLabel: "Remove", danger: true }))) return false;
    await data.expensesApi({ action: "remove", expenseId: e.id, reason: "Removed" });
    try {
      await data.scheduleApi({ action: "cancel", scheduleId: e.scheduleId, reason: "Removed" });
    } catch {}
    return done("Removed.")({});
  }

  const expenseOf = (id) => state.expenses.find((r) => r.id === id);
  const billOf = (id) => state.bills.find((r) => r.id === id);
  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    el.closest("details.line-menu")?.removeAttribute("open");
    const key = `${el.dataset.act}:${el.dataset.id || ""}`;
    if (state.busy.has(key)) return undefined;
    state.busy.add(key);
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
        case "bill-paid": {
          const b = billOf(el.dataset.id);
          return b ? await billPaid(b) : undefined;
        }
        case "bill-edit": {
          const b = billOf(el.dataset.id);
          return b ? done("Bill updated")(await billEditDialog(b)) : undefined;
        }
        case "bill-remove": {
          const b = billOf(el.dataset.id);
          return b ? await billRemove(b) : undefined;
        }
        case "bill-unpaid": {
          const e = expenseOf(el.dataset.id);
          return e ? await billUnpaid(e) : undefined;
        }
        case "bill-remove-paid": {
          const e = expenseOf(el.dataset.id);
          return e ? await billRemovePaid(e) : undefined;
        }
        case "month-prev":
        case "month-next":
          state.month = shiftMonth(state.month, el.dataset.act === "month-prev" ? -1 : 1);
          state.summary = null;
          state.expenses = [];
          return load();
        default:
          return undefined;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      return undefined;
    } finally {
      state.busy.delete(key);
    }
  };
  container.addEventListener("click", onClick);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
  };
}
