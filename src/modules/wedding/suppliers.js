// Money (Owner-pilot Bridal UX; the Wedding Suppliers module): everything
// the wedding costs, laid out like Household Expenses (2026-10-18):
//   Spent ₱470k | To pay ₱400k            (two boxes; the budget, if set, a quiet line)
//   RECEPTION                              (category heading, no total)
//     Admiral Hotel          ₱800k   ⋯     (supplier / payee / description)
//     Partial · ₱330k left                (status + what's left, quiet)
// Sample Budget is a secondary view (+ Add → From sample budget), not a tab.
//   Row kinds
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
import { pageHeader, emptyState, badge, skeleton, segmented } from "../../components/ui.js";
import { SAMPLE_BUDGET, sampleKey } from "@shared/wedding-samples.js";
import { sampleList, sampleItem } from "./samples.js";
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
    if (c.status !== "active" || !(c.budget > 0 || c.planned === true) || withSupplier.has(c.id)) continue;
    const amount = c.budget > 0 ? c.budget : null; // null: on the plan, amount not set yet
    rows.push({ kind: "planned", id: c.id, categoryId: c.id, category: c.name, name: null, total: amount, status: "planned", remaining: amount === null ? null : Math.max(0, amount - (spentBy[c.id] ?? 0)), record: c });
  }
  for (const e of expenses) {
    if (e.supplierId) continue;
    rows.push({ kind: "expense", id: e.id, categoryId: e.category, category: name(e.category) || e.categoryName || "", name: e.payee || null, total: e.amount, status: "paid", remaining: 0, record: e });
  }
  const rank = { supplier: 0, planned: 1, expense: 2 };
  return rows.sort((a, b) => (order.get(a.categoryId) ?? 999) - (order.get(b.categoryId) ?? 999) || rank[a.kind] - rank[b.kind] || (a.name || "").localeCompare(b.name || ""));
}

// Money rows grouped under their category (the heading), in category order.
export function moneyGroups(rows) {
  const groups = [];
  const at = new Map();
  for (const r of rows) {
    const key = r.categoryId ?? "none";
    if (!at.has(key)) {
      at.set(key, groups.length);
      groups.push({ key, name: r.category || "Other", rows: [] });
    }
    groups[at.get(key)].rows.push(r);
  }
  return groups;
}
// The row's label: supplier, payee or description; a plan line without a supplier says so.
export const moneyLabel = (r) => r.name || (r.kind === "expense" ? r.record?.notes || "Expense" : "No supplier yet");

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
  // view: "mine" (My Money) | "sample" (the read-only Sample Budget).
  const state = { view: "mine", filter: "all", search: "", rows: [], inactive: [], other: [], otherMore: false, budget: null, categories: [], upcoming: [], loading: true, error: null };
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

  // Owner-pilot Bridal: ⋯ is just Edit / Details / Remove. Edit is the one
  // place to change a Money line (category, supplier, total, payments,
  // schedule); Details is read-only; Remove keeps any payment history.
  function menuItems(r) {
    const items = [];
    if (r.kind === "supplier") {
      const s = r.record;
      const active = s.status === "active";
      if (canManage && active) items.push({ x: "edit", label: "Edit" });
      items.push({ x: "view", label: "Details" });
      if (canManage) items.push(active ? { x: "remove", label: "Remove", danger: true } : { x: "restore", label: "Bring back" });
    } else if (r.kind === "expense") {
      if (can.update) items.push({ x: "edit", label: "Edit" });
      items.push({ x: "view", label: "Details" });
      if (can.remove) items.push({ x: "remove", label: "Remove", danger: true });
    } else {
      if (canCategory) items.push({ x: "edit", label: "Edit" });
      items.push({ x: "view", label: "Details" });
      if (canCategory) items.push({ x: "remove", label: "Remove", danger: true });
    }
    return items;
  }

  // A Money row (2026-10-18): what is still owed is the figure that stands
  // out; paid and planned lines are quiet.
  //   Admiral Hotel                    ₱330k left
  //   ₱800k total · Partial
  //   Nice Print / Paid · ₱40k         Wedding Gown / ₱80k planned
  function row(r) {
    const late = r.kind === "supplier" && upcomingOf(r.record).some((p) => p.dueDate < today());
    const who = moneyLabel(r);
    const word = late ? "Overdue" : STATUS[r.status];
    const tone = late ? "danger" : STATUS_TONE[r.status];
    const owes = (r.status === "unpaid" || r.status === "partly") && Number.isSafeInteger(r.remaining) && r.remaining > 0;
    const sub =
      r.status === "planned"
        ? r.total === null ? html`<span class="wl-state-word" data-tone="info">Planned</span> · amount not set` : html`${shortPeso(r.total)} <span class="wl-state-word" data-tone="info">planned</span>`
        : r.status === "paid"
          ? html`<span class="wl-state-word" data-tone="success">Paid</span> · ${shortPeso(r.total ?? 0)}`
          : html`${r.total === null ? "" : `${shortPeso(r.total)} total · `}<span class="wl-state-word${late ? " is-late" : ""}" data-tone="${tone}">${word}</span>`;
    const menu = menuItems(r);
    return html`<li class="wl-row hx-row wl-money-row" data-kind="${r.kind}" data-${r.kind === "supplier" ? "supplier" : r.kind === "planned" ? "planned" : "expense"}="${r.id}" data-state="${r.status}">
      <button type="button" class="wl-main hx-main" data-act="open" data-kind="${r.kind}" data-id="${r.id}">
        <span class="wl-name">${who}</span>
        <span class="wl-sub hx-sub" data-role="status">${sub}</span>
      </button>
      ${owes ? html`<span class="wl-amt hx-amt wl-owed${late ? " is-late" : ""}" data-role="left">${shortPeso(r.remaining)} left</span>` : html`<span class="wl-amt hx-amt" data-role="left"></span>`}
      ${menu.length ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${who}">⋯</summary><div class="line-menu-list" role="menu">${menu.map((i) => html`${i.danger ? html`<div class="menu-sep" role="separator"></div>` : ""}<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="menu" data-kind="${r.kind}" data-x="${i.x}" data-id="${r.id}">${i.label}</button>`)}</div></details>` : html`<span class="wl-menu-gap"></span>`}
    </li>`;
  }
  const groupsHtml = (rows, role) => moneyGroups(rows).map((g) => html`<section class="wl-section hx-group" data-group="${g.key}"><h2 class="wl-cat-head hx-group-head"><span class="wl-group-title">${g.name}</span></h2><ul class="wl-list" data-role="${role}">${g.rows.map(row)}</ul></section>`);

  const addItems = () => [
    ...(canPay ? [{ x: "expense", label: "Expense (paid)" }] : []),
    ...(canManage ? [{ x: "supplier", label: "Supplier" }] : []),
    ...(canCategory ? [{ x: "budget", label: "Budget item" }] : []),
    ...(canCategory ? [{ x: "sample", label: "From sample budget" }] : []),
  ];

  // Two boxes (Spent / To pay); a set budget is a quiet line under them.
  function summary() {
    if (!seesBudget) return "";
    if (state.loading) return skeleton(1);
    const sum = moneySummary(state.budget, [...state.rows, ...state.inactive]);
    return html`<div class="hx-sum" data-role="money-summary"><div class="hx-sum-item" data-k="spent" title="${money(sum.spent)}"><span class="kpi-label">Spent</span><b class="kpi-value">${shortPeso(sum.spent)}</b></div><div class="hx-sum-item" data-k="still" title="${money(sum.stillToPay)}"><span class="kpi-label">To pay</span><b class="kpi-value">${shortPeso(sum.stillToPay)}</b></div></div>
      ${sum.budget !== null ? html`<p class="stat-hint wl-budget-line" data-role="budget-line">Budget ${shortPeso(sum.budget)} · ${sum.remaining < 0 ? `over by ${shortPeso(-sum.remaining)}` : `${shortPeso(sum.remaining)} left`}</p>` : ""}`;
  }

  function draw() {
    if (!alive) return;
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
          : state.view === "sample"
            ? html`<p class="wl-links"><button type="button" class="btn btn-compact btn-ghost" data-act="sample-back">‹ Money</button></p>
                <h2 class="section-title">Sample budget</h2>
                ${state.loading ? skeleton(5) : sampleList({ groups: SAMPLE_BUDGET, added: new Set(allRows().map((r) => sampleKey(r.category))), canAdd: canCategory, role: "sample-money", intro: "A starter list of what weddings usually pay for. It doesn't count in your totals: tap + Add to put a line on Money (Planned, amount later)." })}`
          : html`
            ${summary()}
            ${state.loading
              ? skeleton(5)
              : !allRows().length
                ? emptyState({ iconName: "budget", title: "Nothing here yet", body: "Tap + Add for an expense, a supplier or a budget item, or pick lines from the sample budget." })
                : html`${groupsHtml(allRows(), "money")}
                  ${state.otherMore ? html`<p class="wl-links"><a href="/expenses" data-link>All expenses ›</a></p>` : ""}`}
            ${state.inactive.length ? html`<details class="wl-fold"><summary>Removed from the list (${state.inactive.length})</summary><ul class="wl-list" data-role="suppliers-inactive">${moneyRows({ suppliers: state.inactive, categories: state.categories }).map(row)}</ul></details>` : ""}`}`
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
  // Details (read-only): what happened with this wedding expense.
  async function openView(s) {
    let paid = [];
    try {
      paid = seesExpenses ? (await data.listWeddingExpenses(businessId, { status: "active", supplierId: s.id }, { pageSize: 100 })).rows : [];
    } catch {
      paid = [];
    }
    const plan = upcomingOf(s);
    // Details (2026-10-18): what it is, then Total / Paid / Remaining (the
    // figure the couple cares about), scheduled payments, and the payment
    // history and activity folded away. Nothing is said twice.
    const total = Number.isSafeInteger(s.agreedAmount) ? s.agreedAmount : null;
    const balance = supplierBalance(s);
    const shortDay = (d) => formatDayId(d).replace(/, \d{4}$/, "");
    const proofWord = (e) => (e.proof ? (e.proof.contentType === "application/pdf" ? "PDF proof" : "Photo proof") : "No proof");
    const hero = html`<div class="dd-money" data-role="money-figures">
      <div class="dd-fig"><span>Total</span><b data-role="total">${total === null ? "Not set" : whole(total)}</b></div>
      <div class="dd-fig"><span>Paid</span><b data-role="paid">${whole(s.paid ?? 0)}${total !== null ? html`<small> / ${whole(total)}</small>` : ""}</b></div>
      ${balance !== null ? html`<div class="dd-fig dd-fig-main${balance > 0 ? "" : " is-done"}"><span>Remaining</span><b data-role="remaining">${whole(Math.max(0, balance))}</b></div>` : ""}
    </div>`;
    detailsDialog({
      title: s.name,
      subtitle: [categoryNameOf(state.categories, s.categoryId), serviceLabel(s.service)].filter((x, i, a) => x && a.indexOf(x) === i && x !== "Other").join(" · "),
      badgeHtml: badge(s.status === "active" ? STATUS[paidState(s)] : "Removed from the list", s.status === "active" ? STATUS_TONE[paidState(s)] || "neutral" : "neutral"),
      hero,
      rows: [
        ["Contact person", s.contactPerson],
        ["Phone", s.phone],
        ["Email", s.email],
        ["Address / location", s.location],
        ["Notes", s.notes],
      ],
      sections: [
        ...(plan.length ? [{ title: "Scheduled payments", key: "scheduled", lines: plan.map((p) => ({ date: shortDay(p.dueDate), amount: whole(p.amount), sub: [p.description, p.dueDate < today() ? "Overdue" : ""].filter(Boolean).join(" · ") })) }] : []),
        { title: "Payment history", key: "history", fold: { open: `View payment history${paid.length ? ` (${paid.length})` : ""}`, close: "Hide payment history" }, lines: [...paid].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).map((e) => ({ date: shortDay(e.date), amount: whole(e.amount), sub: [e.method ? EXPENSE_METHODS[e.method]?.label ?? e.method : "", e.reference ? `Ref ${e.reference}` : "", proofWord(e)].filter(Boolean).join(" · ") })), empty: "Nothing paid yet." },
      ],
      activity: activityLines(s.history, timezone),
      activityFold: true,
      actions: [],
      onAction: async () => false,
    });
  }

  // Edit (one sheet): Category, Supplier, Total, then Payments (Record
  // payment, proofs) and Payment schedule; contact details folded.
  async function editSheet(s) {
    let paid = [];
    try {
      paid = seesExpenses ? (await data.listWeddingExpenses(businessId, { status: "active", supplierId: s.id }, { pageSize: 100 })).rows : [];
    } catch {
      paid = [];
    }
    const plan = upcomingOf(s);
    const balance = supplierBalance(s);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const cats = state.categories.filter((c) => c.status === "active").map((c) => c.name);
    const input = (name, label, value, extra = "") => html`<div class="field"><label for="me-${name}">${label}</label><input class="input" id="me-${name}" name="${name}" value="${value ?? ""}" ${extra}></div>`;
    const proofBtn = (e) => (e.proof ? html`<button type="button" class="btn btn-compact btn-ghost" data-x="proof-view" data-id="${e.id}">View proof</button>` : can.update ? html`<button type="button" class="btn btn-compact btn-ghost" data-x="proof-add" data-id="${e.id}">Add proof</button>` : "");
    render(
      backdrop,
      html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Edit money item" data-role="money-edit">
        <div class="modal-header"><h2 class="card-title">Edit money item</h2></div>
        <div class="modal-body">
          <form data-role="money-edit-form" novalidate>
            <datalist id="me-cats">${cats.map((n) => html`<option value="${n}"></option>`)}</datalist>
            ${input("category", "Category", categoryNameOf(state.categories, s.categoryId), 'list="me-cats" autocomplete="off"')}
            ${input("name", "Supplier", s.name, "required")}
            ${input("agreedAmount", "Total (₱)", pesosText(s.agreedAmount), 'inputmode="decimal" placeholder="Optional"')}
            <details class="wl-fold"><summary>More details</summary>
              ${input("contactPerson", "Contact person", s.contactPerson)}${input("phone", "Phone", s.phone, 'inputmode="tel"')}${input("email", "Email", s.email)}${input("location", "Address / location", s.location)}
              <div class="field"><label for="me-notes">Notes</label><textarea class="input" id="me-notes" name="notes" rows="2">${s.notes ?? ""}</textarea></div>
            </details>
            <p class="form-error" role="alert" data-role="me-error" hidden></p>
          </form>
          <h3 class="slip-head">Payments</h3>
          <p class="wl-count" data-role="me-paid">${whole(s.paid ?? 0)} paid${balance === null ? "" : ` · ${whole(balance)} remaining`} · <span class="wl-chip" data-tone="${STATUS_TONE[paidState(s)] || ""}">${STATUS[paidState(s)]}</span></p>
          ${paid.length ? html`<ul class="slip" data-role="paid-list">${paid.map((e) => html`<li data-expense="${e.id}"><span class="slip-what">${whole(e.amount)} paid ${short(e.date)}${e.reference ? html`<small>${e.reference}</small>` : ""}</span><span class="slip-amt"></span><span class="slip-act">${proofBtn(e)}</span></li>`)}</ul>` : ""}
          ${canPay ? html`<button type="button" class="btn btn-compact" data-x="record">Record payment</button>` : ""}
          <h3 class="slip-head">Payment schedule</h3>
          ${plan.length ? html`<ul class="wl-list" data-role="scheduled-list">${plan.map((p) => html`<li class="wl-row"><button type="button" class="wl-main" data-x="scheduled" data-id="${p.id}"><span class="wl-name">${short(p.dueDate)} · ${whole(p.amount)}</span><span class="wl-sub">${p.dueDate < today() ? "Overdue · " : ""}${p.description || "Tap to pay, edit or cancel"}</span></button></li>`)}</ul>` : html`<p class="stat-hint">Nothing scheduled.</p>`}
          ${canSchedule ? html`<button type="button" class="btn btn-compact" data-x="schedule">${plan.length ? "Add to schedule" : "Add a payment schedule"}</button>` : ""}
        </div>
        <div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button><button type="button" class="btn btn-primary" data-x="save">Save changes</button></div>
      </div>`
    );
    // After a payment / schedule change, reopen the sheet with fresh figures.
    const again = async () => {
      await load();
      const fresh = state.rows.find((x) => x.id === s.id);
      if (fresh) await editSheet(fresh);
    };
    backdrop.addEventListener("click", async (ev) => {
      const x = ev.target.closest("[data-x]")?.dataset.x;
      if (ev.target === backdrop || x === "close") return close();
      try {
        if (x === "save") {
          const f = backdrop.querySelector('[data-role="money-edit-form"]').elements;
          const v = Object.fromEntries(["category", "name", "agreedAmount", "contactPerson", "phone", "email", "location", "notes"].map((k) => [k, f[k].value]));
          if (!v.name.trim()) throw new Error("Enter the supplier's name");
          const next = toSupplierInput(await withCategory({ ...v, service: s.service }));
          const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (s[k] ?? null) !== (val ?? null)));
          if (Object.keys(changes).length) {
            await data.suppliersApi({ action: "update", supplierId: s.id, expectedRevision: s.revision, changes });
            toast("Saved.", "success");
          }
          close();
          load();
        } else if (x === "record") {
          close();
          if (recorded(await recordPayment(s, false))) await again();
        } else if (x === "schedule") {
          close();
          const r = await pay.newDialog(s);
          await pay.after("Payment scheduled.")(r);
          if (r) await again();
        } else if (x === "scheduled") {
          const p = state.upcoming.find((y) => y.id === ev.target.closest("[data-x]").dataset.id);
          close();
          if (p) pay.openView(p);
        } else if (x === "proof-view" || x === "proof-add") {
          const e = paid.find((y) => y.id === ev.target.closest("[data-x]").dataset.id);
          if (!e) return undefined;
          if (x === "proof-add") close();
          await exp.proofAction(x, e);
        }
      } catch (err) {
        const box = backdrop.querySelector('[data-role="me-error"]');
        if (box) {
          box.hidden = false;
          box.textContent = err.message || "Couldn't save";
        }
        toast(err.message || "Something went wrong", "danger");
      }
      return undefined;
    });
  }

  // Planned line: Edit (category, amount, optional supplier) and Details.
  const plannedEdit = (c) =>
    formDialog({
      title: "Edit money item",
      fields: [
        { name: "name", label: "Category", value: c.name, required: true },
        { name: "budget", label: "Amount (₱)", value: Number.isSafeInteger(c.budget) ? String(c.budget / 100) : "", inputmode: "decimal", hint: "Optional: leave blank until you know it." },
        ...(canManage ? [{ name: "supplier", label: "Supplier / Payee", value: "", placeholder: "e.g. Nice Print Photography", hint: "Optional. Adding one turns this planned line into a supplier line." }] : []),
      ],
      submitLabel: "Save changes",
      onSubmit: async (v) => {
        const budget = v.budget.trim() ? parseBudget(v.budget, "amount") : null;
        const changes = {};
        if (v.name.trim() !== c.name) changes.name = v.name.trim();
        if ((c.budget ?? null) !== budget) changes.budget = budget;
        if (budget === null && !c.planned) changes.planned = true; // stays on the plan without an amount
        if (Object.keys(changes).length) await data.budgetApi({ action: "updateCategory", categoryId: c.id, ...(c.revision ? { expectedRevision: c.revision } : {}), changes });
        const name = (v.supplier || "").trim();
        if (name) await data.suppliersApi({ action: "create", supplier: toSupplierInput({ name, service: guessService(changes.name || c.name), agreedAmount: budget === null ? "" : String(budget / 100), categoryId: c.id }) });
        return Object.keys(changes).length || name ? { saved: true } : { unchanged: true };
      },
    });
  const plannedView = (r) =>
    detailsDialog({
      title: r.category,
      badgeHtml: badge("Planned", "info"),
      rows: [["Category", r.category], ["Supplier", "No supplier yet"], ["Planned amount", r.total === null ? "Amount not set" : money(r.total)], ["Spent so far", money((state.budget?.spentByCategory || {})[r.id] ?? 0)], ["Remaining", r.remaining === null ? "—" : money(r.remaining)]],
      activity: activityLines(r.record.history, timezone),
      actions: [],
      onAction: async () => false,
    });

  // Remove: nothing recorded -> deleted; payments / schedule -> off the
  // active list (records, payments and history kept). Planned -> off the plan.
  async function removeRow(r) {
    if (r.kind === "supplier") {
      const s = r.record;
      const activity = s.paid > 0 || s.upcomingCount > 0;
      const keep = activity ? ` Its ${s.paid > 0 ? `${whole(s.paid)} in payments` : ""}${s.paid > 0 && s.upcomingCount > 0 ? " and " : ""}${s.upcomingCount > 0 ? "scheduled payments" : ""} stay in your records and history.` : "";
      if (!(await confirm({ title: "Remove this money item?", body: `It will no longer appear in your active wedding money list.${keep}`, confirmLabel: "Remove", danger: true }))) return;
      if (activity) await data.suppliersApi({ action: "setStatus", supplierId: s.id, status: "inactive" });
      else await data.suppliersApi({ action: "delete", supplierId: s.id });
      toast("Removed.", "success");
      load();
    } else if (r.kind === "expense") exp.done("Removed")(await exp.removeDialog(r.record));
    else {
      const c = r.record;
      if (!(await confirm({ title: "Remove this money item?", body: "It will no longer appear in your active wedding money list. Anything already paid stays.", confirmLabel: "Remove", danger: true }))) return;
      saved("Removed.")(await data.budgetApi({ action: "updateCategory", categoryId: c.id, ...(c.revision ? { expectedRevision: c.revision } : {}), changes: { budget: null, ...(c.planned ? { planned: false } : {}) } }));
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
    if (kind === "supplier") await openView(r.record);
    else if (kind === "expense") exp.openView(r.record, { readOnly: true });
    else if (canCategory) saved("Saved.")(await plannedEdit(r.record));
    else plannedView(r);
  }

  // Sample Budget + Add: a normal Planned line (category = the item, no
  // supplier, no amount yet). An existing category of that name is reused
  // (brought back if archived) and put on the plan.
  async function addSampleLine(name) {
    const c = state.categories.find((x) => sampleKey(x.name) === sampleKey(name));
    if (!c) await data.budgetApi({ action: "createCategory", category: { name, budget: null, planned: true } });
    else {
      if (c.status !== "active") await data.budgetApi({ action: "setCategoryStatus", categoryId: c.id, status: "active" });
      await data.budgetApi({ action: "updateCategory", categoryId: c.id, changes: { planned: true } });
    }
    toast(`Added to Money: ${name} (Planned)`, "success");
    load();
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
        else if (x === "sample") {
          state.view = "sample";
          draw();
        }
        return;
      }
      if (a === "sample-back") {
        state.view = "mine";
        draw();
        return;
      }
      if (a === "open") return await openRow(el.dataset.kind, el.dataset.id);
      if (a === "seg") {
        state.view = el.dataset.value === "sample" ? "sample" : "mine";
        draw();
        return;
      }
      if (a === "sample-add") {
        const pick = sampleItem(SAMPLE_BUDGET, el);
        if (!pick) return;
        el.disabled = true;
        await addSampleLine(pick.item.title);
        return;
      }
      if (a !== "menu") return;
      const r = findRow(el.dataset.kind, el.dataset.id);
      if (!r) return;
      const x = el.dataset.x;
      if (x === "remove") return await removeRow(r);
      if (r.kind === "supplier") {
        const s = r.record;
        if (x === "view") await openView(s);
        else if (x === "edit") await editSheet(s);
        else if (x === "restore") {
          await data.suppliersApi({ action: "setStatus", supplierId: s.id, status: "active" });
          toast("Brought back.", "success");
          load();
        }
      } else if (r.kind === "expense") {
        const e = r.record;
        if (x === "view") exp.openView(e, { readOnly: true });
        else if (x === "edit") exp.done("Expense updated")(await exp.editDialog(e));
      } else if (x === "edit") saved("Saved.")(await plannedEdit(r.record));
      else if (x === "view") plannedView(r);
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
