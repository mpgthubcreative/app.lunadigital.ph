// Advances = Work (Phase 14; Phase 18.5 layout): "What was advanced, and
// what is still to be deducted?" One compact row per advance.
//   Date | Employee | Description | Amount | Status ▾ | Paid date | Deducted | View details
// Status is a controlled value (Not Yet Paid / Paid), never free text.
// Choosing Paid records the release (date, method, reference). Release is
// separate from repayment: a paid advance is deducted in full from the
// person's next payroll.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { ADVANCE_STATUSES, SALARY_METHODS, businessDate, parseCentavos } from "@shared/index.js";
import * as defaultData from "../household/data.js";

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const canManage = session.member.permissions["advances.manage"] === true;
  const businessId = session.business.id;
  const today = businessDate(session.business.timezone, now());
  const state = { staffId: "", status: "", from: "", to: "", cursors: [], rows: [], hasMore: false, staff: [], loading: true, error: null };
  let alive = true;
  const filters = () => Object.fromEntries(Object.entries({ staffId: state.staffId, status: state.status, from: state.from, to: state.to }).filter(([, v]) => v));

  async function load() {
    state.loading = true;
    draw();
    try {
      if (!state.staff.length) state.staff = await data.activeStaff(businessId);
      const page = await data.listAdvances(businessId, filters(), { cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("advances: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load advances.";
    }
    state.loading = false;
    draw();
  }

  const statusCell = (a) =>
    canManage && a.status === "not_yet_paid"
      ? html`<select class="select select-compact" data-act="status" data-id="${a.id}" aria-label="Status">${Object.entries(ADVANCE_STATUSES).map(([k, s]) => html`<option value="${k}" ${a.status === k ? "selected" : ""}>${s.label}</option>`)}</select>`
      : badge(ADVANCE_STATUSES[a.status]?.label ?? a.status, a.status === "paid" ? "success" : "warning");

  function draw() {
    if (!alive) return;
    const opt = (v, l, cur) => html`<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
    render(
      container,
      html`
        ${pageHeader({ title: "Advances", subtitle: "Cash advances (bale). Once paid out, an advance is deducted in full from the person's next payroll.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ New advance</button>` : "" })}
        ${filterBar({
          fields: [
            { name: "staffId", label: "Employee", type: "select", primary: true, all: "All employees", options: state.staff.map((x) => [x.id, x.name]), value: state.staffId },
            { name: "status", label: "Status", type: "select", primary: true, all: "Any status", options: Object.entries(ADVANCE_STATUSES).map(([k, x]) => [k, x.label]), value: state.status },
            { name: "from", label: "From", type: "date", value: state.from },
            { name: "to", label: "To", type: "date", value: state.to },
          ],
          end: mayExport(session, "advances") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("advances")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(4)
              : !state.rows.length
                ? emptyState({ iconName: "advance", title: "No advances", body: "Advances you give household staff appear here." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="advances">
                    <thead><tr><th class="m-only"></th><th>Date</th><th>Employee</th><th class="col-secondary">Description</th><th class="num">Amount</th><th>Status</th><th class="col-secondary">Paid date</th><th class="col-secondary">Deducted</th><th><span class="visually-hidden">Details</span></th></tr></thead>
                    <tbody>${state.rows.map(
                      (a) => html`<tr data-advance="${a.id}" data-open>
                        ${mobileCell({ title: a.staffName, sub: `${formatDayId(a.date)}${a.description ? ` · ${a.description}` : ""} · ${a.deducted ? "deducted" : a.status === "paid" ? "deduct next payroll" : "not paid out yet"}`, end: formatCentavos(a.amount) })}
                        <td>${formatDayId(a.date)}</td><td>${a.staffName}</td><td class="col-secondary">${a.description || "—"}</td><td class="num">${formatCentavos(a.amount)}</td>
                        <td data-m="ctl">${statusCell(a)}</td><td class="col-secondary">${a.paidDate ? formatDayId(a.paidDate) : "—"}</td>
                        <td class="col-secondary">${a.deducted ? "Yes" : a.deductionPayrollId ? "In unpaid payroll" : a.status === "paid" ? "Next payroll" : "—"}</td>
                        <td class="row-actions" data-m="more">${openButton(a.id, `View advance of ${a.staffName}`, { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager">
                    <button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button>
                    <button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button>
                  </div>`}
        </section>`
    );
  }

  const markPaid = (a) =>
    formDialog({
      title: `Mark ${formatCentavos(a.amount)} to ${a.staffName} as paid`,
      intro: "It will be deducted in full from their next payroll.",
      fields: [
        { name: "paidDate", label: "Paid date", type: "date", value: today, max: today },
        { name: "method", label: "Paid via", type: "select", value: "cash", options: Object.entries(SALARY_METHODS).map(([value, m]) => ({ value, label: m.label })) },
        { name: "reference", label: "Reference (optional)" },
      ],
      submitLabel: "Mark paid",
      onSubmit: (v) => data.advancesApi({ action: "markPaid", advanceId: a.id, release: { paidDate: v.paidDate || today, method: v.method, ...(v.reference ? { reference: v.reference } : {}) } }),
    });

  async function view(a) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    render(
      backdrop,
      html`<div class="modal" role="dialog" aria-modal="true" aria-label="Advance" data-role="advance-view">
        <div class="modal-header"><h2 class="card-title">${a.staffName} · ${formatCentavos(a.amount)}</h2></div>
        <div class="modal-body">
          <dl class="dl dl-compact"><dt>Date</dt><dd>${formatDayId(a.date)}</dd><dt>Description</dt><dd>${a.description || "—"}</dd>
            <dt>Status</dt><dd>${ADVANCE_STATUSES[a.status]?.label}</dd>${a.paidDate ? html`<dt>Paid</dt><dd>${formatDayId(a.paidDate)} via ${SALARY_METHODS[a.method]?.label}${a.reference ? ` · Ref ${a.reference}` : ""}</dd>` : ""}
            <dt>Deducted</dt><dd>${a.deducted ? "Yes" : a.deductionPayrollId ? "In an unpaid payroll" : a.status === "paid" ? "From the next payroll" : "Not until it's paid"}</dd></dl>
          <ul class="list activity">${(a.history || []).map((h) => html`<li>${h.label}${h.actor ? ` · ${h.actor.name}` : ""}</li>`)}</ul>
        </div>
        <div class="modal-footer">${canManage && a.status === "not_yet_paid" ? html`<button type="button" class="btn btn-danger" data-x="delete">Delete</button>` : ""}<button type="button" class="btn" data-x="close">Close</button></div>
      </div>`
    );
    backdrop.addEventListener("click", async (event) => {
      const x = event.target === backdrop ? "close" : event.target.closest("[data-x]")?.dataset.x;
      if (x === "close") backdrop.remove();
      if (x === "delete" && (await confirmDialog({ title: "Delete this advance?", body: "Only advances not yet paid can be deleted.", confirmLabel: "Delete", danger: true }))) {
        try {
          await data.advancesApi({ action: "delete", advanceId: a.id });
          backdrop.remove();
          load();
        } catch (err) {
          toast(err.message, "danger");
        }
      }
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.tagName === "SELECT") return;
    const a = state.rows.find((r) => r.id === el.dataset.id);
    if (el.dataset.act === "new") {
      if (!state.staff.length) return toast("Add household staff first.", "danger");
      const r = await formDialog({
        title: "New advance",
        fields: [
          { name: "staffId", label: "Employee", type: "select", value: state.staff[0].id, options: state.staff.map((s) => ({ value: s.id, label: s.name })) },
          { name: "date", label: "Date", type: "date", value: today, max: today },
          { name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" },
          { name: "description", label: "Description", hint: "e.g. Fare home, medicine" },
        ],
        onSubmit: (v) => data.advancesApi({ action: "create", advance: { staffId: v.staffId, date: v.date || today, amount: parseCentavos(v.amount), ...(v.description ? { description: v.description } : {}) } }),
      });
      if (r) {
        toast("Advance recorded (Not Yet Paid).", "success");
        load();
      }
    } else if (el.dataset.act === "view" && a) view(a);
    else if (el.dataset.act === "next" && state.rows.length) {
      state.cursors.push(state.rows.at(-1));
      load();
    } else if (el.dataset.act === "prev") {
      state.cursors.pop();
      load();
    }
  };
  const onChange = async (event) => {
    const el = event.target;
    if (el.dataset.act !== "status" || el.value !== "paid") return;
    const a = state.rows.find((r) => r.id === el.dataset.id);
    const r = a ? await markPaid(a) : null;
    if (r) toast("Advance marked paid.", "success");
    load();
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const f = event.target.elements;
    if (f.from.value && f.to.value && f.from.value > f.to.value) return toast("The start date is after the end date.", "danger");
    Object.assign(state, { staffId: f.staffId.value, status: f.status.value, from: f.from.value, to: f.to.value, cursors: [] });
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, filters, { toast, deps: exportDeps });
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
    unbindExport();
    unbindFilters();
    unbindRows();
  };
}
