// Super Admin money pages (Phase 18.6, simplified 2026-10-19):
//   Subscriptions  who is subscribed, the date that matters, status, ⋯
//   Payments       what needs verification / what has been paid
//   Usage          WORKSPACE usage Luna measures per business (users,
//                  storage, Excel downloads and transfer, orders) and, apart,
//                  the PROVIDER bills (Firebase / Netlify bill the whole
//                  project: their dashboards are the source of truth; a
//                  per-business provider cost isn't invented).
// Every read and write goes through POST /api/operator (ctx.call), which
// re-checks the operator. Revenue never reaches tenants.

import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState, badge, section, kpiStrip, mobileCell } from "../components/ui.js";
import { formDialog } from "../components/form-dialog.js";
import { confirmDialog } from "../components/feedback.js";
import { formatBytes, formatNumber, formatDayId } from "../lib/format.js";
import { SUBSCRIPTION_LABELS, NO_LIMIT_FROM } from "@shared/index.js";
import { PAYMENT_STATUSES, PLATFORM_EXPENSE_CATEGORIES, PLATFORM_EXPENSE_KINDS } from "@shared/billing.js";
import { whenText, stateChip, subscriptionMenu, toggleMenus, runSubscriptionAction, billingText } from "./actions.js";

const peso = (c) => (c === null || c === undefined ? "—" : `${c < 0 ? "−" : ""}₱${(Math.abs(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const monthLabel = (p) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", timeZone: "UTC" });
const monthLong = (p) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });
const payBadge = (s) => badge(PAYMENT_STATUSES[s]?.label ?? s, PAYMENT_STATUSES[s]?.tone ?? "neutral");
const loading = (title) => html`${pageHeader({ title })}${card({ body: emptyState({ title: "Loading…" }) })}`;
const failed = (title, err) => html`${pageHeader({ title })}${card({ body: emptyState({ title: "Couldn't load", body: err?.message || "Try again." }) })}`;
const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;
const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);

// ---------- Subscriptions ----------

export function subscriptionsView(el, ctx) {
  const params = new URLSearchParams(ctx.search || "");
  const state = { filters: Object.fromEntries([["status", params.get("status") || ""], ["workspaceTemplateId", params.get("workspace") || ""]].filter(([, v]) => v)), cursors: [null], page: null };
  async function load() {
    render(el, loading("Subscriptions"));
    try {
      state.page = await ctx.call("subscriptions", { filters: state.filters, after: state.cursors.at(-1) });
    } catch (err) {
      render(el, failed("Subscriptions", err));
      return;
    }
    const f = state.filters;
    const rows = state.page.rows.filter((r) => r.status !== "deleted");
    render(
      el,
      html`${pageHeader({ title: "Subscriptions" })}
        <form class="filter-form toolbar" data-role="filters">
          <select class="select" name="status" aria-label="Status">${opt("", "All statuses", f.status || "")}${Object.entries(SUBSCRIPTION_LABELS).filter(([k]) => k !== "deleted").map(([k, l]) => opt(k, l, f.status))}</select>
          <select class="select" name="workspaceTemplateId" aria-label="Workspace">${opt("", "All workspaces", f.workspaceTemplateId || "")}${ctx.workspaces.map((w) => opt(w.id, w.name, f.workspaceTemplateId))}</select>
          <button type="submit" class="btn">Apply</button>
        </form>
        ${card({
          body: rows.length
            ? html`<div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="subscriptions">
                <thead><tr><th class="m-only"></th><th>Name / plan</th><th>Billing</th><th>Date</th><th>Status</th><th></th></tr></thead>
                <tbody>${rows.map(
                  (r) => html`<tr data-business="${r.id}">
                    ${mobileCell({ title: r.name, sub: [r.planName ?? ctx.planName(r.planId), r.billingType === "annual" ? billingText(r) : null, whenText(r)].filter(Boolean).join(" · "), end: stateChip(r) })}
                    <td><a class="cell-strong" href="${ctx.base}/businesses?b=${r.id}" data-link>${r.name}</a><span class="cell-sub">${r.planName ?? ctx.planName(r.planId)}</span></td>
                    <td>${billingText(r)}<span class="cell-sub">${peso(r.amount)}</span></td>
                    <td data-role="when">${whenText(r)}${r.attention?.kind === "overdue" ? html`<span class="cell-sub tone-danger">${r.attention.label}</span>` : ""}</td>
                    <td>${stateChip(r)}</td>
                    <td class="row-actions" data-m="more">${subscriptionMenu(r, { ctx })}</td>
                  </tr>`
                )}</tbody></table></div>
              <div class="pager"><button type="button" class="btn btn-compact" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Previous</button><button type="button" class="btn btn-compact" data-act="next" ${state.page.next ? "" : "disabled"}>Next</button></div>`
            : emptyState({ title: "No subscriptions match" }),
        })}`
    );
  }
  el.onsubmit = (e) => {
    if (e.target.dataset.role !== "filters") return;
    e.preventDefault();
    const x = e.target.elements;
    state.filters = Object.fromEntries([["status", x.status.value], ["workspaceTemplateId", x.workspaceTemplateId.value]].filter(([, v]) => v));
    state.cursors = [null];
    load();
  };
  el.onclick = async (e) => {
    if (toggleMenus(e, el)) return;
    const t = e.target.closest("[data-act]");
    const act = t?.dataset.act;
    if (act === "next") {
      state.cursors.push(state.page.next);
      load();
    } else if (act === "prev") {
      state.cursors.pop();
      load();
    } else if (act?.startsWith("s-")) {
      const r = state.page.rows.find((x) => x.id === t.dataset.id);
      if (r && (await runSubscriptionAction(ctx, act, r))) load();
    }
  };
  load();
}

// ---------- Payments ----------

export function paymentsView(el, ctx) {
  const state = { filters: { status: "for_verification" }, cursors: [null], page: null };
  async function load() {
    render(el, loading("Payments"));
    try {
      state.page = await ctx.call("payments", { filters: state.filters, after: state.cursors.at(-1) });
    } catch (err) {
      render(el, failed("Payments", err));
      return;
    }
    const f = state.filters;
    const rows = state.page.rows;
    render(
      el,
      html`${pageHeader({ title: "Payments", subtitle: "Luna subscription payments: what needs your verification, and what's been paid.", actions: html`<button type="button" class="btn" data-act="settings">Payment settings</button>` })}
        <form class="filter-form toolbar" data-role="filters">
          <select class="select" name="status" aria-label="Status">${opt("", "Any status", f.status || "")}${Object.entries(PAYMENT_STATUSES).map(([k, s]) => opt(k, s.label, f.status))}</select>
          <select class="select" name="workspaceTemplateId" aria-label="Workspace">${opt("", "Any workspace", f.workspaceTemplateId || "")}${ctx.workspaces.map((w) => opt(w.id, w.name, f.workspaceTemplateId))}</select>
          <input class="input" type="month" name="period" aria-label="Billing month" value="${f.period || ""}" />
          <input class="input" name="businessId" aria-label="Business ID" placeholder="Business ID" value="${f.businessId || ""}" />
          <button type="submit" class="btn">Apply</button>
        </form>
        ${card({
          body: rows.length
            ? html`<div class="table-wrap"><table class="table table-compact rows" data-role="payments">
                <thead><tr><th class="m-only"></th><th>Business</th><th class="col-secondary">Workspace</th><th class="col-secondary">Plan</th><th>For</th><th class="num">Amount</th><th class="col-secondary">Paid on</th><th>Status</th><th></th></tr></thead>
                <tbody>${rows.map(
                  (r) => html`<tr data-payment="${r.id}">
                    <td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${r.businessName}</span><span class="m-sub">${ctx.workspaceName(r.workspaceTemplateId)} · ${r.planName} · ${monthLabel(r.period)}</span></div><div class="m-end">${peso(r.amountSubmitted)}<small>${PAYMENT_STATUSES[r.status]?.label}</small></div></div></td>
                    <td>${r.businessName}</td><td class="col-secondary">${ctx.workspaceName(r.workspaceTemplateId)}</td><td class="col-secondary">${r.planName}</td>
                    <td>${monthLong(r.period)}</td>
                    <td class="num">${peso(r.amountSubmitted)}${r.amountSubmitted !== r.amountDue ? html`<div class="stat-hint">of ${peso(r.amountDue)}</div>` : ""}</td>
                    <td class="col-secondary">${formatDayId(r.paymentDate)}</td>
                    <td>${payBadge(r.status)}</td>
                    <td class="row-actions" data-m="more"><button type="button" class="btn btn-compact${r.status === "for_verification" ? " btn-primary" : ""}" data-act="review" data-id="${r.id}">${r.status === "for_verification" ? "Review" : "View"}</button></td>
                  </tr>`
                )}</tbody></table></div>
              <div class="modal-footer"><button type="button" class="btn" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Previous</button><button type="button" class="btn" data-act="next" ${state.page.next ? "" : "disabled"}>Next</button></div>`
            : emptyState({ iconName: "check", title: f.status === "for_verification" ? "Nothing to verify" : "No payments match", body: f.status === "for_verification" ? "New subscription payments appear here for your review." : "" }),
        })}`
    );
  }

  async function review(id) {
    let d;
    try {
      d = await ctx.call("payment", { paymentId: id });
    } catch (err) {
      ctx.toast(err.message, "danger");
      return;
    }
    const p = d.payment;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    render(
      backdrop,
      html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="pay-title" data-role="payment-review">
        <div class="modal-header"><h2 class="card-title" id="pay-title">${p.businessName} · ${monthLong(p.period)}</h2>${payBadge(p.status)}</div>
        <div class="modal-body">
          <dl class="dl dl-compact">
            <dt>Workspace</dt><dd>${ctx.workspaceName(p.workspaceTemplateId)}</dd>
            <dt>Plan</dt><dd>${p.planName}</dd>
            <dt>Billing month</dt><dd>${monthLong(p.period)}</dd>
            <dt>Expected amount</dt><dd>${peso(p.amountDue)}${d.invoice && d.invoice.amountPaid ? ` (${peso(d.invoice.amountPaid)} already paid)` : ""}</dd>
            <dt>Submitted amount</dt><dd data-role="submitted"><b>${peso(p.amountSubmitted)}</b></dd>
            <dt>Payment date</dt><dd>${formatDayId(p.paymentDate)}</dd>
            <dt>Reference</dt><dd>${p.reference}</dd>
            ${p.note ? html`<dt>Note</dt><dd>${p.note}</dd>` : ""}
            <dt>Sent by</dt><dd>${p.submittedBy ?? "—"}</dd>
            ${p.rejectionReason ? html`<dt>Rejected because</dt><dd>${p.rejectionReason}</dd>` : ""}
            ${p.verifiedBy ? html`<dt>Confirmed by</dt><dd>${p.verifiedBy}</dd>` : ""}
          </dl>
          <div class="proof-box" data-role="proof">${p.hasProof ? html`<span class="stat-hint">Loading the screenshot…</span>` : html`<span class="stat-hint">No proof attached</span>`}</div>
          ${d.history.length
            ? html`<h3 class="section-title">Earlier payments from this business</h3><ul class="items" data-role="history">${d.history.map((h) => html`<li><div class="item"><span class="item-main"><span class="item-title">${monthLong(h.period)}</span><span class="item-sub">${formatDayId(h.paymentDate)} · ref ${h.reference}${h.rejectionReason ? ` · ${h.rejectionReason}` : ""}</span></span><span class="item-end">${peso(h.amountSubmitted)}<small>${PAYMENT_STATUSES[h.status]?.label}</small></span></div></li>`)}</ul>`
            : ""}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-act="close">Close</button>
          ${p.status === "for_verification" ? html`<button type="button" class="btn btn-danger" data-act="reject">Reject payment</button><button type="button" class="btn btn-primary" data-act="confirm">Confirm payment</button>` : ""}
        </div>
      </div>`
    );
    if (p.hasProof) {
      ctx
        .call("paymentProof", { paymentId: id })
        .then(({ proof }) => {
          const box = backdrop.querySelector('[data-role="proof"]');
          if (!box) return;
          const url = `data:${proof.contentType};base64,${proof.dataBase64}`;
          render(box, proof.contentType === "application/pdf" ? html`<a class="btn" href="${url}" download="payment-${id}.pdf">Download the PDF receipt</a>` : html`<img class="proof-img" src="${url}" alt="Payment screenshot from ${p.businessName}" />`);
        })
        .catch(() => {
          const box = backdrop.querySelector('[data-role="proof"]');
          if (box) render(box, html`<span class="stat-hint">Couldn't load the proof.</span>`);
        });
    }
    backdrop.onclick = async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "close") return close();
      if (act === "confirm") {
        const ok = await confirmDialog({ title: `Confirm ${peso(p.amountSubmitted)} from ${p.businessName}?`, body: `Only confirm if the money is in Luna's account. ${monthLong(p.period)} is credited, the renewal moves and the revenue is recorded.`, confirmLabel: "Confirm payment" });
        if (!ok) return;
        try {
          const r = await ctx.call("confirmPayment", { paymentId: id });
          ctx.toast(r.alreadyDecided ? "Already decided: nothing changed." : r.invoiceStatus === "paid" ? `Confirmed. Paid through ${formatDayId(r.paidThrough)}.` : "Confirmed. Part of the bill is still due.", "success");
          close();
          load();
        } catch (err) {
          ctx.toast(err.message, "danger");
        }
      }
      if (act === "reject") {
        const r = await formDialog({ title: "Reject this payment?", intro: "The business sees your reason and can send a corrected proof. The submission stays in the history.", fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }], submitLabel: "Reject payment", onSubmit: (v) => ctx.call("rejectPayment", { paymentId: id, reason: v.reason }) });
        if (r) {
          ctx.toast(r.alreadyDecided ? "Already decided: nothing changed." : "Payment rejected. The business was told why.", "success");
          close();
          load();
        }
      }
    };
  }

  async function settings() {
    let s = null;
    try {
      s = (await ctx.call("billingSettings")).settings;
    } catch (err) {
      ctx.toast(err.message, "danger");
      return;
    }
    const r = await formDialog({
      title: "Luna payment settings",
      intro: "One bank account for every workspace: every business's Subscription page shows these details.",
      fields: [
        { name: "bankName", label: "Bank name", value: s?.bankName ?? "", required: true },
        { name: "accountName", label: "Account name", value: s?.accountName ?? "", required: true },
        { name: "accountNumber", label: "Account number", value: s?.accountNumber ?? "", required: true },
        { name: "instructions", label: "Payment instructions (optional)", type: "textarea", value: s?.instructions ?? "" },
      ],
      submitLabel: "Save",
      onSubmit: (v) => ctx.call("saveBillingSettings", { settings: { bankName: v.bankName, accountName: v.accountName, accountNumber: v.accountNumber, ...(v.instructions.trim() ? { instructions: v.instructions } : {}) } }),
    });
    if (r) ctx.toast("Payment settings saved.", "success");
  }

  el.onsubmit = (e) => {
    if (e.target.dataset.role !== "filters") return;
    e.preventDefault();
    const x = e.target.elements;
    state.filters = Object.fromEntries([["status", x.status.value], ["workspaceTemplateId", x.workspaceTemplateId.value], ["period", x.period.value], ["businessId", x.businessId.value.trim()]].filter(([, v]) => v));
    state.cursors = [null];
    load();
  };
  el.onclick = (e) => {
    const t = e.target.closest("[data-act]");
    const act = t?.dataset.act;
    if (act === "review") review(t.dataset.id);
    else if (act === "settings") settings();
    else if (act === "next") {
      state.cursors.push(state.page.next);
      load();
    } else if (act === "prev") {
      state.cursors.pop();
      load();
    }
  };
  load();
}

// ---------- Usage: workspace usage, and provider bills apart ----------

const TABS = { usage: "Workspace usage", costs: "Provider bills" };
const ofLimit = (used, limit, fmt = formatNumber) => (limit === null || limit === undefined || (fmt === formatNumber && limit >= NO_LIMIT_FROM) ? fmt(used) : `${fmt(used)} of ${fmt(limit)}`);

export function usageCostView(el, ctx) {
  const params = new URLSearchParams(ctx.search || "");
  const state = { tab: Object.hasOwn(TABS, params.get("tab")) ? params.get("tab") : "usage", month: currentMonth(), cursors: [null] };
  const tabs = () => html`<div class="seg" role="tablist" aria-label="Usage sections" data-role="usage-tabs">${Object.entries(TABS).map(([k, l]) => html`<button type="button" class="seg-btn${state.tab === k ? " is-on" : ""}" role="tab" aria-pressed="${state.tab === k}" data-tab="${k}">${l}</button>`)}</div>`;
  const header = () => pageHeader({ title: "Usage", actions: html`<button type="button" class="btn btn-compact" data-act="refresh">Refresh</button>` });
  const monthPicker = () => html`<label class="field-inline">Month <input class="input" type="month" name="month" data-role="month" value="${state.month}" aria-label="Month" /></label>`;

  async function drawUsage() {
    render(el, html`${header()}${tabs()}${card({ body: emptyState({ title: "Loading…" }) })}`);
    let page;
    try {
      page = await ctx.call("usageOverview", { after: state.cursors.at(-1) });
    } catch (err) {
      render(el, html`${header()}${tabs()}${card({ body: emptyState({ title: "Couldn't load", body: err.message }) })}`);
      return;
    }
    const rows = page.rows;
    const sum = (k) => rows.reduce((t, r) => t + (r.usage[k] || 0), 0);
    render(
      el,
      html`${header()}${tabs()}
        <section class="card hero-card" data-role="usage-totals">
          ${kpiStrip([
            { id: "transfer", label: "Excel transfer", value: formatBytes(sum("transferBytes")), hint: "This month" },
            { id: "downloads", label: "Excel downloads", value: formatNumber(sum("downloads")), hint: "This month" },
            { id: "storage", label: "Storage", value: formatBytes(sum("storageBytes")), hint: "Kept now" },
            { id: "orders", label: "Orders", value: formatNumber(sum("orders")), hint: "This month" },
          ])}
        </section>
        ${section({
          title: "By business",
          id: "workspace-usage",
          body: html`<div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="workspace-usage">
            <thead><tr><th class="m-only"></th><th>Business</th><th>Active users</th><th>Storage</th><th>Excel</th><th>Orders</th></tr></thead>
            <tbody>${rows.map(
              (r) => html`<tr data-business="${r.id}">
                ${mobileCell({ title: r.name, sub: `${ofLimit(r.usage.users, r.usage.userLimit)} users · ${ofLimit(r.usage.storageBytes, r.usage.storageLimit, formatBytes)}`, end: formatBytes(r.usage.transferBytes), endSub: `${formatNumber(r.usage.downloads)} download${r.usage.downloads === 1 ? "" : "s"}` })}
                <td><a class="cell-strong" href="${ctx.base}/businesses?b=${r.id}" data-link>${r.name}</a><span class="cell-sub">${ctx.workspaceName(r.workspaceTemplateId)} · ${ctx.planName(r.planId)}</span></td>
                <td data-usage="users">${ofLimit(r.usage.users, r.usage.userLimit)}</td>
                <td data-usage="storage">${ofLimit(r.usage.storageBytes, r.usage.storageLimit, formatBytes)}</td>
                <td data-usage="excel">${formatNumber(r.usage.downloads)} <span class="stat-hint">· ${formatBytes(r.usage.transferBytes)}</span></td>
                <td data-usage="orders">${r.usage.orders === null ? html`<span class="stat-hint">—</span>` : formatNumber(r.usage.orders)}</td>
              </tr>`
            )}</tbody></table></div>
            <div class="pager"><button type="button" class="btn btn-compact" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Previous</button><button type="button" class="btn btn-compact" data-act="next" data-next="${page.next ?? ""}" ${page.next ? "" : "disabled"}>Next</button></div>`,
        })}
        <p class="stat-note" data-role="provider-note">Workspace usage is measured by Luna for each business. Firebase and Netlify bill the whole project: their dashboards are the exact source for provider usage and cost.</p>`
    );
  }

  async function drawCosts() {
    render(el, html`${header()}${tabs()}${card({ body: emptyState({ title: "Loading…" }) })}`);
    let list;
    try {
      list = await ctx.call("expenses", { month: state.month });
    } catch (err) {
      render(el, html`${header()}${tabs()}${card({ body: emptyState({ title: "Couldn't load", body: err.message }) })}`);
      return;
    }
    render(
      el,
      html`${header()}${tabs()}
        <div class="toolbar">${monthPicker()}<span class="toolbar-spacer"></span><button type="button" class="btn" data-act="copy">Copy recurring from last month</button><button type="button" class="btn btn-primary" data-act="add">Add cost</button></div>
        ${section({
          title: `Provider bills · ${monthLong(state.month)}`,
          hint: "Luna's own bills (Firebase, Netlify, email…), entered from each provider's invoice",
          id: "platform-expenses",
          body: list.rows.length
            ? html`<div class="table-wrap"><table class="table table-compact rows" data-role="expenses">
                <thead><tr><th class="m-only"></th><th>Provider / category</th><th>Description</th><th class="col-secondary">Kind</th><th class="col-secondary">Reference</th><th class="num">Amount</th><th></th></tr></thead>
                <tbody>${list.rows.map((x) => html`<tr data-expense="${x.id}">
                  <td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${PLATFORM_EXPENSE_CATEGORIES[x.category]?.label ?? x.category}</span><span class="m-sub">${x.description} · ${PLATFORM_EXPENSE_KINDS[x.kind]?.label ?? x.kind}</span></div><div class="m-end">${peso(x.amount)}</div></div></td>
                  <td>${PLATFORM_EXPENSE_CATEGORIES[x.category]?.label ?? x.category}${PLATFORM_EXPENSE_CATEGORIES[x.category]?.infra ? html` ${badge("Infrastructure", "info")}` : ""}</td>
                  <td>${x.description}${x.notes ? html`<div class="stat-hint">${x.notes}</div>` : ""}</td>
                  <td class="col-secondary">${PLATFORM_EXPENSE_KINDS[x.kind]?.label ?? x.kind}</td>
                  <td class="col-secondary">${x.reference ?? "—"}</td>
                  <td class="num">${peso(x.amount)}</td>
                  <td class="row-actions" data-m="more"><button type="button" class="btn btn-compact" data-act="edit" data-id="${x.id}">Edit</button><button type="button" class="btn btn-compact" data-act="remove" data-id="${x.id}">Remove</button></td>
                </tr>`)}</tbody>
                <tfoot><tr><td class="m-only"></td><th colspan="4">Total platform cost</th><th class="num" data-role="total">${peso(list.total)}</th><td></td></tr></tfoot></table></div>
              <p class="stat-note">Of which Firebase / Google Cloud and Netlify (the actual infrastructure bill): <b>${peso(list.infra)}</b>.</p>`
            : emptyState({ title: "No platform costs recorded", body: "Add Luna's own bills (Firebase / Google Cloud, Netlify, email, domain, other software). Nothing is assumed." }),
        })}`
    );
    el.dataset.rows = JSON.stringify(list.rows);
  }

  const draw = () => (state.tab === "costs" ? drawCosts() : drawUsage());

  const expenseFields = (x = {}) => [
    { name: "category", label: "Provider / category", type: "select", options: Object.entries(PLATFORM_EXPENSE_CATEGORIES).map(([value, c]) => ({ value, label: c.label })), value: x.category ?? "firebase_gcp" },
    { name: "description", label: "Description", value: x.description ?? "", required: true },
    { name: "amount", label: "Amount (₱)", value: x.amount ? (x.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
    { name: "kind", label: "Kind", type: "select", options: Object.entries(PLATFORM_EXPENSE_KINDS).map(([value, k]) => ({ value, label: k.label })), value: x.kind ?? "recurring" },
    { name: "reference", label: "Invoice / reference (optional)", value: x.reference ?? "" },
    { name: "notes", label: "Notes (optional)", type: "textarea", value: x.notes ?? "" },
  ];
  const toExpense = (v) => {
    const amount = Math.round(Number(String(v.amount).replace(/[₱,\s]/g, "")) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter an amount more than ₱0");
    return { category: v.category, description: v.description.trim(), amount, kind: v.kind, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) };
  };

  el.onchange = (e) => {
    if (e.target.dataset.role === "month" && e.target.value) {
      state.month = e.target.value;
      state.cursors = [null];
      draw();
    }
  };
  el.onclick = async (e) => {
    const t = e.target.closest("[data-tab], [data-act]");
    if (!t) return;
    try {
      if (t.dataset.tab) {
        state.tab = t.dataset.tab;
        draw();
        return;
      }
      const act = t.dataset.act;
      if (act === "next") {
        state.cursors.push(t.dataset.next);
        draw();
      } else if (act === "prev") {
        state.cursors.pop();
        draw();
      } else if (act === "add") {
        const r = await formDialog({ title: `Add a platform cost · ${monthLong(state.month)}`, fields: expenseFields(), onSubmit: (v) => ctx.call("addExpense", { expense: { month: state.month, ...toExpense(v) } }) });
        if (r) {
          ctx.toast("Cost added.", "success");
          draw();
        }
      } else if (act === "edit" || act === "remove") {
        const x = JSON.parse(el.dataset.rows || "[]").find((r) => r.id === t.dataset.id);
        if (!x) return;
        const r =
          act === "edit"
            ? await formDialog({ title: `Edit ${x.description}`, fields: expenseFields(x), onSubmit: (v) => ctx.call("editExpense", { expenseId: x.id, changes: toExpense(v) }) })
            : await formDialog({ title: `Remove ${x.description}?`, intro: "It stops counting toward the month's costs; the record and its history are kept.", fields: [{ name: "reason", label: "Reason", required: true }], submitLabel: "Remove", onSubmit: (v) => ctx.call("removeExpense", { expenseId: x.id, reason: v.reason }) });
        if (r) {
          ctx.toast(act === "edit" ? "Saved." : "Removed.", "success");
          draw();
        }
      } else if (act === "copy") {
        const r = await ctx.call("copyRecurring", { month: state.month });
        ctx.toast(r.copied ? `${r.copied} recurring cost${r.copied === 1 ? "" : "s"} copied.` : "Nothing new to copy.", "success");
        draw();
      } else if (act === "refresh") {
        draw();
      }
    } catch (err) {
      ctx.toast(err.message || "Something went wrong", "danger");
    }
  };
  draw();
}
