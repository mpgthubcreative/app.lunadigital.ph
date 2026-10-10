// Attendance = Work (Phase 18.5): "Who worked, and which days are payable?"
//   Requests     Phase 18.6: what staff sent from their own accounts, with
//                Approve / Reject (approval marks the day; nothing before)
//   By day       one row per person with one-tap Present / Leave / Unpaid / Rest / Absent
//                (44px targets on phones); ‹ date › steps through days.
//   By employee  Date | Day | Status ▾ | Daily Wage | Payable Amount | Notes
//                + Present / Official Leave / Absent / Not marked, payable days, base pay
// The server records previous -> new, who and when, and recalculates any
// unpaid payroll. Present and Paid Leave are payable; Absent, Unpaid Leave,
// Rest Day and unmarked days aren't (a daily-paid rest day is a day not
// worked, never a deduction). Released periods are locked by the server.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, segmented, skeleton, mobileCell } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { ATTENDANCE_STATUSES, businessDate, periodFor, daysIn, weekdayLabel, summarizeAttendance, addDays } from "@shared/index.js";
import * as defaultData from "../household/data.js";

const SHORT = { present: "Present", official_leave: "Leave", unpaid_leave: "Unpaid", rest_day: "Rest", absent: "Absent" };

const statusSelect = (staffId, date, status, disabled) =>
  html`<select class="select select-compact select-chip" data-act="mark" data-staff="${staffId}" data-date="${date}" data-tone="${status === "present" ? "success" : status === "absent" ? "danger" : status ? "info" : ""}" aria-label="Status on ${formatDayId(date)}" ${disabled ? "disabled" : ""}>
    ${!status ? html`<option value="" selected>— Not marked</option>` : ""}
    ${Object.entries(ATTENDANCE_STATUSES).map(([k, s]) => html`<option value="${k}" ${status === k ? "selected" : ""}>${s.label}</option>`)}
  </select>`;

// One tap per person: Present / Leave / Absent (aria-pressed = current).
const statusButtons = (staff, date, status, disabled) =>
  html`<div class="pla" role="group" aria-label="Attendance of ${staff.name} on ${formatDayId(date)}">
    ${Object.keys(ATTENDANCE_STATUSES).map(
      (k) => html`<button type="button" class="pla-btn pla-${k}" data-act="mark-btn" data-staff="${staff.id}" data-date="${date}" data-status="${k}" aria-pressed="${status === k ? "true" : "false"}" title="${ATTENDANCE_STATUSES[k].label}${ATTENDANCE_STATUSES[k].payable ? " (paid)" : " (not paid)"}" ${disabled ? "disabled" : ""}>${SHORT[k]}</button>`
    )}
  </div>`;

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const businessId = session.business.id;
  const canEdit = session.member.permissions["attendance.edit"] === true;
  const today = businessDate(session.business.timezone, now());
  const state = { view: "day", date: today, staffId: "", from: "", to: "", staff: [], lines: [], requests: [], loading: true, error: null, saving: null, deciding: null };
  let alive = true;

  async function load() {
    state.loading = !state.lines.length || state.loading;
    draw();
    try {
      [state.staff, state.requests] = await Promise.all([data.activeStaff(businessId), canEdit && data.pendingAttendanceRequests ? data.pendingAttendanceRequests(businessId).catch(() => []) : []]);
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
    state.saving = null;
    draw();
  }

  function dayView() {
    const byStaff = new Map(state.lines.map((l) => [l.staffId, l]));
    if (!state.staff.length) return emptyState({ iconName: "staff", title: "No household staff yet", body: "Add the people you pay on the Household Staff page first.", action: html`<a class="btn btn-primary" href="/household-staff" data-link>Add staff</a>` });
    const marked = state.staff.filter((s) => byStaff.has(s.id)).length;
    return html`<p class="chart-note" data-role="day-summary">${marked} of ${state.staff.length} marked for ${formatDayId(state.date)}${marked < state.staff.length && canEdit ? " · tap a status to mark the rest" : ""}</p>
      <div class="table-wrap"><table class="table table-compact rows" data-role="attendance-day">
      <thead><tr><th class="m-only"></th><th>Employee</th><th>Status</th><th class="num">Daily wage</th><th class="num">Payable</th><th class="col-secondary">Note</th></tr></thead>
      <tbody>${state.staff.map((s) => {
        const l = byStaff.get(s.id);
        return html`<tr data-staff="${s.id}" class="${state.saving === s.id ? "is-saving" : ""}">
          ${mobileCell({ title: s.name, sub: `${s.position || "Staff"} · ${formatCentavos(l?.dailyWage ?? s.dailyWage)}/day`, end: l ? formatCentavos(l.payableAmount) : "—", endSub: l ? "payable" : "not marked" })}
          <td><span class="cell-strong">${s.name}</span>${s.position ? html`<span class="cell-sub">${s.position}</span>` : ""}</td>
          <td data-m="ctl">${statusButtons(s, state.date, l?.status, !canEdit || state.saving === s.id)}</td>
          <td class="num">${formatCentavos(l?.dailyWage ?? s.dailyWage)}</td><td class="num">${l ? formatCentavos(l.payableAmount) : "—"}</td><td class="col-secondary">${l?.note || ""}</td></tr>`;
      })}</tbody></table></div>`;
  }

  function employeeView() {
    if (!state.staffId) return emptyState({ iconName: "staff", title: "Choose an employee" });
    const byDate = new Map(state.lines.map((l) => [l.date, l]));
    const days = state.from && state.to && state.from <= state.to ? daysIn({ start: state.from, end: state.to > today ? today : state.to }) : [];
    const sum = summarizeAttendance(state.lines, { start: state.from, end: state.to > today ? today : state.to });
    return html`<p class="chart-note" data-role="totals">Present ${sum.present} · Paid Leave ${sum.officialLeave} · Unpaid Leave ${sum.unpaidLeave} · Rest Day ${sum.restDay} · Absent ${sum.absent} · Not marked ${sum.notMarked} → <strong>${sum.payableDays} paid days · ${formatCentavos(sum.basePay)} basic pay</strong></p>
      <div class="table-wrap"><table class="table table-compact rows" data-role="attendance-employee">
      <thead><tr><th class="m-only"></th><th>Date</th><th>Day</th><th>Status</th><th class="num">Daily Wage</th><th class="num">Payable Amount</th><th class="col-secondary">Notes</th></tr></thead>
      <tbody>${days.map((d) => {
        const l = byDate.get(d);
        return html`<tr data-date="${d}">${mobileCell({ title: formatDayId(d), sub: weekdayLabel(d), end: l ? formatCentavos(l.payableAmount) : "—" })}<td>${formatDayId(d)}</td><td>${weekdayLabel(d)}</td><td data-m="ctl">${statusSelect(state.staffId, d, l?.status, !canEdit)}</td>
          <td class="num">${l ? formatCentavos(l.dailyWage) : "—"}</td><td class="num">${l ? formatCentavos(l.payableAmount) : "—"}</td><td class="col-secondary">${l?.note || ""}</td></tr>`;
      })}</tbody></table></div>`;
  }

  // Requests staff sent from their own accounts (Phase 18.6).
  function requestsSection() {
    if (!canEdit || !state.requests.length) return "";
    return html`<section class="card section" data-section="requests">
      <h2 class="card-title">Waiting for your approval (${state.requests.length})</h2>
      <ul class="request-list" data-role="requests">${state.requests.map(
        (r) => html`<li data-request="${r.id}">
          <div class="request-main"><strong>${r.staffName}</strong> · ${ATTENDANCE_STATUSES[r.status]?.label ?? r.status} · ${formatDayId(r.date)}<small>${r.note ? `"${r.note}"` : r.current ? `Now marked ${ATTENDANCE_STATUSES[r.current]?.label ?? r.current}` : "Not marked yet"} · ${ATTENDANCE_STATUSES[r.status]?.payable ? "paid day" : "not paid"}</small></div>
          <div class="request-actions"><button type="button" class="btn btn-compact" data-act="reject" data-id="${r.id}" ${state.deciding === r.id ? "disabled" : ""}>Reject</button><button type="button" class="btn btn-compact btn-primary" data-act="approve" data-id="${r.id}" ${state.deciding === r.id ? "disabled" : ""}>Approve</button></div>
        </li>`
      )}</ul>
    </section>`;
  }

  async function decide(id, decision) {
    state.deciding = id;
    draw();
    try {
      await data.decideAttendance(id, decision);
      toast(decision === "approve" ? "Approved and marked." : "Rejected. Nothing was changed.", "success");
    } catch (err) {
      toast(err.message || "Couldn't save", "danger");
    }
    state.deciding = null;
    load();
  }

  function draw() {
    if (!alive) return;
    render(
      container,
      html`
        ${pageHeader({ title: "Attendance", subtitle: "Who worked each day. Present and Paid Leave are paid; Absent, Unpaid Leave and Rest Day aren't." })}
        ${requestsSection()}
        <div class="toolbar">
          ${segmented("view", [["day", "By day"], ["employee", "By employee"]], state.view, { label: "View" })}
        </div>
        <form class="filter-form" data-role="filters">
          <div class="toolbar">
            ${state.view === "day"
              ? html`<button type="button" class="btn btn-icon" data-act="step" data-step="-1" aria-label="Previous day">‹</button>
                  <input class="input" type="date" name="date" value="${state.date}" max="${today}" aria-label="Date" />
                  <button type="button" class="btn btn-icon" data-act="step" data-step="1" aria-label="Next day" ${state.date >= today ? "disabled" : ""}>›</button>
                  ${state.date !== today ? html`<button type="button" class="btn btn-ghost" data-act="step" data-step="today">Today</button>` : ""}`
              : html`<select class="select" name="staffId" aria-label="Employee">${state.staff.map((s) => html`<option value="${s.id}" ${state.staffId === s.id ? "selected" : ""}>${s.name}</option>`)}</select>
                  <input class="input" type="date" name="from" value="${state.from}" aria-label="From" />
                  <input class="input" type="date" name="to" value="${state.to}" aria-label="To" />`}
            <button type="submit" class="btn">Show</button>
            <div class="toolbar-end">${mayExport(session, "attendance") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("attendance")}` : ""}</div>
          </div>
        </form>
        <section class="card">${state.error ? emptyState({ title: "Couldn't load", body: state.error }) : state.loading ? skeleton(4) : state.view === "day" ? dayView() : employeeView()}</section>`
    );
    for (const btn of container.querySelectorAll('[data-act="export"]')) btn.classList.add("btn-ghost");
  }

  const mark = async (staffId, date, status) => {
    state.saving = staffId;
    draw();
    try {
      await data.setAttendance(staffId, date, status);
    } catch (err) {
      toast(err.message || "Couldn't save", "danger");
    }
    load();
  };
  const onChange = async (event) => {
    const el = event.target;
    if (el.dataset.act !== "mark" || !el.value) return;
    el.disabled = true;
    await mark(el.dataset.staff, el.dataset.date, el.value);
  };
  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    if (el.dataset.act === "seg" && el.dataset.seg === "view") {
      state.view = el.dataset.value;
      state.loading = true;
      load();
    }
    if (el.dataset.act === "mark-btn" && el.getAttribute("aria-pressed") !== "true") mark(el.dataset.staff, el.dataset.date, el.dataset.status);
    if (el.dataset.act === "approve" || el.dataset.act === "reject") decide(el.dataset.id, el.dataset.act);
    if (el.dataset.act === "step") {
      const next = el.dataset.step === "today" ? today : addDays(state.date, Number(el.dataset.step));
      if (next > today) return;
      state.date = next;
      state.loading = true;
      load();
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const f = event.target.elements;
    if (state.view === "day") state.date = f.date.value && f.date.value <= today ? f.date.value : today;
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
    state.loading = true;
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
