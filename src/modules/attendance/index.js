// Attendance (Owner-pilot simplification batch): "What is this helper's
// attendance for this period?" The Owner records it.
//   Employee ▾  Period ▾        one helper, one pay period (their own cycle)
//   one compact row per date with a status dropdown; tick days and mark
//   them together (Present / Absent / Rest Day / Paid Leave / Unpaid Leave)
//   the helper's confirmation of the period ("Yanie confirmed this on…")
//   Needs review (compact, only when there is something): attendance
//   corrections the helper reported, and any older staff request.
// The server records previous -> new, who and when, and moves the period's
// payroll. Present and Paid Leave are payable; Absent, Unpaid Leave, Rest
// Day and unmarked days aren't. Correcting a day the helper sent asks for a
// reason (kept in its history). Paid days are locked by the server.
// ?staff=<id>&period=<start> opens on that helper / period.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, badge } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { ATTENDANCE_STATUSES, businessDate, staffPeriod, staffPeriods, daysIn, weekdayLabel, summarizeAttendance, addDays } from "@shared/index.js";
import * as defaultData from "../household/data.js";
import { formDialog } from "../../components/form-dialog.js";

const ORDER = ["present", "absent", "rest_day", "official_leave", "unpaid_leave"];
const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");
const range = (p) => (p.start.slice(0, 7) === p.end.slice(0, 7) ? `${short(p.start)}–${Number(p.end.slice(8))}` : `${short(p.start)} – ${short(p.end)}`);
const ID = /^[A-Za-z0-9]{8,40}$/;

// A helper's pay periods: about a year back (not before their start date)
// up to the current one, newest first. Upcoming days can't be marked
// (attendance records what actually happened).
export function periodsOf(staff, today) {
  const current = staffPeriod(staff, today);
  const from = [staff.startDate, addDays(today, -366)].filter(Boolean).sort().pop();
  const to = staff.endDate && staff.endDate < current.end ? staff.endDate : current.end;
  return staffPeriods(staff, from, to, 26);
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const businessId = session.business.id;
  const canEdit = session.member.permissions["attendance.edit"] === true;
  const today = businessDate(session.business.timezone, now());
  const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const state = { staffId: ID.test(params.get("staff") || "") ? params.get("staff") : "", periodStart: /^\d{4}-\d{2}-\d{2}$/.test(params.get("period") || "") ? params.get("period") : "", staff: [], lines: [], review: { corrections: [], requests: [], confirmation: null }, selected: new Set(), loading: true, error: null, saving: false };
  let alive = true;

  const person = () => state.staff.find((s) => s.id === state.staffId) || null;
  const periods = () => (person() ? periodsOf(person(), today) : []);
  const period = () => periods().find((p) => p.start === state.periodStart) || null;

  async function load() {
    state.loading = true;
    draw();
    try {
      if (!state.staff.length) state.staff = await data.activeStaff(businessId);
      if (!person()) state.staffId = state.staff[0]?.id || "";
      if (person() && !period()) state.periodStart = staffPeriod(person(), today).start;
      const p = period();
      const [lines, review] = await Promise.all([p ? data.listAttendance(businessId, { staffId: state.staffId, from: p.start, to: p.end }, { pageSize: 100 }).then((r) => r.rows) : [], data.attendanceReview ? data.attendanceReview(state.staffId || null, p?.start || null).catch(() => null) : null]);
      state.lines = lines;
      state.review = review || { corrections: [], requests: [], confirmation: null };
      state.error = null;
    } catch (err) {
      console.error("attendance: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load attendance.";
    }
    state.loading = false;
    state.saving = false;
    draw();
  }

  // Compact: only when the helper reported something (or an older request waits).
  function needsReview() {
    const { corrections, requests } = state.review;
    if (!corrections.length && !requests.length) return "";
    const reqBy = new Map();
    for (const r of requests) {
      if (!reqBy.has(r.staffId)) reqBy.set(r.staffId, []);
      reqBy.get(r.staffId).push(r);
    }
    return html`<section class="card section needs-review" data-section="needs-review">
      <h2 class="card-title">Needs review</h2>
      <ul class="review-list">
        ${corrections.map(
          (c) => html`<li data-correction="${c.id}"><div class="request-main"><strong>${c.staffName}</strong> · Attendance correction${c.date ? ` · ${short(c.date)}` : ""}<small>"${c.message}"</small></div>
            <div class="request-actions">${c.staffId !== state.staffId || (c.date && period() && (c.date < period().start || c.date > period().end)) ? html`<button type="button" class="btn btn-compact" data-act="open-correction" data-staff="${c.staffId}" data-date="${c.date || ""}">Open</button>` : ""}${canEdit ? html`<button type="button" class="btn btn-compact btn-primary" data-act="resolve" data-id="${c.id}">Done</button>` : ""}</div></li>`
        )}
        ${[...reqBy.values()].map((list) => html`<li data-requests="${list[0].staffId}"><div class="request-main"><strong>${list[0].staffName}</strong> · ${list.length} day${list.length === 1 ? "" : "s"} sent<small>${list.map((r) => `${ATTENDANCE_STATUSES[r.status]?.label ?? r.status} ${short(r.date)}`).join(", ")}</small></div>
          ${canEdit ? html`<div class="request-actions"><button type="button" class="btn btn-compact" data-act="reject-all" data-ids="${list.map((r) => r.id).join(",")}">Reject</button><button type="button" class="btn btn-compact btn-primary" data-act="approve-all" data-ids="${list.map((r) => r.id).join(",")}">Approve${list.length > 1 ? ` all ${list.length}` : ""}</button></div>` : ""}</li>`)}
      </ul>
    </section>`;
  }

  function confirmationLine(sum) {
    const c = state.review.confirmation;
    const s = person();
    if (!s || !s.memberUid) return "";
    if (!c) return html`<p class="stat-hint" data-role="confirmation">${badge("Not confirmed", "neutral")} ${s.name} hasn't confirmed this period yet.</p>`;
    const same = ["present", "absent", "officialLeave", "unpaidLeave", "restDay", "notMarked"].every((k) => (c.counts?.[k] ?? 0) === sum[k]);
    return html`<p class="stat-hint" data-role="confirmation">${same ? badge("Confirmed", "success") : badge("Changed since", "warning")} ${s.name} confirmed this attendance${c.confirmedAt ? ` on ${short(c.confirmedAt.slice(0, 10))}` : ""}${same ? "." : "; days changed after that."}</p>`;
  }

  function sheet() {
    const s = person();
    if (!s) return emptyState({ iconName: "staff", title: "No household staff yet", body: "Add the people you pay on the Household Staff page first.", action: html`<a class="btn btn-primary" href="/household-staff" data-link>Add staff</a>` });
    const p = period();
    if (!p) return emptyState({ iconName: "calendar", title: "No pay period", body: `${s.name}'s start date is after today.` });
    const byDate = new Map(state.lines.map((l) => [l.date, l]));
    const sum = summarizeAttendance(state.lines, { start: p.start, end: p.end > today ? today : p.end });
    const days = daysIn(p).filter((d) => (!s.startDate || d >= s.startDate) && (!s.endDate || d <= s.endDate));
    const n = state.selected.size;
    return html`
      <p class="chart-note" data-role="totals">Present ${sum.present} · Absent ${sum.absent} · Rest Day ${sum.restDay} · Paid Leave ${sum.officialLeave} · Unpaid Leave ${sum.unpaidLeave}${sum.notMarked ? ` · Not marked ${sum.notMarked}` : ""} → <strong>${sum.payableDays} paid days · ${formatCentavos(sum.basePay)}</strong></p>
      ${confirmationLine(sum)}
      ${canEdit && n
        ? html`<div class="sheet-bulk" data-role="bulk"><span>${n} selected:</span>${ORDER.map((k) => html`<button type="button" class="btn btn-compact" data-act="bulk" data-status="${k}" ${state.saving ? "disabled" : ""}>${ATTENDANCE_STATUSES[k].label}</button>`)}<button type="button" class="btn btn-compact btn-ghost" data-act="clear">Clear</button></div>`
        : canEdit
          ? html`<p class="stat-hint">Tick days to mark several at once.</p>`
          : ""}
      <ul class="sheet-list" data-role="owner-sheet">${days.map((d) => {
        const l = byDate.get(d);
        const future = d > today;
        const types = ORDER;
        if (future) return html`<li class="sheet-row is-upcoming" data-day="${d}"><span class="sheet-check" aria-hidden="true"></span><span class="sheet-date"><strong>${short(d)}</strong> <small>${weekdayLabel(d)}</small></span><span class="sheet-value"><select class="input sheet-select" data-date="${d}" aria-label="Status on ${short(d)} (upcoming)" disabled><option selected>Upcoming</option></select></span></li>`;
        return html`<li class="sheet-row${state.selected.has(d) ? " is-selected" : ""}" data-day="${d}">
          ${canEdit ? html`<label class="sheet-check"><input type="checkbox" data-sel="${d}" ${state.selected.has(d) ? "checked" : ""} aria-label="Select ${short(d)}" /></label>` : html`<span class="sheet-check" aria-hidden="true"></span>`}
          <span class="sheet-date"><strong>${short(d)}</strong> <small>${weekdayLabel(d)}${l?.source === "staff_request" ? " · sent by helper" : ""}</small></span>
          <span class="sheet-value"><select class="input sheet-select" data-act="mark" data-date="${d}" aria-label="Status on ${short(d)}" ${!canEdit || state.saving ? "disabled" : ""}>
            ${!l ? html`<option value="" selected>Not marked</option>` : ""}
            ${types.map((k) => html`<option value="${k}" ${l?.status === k ? "selected" : ""}>${ATTENDANCE_STATUSES[k].label}</option>`)}
            ${l && !types.includes(l.status) ? html`<option value="${l.status}" selected>${ATTENDANCE_STATUSES[l.status]?.label ?? l.status}</option>` : ""}
          </select></span>
        </li>`;
      })}</ul>`;
  }

  function draw() {
    if (!alive) return;
    const s = person();
    render(
      container,
      html`
        ${pageHeader({ title: "Attendance", subtitle: "Choose a helper and a pay period. Present and Paid Leave are paid; Absent, Unpaid Leave and Rest Day aren't." })}
        ${needsReview()}
        <section class="card section">
          <div class="pick-row" data-role="pickers">
            <label class="pick">Employee <select class="select" data-role="pick-staff" aria-label="Employee">${state.staff.map((x) => html`<option value="${x.id}" ${x.id === state.staffId ? "selected" : ""}>${x.name}</option>`)}</select></label>
            <label class="pick">Period <select class="select" data-role="pick-period" aria-label="Pay period" ${s ? "" : "disabled"}>${periods().map((p) => html`<option value="${p.start}" ${p.start === state.periodStart ? "selected" : ""}>${range(p)}${p.start <= today && today <= p.end ? " (now)" : ""}</option>`)}</select></label>
            ${mayExport(session, "attendance") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("attendance")}` : ""}
          </div>
          ${state.error ? emptyState({ title: "Couldn't load", body: state.error }) : state.loading && !state.lines.length ? skeleton(6) : sheet()}
        </section>`
    );
    for (const btn of container.querySelectorAll('[data-act="export"]')) btn.classList.add("btn-ghost");
  }

  // One day or several; a day the helper sent needs the Owner's reason.
  async function save(days) {
    state.saving = true;
    draw();
    try {
      let r = await data.setAttendanceMany(state.staffId, days);
      const needReason = r.failed.filter((f) => f.code === "reason-required");
      if (needReason.length) {
        const reason = await formDialog({ title: "Correct what the helper sent?", intro: `${needReason.map((f) => short(f.date)).join(", ")} ${needReason.length === 1 ? "was" : "were"} sent by the helper. Your reason is kept in the history with the before and after.`, fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. She was on leave that day" }], submitLabel: "Save correction", onSubmit: (v) => v.reason.trim() });
        if (reason) {
          const again = await data.setAttendanceMany(state.staffId, days.filter((d) => needReason.some((f) => f.date === d.date)), reason);
          r = { saved: [...r.saved, ...again.saved], failed: [...r.failed.filter((f) => f.code !== "reason-required"), ...again.failed] };
        } else r = { ...r, failed: r.failed.filter((f) => f.code !== "reason-required") };
      }
      if (r.failed.length) toast(`${r.failed.length} day${r.failed.length === 1 ? "" : "s"} not saved: ${r.failed[0].error}`, "danger");
      else if (days.length > 1) toast(`${r.saved.length} days saved.`, "success");
      state.selected.clear();
    } catch (err) {
      toast(err.message || "Couldn't save", "danger");
    }
    load();
  }

  async function decideAll(ids, decision) {
    try {
      const r = await data.decideAttendanceMany(ids, decision);
      toast(r.failed.length ? `${r.decided.length} done. ${r.failed.length} couldn't be: ${r.failed[0].error}` : decision === "approve" ? "Approved and marked." : "Rejected. Nothing was changed.", r.failed.length ? "danger" : "success");
    } catch (err) {
      toast(err.message || "Couldn't save", "danger");
    }
    load();
  }

  const choose = (staffId, periodStart) => {
    state.staffId = staffId;
    state.periodStart = periodStart || "";
    state.selected.clear();
    state.lines = [];
    load();
  };

  const onChange = (event) => {
    const el = event.target;
    if (el.dataset.role === "pick-staff") return choose(el.value, "");
    if (el.dataset.role === "pick-period") return choose(state.staffId, el.value);
    if (el.dataset.sel) {
      if (el.checked) state.selected.add(el.dataset.sel);
      else state.selected.delete(el.dataset.sel);
      return draw();
    }
    if (el.dataset.act === "mark" && el.value) return save([{ date: el.dataset.date, status: el.value }]);
    return undefined;
  };
  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const a = el.dataset.act;
    if (a === "bulk") {
      const days = [...state.selected].sort().filter((d) => d <= today).map((date) => ({ date, status: el.dataset.status }));
      if (days.length) save(days);
    } else if (a === "clear") {
      state.selected.clear();
      draw();
    } else if (a === "resolve") {
      const r = await formDialog({ title: "Mark this report done?", intro: "Fix the attendance first if needed. Your note is kept with the report.", fields: [{ name: "note", label: "Note (optional)", placeholder: "e.g. Changed Oct 8 to Present" }], submitLabel: "Done", onSubmit: (v) => data.resolveCorrection(el.dataset.id, v.note.trim() || null) });
      if (r) load();
    } else if (a === "open-correction") {
      const s = state.staff.find((x) => x.id === el.dataset.staff);
      choose(el.dataset.staff, s && el.dataset.date ? staffPeriod(s, el.dataset.date).start : "");
    } else if (a === "approve-all" || a === "reject-all") decideAll(el.dataset.ids.split(","), a === "approve-all" ? "approve" : "reject");
  };
  container.addEventListener("change", onChange);
  container.addEventListener("click", onClick);
  const unbindExport = bindExport(container, () => ({ staffId: state.staffId, from: period()?.start ?? "", to: period()?.end ?? "" }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    container.removeEventListener("change", onChange);
    container.removeEventListener("click", onClick);
    unbindExport();
  };
}
