// Providers / Vendors (Phase 15): a small Baby directory of clinics, shops
// and services, one compact row each.
//   Name | Type | Phone | Address / location | Status | Edit · Deactivate · View details
// Not Distributor Customers, not Bridal suppliers. Expenses and scheduled
// payments keep the provider's name as it was when recorded.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, rowMenu, bindRowMenus } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { PROVIDER_TYPES, PROVIDER_STATUSES } from "@shared/index.js";
import * as defaultData from "./data.js";
import { activityLines, detailsDialog } from "./common.js";

const TYPE_OPTIONS = Object.entries(PROVIDER_TYPES).map(([value, t]) => ({ value, label: t.label }));
const typeLabel = (t) => PROVIDER_TYPES[t]?.label ?? t;

const providerFields = (p = {}) => [
  { name: "name", label: "Name", value: p.name ?? "", required: true, hint: "e.g. ABC Women's Clinic, Baby Company" },
  { name: "type", label: "Type", type: "select", options: TYPE_OPTIONS, value: p.type ?? "medical" },
  { name: "phone", label: "Phone", value: p.phone ?? "", inputmode: "tel" },
  { name: "email", label: "Email", value: p.email ?? "" },
  { name: "location", label: "Address / location", value: p.location ?? "" },
  { name: "notes", label: "Notes", type: "textarea", value: p.notes ?? "" },
];

export function toProviderInput(v) {
  const out = { name: v.name.trim(), type: v.type };
  for (const k of ["phone", "email", "location", "notes"]) out[k] = v[k].trim() || null;
  return out;
}

export function mount(container, session, { data = defaultData, toast = defaultToast, exportDeps = {}, confirm = confirmDialog } = {}) {
  const canManage = session.member.permissions["providers.manage"] === true;
  const businessId = session.business.id;
  const timezone = session.business.timezone;
  const state = { filters: { status: "active" }, cursors: [], rows: [], hasMore: false, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      const page = await data.listProviders(businessId, state.filters, { cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("providers: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load providers.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;

  function draw() {
    if (!alive) return;
    const f = state.filters;
    render(
      container,
      html`
        ${pageHeader({ title: "Providers / Vendors", subtitle: "Clinics, shops and services you pay for your baby.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">Add provider</button>` : "" })}
        <form class="filter-form toolbar filter-toolbar" data-role="filters" data-auto-apply>
          <input class="input" name="search" placeholder="Name starts with…" value="${f.search || ""}" autocomplete="off" aria-label="Search name" />
          <select class="select" name="type" aria-label="Type">${opt("", "Any type", f.type || "")}${TYPE_OPTIONS.map((t) => opt(t.value, t.label, f.type))}</select>
          <select class="select" name="status" aria-label="Status">${Object.entries(PROVIDER_STATUSES).map(([k, s]) => opt(k, s.label, f.status))}</select>
          <button type="submit" class="visually-hidden" tabindex="-1">Apply</button>
          ${mayExport(session, "providers") ? html`<span class="toolbar-end">${exportButton("providers")}<span class="visually-hidden">${exportHint}</span></span>` : ""}
        </form>
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "provider", title: f.status === "active" ? "No providers yet" : "No inactive providers", body: "Save the clinics and shops you pay, then pick them when recording an expense." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="providers">
                    <thead><tr><th class="m-only"></th><th>Name</th><th>Type</th><th class="col-secondary">Phone</th><th class="col-secondary">Address / location</th><th>Status</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (p) => html`<tr data-provider="${p.id}" data-open>${mobileCell({ title: p.name, sub: [typeLabel(p.type), p.phone].filter(Boolean).join(" · ") })}
                        <td>${p.name}</td><td>${typeLabel(p.type)}</td>
                        <td class="col-secondary">${p.phone || "—"}</td><td class="col-secondary">${p.location || "—"}</td>
                        <td>${badge(PROVIDER_STATUSES[p.status]?.label ?? p.status, p.status === "active" ? "success" : "neutral")}</td>
                        <td class="row-actions" data-m="more">${canManage ? rowMenu(p.id, [{ act: "edit", label: "Edit" }, { act: "status", label: p.status === "active" ? "Deactivate" : "Reactivate" }, { sep: true }, { act: "delete", label: "Delete (added by mistake)", danger: true }], { label: `Actions for ${p.name}` }) : ""}${openButton(p.id, "View details", { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>`}
        </section>`
    );
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    const p = state.rows.find((r) => r.id === el.dataset.id);
    try {
      let r = null;
      let message = "Saved.";
      switch (el.dataset.act) {
        case "new":
          r = await formDialog({ title: "Add provider", fields: providerFields(), onSubmit: (v) => data.providersApi({ action: "create", provider: toProviderInput(v) }) });
          message = "Provider added.";
          break;
        case "edit":
          if (!p) return;
          r = await formDialog({
            title: `Edit ${p.name}`,
            intro: "Past expenses keep the name they were recorded with.",
            fields: providerFields(p),
            onSubmit: (v) => {
              const next = toProviderInput(v);
              const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (p[k] ?? null) !== (val ?? null)));
              return Object.keys(changes).length ? data.providersApi({ action: "update", providerId: p.id, expectedRevision: p.revision, changes }) : { unchanged: true };
            },
          });
          break;
        case "delete":
          if (!p) return;
          if (!(await confirm({ title: `Delete ${p.name}?`, body: "Only for a provider added by mistake. Providers used by expenses or scheduled payments can't be deleted; deactivate them instead.", confirmLabel: "Delete", danger: true }))) return;
          r = await data.providersApi({ action: "delete", providerId: p.id });
          message = `${p.name} deleted.`;
          break;
        case "status":
          if (!p) return;
          r = await data.providersApi({ action: "setStatus", providerId: p.id, status: p.status === "active" ? "inactive" : "active" });
          message = p.status === "active" ? "Provider deactivated. Past expenses keep it." : "Provider reactivated.";
          break;
        case "view":
          if (!p) return;
          detailsDialog({
            title: p.name,
            badgeHtml: badge(PROVIDER_STATUSES[p.status]?.label ?? p.status, p.status === "active" ? "success" : "neutral"),
            rows: [["Type", typeLabel(p.type)], ["Phone", p.phone], ["Email", p.email], ["Address / location", p.location], ["Notes", p.notes]],
            activity: activityLines(p.history, timezone),
            onAction: async () => false,
          });
          return;
        case "next":
          state.cursors.push(state.rows.at(-1));
          load();
          return;
        case "prev":
          state.cursors.pop();
          load();
          return;
        default:
          return;
      }
      if (r && !r.unchanged) toast(message, "success");
      if (r) load();
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const el = event.target.elements;
    state.filters = Object.fromEntries([["status", el.status.value], ["type", el.type.value], ["search", el.search.value.trim()]].filter(([, v]) => v));
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindMenus = bindRowMenus(container);
  const unbindExport = bindExport(container, () => ({ ...state.filters }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    unbindFilters();
    unbindRows();
    unbindMenus();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
