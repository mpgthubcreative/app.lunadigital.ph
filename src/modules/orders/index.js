// Orders: the day-to-day control sheet. One compact row per order:
//   Order # | Time | Customer | Items | Total | Reference | Proof | Payment ▾ | Fulfillment ▾ | View details
// Payment and Fulfillment are separate inline controls:
//   Payment ▾       Paid / Partially paid open a small "record payment"
//                   popover; on a "For verification" order, Paid = verify.
//                   The status itself is always derived by the server.
//   Fulfillment ▾   Pending / Preparing / Ready change the stage; Fulfilled
//                   and Cancelled go through the protected fulfil / cancel
//                   engines (stock, Sales, COGS), never a bare status write.
// View details: items, totals, payments, activity log, Edit, ⋯ More.
// Permissions decide every control; the server re-checks all of it.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { ORDER_SOURCES, ORDER_SOURCE_IDS, FULFILLMENT_STATUSES, PAYMENT_STATUSES, PAYMENT_STATES, isDayId, isOpenFulfillment } from "@shared/index.js";
import * as ordersData from "./data.js";
import { listOrderPayments } from "../payments/data.js";
import { listProducts } from "../inventory/data.js";
import { orderRow, historyRows, costCorrectionRows, qtyText, sourceLabel, fulfillmentLabel, paymentLabel, FULFILLMENT_TONE, PAYMENT_TONE, when } from "./view.js";
import { openOrderEditor } from "./editor.js";
import { recordPaymentDialog, editPaymentDialog, removePaymentDialog, showProof, methodLabel } from "../payments/actions.js";
import { STATE_TONE } from "../payments/index.js";

const defaultDeps = {
  data: ordersData,
  listOrderPayments,
  searchProducts: (businessId, term) => listProducts(businessId, { search: term, status: "active" }).then((r) => r.rows),
};

export function mount(container, session, { data = defaultDeps.data, payments = { listOrderPayments: defaultDeps.listOrderPayments }, searchProducts = defaultDeps.searchProducts, api = defaultApi, toast = defaultToast } = {}) {
  const perms = session.member.permissions;
  const can = {
    create: perms["orders.create"] === true,
    update: perms["orders.update"] === true,
    fulfill: perms["orders.fulfill"] === true,
    cancel: perms["orders.cancel"] === true,
    correct: perms["orders.correct"] === true,
    financials: perms["dashboard.financials"] === true,
    viewPayments: perms["payments.view"] === true,
    recordPayment: perms["payments.record"] === true,
    verifyPayment: perms["payments.verify"] === true,
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

  // ---- inline controls ----
  function paymentCell(o) {
    if (!can.recordPayment || o.fulfillmentStatus === "cancelled") return badge(paymentLabel(o.paymentStatus), PAYMENT_TONE[o.paymentStatus] || "neutral");
    return html`<select class="select select-compact" data-act="payment" data-id="${o.id}" aria-label="Payment status of ${o.orderNumber}">
      ${Object.entries(PAYMENT_STATUSES).map(([k, v]) => html`<option value="${k}" ${o.paymentStatus === k ? "selected" : ""}>${v.label}</option>`)}
    </select>`;
  }

  function fulfillmentCell(o) {
    if (!can.fulfill || !isOpenFulfillment(o.fulfillmentStatus)) return badge(fulfillmentLabel(o.fulfillmentStatus), FULFILLMENT_TONE[o.fulfillmentStatus] || "neutral");
    const choices = Object.entries(FULFILLMENT_STATUSES).filter(([k]) => k !== "cancelled" || can.cancel);
    return html`<select class="select select-compact" data-act="fulfillment" data-id="${o.id}" aria-label="Fulfillment of ${o.orderNumber}">
      ${choices.map(([k, v]) => html`<option value="${k}" ${o.fulfillmentStatus === k ? "selected" : ""}>${v.label}</option>`)}
    </select>`;
  }

  function draw() {
    if (!alive) return;
    const f = state.filters;
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
              : !state.rows.length
                ? emptyState({ iconName: "orders", title: "No orders", body: can.create ? "Create the first order from a chat or call." : "Orders appear here as your team enters them." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="orders">
                    <thead><tr><th>Order #</th><th>Time</th><th>Customer</th><th class="col-secondary">Items</th><th class="num">Total</th><th class="col-secondary">Reference</th><th class="col-secondary">Proof</th><th>Payment</th><th>Fulfillment</th><th></th></tr></thead>
                    <tbody>${state.rows.map((o) => {
                      const r = orderRow(o, { currency, timezone });
                      return html`<tr data-order="${r.id}">
                        <td>${r.number}</td>
                        <td>${r.when}</td><td>${r.customer}</td><td class="col-secondary">${r.items}</td>
                        <td class="num">${r.total}</td>
                        <td class="col-secondary" data-col="reference">${r.reference}</td>
                        <td class="col-secondary" data-col="proof">${r.proofPaymentId && can.viewPayments ? html`<button type="button" class="cell-edit" data-act="proof" data-payment="${r.proofPaymentId}" data-id="${r.id}">View screenshot</button>` : "—"}</td>
                        <td data-col="payment">${paymentCell(o)}</td>
                        <td data-col="fulfillment">${fulfillmentCell(o)}</td>
                        <td class="row-actions"><button type="button" class="btn btn-compact" data-act="open" data-id="${r.id}">View details</button></td>
                      </tr>`;
                    })}</tbody>
                  </table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>
      `
    );
  }

  // Payment ▾: Paid / Partially paid record a payment; Paid on a
  // for-verification order verifies its pending payments.
  async function onPaymentChoice(o, choice, select) {
    const reset = () => {
      if (select) select.value = o.paymentStatus;
    };
    try {
      if (choice === "paid" && o.paymentStatus === "for_verification" && can.verifyPayment) {
        const pending = (await payments.listOrderPayments(businessId, o.id)).filter((p) => p.state === "for_verification");
        const total = pending.reduce((s, p) => s + p.amount, 0);
        const ok = await confirmDialog({ title: `Verify payment for ${o.orderNumber}?`, body: `${pending.length} payment(s), ${formatCentavos(total, currency)}${pending[0]?.reference ? `, ref ${pending[0].reference}` : ""}.`, confirmLabel: "Mark verified" });
        if (!ok) return reset();
        for (const p of pending) await api("payments", { method: "POST", body: { action: "verify", paymentId: p.id } });
        toast("Payment verified", "success");
        return load();
      }
      if ((choice === "paid" || choice === "partial") && (o.balance ?? o.total) > 0) {
        const result = await recordPaymentDialog({ order: o, api, currency, fullBalance: choice === "paid" });
        if (!result) return reset();
        toast("Payment recorded", "success");
        return load();
      }
      toast("Payment status follows the recorded payments. Open View details to change a payment.", "neutral");
      return reset();
    } catch (err) {
      toast(err.message || "Couldn't update the payment.", "danger");
      return reset();
    }
  }

  // Fulfillment ▾
  async function onFulfillmentChoice(o, choice, select) {
    const reset = () => {
      if (select) select.value = o.fulfillmentStatus;
    };
    try {
      if (isOpenFulfillment(choice)) {
        await api("orders", { method: "POST", body: { action: "stage", orderId: o.id, stage: choice } });
        toast(`${o.orderNumber}: ${fulfillmentLabel(choice)}`, "success");
        return load();
      }
      if (choice === "fulfilled") {
        const ok = await confirmDialog({ title: `Fulfill ${o.orderNumber}?`, body: "Stock leaves inventory and the sale counts toward today.", confirmLabel: "Mark fulfilled" });
        if (!ok) return reset();
        await api("orders", { method: "POST", body: { action: "fulfill", orderId: o.id } });
        toast("Order fulfilled", "success");
        return load();
      }
      if (choice === "cancelled") {
        const result = await cancelDialog(o);
        if (!result) return reset();
        toast("Order cancelled", "success");
        return load();
      }
      return reset();
    } catch (err) {
      toast(err.message || "Couldn't update the order.", "danger");
      return reset();
    }
  }

  const cancelDialog = (order) =>
    formDialog({
      title: `Cancel ${order.orderNumber}`,
      intro: "Reserved stock is released. The order stays in history.",
      fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
      submitLabel: "Cancel order",
      onSubmit: (v) => api("orders", { method: "POST", body: { action: "cancel", orderId: order.id, reason: v.reason } }),
    });

  // ---- View details ----
  async function openDetail(orderId) {
    let order;
    let costs = null;
    let paymentRows = [];
    try {
      order = await data.getOrder(businessId, orderId);
      if (order && can.financials && order.fulfillmentStatus === "fulfilled") costs = await data.getOrderCosts(businessId, orderId);
      if (order && can.viewPayments && (order.paymentCount || order.amountPaid)) paymentRows = await payments.listOrderPayments(businessId, orderId);
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
    const open = isOpenFulfillment(order.fulfillmentStatus);
    const fulfilled = order.fulfillmentStatus === "fulfilled";
    const canEdit = can.update && (open || (fulfilled && can.correct));
    const canDelete = can.cancel && open && !(order.amountPaid > 0);
    const canRecord = can.recordPayment && order.fulfillmentStatus !== "cancelled" && (order.balance ?? 0) > 0;
    const more = [
      ...(open && can.cancel ? [html`<button type="button" class="menu-item" data-act="cancel">Cancel order</button>`] : []),
      ...(canDelete ? [html`<button type="button" class="menu-item menu-danger" data-act="delete">Delete order</button>`] : []),
    ];
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
          ${paymentRows.length
            ? html`<h3 class="section-title">Payments</h3>
              <div class="table-wrap"><table class="table table-compact" data-role="payments"><thead><tr><th>When</th><th class="num">Amount</th><th>Method</th><th>Reference</th><th>Proof</th><th>Status</th><th></th></tr></thead>
              <tbody>${paymentRows.map(
                (p) => html`<tr data-payment="${p.id}">
                  <td>${when(p.receivedAt || p.createdAt, timezone)}</td><td class="num">${formatCentavos(p.amount, currency)}</td><td>${methodLabel(p.method)}</td><td>${p.reference || "—"}</td>
                  <td>${p.proof ? html`<button type="button" class="cell-edit" data-act="p-proof" data-payment="${p.id}">View screenshot</button>` : "—"}</td>
                  <td>${badge(PAYMENT_STATES[p.state]?.label ?? p.state, STATE_TONE[p.state] || "neutral")}</td>
                  <td class="row-actions">${can.verifyPayment && p.state === "for_verification" ? html`<button type="button" class="btn btn-compact" data-act="p-verify" data-payment="${p.id}">Verify</button>` : ""}${can.verifyPayment && p.state !== "voided" ? html`<button type="button" class="btn btn-compact" data-act="p-edit" data-payment="${p.id}">Edit</button><button type="button" class="btn btn-compact" data-act="p-remove" data-payment="${p.id}" title="Remove payment">⋯</button>` : ""}</td>
                </tr>`
              )}</tbody></table></div>`
            : ""}
          <h3 class="section-title">Activity</h3>
          <ul class="list activity" data-role="history">${historyRows(order, { currency, timezone }).map(
            (h) => html`<li data-type="${h.type}"><span>${h.headline}</span>${h.effects.map((e) => html`<div class="stat-hint">${e}</div>`)}</li>`
          )}</ul>
          ${costs && costs.corrections?.length ? html`<ul class="list activity" data-role="cost-corrections">${costCorrectionRows(costs, { currency, timezone }).map((c) => html`<li><span class="stat-hint">${c.headline}</span><div class="stat-hint">${c.text}</div></li>`)}</ul>` : ""}
        </div>
        <div class="modal-footer">
          ${more.length ? html`<div class="menu-wrap"><button type="button" class="btn" data-act="more" aria-haspopup="true" aria-expanded="false">⋯ More</button><div class="menu" data-role="more-menu" hidden>${more}</div></div>` : ""}
          ${canRecord ? html`<button type="button" class="btn" data-act="record">Record payment</button>` : ""}
          ${canEdit ? html`<button type="button" class="btn" data-act="edit">Edit</button>` : ""}
          ${open && can.fulfill ? html`<button type="button" class="btn btn-primary" data-act="fulfill">Mark fulfilled</button>` : ""}
          <button type="button" class="btn" data-act="close">Close</button>
        </div>
      </div>`
    );
    const after = async (promise, message) => {
      const result = await promise;
      if (result) {
        close();
        toast(message, "success");
        load();
      }
    };
    backdrop.addEventListener("click", async (e) => {
      const el = e.target.closest("[data-act]");
      const act = el?.dataset.act;
      if (e.target === backdrop || act === "close") return close();
      const payment = el?.dataset.payment ? paymentRows.find((p) => p.id === el.dataset.payment) : null;
      if (act === "more") {
        const menu = backdrop.querySelector('[data-role="more-menu"]');
        menu.hidden = !menu.hidden;
        el.setAttribute("aria-expanded", String(!menu.hidden));
        return undefined;
      }
      if (act === "p-proof") return showProof({ api, paymentId: payment.id, title: `Screenshot · ${order.orderNumber}` });
      if (act === "p-edit") return after(editPaymentDialog({ payment, api, currency }), "Payment updated");
      if (act === "p-remove") return after(removePaymentDialog({ payment, api, currency }), "Payment removed");
      if (act === "p-verify") {
        try {
          return await after(api("payments", { method: "POST", body: { action: "verify", paymentId: payment.id } }), "Payment verified");
        } catch (err) {
          return toast(err.message, "danger");
        }
      }
      if (act === "record") return after(recordPaymentDialog({ order, api, currency, fullBalance: true }), "Payment recorded");
      if (act === "delete") {
        return after(
          formDialog({
            title: `Delete ${order.orderNumber}?`,
            intro: "For orders entered by mistake. Reserved stock is released and a record of the deletion is kept. Fulfilled orders can't be deleted.",
            fields: [{ name: "reason", label: "Reason (optional)", type: "textarea" }],
            submitLabel: "Delete order",
            onSubmit: (v) => api("orders", { method: "POST", body: { action: "delete", orderId: order.id, ...(v.reason ? { reason: v.reason } : {}) } }),
          }),
          "Order deleted"
        );
      }
      if (act === "edit") {
        close();
        const result = await openOrderEditor({ session, deps: editorDeps, order });
        if (result) {
          toast("Order updated", "success");
          load();
        }
        return undefined;
      }
      if (act === "fulfill") {
        const ok = await confirmDialog({ title: `Fulfill ${order.orderNumber}?`, body: "Stock leaves inventory and the sale counts toward today. This can't be undone (returns come later).", confirmLabel: "Mark fulfilled" });
        if (!ok) return undefined;
        try {
          return await after(api("orders", { method: "POST", body: { action: "fulfill", orderId: order.id } }), "Order fulfilled");
        } catch (err) {
          return toast(err.message || "Couldn't fulfill the order.", "danger");
        }
      }
      if (act === "cancel") return after(cancelDialog(order), "Order cancelled");
      return undefined;
    });
  }

  const find = (id) => state.rows.find((o) => o.id === id);
  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.tagName === "SELECT") return undefined;
    switch (el.dataset.act) {
      case "new": {
        const result = await openOrderEditor({ session, deps: editorDeps });
        if (result) {
          toast(`Order ${result.orderNumber} created`, "success");
          state.cursors = [];
          load();
        }
        return undefined;
      }
      case "open":
        return openDetail(el.dataset.id);
      case "proof":
        return showProof({ api, paymentId: el.dataset.payment, title: `Screenshot · ${find(el.dataset.id)?.orderNumber ?? ""}` });
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
  const onChange = (event) => {
    const el = event.target;
    const o = el.dataset.id ? find(el.dataset.id) : null;
    if (!o) return;
    if (el.dataset.act === "payment") onPaymentChoice(o, el.value, el);
    if (el.dataset.act === "fulfillment") onFulfillmentChoice(o, el.value, el);
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
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
  };
}
