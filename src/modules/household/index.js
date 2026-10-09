// Household Staff (Phase 14): one compact row per person.
//   Name | Position | Daily wage | Pay cycle | Status | Edit · Deactivate
// The daily wage and pay cycle drive attendance and payroll; Luna computes
// pay from them, nobody types base pay.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { PAY_CYCLES, STAFF_STATUSES, parseCentavos } from "@shared/index.js";
import * as defaultData from "./data.js";

const cycleOptions = Object.entries(PAY_CYCLES).map(([value, c]) => ({ value, label: c.label }));
const centsText = (c) => (c ? String(c / 100) : "");

function staffFields(s = {}) {
  return [
    { name: "name", label: "Name", value: s.name ?? "", required: true },
    { name: "position", label: "Position", value: s.position ?? "", hint: "e.g. Kasambahay, Yaya, Driver" },
    { name: "dailyWage", label: "Daily wage (₱)", value: centsText(s.dailyWage), required: true, inputmode: "decimal" },
    { name: "payCycle", label: "Pay cycle", type: "select", value: s.payCycle ?? "semi_monthly", options: cycleOptions },
    { name: "phone", label: "Phone", value: s.phone ?? "", inputmode: "tel" },
    { name: "startDate", label: "Start date", type: "date", value: s.startDate ?? "" },
    { name: "notes", label: "Notes", type: "textarea", value: s.notes ?? "" },
  ];
}

function toInput(v) {
  const out = { ...v, dailyWage: parseCentavos(v.dailyWage) };
  for (const k of ["position", "phone", "startDate", "notes"]) if (out[k] === "") out[k] = null;
  return out;
}

export function mount(container, session, { data = defaultData, toast = defaultToast, exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["household.manage"] === true;
  const businessId = session.business.id;
  const state = { status: "active", rows: [], loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      state.rows = (await data.listStaff(businessId, { status: state.status })).rows;
      state.error = null;
    } catch (err) {
      console.error("household: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load household staff.";
    }
    state.loading = false;
    draw();
  }

  function draw() {
    if (!alive) return;
    render(
      container,
      html`
        ${pageHeader({ title: "Household Staff", subtitle: "The people you pay, their daily wage and pay cycle.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">Add staff</button>` : "" })}
        <form class="section card filters filters-inline" data-role="filters">
          <select class="select" name="status" aria-label="Status">${Object.entries(STAFF_STATUSES).map(([k, s]) => html`<option value="${k}" ${state.status === k ? "selected" : ""}>${s.label}</option>`)}</select>
          <button type="submit" class="btn">Apply</button>
          ${mayExport(session, "householdStaff") ? html`${exportButton("householdStaff")}<span class="stat-hint">${exportHint}</span>` : ""}
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !state.rows.length
                ? emptyState({ iconName: "staff", title: state.status === "active" ? "No household staff yet" : "No inactive staff", body: "Add the people you pay to start marking attendance." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="staff">
                    <thead><tr><th>Name</th><th class="col-secondary">Position</th><th class="num">Daily wage</th><th>Pay cycle</th><th>Status</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (s) => html`<tr data-staff="${s.id}">
                        <td>${s.name}</td><td class="col-secondary">${s.position || "—"}</td>
                        <td class="num">${formatCentavos(s.dailyWage)}</td><td>${PAY_CYCLES[s.payCycle]?.label ?? s.payCycle}</td>
                        <td>${badge(STAFF_STATUSES[s.status]?.label ?? s.status, s.status === "active" ? "success" : "neutral")}</td>
                        <td class="row-actions">${canManage
                          ? html`<button type="button" class="btn btn-compact" data-act="edit" data-id="${s.id}">Edit</button>
                              <button type="button" class="btn btn-compact" data-act="status" data-id="${s.id}">${s.status === "active" ? "Deactivate" : "Reactivate"}</button>`
                          : ""}</td>
                      </tr>`
                    )}</tbody></table></div>`}
        </section>`
    );
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    const s = state.rows.find((r) => r.id === el.dataset.id);
    try {
      if (el.dataset.act === "new") {
        const r = await formDialog({ title: "Add household staff", fields: staffFields(), submitLabel: "Save", onSubmit: (v) => data.staffApi({ action: "create", staff: toInput(v) }) });
        if (r) toast("Staff member added.", "success");
      } else if (el.dataset.act === "edit" && s) {
        const r = await formDialog({
          title: `Edit ${s.name}`,
          fields: staffFields(s),
          onSubmit: (v) => {
            const next = toInput(v);
            const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (s[k] ?? null) !== (val ?? null)));
            return Object.keys(changes).length ? data.staffApi({ action: "update", staffId: s.id, changes }) : { unchanged: true };
          },
        });
        if (r && !r.unchanged) toast("Saved.", "success");
      } else if (el.dataset.act === "status" && s) {
        await data.staffApi({ action: "setStatus", staffId: s.id, status: s.status === "active" ? "inactive" : "active" });
      } else return;
      load();
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    state.status = event.target.elements.status.value;
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, () => ({ status: state.status }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
    unbindExport();
  };
}
