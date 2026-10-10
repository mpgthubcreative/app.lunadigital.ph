// Payments = Work (Phase 18.5): "What has been received, and what still
// needs verification?" One payment per compact row:
//   Date/Time | Order # | Customer | Amount | Method | Reference | Proof | Status (+ Verify) | ›
// Unpaid ORDERS belong to Orders (linked from here). The row opens the
// payment's activity and, by permission, Edit / Verify and "⋯ More" ->
// Remove payment. Every write is POST /api/payments.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { PAYMENT_STATES, PAYMENT_METHODS, PAYMENT_METHOD_IDS, isDayId } from "@shared/index.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
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

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast, exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const canVerify = perms["payments.verify"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  // The Dashboard links here as ?state=for_verification.
  const urlState = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("state");
  const state = { filters: urlState && Object.hasOwn(PAYMENT_STATES, urlState) ? { state: urlState } : {}, cursors: [], rows: [], hasMore: false, loading: true, error: null };
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

  function draw() {
    if (!alive) return;
    const rows = state.rows.map((p) => paymentRow(p, { currency, timezone }));
    const f = state.filters;
    const filtered = Object.keys(f).length > 0;
    render(
      container,
      html`
        ${pageHeader({ title: "Payments", subtitle: "Money received against orders, and what still needs verification.", actions: html`<a class="btn btn-ghost" href="/orders?paymentStatus=unpaid" data-link>Unpaid orders ›</a>` })}
        ${filterBar({
          fields: [
            { name: "state", label: "Status", type: "select", primary: true, all: "Any status", options: Object.entries(PAYMENT_STATES).map(([k, v]) => [k, v.label]), value: f.state },
            { name: "method", label: "Method", type: "select", primary: true, all: "Any method", options: PAYMENT_METHOD_IDS.map((k) => [k, PAYMENT_METHODS[k].label]), value: f.method },
            { name: "from", label: "Received from", type: "date", value: f.from },
            { name: "to", label: "Received to", type: "date", value: f.to },
          ],
          end: mayExport(session, "payments") ? html`<span class="visually-hidden" data-role="export-hint">${exportHint}</span>${exportButton("payments")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(6)
              : !rows.length
                ? emptyState({ iconName: "payments", title: filtered ? "No payments match these filters" : "No payments", body: filtered ? "Remove a filter to see more." : "Payments recorded on orders appear here." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="payments">
                    <thead><tr><th class="m-only"></th><th>Date/Time</th><th>Order #</th><th>Customer</th><th class="num">Amount</th><th class="col-secondary">Method</th><th>Reference</th><th class="col-secondary">Proof</th><th>Status</th><th><span class="visually-hidden">Details</span></th></tr></thead>
                    <tbody>${rows.map(
                      (r) => html`<tr data-payment="${r.id}" data-open>
                        ${mobileCell({ title: `${r.orderNumber} · ${r.customer}`, sub: `${r.when} · ${r.method}${r.reference !== "—" ? ` · ${r.reference}` : ""}`, end: r.amount })}
                        <td>${r.when}</td><td class="cell-strong">${r.orderNumber}</td><td>${r.customer}</td><td class="num">${r.amount}</td>
                        <td class="col-secondary">${r.method}</td><td>${r.reference}</td>
                        <td class="col-secondary">${r.hasProof ? html`<button type="button" class="cell-edit" data-act="proof" data-id="${r.id}">View screenshot</button>` : "—"}</td>
                        <td data-m="ctl"><span class="row-actions">${badge(PAYMENT_STATES[r.state]?.label ?? r.state, STATE_TONE[r.state] || "neutral")}${canVerify && r.state === "for_verification" ? html`<button type="button" class="btn btn-compact" data-act="quick-verify" data-id="${r.id}">Verify</button>` : ""}</span></td>
                        <td class="row-actions" data-m="more">${openButton(r.id, `View payment for ${r.orderNumber}`, { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager">
                    <button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button>
                    <button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button>
                  </div>`}
        </section>`
    );
  }

  // The same confirm-then-verify as the details panel.
  async function verify(p) {
    if (!(await confirmDialog({ title: "Mark this payment verified?", body: `${formatCentavos(p.amount, currency)} via ${methodLabel(p.method)}${p.reference ? `, ref ${p.reference}` : ""}.`, confirmLabel: "Mark verified" }))) return null;
    try {
      return await api("payments", { method: "POST", body: { action: "verify", paymentId: p.id } });
    } catch (err) {
      toast(err.message, "danger");
      return null;
    }
  }

  function openView(p) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
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
        return run(() => verify(p), "Payment verified");
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
      case "quick-verify":
        return verify(p).then((r) => {
          if (r) {
            toast("Payment verified", "success");
            load();
          }
        });
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
    const from = f.from.value.trim();
    const to = f.to.value.trim();
    if ((from && !isDayId(from)) || (to && !isDayId(to)) || (from && to && from > to)) {
      toast("Choose a valid date range (the start can't be after the end).", "danger");
      return;
    }
    state.filters = Object.fromEntries([["state", f.state.value], ["method", f.method.value], ["from", from], ["to", to]].filter(([, v]) => v));
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, () => ({ ...state.filters }), { toast, deps: exportDeps });
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
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
