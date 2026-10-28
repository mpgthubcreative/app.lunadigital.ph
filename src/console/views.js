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
import { planWorkspace, isCatalogPlan, priceLabel, planBilling, termLabel, addOnLabel, monthsText, businessIdFromName, BILLING_TYPES, SUBSCRIPTION_LABELS, OVERRIDE_CHOICES, ROLE_TEMPLATES, METERS, MONTHLY_METER_IDS, overrideImpact, NO_LIMIT_FROM } from "@shared/index.js";
import { formatBytes, formatNumber, formatDayId } from "../lib/format.js";
import { invitationDesignView } from "./design.js";
import { reviewPayment, methodText } from "./money.js";
import { invitationCard, supportCard, supportView, startSupportDialog, previewInvitation, publishInvitation } from "./support.js";
import { peso, dateText, whenText, stateChip, billingCell, subscriptionMenu, toggleMenus, runSubscriptionAction, termText, adjustmentDialog } from "./actions.js";

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
  const toReview = Array.isArray(o.toReview) ? o.toReview : [];
  const draw = () =>
    render(
      el,
      html`${pageHeader({ title: "Overview" })}
        <section class="card hero-card" data-role="overview-kpis">
          ${kpiStrip(
            [
              { id: "active", label: "Active subscriptions", value: formatNumber(o.activeAccess), hint: "Paying or with access now" },
              { id: "trials", label: "Free trials", value: formatNumber(o.trials?.active ?? 0), hint: `${formatNumber(o.trials?.endingSoon ?? 0)} ending this week · ${formatNumber(o.trials?.ended ?? 0)} ended` },
              { id: "annual", label: "Collected this month", value: peso(o.collectedThisMonth ?? o.annualIncomeThisMonth), hint: "Paid payments only (access and add-ons)" },
              ...(o.recurringIncome ? [{ id: "recurring", label: "Recurring income", value: `${peso(o.recurringIncome)}`, hint: "Older monthly plans, per month" }] : []),
            ],
            { role: "kpis" }
          )}
        </section>
        ${toReview.length
          ? html`<section class="card section" data-role="to-review">
              <div class="card-header"><h2 class="card-title">Payments to review</h2><span class="stat-hint">${formatNumber(o.awaiting.count)} · ${peso(o.awaiting.amount)}</span></div>
              <ul class="items sa-review" data-role="review-rows">${toReview.map(
                (p) => html`<li data-payment="${p.id}"><div class="item">
                  <span class="item-main"><span class="item-title">${p.businessName}</span><span class="item-sub">${p.product?.label ?? p.planName} · ${methodText(p.method)} · Submitted ${p.submittedAt ? formatDayId(p.submittedAt.slice(0, 10)) : formatDayId(p.paymentDate)}</span></span>
                  <span class="item-end"><b>${peso(p.amountSubmitted)}</b><button type="button" class="btn btn-compact btn-primary" data-act="review-payment" data-id="${p.id}">Review payment</button></span>
                </div></li>`
              )}</ul>
              ${o.awaiting.count > toReview.length ? html`<p class="stat-note"><a href="${ctx.base}/payments" data-link>All ${formatNumber(o.awaiting.count)} payments to verify</a></p>` : ""}
            </section>`
          : ""}
        <section class="card section" data-role="attention">
          <div class="card-header"><h2 class="card-title">Needs attention</h2><span class="stat-hint">${rows.length ? `${rows.length}` : ""}</span></div>
          ${rows.length
            ? html`<div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="attention-rows">
                <thead><tr><th class="m-only"></th><th>Name / plan</th><th>Date</th><th>Status</th><th></th></tr></thead>
                <tbody>${rows.map(
                  (r) => html`<tr data-business="${r.id}" data-kind="${r.attention.kind}">
                    ${billingCell(r, r.planName ?? ctx.planName(r.planId))}
                    <td><span class="cell-strong">${r.name}</span><span class="cell-sub">${r.planName ?? ctx.planName(r.planId)}</span></td>
                    <td data-role="when">${whenText(r)}${r.attention.kind === "overdue" ? html`<span class="cell-sub tone-danger">${r.attention.label}</span>` : ""}</td>
                    <td>${stateChip(r)}</td>
                    <td class="row-actions" data-m="more">${subscriptionMenu(r, { ctx })}</td>
                  </tr>`
                )}</tbody></table></div>`
            : html`<p class="all-clear" data-role="all-clear">✓ Nobody is due, overdue, expiring or ending a trial.</p>`}
        </section>
        <section class="card section" data-role="income">
          <div class="card-header"><h2 class="card-title">Income by workspace</h2></div>
          <div class="card-body"><ul class="sa-income">${o.incomeByWorkspace.map(
            (w) => html`<li data-workspace="${w.workspaceTemplateId}">
              <span class="sa-income-name">${ctx.workspaceName(w.workspaceTemplateId)}<small>${w.billingType === "monthly" ? `Recurring · ${formatNumber(w.active)} active` : w.billingType === "annual" ? `6 / 12-month access collected this month · ${formatNumber(w.active)} active` : `Wedding access collected this month · ${formatNumber(w.active)} active`}</small></span>
              <strong class="sa-income-value">${w.billingType === "monthly" ? html`${peso(w.recurring)}<small>/ month</small>` : peso(w.collected)}</strong>
            </li>`
          )}</ul></div>
        </section>
        <section class="card section" data-role="trial-requests" hidden></section>
        <section class="card section" data-role="custom-links"></section>`
    );
  draw();
  // Bridal free-trial requests from the public /bridal page (2026-10-28):
  // create the workspace (trial), then mark the request done.
  let requests = [];
  const drawRequests = () => {
    const box = el.querySelector('[data-role="trial-requests"]');
    if (!box) return;
    box.hidden = !requests.length;
    render(
      box,
      requests.length
        ? html`<div class="card-header"><h2 class="card-title">Trial requests</h2><span class="stat-hint">${formatNumber(requests.length)}</span></div>
            <ul class="items sa-review" data-role="request-rows">${requests.map(
              (q) => html`<li data-request="${q.id}"><div class="item">
                <span class="item-main"><span class="item-title">${q.name}${q.coupleNames ? ` · ${q.coupleNames}` : ""}</span><span class="item-sub">${q.contact}${q.weddingDate ? ` · wedding ${formatDayId(q.weddingDate)}` : ""}${q.createdAt ? ` · ${formatDayId(q.createdAt.slice(0, 10))}` : ""}</span>${q.note ? html`<span class="item-sub">${q.note}</span>` : ""}</span>
                <span class="item-end"><button type="button" class="btn btn-compact btn-primary" data-act="tr-create" data-id="${q.id}">Create workspace</button><button type="button" class="btn btn-compact" data-act="tr-done" data-id="${q.id}">Done</button></span>
              </div></li>`
            )}</ul>`
        : ""
    );
  };
  ctx
    .call("trialRequests")
    .then((r) => {
      requests = Array.isArray(r?.requests) ? r.requests : [];
      drawRequests();
    })
    .catch(() => {});
  const closeRequest = async (id) => {
    await ctx.call("closeTrialRequest", { requestId: id });
    requests = requests.filter((x) => x.id !== id);
    drawRequests();
  };
  // Custom workspace links: names, setup and how many site addresses are used.
  ctx
    .call("customLinks")
    .then(({ customLinks: c }) => {
      const box = el.querySelector('[data-role="custom-links"]');
      if (!box || !c.rows.length) return;
      const near = c.names >= c.warnAt;
      render(
        box,
        html`<div class="card-header"><h2 class="card-title">Custom links</h2><span class="stat-hint" data-role="link-count">${formatNumber(c.names)} of ${formatNumber(c.limit)} addresses${near ? " · plan the wildcard domain" : ""}</span></div>
          <div class="card-body"><table class="table table-compact"><tbody>${c.rows.map(
            (r) => html`<tr data-link="${r.label}"><td>${r.host}<span class="cell-sub">${r.businessName}${r.kind === "previous" ? ` · old name → ${r.current}` : ""}</span></td><td>${r.setup === "active" ? "Ready" : `Pending${r.setupError ? ` (${r.setupError})` : ""}`}<span class="cell-sub">${r.state === "live" ? "Live" : r.state === "unavailable" ? "Suspended: held" : "Retained (held)"} · ${r.subscriptionStatus ?? "deleted"}</span></td></tr>`
          )}</tbody></table></div>`
      );
    })
    .catch(() => {});
  el.onclick = async (e) => {
    if (toggleMenus(e, el)) return;
    const t = e.target.closest("[data-act]");
    if (t?.dataset.act === "review-payment") return reviewPayment(ctx, t.dataset.id, { onDone: () => overviewView(el, ctx) });
    if (t?.dataset.act === "tr-create" || t?.dataset.act === "tr-done") {
      const q = requests.find((x) => x.id === t.dataset.id);
      if (!q) return undefined;
      try {
        if (t.dataset.act === "tr-create") {
          const made = await createBusinessDialog(ctx, { planId: "bridal-basic", name: q.coupleNames ? `${q.coupleNames} Wedding` : `${q.name} Wedding`, ownerName: q.name });
          if (!made) return undefined;
          ctx.toast("Workspace created with the free trial. Send the owner their setup link.", "success");
          await closeRequest(q.id);
          ctx.navigate(`/businesses?b=${made.businessId}#members`);
          return undefined;
        }
        await closeRequest(q.id);
      } catch (err) {
        ctx.toast(err.message || "Something went wrong", "danger");
      }
      return undefined;
    }
    if (!t || !t.dataset.act.startsWith("s-")) return;
    const r = rows.find((x) => x.id === t.dataset.id);
    if (r && (await runSubscriptionAction(ctx, t.dataset.act, r))) overviewView(el, ctx);
  };
}

// ---------- Businesses ----------

export function businessesView(el, ctx) {
  const params = new URLSearchParams(ctx.search || "");
  if (params.get("b") && params.get("design")) return invitationDesignView(el, ctx, params.get("b"));
  if (params.get("b") && params.get("support")) return supportView(el, ctx, params.get("b"));
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
                        ${billingCell(b, `${ctx.workspaceName(b.workspaceTemplateId)} · ${b.planName ?? ctx.planName(b.planId)}`)}
                        <td><a class="cell-strong" href="${ctx.base}/businesses?b=${b.id}" data-link>${b.name}</a></td>
                        <td>${ctx.workspaceName(b.workspaceTemplateId)}</td>
                        <td>${b.planName ?? ctx.planName(b.planId)}</td>
                        <td>${stateChip(b)}</td>
                        <td class="row-actions" data-m="more">${subscriptionMenu(b, { ctx })}</td>
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
// Product first (it decides the workspace), then the access term, then the
// name and the owner. Price, billing and included limits follow the product.
// The business ID is made from the name; ID, timezone and an agreed price
// are under Advanced.

const limitsText = (p) => `${formatNumber(p.limits.users)} user${p.limits.users === 1 ? "" : "s"} · ${formatBytes(p.limits.storageBytes)}`;
const termOptions = (p) => planBilling(p).terms.map((t) => ({ value: String(t.months), label: termLabel(p, t.months) }));
// prefill (2026-10-28, a Bridal trial request): { planId, name, ownerName }.
export function createBusinessDialog(ctx, prefill = {}) {
  const products = ctx.workspaces.flatMap((w) => plansFor(ctx, w.id));
  const first = products.find((p) => p.id === prefill.planId) ?? products[0];
  let idTouched = false;
  return formDialog({
    title: "Create business",
    fields: [
      { name: "planId", label: "Product", type: "select", options: products.map((p) => ({ value: p.id, label: p.name })), value: first?.id, hint: first ? `${priceLabel(first)} · ${limitsText(first)}` : "" },
      { name: "termMonths", label: "Term", type: "select", options: first ? termOptions(first) : [], value: first ? String(planBilling(first).defaultTermMonths) : "" },
      // Products with a free trial start with it (nothing billed until the
      // customer chooses a plan on "Continue with Luna").
      { name: "start", label: "Start", type: "select", options: [{ value: "trial", label: "30-day free trial" }, { value: "paid", label: "Paid from today" }], value: "trial" },
      { name: "name", label: "Business / workspace name", required: true, value: prefill.name ?? "" },
      { name: "ownerName", label: "Owner name", required: true, value: prefill.ownerName ?? "" },
      { name: "ownerEmail", label: "Owner email", required: true, inputmode: "email" },
      { name: "price", label: "Agreed price (₱, optional)", inputmode: "decimal", hint: "Only when it differs from the product's price (e.g. a Custom wedding's quote).", more: true },
      { name: "addonUsers", label: "Extra users (add-on packs)", value: "0", inputmode: "numeric", more: true, default: true },
      { name: "addonStorage", label: "Extra storage (add-on packs)", value: "0", inputmode: "numeric", more: true, default: true },
      { name: "setupFee", label: "Setup fee (₱)", inputmode: "decimal", more: true, default: true },
      { name: "waiveSetupFee", label: "Setup fee", type: "select", options: [{ value: "no", label: "Bill it on the first bill" }, { value: "yes", label: "Waive it (shown as waived)" }], value: "no", more: true, default: true },
      { name: "businessId", label: "Business ID", hint: "Made from the name. Permanent.", more: true, default: true },
      { name: "timezone", label: "Timezone", value: "Asia/Manila", more: true, default: true },
    ],
    moreLabel: "Advanced",
    submitLabel: "Create business",
    onFormChange: (form) => {
      const els = form.elements;
      const plan = products.find((p) => p.id === els.planId.value) ?? first;
      if (!plan) return;
      const opts = termOptions(plan);
      if (els.termMonths.dataset.plan !== plan.id) {
        els.termMonths.dataset.plan = plan.id;
        render(els.termMonths, html`${opts.map((o) => html`<option value="${o.value}" ${o.value === String(planBilling(plan).defaultTermMonths) ? "selected" : ""}>${o.label}</option>`)}`);
      }
      // One term (Bridal, Baby): nothing to choose.
      els.termMonths.closest(".field").hidden = opts.length < 2;
      const trialDays = planBilling(plan).trialDays;
      els.start.closest(".field").hidden = !trialDays;
      if (trialDays) els.start.options[0].textContent = `${trialDays}-day free trial`;
      // Advanced: this product's add-ons and setup fee (none: hidden).
      const b = planBilling(plan);
      const packOf = (kind) => b.addOns.find((a) => (kind === "users" ? a.users > 0 : a.storageMb > 0));
      for (const [field, kind] of [["addonUsers", "users"], ["addonStorage", "storage"]]) {
        const a = packOf(kind);
        const f = els[field].closest(".field");
        f.hidden = !a;
        if (a) f.querySelector("label").textContent = `Extra: ${addOnLabel(a)}`;
      }
      els.setupFee.closest(".field").hidden = !b.setupFee;
      els.waiveSetupFee.closest(".field").hidden = !b.setupFee;
      if (els.setupFee.dataset.plan !== plan.id) {
        els.setupFee.dataset.plan = plan.id;
        els.setupFee.value = b.setupFee ? String(b.setupFee / 100) : "";
      }
      const hint = els.planId.closest(".field")?.querySelector(".stat-hint");
      if (hint) hint.textContent = `${priceLabel(plan)} · ${limitsText(plan)}${planBilling(plan).type === "term" ? " · no automatic renewal" : ""}`;
      if (!idTouched && els.businessId) els.businessId.value = businessIdFromName(els.name.value);
      if (els.businessId && !els.businessId.dataset.watch) {
        els.businessId.dataset.watch = "1";
        els.businessId.addEventListener("input", () => (idTouched = true));
      }
    },
    onSubmit: async (v) => {
      const plan = products.find((p) => p.id === v.planId);
      if (!plan) throw new Error("Choose a product");
      const businessId = (v.businessId || businessIdFromName(v.name)).trim().toLowerCase();
      if (!businessId) throw new Error("Enter a name (or a Business ID under Advanced)");
      const s = String(v.price || "").replace(/[₱,\s]/g, "");
      const priceOverride = s ? Math.round(Number(s) * 100) : null;
      if (priceOverride !== null && (!Number.isSafeInteger(priceOverride) || priceOverride <= 0)) throw new Error("Agreed price: an amount more than ₱0");
      const b = planBilling(plan);
      const addOns = {};
      for (const [field, kind] of [["addonUsers", "users"], ["addonStorage", "storage"]]) {
        const a = b.addOns.find((x) => (kind === "users" ? x.users > 0 : x.storageMb > 0));
        const n = Number(String(v[field] || "0").trim() || "0");
        if (!Number.isSafeInteger(n) || n < 0 || n > 50) throw new Error("Add-ons: a whole number from 0 to 50");
        if (a && n) addOns[a.id] = n;
      }
      const fee = String(v.setupFee || "").replace(/[₱,\s]/g, "");
      const setupFee = b.setupFee && fee !== "" ? Math.round(Number(fee) * 100) : null;
      if (setupFee !== null && (!Number.isSafeInteger(setupFee) || setupFee < 0)) throw new Error("Setup fee: ₱0 or more");
      const r = await ctx.call("createBusiness", { business: { name: v.name, businessId, workspaceTemplateId: planWorkspace(plan), planId: plan.id, termMonths: Number(v.termMonths) || b.defaultTermMonths, ...(priceOverride ? { priceOverride } : {}), ...(Object.keys(addOns).length ? { addOns } : {}), ...(setupFee !== null && setupFee !== b.setupFee ? { setupFee } : {}), ...(b.setupFee && v.waiveSetupFee === "yes" ? { waiveSetupFee: true } : {}), ...(b.trialDays && v.start !== "paid" ? { trial: true } : {}), ownerName: v.ownerName, ownerEmail: v.ownerEmail, timezone: v.timezone || "Asia/Manila" } });
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
    html`${pageHeader({ title: b.name, subtitle: `${b.workspaceName ?? b.workspaceTemplateId} · ${b.planName ?? b.planId}`, actions: html`<span class="sa-head-status">${stateChip(r)}</span>${b.status === "deleted" ? "" : html`<button type="button" class="btn btn-primary" data-act="s-pay" data-id="${b.id}">Record payment</button>`}${subscriptionMenu(r, { detail: true, ctx })}` })}
      ${b.entitlementsValid ? "" : html`<div class="banner banner-danger" role="alert">Entitlements are invalid (${b.entitlementProblems.join("; ")}). The business is blocked until they're recomputed.</div>`}
      ${b.status === "deleted" ? html`<div class="banner banner-danger" role="alert">Deleted. Access is off. Recoverable until ${dateText(r.purgeAfter)} (⋯ → Restore business).</div>` : ""}
      <div class="section grid grid-2">
        <section class="card" data-role="subscription">
          <div class="card-header"><h2 class="card-title">Subscription</h2></div>
          <div class="card-body"><dl class="dl dl-compact">
            <dt>Product</dt><dd>${b.planName ?? b.planId}${plan ? html`<span class="cell-sub">${priceLabel(plan)}${plan.legacy ? " · older plan" : ""}</span>` : ""}</dd>
            ${r.billingType === "term"
              ? html`<dt>Access</dt><dd data-role="term">${r.trial?.open ? "Free Trial" : `${r.termMonths} Months — ${peso(r.priceOverride ?? r.amount)}`}<span class="cell-sub" data-role="access-paid">${r.trial?.open ? `Trial ends ${dateText(r.trial.endsAt)}` : r.paidThrough ? "Paid" : `Not paid yet · nothing collected${r.accessGrant ? " · set by Luna" : ""}`}</span></dd>`
              : html`<dt>Term</dt><dd data-role="term">${termText(r)}${r.amount ? html`<span class="cell-sub">${peso(r.amount)} per bill${r.priceOverride ? " · agreed price" : ""}</span>` : ""}</dd>`}
            ${r.addOns?.length ? html`<dt>Add-ons</dt><dd data-role="addons">${r.addOns.map((a) => html`<span class="cell-sub-line">${a.flat ? html`${a.label} · ${peso(a.price)} · <strong data-role="addon-paid">${a.paid ? "Paid" : "Not paid yet"}</strong>` : `${a.qty} × ${a.label}`}</span>`)}</dd>` : ""}
            ${r.linkAddOn ? html`<dt>${r.linkAddOn.label}</dt><dd data-role="link-addon">${r.linkAddOn.paid ? "Yes" : r.addOns?.some((a) => a.id === r.linkAddOn.id) ? "Billed, not paid" : "No"} <span class="cell-sub">${peso(r.linkAddOn.price)} once</span></dd>` : ""}
            ${r.customLink ? html`<dt>Own link</dt><dd data-role="custom-link">${r.customLink.label}${r.customLinkDomain ? `.${r.customLinkDomain}` : ""}<span class="cell-sub">${r.customLink.setup === "active" ? "Ready" : "Being set up"}</span></dd>` : ""}
            <dt>${r.billingType === "term" ? "Ends" : "Next"}</dt><dd data-role="when">${whenText(r)}</dd>
            ${r.paidThrough ? html`<dt>Paid through</dt><dd>${dateText(r.paidThrough)}</dd>` : ""}
            <dt>Started</dt><dd>${dateText(r.startDate)}</dd>
            ${paymentLine(d.latestPayment, r)}
          </dl></div>
        </section>
        <section class="card" data-role="usage">
          <div class="card-header"><h2 class="card-title">Usage <span class="hint">this month</span></h2></div>
          <div class="card-body"><dl class="dl dl-compact sa-usage">
            <dt>Active users</dt><dd data-usage="users">${ofLimit(u.users ?? 0, lim.users)}${Number.isSafeInteger(lim.users) && (u.users ?? 0) > lim.users ? html`<span class="cell-sub tone-warning" data-role="over-capacity">Existing members keep access. Add capacity to invite more.</span>` : ""}</dd>
            <dt>Storage</dt><dd data-usage="storage">${ofLimit(u.storageBytes ?? 0, lim.storageBytes, formatBytes)}</dd>
            <dt>Excel downloads</dt><dd data-usage="downloads">${formatNumber(u.downloads ?? 0)}</dd>
            <dt>Excel transfer</dt><dd data-usage="transfer">${formatBytes(u.transferBytes ?? 0)}</dd>
            ${u.orders === null || u.orders === undefined ? "" : html`<dt>Orders</dt><dd data-usage="orders">${formatNumber(u.orders)}</dd>`}
          </dl></div>
        </section>
      </div>
      ${invitationCard(d.invitation, b, ctx)}
      ${billsCard(d.bills || [], b)}
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
      ${b.status === "deleted" ? "" : supportCard(d.support, b, ctx)}
      <details class="section card sa-advanced" data-role="advanced">
        <summary class="card-header"><h2 class="card-title">Advanced</h2></summary>
        <div class="card-body">
        <div class="page-actions">
          <button type="button" class="btn btn-compact" data-act="general">Edit name / timezone</button>
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
        </div>
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
    if (act === "review-payment") return reviewPayment(ctx, t.dataset.id, { onDone: reload });
    if (act === "inv-preview") {
      try {
        await previewInvitation(businessId, t.dataset.which, b.name);
      } catch (err) {
        ctx.toast(err.message || "Couldn't open the preview", "danger");
      }
      return;
    }
    if (act === "inv-publish") {
      run(() => publishInvitation(businessId), "Published. Guest links show the design; their links didn't change.");
      return;
    }
    if (act === "support-start") {
      const v = await startSupportDialog(ctx, b);
      if (v) ctx.navigate(`/businesses?b=${businessId}&support=1`);
      return;
    }
    if (act === "support-end") {
      run(() => ctx.call("supportEnd", { sessionId: t.dataset.id }), "Support session ended.");
      return;
    }
    if (act === "bill-adjust") {
      run(() => adjustmentDialog(ctx, r, { invoiceId: t.dataset.id, title: `Add discount / deduction · ${t.dataset.label}` }), "Added.");
      return;
    }
    if (act === "bill-unadjust") {
      const ok = await confirmDialog({ title: `Remove ${t.dataset.label}?`, body: "The bill goes back up by that amount.", confirmLabel: "Remove" });
      if (ok) run(() => ctx.call("removeAdjustment", { businessId, invoiceId: t.dataset.id, adjustmentId: t.dataset.adj }), "Removed.");
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

// ---------- Bills (breakdown, discounts / credits) ----------
// Open bills show their lines and what's taken off, with + Add discount /
// deduction until a payment is recorded; a paid bill keeps its breakdown.
// The latest payment (2026-10-28): received → pending verification with
// Review; verified → whether what it paid for is active.
function paymentLine(p, r) {
  if (!p) return "";
  const head = `${peso(p.amountSubmitted)} · ${formatDayId(p.paymentDate)}`;
  const forWhat = p.product?.label ?? p.planName;
  if (p.status === "for_verification") return html`<dt>Payment</dt><dd data-role="latest-payment" data-status="pending">Payment received<span class="cell-sub">${head} · ${forWhat} · Pending verification</span><button type="button" class="btn btn-compact btn-primary" data-act="review-payment" data-id="${p.id}">Review</button></dd>`;
  if (p.status === "paid") {
    const active = p.product?.kind === "addon" ? r.addOns?.some((a) => a.id === p.product.addOnId && a.paid) || r.linkAddOn?.paid : Boolean(r.paidThrough);
    return html`<dt>Payment</dt><dd data-role="latest-payment" data-status="paid">Payment verified ✓<span class="cell-sub">${head} · ${forWhat}</span><span class="cell-sub ${active ? "" : "tone-warning"}" data-role="payment-access">${active ? (p.product?.kind === "addon" ? "Unlocked" : "Access active") : "Not active yet: part of the bill is still due"}</span></dd>`;
  }
  return html`<dt>Payment</dt><dd data-role="latest-payment" data-status="${p.status}">Payment ${p.status === "rejected" ? "rejected" : p.status}<span class="cell-sub">${head} · ${forWhat}${p.rejectionReason ? ` · ${p.rejectionReason}` : ""}</span><button type="button" class="btn btn-compact" data-act="review-payment" data-id="${p.id}">View</button></dd>`;
}

function billsCard(bills, b) {
  if (!bills.length) return "";
  const title = (i) => (i.kind === "upgrade" ? `Upgrade · ${dateText(i.dueDate)}` : i.kind === "addon" ? `Add-on: ${i.lines?.[0]?.label ?? "add-on"} · ${dateText(i.dueDate)}` : `${i.period} · due ${dateText(i.dueDate)}`);
  const status = (i) => (i.status === "paid" ? badge("Paid", "success") : i.status === "for_verification" ? badge("For verification", "info") : badge("Due", "warning"));
  return html`<section class="section card" data-role="bills">
    <div class="card-header"><h2 class="card-title">Bills</h2></div>
    <div class="card-body"><ul class="sa-bills">${bills.map(
      (i) => html`<li data-bill="${i.id}" class="${i.status === "paid" ? "is-paid" : ""}">
        <div class="sa-bill-head"><span class="cell-strong">${title(i)}</span>${status(i)}<strong class="sa-bill-amount">${peso(i.amountDue)}</strong></div>
        <dl class="bill-lines">${i.lines.map((l) => html`<dt>${l.label}</dt><dd>${peso(l.amount)}</dd>`)}${i.adjustments.map((a) => html`<dt>${a.description}${i.editable ? html` <button type="button" class="btn-linklike sa-remove" data-act="bill-unadjust" data-id="${i.id}" data-adj="${a.id}" data-label="${a.description}" aria-label="Remove ${a.description}">Remove</button>` : ""}</dt><dd class="bill-minus">−${peso(a.amount)}</dd>`)}<dt class="bill-total">Amount due</dt><dd class="bill-total">${peso(i.amountDue)}</dd></dl>
        ${i.editable && b.status !== "deleted" ? html`<button type="button" class="btn btn-compact" data-act="bill-adjust" data-id="${i.id}" data-label="${title(i)}">+ Add discount / deduction</button>` : ""}
      </li>`
    )}</ul></div>
  </section>`;
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

// ---------- Products (plans) ----------
// One product per workspace (Bridal: Standard and Custom). Each shows what
// it's for, its terms, what's included and its add-ons. Prices, term
// prices, add-on prices and included limits are edited here (applied to new
// businesses and product / access changes).

export async function plansView(el, ctx) {
  render(el, loading("Products"));
  let data;
  try {
    data = await ctx.call("plans");
  } catch (err) {
    render(el, failed("Products", err));
    return;
  }
  const plans = data.plans.filter(isCatalogPlan);
  const counts = data.subscribers || {};
  const groups = ctx.workspaces.map((w) => ({ w, plans: plans.filter((p) => planWorkspace(p) === w.id) })).filter((g) => g.plans.length);
  render(
    el,
    html`${pageHeader({ title: "Products" })}
      ${groups.map(
        (g) => html`<section class="section card" data-workspace="${g.w.id}">
          <div class="card-header"><h2 class="card-title">${g.w.name}</h2><span class="stat-hint">${BILLING_TYPES[planBilling(g.plans[0]).type].label}</span></div>
          <div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="plans">
            <thead><tr><th class="m-only"></th><th>Product</th><th>Terms</th><th>Included</th><th class="num">Active</th><th></th></tr></thead>
            <tbody>${g.plans.map((p) => {
              const b = planBilling(p);
              return html`<tr data-plan="${p.id}">
                ${mobileCell({ title: p.name, sub: `${priceLabel(p)} · ${limitsText(p)}`, end: formatNumber(counts[p.id] ?? 0), endSub: "active" })}
                <td class="col-wrap"><span class="cell-strong">${p.name}</span><span class="cell-sub">${priceLabel(p)}</span>${p.tagline ? html`<span class="cell-sub" data-role="tagline">${p.tagline}</span>` : ""}</td>
                <td class="col-wrap" data-role="terms" data-m="info">${b.terms.map((t) => html`<span class="cell-sub-line">${termLabel(p, t.months)}</span>`)}${b.type === "term" ? html`<span class="cell-sub">No automatic renewal</span>` : ""}</td>
                <td class="col-wrap" data-role="included" data-m="info">${limitsText(p)}${b.addOns.length ? html`${b.addOns.map((a) => html`<span class="cell-sub">+ ${addOnLabel(a)}</span>`)}` : ""}</td>
                <td class="num" data-col="subscribers">${formatNumber(counts[p.id] ?? 0)}</td>
                <td class="row-actions" data-m="more"><button type="button" class="btn btn-compact" data-act="edit" data-id="${p.id}">Edit</button></td>
              </tr>`;
            })}</tbody></table></div>
        </section>`
      )}
      <p class="stat-note">A change applies to new businesses and to product or access changes. Existing businesses keep their price, term and limits until then.</p>`
  );
  el.onclick = async (e) => {
    const t = e.target.closest('[data-act="edit"]');
    if (!t) return;
    const p = plans.find((x) => x.id === t.dataset.id);
    const b = planBilling(p);
    const pesos = (c) => (c ? String(c / 100) : "");
    const cents = (v, label, { allowZero = false } = {}) => {
      const n = Math.round(Number(String(v ?? "").replace(/[₱,\s]/g, "")) * 100);
      if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`${label}: enter an amount in pesos`);
      return n;
    };
    const r = await formDialog({
      title: `Edit ${p.name}`,
      fields: [
        { name: "name", label: "Product name", value: p.name, required: true },
        ...b.terms.map((x) => ({ name: `term-${x.months}`, label: `${monthsText(x.months)}${b.type === "monthly" && x.months === 1 ? " (monthly price)" : ""} · ₱`, value: pesos(x.price), inputmode: "decimal", required: true, hint: x.kind === "trial" ? (b.type === "monthly" ? "Prepaid starter" : "Paid trial") : "Main offer" })),
        ...(b.type === "monthly" || b.setupFee > 0 ? [{ name: "setupFee", label: "One-time setup fee (₱)", value: pesos(b.setupFee) || "0", inputmode: "decimal" }] : []),
        { name: "users", label: "Included users", value: String(p.limits.users), inputmode: "numeric", required: true },
        { name: "storageMb", label: "Included storage (MB)", value: String(Math.round(p.limits.storageBytes / MB)), inputmode: "numeric", required: true },
        ...b.addOns.map((a) => ({ name: `addon-${a.id}`, label: `${a.label} · ₱ per ${a.perMonths === 1 ? "month" : monthsText(a.perMonths)}`, value: pesos(a.price), inputmode: "decimal", required: true })),
        { name: "tagline", label: "What it's for (one line)", type: "textarea", value: p.tagline ?? "", more: true },
        { name: "priceIsMinimum", label: "Price shown as", type: "select", options: [{ value: "no", label: "Exact price" }, { value: "yes", label: "Starting at" }], value: b.priceIsMinimum ? "yes" : "no", more: true, default: true },
      ],
      moreLabel: "Description and display",
      onSubmit: (v) => {
        const whole = (x, label) => {
          const n = Number(String(x).replace(/,/g, "").trim());
          if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label}: a whole number`);
          return n;
        };
        return ctx.call("savePlan", {
          planId: p.id,
          changes: {
            name: v.name,
            tagline: v.tagline,
            termPrices: Object.fromEntries(b.terms.map((x) => [String(x.months), cents(v[`term-${x.months}`], monthsText(x.months))])),
            ...(b.addOns.length ? { addOnPrices: Object.fromEntries(b.addOns.map((a) => [a.id, cents(v[`addon-${a.id}`], a.label)])) } : {}),
            ...(b.type === "monthly" || b.setupFee > 0 ? { setupFee: cents(v.setupFee || "0", "Setup fee", { allowZero: true }) } : {}),
            users: whole(v.users, "Users"),
            storageMb: whole(v.storageMb, "Storage"),
            priceIsMinimum: v.priceIsMinimum === "yes",
          },
        });
      },
    });
    if (r) {
      ctx.toast("Product saved.", "success");
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
