// Luna Super Admin console views (Phase 17). Every read and write goes
// through POST /api/operator (ctx.call), which re-checks the operator on
// every request; nothing here talks to Firestore directly, and nothing the
// browser holds decides access. The browser sends intent (business id +
// plan id + reason), never entitlement objects or permission lists.

import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState, badge, statCard } from "../components/ui.js";
import { formDialog } from "../components/form-dialog.js";
import { formatMoney, SUBSCRIPTION_LABELS, SUBSCRIPTION_ACTIONS, OVERRIDE_CHOICES, ROLE_TEMPLATES, METERS, MONTHLY_METER_IDS, overrideImpact } from "@shared/index.js";
import { formatBytes, formatNumber } from "../lib/format.js";

const TONE = { active: "success", past_due: "warning", suspended: "danger", cancelled: "neutral" };
const statusBadge = (s) => badge(SUBSCRIPTION_LABELS[s] ?? s ?? "—", TONE[s] || "neutral");
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "—");
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—");
const loading = () => card({ body: emptyState({ title: "Loading…" }) });
const failed = (err) => card({ body: emptyState({ title: "Couldn't load", body: err?.message || "Try again." }) });

// ---------- Overview ----------

export async function overviewView(el, ctx) {
  render(el, html`${pageHeader({ title: "Overview", subtitle: "Luna businesses at a glance." })}${loading()}`);
  try {
    const { overview: o } = await ctx.call("overview");
    const row = (title, map, label = (k) => k) => card({ title, body: html`<dl class="dl dl-compact">${Object.entries(map).map(([k, v]) => html`<dt>${label(k)}</dt><dd>${formatNumber(v)}</dd>`)}</dl>` });
    render(
      el,
      html`${pageHeader({ title: "Overview", subtitle: "Luna businesses at a glance (no revenue analytics yet)." })}
        <section class="section stat-grid" data-role="counts">
          ${statCard({ id: "total", label: "Total businesses", value: formatNumber(o.total) })}
          ${Object.entries(o.byStatus).map(([s, n]) => statCard({ id: s, label: SUBSCRIPTION_LABELS[s] ?? s, value: formatNumber(n) }))}
        </section>
        <div class="section grid grid-2">${row("By workspace", o.byWorkspace, (k) => ctx.workspaceName(k))}${row("By plan", o.byPlan)}</div>`
    );
  } catch (err) {
    render(el, failed(err));
  }
}

// ---------- Businesses ----------

export function businessesView(el, ctx) {
  const params = new URLSearchParams(ctx.search || "");
  if (params.get("b")) return businessDetailView(el, ctx, params.get("b"));
  const state = { filters: {}, cursors: [null], page: null, error: null, loading: true };
  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;

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
      html`${pageHeader({ title: "Businesses", subtitle: "Tenants, their workspace, plan and subscription.", actions: html`<button type="button" class="btn btn-primary" data-act="create">Create business</button>` })}
        <form class="section card filters filters-inline" data-role="filters">
          <input class="input" name="search" placeholder="Business ID or name starts with…" value="${f.search || ""}" autocomplete="off" aria-label="Search" />
          <select class="select" name="workspaceTemplateId" aria-label="Workspace">${opt("", "Any workspace", f.workspaceTemplateId || "")}${ctx.workspaces.map((w) => opt(w.id, w.name, f.workspaceTemplateId))}</select>
          <select class="select" name="planId" aria-label="Plan">${opt("", "Any plan", f.planId || "")}${ctx.plans.map((p) => opt(p.id, p.name, f.planId))}</select>
          <select class="select" name="status" aria-label="Status">${opt("", "Any status", f.status || "")}${Object.entries(SUBSCRIPTION_LABELS).map(([k, l]) => opt(k, l, f.status))}</select>
          <button type="submit" class="btn">Apply</button>
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error.message })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !rows.length
                ? emptyState({ iconName: "businesses", title: "No businesses match" })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="businesses">
                    <thead><tr><th>Business</th><th>Workspace</th><th>Plan</th><th>Status</th><th class="col-secondary">Owner</th><th class="col-secondary">Created</th><th class="num col-secondary">Orders / imports / exports (month)</th><th></th></tr></thead>
                    <tbody>${rows.map(
                      (b) => html`<tr data-business="${b.id}">
                        <td>${b.name}<div class="stat-hint">${b.id}</div></td>
                        <td>${ctx.workspaceName(b.workspaceTemplateId)} <span class="stat-hint">v${b.workspaceTemplateVersion ?? "?"}</span></td>
                        <td>${ctx.planName(b.planId)}</td><td>${statusBadge(b.status)}</td>
                        <td class="col-secondary">${b.owner?.email ?? "—"}</td><td class="col-secondary">${day(b.createdAt)}</td>
                        <td class="num col-secondary">${b.usage.orders} / ${b.usage.imports} / ${b.usage.exports}</td>
                        <td class="row-actions"><a class="btn btn-compact" href="${ctx.base}/businesses?b=${b.id}" data-link>Manage</a></td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.page?.next ? "" : "disabled"}>Next</button>
                  </div>`}
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
  el.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "next") {
      state.cursors.push(state.page.next);
      load();
    } else if (act === "prev") {
      state.cursors.pop();
      load();
    } else if (act === "create") {
      const r = await createBusinessDialog(ctx);
      if (r) ctx.navigate(`/businesses?b=${r.businessId}`);
    }
  };
  load();
}

// Create business: one call, one retry-safe workflow on the server. A
// double click or retry converges on the same business.
export function createBusinessDialog(ctx) {
  return formDialog({
    title: "Create business",
    intro: "Creates the business, its owner's account (if new) and owner membership, at the workspace's current version.",
    fields: [
      { name: "name", label: "Business name", required: true },
      { name: "businessId", label: "Business ID (lowercase, digits, dashes)", required: true, hint: "Permanent. e.g. abc-test-trading" },
      { name: "workspaceTemplateId", label: "Workspace", type: "select", options: ctx.workspaces.map((w) => ({ value: w.id, label: w.name })), value: ctx.workspaces[0]?.id },
      { name: "planId", label: "Plan", type: "select", options: ctx.plans.map((p) => ({ value: p.id, label: p.name })), value: ctx.plans.find((p) => p.recommended)?.id ?? ctx.plans[0]?.id },
      { name: "ownerEmail", label: "Owner email", required: true },
      { name: "ownerName", label: "Owner name", required: true },
      { name: "timezone", label: "Timezone", value: "Asia/Manila" },
    ],
    submitLabel: "Create business",
    onSubmit: async (v) => {
      const r = await ctx.call("createBusiness", { business: { ...v, businessId: v.businessId.trim().toLowerCase() } });
      ctx.toast(r.created ? "Business created." : "Already created: nothing was duplicated.", "success");
      return r;
    },
  });
}

// ---------- One business ----------

export async function businessDetailView(el, ctx, businessId) {
  render(el, html`${pageHeader({ title: "Business" })}${loading()}`);
  let d;
  try {
    d = await ctx.call("business", { businessId });
  } catch (err) {
    render(el, failed(err));
    return;
  }
  const b = d.business;
  const yes = (on) => (on ? "Yes" : "—");
  const ov = (v) => (v === true ? "Enabled" : v === false ? "Disabled" : "Default");
  render(
    el,
    html`${pageHeader({ title: b.name, subtitle: `${b.id} · ${b.workspaceName ?? b.workspaceTemplateId} v${b.workspaceTemplateVersion ?? "?"}`, actions: html`<a class="btn" href="${ctx.base}/businesses" data-link>All businesses</a>` })}
      ${b.entitlementsValid ? "" : html`<div class="banner banner-danger" role="alert">Entitlements are invalid (${b.entitlementProblems.join("; ")}). The business is blocked until they're recomputed.</div>`}
      <div class="section grid grid-2">
        ${card({
          title: "Overview",
          body: html`<dl class="dl dl-compact" data-role="overview">
            <dt>Business ID</dt><dd>${b.id}</dd>
            <dt>Workspace</dt><dd>${b.workspaceName} (v${b.workspaceTemplateVersion}) <span class="stat-hint">fixed after creation</span></dd>
            <dt>Plan</dt><dd>${b.planName ?? b.planId}</dd>
            <dt>Subscription</dt><dd>${statusBadge(b.status)}</dd>
            <dt>Timezone</dt><dd>${b.timezone}</dd>
            <dt>Created</dt><dd>${when(b.createdAt)} ${b.createdBy ? html`<span class="stat-hint">by ${b.createdBy}</span>` : ""}</dd>
            <dt>Owner(s)</dt><dd>${d.members.filter((m) => m.isAccountOwner).map((m) => m.email).join(", ") || "—"}</dd>
          </dl>`,
          actions: html`<div class="page-actions">
            <button type="button" class="btn btn-compact" data-act="plan">Change plan</button>
            <button type="button" class="btn btn-compact" data-act="status">Subscription…</button>
            <button type="button" class="btn btn-compact" data-act="general">Edit name / timezone</button>
          </div>`,
        })}
        ${card({
          title: `Activity · ${d.usage.period}`,
          body: html`<dl class="dl dl-compact" data-role="usage">
            ${(d.meters || []).map((m) => html`<dt title="${m.definition}">${m.label}</dt><dd>${formatNumber(m.value)}</dd>`)}
          </dl>
          <p class="stat-hint">Informational counters: not plan limits, never enforced.</p>`,
        })}
      </div>
      ${d.limitRows
        ? html`<section class="section card">
            <div class="card-header"><h2 class="card-title">Plan limits</h2><span class="stat-hint">Effective = the business override if set, otherwise the plan's limit. Commercial limits are enforced by the server.</span></div>
            <div class="table-wrap"><table class="table table-compact" data-role="limits">
              <thead><tr><th>Limit</th><th class="num">Plan</th><th class="num">Override</th><th class="num">Effective</th><th class="num">Current</th><th></th></tr></thead>
              <tbody>${d.limitRows.map((l) => {
                const f = limitFormat(l.unit);
                return html`<tr data-limit="${l.limitKey}">
                  <td>${l.label}${l.kind === "monthly" ? html` <span class="stat-hint">/ month</span>` : ""}</td>
                  <td class="num">${l.plan === null ? "—" : f(l.plan)}</td>
                  <td class="num">${l.override === null ? "—" : f(l.override)}</td>
                  <td class="num">${l.effective === null ? "—" : f(l.effective)}</td>
                  <td class="num">${f(l.current)}${l.percent !== null ? html` <span class="stat-hint">${l.percent}%</span>` : ""}${l.atOrOver ? html` ${badge("At limit", "warning")}` : ""}</td>
                  <td class="row-actions"><button type="button" class="btn btn-compact" data-act="limit" data-id="${l.limitKey}">Set override</button>${l.override !== null ? html` <button type="button" class="btn btn-compact" data-act="limit-default" data-id="${l.limitKey}">Default</button>` : ""}</td>
                </tr>`;
              })}</tbody></table></div>
            ${d.storage?.reservedBytes ? html`<p class="stat-hint">${formatBytes(d.storage.reservedBytes)} reserved by uploads in progress.</p>` : ""}
          </section>`
        : ""}
      ${d.history
        ? html`<section class="section card">
            <div class="card-header"><h2 class="card-title">Usage history</h2><span class="stat-hint">Last 12 months. — = not measured that month. Storage and users are current totals, not monthly.</span></div>
            <div class="table-wrap"><table class="table table-compact" data-role="history">
              <thead><tr><th>Month</th>${historyColumns(d).map((id) => html`<th class="num">${METERS[id].label}</th>`)}<th class="num">Records created</th></tr></thead>
              <tbody>${d.history.map((r) =>
                r.recorded
                  ? html`<tr data-period="${r.period}"><td>${r.period}${r.timezone && r.timezone !== b.timezone ? html` <span class="stat-hint">${r.timezone}</span>` : ""}</td>${historyColumns(d).map((id) => html`<td class="num">${r.values[id] === null ? "—" : formatNumber(r.values[id])}</td>`)}<td class="num">${r.recordsCreated === null ? "—" : formatNumber(r.recordsCreated)}</td></tr>`
                  : html`<tr data-period="${r.period}"><td>${r.period}</td><td colspan="${historyColumns(d).length + 1}" class="stat-hint">No recorded usage</td></tr>`
              )}</tbody></table></div>
          </section>`
        : ""}
      <section class="section card">
        <div class="card-header"><h2 class="card-title">Modules</h2><span class="stat-hint">Effective = in the workspace template AND (override Enabled, or the plan includes it and it isn't Disabled). Only the workspace's own modules can be changed.</span></div>
        <div class="table-wrap"><table class="table table-compact" data-role="modules">
          <thead><tr><th>Module</th><th>Workspace</th><th>Plan</th><th>Override</th><th>Effective</th><th></th></tr></thead>
          <tbody>${d.modules.map(
            (m) => html`<tr data-module="${m.id}">
              <td>${m.label}</td><td>${yes(m.template)}</td><td>${yes(m.plan)}</td><td>${ov(m.override)}</td>
              <td>${m.effective ? badge("On", "success") : badge("Off", "neutral")}</td>
              <td class="row-actions">${m.editable ? html`<select class="select select-compact" data-act="override" data-id="${m.id}" aria-label="Override ${m.label}">${Object.entries(OVERRIDE_CHOICES).map(([k, l]) => html`<option value="${k}" ${(m.override === true ? "enabled" : m.override === false ? "disabled" : "default") === k ? "selected" : ""}>${l}</option>`)}</select>` : html`<span class="stat-hint">${m.template ? "core" : "not in this workspace"}</span>`}</td>
            </tr>`
          )}</tbody></table></div>
      </section>
      <section class="section card">
        <div class="card-header"><h2 class="card-title">Members</h2><button type="button" class="btn btn-compact" data-act="add-member">Add member</button></div>
        <div class="table-wrap"><table class="table table-compact" data-role="members">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>${d.members.map(
            (m) => html`<tr data-member="${m.uid}">
              <td>${m.name ?? ""}<div class="stat-hint">${m.email}</div></td>
              <td>${ROLE_TEMPLATES[m.roleTemplate]?.label ?? m.roleTemplate}${m.isAccountOwner ? html` ${badge("Account owner", "primary")}` : ""}</td>
              <td>${m.status === "active" ? badge("Active", "success") : badge("Disabled", "neutral")}</td>
              <td class="row-actions">
                <button type="button" class="btn btn-compact" data-act="setup-link" data-id="${m.uid}">Setup link</button>
                ${m.isAccountOwner ? "" : html`<button type="button" class="btn btn-compact" data-act="member-status" data-id="${m.uid}">${m.status === "active" ? "Deactivate" : "Reactivate"}</button>`}
              </td>
            </tr>`
          )}</tbody></table></div>
      </section>
      ${d.terms.length
        ? card({
            title: "Configuration",
            body: html`<dl class="dl dl-compact" data-role="config">${d.terms.map((t) => html`<dt>${t.label}</dt><dd><select class="select select-compact" data-act="term" data-id="${t.id}">${t.options.map((o) => html`<option value="${o.id}" ${d.config.terminology[t.id]?.choice === o.id ? "selected" : ""}>${o.label}</option>`)}</select></dd>`)}</dl>`,
          })
        : ""}
      <section class="section card">
        <h2 class="card-title">Recent changes</h2>
        <ul class="list activity" data-role="audit">${d.audit.length ? d.audit.map((a) => html`<li>${when(a.at)} • ${a.actor ?? ""} • ${a.summary ?? a.type}${a.reason ? ` · ${a.reason}` : ""}</li>`) : html`<li>No changes recorded yet.</li>`}</ul>
      </section>`
  );

  const reload = () => businessDetailView(el, ctx, businessId);
  const run = async (fn, ok) => {
    try {
      const r = await fn();
      if (r) {
        if (ok) ctx.toast(ok, "success");
        reload();
      }
    } catch (err) {
      ctx.toast(err.message || "Something went wrong", "danger");
      reload();
    }
  };
  const withReason = (title, intro, fields, submitLabel, send) => formDialog({ title, intro, fields: [...fields, { name: "reason", label: "Reason (recorded in the audit log)", type: "textarea", required: true }], submitLabel, onSubmit: send });

  el.onclick = async (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT") return;
    const act = t.dataset.act;
    if (act === "plan") {
      run(() => withReason("Change plan", "Entitlements are recomputed; the workspace ceiling and valid overrides are kept. A downgrade never deletes data: modules become unavailable.", [{ name: "planId", label: "Plan", type: "select", options: ctx.plans.map((p) => ({ value: p.id, label: p.name })), value: b.planId }], "Change plan", (v) => ctx.call("changePlan", { businessId, planId: v.planId, reason: v.reason, expectedRevision: b.adminRevision })), "Plan changed.");
    } else if (act === "status") {
      run(() => withReason(`Subscription · now ${SUBSCRIPTION_LABELS[b.status] ?? b.status}`, "Suspended businesses become read-only; cancelled keeps all data (owner export only). Nothing is deleted.", [{ name: "status", label: "New status", type: "select", options: Object.entries(SUBSCRIPTION_ACTIONS).map(([k, l]) => ({ value: k, label: l })), value: b.status === "active" ? "suspended" : "active" }], "Confirm", (v) => ctx.call("setStatus", { businessId, status: v.status, reason: v.reason, expectedRevision: b.adminRevision })), "Subscription updated.");
    } else if (act === "general") {
      run(() => withReason("Edit name / timezone", "A timezone change doesn't move records already dated.", [{ name: "name", label: "Business name", value: b.name, required: true }, { name: "timezone", label: "Timezone", value: b.timezone }], "Save", (v) => ctx.call("updateGeneral", { businessId, changes: { name: v.name, timezone: v.timezone }, reason: v.reason, expectedRevision: b.adminRevision })), "Saved.");
    } else if (act === "limit" || act === "limit-default") {
      const l = d.limitRows.find((x) => x.limitKey === t.dataset.id);
      run(() => limitOverrideDialog(ctx, { businessId, row: l, clear: act === "limit-default", expectedRevision: b.adminRevision }), act === "limit" ? "Limit override saved." : "Back to the plan's limit.");
    } else if (act === "add-member") {
      run(() => formDialog({ title: "Add member", intro: "Roles come from Luna's role templates. A new person gets an account without a password: share a setup link.", fields: [{ name: "email", label: "Email", required: true }, { name: "name", label: "Name", required: true }, { name: "roleTemplate", label: "Role", type: "select", options: Object.entries(ROLE_TEMPLATES).map(([k, r]) => ({ value: k, label: r.label })), value: "staff" }], submitLabel: "Add member", onSubmit: (v) => ctx.call("addMember", { businessId, email: v.email, name: v.name, roleTemplate: v.roleTemplate }) }), "Member saved.");
    } else if (act === "member-status") {
      const m = d.members.find((x) => x.uid === t.dataset.id);
      run(() => withReason(`${m.status === "active" ? "Deactivate" : "Reactivate"} ${m.email}?`, "Their membership is kept (and can be reactivated).", [], m.status === "active" ? "Deactivate" : "Reactivate", (v) => ctx.call("setMemberStatus", { businessId, uid: m.uid, status: m.status === "active" ? "disabled" : "active", reason: v.reason })), "Member updated.");
    } else if (act === "setup-link") {
      try {
        const r = await ctx.call("setupLink", { businessId, uid: t.dataset.id });
        await formDialog({ title: `Setup link for ${r.email}`, intro: "Share it privately. It lets the person set their password; it expires.", fields: [{ name: "link", label: "Link", value: r.link }], submitLabel: "Done", onSubmit: () => ({}) });
      } catch (err) {
        ctx.toast(err.message, "danger");
      }
    }
  };
  el.onchange = async (e) => {
    const t = e.target;
    if (t.dataset.act === "override") {
      const choice = t.value;
      run(() => withReason(`Override ${t.dataset.id}: ${OVERRIDE_CHOICES[choice]}`, "Stays inside the workspace template; recorded in the audit log.", [], "Apply", (v) => ctx.call("setModuleOverride", { businessId, moduleId: t.dataset.id, choice, reason: v.reason, expectedRevision: b.adminRevision })), "Override applied.");
    } else if (t.dataset.act === "term") {
      run(() => ctx.call("setTerminology", { businessId, terminology: { [t.dataset.id]: t.value } }), "Configuration saved.");
    }
  };
}

// ---------- Limit overrides (Phase 18) ----------

const MB = 1024 * 1024;
const limitFormat = (unit) => (unit === "bytes" ? formatBytes : formatNumber);
// The monthly meters that apply to this business (from the registry, via the server).
const historyColumns = (d) => d.historyMeters || MONTHLY_METER_IDS;

// Sends intent only: { limitKey, value } (value null = back to the plan).
// Storage is typed in MB and sent in bytes. Lowering a limit to or below
// what's already used shows a warning and needs a second confirmation;
// nothing is ever deleted.
export async function limitOverrideDialog(ctx, { businessId, row, clear = false, expectedRevision }) {
  const bytes = row.unit === "bytes";
  const v = await formDialog({
    title: clear ? `${row.label}: back to the plan's limit` : `${row.label}: business override`,
    intro: `Plan limit: ${row.plan === null ? "—" : limitFormat(row.unit)(row.plan)}. Current: ${limitFormat(row.unit)(row.current)}. Separate from module overrides; recorded in the audit log.`,
    fields: [...(clear ? [] : [{ name: "value", label: bytes ? "New limit (MB)" : "New limit", value: row.override === null ? "" : String(bytes ? Math.round(row.override / MB) : row.override), required: true, inputmode: "numeric" }]), { name: "reason", label: "Reason (recorded in the audit log)", type: "textarea", required: true }],
    submitLabel: clear ? "Use the plan's limit" : "Save override",
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

// ---------- Usage across businesses (Phase 18) ----------

export function usageView(el, ctx) {
  const state = { cursors: [null], page: null };
  const cell = (l) => (l ? html`${limitFormat(l.unit)(l.current)} / ${l.effective === null ? "—" : limitFormat(l.unit)(l.effective)}${l.percent !== null ? html` <span class="stat-hint">${l.percent}%</span>` : ""}${l.atOrOver ? html` ${badge("At limit", "warning")}` : ""}` : "—");
  async function load() {
    render(el, html`${pageHeader({ title: "Usage" })}${loading()}`);
    try {
      state.page = await ctx.call("usageOverview", { after: state.cursors.at(-1) });
    } catch (err) {
      render(el, failed(err));
      return;
    }
    const rows = state.page.rows;
    render(
      el,
      html`${pageHeader({ title: "Usage", subtitle: "This month's usage against each business's effective limits (25 per page). Exports and records created are informational." })}
        ${card({
          body: rows.length
            ? html`<div class="table-wrap"><table class="table table-compact" data-role="usage">
                <thead><tr><th>Business</th><th>Plan</th><th class="num">Users</th><th class="num">Orders / mo</th><th class="num">Imports / mo</th><th class="num">Storage</th><th class="num col-secondary">Exports</th><th class="num col-secondary">Records created</th></tr></thead>
                <tbody>${rows.map((r) => {
                  const by = Object.fromEntries(r.limits.map((l) => [l.limitKey, l]));
                  return html`<tr data-business="${r.id}">
                    <td><a href="${ctx.base}/businesses?b=${r.id}" data-link>${r.name}</a><div class="stat-hint">${ctx.workspaceName(r.workspaceTemplateId)} · ${r.period}</div></td>
                    <td>${ctx.planName(r.planId)} ${statusBadge(r.status)}</td>
                    <td class="num">${cell(by.users)}</td><td class="num">${cell(by.ordersPerMonth)}</td><td class="num">${cell(by.importsPerMonth)}</td><td class="num">${cell(by.storageBytes)}</td>
                    <td class="num col-secondary">${formatNumber(r.exports)}</td><td class="num col-secondary">${formatNumber(r.recordsCreated)}</td>
                  </tr>`;
                })}</tbody></table></div>
              <div class="modal-footer"><button type="button" class="btn" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Previous</button><button type="button" class="btn" data-act="next" ${state.page.next ? "" : "disabled"}>Next</button></div>`
            : emptyState({ title: "No businesses yet" }),
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

// ---------- Plans (read-only) ----------

export async function plansView(el, ctx) {
  render(el, html`${pageHeader({ title: "Plans" })}${loading()}`);
  const moduleLabel = (id) => ctx.moduleLabel(id);
  render(
    el,
    html`${pageHeader({ title: "Plans", subtitle: "Stored plans (the authority). Read-only: plans change through the seeded definitions and their validation." })}
      ${card({
        body: html`<div class="table-wrap"><table class="table" data-role="plans">
          <thead><tr><th>Plan</th><th class="num">Setup</th><th class="num">Monthly</th><th class="num">Users</th><th class="num">Orders / mo</th><th class="num">Storage</th><th class="num">Imports / mo</th><th>Modules (default on)</th></tr></thead>
          <tbody>${ctx.plans.map(
            (p) => html`<tr>
              <td>${p.name} ${p.recommended ? badge("Recommended", "primary") : ""}</td>
              <td class="num">${formatMoney(p.pricing.setupFee, { minimum: p.pricing.setupFeeIsMinimum })}</td>
              <td class="num">${formatMoney(p.pricing.monthly, { minimum: p.pricing.monthlyIsMinimum })}</td>
              <td class="num">${formatNumber(p.limits.users)}</td><td class="num">${formatNumber(p.limits.ordersPerMonth)}</td>
              <td class="num">${formatBytes(p.limits.storageBytes)}</td><td class="num">${formatNumber(p.limits.importsPerMonth)}</td>
              <td>${Object.entries(p.modules).filter(([, on]) => on).map(([id]) => moduleLabel(id)).join(", ")}</td>
            </tr>`
          )}</tbody></table></div>`,
      })}`
  );
}

// ---------- Audit ----------

export function auditView(el, ctx) {
  const state = { cursors: [null], page: null };
  async function load() {
    render(el, html`${pageHeader({ title: "Audit" })}${loading()}`);
    try {
      state.page = await ctx.call("audit", { after: state.cursors.at(-1) });
    } catch (err) {
      render(el, failed(err));
      return;
    }
    render(
      el,
      html`${pageHeader({ title: "Audit", subtitle: "Operator and configuration changes across Luna, newest first." })}
        ${card({
          body: html`<div class="table-wrap"><table class="table table-compact" data-role="audit">
            <thead><tr><th>When</th><th>Business</th><th>Change</th><th>By</th><th class="col-secondary">Reason</th></tr></thead>
            <tbody>${state.page.rows.map((a) => html`<tr><td>${when(a.at)}</td><td>${a.businessId ?? (a.operator ? `operator ${a.operator.email}` : "—")}</td><td>${a.summary ?? a.type}</td><td>${a.actor ?? ""}</td><td class="col-secondary">${a.reason ?? ""}</td></tr>`)}</tbody>
          </table></div>
          <div class="modal-footer"><button type="button" class="btn" data-act="prev" ${state.cursors.length > 1 ? "" : "disabled"}>Newer</button><button type="button" class="btn" data-act="next" ${state.page.next ? "" : "disabled"}>Older</button></div>`,
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
