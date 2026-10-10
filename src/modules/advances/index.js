// Advances = Work (Phase 14; Phase 18.5 layout): "What was advanced, and
// what is still to be deducted?" One compact row per advance.
//   Date | Employee | Description | Amount | Status | Released | Left to repay | View details
// Phase 18.6: Requested (by the staff member) -> Approved -> Released
// (paid out: date, method, reference) -> deducted per payroll, all at once
// or a set amount each payday, until nothing is left. Approval is not the
// money; release is separate from repayment; a rejected request goes nowhere.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { ADVANCE_STATUSES, SALARY_METHODS, businessDate, parseCentavos, advanceRemaining } from "@shared/index.js";
import * as defaultData from "../household/data.js";

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const canManage = session.member.permissions["advances.manage"] === true;
  const businessId = session.business.id;
  const today = businessDate(session.business.timezone, now());
  const state = { staffId: "", status: "", from: "", to: "", cursors: [], rows: [], requests: [], hasMore: false, staff: [], loading: true, error: null };
  const optionalPesos = (v) => (v && String(v).trim() ? parseCentavos(v) : null);
  let alive = true;
  const filters = () => Object.fromEntries(Object.entries({ staffId: state.staffId, status: state.status, from: state.from, to: state.to }).filter(([, v]) => v));

  async function load() {
    state.loading = true;
    draw();
    try {
      if (!state.staff.length) state.staff = await data.activeStaff(businessId);
      const [page, requests] = await Promise.all([data.listAdvances(businessId, filters(), { cursor: state.cursors.at(-1) || null }), canManage ? data.listAdvances(businessId, { status: "requested" }, { pageSize: 50 }).then((p) => p.rows).catch(() => []) : []]);
      state.requests = requests;
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

  const TONE = { requested: "warning", not_yet_paid: "info", paid: "success", rejected: "neutral" };
  // Approved: choosing Released records the payout. Requested: Approve / Reject.
  const statusCell = (a) =>
    canManage && a.status === "not_yet_paid"
      ? html`<select class="select select-compact" data-act="status" data-id="${a.id}" aria-label="Status">${["not_yet_paid", "paid"].map((k) => html`<option value="${k}" ${a.status === k ? "selected" : ""}>${ADVANCE_STATUSES[k].label}</option>`)}</select>`
      : canManage && a.status === "requested"
        ? html`<span class="request-actions"><button type="button" class="btn btn-compact" data-act="reject" data-id="${a.id}">Reject</button><button type="button" class="btn btn-compact btn-primary" data-act="approve" data-id="${a.id}">Approve</button></span>`
        : badge(ADVANCE_STATUSES[a.status]?.label ?? a.status, TONE[a.status] || "neutral");
  const leftText = (a) => (a.status !== "paid" ? "—" : advanceRemaining(a) === 0 ? "Repaid" : `${formatCentavos(advanceRemaining(a))}${a.installment ? ` · ${formatCentavos(a.installment)}/payday` : ""}`);

  function draw() {
    if (!alive) return;
    const opt = (v, l, cur) => html`<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
    render(
      container,
      html`
        ${pageHeader({ title: "Advances", subtitle: "Cash advances (bale). Once paid out, they're taken from salary: all at once, or a set amount each payday.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ New advance</button>` : "" })}
        ${canManage && state.requests.length && state.status !== "requested"
          ? html`<section class="card section" data-section="requests"><h2 class="card-title">Waiting for your approval (${state.requests.length})</h2>
              <ul class="request-list" data-role="advance-requests">${state.requests.map(
                (a) => html`<li data-advance="${a.id}"><div class="request-main"><strong>${a.staffName}</strong> asks for ${formatCentavos(a.requestedAmount ?? a.amount)}<small>${formatDayId(a.date)}${a.description ? ` · "${a.description}"` : ""}</small></div>
                  <div class="request-actions"><button type="button" class="btn btn-compact" data-act="reject" data-id="${a.id}">Reject</button><button type="button" class="btn btn-compact btn-primary" data-act="approve" data-id="${a.id}">Approve</button></div></li>`
              )}</ul></section>`
          : ""}
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
                    <thead><tr><th class="m-only"></th><th>Date</th><th>Employee</th><th class="col-secondary">Description</th><th class="num">Amount</th><th>Status</th><th class="col-secondary">Released</th><th class="col-secondary">Left to repay</th><th><span class="visually-hidden">Details</span></th></tr></thead>
                    <tbody>${state.rows.map(
                      (a) => html`<tr data-advance="${a.id}" data-open>
                        ${mobileCell({ title: a.staffName, sub: `${formatDayId(a.date)}${a.description ? ` · ${a.description}` : ""} · ${a.status === "paid" ? (advanceRemaining(a) ? `${formatCentavos(advanceRemaining(a))} left` : "repaid") : (ADVANCE_STATUSES[a.status]?.label ?? a.status).toLowerCase()}`, end: formatCentavos(a.amount) })}
                        <td>${formatDayId(a.date)}</td><td>${a.staffName}</td><td class="col-secondary">${a.description || "—"}</td><td class="num">${formatCentavos(a.amount)}</td>
                        <td data-m="ctl">${statusCell(a)}</td><td class="col-secondary">${a.paidDate ? formatDayId(a.paidDate) : "—"}</td>
                        <td class="col-secondary" data-col="left">${leftText(a)}</td>
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
      title: `Release ${formatCentavos(a.amount)} to ${a.staffName}`,
      intro: a.installment ? `${formatCentavos(a.installment)} will be taken from each payroll until it's repaid.` : "It will be taken in full from their next payroll.",
      fields: [
        { name: "paidDate", label: "Paid date", type: "date", value: today, max: today },
        { name: "method", label: "Paid via", type: "select", value: "cash", options: Object.entries(SALARY_METHODS).map(([value, m]) => ({ value, label: m.label })) },
        { name: "reference", label: "Reference (optional)" },
      ],
      submitLabel: "Mark released",
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
            ${a.requestedAmount && a.requestedAmount !== a.amount ? html`<dt>Asked for</dt><dd>${formatCentavos(a.requestedAmount)}</dd>` : ""}
            <dt>Taken from salary</dt><dd>${a.installment ? `${formatCentavos(a.installment)} each payday` : "All at once"}</dd>
            <dt>Left to repay</dt><dd>${a.status === "paid" ? leftText(a) : "Not until it's released"}</dd>
            ${(a.deductionLog || []).length ? html`<dt>Deductions</dt><dd>${a.deductionLog.map((d) => `${formatCentavos(d.amount)} (period to ${formatDayId(d.periodEnd)})`).join(" · ")}</dd>` : ""}</dl>
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
          { name: "installment", label: "Take from each payroll (₱, optional)", inputmode: "decimal", hint: "Leave blank to take it all from the next payroll." },
        ],
        onSubmit: (v) => data.advancesApi({ action: "create", advance: { staffId: v.staffId, date: v.date || today, amount: parseCentavos(v.amount), ...(v.description ? { description: v.description } : {}), ...(optionalPesos(v.installment) ? { installment: optionalPesos(v.installment) } : {}) } }),
      });
      if (r) {
        toast("Advance recorded. Mark it released when you hand over the money.", "success");
        load();
      }
    } else if (el.dataset.act === "approve") {
      const req = state.rows.find((r) => r.id === el.dataset.id) || state.requests.find((r) => r.id === el.dataset.id);
      if (!req) return undefined;
      const asked = req.requestedAmount ?? req.amount;
      const r = await formDialog({
        title: `Approve ${req.staffName}'s advance`,
        intro: `${req.staffName} asked for ${formatCentavos(asked)}${req.description ? ` (${req.description})` : ""}. Approving doesn't move money: mark it released when you hand it over.`,
        fields: [
          { name: "amount", label: "Approved amount (₱)", value: String(asked / 100), inputmode: "decimal", required: true },
          { name: "installment", label: "Take from each payroll (₱, optional)", inputmode: "decimal", hint: "Leave blank to take it all from the next payroll." },
          { name: "note", label: "Message to them (optional)" },
        ],
        submitLabel: "Approve",
        onSubmit: (v) => data.advancesApi({ action: "decide", advanceId: req.id, decision: { decision: "approve", ...(v.note.trim() ? { note: v.note.trim() } : {}) }, approval: { amount: parseCentavos(v.amount), ...(optionalPesos(v.installment) ? { installment: optionalPesos(v.installment) } : {}) } }),
      });
      if (r) {
        toast("Approved. Mark it released when you hand over the money.", "success");
        load();
      }
    } else if (el.dataset.act === "reject") {
      const req = state.rows.find((r) => r.id === el.dataset.id) || state.requests.find((r) => r.id === el.dataset.id);
      if (!req) return undefined;
      const r = await formDialog({
        title: `Reject ${req.staffName}'s request?`,
        fields: [{ name: "note", label: "Message to them (optional)", placeholder: "e.g. Next month" }],
        submitLabel: "Reject",
        onSubmit: (v) => data.advancesApi({ action: "decide", advanceId: req.id, decision: { decision: "reject", ...(v.note.trim() ? { note: v.note.trim() } : {}) } }),
      });
      if (r) {
        toast("Request rejected.", "success");
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
    if (r) toast("Advance released.", "success");
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
