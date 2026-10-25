// Customers (Phase 9, Distributor; back in Business 2026-10-20). Its job:
// save a recurring buyer once, so their next orders don't need retyping.
// Not a CRM.
//   Row      Customer | Contact | Delivery address | Orders | [Add order] ⋯
//            (⋯ = View, Edit)
//   Details  Contact, Delivery address, [Add order] [View orders]; then
//            total orders, total purchased, outstanding balance, last order
//            and the 5 most recent orders (View orders shows them all).
//   Form     Name * , Contact, Delivery address (nothing else asked; older
//            records keep any company / email / notes they had).
// Who owes us (2026-10-25): a second view (Customers | Who owes us):
//   TOTAL UNPAID ₱X, then Customer | Balance | Oldest unpaid | View; View
//   shows what makes up the balance (unpaid orders, an opening balance).
// Add order opens the order form with the customer linked and their name,
// contact and delivery address filled in. The order keeps its own copy, so
// editing the customer later never rewrites past orders. Order statistics
// come from the server; nothing here computes them.

import { html, render } from "../../lib/html.js";
import { bindExport } from "../../lib/export.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, rowMenu, bindRowOpen, skeleton, segmented, mobileCell } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { CUSTOMER_STATUSES, PAYMENT_STATUSES, FULFILLMENT_STATUSES, PAYMENT_METHODS, canUseModule, businessDate, parseCentavos } from "@shared/index.js";
import { receivableRows, daysBetween } from "./receivables.js";
import * as defaultData from "./data.js";
import { when } from "../orders/view.js";
import { openOrderEditor } from "../orders/editor.js";
import { getProducts as defaultGetProducts } from "../orders/data.js";
import { listActiveProducts as defaultListActiveProducts } from "../dashboard/checkout.js";

const STATUS_TONE = { active: "success", inactive: "neutral" };
// One request key per payment dialog (a retry records it once).
const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

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

// What an empty buyers page shows (examples only: never saved, never in receivables).
export const CUSTOMER_EXAMPLES = Object.freeze([
  { name: "Maria's Mini Mart", sub: "0917 123 4567 · Quezon City", end: "Owes ₱950" },
  { name: "ABC Restaurant", sub: "0928 555 0198 · Makati", end: "No balance" },
  { name: "Juan Store", sub: "0939 222 0147 · Pasig", end: "Owes ₱1,850" },
]);

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
  const fromUrl = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const state = { view: fromUrl.get("view") === "owed" ? "owed" : "all", status: "active", search: "", cursors: [], rows: [], hasMore: false, loading: true, error: null, owed: null };
  let alive = true;
  const today = () => businessDate(timezone || "Asia/Manila");

  // Who owes us: customers with a balance, their unpaid orders and opening balances.
  async function loadOwed() {
    state.loading = true;
    draw();
    try {
      const [customers, orders, openings] = await Promise.all([
        data.listCustomersWithBalance(businessId),
        canSeeOrders ? data.listUnpaidOrders(businessId) : [],
        data.listOpenOpeningBalances ? data.listOpenOpeningBalances(businessId).catch(() => []) : [],
      ]);
      state.owed = receivableRows(customers, { orders, openings, today: today() });
      state.error = null;
    } catch (err) {
      console.error("customers: balances failed:", err && (err.code || err.message));
      state.error = "Couldn't load balances.";
    }
    state.loading = false;
    if (alive) draw();
  }

  const unfiltered = () => !state.search && state.status === "active" && !state.cursors.length;
  async function load() {
    if (state.view === "owed") return loadOwed();
    state.loading = true;
    draw();
    try {
      const page = await data.listCustomers(businessId, { status: state.status, search: state.search, cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      // No active buyers and no search: examples, unless inactive ones exist.
      state.others = page.rows.length || !unfiltered() ? null : await data.listCustomers(businessId, { status: "inactive", pageSize: 1 }).then((p) => p.rows.length > 0, () => true);
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

  const oldestText = (r) => (r.oldestDays === null ? "—" : r.oldestDays === 0 ? "Today" : `${r.oldestDays} ${r.oldestDays === 1 ? "day" : "days"}`);
  function owedView() {
    const o = state.owed || { rows: [], total: 0 };
    return html`<section class="card rv-total" data-role="total-unpaid"><span class="kpi-label">Total unpaid</span><b class="kpi-value" data-role="total-unpaid-amount">${formatCentavos(o.total, currency)}</b><span class="stat-hint">${o.rows.length} ${o.rows.length === 1 ? singular : plural.toLowerCase()} with a balance</span></section>
      <section class="card">
        ${!o.rows.length
          ? emptyState({ iconName: "customers", title: "Nobody owes you", body: `When a saved ${singular} has an unpaid or partly paid order, they appear here.` })
          : html`<div class="table-wrap"><table class="table table-compact rows" data-role="receivables">
              <thead><tr><th class="m-only"></th><th>${plural.replace(/s$/, "")}</th><th class="num">Balance</th><th>Oldest unpaid</th><th><span class="visually-hidden">View</span></th></tr></thead>
              <tbody>${o.rows.map(
                (r) => html`<tr data-receivable="${r.id}">
                  ${mobileCell({ title: r.name, sub: `Oldest unpaid: ${oldestText(r)}`, end: formatCentavos(r.balance, currency) })}
                  <td class="cell-strong">${r.name}</td>
                  <td class="num" data-col="balance"><strong>${formatCentavos(r.balance, currency)}</strong></td>
                  <td data-col="oldest">${oldestText(r)}</td>
                  <td class="row-actions" data-m="more"><button type="button" class="btn btn-compact" data-act="view-owed" data-id="${r.id}">View</button></td>
                </tr>`
              )}</tbody></table></div>`}
      </section>
      <p class="stat-hint page-foot" data-role="walkin-note">Saved ${plural.toLowerCase()} only. Unpaid walk-in orders are in Orders (Payment: Unpaid).</p>`;
  }

  function draw() {
    if (!alive) return;
    const rows = state.rows.map((c) => customerRow(c, { timezone }));
    const views = html`<div class="wl-tools">${segmented("view", [["all", plural], ["owed", "Who owes us"]], state.view, { label: `${plural} view` })}</div>`;
    if (state.view === "owed") {
      render(container, html`${pageHeader({ title: plural, subtitle: "Who owes you, how much, and since when." })}${views}${state.error ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>` : state.loading ? html`<section class="card">${skeleton(5)}</section>` : owedView()}`);
      return;
    }
    render(
      container,
      html`
        ${pageHeader({ title: plural, subtitle: "Save a buyer once; their next orders fill in by themselves.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ New ${singular}</button>` : "" })}
        ${views}
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
                ? !unfiltered() || state.others !== false
                  ? emptyState({ iconName: "customers", title: state.search ? "No match" : `No ${plural.toLowerCase()} yet`, body: state.search ? "Try another name." : "Save the buyers who order again, so you don't retype their details." })
                  : examplesState({ title: `No ${plural.toLowerCase()} yet`, body: "Each buyer, with what they still owe:", items: CUSTOMER_EXAMPLES, helper: canManage ? `Tap + New ${singular} to save your first one, so you don't retype their details.` : "Buyers saved by your team appear here.", role: "customer-examples", wrap: true })
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

  // owed: what makes up the balance ([{ kind, label, day, due }]), from Who owes us.
  async function openView(c, { owed = null } = {}) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const view = { orders: null, ordersError: false, all: false, prices: null };
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
            ${(canOrder && c.status === "active") || canSeeOrders ? html`<div class="page-actions">${canOrder && c.status === "active" ? html`<button type="button" class="btn btn-primary" data-act="add-order">Add order</button>` : ""}${canSeeOrders && (s.orderCount ?? 0) > 5 && !view.all ? html`<button type="button" class="btn" data-act="all-orders">View orders</button>` : ""}</div>` : ""}
            ${owed
              ? html`<h3 class="section-title">What makes up the ${formatCentavos(Math.max(0, s.outstandingBalance ?? 0), currency)}</h3>
                  ${owed.length
                    ? html`<ul class="cp-orders" data-role="balance-items">${owed.map((i) => html`<li class="cp-order" data-item="${i.kind}:${i.id}"><span class="cp-num">${i.label}</span><b class="cp-total">${formatCentavos(i.due, currency)} due</b><span class="cp-sub">${[i.day ? `${daysBetween(i.day, today())} days ago` : "", i.kind === "order" ? `${formatCentavos(i.paid, currency)} paid of ${formatCentavos(i.total, currency)}` : i.note || "Owed before Luna"].filter(Boolean).join(" · ")}</span>${i.kind === "opening" && canManage ? html`<span class="cp-due"><button type="button" class="btn btn-compact" data-act="ob-pay" data-id="${i.id}">Record payment</button></span>` : ""}</li>`)}</ul>`
                    : html`<p class="stat-hint">${canSeeOrders ? "No unpaid items found." : "Ask the Owner for access to orders to see which ones are unpaid."}</p>`}`
              : ""}
            <dl class="dl dl-compact" data-role="customer-stats">
              <dt>Total orders</dt><dd data-role="order-count">${s.orderCount ?? 0}</dd>
              <dt>Total purchased</dt><dd data-role="total-purchased">${formatCentavos(s.totalOrdered ?? 0, currency)}</dd>
              <dt>Outstanding balance</dt><dd data-role="outstanding">${formatCentavos(Math.max(0, s.outstandingBalance ?? 0), currency)}</dd>
              <dt>Last order</dt><dd>${s.lastOrderAt ? `${s.lastOrderNumber ?? ""} · ${when(s.lastOrderAt, timezone)}` : "—"}</dd>
            </dl>
            ${canSeeOrders
              ? html`<h3 class="section-title">${view.all ? "Orders" : "Recent orders"}</h3>
                  <div data-role="customer-orders">${view.ordersError
                    ? html`<p class="form-error">Couldn't load orders.</p>`
                    : view.orders === null
                      ? html`<p class="stat-hint">Loading…</p>`
                      : !view.orders.length
                        ? html`<p class="stat-hint">No orders for this customer yet.</p>`
                        : html`<ul class="cp-orders">${view.orders.slice(0, view.all ? view.orders.length : 5).map((o) => {
                            // One compact row: number · total, then date · payment · fulfilment · what's still due.
                            const due = o.fulfillmentStatus === "cancelled" ? 0 : Math.max(0, o.balance ?? o.total - (o.amountPaid || 0));
                            return html`<li class="cp-order" data-order="${o.id}"><span class="cp-num">${o.orderNumber}</span><b class="cp-total">${formatCentavos(o.total, currency)}</b>
                              <span class="cp-sub">${[(when(o.createdAt, timezone) || "").replace(/,? \d{1,2}:\d{2}.*$/, ""), PAYMENT_STATUSES[o.paymentStatus]?.label ?? o.paymentStatus, FULFILLMENT_STATUSES[o.fulfillmentStatus]?.label ?? o.fulfillmentStatus].filter(Boolean).join(" · ")}</span>
                              <span class="cp-due" data-role="balance">${due ? `${formatCentavos(due, currency)} due` : ""}</span></li>`;
                          })}</ul>`}</div>`
              : ""}
            <h3 class="section-title">Special prices</h3>
            <div data-role="special-prices">${view.prices === null
              ? html`<p class="stat-hint">Loading…</p>`
              : html`${view.prices.length
                  ? html`<ul class="cp-orders">${view.prices.map((p) => html`<li class="cp-order" data-price="${p.productId}"><span class="cp-num">${p.productName}</span><b class="cp-total">${formatCentavos(p.price, currency)}</b><span class="cp-sub">${p.sku || ""}</span>${canManage ? html`<span class="cp-due"><button type="button" class="btn btn-compact btn-ghost" data-act="price-edit" data-product="${p.productId}">Change</button><button type="button" class="btn btn-compact btn-ghost" data-act="price-clear" data-product="${p.productId}">Remove</button></span>` : ""}</li>`)}</ul>`
                  : html`<p class="stat-hint">None. Their orders use each product's normal price.</p>`}
                ${canManage ? html`<button type="button" class="btn btn-compact" data-act="price-add">+ Special price</button>` : ""}`}</div>
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
    const loadPrices = () =>
      (data.listCustomerPrices ? data.listCustomerPrices(businessId, c.id) : Promise.resolve([]))
        .then((rows) => (view.prices = [...rows].sort((a, b) => (a.productName || "").localeCompare(b.productName || ""))))
        .catch(() => (view.prices = []))
        .then(() => backdrop.isConnected && paint());
    loadPrices();
    // + Special price / Change: one product and its price for this customer.
    const priceDialog = async (current = null) => {
      const products = current ? [] : await editorDeps.listActiveProducts().catch(() => []);
      const taken = new Set((view.prices || []).map((p) => p.productId));
      const choices = products.filter((p) => p.status === "active" && !taken.has(p.id));
      if (!current && !choices.length) {
        toast("Every active product already has a special price for this customer, or there are no products yet.", "warning");
        return null;
      }
      return formDialog({
        title: current ? `${current.productName}: special price` : `Special price for ${c.name}`,
        intro: "Used on this customer's new orders. Orders already made keep their prices.",
        fields: [
          ...(current ? [] : [{ name: "productId", label: "Product", type: "select", options: choices.map((p) => ({ value: p.id, label: `${p.name} · normal ${formatCentavos(p.sellingPrice, currency)}` })), value: choices[0].id, required: true }]),
          { name: "price", label: `Special price (${currency})`, value: current ? (current.price / 100).toFixed(2) : "", inputmode: "decimal", required: true },
        ],
        submitLabel: "Save",
        onSubmit: (v) => {
          const price = parseCentavos(v.price);
          if (!(price > 0)) throw new Error("Enter the special price (more than ₱0)");
          return api("customers", { method: "POST", body: { action: "setPrice", customerId: c.id, productId: current ? current.productId : v.productId, price } });
        },
      });
    };
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
      if (act === "ob-pay") {
        const item = (owed || []).find((x) => x.kind === "opening" && x.id === e.target.closest("[data-id]").dataset.id);
        if (!item) return undefined;
        const idempotencyKey = newKey();
        try {
          const r = await formDialog({
            title: `${c.name}: payment on the opening balance`,
            intro: `${formatCentavos(item.due, currency)} still owed from before Luna.`,
            fields: [
              { name: "amount", label: `Amount (${currency})`, value: (item.due / 100).toFixed(2), inputmode: "decimal", required: true },
              { name: "method", label: "Method", type: "select", options: Object.entries(PAYMENT_METHODS).map(([value, m]) => ({ value, label: m.label })), value: "cash" },
              { name: "reference", label: "Reference no.", more: true },
            ],
            moreLabel: "More details",
            submitLabel: "Save",
            onSubmit: (v) => {
              const amount = parseCentavos(v.amount);
              if (!(amount > 0)) throw new Error("Enter an amount");
              if (amount > item.due) throw new Error(`That's more than what's left (${formatCentavos(item.due, currency)})`);
              return api("customers", { method: "POST", body: { action: "payOpening", idempotencyKey, openingBalanceId: item.id, amount, method: v.method, ...(v.reference ? { reference: v.reference } : {}) } });
            },
          });
          if (r) {
            toast("Payment recorded", "success");
            close();
            load();
          }
        } catch (err) {
          toast(err.message, "danger");
        }
        return undefined;
      }
      if (act === "price-add" || act === "price-edit") {
        try {
          const r = await priceDialog(act === "price-edit" ? view.prices.find((p) => p.productId === e.target.closest("[data-product]").dataset.product) : null);
          if (r) {
            toast("Special price saved", "success");
            loadPrices();
          }
        } catch (err) {
          toast(err.message, "danger");
        }
        return undefined;
      }
      if (act === "price-clear") {
        const p = view.prices.find((x) => x.productId === e.target.closest("[data-product]").dataset.product);
        if (!p || !(await confirmDialog({ title: `Remove ${c.name}'s special price for ${p.productName}?`, body: "Their next orders use the product's normal price. Orders already made keep their prices.", confirmLabel: "Remove" }))) return undefined;
        try {
          await api("customers", { method: "POST", body: { action: "clearPrice", customerId: c.id, productId: p.productId } });
          toast("Special price removed", "success");
          loadPrices();
        } catch (err) {
          toast(err.message, "danger");
        }
        return undefined;
      }
      if (act === "all-orders") {
        view.all = true;
        paint();
        backdrop.querySelector('[data-role="customer-orders"]')?.scrollIntoView?.({ block: "start" });
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
      case "view-owed": {
        const r = state.owed?.rows.find((x) => x.id === el.dataset.id);
        return r ? openView(r.customer, { owed: r.items }) : undefined;
      }
      case "seg":
        state.view = el.dataset.value === "owed" ? "owed" : "all";
        return load();
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
