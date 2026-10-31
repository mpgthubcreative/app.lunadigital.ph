// Costs (Luna Business, Owner pilot 2026-10-19): one page, two sections.
//   Operating Expenses   the month's expenses as compact rows
//                        (Rent ₱2,500), ‹ month ›, the month's total,
//                        ⋯ Edit / Remove, + Add item (Expense, Amount, Date;
//                        category, method, reference and notes under More
//                        details). No activity or added / changed lines.
//   COGS                 each product's current unit cost (Hayst Kopi
//                        ₱43), ⋯ Edit, + Add item (a product without a
//                        cost yet). Setting it makes it the cost basis from
//                        now on (POST /api/products setUnitCost); averages,
//                        stock value and costing history stay internal.
// Expenses are the Expenses module (expenses.*); COGS needs the Inventory
// module + inventory.costs to see and products.manage to change.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { DEFAULT_EXPENSE_CATEGORIES, EXPENSE_METHODS, EXPENSE_METHOD_IDS, expenseCategoryLabel, parseCentavos, parseCost, businessDate, canUseModule, costUnitsToCentavos } from "@shared/index.js";
import * as defaultData from "./data.js";
import * as defaultInventoryData from "../inventory/data.js";

const CATEGORY_OPTIONS = DEFAULT_EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));
const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const YES_NO = [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_PAGES = 20;

const pesos = (c) => (c / 100).toFixed(2).replace(/\.00$/, "");
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shiftMonth = (m, n) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthRange = (m) => ({ from: `${m}-01`, to: `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}` });
// The row's name: what the expense was for (stored as the payee), else its category.
export const expenseName = (e) => e.payee || expenseCategoryLabel(e.category);

const EXPENSE_FIELDS = (e, today) => [
  { name: "payee", label: "Expense", value: e?.payee ?? "", required: true, placeholder: "e.g. Rent" },
  { name: "amount", label: "Amount (₱)", value: e ? pesos(e.amount) : "", inputmode: "decimal", required: true },
  { name: "date", label: "Date", type: "date", value: e?.date ?? today, max: today, required: true },
  { name: "category", label: "Category", type: "select", options: CATEGORY_OPTIONS, value: e?.category ?? "misc", more: true, default: true },
  { name: "method", label: "Paid by", type: "select", options: METHOD_OPTIONS, value: e?.method ?? "cash", more: true, default: true },
  { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: e?.reference ?? "", more: true },
  { name: "recurring", label: "Recurring", type: "select", options: YES_NO, value: e?.recurring ? "yes" : "no", more: true, default: true },
  { name: "notes", label: "Notes", type: "textarea", value: e?.notes ?? "", more: true },
];

function parseExpense(v) {
  const payee = String(v.payee || "").trim();
  if (!payee) throw new Error("Enter what the expense is for, e.g. Rent");
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.date) throw new Error("Choose the date");
  return { date: v.date, category: v.category, amount, payee, method: v.method, reference: v.reference.trim() || null, notes: v.notes.trim() || null, recurring: v.recurring === "yes" };
}

export function addExpenseDialog({ api, today }) {
  return formDialog({
    title: "Add operating expense",
    fields: EXPENSE_FIELDS(null, today),
    submitLabel: "Add",
    onSubmit: (v) => {
      const e = parseExpense(v);
      for (const k of ["reference", "notes"]) if (e[k] === null) delete e[k];
      return api("expenses", { method: "POST", body: { action: "create", expense: e } });
    },
  });
}

export function editExpenseDialog({ expense, api, today }) {
  return formDialog({
    title: `Edit ${expenseName(expense)}`,
    fields: EXPENSE_FIELDS(expense, today),
    submitLabel: "Save",
    onSubmit: (v) => {
      const next = parseExpense(v);
      // Only what changed is sent.
      const changes = {};
      for (const [k, val] of Object.entries(next)) if ((expense[k] ?? null) !== (val ?? null) && !(k === "recurring" && Boolean(expense.recurring) === val)) changes[k] = val;
      if (!Object.keys(changes).length) return { unchanged: true };
      return api("expenses", { method: "POST", body: { action: "update", expenseId: expense.id, expectedRevision: expense.revision, changes } });
    },
  });
}

export function removeExpenseDialog({ expense, api }) {
  return formDialog({
    title: `Remove ${expenseName(expense)} · ${formatCentavos(expense.amount).replace(/\.00$/, "")}?`,
    intro: "It stops counting in your costs. Luna keeps it in the record.",
    fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Entered twice" }],
    submitLabel: "Remove",
    onSubmit: (v) => {
      if (!v.reason.trim()) throw new Error("Enter a reason");
      return api("expenses", { method: "POST", body: { action: "remove", expenseId: expense.id, reason: v.reason.trim() } });
    },
  });
}

export function mount(container, session, { data = defaultData, inventoryData = defaultInventoryData, api = defaultApi, toast = defaultToast, now = () => new Date() } = {}) {
  const perms = session.member.permissions;
  const access = { entitlements: session.entitlements, permissions: perms };
  const can = {
    create: perms["expenses.create"] === true,
    update: perms["expenses.update"] === true,
    remove: perms["expenses.delete"] === true,
    cogs: canUseModule(access, "inventory") && perms["inventory.costs"] === true,
    cogsEdit: canUseModule(access, "inventory") && perms["inventory.costs"] === true && perms["products.manage"] === true,
  };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const money = (c) => formatCentavos(c, currency).replace(/\.00$/, "");
  const today = () => businessDate(session.business.timezone, now());
  const state = { month: today().slice(0, 7), expenses: [], more: false, expLoading: true, expError: null, products: [], costs: {}, cogsLoading: can.cogs, cogsError: null };
  let alive = true;

  async function loadExpenses() {
    state.expLoading = true;
    draw();
    try {
      const { from, to } = monthRange(state.month);
      const rows = [];
      let cursor = null;
      let pages = 0;
      for (;;) {
        const page = await data.listExpenses(businessId, { filters: { status: "active", from, to }, cursor, pageSize: 100 });
        rows.push(...page.rows);
        pages += 1;
        if (!page.hasMore || pages >= MAX_PAGES) {
          state.more = Boolean(page.hasMore);
          break;
        }
        cursor = page.rows.at(-1);
      }
      state.expenses = rows;
      state.expError = null;
    } catch (err) {
      console.error("costs: expenses failed:", err && (err.code || err.message));
      state.expError = "Couldn't load operating expenses.";
    }
    state.expLoading = false;
    if (alive) draw();
  }

  async function loadCogs() {
    if (!can.cogs) return;
    state.cogsLoading = true;
    draw();
    try {
      const rows = [];
      let cursor = null;
      for (let i = 0; i < MAX_PAGES; i += 1) {
        const page = await inventoryData.listProducts(businessId, { status: "active", cursor, pageSize: 100 });
        rows.push(...page.rows);
        if (!page.hasMore) break;
        cursor = page.rows.at(-1);
      }
      state.products = rows;
      state.costs = await inventoryData.loadCostDocs(businessId, "productCosts", rows.map((p) => p.id));
      state.cogsError = null;
    } catch (err) {
      console.error("costs: COGS failed:", err && (err.code || err.message));
      state.cogsError = "Couldn't load product costs.";
    }
    state.cogsLoading = false;
    if (alive) draw();
  }

  const unitCostOf = (p) => {
    const c = state.costs[p.id]?.avgCostUnits;
    return Number.isSafeInteger(c) ? costUnitsToCentavos(c) : null;
  };
  const menu = (label, items) =>
    items.length
      ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${label}">⋯</summary><div class="line-menu-list" role="menu">
          ${items.map((i) => (i.sep ? html`<div class="menu-sep" role="separator"></div>` : html`<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="${i.act}" data-id="${i.id}">${i.label}</button>`))}
        </div></details>`
      : html`<span class="wl-menu-gap" aria-hidden="true"></span>`;

  function expensesSection() {
    const total = state.expenses.reduce((t, e) => t + e.amount, 0);
    const atEnd = state.month >= today().slice(0, 7);
    const rows = [...state.expenses].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : expenseName(a).localeCompare(expenseName(b))));
    return html`<section class="wl-section cost-section" data-section="operating">
      <div class="cost-head">
        <h2 class="cost-title">Operating Expenses</h2>
        <strong class="cost-total" data-role="opex-total">${state.expLoading ? "…" : money(total)}</strong>
      </div>
      <div class="hx-month cost-month" data-role="month-nav">
        <button type="button" class="btn btn-compact btn-ghost" data-act="month-prev" aria-label="Previous month">‹</button>
        <span data-role="month">${monthLabel(state.month)}</span>
        <button type="button" class="btn btn-compact btn-ghost" data-act="month-next" aria-label="Next month" ${atEnd ? "disabled" : ""}>›</button>
      </div>
      ${state.expError
        ? emptyState({ title: "Couldn't load", body: state.expError })
        : state.expLoading
          ? skeleton(3)
          : rows.length
            ? html`<ul class="wl-list" data-role="expenses">${rows.map(
                (e) => html`<li class="wl-row hx-row" data-expense="${e.id}">
                  <span class="wl-main hx-main"><span class="wl-name">${expenseName(e)}</span><span class="wl-sub hx-sub">${formatDayId(e.date).replace(/, \d{4}$/, "")}</span></span>
                  <span class="wl-amt hx-amt">${money(e.amount)}</span>
                  ${menu(`${expenseName(e)} ${money(e.amount)}`, [...(can.update ? [{ act: "exp-edit", id: e.id, label: "Edit" }] : []), ...(can.remove ? [{ act: "exp-remove", id: e.id, label: "Remove", danger: true }] : [])])}
                </li>`
              )}</ul>${state.more ? html`<p class="stat-hint">Showing the first ${rows.length} expenses of ${monthLabel(state.month)}.</p>` : ""}`
            : html`<p class="wl-none stat-hint" data-role="opex-empty">No operating expenses in ${monthLabel(state.month)}.</p>`}
      ${can.create ? html`<button type="button" class="btn cost-add" data-act="exp-add">+ Add item</button>` : ""}
    </section>`;
  }

  function cogsSection() {
    if (!can.cogs) return "";
    const priced = state.products.filter((p) => unitCostOf(p) !== null).sort((a, b) => a.name.localeCompare(b.name));
    const unpriced = state.products.filter((p) => unitCostOf(p) === null);
    return html`<section class="wl-section cost-section" data-section="cogs">
      <div class="cost-head"><h2 class="cost-title">COGS</h2><span class="stat-hint">Cost per unit</span></div>
      ${state.cogsError
        ? emptyState({ title: "Couldn't load", body: state.cogsError })
        : state.cogsLoading
          ? skeleton(3)
          : priced.length
            ? html`<ul class="wl-list" data-role="cogs">${priced.map(
                (p) => html`<li class="wl-row hx-row" data-product="${p.id}">
                  <span class="wl-main hx-main"><span class="wl-name">${p.name}</span></span>
                  <span class="wl-amt hx-amt" data-role="unit-cost">${money(unitCostOf(p))}</span>
                  ${menu(`${p.name} unit cost`, can.cogsEdit ? [{ act: "cogs-edit", id: p.id, label: "Edit" }] : [])}
                </li>`
              )}</ul>`
            : html`<p class="wl-none stat-hint" data-role="cogs-empty">${state.products.length ? "No product costs yet." : "Add products in Inventory first."}</p>`}
      ${can.cogsEdit && !state.cogsLoading && unpriced.length ? html`<button type="button" class="btn cost-add" data-act="cogs-add">+ Add item</button>` : ""}
    </section>`;
  }

  function draw() {
    if (!alive) return;
    render(container, html`${pageHeader({ title: "Costs" })}<div class="costs" data-role="costs">${expensesSection()}${cogsSection()}</div>`);
  }

  const setCost = (product, title) =>
    formDialog({
      title,
      fields: [
        ...(product ? [] : [{ name: "productId", label: "Product", type: "select", options: state.products.filter((p) => unitCostOf(p) === null).sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name })) }]),
        { name: "unitCost", label: "Cost per unit (₱)", value: product && unitCostOf(product) !== null ? pesos(unitCostOf(product)) : "", inputmode: "decimal", required: true, hint: "What one unit costs you. Luna uses this to calculate COGS and profit (the same cost as in Inventory)." },
      ],
      submitLabel: "Save",
      onSubmit: (v) => {
        const unitCost = parseCost(v.unitCost);
        return api("products", { method: "POST", body: { action: "setUnitCost", productId: product ? product.id : v.productId, unitCost } });
      },
    });

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    el.closest("details.line-menu")?.removeAttribute("open");
    const act = el.dataset.act;
    const expense = state.expenses.find((e) => e.id === el.dataset.id);
    const product = state.products.find((p) => p.id === el.dataset.id);
    let r = null;
    if (act === "month-prev" || act === "month-next") {
      state.month = shiftMonth(state.month, act === "month-prev" ? -1 : 1);
      return loadExpenses();
    }
    if (act === "exp-add") r = await addExpenseDialog({ api, today: today() });
    else if (act === "exp-edit" && expense) r = await editExpenseDialog({ expense, api, today: today() });
    else if (act === "exp-remove" && expense) r = await removeExpenseDialog({ expense, api });
    else if (act === "cogs-add") r = await setCost(null, "Add product cost");
    else if (act === "cogs-edit" && product) r = await setCost(product, `${product.name} unit cost`);
    if (!r || r.unchanged) return undefined;
    toast(act === "exp-add" ? "Expense added." : act === "exp-edit" ? "Expense updated." : act === "exp-remove" ? "Expense removed." : "Cost per unit saved.", "success");
    return act.startsWith("exp") ? loadExpenses() : loadCogs();
  };
  container.addEventListener("click", onClick);
  draw();
  loadExpenses();
  loadCogs();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
  };
}
