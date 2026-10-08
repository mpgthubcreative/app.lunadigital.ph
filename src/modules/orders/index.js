// Orders: newest-first list with filters, the order detail (items, totals,
// status history, and COGS / profit for dashboard.financials holders), and
// the actions each member's permissions allow:
//   orders.create  New order          orders.update  Edit (pending only)
//   orders.fulfill Fulfill            orders.cancel  Cancel (pending only)
// Every write is POST /api/orders; the server re-checks all of it.

import { html, render } from "../../lib/html.js";
import { pageHeader, card, emptyState, badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { ORDER_SOURCES, ORDER_SOURCE_IDS, FULFILLMENT_STATUSES, PAYMENT_STATUSES, isDayId } from "@shared/index.js";
import * as ordersData from "./data.js";
import { listProducts } from "../inventory/data.js";
import { orderRow, historyRows, qtyText, sourceLabel, fulfillmentLabel, paymentLabel, FULFILLMENT_TONE, PAYMENT_TONE } from "./view.js";
import { openOrderEditor } from "./editor.js";

const defaultDeps = {
  data: ordersData,
  searchProducts: (businessId, term) => listProducts(businessId, { search: term, status: "active" }).then((r) => r.rows),
};

export function mount(container, session, { data = defaultDeps.data, searchProducts = defaultDeps.searchProducts, api = defaultApi, toast = defaultToast } = {}) {
  const perms = session.member.permissions;
  const can = {
    create: perms["orders.create"] === true,
    update: perms["orders.update"] === true,
    fulfill: perms["orders.fulfill"] === true,
    cancel: perms["orders.cancel"] === true,
    financials: perms["dashboard.financials"] === true,
  };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const state = { filters: {}, cursors: [], rows: [], hasMore: false, loading: true, error: null };
  let alive = true;
  const editorDeps = { searchProducts: (term) => searchProducts(businessId, term), getProducts: (ids) => data.getProducts(businessId, ids), api };

  async function load() {
    state.loading = true;
    state.error = null;
    draw();
    try {
      const page = await data.listOrders(businessId, { filters: state.filters, cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
    } catch (err) {
      console.error("orders: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load orders. Check your connection and try again.";
    }
    state.loading = false;
    if (alive) draw();
  }

  const opts = (entries, selected, allLabel) => html`<option value="">${allLabel}</option>${entries.map(([v, l]) => html`<option value="${v}" ${selected === v ? "selected" : ""}>${l}</option>`)}`;

  function draw() {
    if (!alive) return;
    const f = state.filters;
    const rows = state.rows.map((o) => orderRow(o, { currency, timezone }));
    render(
      container,
      html`
        ${pageHeader({ title: "Orders", subtitle: "Orders from Messenger, Facebook, Viber, phone and walk-ins.", actions: can.create ? html`<button type="button" class="btn btn-primary" data-act="new">New order</button>` : "" })}
        <form class="section card filters filters-inline" data-role="filters">
          <select class="select" name="fulfillmentStatus" aria-label="Fulfillment">${opts(Object.entries(FULFILLMENT_STATUSES).map(([k, v]) => [k, v.label]), f.fulfillmentStatus, "Any fulfillment")}</select>
          <select class="select" name="paymentStatus" aria-label="Payment">${opts(Object.entries(PAYMENT_STATUSES).map(([k, v]) => [k, v.label]), f.paymentStatus, "Any payment")}</select>
          <select class="select" name="source" aria-label="Source">${opts(ORDER_SOURCE_IDS.map((k) => [k, ORDER_SOURCES[k].label]), f.source, "Any source")}</select>
          <input class="input" name="day" value="${f.day || ""}" placeholder="Date YYYY-MM-DD" aria-label="Date (YYYY-MM-DD)" autocomplete="off" />
          <button type="submit" class="btn">Apply</button>
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !rows.length
                ? emptyState({ iconName: "orders", title: "No orders", body: can.create ? "Create the first order from a chat or call." : "Orders appear here as your team enters them." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="orders">
                    <thead><tr><th>Order #</th><th>Time</th><th>Customer</th><th class="col-secondary">Items</th><th class="num">Total</th><th class="col-secondary">Reference</th><th class="col-secondary">Proof</th><th>Payment</th><th>Fulfillment</th><th></th></tr></thead>
                    <tbody>${rows.map(
                      (r) => html`<tr data-order="${r.id}">
                        <td>${r.number}</td>
                        <td>${r.when}</td><td>${r.customer}</td><td class="col-secondary">${r.items}</td>
                        <td class="num">${r.total}</td>
                        <td class="col-secondary">${r.reference}</td><td class="col-secondary">${r.proof}</td>
                        <td>${badge(paymentLabel(r.paymentStatus), PAYMENT_TONE[r.paymentStatus] || "neutral")}</td>
                        <td>${badge(fulfillmentLabel(r.fulfillmentStatus), FULFILLMENT_TONE[r.fulfillmentStatus] || "neutral")}</td>
                        <td class="row-actions"><button type="button" class="btn btn-compact" data-act="open" data-id="${r.id}">View details</button></td>
                      </tr>`
                    )}</tbody>
                  </table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>
      `
    );
  }

  async function openDetail(orderId) {
    let order;
    let costs = null;
    try {
      order = await data.getOrder(businessId, orderId);
      if (order && can.financials && order.fulfillmentStatus === "fulfilled") costs = await data.getOrderCosts(businessId, orderId);
    } catch (err) {
      toast("Couldn't load the order.", "danger");
      return;
    }
    if (!order) {
      toast("Order not found.", "danger");
      return;
    }
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const pending = order.fulfillmentStatus === "pending";
    const costByLine = new Map((costs?.lines || []).map((l) => [l.lineId, l.costConsumed]));
    render(
      backdrop,
      html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Order ${order.orderNumber}" data-role="detail">
        <div class="modal-header"><h2 class="card-title">${order.orderNumber}</h2>
          <div class="page-actions">${badge(fulfillmentLabel(order.fulfillmentStatus), FULFILLMENT_TONE[order.fulfillmentStatus] || "neutral")} ${badge(paymentLabel(order.paymentStatus), PAYMENT_TONE[order.paymentStatus] || "neutral")}</div></div>
        <div class="modal-body">
          <dl class="dl">
            <dt>Customer</dt><dd>${order.customer?.name}${order.customer?.phone ? ` · ${order.customer.phone}` : ""}</dd>
            <dt>Source</dt><dd>${sourceLabel(order.source)}${order.sourceNote ? ` · ${order.sourceNote}` : ""}</dd>
            <dt>Created by</dt><dd>${order.createdBy?.name ?? ""}</dd>
            ${order.notes ? html`<dt>Notes</dt><dd>${order.notes}</dd>` : ""}
            ${order.cancellationReason ? html`<dt>Cancelled because</dt><dd>${order.cancellationReason}</dd>` : ""}
          </dl>
          <div class="table-wrap"><table class="table table-compact" data-role="items"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Subtotal</th>${costs ? html`<th class="num">Cost (COGS)</th>` : ""}</tr></thead>
            <tbody>${order.items.map(
              (l) => html`<tr><td>${l.sku} · ${l.name}</td><td class="num">${qtyText(l.quantity, l.unit)}</td><td class="num">${formatCentavos(l.unitPrice, currency)}</td><td class="num">${formatCentavos(l.lineSubtotal, currency)}</td>${costs ? html`<td class="num">${formatCentavos(costByLine.get(l.lineId) ?? 0, currency)}</td>` : ""}</tr>`
            )}</tbody></table></div>
          <dl class="dl" data-role="totals">
            <dt>Subtotal</dt><dd>${formatCentavos(order.subtotal, currency)}</dd>
            <dt>Discount</dt><dd>${formatCentavos(order.discount, currency)}</dd>
            <dt>Total</dt><dd><strong>${formatCentavos(order.total, currency)}</strong></dd>
            <dt>Paid</dt><dd>${formatCentavos(order.amountPaid, currency)}</dd>
            <dt>Balance</dt><dd>${formatCentavos(order.balance, currency)}</dd>
            ${costs ? html`<dt>COGS</dt><dd data-role="cogs">${formatCentavos(costs.cogs, currency)}</dd><dt>Gross profit</dt><dd data-role="profit">${formatCentavos(costs.grossProfit, currency)}</dd>` : ""}
          </dl>
          <h3 class="section-title">History</h3>
          <ul class="list" data-role="history">${historyRows(order, { currency, timezone }).map((h) => html`<li><strong>${h.label}</strong> <span class="stat-hint">${h.when} · ${h.actor}</span>${h.details ? html`<div class="stat-hint">${h.details}</div>` : ""}</li>`)}</ul>
        </div>
        <div class="modal-footer">
          ${pending && can.update ? html`<button type="button" class="btn" data-act="edit">Edit</button>` : ""}
          ${pending && can.cancel ? html`<button type="button" class="btn btn-danger" data-act="cancel">Cancel order</button>` : ""}
          ${pending && can.fulfill ? html`<button type="button" class="btn btn-primary" data-act="fulfill">Mark fulfilled</button>` : ""}
          <button type="button" class="btn" data-act="close">Close</button>
        </div>
      </div>`
    );
    backdrop.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (e.target === backdrop || act === "close") return close();
      if (act === "edit") {
        close();
        const result = await openOrderEditor({ session, deps: editorDeps, order });
        if (result) {
          toast("Order updated", "success");
          load();
        }
      }
      if (act === "fulfill") {
        const ok = await confirmDialog({ title: `Fulfill ${order.orderNumber}?`, body: "Stock leaves inventory and the sale counts toward today. This can't be undone (returns come later).", confirmLabel: "Mark fulfilled" });
        if (!ok) return;
        try {
          await api("orders", { method: "POST", body: { action: "fulfill", orderId: order.id } });
          close();
          toast("Order fulfilled", "success");
          load();
        } catch (err) {
          toast(err.message || "Couldn't fulfill the order.", "danger");
        }
      }
      if (act === "cancel") {
        const result = await formDialog({
          title: `Cancel ${order.orderNumber}`,
          intro: "Reserved stock is released. The order stays in history.",
          fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
          submitLabel: "Cancel order",
          onSubmit: (v) => api("orders", { method: "POST", body: { action: "cancel", orderId: order.id, reason: v.reason } }),
        });
        if (result) {
          close();
          toast("Order cancelled", "success");
          load();
        }
      }
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    switch (el.dataset.act) {
      case "new": {
        const result = await openOrderEditor({ session, deps: editorDeps });
        if (result) {
          toast(`Order ${result.orderNumber} created`, "success");
          state.cursors = [];
          load();
        }
        return;
      }
      case "open":
        return openDetail(el.dataset.id);
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
    const form = event.target;
    const day = form.elements.day.value.trim();
    state.filters = Object.fromEntries(
      [["fulfillmentStatus", form.elements.fulfillmentStatus.value], ["paymentStatus", form.elements.paymentStatus.value], ["source", form.elements.source.value], ["day", isDayId(day) ? day : ""]].filter(([, v]) => v)
    );
    if (day && !isDayId(day)) toast("Date must look like 2026-10-08", "danger");
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
