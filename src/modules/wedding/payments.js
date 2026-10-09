// Supplier Payments (Phase 16): a supplier's payment schedule and history,
// one compact row per payment.
//   Due date | Supplier | Description | Category | Amount | Status | Mark paid · View details
// An Upcoming payment is a commitment, not spending. "Mark paid" records
// exactly ONE Wedding Expense (a retry or a second click returns the same
// one); only then do Spent and the supplier's Paid go up.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { SUPPLIER_PAYMENT_STATUSES, EXPENSE_METHODS, EXPENSE_METHOD_IDS, parseCentavos, businessDate } from "@shared/index.js";
import { categoryName, optionsOf, activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";

const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const TONE = { upcoming: "warning", paid: "success", cancelled: "neutral" };

function paymentFields(p, { categories, suppliers }) {
  const active = categories.filter((c) => c.status === "active");
  const fields = [];
  if (!p) fields.push({ name: "supplierId", label: "Supplier", type: "select", options: optionsOf(suppliers), value: suppliers[0]?.id ?? "" });
  fields.push(
    { name: "description", label: "Description", value: p?.description ?? "", required: true, hint: "e.g. Reservation fee, Second payment, Balance" },
    { name: "category", label: "Budget category", type: "select", options: optionsOf(active, { blank: p ? null : "— The supplier's category —", include: p ? { value: p.category, label: `${p.categoryName ?? "Category"} (inactive)` } : null }), value: p?.category ?? "" },
    { name: "amount", label: "Amount (PHP)", value: p ? (p.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
    { name: "dueDate", label: "Due date", type: "date", value: p?.dueDate ?? "", required: true },
    { name: "notes", label: "Notes", type: "textarea", value: p?.notes ?? "" }
  );
  return fields;
}

export function parseSupplierPayment(v, suppliers = []) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.dueDate) throw new Error("Choose a due date");
  const out = { description: v.description.trim(), amount, dueDate: v.dueDate, notes: (v.notes || "").trim() || null };
  if (v.supplierId !== undefined) {
    if (!v.supplierId) throw new Error("Choose a supplier (add one under Wedding Suppliers)");
    out.supplierId = v.supplierId;
  }
  const category = v.category || suppliers.find((s) => s.id === v.supplierId)?.categoryId || "";
  if (!category) throw new Error("Choose a budget category");
  out.category = category;
  return out;
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["vendorpayments.manage"] === true;
  const canPay = canManage && perms["expenses.create"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "upcoming" }, cursors: [], rows: [], hasMore: false, categories: [], suppliers: [], loading: true, error: null };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, sups, page] = await Promise.all([
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        state.suppliers.length || !perms["vendors.view"] ? state.suppliers : data.activeSuppliers(businessId).catch(() => []),
        data.listSupplierPayments(businessId, state.filters, { cursor: state.cursors.at(-1) || null }),
      ]);
      state.categories = cats;
      state.suppliers = sups;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("supplier payments: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load supplier payments.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;
  // Overdue is derived (an Upcoming payment past its due date), never stored.
  const statusBadge = (p) => (p.status === "upcoming" && p.dueDate < today() ? badge("Overdue", "danger") : badge(SUPPLIER_PAYMENT_STATUSES[p.status]?.label ?? p.status, TONE[p.status] || "neutral"));

  function draw() {
    if (!alive) return;
    const f = state.filters;
    const n = names();
    render(
      container,
      html`
        ${pageHeader({ title: "Supplier Payments", subtitle: "Deposits and balances due to your suppliers. They count as spent only once you mark them paid.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">Schedule payment</button>` : "" })}
        <form class="section card filters filters-inline" data-role="filters">
          <select class="select" name="status" aria-label="Status">${Object.entries(SUPPLIER_PAYMENT_STATUSES).map(([k, s]) => opt(k, s.label, f.status))}</select>
          <input class="input" type="date" name="from" value="${f.from || ""}" aria-label="Due from" />
          <input class="input" type="date" name="to" value="${f.to || ""}" aria-label="Due to" />
          <select class="select" name="supplierId" aria-label="Supplier">${opt("", "Any supplier", f.supplierId || "")}${state.suppliers.map((s) => opt(s.id, s.name, f.supplierId))}</select>
          <select class="select" name="category" aria-label="Category">${opt("", "Any category", f.category || "")}${state.categories.map((c) => opt(c.id, c.name, f.category))}</select>
          <button type="submit" class="btn">Apply</button>
          ${mayExport(session, "supplierPayments") ? html`${exportButton("supplierPayments")}<span class="stat-hint">${exportHint}</span>` : ""}
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !state.rows.length
                ? emptyState({ iconName: "payments", title: f.status === "upcoming" ? "No upcoming supplier payments" : "Nothing here", body: "Schedule each supplier's deposits and balances to see what's coming up." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="payments">
                    <thead><tr><th>Due date</th><th>Supplier</th><th>Description</th><th class="col-secondary">Category</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (p) => html`<tr data-payment="${p.id}">
                        <td>${formatDayId(p.dueDate)}</td><td>${p.supplierName}</td><td>${p.description}</td>
                        <td class="col-secondary">${categoryName(n, p)}</td>
                        <td class="num">${formatCentavos(p.status === "paid" ? p.paidAmount ?? p.amount : p.amount, currency)}</td>
                        <td>${statusBadge(p)}</td>
                        <td class="row-actions">
                          ${canPay && p.status === "upcoming" ? html`<button type="button" class="btn btn-compact" data-act="pay" data-id="${p.id}">Mark paid</button>` : ""}
                          <button type="button" class="btn btn-compact" data-act="view" data-id="${p.id}">View details</button>
                        </td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>`
    );
  }

  const ctx = () => ({ categories: state.categories, suppliers: state.suppliers });
  const newDialog = () =>
    formDialog({
      title: "Schedule a supplier payment",
      intro: "Not spending yet: it shows under Upcoming payments until you mark it paid. Paid + scheduled can't exceed the supplier's agreed amount.",
      fields: paymentFields(null, ctx()),
      onSubmit: (v) => {
        const p = parseSupplierPayment(v, state.suppliers);
        if (p.notes === null) delete p.notes;
        return data.paymentsApi({ action: "create", payment: p });
      },
    });
  const editDialog = (p) =>
    formDialog({
      title: `Edit ${p.description}`,
      fields: paymentFields(p, ctx()),
      onSubmit: (v) => {
        const next = parseSupplierPayment({ ...v, category: v.category || p.category });
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (p[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? data.paymentsApi({ action: "update", paymentId: p.id, expectedRevision: p.revision, changes }) : { unchanged: true };
      },
    });
  // One expense, once: the server returns the same expense on a retry.
  const payDialog = (p) =>
    formDialog({
      title: `Mark ${p.description} paid`,
      intro: `This records ONE Wedding Expense paid to ${p.supplierName} and removes it from Upcoming.`,
      fields: [
        { name: "paidDate", label: "Date paid", type: "date", value: today(), max: today(), required: true },
        { name: "amount", label: "Amount paid (PHP)", value: (p.amount / 100).toFixed(2), inputmode: "decimal", required: true, hint: "Change it if the final bill differed." },
        { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: "bank_transfer" },
        { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: "" },
      ],
      submitLabel: "Mark paid",
      onSubmit: (v) => {
        const amount = parseCentavos(v.amount);
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        const payment = { paidDate: v.paidDate, method: v.method, ...(amount !== p.amount ? { amount } : {}), ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) };
        return data.paymentsApi({ action: "markPaid", paymentId: p.id, payment });
      },
    });
  const cancelDialog = (p) =>
    formDialog({
      title: `Cancel ${p.description}?`,
      intro: "It leaves Upcoming payments. Nothing is spent.",
      fields: [{ name: "reason", label: "Reason (optional)", type: "textarea" }],
      submitLabel: "Cancel payment",
      onSubmit: (v) => data.paymentsApi({ action: "cancel", paymentId: p.id, ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) }),
    });
  const after = (message) => (r) => {
    if (!r) return false;
    if (!r.unchanged) toast(r.alreadyPaid ? "Already marked paid: no second expense was recorded." : message, "success");
    load();
    return true;
  };

  function openView(p) {
    const upcoming = p.status === "upcoming";
    detailsDialog({
      title: `${p.supplierName} · ${p.description}`,
      badgeHtml: statusBadge(p),
      rows: [
        ["Supplier", p.supplierName],
        ["Due date", formatDayId(p.dueDate)],
        ["Amount", formatCentavos(p.amount, currency)],
        ["Category", categoryName(names(), p)],
        ["Status", SUPPLIER_PAYMENT_STATUSES[p.status]?.label ?? p.status],
        ["Paid on", p.paidDate ? formatDayId(p.paidDate) : null],
        ["Amount paid", p.paidAmount ? formatCentavos(p.paidAmount, currency) : null],
        ["Payment method", p.method ? EXPENSE_METHODS[p.method]?.label ?? p.method : null],
        ["Reference", p.reference],
        ["Linked expense", p.expenseId ? "Recorded in Wedding Expenses" : null],
        ["Cancel reason", p.cancelReason],
        ["Notes", p.notes],
      ],
      activity: activityLines(p.history, timezone),
      actions: upcoming && canManage ? [{ act: "cancel", label: "Cancel payment", danger: true }, { act: "edit", label: "Edit" }, ...(canPay ? [{ act: "pay", label: "Mark paid" }] : [])] : [],
      onAction: async (act) => {
        try {
          if (act === "edit") return after("Saved.")(await editDialog(p));
          if (act === "cancel") return after("Payment cancelled.")(await cancelDialog(p));
          if (act === "pay") return after("Marked paid. The expense was recorded.")(await payDialog(p));
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return undefined;
    const p = state.rows.find((r) => r.id === el.dataset.id);
    try {
      switch (el.dataset.act) {
        case "new":
          if (!state.suppliers.length) {
            toast("Add a supplier first (Wedding Suppliers).", "danger");
            return undefined;
          }
          return after("Payment scheduled.")(await newDialog());
        case "pay":
          return p ? after("Marked paid. The expense was recorded.")(await payDialog(p)) : undefined;
        case "view":
          return p ? openView(p) : undefined;
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
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const el = event.target.elements;
    if (el.from.value && el.to.value && el.from.value > el.to.value) {
      toast("Choose a valid date range (the start can't be after the end).", "danger");
      return;
    }
    state.filters = Object.fromEntries([["status", el.status.value], ["from", el.from.value], ["to", el.to.value], ["supplierId", el.supplierId.value], ["category", el.category.value]].filter(([, v]) => v));
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, () => ({ ...state.filters }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
