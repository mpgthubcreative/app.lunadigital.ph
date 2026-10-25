// Bridal Expenses (the Wedding Suppliers module): everything the wedding
// costs, as ONE system (2026-10-21, final Bridal UX):
//   Spent ₱470k | To pay ₱400k            (two boxes; next payment, quiet)
//   PHOTO & VIDEO                          (category heading)
//     ABC Photo & Films                    [Pay]  ⋯
//     ₱90k total · ₱20k paid · ₱70k left
//     Next: Nov 10
//   Row kinds
//             supplier  a saved supplier (a contract): total = its contract
//                       (or what was paid / scheduled without one)
//             expense   an expense paid to no saved supplier: Paid
//   + Add Expense  the one smart form: Category (+ Add category), Supplier
//             (+ Add supplier, or none), Total contract, Record payment,
//             Paid now / Pay later (+ Due date). Suppliers, payments and
//             scheduled payments stay separate records underneath.
//   Pay       on each open contract: Amount, Paid now / Schedule for later;
//             pays a scheduled payment too (it is marked paid, never twice)
//   ⋯         Edit / Details / Remove (payment history lives in Details)
// Bridal has no Budget: old budget amounts stay stored but never show.
// The server keeps every check (paid + scheduled never above the contract).

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { expenseActions, proofField } from "./expenses.js";
import { SUPPLIER_SERVICES, EXPENSE_METHODS, EXPENSE_METHOD_IDS, supplierBalance, businessDate, weddingSummary } from "@shared/index.js";
import { parseBudget } from "../baby/budget.js";
import { activityLines, detailsDialog } from "../baby/common.js";
import { paymentActions } from "./payments.js";
import { categoryField, resolveCategory, categoryNameOf, guessService } from "./categories.js";
import * as defaultData from "./data.js";
import { paidState, moneyRows, moneyLabel, MONEY_STATUS } from "@shared/wedding-money.js";

const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
// Money rows, paid state and labels: shared/wedding-money.js (the Download
// Excel workbook lists the same rows).
export { paidState, moneyRows, moneyLabel };
// Words in the Expenses list.
const STATUS = MONEY_STATUS;
const STATUS_TONE = { unpaid: "", partly: "warning", paid: "success" };

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

// The Expenses figures (centavos). totals: budgets/current, where Luna
// keeps what was spent (no budget is shown).
export function moneySummary(totals, suppliers) {
  const stillToPay = suppliers.reduce((sum, x) => {
    const bal = supplierBalance(x);
    return sum + (bal === null ? Math.max(0, x.upcoming ?? 0) : Math.max(0, bal));
  }, 0);
  return { spent: weddingSummary(totals).spent, stillToPay };
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

const serviceLabel = (s) => SUPPLIER_SERVICES[s]?.label ?? s;
const pesosText = (c) => (Number.isSafeInteger(c) ? String(c / 100) : "");
// ₱ text -> centavos (null when blank), with a plain message.
function pesos(text, what) {
  try {
    return parseBudget(text, what);
  } catch {
    throw new Error(`Enter a valid ${what} (e.g. 20000 or 20,000.50), or leave it blank`);
  }
}
const NEW = "__new";
const NONE = "__none";

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
  // budget.view: the categories and the spent figure (no budget is shown).
  const seesTotals = perms["budget.view"] === true;
  const seesExpenses = perms["expenses.view"] === true;
  const canCategory = perms["budget.manage"] === true;
  const can = { create: canPay, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true, category: canCategory };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { rows: [], inactive: [], other: [], otherMore: false, totals: null, categories: [], upcoming: [], loading: true, error: null };
  let alive = true;
  let focus = new URLSearchParams(loc?.search || "").get("supplier");
  const money = (c) => (c === null || c === undefined ? "—" : formatCentavos(c, currency));
  const whole = (c) => money(c).replace(/\.00$/, "");

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      const [cats, totals, page, inactive, upcoming, expenses] = await Promise.all([
        seesTotals ? data.listCategories(businessId).catch(() => state.categories) : state.categories,
        seesTotals && data.getBudget ? data.getBudget(businessId).catch(() => null) : null,
        data.listSuppliers(businessId, { status: "active" }, { pageSize: 200 }),
        data.listSuppliers(businessId, { status: "inactive" }, { pageSize: 200 }).catch(() => ({ rows: [] })),
        seesPayments ? data.listSupplierPayments(businessId, { status: "upcoming" }, { pageSize: 200 }).then((r) => r.rows).catch(() => []) : [],
        seesExpenses && data.listWeddingExpenses ? data.listWeddingExpenses(businessId, { status: "active" }, { pageSize: 300 }).catch(() => ({ rows: [] })) : { rows: [] },
      ]);
      state.categories = cats;
      state.totals = totals;
      state.upcoming = upcoming;
      state.rows = page.rows;
      state.inactive = inactive.rows;
      state.other = expenses.rows.filter((e) => !e.supplierId);
      state.otherMore = Boolean(expenses.hasMore);
      state.error = null;
    } catch (err) {
      console.error("expenses: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load Expenses.";
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
  const allRows = () => moneyRows({ suppliers: state.rows, categories: state.categories, expenses: state.other, upcoming: state.upcoming });
  const findRow = (kind, id) => allRows().find((r) => r.kind === kind && r.id === id) || (kind === "supplier" ? moneyRows({ suppliers: state.inactive, categories: state.categories }).find((r) => r.id === id) : null);
  // What can still be paid or scheduled on a contract (null: no contract).
  const openOf = (s) => {
    const bal = supplierBalance(s);
    return bal === null ? null : Math.max(0, bal - upcomingOf(s).reduce((n, p) => n + p.amount, 0));
  };
  const mayPay = canPay || canSchedule;

  // ⋯ is just Edit / Details / Remove. Edit is the one place to change a
  // contract (category, supplier, total, payments, schedule); Details is
  // read-only with the payment history; Remove keeps any payment history.
  function menuItems(r) {
    const items = [];
    if (r.kind === "supplier") {
      const active = r.record.status === "active";
      if (canManage && active) items.push({ x: "edit", label: "Edit" });
      items.push({ x: "view", label: "Details" });
      if (canManage) items.push(active ? { x: "remove", label: "Remove", danger: true } : { x: "restore", label: "Bring back" });
    } else {
      if (can.update) items.push({ x: "edit", label: "Edit" });
      items.push({ x: "view", label: "Details" });
      if (can.remove) items.push({ x: "remove", label: "Remove", danger: true });
    }
    return items;
  }

  // One row (2026-10-21):
  //   ABC Photo & Films                         [Pay]  ⋯
  //   ₱90k total · ₱20k paid · ₱70k left
  //   Next: Nov 10
  // Each figure keeps its word (it never breaks inside "₱90k total").
  const piece = (text) => html`<span class="wl-nobr">${text}</span>`;
  function row(r) {
    const s = r.kind === "supplier" ? r.record : null;
    const plan = s ? upcomingOf(s) : [];
    const late = plan.some((p) => p.dueDate < today());
    const who = moneyLabel(r);
    let line;
    if (!s) line = html`${piece(shortPeso(r.total ?? 0))} · <span class="wl-state-word" data-tone="success">Paid</span>`;
    else if (r.status === "paid" && !(r.remaining > 0)) line = html`${piece(`${shortPeso(r.total ?? 0)} total`)} · <span class="wl-state-word" data-tone="success">Paid</span>`;
    else {
      const parts = [];
      if (r.total > 0 || Number.isSafeInteger(s.agreedAmount)) parts.push(piece(`${shortPeso(r.total ?? 0)} total`));
      parts.push(piece(`${shortPeso(s.paid ?? 0)} paid`));
      if (r.remaining > 0) parts.push(html`<b class="wl-nobr wl-owed${late ? " is-late" : ""}" data-role="left">${shortPeso(r.remaining)} left</b>`);
      line = parts.map((x, i) => html`${i ? " · " : ""}${x}`);
    }
    const next = plan[0] ? html`<span class="wl-sub hx-sub wl-next" data-role="next">Next: ${short(plan[0].dueDate)}${late ? html` · <span class="wl-state-word is-late" data-tone="danger">Overdue</span>` : ""}</span>` : "";
    const menu = menuItems(r);
    const payable = s && s.status === "active" && mayPay && (s.agreedAmount === null || s.agreedAmount === undefined || r.remaining > 0);
    return html`<li class="wl-row hx-row wl-money-row" data-kind="${r.kind}" data-${s ? "supplier" : "expense"}="${r.id}" data-state="${r.status}">
      <button type="button" class="wl-main hx-main" data-act="open" data-kind="${r.kind}" data-id="${r.id}">
        <span class="wl-name">${who}</span>
        <span class="wl-sub hx-sub" data-role="status">${line}</span>
        ${next}
      </button>
      ${payable ? html`<span class="wl-owe-col"><button type="button" class="btn btn-compact wl-pay" data-act="pay" data-id="${r.id}" aria-label="Pay ${who}">Pay</button></span>` : html`<span class="wl-amt hx-amt"></span>`}
      ${menu.length ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${who}">⋯</summary><div class="line-menu-list" role="menu">${menu.map((i) => html`${i.danger ? html`<div class="menu-sep" role="separator"></div>` : ""}<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="menu" data-kind="${r.kind}" data-x="${i.x}" data-id="${r.id}">${i.label}</button>`)}</div></details>` : html`<span class="wl-menu-gap"></span>`}
    </li>`;
  }
  const groupsHtml = (rows, role) => moneyGroups(rows).map((g) => html`<section class="wl-section hx-group" data-group="${g.key}"><h2 class="wl-cat-head hx-group-head"><span class="wl-group-title">${g.name}</span></h2><ul class="wl-list" data-role="${role}">${g.rows.map(row)}</ul></section>`);

  // The next payment due (scheduled, any supplier).
  const nextDue = () => [...state.upcoming].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))[0] ?? null;

  // Two boxes: Spent / To pay; the next payment due under them.
  function summary() {
    if (!seesTotals) return "";
    if (state.loading) return skeleton(1);
    const sum = moneySummary(state.totals, [...state.rows, ...state.inactive]);
    const n = nextDue();
    return html`<div class="hx-sum" data-role="money-summary"><div class="hx-sum-item" data-k="spent" title="${money(sum.spent)}"><span class="kpi-label">Spent</span><b class="kpi-value">${shortPeso(sum.spent)}</b></div><div class="hx-sum-item" data-k="still" title="${money(sum.stillToPay)}"><span class="kpi-label">To pay</span><b class="kpi-value">${shortPeso(sum.stillToPay)}</b></div></div>
      ${n ? html`<p class="stat-hint wl-budget-line" data-role="next-payment">Next payment: <b>${short(n.dueDate)}</b> · ${n.supplierName ?? n.description} ${shortPeso(n.amount)}${n.dueDate < today() ? " · overdue" : ""}</p>` : ""}`;
  }

  function draw() {
    if (!alive) return;
    render(
      container,
      html`
        ${pageHeader({ title: "Expenses", actions: canPay || canManage ? html`<button type="button" class="btn btn-primary" data-act="add-expense">+ Add Expense</button>` : "" })}
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : html`
            ${summary()}
            ${state.loading
              ? skeleton(5)
              : !allRows().length
                ? examplesState({
                    title: "No expenses yet",
                    body: "Each supplier or purchase shows what it costs, what's paid and what's left:",
                    items: [
                      { name: "Photographer", sub: "₱90,000 total · ₱20,000 paid · ₱70,000 left" },
                      { name: "Venue", sub: "₱150,000 total · ₱50,000 paid · ₱100,000 left" },
                      { name: "Wedding dress", sub: "₱35,000 paid" },
                    ],
                    add: canPay || canManage ? { act: "add-expense", label: "+ Add Expense" } : null,
                    helper: "Examples: venue, photographer, gown, flowers, catering, invitations.",
                    role: "expense-examples",
                  })
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

  // Details (read-only): Total contract / Paid / Remaining, scheduled
  // payments, then the payment history and activity folded away.
  async function openView(s) {
    let paid = [];
    try {
      paid = seesExpenses ? (await data.listWeddingExpenses(businessId, { status: "active", supplierId: s.id }, { pageSize: 100 })).rows : [];
    } catch {
      paid = [];
    }
    const plan = upcomingOf(s);
    const total = Number.isSafeInteger(s.agreedAmount) ? s.agreedAmount : null;
    const balance = supplierBalance(s);
    const proofWord = (e) => (e.proof ? (e.proof.contentType === "application/pdf" ? "PDF proof" : "Photo proof") : "No proof");
    const hero = html`<div class="dd-money" data-role="money-figures">
      <div class="dd-fig"><span>Total contract</span><b data-role="total">${total === null ? "Not set" : whole(total)}</b></div>
      <div class="dd-fig"><span>Paid</span><b data-role="paid">${whole(s.paid ?? 0)}</b>${total !== null ? html`<small class="dd-of" data-role="paid-of">of ${whole(total)}</small>` : ""}</div>
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
        ...(plan.length ? [{ title: "Scheduled payments", key: "scheduled", lines: plan.map((p) => ({ date: short(p.dueDate), amount: whole(p.amount), sub: [p.description, p.dueDate < today() ? "Overdue" : ""].filter(Boolean).join(" · ") })) }] : []),
        { title: "Payment history", key: "history", fold: { open: `View payment history${paid.length ? ` (${paid.length})` : ""}`, close: "Hide payment history" }, lines: [...paid].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).map((e) => ({ date: short(e.date), amount: whole(e.amount), sub: [e.method ? EXPENSE_METHODS[e.method]?.label ?? e.method : "", e.reference ? `Ref ${e.reference}` : "", proofWord(e)].filter(Boolean).join(" · ") })), empty: "Nothing paid yet." },
      ],
      activity: activityLines(s.history, timezone),
      activityFold: true,
      actions: [],
      onAction: async () => false,
    });
  }

  // Edit (one sheet): Category, Supplier, Total contract, then Payments
  // (Pay, proofs) and Payment schedule; contact details folded.
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
      html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Edit ${s.name}" data-role="money-edit">
        <div class="modal-header"><h2 class="card-title">Edit ${s.name}</h2></div>
        <div class="modal-body">
          <form data-role="money-edit-form" novalidate>
            <datalist id="me-cats">${cats.map((n) => html`<option value="${n}"></option>`)}</datalist>
            ${input("category", "Category", categoryNameOf(state.categories, s.categoryId), 'list="me-cats" autocomplete="off"')}
            ${input("name", "Supplier", s.name, "required")}
            ${input("agreedAmount", "Total contract (₱)", pesosText(s.agreedAmount), 'inputmode="decimal" placeholder="Optional"')}
            <details class="wl-fold"><summary>More details</summary>
              ${input("contactPerson", "Contact person", s.contactPerson)}${input("phone", "Phone", s.phone, 'inputmode="tel"')}${input("email", "Email", s.email)}${input("location", "Address / location", s.location)}
              <div class="field"><label for="me-notes">Notes</label><textarea class="input" id="me-notes" name="notes" rows="2">${s.notes ?? ""}</textarea></div>
            </details>
            <p class="form-error" role="alert" data-role="me-error" hidden></p>
          </form>
          <h3 class="slip-head">Payments</h3>
          <p class="wl-count" data-role="me-paid">${whole(s.paid ?? 0)} paid${balance === null ? "" : ` · ${whole(Math.max(0, balance))} remaining`} · <span class="wl-chip" data-tone="${STATUS_TONE[paidState(s)] || ""}">${STATUS[paidState(s)]}</span></p>
          ${paid.length ? html`<ul class="slip" data-role="paid-list">${paid.map((e) => html`<li data-expense="${e.id}"><span class="slip-what">${whole(e.amount)} paid ${short(e.date)}${e.reference ? html`<small>${e.reference}</small>` : ""}</span><span class="slip-amt"></span><span class="slip-act">${proofBtn(e)}</span></li>`)}</ul>` : ""}
          ${mayPay ? html`<button type="button" class="btn btn-compact" data-x="record">Pay</button>` : ""}
          <h3 class="slip-head">Payment schedule</h3>
          ${plan.length ? html`<ul class="wl-list" data-role="scheduled-list">${plan.map((p) => html`<li class="wl-row"><button type="button" class="wl-main" data-x="scheduled" data-id="${p.id}"><span class="wl-name">${short(p.dueDate)} · ${whole(p.amount)}</span><span class="wl-sub">${p.dueDate < today() ? "Overdue · " : ""}${p.description || "Tap to pay, edit or cancel"}</span></button></li>`)}</ul>` : html`<p class="stat-hint">Nothing scheduled.</p>`}
        </div>
        <div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button><button type="button" class="btn btn-primary" data-x="save">Save changes</button></div>
      </div>`
    );
    // After a payment change, reopen the sheet with fresh figures.
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
          if (paid_(await paySheet(s))) await again();
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

  // Remove: nothing recorded -> deleted; payments / schedule -> off the
  // active list (records, payments and history kept).
  async function removeRow(r) {
    if (r.kind === "supplier") {
      const s = r.record;
      const activity = s.paid > 0 || s.upcomingCount > 0;
      const keep = activity ? ` Its ${s.paid > 0 ? `${whole(s.paid)} in payments` : ""}${s.paid > 0 && s.upcomingCount > 0 ? " and " : ""}${s.upcomingCount > 0 ? "scheduled payments" : ""} stay in your records and history.` : "";
      if (!(await confirm({ title: `Remove ${s.name}?`, body: `It will no longer appear in your Expenses list.${keep}`, confirmLabel: "Remove", danger: true }))) return;
      if (activity) await data.suppliersApi({ action: "setStatus", supplierId: s.id, status: "inactive" });
      else await data.suppliersApi({ action: "delete", supplierId: s.id });
      toast("Removed.", "success");
      load();
    } else exp.done("Removed")(await exp.removeDialog(r.record));
  }

  const pay = paymentActions({ data, currency, timezone, today, canManage: canSchedule, canPay: canSchedule && canPay, toast, getCtx: () => ({ categories: state.categories, suppliers: state.rows }), reload: () => load() });
  const exp = expenseActions({ data, currency, timezone, can, toast, getCtx: () => ({ today: today(), categories: state.categories, suppliers: state.rows }), reload: () => load(), ...(prepareProof ? { prepareProof } : {}) });

  // Paid now / Pay later (Schedule for later): which fields show.
  //   now    Payment date + method / reference / proof
  //   later  Due date (today or later); payment details wait for the payment
  const show = (form, name, on) => {
    const el = form.elements[name];
    const box = el && (el.closest ? el.closest(".field") : el[0]?.closest(".field"));
    if (box) box.hidden = !on;
  };
  function timing(form, { forceNow = false } = {}) {
    const later = !forceNow && form.elements.when?.value === "later";
    show(form, "when", !forceNow);
    show(form, "date", !later);
    show(form, "dueDate", later);
    for (const n of ["method", "reference", "proof"]) show(form, n, !later);
    return later;
  }
  const whenField = (laterLabel, value) => {
    const options = [...(canPay ? [{ value: "now", label: "Paid now" }] : []), ...(canSchedule ? [{ value: "later", label: laterLabel }] : [])];
    return { name: "when", label: "Payment timing", type: "radio", options, value: options.some((o) => o.value === value) ? value : options[0]?.value };
  };
  const paymentFields = () => [
    { name: "date", label: "Payment date", type: "date", value: today(), max: today() },
    { name: "dueDate", label: "Due date", type: "date", value: "" },
    { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: "bank_transfer", more: true, default: true },
    { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: "", more: true },
    proofField(),
  ];
  // ONE payment to supplier s: now -> a Wedding Expense (one per dialog,
  // even on a retry); later -> a scheduled payment (not spent yet).
  async function recordFor(s, { amount, later, v, idempotencyKey, description = "Payment" }) {
    const category = s.categoryId || (await categoryFor(""));
    if (later) {
      if (!canSchedule) throw new Error("You can't schedule payments");
      if (!v.dueDate) throw new Error("Choose the due date");
      if (v.dueDate < today()) throw new Error("Choose today or a later due date");
      return data.paymentsApi({ action: "create", payment: { description, amount, dueDate: v.dueDate, category, supplierId: s.id } });
    }
    if (!canPay) throw new Error("You can't record payments. Choose to pay later");
    if (!v.date) throw new Error("Choose the payment date");
    const r = await data.expensesApi({ action: "create", idempotencyKey, expense: { date: v.date, category, amount, supplierId: s.id, method: v.method, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) } });
    await exp.attachAfter(r, v.proof);
    return r;
  }
  // Friendly overpayment check (the server checks again): paid + scheduled
  // never above the total contract.
  const overCheck = (open, amount) => {
    if (open !== null && amount > open) throw new Error(open > 0 ? `That's more than the ${whole(open)} still to pay on this contract. Change the total contract first if it went up.` : "Everything on this contract is already paid or scheduled. Change the total contract first if it went up.");
  };

  // Pay (on the row and in Edit): Amount, Paid now / Schedule for later,
  // Payment date or Due date. A scheduled payment can be paid here too: it
  // is marked paid (one expense), never paid twice.
  function paySheet(s) {
    const plan = canSchedule && canPay ? upcomingOf(s) : [];
    const open = openOf(s);
    const balance = supplierBalance(s);
    const idempotencyKey = newKey();
    const amountFor = (which) => {
      const p = plan.find((x) => x.id === which);
      return p ? (p.amount / 100).toFixed(2) : open ? (open / 100).toFixed(2) : "";
    };
    const first = plan.length ? plan[0].id : NEW;
    let lastWhich = first;
    return formDialog({
      title: `Pay ${s.name}`,
      intro: balance === null ? `${whole(s.paid ?? 0)} paid so far` : `${whole(s.paid ?? 0)} paid · ${whole(Math.max(0, balance))} remaining`,
      fields: [
        ...(plan.length ? [{ name: "which", label: "Payment", type: "select", options: [...plan.map((p) => ({ value: p.id, label: `${whole(p.amount)} due ${short(p.dueDate)}${p.description && p.description !== "Payment" ? ` · ${p.description}` : ""}` })), { value: NEW, label: "A new payment" }], value: first }] : []),
        { name: "amount", label: "Amount (₱)", value: amountFor(first), inputmode: "decimal", required: true },
        whenField("Schedule for later", "now"),
        ...paymentFields(),
        { name: "description", label: "What it's for", value: "", placeholder: "e.g. Second payment", more: true },
      ],
      moreLabel: "More options",
      submitLabel: "Save",
      onFormChange: (form) => {
        const which = form.elements.which?.value ?? NEW;
        if (which !== lastWhich) {
          form.elements.amount.value = amountFor(which);
          lastWhich = which;
        }
        timing(form, { forceNow: which !== NEW });
      },
      onSubmit: async (v) => {
        const amount = pesos(v.amount, "amount");
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        const p = plan.find((x) => x.id === v.which);
        if (p) {
          if (!v.date) throw new Error("Choose the payment date");
          overCheck(open === null ? null : open + p.amount, amount);
          const r = await data.paymentsApi({ action: "markPaid", paymentId: p.id, payment: { paidDate: v.date, method: v.method, ...(amount !== p.amount ? { amount } : {}), ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) } });
          await exp.attachAfter(r, v.proof);
          return r;
        }
        overCheck(open, amount);
        return recordFor(s, { amount, later: v.when === "later", v, idempotencyKey, description: (v.description || "").trim() || "Payment" });
      },
    });
  }

  // + Add Expense: the one smart form for wedding money.
  //   Category   [Select category] / + Add category (typed right here)
  //   Supplier   [Select supplier] / + Add supplier / No supplier (one-off)
  //   Total contract, Record payment (blank = nothing paid yet)
  //   Paid now / Pay later (+ Due date)
  // Never leaves the form: a new category / supplier is created on Save.
  function addExpenseDialog() {
    const cats = state.categories.filter((c) => c.status === "active");
    const suppliers = state.rows;
    const idempotencyKey = newKey();
    const made = { supplier: null, key: "" }; // a supplier created by an earlier try of this form
    let lastSupplier = "";
    return formDialog({
      title: "Add Expense",
      fields: [
        { name: "category", label: "Category", type: "select", options: [{ value: "", label: "Select category" }, ...cats.map((c) => ({ value: c.id, label: c.name })), ...(canCategory ? [{ value: NEW, label: "+ Add category" }] : [])], value: cats.length || !canCategory ? "" : NEW },
        ...(canCategory ? [{ ...categoryField(state.categories), name: "newCategory", label: "New category" }] : []),
        { name: "supplierId", label: "Supplier", type: "select", options: [{ value: "", label: "Select supplier" }, ...suppliers.map((x) => ({ value: x.id, label: x.name })), ...(canManage ? [{ value: NEW, label: "+ Add supplier" }] : []), ...(canPay ? [{ value: NONE, label: "No supplier (one-off expense)" }] : [])], value: suppliers.length || !canManage ? "" : NEW },
        ...(canManage ? [{ name: "newSupplier", label: "Supplier name", value: "", placeholder: "e.g. ABC Photo & Films" }] : []),
        { name: "payee", label: "Paid to / what for", value: "", placeholder: "e.g. Photographer balance" },
        { name: "agreedAmount", label: "Total contract (₱)", value: "", inputmode: "decimal", hint: "Optional. Luna works out what's left." },
        // Without the right to pay or schedule: the contract only.
        ...(mayPay ? [{ name: "amount", label: "Record payment (₱)", value: "", inputmode: "decimal", hint: "Leave blank if nothing is paid yet." }, whenField("Pay later", "now"), ...paymentFields()] : []),
      ],
      moreLabel: "More options",
      submitLabel: "Save",
      onFormChange: (form) => {
        const el = form.elements;
        const who = el.supplierId.value;
        // A saved supplier brings its category and total contract.
        if (who !== lastSupplier) {
          const x = suppliers.find((y) => y.id === who);
          if (x) {
            if (x.categoryId && cats.some((c) => c.id === x.categoryId)) el.category.value = x.categoryId;
            el.agreedAmount.value = pesosText(x.agreedAmount);
          } else if (suppliers.some((y) => y.id === lastSupplier)) el.agreedAmount.value = "";
          lastSupplier = who;
        }
        show(form, "newCategory", el.category.value === NEW);
        show(form, "newSupplier", who === NEW);
        show(form, "payee", who === NONE);
        show(form, "agreedAmount", who !== NONE);
        if (mayPay) timing(form, { forceNow: who === NONE });
      },
      onSubmit: async (v) => {
        const amount = mayPay ? pesos(v.amount, "payment") ?? 0 : 0;
        if (!v.supplierId) throw new Error("Select a supplier, + Add supplier, or No supplier");
        const existing = suppliers.find((x) => x.id === v.supplierId) || null;
        if (v.category === NEW && !(v.newCategory || "").trim()) throw new Error("Type the new category's name");
        if (!v.category && !existing?.categoryId) throw new Error("Select a category");

        if (v.supplierId === NONE) {
          if (!(amount > 0)) throw new Error("Enter what was paid");
          if (!v.date) throw new Error("Choose the payment date");
          const category = v.category === NEW ? await categoryFor(v.newCategory) : v.category;
          const payee = (v.payee || "").trim();
          const r = await data.expensesApi({ action: "create", idempotencyKey, expense: { date: v.date, category, amount, method: v.method, ...(payee ? { payee } : {}), ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) } });
          await exp.attachAfter(r, v.proof);
          return { ...r, saved: "Expense saved." };
        }

        const total = pesos(v.agreedAmount, "total contract");
        const later = v.when === "later";
        let s = existing;
        if (v.supplierId === NEW) {
          const name = (v.newSupplier || "").trim();
          if (!name) throw new Error("Type the supplier's name");
          if (total !== null && amount > total) throw new Error(`The payment is more than the ${whole(total)} total contract`);
          const categoryId = v.category === NEW ? await categoryFor(v.newCategory) : v.category;
          const key = `${name}|${categoryId}|${total}`;
          if (made.supplier && made.key === key) s = made.supplier;
          else {
            const input = toSupplierInput({ name, agreedAmount: v.agreedAmount, categoryId, service: guessService(categoryNameOf(state.categories, categoryId)) });
            const r = await data.suppliersApi({ action: "create", supplier: input });
            s = { id: r.supplierId, name, categoryId, agreedAmount: input.agreedAmount, paid: 0 };
            made.supplier = s;
            made.key = key;
          }
          if (!(amount > 0)) return { supplierId: s.id, saved: `${name} added.` };
        } else {
          const changed = (s.agreedAmount ?? null) !== total;
          if (!changed && !(amount > 0)) throw new Error("Enter a payment, or change the total contract");
          if (changed) {
            if (!canManage) throw new Error("Only the Owner can change the total contract");
            await data.suppliersApi({ action: "update", supplierId: s.id, expectedRevision: s.revision, changes: { agreedAmount: total } });
            s = { ...s, agreedAmount: total, revision: (s.revision ?? 0) + 1 };
            if (!(amount > 0)) return { supplierId: s.id, saved: "Total contract saved." };
          }
          const committed = (s.paid ?? 0) + upcomingOf(s).reduce((n, p) => n + p.amount, 0);
          overCheck(total === null ? null : Math.max(0, total - committed), amount);
          // The chosen category (when it differs) goes on this payment only.
          if (v.category && v.category !== NEW && v.category !== s.categoryId) s = { ...s, categoryId: v.category };
          else if (v.category === NEW) s = { ...s, categoryId: await categoryFor(v.newCategory) };
        }
        const r = await recordFor(s, { amount, later, v, idempotencyKey });
        return { ...r, saved: later ? "Payment scheduled." : "Payment recorded." };
      },
    });
  }

  // After Pay / + Add Expense: a toast and a fresh list.
  const paid_ = (r) => {
    if (r) {
      toast(r.alreadyRecorded || r.alreadyPaid ? "Already recorded: no second payment was added." : r.saved || (r.paymentId && !r.expenseId ? "Payment scheduled." : "Payment recorded."), "success");
      load();
    }
    return r;
  };
  async function openRow(kind, id) {
    const r = findRow(kind, id);
    if (!r) return;
    if (kind === "supplier") await openView(r.record);
    else exp.openView(r.record, { readOnly: true });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const a = el.dataset.act;
    el.closest("details.line-menu")?.removeAttribute("open");
    try {
      if (a === "add-expense") return paid_(await addExpenseDialog());
      if (a === "open") return await openRow(el.dataset.kind, el.dataset.id);
      // Pay, right on the supplier's row (no menu, no sheet first).
      if (a === "pay") {
        const s = state.rows.find((x) => x.id === el.dataset.id);
        return s ? paid_(await paySheet(s)) : undefined;
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
      } else if (x === "view") exp.openView(r.record, { readOnly: true });
      else if (x === "edit") exp.done("Expense updated")(await exp.editDialog(r.record));
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  container.addEventListener("click", onClick);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
  };
}
