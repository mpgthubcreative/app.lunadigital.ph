// Orders = Work (Phase 18.5): "What orders do we need to process?"
// One compact row per order (desktop):
//   Order # (+time) | Customer (+items) | Total | Reference | Proof | Payment ▾ | Fulfillment ▾ | ›
// Phones show a 2-3 line record (number · customer · total, then the two
// inline controls). Tapping a row opens its details panel.
// Payment and Fulfillment are separate inline controls:
//   Payment ▾       Paid / Partially paid open a small "record payment"
//                   popover; on a "For verification" order, Paid = verify.
//                   The status itself is always derived by the server.
//   Fulfillment ▾   Pending / Preparing / Ready change the stage; Fulfilled
//                   and Cancelled go through the protected fulfil / cancel
//                   engines (stock, Sales, COGS), never a bare status write.
// View details: "Fulfilled · Paid", the customer (if any), stacked product
// lines, Total strongest, compact payments, activity folded; Edit and
// Close, everything else under ⋯ More.
// Permissions decide every control; the server re-checks all of it.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { orderPermissions, paymentCell, fulfillmentCell, latestPaymentCell, copyPending, inlineOrderActions } from "./inline.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { ORDER_SOURCES, ORDER_SOURCE_IDS, sourceText, FULFILLMENT_STATUSES, PAYMENT_STATUSES, PAYMENT_STATES, isDayId, isOpenFulfillment } from "@shared/index.js";
import * as ordersData from "./data.js";
import { listOrderPayments } from "../payments/data.js";
import { listProducts } from "../inventory/data.js";
import { orderRow, historyRows, costCorrectionRows, qtyText, sourceLabel, fulfillmentLabel, paymentLabel, FULFILLMENT_TONE, PAYMENT_TONE, when } from "./view.js";
import { openOrderEditor } from "./editor.js";
import { openShareMenu } from "./share-menu.js";
import { recordPaymentDialog, editPaymentDialog, removePaymentDialog, rejectPaymentDialog, showReceipt, showProof, methodLabel } from "../payments/actions.js";
import { openPayLinkSheet } from "../payments/link-sheet.js";
import { STATE_TONE } from "../payments/index.js";
import { searchCustomers as defaultSearchCustomers } from "../customers/data.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";

const defaultDeps = {
  data: ordersData,
  listOrderPayments,
  // Every active product for the order form's dropdown, a page at a time.
  listActiveProducts: async (businessId) => {
    const rows = [];
    for (let cursor = null, more = true; more; ) {
      const page = await listProducts(businessId, { status: "active", cursor, pageSize: 200 });
      rows.push(...page.rows);
      more = page.hasMore && page.rows.length > 0;
      cursor = page.rows[page.rows.length - 1];
    }
    return rows;
  },
  searchCustomers: defaultSearchCustomers,
};

export function mount(container, session, { data = defaultDeps.data, payments = { listOrderPayments: defaultDeps.listOrderPayments }, listActiveProducts = defaultDeps.listActiveProducts, searchCustomers = defaultDeps.searchCustomers, api = defaultApi, toast = defaultToast, exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const can = orderPermissions(perms);
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  // Links from the Dashboard open a filtered list (e.g. ?fulfillmentStatus=ready).
  const fromUrl = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const initial = Object.fromEntries([["fulfillmentStatus", FULFILLMENT_STATUSES], ["paymentStatus", PAYMENT_STATUSES], ["source", ORDER_SOURCES]].filter(([k, allowed]) => fromUrl.get(k) && Object.hasOwn(allowed, fromUrl.get(k))).map(([k]) => [k, fromUrl.get(k)]));
  const state = { filters: initial, cursors: [], rows: [], hasMore: false, loading: true, error: null };
  let alive = true;
  const editorDeps = { listActiveProducts: () => listActiveProducts(businessId), searchCustomers: (term) => searchCustomers(businessId, term), getProducts: (ids) => data.getProducts(businessId, ids), api };

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

  function draw() {
    if (!alive) return;
    const f = state.filters;
    const filtered = Object.keys(f).length > 0;
    render(
      container,
      html`
        ${pageHeader({ title: "Orders", subtitle: "What needs processing: take payment and move each order along, right in its row.", actions: html`<button type="button" class="btn" data-act="share-menu">Share menu</button>${can.create ? html`<button type="button" class="btn btn-primary" data-act="new">+ New order</button>` : ""}` })}
        ${filterBar({
          fields: [
            { name: "fulfillmentStatus", label: "Fulfillment", type: "select", primary: true, all: "Any fulfillment", options: Object.entries(FULFILLMENT_STATUSES).map(([k, v]) => [k, v.label]), value: f.fulfillmentStatus },
            { name: "paymentStatus", label: "Payment", type: "select", primary: true, all: "Any payment", options: Object.entries(PAYMENT_STATUSES).map(([k, v]) => [k, v.label]), value: f.paymentStatus },
            { name: "source", label: "Came from", type: "select", all: "Anywhere", options: ORDER_SOURCE_IDS.map((k) => [k, ORDER_SOURCES[k].label]), value: f.source },
            { name: "from", label: "From (order date)", type: "date", value: f.from },
            { name: "to", label: "To (order date)", type: "date", value: f.to },
          ],
          end: "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(6)
              : !state.rows.length
                ? emptyState({ iconName: "orders", title: filtered ? "No orders match these filters" : "No orders", body: filtered ? "Remove a filter to see more." : can.create ? "Create the first order from a chat or call." : "Orders appear here as your team enters them." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="orders">
                    <thead><tr><th class="m-only"></th><th>Order #</th><th>Customer</th><th class="num">Total</th><th>Latest payment</th><th>Payment</th><th>Fulfillment</th><th><span class="visually-hidden">Details</span></th></tr></thead>
                    <tbody>${state.rows.map((o) => {
                      const r = orderRow(o, { currency, timezone });
                      return html`<tr data-order="${r.id}" data-open>
                        ${mobileCell({ title: `${r.number} · ${r.customer}`, sub: `${r.when} · ${r.items}`, end: r.total })}
                        <td><span class="cell-strong">${r.number}</span><span class="cell-sub">${r.when}</span></td>
                        <td>${r.customer}<span class="cell-sub">${r.items}</span></td>
                        <td class="num">${r.total}</td>
                        <td data-col="latest-payment" data-m="ctl">${latestPaymentCell(o, can)}</td>
                        <td data-col="payment" data-m="ctl">${paymentCell(o, can)}</td>
                        <td data-col="fulfillment" data-m="ctl">${fulfillmentCell(o, can)}</td>
                        <td class="row-actions" data-m="more">${openButton(r.id, `View details of ${r.number}`)}</td>
                      </tr>`;
                    })}</tbody>
                  </table></div>
                  <div class="pager">
                    <button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button>
                    <button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button>
                  </div>`}
        </section>
      `
    );
  }

  // Payment ▾ / Fulfillment ▾: the shared engine (./inline.js), same as the Dashboard.
  const { onPaymentChoice, onFulfillmentChoice, cancelDialog } = inlineOrderActions({ can, api, toast, currency, businessId, listOrderPayments: payments.listOrderPayments, reload: () => load() });

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
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const open = isOpenFulfillment(order.fulfillmentStatus);
    const fulfilled = order.fulfillmentStatus === "fulfilled";
    const canEdit = can.update && (open || (fulfilled && can.correct));
    const canDelete = can.cancel && open && !(order.amountPaid > 0);
    const canRecord = can.recordPayment && order.fulfillmentStatus !== "cancelled" && (order.balance ?? 0) > 0;
    // Owner pilot: Edit and Close are the two buttons; everything else an
    // order can do (payment, fulfil, cancel, delete) sits under ⋯ More.
    const more = [
      ...(canRecord ? [html`<button type="button" class="menu-item" data-act="pay-link">Payment link</button>`] : []),
      ...(canRecord ? [html`<button type="button" class="menu-item" data-act="record">Record payment</button>`] : []),
      ...(open && can.fulfill ? [html`<button type="button" class="menu-item" data-act="fulfill">Mark fulfilled</button>`] : []),
      ...(open && can.cancel ? [html`<button type="button" class="menu-item" data-act="cancel">Cancel order</button>`] : []),
      ...(canDelete ? [html`<button type="button" class="menu-item menu-danger" data-act="delete">Delete order</button>`] : []),
    ];
    const costByLine = new Map((costs?.lines || []).map((l) => [l.lineId, l.costConsumed]));
    const money = (c) => formatCentavos(c, currency);
    const day = (at) => (when(at, timezone) || "").replace(/,? \d{1,2}:\d{2}.*$/, "");
    // A plain walk-in (no name typed) shows no customer block.
    const name = order.customer?.name ?? "";
    const hasCustomer = Boolean(order.customerId || order.customer?.phone || (name && name !== "Walk-in"));
    const came = sourceText(order.source, order.sourceNote) || sourceLabel(order.source);
    const tone = (t) => `od-tone-${t || "neutral"}`;
    const history = historyRows(order, { currency, timezone });
    const payActions = (p) => [
      ...(p.proof ? [html`<button type="button" class="menu-item" role="menuitem" data-act="p-proof" data-payment="${p.id}">View screenshot</button>`] : []),
      ...(p.state === "verified" ? [html`<button type="button" class="menu-item" role="menuitem" data-act="p-receipt" data-payment="${p.id}">Receipt</button>`] : []),
      ...(can.verifyPayment && p.state === "for_verification" ? [html`<button type="button" class="menu-item" role="menuitem" data-act="p-verify" data-payment="${p.id}">Verify</button>`] : []),
      ...(can.verifyPayment && p.state === "for_verification" && p.via === "payment_link" ? [html`<button type="button" class="menu-item" role="menuitem" data-act="p-reject" data-payment="${p.id}">Not accepted / needs correction</button>`] : []),
      ...(can.verifyPayment && p.state !== "voided" ? [html`<button type="button" class="menu-item" role="menuitem" data-act="p-edit" data-payment="${p.id}">Edit</button>`, html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item menu-danger" role="menuitem" data-act="p-remove" data-payment="${p.id}">Remove</button>`] : []),
    ];
    render(
      backdrop,
      html`<div class="modal modal-wide od" role="dialog" aria-modal="true" aria-label="Order ${order.orderNumber}" data-role="detail">
        <div class="modal-header od-head"><h2 class="card-title od-number">${order.orderNumber}</h2>
          <p class="od-status" data-role="status"><span class="${tone(FULFILLMENT_TONE[order.fulfillmentStatus])}">${fulfillmentLabel(order.fulfillmentStatus)}</span> · <span class="${tone(PAYMENT_TONE[order.paymentStatus])}">${paymentLabel(order.paymentStatus)}</span></p></div>
        <div class="modal-body">
          ${hasCustomer
            ? html`<div class="od-customer" data-role="customer"><span class="od-name">${name}${order.customerId ? html` ${badge("Saved", "info")}` : ""}</span><span class="od-sub">${[order.customer?.phone, came].filter(Boolean).join(" · ")}</span></div>`
            : html`<p class="od-sub od-came" data-role="came">${came}</p>`}
          ${order.deliveryAddress ? html`<p class="od-note"><span class="od-k">Deliver to</span> ${order.deliveryAddress}</p>` : ""}
          ${order.notes ? html`<p class="od-note" data-role="notes"><span class="od-k">Note</span> ${order.notes}</p>` : ""}
          ${order.cancellationReason ? html`<p class="od-note"><span class="od-k">Cancelled because</span> ${order.cancellationReason}</p>` : ""}
          <ul class="od-items" data-role="items">${order.items.map(
            (l) => html`<li class="od-item"><span class="od-item-main"><span class="od-name">${l.name}</span><span class="od-sub">${qtyText(l.quantity, l.unit)} × ${money(l.unitPrice)}${costs ? html` · cost ${money(costByLine.get(l.lineId) ?? 0)}` : ""}</span></span><b class="od-amt">${money(l.lineSubtotal)}</b></li>`
          )}</ul>
          <dl class="od-totals" data-role="totals">
            ${order.discount ? html`<div><dt>Subtotal</dt><dd>${money(order.subtotal)}</dd></div><div><dt>Discount</dt><dd>−${money(order.discount)}</dd></div>` : ""}
            <div class="od-grand"><dt>Total</dt><dd data-role="total">${money(order.total)}</dd></div>
            <div><dt>Paid</dt><dd>${money(order.amountPaid)}</dd></div>
            ${(order.balance ?? 0) > 0 ? html`<div class="od-due"><dt>Balance</dt><dd>${money(order.balance)}</dd></div>` : ""}
            ${costs ? html`<div class="od-quiet"><dt>COGS</dt><dd data-role="cogs">${money(costs.cogs)}</dd></div><div class="od-quiet"><dt>Gross profit</dt><dd data-role="profit">${money(costs.grossProfit)}</dd></div>` : ""}
          </dl>
          ${paymentRows.length
            ? html`<h3 class="section-title od-section">Payments</h3>
              <ul class="od-pays" data-role="payments">${paymentRows.map((p) => {
                const acts = payActions(p);
                const flag = p.state && p.state !== "verified" && p.state !== "recorded" ? PAYMENT_STATES[p.state]?.label ?? p.state : "";
                return html`<li class="od-pay" data-payment="${p.id}">
                  <span class="od-pay-main"><span class="od-pay-date">${day(p.receivedAt || p.createdAt)}${flag ? html` ${badge(flag, STATE_TONE[p.state] || "neutral")}` : ""}</span>
                    <span class="od-pay-amt"><b>${money(p.amount)}</b> · ${methodLabel(p.method)}</span>
                    ${p.reference || p.proof || p.via ? html`<span class="od-sub">${[p.reference ? `Ref ${p.reference}` : "", p.proof ? "Screenshot attached" : "", p.via === "payment_link" ? "Sent by the customer (payment link)" : ""].filter(Boolean).join(" · ")}</span>` : ""}</span>
                  ${acts.length ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for this payment">⋯</summary><div class="line-menu-list" role="menu">${acts}</div></details>` : ""}
                </li>`;
              })}</ul>`
            : ""}
          <details class="dd-fold dd-quiet od-activity" data-role="fold-activity"><summary><span class="dd-when-closed">View activity</span><span class="dd-when-open">Hide activity</span></summary>
            <ul class="list activity" data-role="history">${history.map(
              (h) => html`<li data-type="${h.type}"><span>${h.headline}</span>${h.effects.map((e) => html`<div class="stat-hint">${e}</div>`)}</li>`
            )}</ul>
            ${costs && costs.corrections?.length ? html`<ul class="list activity" data-role="cost-corrections">${costCorrectionRows(costs, { currency, timezone }).map((c) => html`<li><span class="stat-hint">${c.headline}</span><div class="stat-hint">${c.text}</div></li>`)}</ul>` : ""}
          </details>
        </div>
        <div class="modal-footer">
          ${more.length ? html`<div class="menu-wrap"><button type="button" class="btn btn-ghost" data-act="more" aria-haspopup="true" aria-expanded="false">⋯ More</button><div class="menu" data-role="more-menu" hidden>${more}</div></div>` : ""}
          ${canEdit ? html`<button type="button" class="btn btn-primary" data-act="edit">Edit</button>` : ""}
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
      if (act === "p-reject") return after(rejectPaymentDialog({ payment, api, currency }), "Marked not accepted. The customer sees why on their link.");
      if (act === "p-receipt") return showReceipt({ payment, businessName: session.business.name, currency });
      if (act === "pay-link") return openPayLinkSheet({ order, api, toast, session });
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
      case "share-menu":
        return openShareMenu({ session, api, toast, listActiveProducts });
      case "open":
        return openDetail(el.dataset.id);
      case "proof":
        return showProof({ api, paymentId: el.dataset.payment, title: `Screenshot · ${find(el.dataset.id)?.orderNumber ?? ""}` });
      // The row's latest payment and payment link (2026-10-22).
      case "copy-pay-link": {
        const o = find(el.dataset.id);
        const link = api("payments", { method: "POST", body: { action: "payLink", orderId: o.id } }).then((r) => `${location.origin}${r.path}`);
        try {
          await copyPending(link);
          toast(`Payment link for ${o.orderNumber} copied ✓`, "success");
        } catch {
          // No clipboard here (or not allowed): show the link to copy by hand.
          link.then(() => openPayLinkSheet({ order: o, api, toast, session })).catch((err) => toast(err.message || "Couldn't get the payment link.", "danger"));
        }
        return undefined;
      }
      case "lp-proof": {
        const o = find(el.dataset.id);
        return showProof({ api, paymentId: o.lastPayment?.id ?? o.lastProofPaymentId, title: `Screenshot · ${o.orderNumber}` });
      }
      case "lp-verify": {
        const o = find(el.dataset.id);
        const p = o.lastPayment;
        if (!(await confirmDialog({ title: `Verify ${formatCentavos(p.amount, currency)} for ${o.orderNumber}?`, body: `${methodLabel(p.method)}${p.reference ? ` · Ref ${p.reference}` : ""}. Check it reached your GCash / Maya / bank first.`, confirmLabel: "Mark verified" }))) return undefined;
        try {
          await api("payments", { method: "POST", body: { action: "verify", paymentId: p.id } });
          toast("Payment verified", "success");
          return load();
        } catch (err) {
          return toast(err.message, "danger");
        }
      }
      case "lp-reject": {
        const o = find(el.dataset.id);
        if (await rejectPaymentDialog({ payment: { ...o.lastPayment, orderNumber: o.orderNumber }, api, currency })) {
          toast("Marked not accepted. The customer sees why on their link.", "success");
          load();
        }
        return undefined;
      }
      case "lp-receipt": {
        const o = find(el.dataset.id);
        const p = o.lastPayment;
        return showReceipt({ payment: { ...p, orderNumber: o.orderNumber, customerName: /^walk-?in$/i.test(o.customer?.name || "") ? "" : o.customer?.name, receivedDay: p.day }, businessName: session.business.name, currency });
      }
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
    const from = form.elements.from.value.trim();
    const to = form.elements.to.value.trim();
    if ((from && !isDayId(from)) || (to && !isDayId(to)) || (from && to && from > to)) {
      toast("Choose a valid date range (the start can't be after the end).", "danger");
      return;
    }
    state.filters = Object.fromEntries(
      [["fulfillmentStatus", form.elements.fulfillmentStatus.value], ["paymentStatus", form.elements.paymentStatus.value], ["source", form.elements.source.value], ["from", from], ["to", to]].filter(([, v]) => v)
    );
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  // Download = the APPLIED filters (what the list shows), every page.
  const unbindExport = bindExport(container, () => ({ ...state.filters }), { toast, deps: exportDeps });
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container);
  load();
  return () => {
    alive = false;
    unbindExport();
    unbindFilters();
    unbindRows();
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
  };
}
