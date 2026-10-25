// Payments (2026-10-22, Distributor: More → Payments): audit and
// reconciliation. Day-to-day payments are handled in Orders (the row shows
// the latest payment, its proof, Verify / Not accepted, the receipt).
//   Today ₱18,500 received · 3 waiting to check
//   [All] [Needs checking] [Verified]           More filters ▸ (Not
//   accepted, method, sent by, proof, dates)
//   Maria · ORD-001                     ₱2,500
//   GCash · Ref 123456789 · from the customer   Waiting verification
//   [View proof] [Verify]                       (verified: [Receipt])
// A payment opens a clean detail (amount, order, customer, method,
// reference, proof, submitted by / when, status, verified / rejected by,
// receipt); its full history is under ⋯ → View history. Every write is
// POST /api/payments.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, segmented } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { PAYMENT_METHODS, isDayId, businessDate } from "@shared/index.js";
import { bindExport } from "../../lib/export.js";
import * as defaultData from "./data.js";
import { editPaymentDialog, removePaymentDialog, rejectPaymentDialog, showReceipt, showProof, methodLabel } from "./actions.js";
import { when } from "../orders/view.js";

export const STATE_TONE = { for_verification: "warning", verified: "success", voided: "neutral" };
// Plain words on the Payments page.
const STATE_WORD = { for_verification: "Waiting verification", verified: "Verified", voided: "Not accepted / removed" };
const VIEWS = [["all", "All"], ["check", "Needs checking"], ["verified", "Verified"]];
const VIEW_STATE = { all: null, check: "for_verification", verified: "verified" };

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

// What an empty Payments page shows (examples only: never a payment record).
export const PAYMENT_EXAMPLES = Object.freeze([
  { name: "Maria's Mini Mart · ORD-001", sub: "GCash · Ref 1234 567 890 · Partial payment", end: "₱1,500" },
  { name: "ABC Restaurant · ORD-002", sub: "Bank transfer · Verified", end: "₱6,200" },
  { name: "Juan Store · ORD-003", sub: "GCash · Waiting to check", end: "₱1,850" },
]);

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast, exportDeps = {}, now = () => new Date() } = {}) {
  const perms = session.member.permissions;
  const canVerify = perms["payments.verify"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = businessDate(timezone || "Asia/Manila", now());
  // Old links (?state=for_verification) open Needs checking.
  const urlState = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("state");
  const state = { view: urlState === "for_verification" ? "check" : urlState === "verified" ? "verified" : "all", more: urlState === "voided" ? { rejected: "1" } : {}, cursors: [], rows: [], hasMore: false, loading: true, error: null, today: null };
  let alive = true;
  const money = (c) => formatCentavos(c, currency);

  // What the list asks the server for (indexed fields); "Sent by" and
  // "Proof" narrow the loaded rows.
  const queryFilters = () => {
    const m = state.more;
    const f = {};
    const st = m.rejected ? "voided" : VIEW_STATE[state.view];
    if (st) f.state = st;
    if (m.method) f.method = m.method;
    if (m.from) f.from = m.from;
    if (m.to) f.to = m.to;
    return f;
  };
  const shown = () =>
    state.rows.filter(
      (p) => (!state.more.via || (state.more.via === "customer" ? p.via === "payment_link" : p.via !== "payment_link")) && (!state.more.proof || (state.more.proof === "with" ? Boolean(p.proof) : !p.proof))
    );

  async function load() {
    state.loading = true;
    draw();
    try {
      const [page, received, waiting] = await Promise.all([
        data.listPayments(businessId, { filters: queryFilters(), cursor: state.cursors.at(-1) || null, pageSize: 50 }),
        // Today: received (not removed) and what's waiting to be checked.
        data.listPayments(businessId, { filters: { from: today, to: today }, pageSize: 200 }).catch(() => null),
        data.listPayments(businessId, { filters: { state: "for_verification" }, pageSize: 100 }).catch(() => null),
      ]);
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.today = received && waiting ? { received: received.rows.filter((p) => p.state !== "voided").reduce((s, p) => s + p.amount, 0), waiting: waiting.rows.length, waitingMore: waiting.hasMore } : null;
      state.error = null;
    } catch (err) {
      console.error("payments: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load payments.";
    }
    state.loading = false;
    if (alive) draw();
  }

  // One payment, one compact row: who · order, amount, method · reference,
  // status, and the next thing to do.
  function row(p) {
    const r = paymentRow(p, { currency, timezone });
    const via = p.via === "payment_link";
    const acts = [
      p.proof ? html`<button type="button" class="btn-linklike" data-act="proof" data-id="${p.id}">View proof</button>` : "",
      canVerify && p.state === "for_verification" ? html`<button type="button" class="btn btn-compact" data-act="quick-verify" data-id="${p.id}">Verify</button>` : "",
      p.state === "verified" ? html`<button type="button" class="btn-linklike" data-act="receipt" data-id="${p.id}">Receipt</button>` : "",
    ].filter(Boolean);
    return html`<li class="py-row" data-payment="${p.id}" data-state="${p.state}">
      <button type="button" class="py-main" data-act="view" data-id="${p.id}" aria-label="View payment for ${r.orderNumber}">
        <span class="py-who">${r.customer || "Walk-in"} · ${r.orderNumber}</span>
        <span class="py-sub">${r.method}${p.reference ? ` · Ref ${p.reference}` : p.proof ? " · Screenshot" : ""}${via ? " · from the customer" : ""} · ${r.when}</span>
      </button>
      <span class="py-end"><b class="py-amt">${r.amount}</b><span class="py-state" data-tone="${STATE_TONE[p.state] || ""}">${STATE_WORD[p.state] ?? p.state}</span></span>
      ${acts.length ? html`<span class="py-acts">${acts}</span>` : ""}
    </li>`;
  }

  function moreFilters() {
    const m = state.more;
    const n = Object.values(m).filter(Boolean).length;
    const opt = (v, l, cur) => html`<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
    return html`<details class="py-more" data-role="more-filters" ${n ? "open" : ""}><summary>More filters${n ? ` (${n})` : ""}</summary>
      <form class="py-more-form" data-role="more-form">
        <label class="sm-check"><input type="checkbox" name="rejected" value="1" ${m.rejected ? "checked" : ""} /> Not accepted / removed</label>
        <div class="field"><label for="py-method">Method</label><select class="select" id="py-method" name="method">${opt("", "Any method", m.method || "")}${["gcash", "maya", "bank_transfer", "cash", "cod", "other"].map((k) => opt(k, PAYMENT_METHODS[k].label, m.method))}</select></div>
        <div class="field"><label for="py-via">Sent by</label><select class="select" id="py-via" name="via">${opt("", "Anyone", m.via || "")}${opt("customer", "Customer (payment link)", m.via)}${opt("staff", "Staff (recorded in Luna)", m.via)}</select></div>
        <div class="field"><label for="py-proof">Proof</label><select class="select" id="py-proof" name="proof">${opt("", "With or without", m.proof || "")}${opt("with", "With proof", m.proof)}${opt("without", "Without proof", m.proof)}</select></div>
        <div class="field"><label for="py-from">Received from</label><input class="input" type="date" id="py-from" name="from" value="${m.from || ""}" /></div>
        <div class="field"><label for="py-to">Received to</label><input class="input" type="date" id="py-to" name="to" value="${m.to || ""}" /></div>
        <div class="py-more-actions"><button type="submit" class="btn btn-primary btn-compact">Apply</button>${n ? html`<button type="button" class="btn btn-ghost btn-compact" data-act="clear-more">Clear</button>` : ""}</div>
      </form>
    </details>`;
  }

  function draw() {
    if (!alive) return;
    const list = shown();
    const filtered = state.view !== "all" || Object.values(state.more).some(Boolean);
    render(
      container,
      html`
        ${pageHeader({ title: "Payments", subtitle: "Checking and history. Day-to-day payments happen in Orders." })}
        ${state.today ? html`<p class="py-today" data-role="today"><b>Today</b> ${money(state.today.received)} received · ${state.today.waiting}${state.today.waitingMore ? "+" : ""} waiting to check</p>` : ""}
        <div class="py-tools">${segmented("view", VIEWS, state.view, { label: "Payments shown" })}</div>
        ${moreFilters()}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(6)
              : !list.length
                ? filtered || state.cursors.length
                  ? emptyState({ iconName: "payments", title: state.view === "check" && !Object.values(state.more).some(Boolean) ? "Nothing to check" : "No payments match", body: state.view === "check" ? "Payments waiting for verification appear here." : "Change the filters to see more." })
                  : examplesState({ title: "No payments yet", body: "Payments you record on orders, or customers send by link, appear here:", items: PAYMENT_EXAMPLES, helper: "Record a payment from its order in Orders.", role: "payment-examples", wrap: true })
                : html`<ul class="py-list" data-role="payments">${list.map(row)}</ul>
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

  // Details: everything needed to check a payment, clean; the full history
  // under ⋯ → View history.
  function openView(p) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const live = p.state !== "voided";
    const via = p.via === "payment_link";
    const at = (t) => when(t, timezone) || "—";
    const decided = p.state === "verified" ? ["Verified by", `${p.verifiedBy?.name ?? "—"}${p.verifiedAt ? ` · ${at(p.verifiedAt)}` : ""}`] : p.state === "voided" ? [via ? "Not accepted by" : "Removed by", `${p.voidedBy?.name ?? "—"}${p.voidedAt ? ` · ${at(p.voidedAt)}` : ""}${p.voidReason ? ` · ${p.voidReason}` : ""}`] : null;
    const menu = [
      html`<button type="button" class="menu-item" data-act="history">View history</button>`,
      ...(canVerify && live ? [html`<button type="button" class="menu-item" data-act="edit">Edit</button>`, html`<button type="button" class="menu-item menu-danger" data-act="remove">Remove payment</button>`] : []),
    ];
    render(
      backdrop,
      html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Payment ${p.orderNumber}" data-role="payment-view">
        <div class="modal-header"><h2 class="card-title">${formatCentavos(p.amount, currency)} · ${p.orderNumber}</h2></div>
        <div class="modal-body">
          <dl class="dl dl-compact" data-role="payment-facts">
            <dt>Amount</dt><dd>${formatCentavos(p.amount, currency)}</dd>
            <dt>Order</dt><dd>${p.orderNumber}</dd>
            <dt>Customer</dt><dd>${p.customerName || "Walk-in"}</dd>
            <dt>Method</dt><dd>${methodLabel(p.method)}</dd>
            <dt>Reference</dt><dd>${p.reference || "—"}</dd>
            <dt>Proof</dt><dd>${p.proof ? html`<button type="button" class="btn-linklike" data-act="proof">View screenshot</button>` : "—"}</dd>
            <dt>Submitted by</dt><dd data-role="via">${via ? "The customer, from the payment link" : p.createdBy?.name ?? "—"}</dd>
            <dt>Submitted</dt><dd>${at(p.receivedAt || p.createdAt)}</dd>
            <dt>Status</dt><dd>${STATE_WORD[p.state] ?? p.state}</dd>
            ${decided ? html`<dt>${decided[0]}</dt><dd data-role="decided">${decided[1]}</dd>` : ""}
            ${p.note ? html`<dt>Note</dt><dd>${p.note}</dd>` : ""}
          </dl>
        </div>
        <div class="modal-footer">
          <div class="menu-wrap"><button type="button" class="btn" data-act="more" aria-label="More">⋯</button><div class="menu" data-role="more-menu" hidden>${menu}</div></div>
          ${p.state === "verified" ? html`<button type="button" class="btn" data-act="receipt">View receipt</button>` : ""}
          ${canVerify && p.state === "for_verification" && via ? html`<button type="button" class="btn" data-act="reject">Not accepted</button>` : ""}
          ${canVerify && p.state === "for_verification" ? html`<button type="button" class="btn btn-primary" data-act="verify">Mark verified</button>` : ""}
          <button type="button" class="btn" data-act="close">Close</button>
        </div>
      </div>`
    );
    backdrop.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (e.target === backdrop || act === "close") return close();
      if (act === "more") {
        const m = backdrop.querySelector('[data-role="more-menu"]');
        m.hidden = !m.hidden;
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
      if (act === "history") return showHistory(p);
      if (act === "edit") return run(() => editPaymentDialog({ payment: p, api, currency }), "Payment updated");
      if (act === "remove") return run(() => removePaymentDialog({ payment: p, api, currency }), "Payment removed");
      if (act === "reject") return run(() => rejectPaymentDialog({ payment: p, api, currency }), "Marked not accepted. The customer sees why on their link.");
      if (act === "receipt") return showReceipt({ payment: p, businessName: session.business.name, currency });
      if (act === "proof") return showProof({ api, paymentId: p.id, title: `Screenshot · ${p.orderNumber}` });
      if (act === "verify") return run(() => verify(p), "Payment verified");
      return undefined;
    });
  }
  // ⋯ → View history: the full audit trail of one payment.
  function showHistory(p) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    render(
      backdrop,
      html`<div class="modal" role="dialog" aria-modal="true" aria-label="Payment history" data-role="payment-history">
        <div class="modal-header"><h2 class="card-title">History · ${p.orderNumber}</h2></div>
        <div class="modal-body"><ul class="list activity" data-role="payment-activity">${paymentActivity(p, { currency, timezone }).map((line) => html`<li>${line}</li>`)}</ul></div>
        <div class="modal-footer"><button type="button" class="btn btn-primary" data-act="close">Close</button></div>
      </div>`
    );
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop || e.target.closest('[data-act="close"]')) backdrop.remove();
    });
  }

  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    const p = el.dataset.id ? state.rows.find((r) => r.id === el.dataset.id) : null;
    switch (el.dataset.act) {
      case "seg":
        state.view = el.dataset.value;
        state.more = { ...state.more, rejected: "" };
        state.cursors = [];
        return load();
      case "clear-more":
        state.more = {};
        state.cursors = [];
        return load();
      case "proof":
        return showProof({ api, paymentId: p.id, title: `Screenshot · ${p.orderNumber}` });
      case "receipt":
        return showReceipt({ payment: p, businessName: session.business.name, currency });
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
    if (event.target.dataset.role !== "more-form") return;
    event.preventDefault();
    const f = event.target.elements;
    const from = f.from.value.trim();
    const to = f.to.value.trim();
    if ((from && !isDayId(from)) || (to && !isDayId(to)) || (from && to && from > to)) {
      toast("Choose a valid date range (the start can't be after the end).", "danger");
      return;
    }
    state.more = Object.fromEntries([["rejected", f.rejected.checked ? "1" : ""], ["method", f.method.value], ["via", f.via.value], ["proof", f.proof.value], ["from", from], ["to", to]].filter(([, v]) => v));
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, () => queryFilters(), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
