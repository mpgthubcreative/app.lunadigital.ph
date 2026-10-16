// Money (Owner-pilot Bridal UX; the Wedding Suppliers module): what we
// budgeted, paid and still owe, on one page. Second pass: less on screen.
//   Summary   Budget · Spent · To pay · Left, one small line of figures
//             (Spent = every active Wedding Expense, supplier payments
//             included, so nothing is counted twice; To pay = what
//             suppliers are still owed on their agreements, plus anything
//             scheduled to a supplier without one; Left = budget − spent −
//             to pay)
//   + Add     one button: Add supplier / Add expense / Set or edit budget
//   Suppliers one compact row each: name, "Partly paid · ₱15,000 due", Pay
//             (when something is owed) and ⋯ (Record payment, Paid in full,
//             View payments, Schedule a payment, Edit supplier, Details).
//             RSVP-style dropdown filter (All / Unpaid / Partly paid / Paid)
//             and a search once the list is long.
//   Other     expenses not paid to a saved supplier, folded ("Other
//             expenses (n)").
// No budget category is needed first: forms take a category name and Luna
// creates it if new (./categories.js). Pay records the supplier's next
// scheduled payment, or one Wedding Expense for the supplier (the same
// records as before; nothing is typed twice). Downloads live under More.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { expenseActions } from "./expenses.js";
import { SUPPLIER_SERVICES, SUPPLIER_STATUSES, EXPENSE_METHODS, EXPENSE_METHOD_IDS, supplierBalance, businessDate, parseCentavos, weddingSummary } from "@shared/index.js";
import { parseBudget } from "../baby/budget.js";
import { activityLines, detailsDialog, categoryName } from "../baby/common.js";
import { paymentActions } from "./payments.js";
import { categoryField, resolveCategory, categoryNameOf, guessService } from "./categories.js";
import * as defaultData from "./data.js";

const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
// Derived from what's recorded (paid = the supplier's Wedding Expenses).
export function paidState(s) {
  const paid = s.paid ?? 0;
  if (!(paid > 0)) return "unpaid";
  if (Number.isSafeInteger(s.agreedAmount) && paid < s.agreedAmount) return "partly";
  return "paid";
}
const PAID_STATES = { unpaid: "Unpaid", partly: "Partly paid", paid: "Paid" };
const PAID_TONE = { unpaid: "neutral", partly: "warning", paid: "success" };
const OTHER_SHOWN = 8;

// The Money figures (all in centavos; remaining null without a budget).
export function moneySummary(budget, suppliers) {
  const s = weddingSummary(budget);
  const stillToPay = suppliers.reduce((sum, x) => {
    const bal = supplierBalance(x);
    return sum + (bal === null ? Math.max(0, x.upcoming ?? 0) : Math.max(0, bal));
  }, 0);
  return { budget: s.total, spent: s.spent, stillToPay, remaining: s.total === null ? null : s.total - s.spent - stillToPay };
}
// ₱500k / ₱152.5k / ₱1.2M / ₱850: short figures for the summary line.
export function shortPeso(c) {
  const p = Math.abs(c) / 100;
  const sign = c < 0 ? "−" : "";
  const one = (n) => String(Math.round(n * 10) / 10);
  if (p >= 1e6) return `${sign}₱${one(p / 1e6)}M`;
  if (p >= 1e3) return `${sign}₱${one(p / 1e3)}k`;
  return `${sign}₱${one(p)}`;
}
const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

const SERVICE_OPTIONS = Object.entries(SUPPLIER_SERVICES).map(([value, s]) => ({ value, label: s.label }));
const serviceLabel = (s) => SUPPLIER_SERVICES[s]?.label ?? s;
const pesosText = (c) => (Number.isSafeInteger(c) ? String(c / 100) : "");

// Supplier name, Category, Total amount; the rest under More options.
const supplierFields = (s = {}, categories = []) => [
  { name: "name", label: "Supplier name", value: s.name ?? "", required: true, placeholder: "e.g. Nice Print Photography" },
  categoryField(categories, { value: categoryNameOf(categories, s.categoryId) }),
  { name: "agreedAmount", label: "Total / contract amount (₱)", value: pesosText(s.agreedAmount), inputmode: "decimal", hint: "Optional. Luna works out what's still due." },
  { name: "service", label: "Service", type: "select", options: [{ value: "", label: "— Match the category —" }, ...SERVICE_OPTIONS], value: s.service ?? "", more: true, default: true },
  { name: "contactPerson", label: "Contact person", value: s.contactPerson ?? "", more: true },
  { name: "phone", label: "Phone", value: s.phone ?? "", inputmode: "tel", more: true },
  { name: "email", label: "Email", value: s.email ?? "", more: true },
  { name: "location", label: "Address / location", value: s.location ?? "", more: true },
  { name: "notes", label: "Notes", type: "textarea", value: s.notes ?? "", more: true },
];

export function toSupplierInput(v) {
  const out = { name: v.name.trim(), service: v.service, agreedAmount: parseBudget(v.agreedAmount, "agreed amount"), categoryId: v.categoryId || null };
  for (const k of ["contactPerson", "phone", "email", "location", "notes"]) out[k] = (v[k] || "").trim() || null;
  return out;
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), confirm = confirmDialog, location: loc = globalThis.location } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["vendors.manage"] === true;
  const canSchedule = perms["vendorpayments.manage"] === true;
  const canPay = perms["expenses.create"] === true;
  const seesPayments = perms["vendorpayments.view"] === true;
  const seesBudget = perms["budget.view"] === true;
  const seesExpenses = perms["expenses.view"] === true;
  const canCategory = perms["budget.manage"] === true;
  const can = { create: canPay, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true, category: canCategory };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filter: "all", search: "", rows: [], inactive: [], other: [], otherMore: false, budget: null, categories: [], upcoming: [], loading: true, error: null };
  let alive = true;
  let focus = new URLSearchParams(loc?.search || "").get("supplier");
  const money = (c) => (c === null || c === undefined ? "—" : formatCentavos(c, currency));
  const whole = (c) => money(c).replace(/\.00$/, "");

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      const [cats, budget, page, inactive, upcoming, expenses] = await Promise.all([
        seesBudget ? data.listCategories(businessId).catch(() => state.categories) : state.categories,
        seesBudget && data.getBudget ? data.getBudget(businessId).catch(() => null) : null,
        data.listSuppliers(businessId, { status: "active" }, { pageSize: 200 }),
        data.listSuppliers(businessId, { status: "inactive" }, { pageSize: 200 }).catch(() => ({ rows: [] })),
        seesPayments ? data.listSupplierPayments(businessId, { status: "upcoming" }, { pageSize: 200 }).then((r) => r.rows).catch(() => []) : [],
        seesExpenses && data.listWeddingExpenses ? data.listWeddingExpenses(businessId, { status: "active" }, { pageSize: 100 }).catch(() => ({ rows: [] })) : { rows: [] },
      ]);
      state.categories = cats;
      state.budget = budget;
      state.upcoming = upcoming;
      state.rows = page.rows;
      state.inactive = inactive.rows;
      const other = expenses.rows.filter((e) => !e.supplierId);
      state.other = other;
      state.otherMore = Boolean(expenses.hasMore);
      state.error = null;
    } catch (err) {
      console.error("money: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load Money.";
    }
    state.loading = false;
    draw();
    if (focus) {
      const s = [...state.rows, ...state.inactive].find((r) => r.id === focus);
      focus = null;
      if (s) openView(s);
    }
  }

  const upcomingOf = (s) => state.upcoming.filter((p) => p.supplierId === s.id).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");
  const shown = () => {
    const q = state.search.toLowerCase();
    return state.rows.filter((s) => (state.filter === "all" || paidState(s) === state.filter) && (!q || s.name.toLowerCase().includes(q)));
  };

  function menuItems(s) {
    const items = [];
    const bal = supplierBalance(s);
    const active = s.status === "active";
    if (active && canPay) {
      items.push({ x: "record", label: "Record payment" });
      if (bal > 0 && !upcomingOf(s).length) items.push({ x: "full", label: "Paid in full" });
    }
    if (seesExpenses || seesPayments) items.push({ x: "payments", label: "View payments" });
    if (active && canSchedule) items.push({ x: "schedule", label: "Schedule a payment" });
    if (canManage) items.push({ x: "edit", label: "Edit supplier" });
    items.push({ x: "view", label: "Details" });
    return items;
  }

  function row(s) {
    const st = paidState(s);
    const bal = supplierBalance(s);
    const list = upcomingOf(s);
    const late = list.some((p) => p.dueDate < today());
    const due = bal > 0 ? `${whole(bal)} due` : "";
    const sub = [late ? "Overdue" : PAID_STATES[st], due].filter(Boolean).join(" · ");
    const payable = s.status === "active" && canPay && (list.length > 0 || bal > 0);
    return html`<li class="wl-row wl-supplier" data-supplier="${s.id}" data-state="${st}">
      <button type="button" class="wl-main" data-act="view" data-id="${s.id}"><span class="wl-name">${s.name}</span><span class="wl-sub m-only-inline${late ? " is-over" : ""}" data-role="sub">${sub}</span></button>
      <span class="wl-col wl-num d-only">${s.agreedAmount === null || s.agreedAmount === undefined ? "—" : money(s.agreedAmount)}</span>
      <span class="wl-col d-only">${badge(PAID_STATES[st], PAID_TONE[st])}${late ? html` ${badge("Overdue", "danger")}` : ""}</span>
      <span class="wl-col wl-num d-only" data-role="due">${due}</span>
      <span class="wl-end">${payable ? html`<button type="button" class="btn btn-compact btn-primary" data-act="pay" data-id="${s.id}">Pay</button>` : ""}
        <details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${s.name}">⋯</summary><div class="line-menu-list" role="menu">${menuItems(s).map((i) => html`<button type="button" class="menu-item" role="menuitem" data-act="menu" data-x="${i.x}" data-id="${s.id}">${i.label}</button>`)}</div></details>
      </span>
    </li>`;
  }

  const addItems = () => [
    ...(canManage ? [{ x: "supplier", label: "Add supplier" }] : []),
    ...(canPay ? [{ x: "expense", label: "Add expense" }] : []),
    ...(seesBudget ? [{ x: "budget", label: "Set / edit budget", href: "/budget" }] : []),
  ];

  function summary() {
    if (!seesBudget) return "";
    if (state.loading) return html`<div class="wl-figs" data-role="money-summary-loading">${skeleton(1)}</div>`;
    const sum = moneySummary(state.budget, [...state.rows, ...state.inactive]);
    const fig = (k, label, value, title, cls = "") => html`<div class="wl-fig ${cls}" data-k="${k}" title="${title}"><span>${label}</span><b>${value}</b></div>`;
    return html`<div class="wl-figs" data-role="money-summary">
      ${sum.budget === null ? html`<a class="wl-fig" data-k="budget" href="/budget" data-link><span>Budget</span><b>Set</b></a>` : fig("budget", "Budget", shortPeso(sum.budget), money(sum.budget))}
      ${fig("spent", "Spent", shortPeso(sum.spent), money(sum.spent))}
      ${fig("still", "To pay", shortPeso(sum.stillToPay), money(sum.stillToPay), sum.stillToPay ? "is-warn" : "")}
      ${fig("remaining", "Left", sum.remaining === null ? "—" : shortPeso(sum.remaining), sum.remaining === null ? "Set a budget to see what's left" : money(sum.remaining), sum.remaining !== null && sum.remaining < 0 ? "is-over" : "")}
    </div>`;
  }

  function draw() {
    if (!alive) return;
    const list = shown();
    const names = new Map(state.categories.map((c) => [c.id, c.name]));
    const add = addItems();
    render(
      container,
      html`
        ${pageHeader({
          title: "Money",
          actions: add.length ? html`<details class="line-menu wl-add" data-role="add"><summary class="btn btn-primary" aria-label="Add">+ Add</summary><div class="line-menu-list" role="menu">${add.map((i) => (i.href ? html`<a class="menu-item" role="menuitem" href="${i.href}" data-link data-x="${i.x}">${i.label}</a>` : html`<button type="button" class="menu-item" role="menuitem" data-act="add" data-x="${i.x}">${i.label}</button>`))}</div></details>` : "",
        })}
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            ${summary()}
            <section class="wl-section" data-section="suppliers">
              ${state.rows.length
                ? html`<div class="wl-tools">
                    <label class="wl-pick"><span class="visually-hidden">Show suppliers</span><select class="select select-compact" data-role="filter" aria-label="Show suppliers">${[["all", "All"], ["unpaid", "Unpaid"], ["partly", "Partly paid"], ["paid", "Paid"]].map(([v, l]) => html`<option value="${v}" ${v === state.filter ? "selected" : ""}>${l}</option>`)}</select></label>
                    ${state.rows.length > 6 || state.search ? html`<input class="input wl-search" type="search" data-role="search" placeholder="Search supplier" aria-label="Search supplier" value="${state.search}">` : ""}
                  </div>`
                : ""}
              ${state.loading
                ? skeleton(4)
                : !state.rows.length
                  ? emptyState({ iconName: "provider", title: "No suppliers yet", body: "Tap + Add to add your venue, caterer or photographer." })
                  : !list.length
                    ? html`<p class="stat-hint wl-none">No ${state.filter === "all" ? "" : PAID_STATES[state.filter].toLowerCase() + " "}suppliers${state.search ? ` matching "${state.search}"` : ""}.</p>`
                    : html`<ul class="wl-list" data-role="suppliers">${list.map(row)}</ul>`}
              ${state.inactive.length ? html`<details class="wl-fold"><summary>Inactive suppliers (${state.inactive.length})</summary><ul class="wl-list" data-role="suppliers-inactive">${state.inactive.map(row)}</ul></details>` : ""}
            </section>
            ${seesExpenses && !state.loading && state.other.length
              ? html`<details class="wl-fold" data-role="other">
                  <summary>Other expenses (${state.other.length}${state.otherMore ? "+" : ""})</summary>
                  <ul class="wl-list" data-role="other-expenses">${state.other.slice(0, OTHER_SHOWN).map(
                    (e) => html`<li class="wl-row" data-expense="${e.id}"><button type="button" class="wl-main" data-act="expense" data-id="${e.id}"><span class="wl-name">${e.payee || categoryName(names, e)}</span><span class="wl-sub">${categoryName(names, e)} · ${short(e.date)}</span></button><span class="wl-amt">${money(e.amount)}</span></li>`
                  )}</ul>
                  <p class="wl-links"><a href="/expenses" data-link>All expenses ›</a></p>
                </details>`
              : ""}`}`
    );
  }

  // The category id for a typed name (created on the spot when new).
  const categoryFor = (text) => resolveCategory(text, { categories: state.categories, data, canCreate: canCategory });
  const withCategory = async (v) => {
    const categoryId = await categoryFor(v.category);
    return { ...v, categoryId, service: v.service || guessService(categoryNameOf(state.categories, categoryId)) };
  };

  const addSupplierDialog = () =>
    formDialog({
      title: "Add supplier",
      fields: supplierFields({}, state.categories),
      moreLabel: "More options",
      submitLabel: "Add supplier",
      onSubmit: async (v) => data.suppliersApi({ action: "create", supplier: toSupplierInput(await withCategory(v)) }),
    });
  const editDialog = (s) =>
    formDialog({
      title: `Edit ${s.name}`,
      fields: supplierFields(s, state.categories),
      moreLabel: "More options",
      onSubmit: async (v) => {
        const next = toSupplierInput(await withCategory({ ...v, service: v.service || s.service }));
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (s[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? data.suppliersApi({ action: "update", supplierId: s.id, expectedRevision: s.revision, changes }) : { unchanged: true };
      },
    });

  function openView(s) {
    detailsDialog({
      title: s.name,
      badgeHtml: badge(SUPPLIER_STATUSES[s.status]?.label ?? s.status, s.status === "active" ? "success" : "neutral"),
      rows: [
        ["Category", categoryNameOf(state.categories, s.categoryId) || null],
        ["Service", serviceLabel(s.service)],
        ["Total / contract", s.agreedAmount === null || s.agreedAmount === undefined ? "Not set" : money(s.agreedAmount)],
        ["Paid", money(s.paid ?? 0)],
        ["Still due", money(supplierBalance(s))],
        ["Scheduled", s.upcomingCount ? `${money(s.upcoming ?? 0)} (${s.upcomingCount} payment${s.upcomingCount === 1 ? "" : "s"})` : null],
        ["Next due", s.nextDue ? formatDayId(s.nextDue) : null],
        ["Contact person", s.contactPerson],
        ["Phone", s.phone],
        ["Email", s.email],
        ["Address / location", s.location],
        ["Notes", s.notes],
      ],
      activity: activityLines(s.history, timezone),
      // Delete only shows for a supplier nothing was recorded against (the server re-checks).
      actions: canManage ? [...(!(s.paid > 0) && !(s.upcomingCount > 0) ? [{ act: "delete", label: "Delete", danger: true }] : []), { act: "status", label: s.status === "active" ? "Deactivate" : "Reactivate" }, { act: "edit", label: "Edit" }] : [],
      onAction: async (act) => {
        try {
          if (act === "edit") {
            const r = await editDialog(s);
            if (r && !r.unchanged) toast("Saved.", "success");
            if (r) load();
            return Boolean(r);
          }
          if (act === "delete") {
            if (!(await confirm({ title: `Delete ${s.name}?`, body: "Only for a supplier added by mistake. Suppliers with payments or expenses can't be deleted; deactivate them instead so their history and balance stay.", confirmLabel: "Delete", danger: true }))) return false;
            await data.suppliersApi({ action: "delete", supplierId: s.id });
            toast(`${s.name} deleted.`, "success");
            load();
            return true;
          }
          if (act === "status") {
            await data.suppliersApi({ action: "setStatus", supplierId: s.id, status: s.status === "active" ? "inactive" : "active" });
            toast(s.status === "active" ? "Supplier deactivated. Its history and balance are kept." : "Supplier reactivated.", "success");
            load();
            return true;
          }
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  // ⋯ View payments: what was paid (the supplier's expenses) and what's
  // scheduled (open one to mark it paid, edit or cancel it).
  async function viewPayments(s) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const paint = (body) =>
      render(backdrop, html`<div class="modal" role="dialog" aria-modal="true" aria-label="Payments to ${s.name}" data-role="supplier-payments"><div class="modal-header"><h2 class="card-title">${s.name} · Payments</h2></div><div class="modal-body">${body}</div><div class="modal-footer">${seesPayments ? html`<a class="btn btn-ghost" href="/supplier-payments" data-link data-x="close">Payment history</a>` : ""}<button type="button" class="btn" data-x="close">Close</button></div></div>`);
    paint(html`<p class="stat-hint">Loading…</p>`);
    backdrop.addEventListener("click", (ev) => {
      const x = ev.target.closest("[data-x]");
      if (ev.target === backdrop || x?.dataset.x === "close") return close();
      if (x?.dataset.x === "scheduled") {
        const p = state.upcoming.find((y) => y.id === x.dataset.id);
        close();
        if (p) pay.openView(p);
      }
      return undefined;
    });
    try {
      const paid = seesExpenses ? (await data.listWeddingExpenses(businessId, { status: "active", supplierId: s.id }, { pageSize: 100 })).rows : [];
      const list = upcomingOf(s);
      paint(html`
        <ul class="slip" data-role="paid-list">${paid.length ? paid.map((e) => html`<li><span class="slip-what">${whole(e.amount)} paid ${short(e.date)}${e.reference ? html`<small>${e.reference}</small>` : ""}</span><span class="slip-amt"></span><span class="slip-act"></span></li>`) : html`<li><span class="slip-what stat-hint">Nothing paid yet.</span></li>`}</ul>
        ${list.length
          ? html`<h3 class="slip-head">Scheduled</h3><ul class="wl-list" data-role="scheduled-list">${list.map(
              (p) => html`<li class="wl-row"><button type="button" class="wl-main" data-x="scheduled" data-id="${p.id}"><span class="wl-name">${whole(p.amount)} ${p.dueDate < today() ? "was due" : "due"} ${short(p.dueDate)}</span><span class="wl-sub">${p.description}</span></button></li>`
            )}</ul>`
          : ""}
        <p class="stat-hint">Paid ${whole(s.paid ?? 0)}${supplierBalance(s) !== null ? ` · ${whole(supplierBalance(s))} still due` : ""}</p>`);
    } catch (err) {
      paint(html`<p class="form-error">${err.message || "Couldn't load"}</p>`);
    }
  }

  const pay = paymentActions({ data, currency, timezone, today, canManage: canSchedule, canPay: canSchedule && canPay, toast, getCtx: () => ({ categories: state.categories, suppliers: state.rows }), reload: () => load() });

  // One Wedding Expense paid to this supplier. Full = the balance not
  // already scheduled (scheduled payments are paid from View payments).
  function recordPayment(s, full) {
    const balance = supplierBalance(s);
    const scheduled = upcomingOf(s).reduce((sum, p) => sum + p.amount, 0);
    const open = balance === null ? null : Math.max(0, balance - scheduled);
    // One key per dialog: a double click or a retry records ONE expense.
    const idempotencyKey = newKey();
    return formDialog({
      title: full ? `${s.name}: paid in full` : `${s.name}: record a payment`,
      fields: [
        { name: "amount", label: "Amount paid (₱)", value: full && open ? (open / 100).toFixed(2) : "", inputmode: "decimal", required: true, hint: balance === null ? "" : `Still due: ${money(balance)}` },
        { name: "date", label: "Date paid", type: "date", value: today(), max: today(), required: true },
        { ...categoryField(state.categories, { value: categoryNameOf(state.categories, s.categoryId) }), more: true },
        { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: "bank_transfer", more: true, default: true },
        { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: "", more: true },
      ],
      moreLabel: "More options",
      submitLabel: "Record payment",
      onSubmit: async (v) => {
        const amount = parseCentavos(v.amount);
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        const category = await categoryFor(v.category);
        return data.expensesApi({ action: "create", idempotencyKey, expense: { date: v.date, category, amount, supplierId: s.id, method: v.method, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) } });
      },
    });
  }

  const exp = expenseActions({ data, currency, timezone, can, toast, getCtx: () => ({ today: today(), categories: state.categories, suppliers: state.rows }), reload: () => load() });

  const recorded = (r) => {
    if (r) {
      toast(r.alreadyRecorded ? "Already recorded: no second payment was added." : "Payment recorded.", "success");
      load();
    }
    return r;
  };
  async function payNow(s) {
    const next = upcomingOf(s)[0];
    if (next) return pay.after("Marked paid. The expense was recorded.")(await pay.payDialog(next));
    return recorded(await recordPayment(s, false));
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const a = el.dataset.act;
    const s = [...state.rows, ...state.inactive].find((r) => r.id === el.dataset.id);
    el.closest("details.line-menu")?.removeAttribute("open");
    try {
      if (a === "add") {
        const x = el.dataset.x;
        if (x === "supplier") {
          const r = await addSupplierDialog();
          if (r) {
            toast("Supplier added.", "success");
            load();
          }
        } else if (x === "expense") exp.done("Expense added")(await exp.addDialog());
      } else if (a === "expense") {
        const e = state.other.find((y) => y.id === el.dataset.id);
        if (e) exp.openView(e);
      } else if (a === "view" && s) openView(s);
      else if (a === "pay" && s) await payNow(s);
      else if (a === "menu" && s) {
        const x = el.dataset.x;
        if (x === "view") openView(s);
        else if (x === "payments") await viewPayments(s);
        else if (x === "edit") {
          const r = await editDialog(s);
          if (r && !r.unchanged) toast("Saved.", "success");
          if (r) load();
        } else if (x === "record" || x === "full") recorded(await recordPayment(s, x === "full"));
        else if (x === "schedule") await pay.after("Payment scheduled.")(await pay.newDialog(s));
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  const onChange = (event) => {
    if (event.target.dataset?.role !== "filter") return;
    state.filter = event.target.value;
    draw();
  };
  const onInput = (event) => {
    if (event.target.dataset?.role !== "search") return;
    state.search = event.target.value.trim();
    const pos = event.target.selectionStart;
    draw();
    const box = container.querySelector('[data-role="search"]');
    if (box) {
      box.focus();
      box.setSelectionRange(pos, pos);
    }
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("input", onInput);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("input", onInput);
  };
}
