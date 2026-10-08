// Payments: one payment per compact row (Luna's operational-table standard).
//   Date/Time | Order # | Customer | Amount | Method | Reference | Proof | Status | View
// View holds the payment's activity and, by permission, Edit / Verify and
// "⋯ More" -> Remove payment. Every write is POST /api/payments.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge } from "../../components/ui.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { PAYMENT_STATES, PAYMENT_METHODS, PAYMENT_METHOD_IDS } from "@shared/index.js";
import * as defaultData from "./data.js";
import { editPaymentDialog, removePaymentDialog, showProof, methodLabel } from "./actions.js";
import { when } from "../orders/view.js";

export const STATE_TONE = { for_verification: "warning", verified: "success", voided: "neutral" };

export function paymentRow(p, { currency = "PHP", timezone } = {}) {
  return {
    id: p.id,
    when: when(p.receivedAt || p.createdAt, timezone),
    orderNumber: p.orderNumber,
    customer: p.customerName || "",
    amount: formatCentavos(p.amount, currency),
    method: methodLabel(p.method),
    reference: p.reference || "—",
    hasProof: Boolean(p.proof),
    state: p.state,
  };
}

// Plain-language activity for one payment.
export function paymentActivity(p, { currency = "PHP", timezone } = {}) {
  return (p.history || []).map((h) => {
    const text =
      h.label ||
      (h.type === "recorded" ? `Payment recorded ${formatCentavos(h.amount, currency)} via ${methodLabel(h.method)}${h.reference ? ` · Reference: ${h.reference}` : ""}` : h.type);
    return [when(h.at, timezone), h.actor?.name ?? "", text + (h.reason ? ` · Reason: ${h.reason}` : "")].filter(Boolean).join(" • ");
  });
}

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast } = {}) {
  const perms = session.member.permissions;
  const canVerify = perms["payments.verify"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const state = { filters: {}, cursors: [], rows: [], hasMore: false, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      const page = await data.listPayments(businessId, { filters: state.filters, cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("payments: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load payments.";
    }
    state.loading = false;
    if (alive) draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;

  function draw() {
    if (!alive) return;
    const rows = state.rows.map((p) => paymentRow(p, { currency, timezone }));
    render(
      container,
      html`
        ${pageHeader({ title: "Payments", subtitle: "Every payment recorded against an order." })}
        <form class="section card filters filters-inline" data-role="filters">
          <select class="select" name="state" aria-label="Status">${opt("", "Any status", state.filters.state || "")}${Object.entries(PAYMENT_STATES).map(([k, v]) => opt(k, v.label, state.filters.state))}</select>
          <select class="select" name="method" aria-label="Method">${opt("", "Any method", state.filters.method || "")}${PAYMENT_METHOD_IDS.map((k) => opt(k, PAYMENT_METHODS[k].label, state.filters.method))}</select>
          <button type="submit" class="btn">Apply</button>
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !rows.length
                ? emptyState({ iconName: "payments", title: "No payments", body: "Payments recorded on orders appear here." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="payments">
                    <thead><tr><th>Date/Time</th><th>Order #</th><th>Customer</th><th class="num">Amount</th><th class="col-secondary">Method</th><th>Reference</th><th class="col-secondary">Proof</th><th>Status</th><th></th></tr></thead>
                    <tbody>${rows.map(
                      (r) => html`<tr data-payment="${r.id}">
                        <td>${r.when}</td><td>${r.orderNumber}</td><td>${r.customer}</td><td class="num">${r.amount}</td>
                        <td class="col-secondary">${r.method}</td><td>${r.reference}</td>
                        <td class="col-secondary">${r.hasProof ? html`<button type="button" class="cell-edit" data-act="proof" data-id="${r.id}">View screenshot</button>` : "—"}</td>
                        <td>${badge(PAYMENT_STATES[r.state]?.label ?? r.state, STATE_TONE[r.state] || "neutral")}</td>
                        <td class="row-actions"><button type="button" class="btn btn-compact" data-act="view" data-id="${r.id}">View</button></td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>`
    );
  }

  function openView(p) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const live = p.state !== "voided";
    render(
      backdrop,
      html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Payment ${p.orderNumber}" data-role="payment-view">
        <div class="modal-header"><h2 class="card-title">${formatCentavos(p.amount, currency)} · ${p.orderNumber}</h2></div>
        <div class="modal-body">
          <dl class="dl dl-compact">
            <dt>Customer</dt><dd>${p.customerName}</dd><dt>Method</dt><dd>${methodLabel(p.method)}</dd>
            <dt>Reference</dt><dd>${p.reference || "—"}</dd><dt>Status</dt><dd>${PAYMENT_STATES[p.state]?.label ?? p.state}</dd>
            ${p.note ? html`<dt>Note</dt><dd>${p.note}</dd>` : ""}
          </dl>
          <h3 class="section-title">Activity</h3>
          <ul class="list activity" data-role="payment-activity">${paymentActivity(p, { currency, timezone }).map((line) => html`<li>${line}</li>`)}</ul>
        </div>
        <div class="modal-footer">
          ${canVerify && live ? html`<div class="menu-wrap"><button type="button" class="btn" data-act="more">⋯ More</button><div class="menu" data-role="more-menu" hidden><button type="button" class="menu-item menu-danger" data-act="remove">Remove payment</button></div></div>` : ""}
          ${canVerify && live ? html`<button type="button" class="btn" data-act="edit">Edit</button>` : ""}
          ${canVerify && p.state === "for_verification" ? html`<button type="button" class="btn btn-primary" data-act="verify">Mark verified</button>` : ""}
          <button type="button" class="btn" data-act="close">Close</button>
        </div>
      </div>`
    );
    backdrop.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (e.target === backdrop || act === "close") return close();
      if (act === "more") {
        const menu = backdrop.querySelector('[data-role="more-menu"]');
        menu.hidden = !menu.hidden;
        return undefined;
      }
      const run = async (fn, message) => {
        const result = await fn();
        if (result) {
          close();
          toast(message, "success");
          load();
        }
      };
      if (act === "edit") return run(() => editPaymentDialog({ payment: p, api, currency }), "Payment updated");
      if (act === "remove") return run(() => removePaymentDialog({ payment: p, api, currency }), "Payment removed");
      if (act === "verify") {
        return run(async () => {
          if (!(await confirmDialog({ title: "Mark this payment verified?", body: `${formatCentavos(p.amount, currency)} via ${methodLabel(p.method)}${p.reference ? `, ref ${p.reference}` : ""}.`, confirmLabel: "Mark verified" }))) return null;
          try {
            return await api("payments", { method: "POST", body: { action: "verify", paymentId: p.id } });
          } catch (err) {
            toast(err.message, "danger");
            return null;
          }
        }, "Payment verified");
      }
      return undefined;
    });
  }

  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    const p = el.dataset.id ? state.rows.find((r) => r.id === el.dataset.id) : null;
    switch (el.dataset.act) {
      case "proof":
        return showProof({ api, paymentId: p.id, title: `Screenshot · ${p.orderNumber}` });
      case "view":
        return openView(p);
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
    const f = event.target.elements;
    state.filters = Object.fromEntries([["state", f.state.value], ["method", f.method.value]].filter(([, v]) => v));
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
