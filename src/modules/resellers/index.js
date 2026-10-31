// Resellers (Reseller Package, 2026-10-31): "Who sells for me, and what do I
// owe them?"
//   + Add reseller        Name only → Save. Luna makes their private menu
//                         link (no Luna account for them).
//   one row per reseller  Commission earned · paid · remaining · Unpaid /
//                         Partially Paid / Paid; tap for details
//   details               the same summary; Copy link · Share · Pay
//                         Commission; ⋯ Regenerate link / Edit / Deactivate;
//                         recent orders (final commission, "Adjusted from");
//                         payout history (⋯ Reverse, kept in the ledger)
// Money comes from the server (/api/resellers); nothing is worked out here.
// Customer payments stay on Orders / Payments: a payout is Business →
// Reseller, a separate record.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { COMMISSION_STATUSES, PAYOUT_METHODS, PAYOUT_METHOD_IDS, parseCentavos, businessDate } from "@shared/index.js";

const short = (d) => (d ? formatDayId(d).replace(/, \d{4}$/, "") : "");
const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
export const PAYOUT_TONE = { none: "neutral", unpaid: "danger", partial: "warning", paid: "success" };
export const payoutBadge = (status) => badge(COMMISSION_STATUSES[status]?.label ?? status, PAYOUT_TONE[status] || "neutral");

export const RESELLER_EXAMPLES = Object.freeze([
  { name: "Riza", sub: "Commission ₱1,500 · Paid ₱1,000", end: "₱500 left" },
  { name: "Yanie", sub: "Commission ₱450", end: "Paid" },
]);

export function mount(container, session, { api = defaultApi, toast = defaultToast, now = () => new Date(), copy = (t) => navigator.clipboard?.writeText(t) } = {}) {
  const perms = session.member.permissions;
  const can = { manage: perms["resellers.manage"] === true, pay: perms["resellers.pay"] === true };
  const currency = session.business.currency || "PHP";
  const money = (c) => formatCentavos(c ?? 0, currency);
  const today = businessDate(session.business.timezone, now());
  const state = { rows: [], loading: true, error: null };
  let alive = true;
  const call = (body) => api("resellers", { method: "POST", body });
  const fullLink = (path) => `${window.location.origin}${path}`;

  async function load() {
    state.loading = true;
    draw();
    try {
      state.rows = (await call({ action: "list" })).resellers || [];
      state.error = null;
    } catch (err) {
      state.error = err.message || "Couldn't load resellers.";
    }
    state.loading = false;
    draw();
  }

  function draw() {
    if (!alive) return;
    const active = state.rows.filter((r) => r.status === "active");
    const t = state.rows.reduce((a, r) => ({ earned: a.earned + r.earned, paid: a.paid + r.paid, remaining: a.remaining + r.remaining }), { earned: 0, paid: 0, remaining: 0 });
    render(
      container,
      html`
        ${pageHeader({ title: "Resellers", subtitle: "Each reseller sells from their own private menu link. You set the owner price; they set their selling price.", actions: can.manage ? html`<button type="button" class="btn btn-primary" data-act="add">+ Add reseller</button>` : "" })}
        <section class="card section">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading && !state.rows.length
              ? skeleton(4)
              : !state.rows.length
                ? html`${examplesState({ title: "No resellers yet", body: "Add a reseller by name; Luna makes their private menu link:", items: RESELLER_EXAMPLES, helper: can.manage ? "Tap + Add reseller, type their name and Save. Then send them their link." : "Resellers your Owner adds appear here.", role: "reseller-examples", wrap: true })}`
                : html`<dl class="pay-figures rs-figures" data-role="totals">
                      <div><dt>Commission earned</dt><dd data-k="earned">${money(t.earned)}</dd></div>
                      <div><dt>Paid</dt><dd data-k="paid">${money(t.paid)}</dd></div>
                      <div><dt>Remaining</dt><dd data-k="remaining">${money(t.remaining)}</dd></div>
                    </dl>
                    <div class="table-wrap"><table class="table table-compact rows" data-role="resellers">
                      <thead><tr><th class="m-only"></th><th>Reseller</th><th class="num">Earned</th><th class="num col-secondary">Paid</th><th class="num">Remaining</th><th>Commission</th><th><span class="visually-hidden">Details</span></th></tr></thead>
                      <tbody>${state.rows.map(
                        (r) => html`<tr data-reseller="${r.id}" data-open class="${r.status === "active" ? "" : "is-muted"}">
                          ${mobileCell({ title: r.name, sub: `${money(r.earned)} earned · ${money(r.paid)} paid${r.status === "active" ? "" : " · Inactive"}`, end: r.remaining ? money(r.remaining) : COMMISSION_STATUSES[r.payoutStatus]?.label ?? "", endSub: r.remaining ? "left" : "" })}
                          <td class="cell-strong">${r.name}${r.status === "active" ? "" : html` ${badge("Inactive", "neutral")}`}</td>
                          <td class="num">${money(r.earned)}</td>
                          <td class="num col-secondary">${money(r.paid)}</td>
                          <td class="num"><strong>${money(r.remaining)}</strong></td>
                          <td data-col="payout">${payoutBadge(r.payoutStatus)}</td>
                          <td class="row-actions" data-m="more">${openButton(r.id, `Open ${r.name}`)}</td>
                        </tr>`
                      )}</tbody>
                    </table></div>
                    ${active.length !== state.rows.length ? html`<p class="stat-hint">${state.rows.length - active.length} inactive: their links don't work.</p>` : ""}`}
        </section>`
    );
  }

  // Name only, then the link to send.
  async function add() {
    const r = await formDialog({
      title: "Add reseller",
      fields: [
        { name: "name", label: "Name", required: true, placeholder: "e.g. Riza" },
        { name: "notes", label: "Notes (optional)", type: "textarea", more: true },
      ],
      moreLabel: "Notes",
      submitLabel: "Save",
      onSubmit: (v) => call({ action: "create", reseller: { name: v.name, ...(v.notes?.trim() ? { notes: v.notes.trim() } : {}) } }),
    });
    if (!r) return;
    toast("Reseller added. Send them their link.", "success");
    await load();
    openDetail(r.resellerId, { link: r.path });
  }

  async function shareLink(name, path) {
    const url = fullLink(path);
    if (navigator.share) {
      try {
        await navigator.share({ title: `${name}'s reseller menu`, text: `Your private reseller menu for ${session.business.name}`, url });
        return;
      } catch {
        /* closed the share sheet */
      }
    }
    try {
      await copy(url);
      toast("Link copied.", "success");
    } catch {
      toast("Copy the link from the box.", "neutral");
    }
  }

  async function openDetail(resellerId, { link = null } = {}) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    let d = null;
    let path = link;
    const close = () => {
      backdrop.remove();
      load();
    };
    const paint = () => {
      if (!d) return render(backdrop, html`<div class="modal"><div class="modal-body">${skeleton(4)}</div></div>`);
      const r = d.reseller;
      const menuItems = [
        ...(can.manage ? [{ x: "rotate", label: "Regenerate link" }, { x: "edit", label: "Edit name / notes" }, { x: r.status === "active" ? "deactivate" : "reactivate", label: r.status === "active" ? "Deactivate reseller" : "Reactivate reseller", danger: r.status === "active" }] : []),
      ];
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${r.name}" data-role="reseller-view">
          <div class="modal-header"><h2 class="card-title">${r.name}${r.status === "active" ? "" : html` ${badge("Inactive", "neutral")}`}</h2></div>
          <div class="modal-body">
            <dl class="pay-figures" data-role="summary">
              <div><dt>Commission earned</dt><dd data-k="earned">${money(r.earned)}</dd></div>
              <div><dt>Commission paid</dt><dd data-k="paid">${money(r.paid)}</dd></div>
              <div><dt>Remaining</dt><dd data-k="remaining">${money(r.remaining)}</dd></div>
            </dl>
            <p class="pay-status">${payoutBadge(r.payoutStatus)}</p>
            ${r.status === "active"
              ? html`<div class="rs-link" data-role="link">
                  ${path ? html`<input class="input" readonly value="${fullLink(path)}" data-role="link-text" aria-label="${r.name}'s private menu link" />` : ""}
                  <div class="link-actions">${can.manage ? html`<button type="button" class="btn btn-compact" data-x="copy">Copy link</button><button type="button" class="btn btn-compact" data-x="share">Share link</button>` : ""}</div>
                  <p class="stat-hint">${r.name} opens it without signing in. Luna knows the orders are ${r.name}'s.</p>
                </div>`
              : html`<p class="stat-hint" data-role="inactive-note">Inactive: ${r.name}'s link doesn't work. Reactivate to turn it back on.</p>`}
            ${r.notes ? html`<p class="od-note"><span class="od-k">Notes</span> ${r.notes}</p>` : ""}
            <h3 class="section-title od-section">Recent orders</h3>
            ${d.orders.length
              ? html`<ul class="od-pays" data-role="orders">${d.orders.map(
                  (o) => html`<li class="od-pay" data-order="${o.id}"><span class="od-pay-main"><span class="od-pay-date">${short(o.orderDate)} · ${o.orderNumber}${o.fulfillmentStatus === "cancelled" ? html` ${badge("Cancelled", "neutral")}` : ""}</span>
                    <span class="od-pay-amt">${o.customer} · ${money(o.total)}</span>
                    <span class="od-sub">Commission <b>${money(o.fulfillmentStatus === "cancelled" ? 0 : o.commission?.final ?? 0)}</b>${o.commission?.adjusted ? ` · Adjusted from ${money(o.commission.calculated)}` : ""}${o.payout && o.fulfillmentStatus !== "cancelled" && o.payout.final > 0 ? ` · ${COMMISSION_STATUSES[o.payout.status]?.label}` : ""}</span></span></li>`
                )}</ul>`
              : html`<p class="stat-hint">No orders yet. Orders ${r.name} makes from their link appear here.</p>`}
            <h3 class="section-title od-section">Payout history</h3>
            ${d.payouts.length
              ? html`<ul class="od-pays" data-role="payouts">${d.payouts.map(
                  (p) => html`<li class="od-pay${p.state === "reversed" ? " is-muted" : ""}" data-payout="${p.id}"><span class="od-pay-main"><span class="od-pay-date">${short(p.date)}${p.state === "reversed" ? html` ${badge("Reversed", "neutral")}` : ""}</span>
                    <span class="od-pay-amt"><b>${money(p.amount)}</b>${p.method ? ` · ${p.method}` : ""}${p.reference ? ` · Ref ${p.reference}` : ""}</span>
                    ${p.notes || p.reversal ? html`<span class="od-sub">${[p.notes, p.reversal ? `Reversed: ${p.reversal.reason}` : ""].filter(Boolean).join(" · ")}</span>` : ""}</span>
                    ${can.pay && p.state !== "reversed" ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for this payout">⋯</summary><div class="line-menu-list" role="menu"><button type="button" class="menu-item is-danger" role="menuitem" data-x="reverse" data-id="${p.id}">Reverse payout</button></div></details>` : ""}</li>`
                )}</ul>`
              : html`<p class="stat-hint">No payouts yet.</p>`}
          </div>
          <div class="modal-footer">
            ${can.pay && r.remaining > 0 ? html`<button type="button" class="btn btn-primary" data-x="pay">Pay commission</button>` : ""}
            ${menuItems.length ? html`<details class="line-menu line-menu-up"><summary class="btn">More ▾</summary><div class="line-menu-list" role="menu">${menuItems.map((i) => html`<button type="button" class="menu-item${i.danger ? " is-danger" : ""}" role="menuitem" data-x="${i.x}">${i.label}</button>`)}</div></details>` : ""}
            <button type="button" class="btn" data-x="close">Close</button>
          </div>
        </div>`
      );
    };
    const refresh = async () => {
      try {
        d = await call({ action: "detail", resellerId });
        if (!path && can.manage && d.reseller.status === "active") path = (await call({ action: "link", resellerId })).path;
      } catch (err) {
        toast(err.message || "Couldn't load", "danger");
      }
      paint();
    };
    backdrop.addEventListener("click", async (e) => {
      if (e.target === backdrop) return close();
      const el = e.target.closest("[data-x]");
      if (!el) return undefined;
      el.closest("details")?.removeAttribute("open");
      const x = el.dataset.x;
      const r = d?.reseller;
      try {
        if (x === "close") return close();
        if (x === "copy") {
          try {
            await copy(fullLink(path));
            toast("Link copied.", "success");
          } catch {
            toast("Copy the link from the box.", "neutral");
          }
        } else if (x === "share") await shareLink(r.name, path);
        else if (x === "rotate") {
          if (await confirmDialog({ title: `Regenerate ${r.name}'s link?`, body: "Luna makes a new private link. The old link stops working at once; send the new one to them.", confirmLabel: "Regenerate link", danger: true })) {
            path = (await call({ action: "link", resellerId, rotate: true })).path;
            toast("New link ready. The old one no longer works.", "success");
            paint();
          }
        } else if (x === "edit") {
          const ok = await formDialog({ title: `Edit ${r.name}`, fields: [{ name: "name", label: "Name", value: r.name, required: true }, { name: "notes", label: "Notes (optional)", type: "textarea", value: r.notes || "" }], submitLabel: "Save", onSubmit: (v) => call({ action: "update", resellerId, changes: { name: v.name, notes: v.notes?.trim() || null } }) });
          if (ok) refresh();
        } else if (x === "deactivate" || x === "reactivate") {
          if (x === "reactivate" || (await confirmDialog({ title: `Deactivate ${r.name}?`, body: `${r.name}'s link stops working. Their orders, commission and payouts stay as they are.`, confirmLabel: "Deactivate", danger: true }))) {
            await call({ action: "setStatus", resellerId, status: x === "deactivate" ? "inactive" : "active" });
            refresh();
          }
        } else if (x === "pay") {
          const idempotencyKey = newKey();
          const ok = await formDialog({
            title: `Pay commission to ${r.name}`,
            intro: `Still owed: ${money(r.remaining)}. Pay all of it or part.`,
            fields: [
              { name: "amount", label: "Amount (₱)", value: String(r.remaining / 100), required: true, inputmode: "decimal" },
              { name: "date", label: "Payment date", type: "date", value: today, max: today },
              { name: "method", label: "Paid by (optional)", type: "select", value: "", options: [{ value: "", label: "—" }, ...PAYOUT_METHOD_IDS.map((id) => ({ value: id, label: PAYOUT_METHODS[id].label }))] },
              { name: "reference", label: "Reference (optional)", more: true },
              { name: "notes", label: "Notes (optional)", more: true },
            ],
            submitLabel: "Pay commission",
            armMs: 700,
            onSubmit: (v) => {
              const amount = parseCentavos(v.amount);
              if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
              if (amount > r.remaining) throw new Error(`That's more than the commission still owed (${money(r.remaining)}).`);
              return call({ action: "pay", resellerId, idempotencyKey, payout: { amount, date: v.date || today, ...(v.method ? { method: v.method } : {}), ...(v.reference?.trim() ? { reference: v.reference.trim() } : {}), ...(v.notes?.trim() ? { notes: v.notes.trim() } : {}) } });
            },
          });
          if (ok) {
            toast(ok.status === "paid" ? "Commission paid in full." : "Payout recorded.", "success");
            refresh();
          }
        } else if (x === "reverse") {
          const p = d.payouts.find((q) => q.id === el.dataset.id);
          const ok = await formDialog({ title: `Reverse the ${money(p.amount)} payout?`, intro: "For a payout recorded by mistake. It stays in the history, marked Reversed, and the amount is owed again.", fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Recorded twice" }], submitLabel: "Reverse payout", onSubmit: (v) => call({ action: "reversePayout", payoutId: p.id, reason: v.reason }) });
          if (ok) refresh();
        }
      } catch (err) {
        toast(err.message || "Something went wrong", "danger");
      }
      return undefined;
    });
    paint();
    refresh();
  }

  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    if (el.dataset.act === "add") add();
    else if (el.dataset.act === "open") openDetail(el.dataset.id);
  };
  container.addEventListener("click", onClick);
  const unbindRows = bindRowOpen(container);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    unbindRows();
  };
}
