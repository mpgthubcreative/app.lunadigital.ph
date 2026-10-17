// Money (Owner-pilot Bridal UX; the Wedding Suppliers module): ONE list of
// everything the wedding costs, so the bride never has to think about
// which kind of record something is.
//   Row       Category | Supplier / Payee | Total | Status | Remaining | ⋯
//             supplier  a saved supplier: total = its contract (or what was
//                       paid without one), Paid / Partial / Unpaid
//             planned   a budget line (category with a budget) that has no
//                       supplier yet: "No supplier yet", Planned. Adding a
//                       supplier in that category replaces it (no duplicate)
//             expense   an expense paid to no saved supplier: Paid, ₱0 left
//   Summary   Budget · Spent · To pay · Left, one small line (Spent = every
//             active Wedding Expense, supplier payments included, so nothing
//             is counted twice; To pay = what suppliers are still owed;
//             Left = budget − spent − to pay)
//   + Add     one button: Expense / Supplier / Budget item
//   ⋯         supplier: Record payment, View payments, Edit, Change
//             category, Payment schedule, Archive (Delete when nothing was
//             recorded); expense: Details, View / Add / Replace proof,
//             Change category, Remove; planned: Add supplier, Add expense,
//             Change amount, Remove from budget
//   Proof     a receipt photo or PDF on an expense (a supplier payment is
//             an expense): under ⋯, in Details and in View payments; never
//             a column. Record payment / Add expense take one too (More options).
// No budget category is needed first: forms take a category NAME and Luna
// creates it if new (./categories.js). Downloads live under More.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { expenseActions, proofField } from "./expenses.js";
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
// Words in the Money list.
const STATUS = { unpaid: "Unpaid", partly: "Partial", paid: "Paid", planned: "Planned" };
const STATUS_TONE = { unpaid: "", partly: "warning", paid: "success", planned: "info" };
const FILTERS = [["all", "All"], ["unpaid", "Unpaid"], ["partly", "Partial"], ["paid", "Paid"], ["planned", "Planned"]];

// The unified Money rows (see the header), in budget-category order.
export function moneyRows({ suppliers = [], categories = [], budget = null, expenses = [], upcoming = [] }) {
  const order = new Map(categories.map((c, i) => [c.id, i]));
  const name = (id) => categories.find((c) => c.id === id)?.name ?? "";
  const spentBy = budget?.spentByCategory && typeof budget.spentByCategory === "object" ? budget.spentByCategory : {};
  const rows = [];
  for (const s of suppliers) {
    const bal = supplierBalance(s);
    const scheduled = upcoming.filter((p) => p.supplierId === s.id).reduce((n, p) => n + p.amount, 0);
    rows.push({ kind: "supplier", id: s.id, categoryId: s.categoryId ?? null, category: name(s.categoryId), name: s.name, total: Number.isSafeInteger(s.agreedAmount) ? s.agreedAmount : (s.paid ?? 0) + scheduled, status: paidState(s), remaining: bal === null ? scheduled : Math.max(0, bal), record: s });
  }
  const withSupplier = new Set(suppliers.filter((s) => s.status === "active").map((s) => s.categoryId));
  for (const c of categories) {
    if (c.status !== "active" || !(c.budget > 0) || withSupplier.has(c.id)) continue;
    rows.push({ kind: "planned", id: c.id, categoryId: c.id, category: c.name, name: null, total: c.budget, status: "planned", remaining: Math.max(0, c.budget - (spentBy[c.id] ?? 0)), record: c });
  }
  for (const e of expenses) {
    if (e.supplierId) continue;
    rows.push({ kind: "expense", id: e.id, categoryId: e.category, category: name(e.category) || e.categoryName || "", name: e.payee || null, total: e.amount, status: "paid", remaining: 0, record: e });
  }
  const rank = { supplier: 0, planned: 1, expense: 2 };
  return rows.sort((a, b) => (order.get(a.categoryId) ?? 999) - (order.get(b.categoryId) ?? 999) || rank[a.kind] - rank[b.kind] || (a.name || "").localeCompare(b.name || ""));
}

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

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), confirm = confirmDialog, location: loc = globalThis.location, prepareProof } = {}) {
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
        seesExpenses && data.listWeddingExpenses ? data.listWeddingExpenses(businessId, { status: "active" }, { pageSize: 300 }).catch(() => ({ rows: [] })) : { rows: [] },
      ]);
      state.categories = cats;
      state.budget = budget;
      state.upcoming = upcoming;
      state.rows = page.rows;
      state.inactive = inactive.rows;
      state.other = expenses.rows.filter((e) => !e.supplierId);
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
  const allRows = () => moneyRows({ suppliers: state.rows, categories: state.categories, budget: state.budget, expenses: state.other, upcoming: state.upcoming });
  const shown = () => {
    const q = state.search.toLowerCase();
    return allRows().filter((r) => (state.filter === "all" || r.status === state.filter) && (!q || `${r.name || ""} ${r.category}`.toLowerCase().includes(q)));
  };
  const findRow = (kind, id) => allRows().find((r) => r.kind === kind && r.id === id) || (kind === "supplier" ? moneyRows({ suppliers: state.inactive, categories: state.categories }).find((r) => r.id === id) : null);

  function menuItems(r) {
    const items = [];
    if (r.kind === "supplier") {
      const s = r.record;
      const active = s.status === "active";
      if (active && canPay) items.push({ x: "record", label: "Record payment" });
      if (seesExpenses || seesPayments) items.push({ x: "payments", label: "View payments" });
      if (canManage) items.push({ x: "edit", label: "Edit" }, { x: "category", label: "Change category" });
      if (active && canSchedule) items.push({ x: "schedule", label: "Payment schedule" });
      items.push({ x: "view", label: "Details" });
      if (canManage) items.push(!(s.paid > 0) && !(s.upcomingCount > 0) ? { x: "delete", label: "Delete", danger: true } : { x: "archive", label: active ? "Archive" : "Bring back", danger: active });
    } else if (r.kind === "expense") {
      items.push({ x: "view", label: "Details" });
      items.push(...exp.proofItems(r.record));
      if (can.update) items.push({ x: "category", label: "Change category" });
      if (can.remove) items.push({ x: "remove", label: "Remove", danger: true });
    } else {
      if (canManage) items.push({ x: "supplier", label: "Add supplier" });
      if (canPay) items.push({ x: "expense", label: "Add expense" });
      if (canCategory) items.push({ x: "amount", label: "Change amount" }, { x: "unplan", label: "Remove from budget", danger: true });
    }
    return items;
  }

  function row(r) {
    const late = r.kind === "supplier" && upcomingOf(r.record).some((p) => p.dueDate < today());
    const who = r.name || (r.kind === "planned" ? "No supplier yet" : "—");
    const left = `${shortPeso(r.remaining)} left`;
    const menu = menuItems(r);
    return html`<li class="wl-row wl-money" data-kind="${r.kind}" data-${r.kind === "supplier" ? "supplier" : r.kind === "planned" ? "planned" : "expense"}="${r.id}" data-state="${r.status}">
      <button type="button" class="wl-main" data-act="open" data-kind="${r.kind}" data-id="${r.id}">
        <span class="wl-cat-col d-only">${r.category || "—"}</span>
        ${r.kind === "supplier" || r.name
          ? html`<span class="wl-name">${who}</span>`
          : html`<span class="wl-name m-title-only">${r.category || who}</span><span class="wl-name-d is-quiet">${who}</span>`}
        <span class="wl-sub m-only-inline" data-role="sub">${[r.kind === "supplier" || r.name ? r.category : r.kind === "planned" ? "No supplier yet" : "", shortPeso(r.total)].filter(Boolean).join(" · ")}</span>
      </button>
      <span class="wl-col wl-num d-only" data-role="total">${shortPeso(r.total)}</span>
      <span class="wl-state" data-role="status"><span class="wl-chip" data-tone="${late ? "danger" : STATUS_TONE[r.status]}">${late ? "Overdue" : STATUS[r.status]}</span><small class="m-only-inline" data-role="left-m">${left}</small></span>
      <span class="wl-col wl-num d-only" data-role="left">${left}</span>
      ${menu.length ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${who}">⋯</summary><div class="line-menu-list" role="menu">${menu.map((i) => html`${i.danger ? html`<div class="menu-sep" role="separator"></div>` : ""}<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="menu" data-kind="${r.kind}" data-x="${i.x}" data-id="${r.id}">${i.label}</button>`)}</div></details>` : html`<span class="wl-menu-gap"></span>`}
    </li>`;
  }

  const addItems = () => [
    ...(canPay ? [{ x: "expense", label: "Expense" }] : []),
    ...(canManage ? [{ x: "supplier", label: "Supplier" }] : []),
    ...(canCategory ? [{ x: "budget", label: "Budget item" }] : []),
  ];

  function summary() {
    if (!seesBudget) return "";
    if (state.loading) return html`<div class="wl-figs" data-role="money-summary-loading">${skeleton(1)}</div>`;
    const sum = moneySummary(state.budget, [...state.rows, ...state.inactive]);
    const fig = (k, label, value, title, cls = "") => html`<span class="wl-fig ${cls}" data-k="${k}" title="${title}"><span>${label}</span> <b>${value}</b></span>`;
    return html`<p class="wl-figs" data-role="money-summary">
      ${fig("budget", "Budget", sum.budget === null ? "—" : shortPeso(sum.budget), sum.budget === null ? "No budget yet: + Add → Budget item" : money(sum.budget))}<span class="wl-dot">·</span>${fig("spent", "Spent", shortPeso(sum.spent), money(sum.spent))}<span class="wl-dot">·</span>${fig("still", "To pay", shortPeso(sum.stillToPay), money(sum.stillToPay), sum.stillToPay ? "is-warn" : "")}<span class="wl-dot">·</span>${fig("remaining", "Left", sum.remaining === null ? "—" : shortPeso(sum.remaining), sum.remaining === null ? "Set a budget to see what's left" : money(sum.remaining), sum.remaining !== null && sum.remaining < 0 ? "is-over" : "")}
    </p>`;
  }

  function draw() {
    if (!alive) return;
    const list = shown();
    const add = addItems();
    render(
      container,
      html`
        ${pageHeader({
          title: "Money",
          actions: add.length ? html`<details class="line-menu wl-add" data-role="add"><summary class="btn btn-primary" aria-label="Add">+ Add</summary><div class="line-menu-list" role="menu">${add.map((i) => html`<button type="button" class="menu-item" role="menuitem" data-act="add" data-x="${i.x}">${i.label}</button>`)}</div></details>` : "",
        })}
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            ${summary()}
            ${state.loading
              ? skeleton(5)
              : !allRows().length
                ? emptyState({ iconName: "budget", title: "Nothing here yet", body: "Tap + Add for an expense, a supplier or a budget item." })
                : html`
                  <div class="wl-tools">
                    <label class="wl-pick"><span class="visually-hidden">Show</span><select class="select select-compact" data-role="filter" aria-label="Show">${FILTERS.map(([v, l]) => html`<option value="${v}" ${v === state.filter ? "selected" : ""}>${l}</option>`)}</select></label>
                    ${allRows().length > 8 || state.search ? html`<input class="input wl-search" type="search" data-role="search" placeholder="Search" aria-label="Search money" value="${state.search}">` : ""}
                  </div>
                  ${list.length ? html`<ul class="wl-list" data-role="money">${list.map(row)}</ul>` : html`<p class="stat-hint wl-none">Nothing ${state.filter === "all" ? "" : STATUS[state.filter].toLowerCase() + " "}${state.search ? `matching "${state.search}"` : "here"}.</p>`}
                  ${state.otherMore ? html`<p class="wl-links"><a href="/expenses" data-link>All expenses ›</a></p>` : ""}`}
            ${state.inactive.length ? html`<details class="wl-fold"><summary>Archived suppliers (${state.inactive.length})</summary><ul class="wl-list" data-role="suppliers-inactive">${moneyRows({ suppliers: state.inactive, categories: state.categories }).map(row)}</ul></details>` : ""}`}`
    );
  }

  // The category id for a typed name (created on the spot when new).
  const categoryFor = (text) => resolveCategory(text, { categories: state.categories, data, canCreate: canCategory });
  const withCategory = async (v) => {
    const categoryId = await categoryFor(v.category);
    return { ...v, categoryId, service: v.service || guessService(categoryNameOf(state.categories, categoryId)) };
  };

  const addSupplierDialog = (categoryName = "") =>
    formDialog({
      title: "Add supplier",
      fields: supplierFields({}, state.categories).map((f) => (f.name === "category" && categoryName ? { ...f, value: categoryName } : f)),
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
    let paid = [];
    backdrop.addEventListener("click", async (ev) => {
      const x = ev.target.closest("[data-x]");
      if (ev.target === backdrop || x?.dataset.x === "close") return close();
      // A paid line's proof: View, or Add when there's none yet.
      if (x?.dataset.x?.startsWith("proof-")) {
        const e = paid.find((y) => y.id === x.dataset.id);
        if (!e) return undefined;
        if (x.dataset.x !== "proof-view") close();
        try {
          await exp.proofAction(x.dataset.x, e);
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return undefined;
      }
      if (x?.dataset.x === "scheduled") {
        const p = state.upcoming.find((y) => y.id === x.dataset.id);
        close();
        if (p) pay.openView(p);
      }
      return undefined;
    });
    try {
      paid = seesExpenses ? (await data.listWeddingExpenses(businessId, { status: "active", supplierId: s.id }, { pageSize: 100 })).rows : [];
      const list = upcomingOf(s);
      const proofButton = (e) => (e.proof ? html`<button type="button" class="btn btn-compact btn-ghost" data-x="proof-view" data-id="${e.id}" aria-label="View proof of the ${whole(e.amount)} payment">View proof</button>` : can.update ? html`<button type="button" class="btn btn-compact btn-ghost" data-x="proof-add" data-id="${e.id}" aria-label="Add proof to the ${whole(e.amount)} payment">Add proof</button>` : "");
      paint(html`
        <ul class="slip" data-role="paid-list">${paid.length ? paid.map((e) => html`<li data-expense="${e.id}"><span class="slip-what">${whole(e.amount)} paid ${short(e.date)}${e.reference ? html`<small>${e.reference}</small>` : ""}</span><span class="slip-amt"></span><span class="slip-act">${proofButton(e)}</span></li>`) : html`<li><span class="slip-what stat-hint">Nothing paid yet.</span></li>`}</ul>
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
        proofField(),
      ],
      moreLabel: "More options",
      submitLabel: "Record payment",
      onSubmit: async (v) => {
        const amount = parseCentavos(v.amount);
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        const category = await categoryFor(v.category);
        const r = await data.expensesApi({ action: "create", idempotencyKey, expense: { date: v.date, category, amount, supplierId: s.id, method: v.method, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) } });
        await exp.attachAfter(r, v.proof);
        return r;
      },
    });
  }

  const exp = expenseActions({ data, currency, timezone, can, toast, getCtx: () => ({ today: today(), categories: state.categories, suppliers: state.rows }), reload: () => load(), ...(prepareProof ? { prepareProof } : {}) });

  const recorded = (r) => {
    if (r) {
      toast(r.alreadyRecorded ? "Already recorded: no second payment was added." : "Payment recorded.", "success");
      load();
    }
    return r;
  };
  const categoryDialog = (title, current) =>
    formDialog({ title, fields: [categoryField(state.categories, { value: current })], onSubmit: async (v) => ({ categoryId: await categoryFor(v.category) }) });
  const budgetItemDialog = (c = null) =>
    formDialog({
      title: c ? `${c.name}: budget` : "Add budget item",
      fields: [...(c ? [] : [{ ...categoryField(state.categories), label: "Item / category", placeholder: "e.g. Wedding gown" }]), { name: "budget", label: "Amount (₱)", value: c && Number.isSafeInteger(c.budget) ? String(c.budget / 100) : "", inputmode: "decimal", required: true }],
      submitLabel: c ? "Save" : "Add",
      onSubmit: async (v) => {
        const amount = parseBudget(v.budget, "amount");
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        const id = c ? c.id : await categoryFor(v.category);
        const cat = state.categories.find((x) => x.id === id);
        return data.budgetApi({ action: "updateCategory", categoryId: id, ...(cat?.revision ? { expectedRevision: cat.revision } : {}), changes: { budget: amount } });
      },
    });
  const saved = (message) => (r) => {
    if (r && !r.unchanged) toast(message, "success");
    if (r) load();
    return r;
  };
  async function openRow(kind, id) {
    const r = findRow(kind, id);
    if (!r) return;
    if (kind === "supplier") openView(r.record);
    else if (kind === "expense") exp.openView(r.record);
    else if (canCategory) saved("Budget saved.")(await budgetItemDialog(r.record));
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const a = el.dataset.act;
    el.closest("details.line-menu")?.removeAttribute("open");
    try {
      if (a === "add") {
        const x = el.dataset.x;
        if (x === "supplier") saved("Supplier added.")(await addSupplierDialog());
        else if (x === "expense") exp.done("Expense added")(await exp.addDialog());
        else if (x === "budget") saved("Budget item added.")(await budgetItemDialog());
        return;
      }
      if (a === "open") return await openRow(el.dataset.kind, el.dataset.id);
      if (a !== "menu") return;
      const r = findRow(el.dataset.kind, el.dataset.id);
      if (!r) return;
      const x = el.dataset.x;
      if (r.kind === "supplier") {
        const s = r.record;
        if (x === "view") openView(s);
        else if (x === "payments") await viewPayments(s);
        else if (x === "edit") saved("Saved.")(await editDialog(s));
        else if (x === "category") {
          const c = await categoryDialog(`${s.name}: category`, r.category);
          if (c && c.categoryId !== (s.categoryId ?? null)) saved("Category changed.")(await data.suppliersApi({ action: "update", supplierId: s.id, expectedRevision: s.revision, changes: { categoryId: c.categoryId } }));
        } else if (x === "record") recorded(await recordPayment(s, false));
        else if (x === "schedule") await pay.after("Payment scheduled.")(await pay.newDialog(s));
        else if (x === "archive") {
          await data.suppliersApi({ action: "setStatus", supplierId: s.id, status: s.status === "active" ? "inactive" : "active" });
          toast(s.status === "active" ? "Archived. Its payments and history are kept." : "Brought back.", "success");
          load();
        } else if (x === "delete") {
          if (!(await confirm({ title: `Delete ${s.name}?`, body: "Nothing was paid or scheduled to this supplier, so it can be deleted.", confirmLabel: "Delete", danger: true }))) return;
          await data.suppliersApi({ action: "delete", supplierId: s.id });
          toast(`${s.name} deleted.`, "success");
          load();
        }
      } else if (r.kind === "expense") {
        const e = r.record;
        if (x === "view" || x === "remove") exp.openView(e);
        else if (x.startsWith("proof-")) await exp.proofAction(x, e);
        else if (x === "category") {
          const c = await categoryDialog("Expense category", r.category);
          if (c && c.categoryId !== e.category) saved("Category changed.")(await data.expensesApi({ action: "update", expenseId: e.id, expectedRevision: e.revision, changes: { category: c.categoryId } }));
        }
      } else {
        const c = r.record;
        if (x === "supplier") saved("Supplier added.")(await addSupplierDialog(c.name));
        else if (x === "expense") exp.done("Expense added")(await exp.addDialog({ category: c.name }));
        else if (x === "amount") saved("Budget saved.")(await budgetItemDialog(c));
        else if (x === "unplan") {
          if (!(await confirm({ title: `Remove ${c.name} from the budget?`, body: "Its budget amount is cleared. Anything already paid stays.", confirmLabel: "Remove", danger: true }))) return;
          saved("Removed from the budget.")(await data.budgetApi({ action: "updateCategory", categoryId: c.id, ...(c.revision ? { expectedRevision: c.revision } : {}), changes: { budget: null } }));
        }
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
