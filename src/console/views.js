// Luna Super Admin console views. Every read and write goes through POST
// /api/operator (ctx.call), which re-checks the operator on every request;
// nothing here talks to Firestore directly, and nothing the browser holds
// decides access. The browser sends intent (business id + plan id +
// reason), never entitlement objects or permission lists.
//
// Super Admin consolidation (2026-10-19): understood in 3 seconds.
// Important state first, one obvious action, secondary actions under ⋯,
// destructive ones confirmed, compact rows, phone-first.

import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState, badge, kpiStrip, mobileCell, rowMenu } from "../components/ui.js";
import { formDialog } from "../components/form-dialog.js";
import { confirmDialog } from "../components/feedback.js";
import { planWorkspace, isCatalogPlan, priceLabel, planBilling, businessIdFromName, BILLING_TYPES, SUBSCRIPTION_LABELS, OVERRIDE_CHOICES, ROLE_TEMPLATES, METERS, MONTHLY_METER_IDS, overrideImpact, NO_LIMIT_FROM } from "@shared/index.js";
import { formatBytes, formatNumber } from "../lib/format.js";
import { invitationDesignView } from "./design.js";
import { apiDownload } from "../lib/api.js";
import { saveBlob } from "../lib/export.js";
import { peso, dateText, whenText, stateChip, subscriptionMenu, toggleMenus, runSubscriptionAction, billingTypeLabel } from "./actions.js";

const when = (iso) => (iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—");
const loading = (title) => html`${pageHeader({ title })}${card({ body: emptyState({ title: "Loading…" }) })}`;
const failed = (title, err) => html`${pageHeader({ title })}${card({ body: emptyState({ title: "Couldn't load", body: err?.message || "Try again." }) })}`;
const plansFor = (ctx, workspaceId) => ctx.plans.filter((p) => planWorkspace(p) === workspaceId && isCatalogPlan(p));
const pagers = (state) => html`<div class="pager"><button type="button" class="btn btn-compact" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Previous</button><button type="button" class="btn btn-compact" data-act="next" ${state.page?.next ? "" : "disabled"}>Next</button></div>`;
// "2 of 4", "184 MB of 1 GB"; a count with no limit is just the count.
const ofLimit = (used, limit, fmt = formatNumber) => (limit === null || limit === undefined || (fmt === formatNumber && limit >= NO_LIMIT_FROM) ? fmt(used) : `${fmt(used)} of ${fmt(limit)}`);

// ---------- Overview ----------
// Active access, recurring income, annual / 12-month income, Needs
// Attention (real dates) and Income by Workspace. No cost or profit here.

export async function overviewView(el, ctx) {
  render(el, loading("Overview"));
  let o;
  try {
    o = (await ctx.call("overview")).overview;
  } catch (err) {
    render(el, failed("Overview", err));
    return;
  }
  const rows = o.needsAttention;
  const draw = () =>
    render(
      el,
      html`${pageHeader({ title: "Overview" })}
        <section class="card hero-card" data-role="overview-kpis">
          ${kpiStrip(
            [
              { id: "active", label: "Active subscriptions", value: formatNumber(o.activeAccess), hint: "Paying or with access now" },
              { id: "recurring", label: "Recurring income", value: `${peso(o.recurringIncome)}`, hint: "Distributor, per month" },
              { id: "annual", label: "Annual / 12-month income", value: peso(o.annualIncomeThisMonth), hint: "Collected this month" },
            ],
            { role: "kpis" }
          )}
          ${o.awaiting.count ? html`<p class="stat-note" data-role="awaiting"><a href="${ctx.base}/payments" data-link>${formatNumber(o.awaiting.count)} payment${o.awaiting.count === 1 ? "" : "s"} to verify · ${peso(o.awaiting.amount)}</a></p>` : ""}
        </section>
        <section class="card section" data-role="attention">
          <div class="card-header"><h2 class="card-title">Needs attention</h2><span class="stat-hint">${rows.length ? `${rows.length}` : ""}</span></div>
          ${rows.length
            ? html`<div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="attention-rows">
                <thead><tr><th class="m-only"></th><th>Name / plan</th><th>Date</th><th>Status</th><th></th></tr></thead>
                <tbody>${rows.map(
                  (r) => html`<tr data-business="${r.id}" data-kind="${r.attention.kind}">
                    ${mobileCell({ title: r.name, sub: `${r.planName ?? ""} · ${whenText(r)}`, end: stateChip(r) })}
                    <td><span class="cell-strong">${r.name}</span><span class="cell-sub">${r.planName ?? ctx.planName(r.planId)}</span></td>
                    <td data-role="when">${whenText(r)}${r.attention.kind === "overdue" ? html`<span class="cell-sub tone-danger">${r.attention.label}</span>` : ""}</td>
                    <td>${stateChip(r)}</td>
                    <td class="row-actions" data-m="more">${subscriptionMenu(r)}</td>
                  </tr>`
                )}</tbody></table></div>`
            : html`<p class="all-clear" data-role="all-clear">✓ Nobody is due, overdue or expiring.</p>`}
        </section>
        <section class="card section" data-role="income">
          <div class="card-header"><h2 class="card-title">Income by workspace</h2></div>
          <ul class="sa-income">${o.incomeByWorkspace.map(
            (w) => html`<li data-workspace="${w.workspaceTemplateId}">
              <span class="sa-income-name">${ctx.workspaceName(w.workspaceTemplateId)}<small>${w.billingType === "monthly" ? `Recurring · ${formatNumber(w.active)} active` : w.billingType === "annual" ? `Annual renewals collected this month · ${formatNumber(w.active)} active` : `12-month access collected this month · ${formatNumber(w.active)} active`}</small></span>
              <strong class="sa-income-value">${w.billingType === "monthly" ? html`${peso(w.recurring)}<small>/ month</small>` : peso(w.collected)}</strong>
            </li>`
          )}</ul>
        </section>`
    );
  draw();
  el.onclick = async (e) => {
    if (toggleMenus(e, el)) return;
    const t = e.target.closest("[data-act]");
    if (!t || !t.dataset.act.startsWith("s-")) return;
    const r = rows.find((x) => x.id === t.dataset.id);
    if (r && (await runSubscriptionAction(ctx, t.dataset.act, r))) overviewView(el, ctx);
  };
}

// ---------- Businesses ----------

export function businessesView(el, ctx) {
  const params = new URLSearchParams(ctx.search || "");
  if (params.get("b") && params.get("design")) return invitationDesignView(el, ctx, params.get("b"));
  if (params.get("b")) return businessDetailView(el, ctx, params.get("b"));
  const state = { filters: {}, cursors: [null], page: null, error: null, loading: true };
  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;
  // The sold plans of the chosen workspace (all workspaces: every sold plan).
  const planOptions = (workspaceId, sel) => html`${opt("", "All plans", sel || "")}${ctx.plans.filter((p) => isCatalogPlan(p) && (!workspaceId || planWorkspace(p) === workspaceId)).map((p) => opt(p.id, p.name, sel))}`;

  async function load() {
    state.loading = true;
    draw();
    try {
      state.page = await ctx.call("listBusinesses", { filters: state.filters, after: state.cursors.at(-1) });
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    state.loading = false;
    draw();
  }

  function draw() {
    const f = state.filters;
    const rows = state.page?.rows || [];
    render(
      el,
      html`${pageHeader({ title: "Businesses", actions: html`<button type="button" class="btn btn-primary" data-act="create">Create business</button>` })}
        <form class="section card filters filters-inline sa-filters" data-role="filters">
          <input class="input" name="search" placeholder="Search name or ID" value="${f.search || ""}" autocomplete="off" aria-label="Search" />
          <select class="select" name="workspaceTemplateId" aria-label="Workspace">${opt("", "All workspaces", f.workspaceTemplateId || "")}${ctx.workspaces.map((w) => opt(w.id, w.name, f.workspaceTemplateId))}</select>
          <select class="select" name="planId" aria-label="Plan">${planOptions(f.workspaceTemplateId, f.planId)}</select>
          <select class="select" name="status" aria-label="Status">${opt("", "All statuses", f.status || "")}${Object.entries(SUBSCRIPTION_LABELS).map(([k, l]) => opt(k, l, f.status))}</select>
          <button type="submit" class="btn">Apply</button>
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error.message })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !rows.length
                ? emptyState({ iconName: "businesses", title: "No businesses match" })
                : html`<div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="businesses">
                    <thead><tr><th class="m-only"></th><th>Name</th><th>Workspace</th><th>Plan</th><th>Status</th><th></th></tr></thead>
                    <tbody>${rows.map(
                      (b) => html`<tr data-business="${b.id}">
                        ${mobileCell({ title: b.name, sub: `${ctx.workspaceName(b.workspaceTemplateId)} · ${b.planName ?? ctx.planName(b.planId)}`, end: stateChip(b) })}
                        <td><a class="cell-strong" href="${ctx.base}/businesses?b=${b.id}" data-link>${b.name}</a></td>
                        <td>${ctx.workspaceName(b.workspaceTemplateId)}</td>
                        <td>${b.planName ?? ctx.planName(b.planId)}</td>
                        <td>${stateChip(b)}</td>
                        <td class="row-actions" data-m="more">${subscriptionMenu(b)}</td>
                      </tr>`
                    )}</tbody></table></div>
                  ${pagers(state)}`}
        </section>`
    );
  }

  el.onsubmit = (e) => {
    if (e.target.dataset.role !== "filters") return;
    e.preventDefault();
    const x = e.target.elements;
    state.filters = Object.fromEntries([["search", x.search.value.trim()], ["workspaceTemplateId", x.workspaceTemplateId.value], ["planId", x.planId.value], ["status", x.status.value]].filter(([, v]) => v));
    state.cursors = [null];
    load();
  };
  // Workspace first: the Plan list follows it.
  el.onchange = (e) => {
    if (e.target.name !== "workspaceTemplateId" || e.target.form?.dataset.role !== "filters") return;
    const planSel = e.target.form.elements.planId;
    const keep = ctx.plans.some((p) => p.id === planSel.value && planWorkspace(p) === e.target.value) ? planSel.value : "";
    render(planSel, planOptions(e.target.value, keep));
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
    } else if (act === "create") {
      const r = await createBusinessDialog(ctx);
      if (r) ctx.navigate(`/businesses?b=${r.businessId}`);
    } else if (act?.startsWith("s-")) {
      const r = (state.page?.rows || []).find((x) => x.id === t.dataset.id);
      if (r && (await runSubscriptionAction(ctx, act, r))) load();
    }
  };
  load();
}

// ---------- Create business ----------
// Workspace first; the plan list, billing type, price and limits follow
// it. The business ID is made from the name (editable under Advanced).

const limitsText = (p) => `${formatNumber(p.limits.users)} user${p.limits.users === 1 ? "" : "s"} · ${formatBytes(p.limits.storageBytes)}`;
export function createBusinessDialog(ctx) {
  const ws = ctx.workspaces.filter((w) => plansFor(ctx, w.id).length);
  const first = ws[0]?.id;
  const firstPlans = plansFor(ctx, first);
  const firstPlan = firstPlans.find((p) => p.recommended) ?? firstPlans[0];
  let idTouched = false;
  return formDialog({
    title: "Create business",
    fields: [
      { name: "workspaceTemplateId", label: "Workspace", type: "select", options: ws.map((w) => ({ value: w.id, label: w.name })), value: first },
      { name: "planId", label: "Plan", type: "select", options: firstPlans.map((p) => ({ value: p.id, label: p.name })), value: firstPlan?.id, hint: firstPlan ? `${priceLabel(firstPlan)} · ${limitsText(firstPlan)}` : "" },
      { name: "name", label: "Business / workspace name", required: true },
      { name: "ownerName", label: "Owner name", required: true },
      { name: "ownerEmail", label: "Owner email", required: true, inputmode: "email" },
      { name: "founding", label: "Price", type: "select", options: [{ value: "no", label: "Regular price" }, { value: "yes", label: "Founding price" }], value: "no", more: true, default: true },
      { name: "businessId", label: "Business ID", hint: "Made from the name. Permanent.", more: true, default: true },
      { name: "timezone", label: "Timezone", value: "Asia/Manila", more: true, default: true },
    ],
    moreLabel: "Advanced",
    submitLabel: "Create business",
    onFormChange: (form) => {
      const els = form.elements;
      const list = plansFor(ctx, els.workspaceTemplateId.value);
      if (![...els.planId.options].every((o) => list.some((p) => p.id === o.value)) || els.planId.options.length !== list.length) {
        render(els.planId, html`${list.map((p) => html`<option value="${p.id}" ${p.recommended ? "selected" : ""}>${p.name}</option>`)}`);
      }
      const plan = list.find((p) => p.id === els.planId.value) ?? list[0];
      const hint = els.planId.closest(".field")?.querySelector(".stat-hint");
      if (hint && plan) hint.textContent = `${priceLabel(plan)} · ${limitsText(plan)}${planBilling(plan).type === "term" ? " · no automatic renewal" : ""}`;
      const fp = plan ? planBilling(plan).founding : null;
      const fSel = els.founding;
      if (fSel) fSel.options[1].textContent = fp ? `Founding price (${fp.label ?? peso(fp.price)})` : "Founding price (none for this plan)";
      if (fSel) fSel.options[1].disabled = !fp;
      if (!idTouched && els.businessId) els.businessId.value = businessIdFromName(els.name.value);
      if (els.businessId && !els.businessId.dataset.watch) {
        els.businessId.dataset.watch = "1";
        els.businessId.addEventListener("input", () => (idTouched = true));
      }
    },
    onSubmit: async (v) => {
      const businessId = (v.businessId || businessIdFromName(v.name)).trim().toLowerCase();
      if (!businessId) throw new Error("Enter a name (or a Business ID under Advanced)");
      const r = await ctx.call("createBusiness", { business: { name: v.name, businessId, workspaceTemplateId: v.workspaceTemplateId, planId: v.planId, ownerName: v.ownerName, ownerEmail: v.ownerEmail, timezone: v.timezone || "Asia/Manila", founding: v.founding === "yes" } });
      ctx.toast(r.created ? "Business created." : "Already created: nothing was duplicated.", "success");
      return r;
    },
  });
}

// ---------- One business ----------

export async function businessDetailView(el, ctx, businessId) {
  render(el, loading("Business"));
  let d;
  try {
    d = await ctx.call("business", { businessId });
  } catch (err) {
    render(el, failed("Business", err));
    return;
  }
  const b = d.business;
  const r = { ...d.billing, name: b.name, workspaceTemplateId: b.workspaceTemplateId };
  const lim = d.limits || {};
  const u = d.current || {};
  const plan = d.plan;
  const ov = (v) => (v === true ? "Enabled" : v === false ? "Disabled" : "Default");
  const memberMenu = (m) =>
    rowMenu(m.uid, [
      { act: "m-link", label: "Setup link" },
      ...(m.isAccountOwner ? [] : [{ act: "m-status", label: m.status === "active" ? "Deactivate" : "Reactivate" }, { sep: true }, { act: "m-remove", label: "Remove member", danger: true }]),
    ], { label: `Actions for ${m.name || m.email}` });
  render(
    el,
    html`${pageHeader({ title: b.name, subtitle: `${b.workspaceName ?? b.workspaceTemplateId} · ${b.planName ?? b.planId}`, actions: html`<span class="sa-head-status">${stateChip(r)}</span>${b.status === "deleted" ? "" : html`<button type="button" class="btn btn-primary" data-act="s-pay" data-id="${b.id}">Record payment</button>`}${subscriptionMenu(r, { detail: true })}` })}
      ${b.entitlementsValid ? "" : html`<div class="banner banner-danger" role="alert">Entitlements are invalid (${b.entitlementProblems.join("; ")}). The business is blocked until they're recomputed.</div>`}
      ${b.status === "deleted" ? html`<div class="banner banner-danger" role="alert">Deleted. Access is off. Recoverable until ${dateText(r.purgeAfter)} (⋯ → Restore business).</div>` : ""}
      <div class="section grid grid-2">
        <section class="card" data-role="subscription">
          <h2 class="card-title">Subscription</h2>
          <dl class="dl dl-compact">
            <dt>Plan</dt><dd>${b.planName ?? b.planId}${plan ? html`<span class="cell-sub">${priceLabel(plan)}</span>` : ""}</dd>
            <dt>Billing</dt><dd>${billingTypeLabel(r.billingType)}${r.amount ? html` · ${peso(r.amount)}` : ""}</dd>
            <dt>${r.billingType === "term" ? "Access" : "Next"}</dt><dd data-role="when">${whenText(r)}</dd>
            ${r.paidThrough ? html`<dt>Paid through</dt><dd>${dateText(r.paidThrough)}</dd>` : ""}
            <dt>Started</dt><dd>${dateText(r.startDate)}</dd>
          </dl>
        </section>
        <section class="card" data-role="usage">
          <h2 class="card-title">Usage <span class="hint">this month</span></h2>
          <dl class="dl dl-compact sa-usage">
            <dt>Active users</dt><dd data-usage="users">${ofLimit(u.users ?? 0, lim.users)}</dd>
            <dt>Storage</dt><dd data-usage="storage">${ofLimit(u.storageBytes ?? 0, lim.storageBytes, formatBytes)}</dd>
            <dt>Excel downloads</dt><dd data-usage="downloads">${formatNumber(u.downloads ?? 0)}</dd>
            <dt>Excel transfer</dt><dd data-usage="transfer">${formatBytes(u.transferBytes ?? 0)}</dd>
            ${u.orders === null || u.orders === undefined ? "" : html`<dt>Orders</dt><dd data-usage="orders">${formatNumber(u.orders)}</dd>`}
          </dl>
        </section>
      </div>
      <section class="section card" id="members" data-role="members">
        <div class="card-header"><h2 class="card-title">Members</h2><button type="button" class="btn btn-compact" data-act="add-member">Add member</button></div>
        <div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="member-rows">
          <thead><tr><th class="m-only"></th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>${d.members.map(
            (m) => html`<tr data-member="${m.uid}">
              ${mobileCell({ title: m.name || m.email, sub: `${ROLE_TEMPLATES[m.roleTemplate]?.label ?? m.roleTemplate}${m.isAccountOwner ? " · Account owner" : ""}${m.seat ? "" : " · no seat"}`, end: m.status === "active" ? badge("Active", "success") : badge("Disabled", "neutral") })}
              <td><span class="cell-strong">${m.name || "—"}</span><span class="cell-sub">${m.email}</span></td>
              <td>${ROLE_TEMPLATES[m.roleTemplate]?.label ?? m.roleTemplate}${m.isAccountOwner ? html` ${badge("Owner", "primary")}` : ""}${m.seat ? "" : html` <span class="stat-hint">no seat</span>`}</td>
              <td>${m.status === "active" ? badge("Active", "success") : badge("Disabled", "neutral")}</td>
              <td class="row-actions" data-m="more">${memberMenu(m)}</td>
            </tr>`
          )}</tbody></table></div>
      </section>
      <details class="section card sa-advanced" data-role="advanced">
        <summary class="card-title">Advanced</summary>
        <div class="page-actions">
          <button type="button" class="btn btn-compact" data-act="general">Edit name / timezone</button>
          <button type="button" class="btn btn-compact" data-act="backup">Master Backup</button>
          ${b.workspaceTemplateId === "bridal-expense" ? html`<a class="btn btn-compact" href="${ctx.base}/businesses?b=${b.id}&design=1" data-link data-role="design-link">Invitation design</a>` : ""}
        </div>
        <dl class="dl dl-compact"><dt>Business ID</dt><dd>${b.id}</dd><dt>Timezone</dt><dd>${b.timezone}</dd><dt>Created</dt><dd>${when(b.createdAt)}${b.createdBy ? ` by ${b.createdBy}` : ""}</dd></dl>
        ${d.limitRows
          ? html`<h3 class="section-title">Limits for this business</h3>
            <ul class="sa-limits" data-role="limits">${d.limitRows.map((l) => {
              const f = limitFormat(l.unit);
              return html`<li data-limit="${l.limitKey}"><span>${l.label}<small>${l.unlimited ? "No limit" : `${f(l.current)} of ${l.effective === null ? "—" : f(l.effective)}`}${l.override !== null ? " · business override" : ""}</small></span>
                ${rowMenu(`limit-${l.limitKey}`, [{ act: "limit", label: "Set a different limit" }, ...(l.override !== null ? [{ act: "limit-default", label: "Use the plan's limit" }] : [])], { label: `${l.label} limit` })}</li>`;
            })}</ul>`
          : ""}
        <h3 class="section-title">Modules</h3>
        <div class="table-wrap"><table class="table table-compact" data-role="modules">
          <thead><tr><th>Module</th><th>On</th><th></th></tr></thead>
          <tbody>${d.modules.filter((m) => m.template).map(
            (m) => html`<tr data-module="${m.id}"><td>${m.label}</td><td>${m.effective ? badge("On", "success") : badge("Off", "neutral")}</td>
              <td class="row-actions">${m.editable ? html`<select class="select select-compact" data-act="override" data-id="${m.id}" aria-label="Override ${m.label}">${Object.entries(OVERRIDE_CHOICES).map(([k, l]) => html`<option value="${k}" ${(m.override === true ? "enabled" : m.override === false ? "disabled" : "default") === k ? "selected" : ""}>${l}</option>`)}</select>` : html`<span class="stat-hint">core</span>`}</td></tr>`
          )}</tbody></table></div>
        ${d.terms.length ? html`<h3 class="section-title">Configuration</h3><dl class="dl dl-compact" data-role="config">${d.terms.map((t) => html`<dt>${t.label}</dt><dd><select class="select select-compact" data-act="term" data-id="${t.id}" aria-label="${t.label}">${t.options.map((o) => html`<option value="${o.id}" ${d.config.terminology[t.id]?.choice === o.id ? "selected" : ""}>${o.label}</option>`)}</select></dd>`)}</dl>` : ""}
        ${d.history
          ? html`<h3 class="section-title">Usage history</h3>
            <div class="table-wrap"><table class="table table-compact" data-role="history">
              <thead><tr><th>Month</th>${historyColumns(d).map((id) => html`<th class="num">${METERS[id].label}</th>`)}</tr></thead>
              <tbody>${d.history.map((h) =>
                h.recorded
                  ? html`<tr data-period="${h.period}"><td>${h.period}</td>${historyColumns(d).map((id) => html`<td class="num">${h.values[id] === null ? "—" : (METERS[id].unit === "bytes" ? formatBytes : formatNumber)(h.values[id])}</td>`)}</tr>`
                  : html`<tr data-period="${h.period}"><td>${h.period}</td><td colspan="${historyColumns(d).length}" class="stat-hint">No recorded usage</td></tr>`
              )}</tbody></table></div>`
          : ""}
        <h3 class="section-title">Recent changes</h3>
        <ul class="list activity" data-role="audit">${d.audit.length ? d.audit.map((a) => html`<li>${when(a.at)} · ${a.actor ?? ""} · ${a.summary ?? a.type}${a.reason ? ` · ${a.reason}` : ""}</li>`) : html`<li>No changes recorded yet.</li>`}</ul>
      </details>`
  );
  if (window.location.hash === "#members") el.querySelector("#members")?.scrollIntoView();

  const reload = () => businessDetailView(el, ctx, businessId);
  const run = async (fn, ok) => {
    try {
      const res = await fn();
      if (res) {
        if (ok) ctx.toast(ok, "success");
        reload();
      }
    } catch (err) {
      ctx.toast(err.message || "Something went wrong", "danger");
      reload();
    }
  };
  const withReason = (title, intro, fields, submitLabel, send) => formDialog({ title, intro, fields: [...fields, { name: "reason", label: "Reason", required: true }], submitLabel, onSubmit: send });

  el.onclick = async (e) => {
    if (toggleMenus(e, el)) return;
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT") return;
    const act = t.dataset.act;
    if (act.startsWith("s-")) {
      if (await runSubscriptionAction(ctx, act, r)) reload();
      return;
    }
    if (act === "general") {
      run(() => withReason("Edit name / timezone", "A timezone change doesn't move records already dated.", [{ name: "name", label: "Business name", value: b.name, required: true }, { name: "timezone", label: "Timezone", value: b.timezone }], "Save", (v) => ctx.call("updateGeneral", { businessId, changes: { name: v.name, timezone: v.timezone }, reason: v.reason, expectedRevision: b.adminRevision })), "Saved.");
    } else if (act === "limit" || act === "limit-default") {
      const l = d.limitRows.find((x) => `limit-${x.limitKey}` === t.dataset.id);
      run(() => limitOverrideDialog(ctx, { businessId, row: l, clear: act === "limit-default", expectedRevision: b.adminRevision }), act === "limit" ? "Limit saved." : "Back to the plan's limit.");
    } else if (act === "add-member") {
      run(() => formDialog({ title: "Add member", intro: "A new person gets an account without a password: share a setup link.", fields: [{ name: "email", label: "Email", required: true }, { name: "name", label: "Name", required: true }, { name: "roleTemplate", label: "Role", type: "select", options: Object.entries(ROLE_TEMPLATES).filter(([k]) => k !== "household_staff").map(([k, x]) => ({ value: k, label: x.label })), value: "staff" }], submitLabel: "Add member", onSubmit: (v) => ctx.call("addMember", { businessId, email: v.email, name: v.name, roleTemplate: v.roleTemplate }) }), "Member saved.");
    } else if (act === "m-status") {
      const m = d.members.find((x) => x.uid === t.dataset.id);
      run(() => withReason(`${m.status === "active" ? "Deactivate" : "Reactivate"} ${m.name || m.email}?`, "Their membership is kept (and can be reactivated).", [], m.status === "active" ? "Deactivate" : "Reactivate", (v) => ctx.call("setMemberStatus", { businessId, uid: m.uid, status: m.status === "active" ? "disabled" : "active", reason: v.reason })), "Member updated.");
    } else if (act === "m-remove") {
      const m = d.members.find((x) => x.uid === t.dataset.id);
      const ok = await confirmDialog({ title: `Remove ${m.name || m.email} from ${b.name}?`, body: "They lose access to this business at once. Their records stay. This can't be undone (add them again if needed).", confirmLabel: "Remove member", danger: true });
      if (ok) run(() => ctx.call("removeMember", { businessId, uid: m.uid }), "Member removed.");
    } else if (act === "backup") {
      // Luna Super Admin only (the server checks): the technical copy of every record.
      const label = t.textContent;
      t.disabled = true;
      t.textContent = "Preparing…";
      try {
        const { blob, fileName } = await (ctx.download || apiDownload)("backup", { businessId });
        (ctx.save || saveBlob)(fileName, blob);
        ctx.toast("Master Backup downloaded. It's recorded in the audit log.", "success");
      } catch (err) {
        ctx.toast(err.message || "Couldn't prepare the backup.", "danger");
      }
      t.disabled = false;
      t.textContent = label;
    } else if (act === "m-link") {
      try {
        const res = await ctx.call("setupLink", { businessId, uid: t.dataset.id });
        await formDialog({ title: `Setup link for ${res.email}`, intro: "Share it privately. It lets the person set their password; it expires.", fields: [{ name: "link", label: "Link", value: res.link }], submitLabel: "Done", onSubmit: () => ({}) });
      } catch (err) {
        ctx.toast(err.message, "danger");
      }
    }
  };
  el.onchange = async (e) => {
    const t = e.target;
    if (t.dataset.act === "override") {
      const choice = t.value;
      run(() => withReason(`${ctx.moduleLabel(t.dataset.id)}: ${OVERRIDE_CHOICES[choice]}`, "For this business only.", [], "Apply", (v) => ctx.call("setModuleOverride", { businessId, moduleId: t.dataset.id, choice, reason: v.reason, expectedRevision: b.adminRevision })), "Saved.");
    } else if (t.dataset.act === "term") {
      run(() => ctx.call("setTerminology", { businessId, terminology: { [t.dataset.id]: t.value } }), "Saved.");
    }
  };
}

// ---------- Limit overrides (Advanced) ----------

const MB = 1024 * 1024;
const limitFormat = (unit) => (unit === "bytes" ? formatBytes : formatNumber);
const historyColumns = (d) => d.historyMeters || MONTHLY_METER_IDS;

// Sends intent only: { limitKey, value } (value null = back to the plan).
// Storage is typed in MB and sent in bytes. Lowering a limit to or below
// what's already used needs a second confirmation; nothing is ever deleted.
export async function limitOverrideDialog(ctx, { businessId, row, clear = false, expectedRevision }) {
  const bytes = row.unit === "bytes";
  const v = await formDialog({
    title: clear ? `${row.label}: the plan's limit` : `${row.label} for this business`,
    intro: `Plan: ${row.plan === null ? "—" : limitFormat(row.unit)(row.plan)}. Now: ${limitFormat(row.unit)(row.current)}.`,
    fields: [...(clear ? [] : [{ name: "value", label: bytes ? "New limit (MB)" : "New limit", value: row.override === null ? "" : String(bytes ? Math.round(row.override / MB) : row.override), required: true, inputmode: "numeric" }]), { name: "reason", label: "Reason", required: true }],
    submitLabel: clear ? "Use the plan's limit" : "Save",
    onSubmit: (x) => {
      if (clear) return { value: null, reason: x.reason };
      const n = Number(String(x.value).replace(/,/g, "").trim());
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("Enter a whole number of 0 or more");
      return { value: bytes ? Math.round(n * MB) : n, reason: x.reason };
    },
  });
  if (!v) return null;
  const effectiveAfter = v.value === null ? row.plan : v.value;
  const warning = overrideImpact({ limitKey: row.limitKey, value: effectiveAfter, current: row.current });
  if (warning) {
    const ok = await formDialog({ title: "This limit is at or below current usage", intro: warning, fields: [], submitLabel: "Save anyway", onSubmit: () => true });
    if (!ok) return null;
  }
  return ctx.call("setLimitOverride", { businessId, limitKey: row.limitKey, value: v.value, reason: v.reason, expectedRevision });
}

// ---------- Plans ----------
// Two plans per workspace; prices, billing type, duration and limits are
// edited here (applied to new businesses and plan changes).

export async function plansView(el, ctx) {
  render(el, loading("Plans"));
  let data;
  try {
    data = await ctx.call("plans");
  } catch (err) {
    render(el, failed("Plans", err));
    return;
  }
  const plans = data.plans.filter(isCatalogPlan);
  const counts = data.subscribers || {};
  const groups = ctx.workspaces.map((w) => ({ w, plans: plans.filter((p) => planWorkspace(p) === w.id) })).filter((g) => g.plans.length);
  render(
    el,
    html`${pageHeader({ title: "Plans" })}
      ${groups.map(
        (g) => html`<section class="section card" data-workspace="${g.w.id}">
          <div class="card-header"><h2 class="card-title">${g.w.name}</h2><span class="stat-hint">${BILLING_TYPES[planBilling(g.plans[0]).type].label}</span></div>
          <div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="plans">
            <thead><tr><th class="m-only"></th><th>Plan</th><th>Price</th><th>Users</th><th>Storage</th><th class="num">Subscribers</th><th></th></tr></thead>
            <tbody>${g.plans.map((p) => {
              const b = planBilling(p);
              return html`<tr data-plan="${p.id}">
                ${mobileCell({ title: p.name, sub: `${priceLabel(p)} · ${limitsText(p)}`, end: formatNumber(counts[p.id] ?? 0), endSub: "active" })}
                <td><span class="cell-strong">${p.name}</span>${b.founding ? html`<span class="cell-sub">Founding: ${b.founding.label ?? peso(b.founding.price)}</span>` : ""}</td>
                <td>${priceLabel(p)}${b.type === "term" ? html`<span class="cell-sub">No automatic renewal</span>` : ""}</td>
                <td>${formatNumber(p.limits.users)}</td>
                <td>${formatBytes(p.limits.storageBytes)}</td>
                <td class="num" data-col="subscribers">${formatNumber(counts[p.id] ?? 0)}</td>
                <td class="row-actions" data-m="more"><button type="button" class="btn btn-compact" data-act="edit" data-id="${p.id}">Edit</button></td>
              </tr>`;
            })}</tbody></table></div>
        </section>`
      )}
      <p class="stat-note">A change applies to new businesses and plan changes. Existing businesses keep their price and limits until their plan is changed.</p>`
  );
  el.onclick = async (e) => {
    const t = e.target.closest('[data-act="edit"]');
    if (!t) return;
    const p = plans.find((x) => x.id === t.dataset.id);
    const b = planBilling(p);
    const pesos = (c) => (c ? String(c / 100) : "");
    const cents = (v, label, { optional = false } = {}) => {
      const s = String(v ?? "").replace(/[₱,\s]/g, "");
      if (optional && !s) return null;
      const n = Math.round(Number(s) * 100);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label}: enter an amount in pesos`);
      return n;
    };
    const r = await formDialog({
      title: `Edit ${p.name}`,
      fields: [
        { name: "name", label: "Plan name", value: p.name, required: true },
        { name: "billingType", label: "Billing", type: "select", options: Object.entries(BILLING_TYPES).map(([value, x]) => ({ value, label: x.label })), value: b.type },
        { name: "price", label: `Price (₱ per ${BILLING_TYPES[b.type].per})`, value: pesos(b.price), inputmode: "decimal", required: true },
        { name: "setupFee", label: "Setup fee (₱)", value: pesos(b.setupFee) || "0", inputmode: "decimal" },
        { name: "termMonths", label: "Access duration (months, annual / 12-month only)", value: String(b.termMonths), inputmode: "numeric" },
        { name: "users", label: "Users", value: String(p.limits.users), inputmode: "numeric", required: true },
        { name: "storageMb", label: "Storage (MB)", value: String(Math.round(p.limits.storageBytes / MB)), inputmode: "numeric", required: true },
        { name: "foundingPrice", label: "Founding price (₱, optional)", value: pesos(b.founding?.price), inputmode: "decimal", more: true },
        { name: "priceIsMinimum", label: "Price shown as", type: "select", options: [{ value: "no", label: "Exact price" }, { value: "yes", label: "Starting at" }], value: b.priceIsMinimum ? "yes" : "no", more: true, default: true },
      ],
      moreLabel: "Founding price and display",
      onSubmit: (v) => {
        const whole = (x, label) => {
          const n = Number(String(x).replace(/,/g, "").trim());
          if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label}: a whole number`);
          return n;
        };
        return ctx.call("savePlan", { planId: p.id, changes: { name: v.name, billingType: v.billingType, price: cents(v.price, "Price"), setupFee: cents(v.setupFee || "0", "Setup fee"), ...(v.billingType === "monthly" ? {} : { termMonths: whole(v.termMonths, "Access duration") }), users: whole(v.users, "Users"), storageMb: whole(v.storageMb, "Storage"), foundingPrice: cents(v.foundingPrice, "Founding price", { optional: true }), priceIsMinimum: v.priceIsMinimum === "yes" } });
      },
    });
    if (r) {
      ctx.toast("Plan saved.", "success");
      const fresh = await ctx.call("plans");
      ctx.plans.splice(0, ctx.plans.length, ...fresh.plans);
      plansView(el, ctx);
    }
  };
}

// ---------- Audit ----------

export function auditView(el, ctx) {
  const state = { cursors: [null], page: null };
  async function load() {
    render(el, loading("Audit"));
    try {
      state.page = await ctx.call("audit", { after: state.cursors.at(-1) });
    } catch (err) {
      render(el, failed("Audit", err));
      return;
    }
    render(
      el,
      html`${pageHeader({ title: "Audit" })}
        ${card({
          body: html`<div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="audit">
            <thead><tr><th class="m-only"></th><th>When</th><th>Business</th><th>Change</th><th>By</th></tr></thead>
            <tbody>${state.page.rows.map((a) => html`<tr>${mobileCell({ title: a.summary ?? a.type, sub: `${when(a.at)} · ${a.businessId ?? ""} · ${a.actor ?? ""}` })}<td>${when(a.at)}</td><td>${a.businessId ?? (a.operator ? `operator ${a.operator.email}` : "—")}</td><td>${a.summary ?? a.type}${a.reason ? html`<span class="cell-sub">${a.reason}</span>` : ""}</td><td>${a.actor ?? ""}</td></tr>`)}</tbody>
          </table></div>
          ${pagers(state)}`,
        })}`
    );
  }
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
