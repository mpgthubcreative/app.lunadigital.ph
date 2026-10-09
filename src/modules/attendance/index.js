// Attendance (Phase 14). Two compact views:
//   By day       Employee | Status ▾ | Daily wage | Payable | Note   (mark everyone for a date)
//   By employee  Date | Day | Status ▾ | Daily Wage | Payable Amount | Notes
//                + Present / Official Leave / Absent / Not marked, payable days, base pay
// Status is changed inline (Present ▾ -> Absent); the server records
// previous -> new, who and when, and recalculates any unpaid payroll.
// Present and Official Leave are payable; Absent and unmarked days aren't.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { ATTENDANCE_STATUSES, businessDate, periodFor, daysIn, weekdayLabel, summarizeAttendance } from "@shared/index.js";
import * as defaultData from "../household/data.js";

const statusSelect = (staffId, date, status, disabled) =>
  html`<select class="select select-compact" data-act="mark" data-staff="${staffId}" data-date="${date}" aria-label="Status" ${disabled ? "disabled" : ""}>
    ${!status ? html`<option value="" selected>— Not marked</option>` : ""}
    ${Object.entries(ATTENDANCE_STATUSES).map(([k, s]) => html`<option value="${k}" ${status === k ? "selected" : ""}>${s.label}</option>`)}
  </select>`;

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const businessId = session.business.id;
  const canEdit = session.member.permissions["attendance.edit"] === true;
  const today = businessDate(session.business.timezone, now());
  const state = { view: "day", date: today, staffId: "", from: "", to: "", staff: [], lines: [], loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      state.staff = await data.activeStaff(businessId);
      if (state.view === "employee" && !state.staffId && state.staff.length) state.staffId = state.staff[0].id;
      if (state.view === "employee" && state.staffId && !state.from) {
        const s = state.staff.find((x) => x.id === state.staffId);
        const p = periodFor(s?.payCycle || "semi_monthly", today);
        state.from = p.start;
        state.to = p.end;
      }
      const filters = state.view === "day" ? { from: state.date, to: state.date } : { staffId: state.staffId, from: state.from, to: state.to };
      state.lines = state.view === "day" || state.staffId ? (await data.listAttendance(businessId, filters, { pageSize: 100 })).rows : [];
      state.error = null;
    } catch (err) {
      console.error("attendance: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load attendance.";
    }
    state.loading = false;
    draw();
  }

  function dayView() {
    const byStaff = new Map(state.lines.map((l) => [l.staffId, l]));
    if (!state.staff.length) return emptyState({ iconName: "staff", title: "No household staff yet", body: "Add staff on the Household Staff page first." });
    return html`<div class="table-wrap"><table class="table table-compact" data-role="attendance-day">
      <thead><tr><th>Employee</th><th>Status</th><th class="num">Daily wage</th><th class="num">Payable</th><th class="col-secondary">Note</th></tr></thead>
      <tbody>${state.staff.map((s) => {
        const l = byStaff.get(s.id);
        return html`<tr data-staff="${s.id}"><td>${s.name}</td><td>${statusSelect(s.id, state.date, l?.status, !canEdit)}</td>
          <td class="num">${formatCentavos(l?.dailyWage ?? s.dailyWage)}</td><td class="num">${l ? formatCentavos(l.payableAmount) : "—"}</td><td class="col-secondary">${l?.note || ""}</td></tr>`;
      })}</tbody></table></div>`;
  }

  function employeeView() {
    if (!state.staffId) return emptyState({ iconName: "staff", title: "Choose an employee" });
    const byDate = new Map(state.lines.map((l) => [l.date, l]));
    const days = state.from && state.to && state.from <= state.to ? daysIn({ start: state.from, end: state.to > today ? today : state.to }) : [];
    const sum = summarizeAttendance(state.lines, { start: state.from, end: state.to > today ? today : state.to });
    return html`<p class="stat-hint" data-role="totals">Present ${sum.present} · Official Leave ${sum.officialLeave} · Absent ${sum.absent} · Not marked ${sum.notMarked} → <strong>${sum.payableDays} payable days · ${formatCentavos(sum.basePay)} base pay</strong></p>
      <div class="table-wrap"><table class="table table-compact" data-role="attendance-employee">
      <thead><tr><th>Date</th><th>Day</th><th>Status</th><th class="num">Daily Wage</th><th class="num">Payable Amount</th><th class="col-secondary">Notes</th></tr></thead>
      <tbody>${days.map((d) => {
        const l = byDate.get(d);
        return html`<tr data-date="${d}"><td>${formatDayId(d)}</td><td>${weekdayLabel(d)}</td><td>${statusSelect(state.staffId, d, l?.status, !canEdit)}</td>
          <td class="num">${l ? formatCentavos(l.dailyWage) : "—"}</td><td class="num">${l ? formatCentavos(l.payableAmount) : "—"}</td><td class="col-secondary">${l?.note || ""}</td></tr>`;
      })}</tbody></table></div>`;
  }

  function draw() {
    if (!alive) return;
    const tab = (v, label) => html`<button type="button" class="btn ${state.view === v ? "btn-primary" : ""}" data-act="view" data-view="${v}">${label}</button>`;
    render(
      container,
      html`
        ${pageHeader({ title: "Attendance", subtitle: "Present and Official Leave are paid; Absent isn't. Luna works out the pay." })}
        <div class="section">${tab("day", "By day")} ${tab("employee", "By employee")}</div>
        <form class="section card filters filters-inline" data-role="filters">
          ${state.view === "day"
            ? html`<input class="input" type="date" name="date" value="${state.date}" max="${today}" aria-label="Date" />`
            : html`<select class="select" name="staffId" aria-label="Employee">${state.staff.map((s) => html`<option value="${s.id}" ${state.staffId === s.id ? "selected" : ""}>${s.name}</option>`)}</select>
                <input class="input" type="date" name="from" value="${state.from}" aria-label="From" />
                <input class="input" type="date" name="to" value="${state.to}" aria-label="To" />`}
          <button type="submit" class="btn">Apply</button>
          ${mayExport(session, "attendance") ? html`${exportButton("attendance")}<span class="stat-hint">${exportHint}</span>` : ""}
        </form>
        <section class="section card">${state.error ? emptyState({ title: "Couldn't load", body: state.error }) : state.loading ? emptyState({ title: "Loading…" }) : state.view === "day" ? dayView() : employeeView()}</section>`
    );
  }

  const onChange = async (event) => {
    const el = event.target;
    if (el.dataset.act !== "mark" || !el.value) return;
    el.disabled = true;
    try {
      await data.setAttendance(el.dataset.staff, el.dataset.date, el.value);
    } catch (err) {
      toast(err.message || "Couldn't save", "danger");
    }
    load();
  };
  const onClick = (event) => {
    const el = event.target.closest('[data-act="view"]');
    if (!el || !container.contains(el)) return;
    state.view = el.dataset.view;
    load();
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const f = event.target.elements;
    if (state.view === "day") state.date = f.date.value || today;
    else {
      if (f.staffId.value !== state.staffId) state.from = "";
      state.staffId = f.staffId.value;
      if (state.from) {
        state.from = f.from.value;
        state.to = f.to.value;
      }
      if (state.from && state.to && state.from > state.to) {
        toast("The start date is after the end date.", "danger");
        return;
      }
    }
    load();
  };
  container.addEventListener("change", onChange);
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  // The download is what's on screen: the day, or the employee + range.
  const unbindExport = bindExport(container, () => (state.view === "day" ? { from: state.date, to: state.date } : { staffId: state.staffId, from: state.from, to: state.to }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    container.removeEventListener("change", onChange);
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
    unbindExport();
  };
}
