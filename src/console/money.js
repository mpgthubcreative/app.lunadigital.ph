// Super Luna: the Owner's business command center (Phase 18.6).
//   Overview       How is Luna doing? (money story, then the tenant counts)
//   Subscriptions  Who is subscribed, due, past due or suspended?
//   Payments       What money needs verification / what has been paid?
//   Usage          Who consumes resources and what does it cost Luna?
//                  (+ Luna's own platform costs and the cost rate card)
// Every read and write goes through POST /api/operator (ctx.call), which
// re-checks the operator. Revenue, costs and margins never reach tenants.

import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState, badge, section, kpiStrip, barRows } from "../components/ui.js";
import { formDialog } from "../components/form-dialog.js";
import { confirmDialog } from "../components/feedback.js";
import { lineChart, legend } from "../components/charts.js";
import { formatBytes, formatNumber, formatDayId } from "../lib/format.js";
import { SUBSCRIPTION_LABELS } from "@shared/index.js";
import { PAYMENT_STATUSES, INVOICE_STATUSES, PLATFORM_EXPENSE_CATEGORIES, PLATFORM_EXPENSE_KINDS, COST_RESOURCES, PROFIT_HELP } from "@shared/billing.js";

const peso = (c) => (c === null || c === undefined ? "—" : `${c < 0 ? "−" : ""}₱${(Math.abs(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pesoShort = (c) => `${c < 0 ? "−" : ""}₱${Math.round(Math.abs(c) / 100).toLocaleString("en-PH")}`;
const pct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const monthLabel = (p) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", timeZone: "UTC" });
const monthLong = (p) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });
const STATUS_TONE = { active: "success", past_due: "warning", suspended: "danger", cancelled: "neutral" };
const subBadge = (s) => badge(SUBSCRIPTION_LABELS[s] ?? s ?? "—", STATUS_TONE[s] || "neutral");
const payBadge = (s) => badge(PAYMENT_STATUSES[s]?.label ?? s, PAYMENT_STATUSES[s]?.tone ?? "neutral");
const loading = (title) => html`${pageHeader({ title })}${card({ body: emptyState({ title: "Loading…" }) })}`;
const failed = (title, err) => html`${pageHeader({ title })}${card({ body: emptyState({ title: "Couldn't load", body: err?.message || "Try again." }) })}`;
const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;
const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);

// ---------- Overview: the money story ----------

export function moneySections(m, ctx) {
  const ws = (id) => ctx.workspaceName(id);
  const maxRev = Math.max(1, ...m.revenueByWorkspace.map((w) => Math.max(w.revenue, w.mrr)));
  const trendPeriods = m.trend.map((t) => ({ label: monthLabel(t.period) }));
  return html`
    <section class="card hero-card" data-role="money">
      ${kpiStrip(
        [
          { id: "collected", label: "Collected this month", value: peso(m.collected), hint: "Verified payments only" },
          { id: "mrr", label: "Monthly recurring revenue", value: peso(m.mrr), hint: `${formatNumber(m.activeSubscriptions)} active / past-due subscriptions` },
          { id: "toCollect", label: "Still to collect", value: peso(m.stillToCollect), hint: "Due, not yet sent for review" },
          { id: "verify", label: "For verification", value: html`<a href="${ctx.base}/payments" data-link>${formatNumber(m.awaiting.count)} · ${peso(m.awaiting.amount)}</a>`, hint: m.awaiting.count ? "Waiting for you" : "Nothing waiting", hintTone: m.awaiting.count ? "warning" : undefined },
        ],
        { role: "money-kpis" }
      )}
    </section>
    <section class="card" data-role="profit">
      <div class="section-head"><h2>Cost and profit <span class="hint">${monthLong(m.period)}</span></h2><a class="link-more" href="${ctx.base}/usage?tab=costs" data-link>Platform costs ›</a></div>
      ${kpiStrip(
        [
          { id: "costs", label: "Platform costs this month", value: peso(m.platformCosts), hint: m.platformCosts ? `${peso(m.infraCosts)} of it Firebase / Netlify` : "None recorded yet" },
          { id: "gp", label: "Estimated platform gross profit", value: peso(m.estimatedGrossProfit), hint: "Collected − platform costs", hintTone: m.estimatedGrossProfit < 0 ? "danger" : undefined },
          { id: "margin", label: "Estimated gross margin", value: pct(m.estimatedGrossMargin), hint: m.collected ? "Gross profit ÷ collected" : "No revenue collected yet" },
        ],
        { role: "profit-kpis" }
      )}
      <details class="help-details"><summary>How is this calculated?</summary><p class="stat-note">${PROFIT_HELP}</p></details>
    </section>
    ${section({
      title: "Revenue, platform costs and estimated gross profit",
      hint: "last 12 months",
      id: "trend",
      body: html`${legend([{ cls: "fill-revenue", label: "Revenue (collected)" }, { cls: "fill-costs", label: "Platform costs (dashed)" }, { cls: "fill-gp", label: "Estimated gross profit" }])}
        <div class="chart-wrap">${lineChart(trendPeriods, [
          { label: "Revenue", short: "Rev", cls: "stroke-revenue", values: m.trend.map((t) => t.revenue) },
          { label: "Platform costs", short: "Cost", cls: "stroke-costs", values: m.trend.map((t) => t.costs), dashed: true },
          { label: "Estimated gross profit", short: "GP", cls: "stroke-gp", values: m.trend.map((t) => t.grossProfit) },
        ], { aria: `Last 12 months. This month: revenue ${peso(m.collected)}, platform costs ${peso(m.platformCosts)}, estimated gross profit ${peso(m.estimatedGrossProfit)}.` })}</div>
        <details class="help-details"><summary>Show the numbers</summary><div class="table-wrap"><table class="table table-compact" data-role="trend-table"><thead><tr><th>Month</th><th class="num">Revenue</th><th class="num">Platform costs</th><th class="num">Est. gross profit</th></tr></thead><tbody>${m.trend.map((t) => html`<tr><td>${monthLong(t.period)}</td><td class="num">${peso(t.revenue)}</td><td class="num">${peso(t.costs)}</td><td class="num">${peso(t.grossProfit)}</td></tr>`)}</tbody></table></div></details>`,
    })}
    <div class="grid grid-2 section">
      ${section({
        title: "Income by workspace",
        hint: "collected this month · MRR",
        id: "by-workspace",
        body: barRows(
          m.revenueByWorkspace.map((w) => ({ id: w.workspaceTemplateId, label: `${ws(w.workspaceTemplateId)} · ${formatNumber(w.subscriptions)} subscription${w.subscriptions === 1 ? "" : "s"}`, value: `${pesoShort(w.revenue)} · MRR ${pesoShort(w.mrr)}`, pct: (w.mrr / maxRev) * 100 })),
          { role: "workspace-bars" }
        ),
      })}
      ${section({
        title: "Due and past due",
        id: "due",
        link: { href: `${ctx.base}/subscriptions`, label: "Subscriptions" },
        body: m.dueThisMonth.length || m.pastDue.length
          ? html`<ul class="items" data-role="due-list">
              ${m.pastDue.map((b) => html`<li data-item="${b.businessId}"><a class="item" href="${ctx.base}/businesses?b=${b.businessId}" data-link><span class="item-main"><span class="item-title">${b.name}</span><span class="item-sub">${ws(b.workspaceTemplateId)} · ${ctx.planName(b.planId)} · ${b.paidThrough ? `paid through ${formatDayId(b.paidThrough)}` : "never paid"}</span></span><span class="item-end">${badge("Past due", "warning")}</span></a></li>`)}
              ${m.dueThisMonth.slice(0, 8).map((i) => html`<li data-item="${i.businessId}"><a class="item" href="${ctx.base}/businesses?b=${i.businessId}" data-link><span class="item-main"><span class="item-title">${i.businessName}</span><span class="item-sub">${ws(i.workspaceTemplateId)} · ${i.planName} · due ${formatDayId(i.dueDate)}</span></span><span class="item-end">${peso(i.amountDue - i.amountPaid)}<small>${INVOICE_STATUSES[i.status]?.label ?? i.status}</small></span></a></li>`)}
            </ul>`
          : emptyState({ iconName: "check", title: "Everyone is paid up", body: "No bills due or past due right now." }),
      })}
    </div>`;
}

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
    const rows = state.page.rows;
    render(
      el,
      html`${pageHeader({ title: "Subscriptions", subtitle: `Who subscribes to what, renewal dates and status. Bills are for ${monthLong(state.page.period)}.` })}
        <form class="filter-form toolbar" data-role="filters">
          <select class="select" name="status" aria-label="Status">${opt("", "Any status", f.status || "")}${Object.entries(SUBSCRIPTION_LABELS).map(([k, l]) => opt(k, l, f.status))}</select>
          <select class="select" name="workspaceTemplateId" aria-label="Workspace">${opt("", "Any workspace", f.workspaceTemplateId || "")}${ctx.workspaces.map((w) => opt(w.id, w.name, f.workspaceTemplateId))}</select>
          <button type="submit" class="btn">Apply</button>
        </form>
        ${card({
          body: rows.length
            ? html`<div class="table-wrap"><table class="table table-compact rows" data-role="subscriptions">
                <thead><tr><th class="m-only"></th><th>Business</th><th class="col-secondary">Workspace</th><th>Plan</th><th class="num">Monthly</th><th>Status</th><th class="col-secondary">Paid through</th><th class="col-secondary">Next renewal</th><th>This month</th></tr></thead>
                <tbody>${rows.map(
                  (r) => html`<tr data-business="${r.id}">
                    <td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${r.name}</span><span class="m-sub">${ctx.workspaceName(r.workspaceTemplateId)} · ${r.planName ?? ctx.planName(r.planId)} · ${peso(r.monthlyAmount)}/mo</span></div><div class="m-end">${subBadge(r.status)}<small>${r.bill ? INVOICE_STATUSES[r.bill.status]?.label : "No bill"}</small></div></div></td>
                    <td><a href="${ctx.base}/businesses?b=${r.id}" data-link>${r.name}</a></td>
                    <td class="col-secondary">${ctx.workspaceName(r.workspaceTemplateId)}</td>
                    <td>${r.planName ?? ctx.planName(r.planId)}</td>
                    <td class="num">${peso(r.monthlyAmount)}</td>
                    <td>${subBadge(r.status)}</td>
                    <td class="col-secondary">${r.paidThrough ? formatDayId(r.paidThrough) : "—"}</td>
                    <td class="col-secondary">${r.nextRenewal ? formatDayId(r.nextRenewal) : "—"}</td>
                    <td>${r.bill ? html`${badge(INVOICE_STATUSES[r.bill.status]?.label ?? r.bill.status, INVOICE_STATUSES[r.bill.status]?.tone ?? "neutral")} <span class="stat-hint">${peso(r.bill.amountDue - r.bill.amountPaid)} left</span>` : html`<span class="stat-hint">Not billed</span>`}</td>
                  </tr>`
                )}</tbody></table></div>
              <div class="modal-footer"><button type="button" class="btn" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Previous</button><button type="button" class="btn" data-act="next" ${state.page.next ? "" : "disabled"}>Next</button></div>`
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
  el.onclick = (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "next") {
      state.cursors.push(state.page.next);
      load();
    } else if (act === "prev") {
      state.cursors.pop();
      load();
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

// ---------- Usage: consumption and what it costs Luna ----------

const TABS = { usage: "Usage & cost", costs: "Platform costs", rates: "Cost rates" };

export function usageCostView(el, ctx) {
  const params = new URLSearchParams(ctx.search || "");
  const state = { tab: Object.hasOwn(TABS, params.get("tab")) ? params.get("tab") : "usage", month: currentMonth(), cursors: [null] };
  const tabs = () => html`<div class="seg" role="tablist" aria-label="Usage sections" data-role="usage-tabs">${Object.entries(TABS).map(([k, l]) => html`<button type="button" class="seg-btn" role="tab" aria-pressed="${state.tab === k}" data-tab="${k}">${l}</button>`)}</div>`;
  const header = () => pageHeader({ title: "Usage", subtitle: "Who consumes Luna's resources, how much, and approximately what it costs Luna. Estimates, not the provider's invoice." });
  const monthPicker = () => html`<label class="field-inline">Month <input class="input" type="month" name="month" data-role="month" value="${state.month}" aria-label="Month" /></label>`;

  async function drawUsage() {
    render(el, html`${header()}${tabs()}${card({ body: emptyState({ title: "Loading…" }) })}`);
    let econ, page, exp;
    try {
      [econ, page, exp] = await Promise.all([ctx.call("economics", { period: state.month }), ctx.call("usageCost", { period: state.month, after: state.cursors.at(-1) }), ctx.call("expenses", { month: state.month })]);
    } catch (err) {
      render(el, html`${header()}${tabs()}${card({ body: emptyState({ title: "Couldn't load", body: err.message }) })}`);
      return;
    }
    const diff = exp.infra - econ.estimatedTotal;
    const unmeasured = Object.entries(COST_RESOURCES).filter(([, r]) => !r.measured).map(([, r]) => r.label);
    const econRows = (rows, label) => html`<div class="table-wrap"><table class="table table-compact" data-role="economics-${label}">
      <thead><tr><th>${label === "workspace" ? "Workspace" : "Plan"}</th><th class="num">Subscribers</th><th class="num">Revenue</th><th class="num">Direct est. cost</th><th class="num">Est. gross profit</th><th class="num">Margin</th></tr></thead>
      <tbody>${rows.map((g) => html`<tr data-key="${g.key}"><td>${label === "workspace" ? ctx.workspaceName(g.key) : ctx.planName(g.key)}</td><td class="num">${formatNumber(g.subscribers)}</td><td class="num">${peso(g.revenue)}</td><td class="num">${peso(g.estimatedCost)}</td><td class="num">${peso(g.estimatedGrossProfit)}</td><td class="num">${pct(g.margin)}</td></tr>`)}</tbody></table></div>`;
    render(
      el,
      html`${header()}${tabs()}
        <div class="toolbar">${monthPicker()}</div>
        <section class="card hero-card" data-role="cost-summary">
          ${kpiStrip([
            { id: "estimate", label: "Estimated usage cost", value: peso(econ.estimatedTotal), hint: page.ratesConfigured ? "Measured usage × cost rates" : "Add cost rates to estimate" },
            { id: "actual", label: "Actual infrastructure bill", value: exp.infra ? peso(exp.infra) : "Not entered", hint: "Firebase / Google Cloud + Netlify, entered manually", empty: !exp.infra },
            { id: "difference", label: "Difference", value: exp.infra ? peso(diff) : "—", hint: exp.infra ? (diff >= 0 ? "Bill above the estimate" : "Bill below the estimate") : "Enter the bill under Platform costs" },
          ])}
          <p class="stat-note">Measured per business today: storage retained and Excel downloads. ${unmeasured.join(", ")}: <b>Unavailable</b> per business (not metered yet), so they're never guessed from orders or page views. Shared costs (e.g. a Netlify subscription) aren't split across businesses.</p>
        </section>
        <div class="grid grid-2 section">
          ${section({ title: "By workspace", hint: "revenue − direct estimated cost", id: "econ-workspace", body: econRows(econ.byWorkspace, "workspace") })}
          ${section({ title: "By plan", hint: "revenue − direct estimated cost", id: "econ-plan", body: econRows(econ.byPlan, "plan") })}
        </div>
        ${section({
          title: "By business",
          hint: `${monthLong(state.month)} · commercial usage, then infrastructure`,
          id: "by-tenant",
          body: html`<div class="table-wrap"><table class="table table-compact rows" data-role="usage-cost">
            <thead><tr><th class="m-only"></th><th>Business</th><th class="num">Orders</th><th class="num">Excel exports</th><th class="num col-secondary">Rows exported</th><th class="num">Storage</th><th class="num col-secondary">Downloads</th><th class="num">Est. cost</th><th class="num">Revenue</th><th class="num">Direct margin</th></tr></thead>
            <tbody>${page.rows.map((r) => {
              const lim = r.limits || {};
              return html`<tr data-business="${r.id}">
                <td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${r.name}</span><span class="m-sub">${ctx.workspaceName(r.workspaceTemplateId)} · ${ctx.planName(r.planId)} · ${formatBytes(r.commercial.storageBytes)}</span></div><div class="m-end">${peso(r.estimate.total)}<small>est. cost</small></div></div></td>
                <td><a href="${ctx.base}/businesses?b=${r.id}" data-link>${r.name}</a><div class="stat-hint">${ctx.workspaceName(r.workspaceTemplateId)} · ${ctx.planName(r.planId)}</div></td>
                <td class="num">${formatNumber(r.commercial.orders)}${lim.ordersPerMonth ? html` <span class="stat-hint">/ ${formatNumber(lim.ordersPerMonth)}</span>` : ""}</td>
                <td class="num">${formatNumber(r.commercial.exports)}</td>
                <td class="num col-secondary">${formatNumber(r.commercial.rowsExported)}</td>
                <td class="num">${formatBytes(r.commercial.storageBytes)}${lim.storageBytes ? html` <span class="stat-hint">/ ${formatBytes(lim.storageBytes)}</span>` : ""}</td>
                <td class="num col-secondary">${r.infrastructure.exportBytes === null ? "Unavailable" : formatBytes(r.infrastructure.exportBytes)}</td>
                <td class="num">${peso(r.estimate.total)}</td>
                <td class="num">${peso(r.revenue)}</td>
                <td class="num">${peso(r.directMargin)}</td>
              </tr>`;
            })}</tbody></table></div>
            <div class="modal-footer"><button type="button" class="btn" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Previous</button><button type="button" class="btn" data-act="next" data-next="${page.next ?? ""}" ${page.next ? "" : "disabled"}>Next</button></div>`,
        })}`
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
          title: `Platform expenses · ${monthLong(state.month)}`,
          hint: "Luna's own costs, never a business's Expenses",
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

  async function drawRates() {
    render(el, html`${header()}${tabs()}${card({ body: emptyState({ title: "Loading…" }) })}`);
    let rates;
    try {
      rates = (await ctx.call("costRates")).rates;
    } catch (err) {
      render(el, html`${header()}${tabs()}${card({ body: emptyState({ title: "Couldn't load", body: err.message }) })}`);
      return;
    }
    render(
      el,
      html`${header()}${tabs()}
        <div class="toolbar"><span class="toolbar-spacer"></span><button type="button" class="btn btn-primary" data-act="add-rate">Add rate</button></div>
        ${section({
          title: "Cost rates",
          hint: "versioned: a new rate never changes an earlier month",
          id: "rates",
          body: rates.length
            ? html`<div class="table-wrap"><table class="table table-compact" data-role="rates">
                <thead><tr><th>Resource</th><th class="col-secondary">Provider</th><th>Unit</th><th class="num">Rate (₱)</th><th class="num col-secondary">Free allowance</th><th>Effective from</th><th class="col-secondary">Measured per business</th></tr></thead>
                <tbody>${rates.map((r) => html`<tr data-rate="${r.id}"><td>${COST_RESOURCES[r.resource]?.label ?? r.resource}</td><td class="col-secondary">${PLATFORM_EXPENSE_CATEGORIES[r.provider]?.label ?? r.provider}</td><td>${r.unit}</td><td class="num">${(r.ratePerUnit / 100).toLocaleString("en-PH", { maximumFractionDigits: 6 })}</td><td class="num col-secondary">${formatNumber(r.freeAllowance)}</td><td>${formatDayId(r.effectiveFrom)}</td><td class="col-secondary">${COST_RESOURCES[r.resource]?.measured ? "Yes" : "Unavailable"}</td></tr>`)}</tbody></table></div>`
            : emptyState({ title: "No cost rates yet", body: "Add the provider rates you want Luna to estimate with (e.g. storage per GB-month). Nothing is hard-coded." }),
        })}`
    );
  }

  const draw = () => (state.tab === "costs" ? drawCosts() : state.tab === "rates" ? drawRates() : drawUsage());

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
      } else if (act === "add-rate") {
        const r = await formDialog({
          title: "Add a cost rate",
          intro: "A new version from its effective date. Earlier months keep the rate they were estimated with.",
          fields: [
            { name: "resource", label: "Resource", type: "select", options: Object.entries(COST_RESOURCES).map(([value, c]) => ({ value, label: `${c.label} (per ${c.unit})${c.measured ? "" : " · not measured per business"}` })), value: "storage_gb_month" },
            { name: "rate", label: "Rate in pesos per unit", inputmode: "decimal", required: true, hint: "e.g. 1.50 for ₱1.50 per GB-month" },
            { name: "effectiveFrom", label: "Effective from", type: "date", value: `${currentMonth()}-01`, required: true },
            { name: "freeAllowance", label: "Free allowance per month (units, optional)", inputmode: "decimal", value: "0" },
            { name: "note", label: "Note (optional)" },
          ],
          onSubmit: (v) => {
            const rate = Number(String(v.rate).replace(/[₱,\s]/g, ""));
            if (!Number.isFinite(rate) || rate < 0) throw new Error("Enter a rate of ₱0 or more");
            return ctx.call("addCostRate", { rate: { resource: v.resource, ratePerUnit: Math.round(rate * 100 * 10000) / 10000, effectiveFrom: v.effectiveFrom, freeAllowance: Number(v.freeAllowance) || 0, ...(v.note.trim() ? { note: v.note.trim() } : {}) } });
          },
        });
        if (r) {
          ctx.toast("Rate added.", "success");
          draw();
        }
      }
    } catch (err) {
      ctx.toast(err.message || "Something went wrong", "danger");
    }
  };
  draw();
}
