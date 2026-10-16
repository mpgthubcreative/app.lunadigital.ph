// Money (Owner-pilot Bridal UX; the Wedding Suppliers module): what we
// budgeted, paid and still owe, on one page.
//   Summary   Wedding budget · Paid / Spent · Still to pay · Remaining budget
//             (Spent = every active Wedding Expense, supplier payments
//             included, so nothing is counted twice; Still to pay = what
//             suppliers are still owed on their agreements, plus anything
//             scheduled to a supplier without one; Remaining = budget −
//             spent − still to pay)
//   Suppliers one compact row each: name · status · amount due · Pay · ⋯
//             (All / Unpaid / Partly paid / Paid, search)
//   Other     the latest expenses not paid to a saved supplier, + Add expense
// Pay records the supplier's next scheduled payment, or one Wedding Expense
// for the supplier (the same records as before; nothing is typed twice).
// The full Wedding Expenses, Supplier Payments and Budget pages stay.
//
// Wedding Suppliers (Phase 16): one compact row per supplier.
//   Supplier (+ service) | Agreed | Paid | Balance | Paid? | Scheduled | View details
// Phase 18.6: suppliers and their payments live on this one page.
//   Paid?      Unpaid / Partly paid / Paid. Choosing Paid or Partly paid
//              records ONE Wedding Expense for the supplier (nothing is
//              ever un-paid here: a mistake is removed under Expenses).
//   Scheduled  the supplier's upcoming payments (open one to Mark paid,
//              Edit or Cancel) and "Schedule a payment..."
// Paid and Balance are computed by Luna (paid = the supplier's
// Wedding Expenses; balance = agreed − paid); nobody types them. Not
// Distributor Customers, not Baby providers.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton, segmented } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { expenseActions } from "./expenses.js";
import { SUPPLIER_SERVICES, SUPPLIER_STATUSES, EXPENSE_METHODS, EXPENSE_METHOD_IDS, supplierBalance, businessDate, parseCentavos, weddingSummary } from "@shared/index.js";
import { parseBudget } from "../baby/budget.js";
import { activityLines, detailsDialog, optionsOf, categoryName } from "../baby/common.js";
import { paymentActions } from "./payments.js";
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
const FILTERS = [["all", "All"], ["unpaid", "Unpaid"], ["partly", "Partly paid"], ["paid", "Paid"]];
const OTHER_SHOWN = 6;

// The Money figures (all in centavos; remaining null without a budget).
export function moneySummary(budget, suppliers) {
  const s = weddingSummary(budget);
  const stillToPay = suppliers.reduce((sum, x) => {
    const bal = supplierBalance(x);
    return sum + (bal === null ? Math.max(0, x.upcoming ?? 0) : Math.max(0, bal));
  }, 0);
  return { budget: s.total, spent: s.spent, stillToPay, remaining: s.total === null ? null : s.total - s.spent - stillToPay };
}
const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

const SERVICE_OPTIONS = Object.entries(SUPPLIER_SERVICES).map(([value, s]) => ({ value, label: s.label }));
const serviceLabel = (s) => SUPPLIER_SERVICES[s]?.label ?? s;
const pesosText = (c) => (Number.isSafeInteger(c) ? String(c / 100) : "");

const supplierFields = (s = {}, categories = []) => [
  { name: "name", label: "Supplier / business name", value: s.name ?? "", required: true, hint: "e.g. ABC Photo Studio" },
  { name: "service", label: "Service", type: "select", options: SERVICE_OPTIONS, value: s.service ?? "venue" },
  { name: "agreedAmount", label: "Agreed / contract amount (₱, optional)", value: pesosText(s.agreedAmount), inputmode: "decimal", hint: "Leave blank if you're only keeping their contact." },
  { name: "categoryId", label: "Budget category for its payments", type: "select", options: optionsOf(categories.filter((c) => c.status === "active"), { blank: "— Choose when scheduling —" }), value: s.categoryId ?? "" },
  { name: "contactPerson", label: "Contact person", value: s.contactPerson ?? "" },
  { name: "phone", label: "Phone", value: s.phone ?? "", inputmode: "tel" },
  { name: "email", label: "Email", value: s.email ?? "" },
  { name: "location", label: "Address / location", value: s.location ?? "" },
  { name: "notes", label: "Notes", type: "textarea", value: s.notes ?? "" },
];

export function toSupplierInput(v) {
  const out = { name: v.name.trim(), service: v.service, agreedAmount: parseBudget(v.agreedAmount, "agreed amount"), categoryId: v.categoryId || null };
  for (const k of ["contactPerson", "phone", "email", "location", "notes"]) out[k] = (v[k] || "").trim() || null;
  return out;
}


export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, confirm = confirmDialog, location: loc = globalThis.location } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["vendors.manage"] === true;
  const canSchedule = perms["vendorpayments.manage"] === true;
  const canPay = perms["expenses.create"] === true;
  const seesPayments = perms["vendorpayments.view"] === true;
  const seesBudget = perms["budget.view"] === true;
  const seesExpenses = perms["expenses.view"] === true;
  const can = { create: canPay, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filter: "all", search: "", rows: [], inactive: [], other: [], otherMore: false, budget: null, categories: [], upcoming: [], loading: true, error: null };
  let alive = true;
  let focus = new URLSearchParams(loc?.search || "").get("supplier");
  const money = (c) => (c === null || c === undefined ? "—" : formatCentavos(c, currency));

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      const [cats, budget, page, inactive, upcoming, expenses] = await Promise.all([
        state.categories.length || !seesBudget ? state.categories : data.listCategories(businessId).catch(() => []),
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
      state.other = other.slice(0, OTHER_SHOWN);
      state.otherMore = other.length > OTHER_SHOWN || Boolean(expenses.hasMore);
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
    const list = upcomingOf(s);
    const bal = supplierBalance(s);
    if (s.status === "active" && canPay) {
      items.push({ x: "record", label: list.length ? "Record another payment" : "Record payment" });
      if (bal > 0 && !list.length) items.push({ x: "full", label: "Paid in full" });
    }
    for (const p of list) items.push({ x: "scheduled", id: p.id, label: `${p.dueDate < today() ? "Overdue" : "Due"} ${short(p.dueDate)} · ${money(p.amount)}` });
    if (s.status === "active" && canSchedule) items.push({ x: "schedule", label: "Schedule a payment" });
    items.push({ x: "view", label: "View details" });
    if (canManage) items.push({ x: "edit", label: "Edit" });
    return items;
  }

  function row(s) {
    const st = paidState(s);
    const bal = supplierBalance(s);
    const list = upcomingOf(s);
    const late = list.some((p) => p.dueDate < today());
    const due = bal > 0 ? `${money(bal)} due` : "";
    // Phone sub-line: status (or Overdue) · amount due, whole pesos when exact.
    const sub = [late ? "Overdue" : PAID_STATES[st], due.replace(/\.00 due$/, " due")].filter(Boolean).join(" · ");
    const payable = s.status === "active" && canPay && (list.length > 0 || bal > 0);
    return html`<li class="wl-row wl-supplier" data-supplier="${s.id}" data-state="${st}">
      <button type="button" class="wl-main" data-act="view" data-id="${s.id}"><span class="wl-name">${s.name}</span><span class="wl-sub m-only-inline" data-role="sub">${sub}</span></button>
      <span class="wl-col wl-num d-only">${s.agreedAmount === null || s.agreedAmount === undefined ? "—" : money(s.agreedAmount)}</span>
      <span class="wl-col d-only">${badge(PAID_STATES[st], PAID_TONE[st])}${late ? html` ${badge("Overdue", "danger")}` : ""}</span>
      <span class="wl-col wl-num d-only" data-role="due">${due}</span>
      <span class="wl-end">${payable ? html`<button type="button" class="btn btn-compact btn-primary" data-act="pay" data-id="${s.id}">Pay</button>` : ""}
        <details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${s.name}">⋯</summary><div class="line-menu-list" role="menu">${menuItems(s).map((i) => html`<button type="button" class="menu-item" role="menuitem" data-act="menu" data-x="${i.x}" data-id="${s.id}" data-pay="${i.id || ""}">${i.label}</button>`)}</div></details>
      </span>
    </li>`;
  }

  function draw() {
    if (!alive) return;
    const sum = moneySummary(state.budget, [...state.rows, ...state.inactive]);
    const list = shown();
    const names = new Map(state.categories.map((c) => [c.id, c.name]));
    render(
      container,
      html`
        ${pageHeader({ title: "Money", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add supplier</button>` : "" })}
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            ${seesBudget && state.loading
              ? html`<div class="wl-sum" data-role="money-summary-loading">${skeleton(2)}</div>`
              : seesBudget
              ? html`<dl class="wl-sum" data-role="money-summary">
                  <dt>Wedding budget</dt><dd data-k="budget">${sum.budget === null ? html`<a href="/budget" data-link>Set budget</a>` : html`<a href="/budget" data-link class="wl-quiet-link">${money(sum.budget)}</a>`}</dd>
                  <dt>Paid / Spent</dt><dd data-k="spent">${money(sum.spent)}</dd>
                  <dt>Still to pay</dt><dd data-k="still">${money(sum.stillToPay)}</dd>
                  <dt>Remaining budget</dt><dd data-k="remaining" class="${sum.remaining !== null && sum.remaining < 0 ? "is-over" : ""}">${sum.remaining === null ? "—" : sum.remaining < 0 ? `Over by ${money(-sum.remaining)}` : money(sum.remaining)}</dd>
                </dl>`
              : ""}
            <section class="wl-section" data-section="suppliers">
              <div class="wl-head"><h2 class="wl-title">Suppliers</h2>${mayExport(session, "weddingSuppliers") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("weddingSuppliers")}` : ""}</div>
              <div class="wl-tools">${segmented("filter", FILTERS, state.filter, { label: "Show suppliers" })}
                ${state.rows.length > 6 || state.search ? html`<input class="input wl-search" type="search" data-role="search" placeholder="Search supplier" aria-label="Search supplier" value="${state.search}">` : ""}</div>
              ${state.loading
                ? skeleton(4)
                : !state.rows.length
                  ? emptyState({ iconName: "provider", title: "No suppliers yet", body: "Add your venue, caterer, photographer and their agreed amounts." })
                  : !list.length
                    ? html`<p class="stat-hint wl-none">No ${state.filter === "all" ? "" : PAID_STATES[state.filter].toLowerCase() + " "}suppliers${state.search ? ` matching "${state.search}"` : ""}.</p>`
                    : html`<ul class="wl-list" data-role="suppliers">${list.map(row)}</ul>`}
              ${state.inactive.length ? html`<details class="wl-fold"><summary>Inactive suppliers (${state.inactive.length})</summary><ul class="wl-list" data-role="suppliers-inactive">${state.inactive.map(row)}</ul></details>` : ""}
            </section>
            ${seesExpenses
              ? html`<section class="wl-section" data-section="other">
                  <div class="wl-head"><h2 class="wl-title">Other expenses</h2>${canPay ? html`<button type="button" class="btn btn-compact" data-act="add-expense">+ Add expense</button>` : ""}</div>
                  ${state.loading
                    ? ""
                    : state.other.length
                      ? html`<ul class="wl-list" data-role="other-expenses">${state.other.map(
                          (e) => html`<li class="wl-row" data-expense="${e.id}"><button type="button" class="wl-main" data-act="expense" data-id="${e.id}"><span class="wl-name">${e.payee || categoryName(names, e)}</span><span class="wl-sub">${categoryName(names, e)} · ${short(e.date)}</span></button><span class="wl-amt">${money(e.amount)}</span></li>`
                        )}</ul>`
                      : html`<p class="stat-hint wl-none">Transport, permits, small purchases: anything not paid to a saved supplier.</p>`}
                </section>`
              : ""}
            <p class="page-foot wl-links">${seesExpenses ? html`<a href="/expenses" data-link>All expenses ›</a>` : ""}${seesPayments ? html`<a href="/supplier-payments" data-link>Payment history ›</a>` : ""}${seesBudget ? html`<a href="/budget" data-link>Budget categories ›</a>` : ""}</p>`}`
    );
  }

  const editDialog = (s) =>
    formDialog({
      title: `Edit ${s.name}`,
      intro: "Past expenses and payments keep the name they were recorded with. The agreed amount can't go below what's already paid or scheduled.",
      fields: supplierFields(s, state.categories),
      onSubmit: (v) => {
        const next = toSupplierInput(v);
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (s[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? data.suppliersApi({ action: "update", supplierId: s.id, expectedRevision: s.revision, changes }) : { unchanged: true };
      },
    });

  function openView(s) {
    detailsDialog({
      title: s.name,
      badgeHtml: badge(SUPPLIER_STATUSES[s.status]?.label ?? s.status, s.status === "active" ? "success" : "neutral"),
      rows: [
        ["Service", serviceLabel(s.service)],
        ["Agreed amount", s.agreedAmount === null || s.agreedAmount === undefined ? "No agreement recorded" : money(s.agreedAmount)],
        ["Paid", money(s.paid ?? 0)],
        ["Balance", money(supplierBalance(s))],
        ["Upcoming", `${money(s.upcoming ?? 0)}${s.upcomingCount ? ` (${s.upcomingCount} payment${s.upcomingCount === 1 ? "" : "s"})` : ""}`],
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

  const pay = paymentActions({ data, currency, timezone, today, canManage: canSchedule, canPay: canSchedule && canPay, toast, getCtx: () => ({ categories: state.categories, suppliers: state.rows }), reload: () => load() });

  // One Wedding Expense paid to this supplier. Full = the balance not
  // already scheduled (scheduled payments are paid from Scheduled).
  function recordPayment(s, full) {
    const balance = supplierBalance(s);
    const scheduled = upcomingOf(s).reduce((sum, p) => sum + p.amount, 0);
    const open = balance === null ? null : Math.max(0, balance - scheduled);
    const active = state.categories.filter((c) => c.status === "active");
    // One key per dialog: a double click or a retry records ONE expense.
    const idempotencyKey = newKey();
    return formDialog({
      title: full ? `${s.name}: paid in full` : `${s.name}: record a payment`,
      intro: `Records ONE Wedding Expense paid to ${s.name}.${scheduled ? ` ${money(scheduled)} is already scheduled: pay those from Scheduled.` : ""}`,
      fields: [
        { name: "amount", label: "Amount paid (₱)", value: full && open ? (open / 100).toFixed(2) : "", inputmode: "decimal", required: true, hint: balance === null ? "" : `Balance: ${money(balance)}` },
        { name: "date", label: "Date paid", type: "date", value: today(), max: today(), required: true },
        { name: "category", label: "Budget category", type: "select", options: optionsOf(active, { blank: "— Choose —" }), value: s.categoryId ?? "" },
        { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: "bank_transfer" },
        { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: "" },
      ],
      submitLabel: "Record payment",
      onSubmit: (v) => {
        const amount = parseCentavos(v.amount);
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        if (!v.category) throw new Error("Choose a budget category");
        return data.expensesApi({ action: "create", idempotencyKey, expense: { date: v.date, category: v.category, amount, supplierId: s.id, method: v.method, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) } });
      },
    });
  }


  const exp = expenseActions({ data, currency, timezone, can, toast, getCtx: () => ({ today: today(), categories: state.categories, suppliers: state.rows }), reload: () => load() });

  async function payNow(s) {
    const next = upcomingOf(s)[0];
    if (next) return pay.after("Marked paid. The expense was recorded.")(await pay.payDialog(next));
    const r = await recordPayment(s, false);
    if (r) {
      toast(r.alreadyRecorded ? "Already recorded: no second payment was added." : "Payment recorded.", "success");
      load();
    }
    return r;
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    const a = el.dataset.act;
    if (a === "seg") {
      state.filter = el.dataset.value;
      draw();
      return;
    }
    const s = [...state.rows, ...state.inactive].find((r) => r.id === el.dataset.id);
    el.closest("details")?.removeAttribute("open");
    try {
      if (a === "new") {
        const r = await formDialog({ title: "Add supplier", fields: supplierFields({}, state.categories), onSubmit: (v) => data.suppliersApi({ action: "create", supplier: toSupplierInput(v) }) });
        if (r) {
          toast("Supplier added.", "success");
          load();
        }
      } else if (a === "add-expense") {
        if (!state.categories.some((c) => c.status === "active")) {
          toast("Add a budget category first (Budget categories).", "danger");
          return;
        }
        exp.done("Expense added")(await exp.addDialog());
      } else if (a === "expense") {
        const e = state.other.find((x) => x.id === el.dataset.id);
        if (e) exp.openView(e);
      } else if (a === "view" && s) openView(s);
      else if (a === "pay" && s) await payNow(s);
      else if (a === "menu" && s) {
        const x = el.dataset.x;
        if (x === "view") openView(s);
        else if (x === "edit") {
          const r = await editDialog(s);
          if (r && !r.unchanged) toast("Saved.", "success");
          if (r) load();
        } else if (x === "record" || x === "full") {
          const r = await recordPayment(s, x === "full");
          if (r) {
            toast(r.alreadyRecorded ? "Already recorded: no second payment was added." : "Payment recorded.", "success");
            load();
          }
        } else if (x === "schedule") await pay.after("Payment scheduled.")(await pay.newDialog(s));
        else if (x === "scheduled") {
          const p = state.upcoming.find((y) => y.id === el.dataset.pay);
          if (p) pay.openView(p);
        }
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
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
  container.addEventListener("input", onInput);
  const unbindExport = bindExport(container, () => ({ status: "active" }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    container.removeEventListener("click", onClick);
    container.removeEventListener("input", onInput);
  };
}
