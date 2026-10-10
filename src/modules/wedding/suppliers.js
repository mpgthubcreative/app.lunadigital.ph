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
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, rowMenu, bindRowMenus, filterBar } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { SUPPLIER_SERVICES, SUPPLIER_STATUSES, EXPENSE_METHODS, EXPENSE_METHOD_IDS, supplierBalance, businessDate, parseCentavos } from "@shared/index.js";
import { parseBudget } from "../baby/budget.js";
import { activityLines, detailsDialog, optionsOf } from "../baby/common.js";
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

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, confirm = confirmDialog } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["vendors.manage"] === true;
  const canSchedule = perms["vendorpayments.manage"] === true;
  const canPay = perms["expenses.create"] === true;
  const seesPayments = perms["vendorpayments.view"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "active" }, cursors: [], rows: [], hasMore: false, categories: [], upcoming: [], loading: true, error: null };
  let alive = true;
  const money = (c) => (c === null || c === undefined ? "—" : formatCentavos(c, currency));

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, page, upcoming] = await Promise.all([
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId).catch(() => []),
        data.listSuppliers(businessId, state.filters, { cursor: state.cursors.at(-1) || null }),
        seesPayments ? data.listSupplierPayments(businessId, { status: "upcoming" }, { pageSize: 200 }).then((r) => r.rows).catch(() => []) : [],
      ]);
      state.categories = cats;
      state.upcoming = upcoming;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("wedding suppliers: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load suppliers.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;
  const upcomingOf = (s) => state.upcoming.filter((p) => p.supplierId === s.id).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

  function paidSelect(s) {
    const cur = paidState(s);
    if (!canPay || s.status !== "active") return badge(PAID_STATES[cur], cur === "paid" ? "success" : cur === "partly" ? "warning" : "neutral");
    return html`<select class="select select-compact" data-role="paid" data-id="${s.id}" aria-label="Paid? ${s.name}">${Object.entries(PAID_STATES).map(([k, l]) => html`<option value="${k}" ${k === cur ? "selected" : ""}>${l}</option>`)}</select>`;
  }

  function scheduledSelect(s) {
    const list = upcomingOf(s);
    const t = today();
    const canAdd = canSchedule && s.status === "active";
    if (!list.length && !canAdd) return "—";
    const head = list.length ? `${formatDayId(list[0].dueDate)} · ${money(list[0].amount)}${list.length > 1 ? ` (+${list.length - 1})` : ""}${list[0].dueDate < t ? " · overdue" : ""}` : "None scheduled";
    return html`<select class="select select-compact" data-role="scheduled" data-id="${s.id}" aria-label="Scheduled payments for ${s.name}">
      <option value="" selected>${head}</option>
      ${list.map((p) => html`<option value="${p.id}">${formatDayId(p.dueDate)} · ${p.description} · ${money(p.amount)}${p.dueDate < t ? " (overdue)" : ""}</option>`)}
      ${canAdd ? html`<option value="new">+ Schedule a payment…</option>` : ""}
    </select>`;
  }

  function draw() {
    if (!alive) return;
    const f = state.filters;
    render(
      container,
      html`
        ${pageHeader({ title: "Wedding Suppliers", subtitle: "Your venue, caterer, photographer and other suppliers: what you agreed, what you've paid, what's scheduled and what's left.", actions: html`${seesPayments ? html`<a class="btn btn-ghost" href="/supplier-payments" data-link>Payment history</a>` : ""}${canManage ? html`<button type="button" class="btn btn-primary" data-act="new">Add supplier</button>` : ""}` })}
        ${filterBar({
          fields: [
            { name: "search", label: "Name starts with…", type: "search", primary: true, value: f.search },
            { name: "service", label: "Service", type: "select", primary: true, options: SERVICE_OPTIONS.map((s) => [s.value, s.label]), value: f.service, all: "Any service" },
            { name: "status", label: "Status", type: "select", primary: false, options: Object.entries(SUPPLIER_STATUSES).map(([k, s]) => [k, s.label]), value: f.status || "active", def: "active" },
          ],
          end: mayExport(session, "weddingSuppliers") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("weddingSuppliers")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "provider", title: f.status === "active" ? "No suppliers yet" : "No inactive suppliers", body: "Add your suppliers and their agreed amounts to track balances and payments." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="suppliers">
                    <thead><tr><th class="m-only"></th><th>Supplier</th><th class="num">Agreed</th><th class="num">Paid</th><th class="num">Balance</th><th>Paid?</th>${seesPayments ? html`<th>Scheduled</th>` : ""}<th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (s) => html`<tr data-supplier="${s.id}" data-open>${mobileCell({ title: s.name, sub: `${serviceLabel(s.service)} · ${money(s.paid ?? 0)} paid`, end: money(supplierBalance(s)), endSub: "balance" })}
                        <td><span class="cell-strong">${s.name}</span>${s.status === "active" ? "" : html` ${badge(SUPPLIER_STATUSES[s.status]?.label ?? s.status, "neutral")}`}<div class="cell-sub">${serviceLabel(s.service)}</div></td>
                        <td class="num">${money(s.agreedAmount)}</td><td class="num">${money(s.paid ?? 0)}</td><td class="num">${money(supplierBalance(s))}</td>
                        <td data-m="ctl">${paidSelect(s)}</td>
                        ${seesPayments ? html`<td data-m="ctl">${scheduledSelect(s)}</td>` : ""}
                        <td class="row-actions" data-m="more">${openButton(s.id, "View details", { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>`}
        </section>`
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
        return data.expensesApi({ action: "create", expense: { date: v.date, category: v.category, amount, supplierId: s.id, method: v.method, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) } });
      },
    });
  }

  const onChange = async (event) => {
    const el = event.target;
    const s = state.rows.find((r) => r.id === el.dataset?.id);
    if (!s || !container.contains(el)) return;
    try {
      if (el.dataset.role === "paid") {
        const cur = paidState(s);
        const want = el.value;
        el.value = cur; // the row repaints from the server after a save
        if (want === cur && want !== "partly") return;
        if (want === "unpaid") {
          toast("Recorded payments aren't undone here. If one was a mistake, remove it under Wedding Expenses.", "danger");
          return;
        }
        const r = await recordPayment(s, want === "paid");
        if (r) {
          toast("Payment recorded.", "success");
          load();
        }
      } else if (el.dataset.role === "scheduled") {
        const want = el.value;
        el.value = "";
        if (want === "new") await pay.after("Payment scheduled.")(await pay.newDialog(s));
        else if (want) {
          const p = state.upcoming.find((x) => x.id === want);
          if (p) pay.openView(p);
        }
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    try {
      switch (el.dataset.act) {
        case "new": {
          const r = await formDialog({ title: "Add supplier", fields: supplierFields({}, state.categories), onSubmit: (v) => data.suppliersApi({ action: "create", supplier: toSupplierInput(v) }) });
          if (r) {
            toast("Supplier added.", "success");
            load();
          }
          return;
        }
        case "view": {
          const s = state.rows.find((r) => r.id === el.dataset.id);
          if (s) openView(s);
          return;
        }
        case "next":
          state.cursors.push(state.rows.at(-1));
          load();
          return;
        case "prev":
          state.cursors.pop();
          load();
          return;
        default:
          return;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const el = event.target.elements;
    state.filters = Object.fromEntries([["status", el.status.value], ["service", el.service.value], ["search", el.search.value.trim()]].filter(([, v]) => v));
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindMenus = bindRowMenus(container);
  const unbindExport = bindExport(container, () => ({ ...state.filters }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    unbindFilters();
    unbindRows();
    unbindMenus();
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
  };
}
