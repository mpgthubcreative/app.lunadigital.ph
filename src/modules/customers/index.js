// Customers (Phase 9, Distributor): one customer per compact row.
//   Customer | Company | Phone | Orders | Total ordered | Balance | Last order | Status | View details
// View details holds contact info, the customer's order history and the
// activity log; Edit -> Save changes contact details; "⋯ More" holds
// Deactivate / Reactivate and Delete (never-ordered customers only).
// Order statistics come from the server; nothing here computes them.

import { html, render } from "../../lib/html.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { pageHeader, emptyState, badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { CUSTOMER_STATUSES, PAYMENT_STATUSES, FULFILLMENT_STATUSES } from "@shared/index.js";
import * as defaultData from "./data.js";
import { when } from "../orders/view.js";

const STATUS_TONE = { active: "success", inactive: "neutral" };

export function customerRow(c, { currency = "PHP", timezone } = {}) {
  const s = c.stats || {};
  return {
    id: c.id,
    name: c.name,
    company: c.company || "—",
    phone: c.phone || "—",
    orders: String(s.orderCount ?? 0),
    totalOrdered: formatCentavos(s.totalOrdered ?? 0, currency),
    balance: formatCentavos(s.outstandingBalance ?? 0, currency),
    hasBalance: (s.outstandingBalance ?? 0) > 0,
    lastOrder: s.lastOrderAt ? `${s.lastOrderNumber ?? ""} · ${when(s.lastOrderAt, timezone)}` : "—",
    status: c.status,
  };
}

// Plain-language activity: "Oct 8 1:22 PM • Carlo • Phone changed A → B".
export function customerActivity(c, { timezone } = {}) {
  const text = (h) => h.label || (h.type === "created" ? "Customer added" : h.type);
  return (c.history || []).map((h) => [when(h.at, timezone), h.actor?.name ?? "", text(h)].filter(Boolean).join(" • "));
}

const FIELDS = (c = {}) => [
  { name: "name", label: "Customer name *", value: c.name ?? "", required: true },
  { name: "company", label: "Company / store", value: c.company ?? "" },
  { name: "phone", label: "Phone", value: c.phone ?? "", inputmode: "tel" },
  { name: "email", label: "Email", value: c.email ?? "", inputmode: "email" },
  { name: "address", label: "Address", type: "textarea", value: c.address ?? "" },
  { name: "notes", label: "Notes", type: "textarea", value: c.notes ?? "" },
];

const duplicateHint = (r) => (r && r.possibleDuplicate ? ` (same phone as ${r.possibleDuplicate.name}: check it isn't a duplicate)` : "");

export function newCustomerDialog({ api }) {
  return formDialog({
    title: "New customer",
    fields: FIELDS(),
    submitLabel: "Save",
    onSubmit: (v) => api("customers", { method: "POST", body: { action: "create", customer: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "")) } }),
  });
}

export function editCustomerDialog({ customer, api }) {
  return formDialog({
    title: `Edit ${customer.name}`,
    fields: FIELDS(customer),
    submitLabel: "Save",
    onSubmit: async (v) => {
      // Only what changed is sent; "" clears an optional field.
      const changes = {};
      for (const [k, val] of Object.entries(v)) if ((customer[k] ?? "") !== val) changes[k] = val === "" ? null : val;
      if (!Object.keys(changes).length) return { unchanged: true };
      return api("customers", { method: "POST", body: { action: "update", customerId: customer.id, expectedRevision: customer.revision, changes } });
    },
  });
}

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast, exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["customers.manage"] === true;
  const canSeeOrders = perms["orders.view"] === true && session.entitlements?.modules?.orders === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const state = { status: "active", search: "", cursors: [], rows: [], hasMore: false, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      const page = await data.listCustomers(businessId, { status: state.status, search: state.search, cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("customers: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load customers.";
    }
    state.loading = false;
    if (alive) draw();
  }

  function draw() {
    if (!alive) return;
    const rows = state.rows.map((c) => customerRow(c, { currency, timezone }));
    render(
      container,
      html`
        ${pageHeader({ title: "Customers", subtitle: "Stores and buyers you sell to, with their orders and balances.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">New customer</button>` : "" })}
        <form class="section card filters filters-inline" data-role="filters">
          <input class="input" name="search" placeholder="Search by name" value="${state.search}" autocomplete="off" aria-label="Search customers" />
          <select class="select" name="status" aria-label="Status">
            ${Object.entries(CUSTOMER_STATUSES).map(([k, v]) => html`<option value="${k}" ${state.status === k ? "selected" : ""}>${v.label}</option>`)}
          </select>
          <button type="submit" class="btn">Apply</button>
          ${mayExport(session, "customers") ? html`${exportButton("customers")}<span class="stat-hint" data-role="export-hint">${exportHint}</span>` : ""}
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !rows.length
                ? emptyState({ iconName: "customers", title: state.search ? "No match" : "No customers yet", body: state.search ? "Try another name." : "Add the stores and buyers you sell to." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="customers">
                    <thead><tr><th>Customer</th><th class="col-secondary">Company</th><th class="col-secondary">Phone</th><th class="num">Orders</th><th class="num col-secondary">Total ordered</th><th class="num">Balance</th><th class="col-secondary">Last order</th><th>Status</th><th></th></tr></thead>
                    <tbody>${rows.map(
                      (r) => html`<tr data-customer="${r.id}">
                        <td>${r.name}</td><td class="col-secondary">${r.company}</td><td class="col-secondary">${r.phone}</td>
                        <td class="num">${r.orders}</td><td class="num col-secondary">${r.totalOrdered}</td>
                        <td class="num" data-col="balance">${r.hasBalance ? html`<strong>${r.balance}</strong>` : r.balance}</td>
                        <td class="col-secondary">${r.lastOrder}</td>
                        <td>${badge(CUSTOMER_STATUSES[r.status]?.label ?? r.status, STATUS_TONE[r.status] || "neutral")}</td>
                        <td class="row-actions"><button type="button" class="btn btn-compact" data-act="view" data-id="${r.id}">View details</button></td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>`
    );
  }

  const done = (message) => (result) => {
    if (!result) return false;
    if (!result.unchanged) toast(message + duplicateHint(result), result.possibleDuplicate ? "warning" : "success");
    load();
    return true;
  };

  async function openView(c) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const view = { orders: null, ordersError: false };
    const s = c.stats || {};
    const paint = () =>
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${c.name}" data-role="customer-view">
          <div class="modal-header"><h2 class="card-title">${c.name}${c.company ? html` · <span class="stat-hint">${c.company}</span>` : ""}</h2></div>
          <div class="modal-body">
            <dl class="dl dl-compact">
              <dt>Phone</dt><dd>${c.phone || "—"}</dd><dt>Email</dt><dd>${c.email || "—"}</dd>
              <dt>Address</dt><dd>${c.address || "—"}</dd>${c.notes ? html`<dt>Notes</dt><dd>${c.notes}</dd>` : ""}
              <dt>Status</dt><dd>${CUSTOMER_STATUSES[c.status]?.label ?? c.status}</dd>
            </dl>
            <dl class="dl dl-compact" data-role="customer-stats">
              <dt>Orders</dt><dd>${s.orderCount ?? 0}</dd>
              <dt>Total ordered</dt><dd>${formatCentavos(s.totalOrdered ?? 0, currency)}</dd>
              <dt>Outstanding balance</dt><dd>${formatCentavos(s.outstandingBalance ?? 0, currency)}</dd>
            </dl>
            ${canSeeOrders
              ? html`<h3 class="section-title">Orders</h3>
                  <div data-role="customer-orders">${view.ordersError
                    ? html`<p class="form-error">Couldn't load orders.</p>`
                    : view.orders === null
                      ? html`<p class="stat-hint">Loading…</p>`
                      : !view.orders.length
                        ? html`<p class="stat-hint">No orders linked to this customer yet.</p>`
                        : html`<div class="table-wrap"><table class="table table-compact">
                            <thead><tr><th>Order #</th><th>Date</th><th class="num">Total</th><th class="num">Balance</th><th>Payment</th><th>Fulfillment</th></tr></thead>
                            <tbody>${view.orders.map(
                              (o) => html`<tr data-order="${o.id}"><td>${o.orderNumber}</td><td>${when(o.createdAt, timezone)}</td>
                                <td class="num">${formatCentavos(o.total, currency)}</td><td class="num">${formatCentavos(o.balance ?? 0, currency)}</td>
                                <td>${PAYMENT_STATUSES[o.paymentStatus]?.label ?? o.paymentStatus}</td><td>${FULFILLMENT_STATUSES[o.fulfillmentStatus]?.label ?? o.fulfillmentStatus}</td></tr>`
                            )}</tbody></table></div>`}</div>`
              : ""}
            <h3 class="section-title">Activity</h3>
            <ul class="list activity" data-role="customer-activity">${customerActivity(c, { timezone }).map((line) => html`<li>${line}</li>`)}</ul>
          </div>
          <div class="modal-footer">
            ${canManage
              ? html`<div class="menu-wrap"><button type="button" class="btn" data-act="more">⋯ More</button><div class="menu" data-role="more-menu" hidden>
                  <button type="button" class="menu-item" data-act="status">${c.status === "active" ? "Deactivate customer" : "Reactivate customer"}</button>
                  ${(s.orderCount ?? 0) === 0 ? html`<button type="button" class="menu-item menu-danger" data-act="delete">Delete customer</button>` : ""}
                </div></div>
                <button type="button" class="btn" data-act="edit">Edit</button>`
              : ""}
            <button type="button" class="btn" data-act="close">Close</button>
          </div>
        </div>`
      );
    paint();
    if (canSeeOrders) {
      data
        .listCustomerOrders(businessId, c.id)
        .then((rows) => (view.orders = rows))
        .catch((err) => {
          console.error("customers: orders failed:", err && err.code);
          view.ordersError = true;
        })
        .then(() => backdrop.isConnected && paint());
    }
    backdrop.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (e.target === backdrop || act === "close") return close();
      if (act === "more") {
        const menu = backdrop.querySelector('[data-role="more-menu"]');
        menu.hidden = !menu.hidden;
        return undefined;
      }
      try {
        if (act === "edit" && done("Customer updated")(await editCustomerDialog({ customer: c, api }))) close();
        if (act === "status") {
          const next = c.status === "active" ? "inactive" : "active";
          const ok = await confirmDialog({
            title: next === "inactive" ? `Deactivate ${c.name}?` : `Reactivate ${c.name}?`,
            body: next === "inactive" ? "They keep their orders and balance but can't be picked for new orders." : "They can be picked for new orders again.",
            confirmLabel: next === "inactive" ? "Deactivate" : "Reactivate",
          });
          if (ok && done(next === "inactive" ? "Customer deactivated" : "Customer reactivated")(await api("customers", { method: "POST", body: { action: "setStatus", customerId: c.id, status: next } }))) close();
        }
        if (act === "delete") {
          const ok = await confirmDialog({ title: `Delete ${c.name}?`, body: "Only for a customer added by mistake. This can't be undone.", confirmLabel: "Delete", danger: true });
          if (ok && done("Customer deleted")(await api("customers", { method: "POST", body: { action: "delete", customerId: c.id } }))) close();
        }
      } catch (err) {
        toast(err.message, "danger");
      }
      return undefined;
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    switch (el.dataset.act) {
      case "new":
        return done("Customer added")(await newCustomerDialog({ api }));
      case "view":
        return openView(state.rows.find((r) => r.id === el.dataset.id));
      case "next":
        state.cursors.push(state.rows.at(-1));
        return load();
      case "prev":
        state.cursors.pop();
        return load();
      default:
        return undefined;
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    state.search = event.target.elements.search.value;
    state.status = event.target.elements.status.value;
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, () => Object.fromEntries([["status", state.status], ["search", state.search.trim()]].filter(([, v]) => v)), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
