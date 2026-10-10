// Wedding Suppliers (Phase 16): one compact row per supplier.
//   Supplier | Service | Agreed | Paid | Balance | Next Due | Status | View details
// Paid, Balance and Next Due are computed by Luna (paid = the supplier's
// Wedding Expenses; balance = agreed − paid); nobody types them. Not
// Distributor Customers, not Baby providers.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, rowMenu, bindRowMenus } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { SUPPLIER_SERVICES, SUPPLIER_STATUSES, supplierBalance, businessDate } from "@shared/index.js";
import { parseBudget } from "../baby/budget.js";
import { activityLines, detailsDialog, optionsOf } from "../baby/common.js";
import * as defaultData from "./data.js";

const SERVICE_OPTIONS = Object.entries(SUPPLIER_SERVICES).map(([value, s]) => ({ value, label: s.label }));
const serviceLabel = (s) => SUPPLIER_SERVICES[s]?.label ?? s;
const pesosText = (c) => (Number.isSafeInteger(c) ? String(c / 100) : "");

const supplierFields = (s = {}, categories = []) => [
  { name: "name", label: "Supplier / business name", value: s.name ?? "", required: true, hint: "e.g. ABC Photo Studio" },
  { name: "service", label: "Service", type: "select", options: SERVICE_OPTIONS, value: s.service ?? "venue" },
  { name: "agreedAmount", label: "Agreed / contract amount (₱, optional)", value: pesosText(s.agreedAmount), inputmode: "decimal", hint: "Leave blank if you're only keeping their contact." },
  { name: "categoryId", label: "Budget category for its payments", type: "select", options: optionsOf(categories.filter((c) => c.status === "active"), { blank: "— Choose when scheduling —" }), value: s.categoryId ?? "" },
  { name: "contactPerson", label: "Contact person", value: s.contactPerson ?? "" },
  { name: "phone", label: "Phone", value: s.phone ?? "", inputmode: "tel" },
  { name: "email", label: "Email", value: s.email ?? "" },
  { name: "location", label: "Address / location", value: s.location ?? "" },
  { name: "notes", label: "Notes", type: "textarea", value: s.notes ?? "" },
];

export function toSupplierInput(v) {
  const out = { name: v.name.trim(), service: v.service, agreedAmount: parseBudget(v.agreedAmount, "agreed amount"), categoryId: v.categoryId || null };
  for (const k of ["contactPerson", "phone", "email", "location", "notes"]) out[k] = (v[k] || "").trim() || null;
  return out;
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, confirm = confirmDialog } = {}) {
  const canManage = session.member.permissions["vendors.manage"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "active" }, cursors: [], rows: [], hasMore: false, categories: [], loading: true, error: null };
  let alive = true;
  const money = (c) => (c === null || c === undefined ? "—" : formatCentavos(c, currency));

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, page] = await Promise.all([state.categories.length || !session.member.permissions["budget.view"] ? state.categories : data.listCategories(businessId).catch(() => []), data.listSuppliers(businessId, state.filters, { cursor: state.cursors.at(-1) || null })]);
      state.categories = cats;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("wedding suppliers: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load suppliers.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;
  const nextDueCell = (s) => (s.nextDue ? html`${formatDayId(s.nextDue)}${s.nextDue < today() ? html` ${badge("Overdue", "danger")}` : ""}` : "—");

  function draw() {
    if (!alive) return;
    const f = state.filters;
    render(
      container,
      html`
        ${pageHeader({ title: "Wedding Suppliers", subtitle: "Your venue, caterer, photographer and other suppliers: what you agreed, what you've paid and what's left.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">Add supplier</button>` : "" })}
        <form class="filter-form toolbar filter-toolbar" data-role="filters" data-auto-apply>
          <input class="input" name="search" placeholder="Name starts with…" value="${f.search || ""}" autocomplete="off" aria-label="Search name" />
          <select class="select" name="service" aria-label="Service">${opt("", "Any service", f.service || "")}${SERVICE_OPTIONS.map((s) => opt(s.value, s.label, f.service))}</select>
          <select class="select" name="status" aria-label="Status">${Object.entries(SUPPLIER_STATUSES).map(([k, s]) => opt(k, s.label, f.status))}</select>
          <button type="submit" class="visually-hidden" tabindex="-1">Apply</button>
          ${mayExport(session, "weddingSuppliers") ? html`<span class="toolbar-end">${exportButton("weddingSuppliers")}<span class="visually-hidden">${exportHint}</span></span>` : ""}
        </form>
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "provider", title: f.status === "active" ? "No suppliers yet" : "No inactive suppliers", body: "Add your suppliers and their agreed amounts to track balances and payments." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="suppliers">
                    <thead><tr><th class="m-only"></th><th>Supplier</th><th>Service</th><th class="num">Agreed</th><th class="num">Paid</th><th class="num">Balance</th><th>Next due</th><th class="col-secondary">Status</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (s) => html`<tr data-supplier="${s.id}" data-open>${mobileCell({ title: s.name, sub: `${serviceLabel(s.service)} · ${money(s.paid ?? 0)} paid`, end: money(supplierBalance(s)), endSub: "balance" })}
                        <td>${s.name}</td><td>${serviceLabel(s.service)}</td>
                        <td class="num">${money(s.agreedAmount)}</td><td class="num">${money(s.paid ?? 0)}</td><td class="num">${money(supplierBalance(s))}</td>
                        <td>${nextDueCell(s)}</td>
                        <td class="col-secondary">${badge(SUPPLIER_STATUSES[s.status]?.label ?? s.status, s.status === "active" ? "success" : "neutral")}</td>
                        <td class="row-actions" data-m="more">${openButton(s.id, "View details", { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>`}
        </section>`
    );
  }

  const editDialog = (s) =>
    formDialog({
      title: `Edit ${s.name}`,
      intro: "Past expenses and payments keep the name they were recorded with. The agreed amount can't go below what's already paid or scheduled.",
      fields: supplierFields(s, state.categories),
      onSubmit: (v) => {
        const next = toSupplierInput(v);
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (s[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? data.suppliersApi({ action: "update", supplierId: s.id, expectedRevision: s.revision, changes }) : { unchanged: true };
      },
    });

  function openView(s) {
    detailsDialog({
      title: s.name,
      badgeHtml: badge(SUPPLIER_STATUSES[s.status]?.label ?? s.status, s.status === "active" ? "success" : "neutral"),
      rows: [
        ["Service", serviceLabel(s.service)],
        ["Agreed amount", s.agreedAmount === null || s.agreedAmount === undefined ? "No agreement recorded" : money(s.agreedAmount)],
        ["Paid", money(s.paid ?? 0)],
        ["Balance", money(supplierBalance(s))],
        ["Upcoming", `${money(s.upcoming ?? 0)}${s.upcomingCount ? ` (${s.upcomingCount} payment${s.upcomingCount === 1 ? "" : "s"})` : ""}`],
        ["Next due", s.nextDue ? formatDayId(s.nextDue) : null],
        ["Contact person", s.contactPerson],
        ["Phone", s.phone],
        ["Email", s.email],
        ["Address / location", s.location],
        ["Notes", s.notes],
      ],
      activity: activityLines(s.history, timezone),
      // Delete only shows for a supplier nothing was recorded against (the server re-checks).
      actions: canManage ? [...(!(s.paid > 0) && !(s.upcomingCount > 0) ? [{ act: "delete", label: "Delete", danger: true }] : []), { act: "status", label: s.status === "active" ? "Deactivate" : "Reactivate" }, { act: "edit", label: "Edit" }] : [],
      onAction: async (act) => {
        try {
          if (act === "edit") {
            const r = await editDialog(s);
            if (r && !r.unchanged) toast("Saved.", "success");
            if (r) load();
            return Boolean(r);
          }
          if (act === "delete") {
            if (!(await confirm({ title: `Delete ${s.name}?`, body: "Only for a supplier added by mistake. Suppliers with payments or expenses can't be deleted; deactivate them instead so their history and balance stay.", confirmLabel: "Delete", danger: true }))) return false;
            await data.suppliersApi({ action: "delete", supplierId: s.id });
            toast(`${s.name} deleted.`, "success");
            load();
            return true;
          }
          if (act === "status") {
            await data.suppliersApi({ action: "setStatus", supplierId: s.id, status: s.status === "active" ? "inactive" : "active" });
            toast(s.status === "active" ? "Supplier deactivated. Its history and balance are kept." : "Supplier reactivated.", "success");
            load();
            return true;
          }
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    try {
      switch (el.dataset.act) {
        case "new": {
          const r = await formDialog({ title: "Add supplier", fields: supplierFields({}, state.categories), onSubmit: (v) => data.suppliersApi({ action: "create", supplier: toSupplierInput(v) }) });
          if (r) {
            toast("Supplier added.", "success");
            load();
          }
          return;
        }
        case "view": {
          const s = state.rows.find((r) => r.id === el.dataset.id);
          if (s) openView(s);
          return;
        }
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
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const el = event.target.elements;
    state.filters = Object.fromEntries([["status", el.status.value], ["service", el.service.value], ["search", el.search.value.trim()]].filter(([, v]) => v));
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
