// Customers (Phase 9, Distributor; back in Business 2026-10-20). Its job:
// save a recurring buyer once, so their next orders don't need retyping.
// Not a CRM.
//   Row      Customer | Contact | Delivery address | Orders | [Add order] ⋯
//            (⋯ = View, Edit)
//   Details  Contact, Delivery address, [Add order]; then total orders, last
//            order and the order history.
//   Form     Name * , Contact, Delivery address (nothing else asked; older
//            records keep any company / email / notes they had).
// Add order opens the order form with the customer linked and their name,
// contact and delivery address filled in. The order keeps its own copy, so
// editing the customer later never rewrites past orders. Order statistics
// come from the server; nothing here computes them.

import { html, render } from "../../lib/html.js";
import { bindExport } from "../../lib/export.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, rowMenu, bindRowOpen, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { CUSTOMER_STATUSES, PAYMENT_STATUSES, FULFILLMENT_STATUSES, canUseModule } from "@shared/index.js";
import * as defaultData from "./data.js";
import { when } from "../orders/view.js";
import { openOrderEditor } from "../orders/editor.js";
import { getProducts as defaultGetProducts } from "../orders/data.js";
import { listActiveProducts as defaultListActiveProducts } from "../dashboard/checkout.js";

const STATUS_TONE = { active: "success", inactive: "neutral" };

export function customerRow(c, { timezone } = {}) {
  const s = c.stats || {};
  return {
    id: c.id,
    name: c.name,
    contact: c.phone || "",
    address: c.address || "",
    orders: s.orderCount ?? 0,
    lastOrder: s.lastOrderAt ? `${s.lastOrderNumber ?? ""} · ${when(s.lastOrderAt, timezone)}` : "",
    status: c.status,
  };
}

// Plain-language activity: "Oct 8 1:22 PM • Carlo • Phone changed A → B".
export function customerActivity(c, { timezone } = {}) {
  const text = (h) => h.label || (h.type === "created" ? "Customer added" : h.type);
  return (c.history || []).map((h) => [when(h.at, timezone), h.actor?.name ?? "", text(h)].filter(Boolean).join(" • "));
}

const FIELDS = (c = {}) => [
  { name: "name", label: "Name *", value: c.name ?? "", required: true },
  { name: "phone", label: "Contact", value: c.phone ?? "", inputmode: "tel", placeholder: "e.g. 0917 123 4567" },
  { name: "address", label: "Delivery address", type: "textarea", value: c.address ?? "" },
];

const duplicateHint = (r) => (r && r.possibleDuplicate ? ` (same contact number as ${r.possibleDuplicate.name}: check it isn't a duplicate)` : "");

export function newCustomerDialog({ api }) {
  return formDialog({
    title: "New customer",
    intro: "Saved once, filled in on their next orders.",
    fields: FIELDS(),
    submitLabel: "Save",
    onSubmit: (v) => api("customers", { method: "POST", body: { action: "create", customer: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "")) } }),
  });
}

export function editCustomerDialog({ customer, api }) {
  return formDialog({
    title: `Edit ${customer.name}`,
    intro: "Changes apply to new orders. Past orders keep the details they were made with.",
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

// The order form for this customer: linked, with their saved details filled in.
export function addOrderFor(customer, { session, deps }) {
  return openOrderEditor({ session, deps, prefill: { customerId: customer.id, customer: { name: customer.name, phone: customer.phone || "" }, deliveryAddress: customer.address || "" } });
}

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast, exportDeps = {}, orderDeps = null } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["customers.manage"] === true;
  const canSeeOrders = perms["orders.view"] === true && session.entitlements?.modules?.orders === true;
  const canOrder = perms["orders.create"] === true && canUseModule({ entitlements: session.entitlements, permissions: perms }, "orders");
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const plural = session.config?.terminology?.customer?.plural ?? "Customers";
  const singular = (session.config?.terminology?.customer?.singular ?? "customer").toLowerCase();
  const editorDeps = orderDeps ?? { listActiveProducts: () => defaultListActiveProducts(businessId), getProducts: (ids) => defaultGetProducts(businessId, ids), searchCustomers: (term) => data.searchCustomers(businessId, term), api };
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

  const menuFor = (r) => rowMenu(r.id, [{ act: "view", label: "View" }, ...(canManage ? [{ act: "edit", label: "Edit" }] : [])], { label: `More for ${r.name}` });
  const addOrderBtn = (r) => (canOrder && r.status === "active" ? html`<button type="button" class="btn btn-compact btn-primary" data-act="add-order" data-id="${r.id}">Add order</button>` : "");

  function draw() {
    if (!alive) return;
    const rows = state.rows.map((c) => customerRow(c, { timezone }));
    render(
      container,
      html`
        ${pageHeader({ title: plural, subtitle: "Save a buyer once; their next orders fill in by themselves.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ New ${singular}</button>` : "" })}
        ${filterBar({
          fields: [
            { name: "search", label: "Search by name", type: "search", primary: true, value: state.search },
            { name: "status", label: "Status", type: "select", primary: true, def: "active", options: Object.entries(CUSTOMER_STATUSES).map(([k, v]) => [k, v.label]), value: state.status },
          ],
          end: "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(6)
              : !rows.length
                ? emptyState({ iconName: "customers", title: state.search ? "No match" : `No ${plural.toLowerCase()} yet`, body: state.search ? "Try another name." : "Save the buyers who order again, so you don't retype their details." })
                : html`<div class="table-wrap"><table class="table table-compact rows cust-rows" data-role="customers">
                    <thead><tr><th class="m-only"></th><th>Customer</th><th>Contact</th><th>Delivery address</th><th class="num col-secondary">Orders</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>${rows.map(
                      (r) => html`<tr data-customer="${r.id}" data-open>
                        <td class="m-only"><div class="cust-mcell">
                          <span class="cust-name">${r.name}${r.status === "inactive" ? html` ${badge("Inactive", "neutral")}` : ""}</span>
                          ${r.contact ? html`<span class="cust-detail" data-m-col="contact">${r.contact}</span>` : ""}
                          ${r.address ? html`<span class="cust-detail" data-m-col="address">${r.address}</span>` : ""}
                        </div></td>
                        <td class="cell-strong">${r.name}${r.status === "inactive" ? html` ${badge("Inactive", "neutral")}` : ""}</td>
                        <td data-col="contact">${r.contact || html`<span class="stat-hint">—</span>`}</td>
                        <td class="cust-address" data-col="address">${r.address || html`<span class="stat-hint">—</span>`}</td>
                        <td class="num col-secondary">${r.orders}</td>
                        <td class="row-actions cust-actions" data-m="more">${addOrderBtn(r)}${menuFor(r)}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager">
                    <button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button>
                    <button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button>
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

  async function addOrder(c) {
    const result = await addOrderFor(c, { session, deps: editorDeps });
    if (result) {
      toast(`Order ${result.orderNumber} created for ${c.name}`, "success");
      load();
    }
    return result;
  }

  async function openView(c) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const view = { orders: null, ordersError: false };
    const s = c.stats || {};
    const paint = () =>
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${c.name}" data-role="customer-view">
          <div class="modal-header"><h2 class="card-title">${c.name}</h2>${c.status === "inactive" ? badge("Inactive", STATUS_TONE.inactive) : ""}</div>
          <div class="modal-body">
            <dl class="dl dl-compact" data-role="customer-contact">
              <dt>Contact</dt><dd>${c.phone || "—"}</dd>
              <dt>Delivery address</dt><dd>${c.address || "—"}</dd>
            </dl>
            ${canOrder && c.status === "active" ? html`<div class="page-actions"><button type="button" class="btn btn-primary" data-act="add-order">Add order</button></div>` : ""}
            <dl class="dl dl-compact" data-role="customer-stats">
              <dt>Total orders</dt><dd>${s.orderCount ?? 0}</dd>
              <dt>Last order</dt><dd>${s.lastOrderAt ? `${s.lastOrderNumber ?? ""} · ${when(s.lastOrderAt, timezone)}` : "—"}</dd>
            </dl>
            ${canSeeOrders
              ? html`<h3 class="section-title">Order history</h3>
                  <div data-role="customer-orders">${view.ordersError
                    ? html`<p class="form-error">Couldn't load orders.</p>`
                    : view.orders === null
                      ? html`<p class="stat-hint">Loading…</p>`
                      : !view.orders.length
                        ? html`<p class="stat-hint">No orders for this customer yet.</p>`
                        : html`<div class="table-wrap"><table class="table table-compact">
                            <thead><tr><th>Order #</th><th>Date</th><th class="num">Total</th><th>Payment</th><th>Fulfillment</th></tr></thead>
                            <tbody>${view.orders.map(
                              (o) => html`<tr data-order="${o.id}"><td>${o.orderNumber}</td><td>${when(o.createdAt, timezone)}</td>
                                <td class="num">${formatCentavos(o.total, currency)}</td>
                                <td>${PAYMENT_STATUSES[o.paymentStatus]?.label ?? o.paymentStatus}</td><td>${FULFILLMENT_STATUSES[o.fulfillmentStatus]?.label ?? o.fulfillmentStatus}</td></tr>`
                            )}</tbody></table></div>`}</div>`
              : ""}
            <details class="help-details"><summary>Activity</summary><ul class="list activity" data-role="customer-activity">${customerActivity(c, { timezone }).map((line) => html`<li>${line}</li>`)}</ul></details>
          </div>
          <div class="modal-footer">
            ${canManage
              ? html`<div class="menu-wrap"><button type="button" class="btn" data-act="more">⋯ More</button><div class="menu" data-role="more-menu" hidden>
                  <button type="button" class="menu-item" data-act="status">${c.status === "active" ? `Deactivate ${singular}` : `Reactivate ${singular}`}</button>
                  ${(s.orderCount ?? 0) === 0 ? html`<button type="button" class="menu-item menu-danger" data-act="delete">Delete ${singular}</button>` : ""}
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
        if (act === "add-order") {
          close();
          await addOrder(c);
        }
        if (act === "edit" && done("Customer updated")(await editCustomerDialog({ customer: c, api }))) close();
        if (act === "status") {
          const next = c.status === "active" ? "inactive" : "active";
          const ok = await confirmDialog({
            title: next === "inactive" ? `Deactivate ${c.name}?` : `Reactivate ${c.name}?`,
            body: next === "inactive" ? "Their orders stay, but they can't be picked for new orders." : "They can be picked for new orders again.",
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

  const closeMenus = (except = null) => container.querySelectorAll(".menu-wrap[data-menu] > .menu:not([hidden])").forEach((m) => m !== except && (m.hidden = true));
  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) {
      closeMenus();
      return undefined;
    }
    const row = () => state.rows.find((r) => r.id === el.dataset.id);
    switch (el.dataset.act) {
      case "row-menu": {
        const menu = el.parentElement.querySelector(".menu");
        closeMenus(menu);
        menu.hidden = !menu.hidden;
        el.setAttribute("aria-expanded", String(!menu.hidden));
        return undefined;
      }
      case "new":
        return done("Customer added")(await newCustomerDialog({ api }));
      case "add-order":
        closeMenus();
        return addOrder(row());
      case "view":
        closeMenus();
        return openView(row());
      case "edit":
        closeMenus();
        return done("Customer updated")(await editCustomerDialog({ customer: row(), api }));
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
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindExport = bindExport(container, () => Object.fromEntries([["status", state.status], ["search", state.search.trim()]].filter(([, v]) => v)), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    unbindFilters();
    unbindRows();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
