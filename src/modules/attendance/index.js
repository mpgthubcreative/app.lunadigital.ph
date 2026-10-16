// Attendance (Owner-pilot simplification batch): "What is this helper's
// attendance for this period?" The Owner records it.
//   Employee ▾  Period ▾        one helper, one pay period (their own cycle)
//   Owner-pilot polish (2026-10-16): a calculator-style tap grid. Tap one
//   or several dates, tap a status (P / A / PL / UL / R, or Clear), Save.
//   "Fill normal schedule" shows the helper's usual week (Household Staff:
//   usual rest day) as Expected; "Confirm through today" turns the expected
//   days up to today into real entries; "Copy previous period" repeats last
//   period's pattern by weekday. Upcoming days are never recorded early.
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
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { ATTENDANCE_STATUSES, businessDate, staffPeriod, staffPeriods, daysIn, weekdayLabel, weekdayOf, summarizeAttendance, addDays, expectedStatus } from "@shared/index.js";
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

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, confirm = confirmDialog } = {}) {
  const businessId = session.business.id;
  const canEdit = session.member.permissions["attendance.edit"] === true;
  const today = businessDate(session.business.timezone, now());
  const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const state = { staffId: ID.test(params.get("staff") || "") ? params.get("staff") : "", periodStart: /^\d{4}-\d{2}-\d{2}$/.test(params.get("period") || "") ? params.get("period") : "", staff: [], lines: [], review: { corrections: [], requests: [], confirmation: null }, selected: new Set(), pending: new Map(), expected: false, loading: true, error: null, saving: false };
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

  // The helper's confirmation of this period, as one chip.
  function confirmationChip(sum) {
    const c = state.review.confirmation;
    const s = person();
    if (!s || !s.memberUid) return "";
    if (!c) return html`<span data-role="confirmation-chip">${badge("Not confirmed", "warning")}</span>`;
    const same = ["present", "absent", "officialLeave", "unpaidLeave", "restDay", "notMarked"].every((k) => (c.counts?.[k] ?? 0) === sum[k]);
    return html`<span data-role="confirmation-chip">${same ? badge(`Confirmed${c.confirmedAt ? ` ${short(c.confirmedAt.slice(0, 10))}` : ""}`, "success") : badge("Changed since confirmed", "warning")}</span>`;
  }

  // Owner-pilot cleanup: Paid Leave this calendar year.
  function leaveLine() {
    const l = state.review.leave;
    if (!l) return "";
    return html`<p class="stat-hint" data-role="leave">Paid Leave ${l.year}: used <strong>${l.used} of ${l.entitled}</strong> day${l.entitled === 1 ? "" : "s"} · ${l.remaining} remaining${l.used > l.entitled ? ` · ${l.used - l.entitled} beyond the allowance` : ""}</p>`;
  }

  // The day as it will be after Save: unsaved change > recorded > nothing.
  const savedOf = (d) => state.lines.find((l) => l.date === d) || null;
  const valueOf = (d) => (state.pending.has(d) ? state.pending.get(d) : savedOf(d)?.status ?? null);
  const shortOf = (st) => (st && st !== "clear" ? ATTENDANCE_STATUSES[st]?.short ?? "?" : "");
  const visibleDays = (s, p) => daysIn(p).filter((d) => (!s.startDate || d >= s.startDate) && (!s.endDate || d <= s.endDate));

  function sheet() {
    const s = person();
    if (!s) return emptyState({ iconName: "staff", title: "No household staff yet", body: "Add the people you pay on the Household Staff page first.", action: html`<a class="btn btn-primary" href="/household-staff" data-link>Add staff</a>` });
    const p = period();
    if (!p) return emptyState({ iconName: "calendar", title: "No pay period", body: `${s.name}'s start date is after today.` });
    const days = visibleDays(s, p);
    const saved = summarizeAttendance(state.lines, { start: p.start, end: p.end > today ? today : p.end });
    const preview = summarizeAttendance(days.filter((d) => d <= today && valueOf(d) && valueOf(d) !== "clear").map((d) => ({ date: d, status: valueOf(d), dailyWage: savedOf(d)?.dailyWage ?? s.dailyWage })), { start: p.start, end: p.end > today ? today : p.end });
    const n = state.selected.size;
    const changes = state.pending.size;
    // Owner-pilot UX (2026-10-17): one quiet summary line (paid days, the
    // helper's confirmation as a chip); the breakdown, the confirmation
    // sentence and Paid Leave fold under Details.
    const open = days.some((d) => d <= today && !valueOf(d));
    return html`
      <div class="att-head" data-role="att-head">
        <span class="att-paid" data-role="att-paid"><strong>${preview.payableDays} paid day${preview.payableDays === 1 ? "" : "s"} · ${formatCentavos(preview.basePay)}</strong>${changes ? html` <span class="stat-hint">unsaved</span>` : ""}</span>
        ${confirmationChip(saved)}
      </div>
      <details class="att-more" data-role="att-details"><summary>Details</summary>
        <p class="stat-hint" data-role="totals">Present ${preview.present} · Absent ${preview.absent} · Rest Day ${preview.restDay} · Paid Leave ${preview.officialLeave} · Unpaid Leave ${preview.unpaidLeave}${preview.notMarked ? ` · Not marked ${preview.notMarked}` : ""} → ${preview.payableDays} paid days · ${formatCentavos(preview.basePay)}${changes ? " (with unsaved changes)" : ""}</p>
        ${confirmationLine(saved)}
        ${leaveLine()}
      </details>
      ${canEdit
        ? html`<div class="att-tools" data-role="tools">
            <button type="button" class="btn${open && !changes ? " btn-primary" : ""}" data-act="confirm-today" ${state.saving ? "disabled" : ""}>Confirm through today</button>
            <button type="button" class="btn btn-compact btn-ghost" data-act="fill" ${state.saving ? "disabled" : ""}>Fill normal schedule</button>
            <button type="button" class="btn btn-compact btn-ghost" data-act="copy-prev" ${state.saving ? "disabled" : ""}>Copy previous period</button>
          </div>`
        : ""}
      <div class="att-grid" data-role="att-grid" role="group" aria-label="${s.name}'s days, ${range(p)}">${days.map((d) => {
        const future = d > today;
        const v = valueOf(d);
        const exp = !v && state.expected ? expectedStatus(s, d) : null;
        const dirty = state.pending.has(d);
        const label = future ? (exp ? `Expected ${ATTENDANCE_STATUSES[exp].label}` : "Upcoming") : v && v !== "clear" ? ATTENDANCE_STATUSES[v]?.label : exp ? `Expected ${ATTENDANCE_STATUSES[exp].label}` : "Not marked";
        return html`<button type="button" class="att-cell${state.selected.has(d) ? " is-selected" : ""}${future ? " is-upcoming" : ""}${exp ? " is-expected" : ""}${dirty ? " is-dirty" : ""}" data-act="cell" data-day="${d}" data-st="${v && v !== "clear" ? v : exp || ""}" aria-pressed="${state.selected.has(d) ? "true" : "false"}" aria-label="${short(d)} ${weekdayLabel(d)}: ${label}" ${future || !canEdit || state.saving ? "disabled" : ""}>
          <span class="att-day">${Number(d.slice(8))}</span><span class="att-st">${future ? (exp ? `${shortOf(exp)}?` : "·") : v && v !== "clear" ? shortOf(v) : exp ? `${shortOf(exp)}?` : "–"}</span>
        </button>`;
      })}</div>
      ${canEdit
        ? html`<div class="att-pad" data-role="pad">${ORDER.map((k) => html`<button type="button" class="btn" data-act="apply" data-status="${k}" ${n && !state.saving ? "" : "disabled"}>${ATTENDANCE_STATUSES[k].label}</button>`)}<button type="button" class="btn btn-ghost" data-act="apply" data-status="clear" ${n && !state.saving ? "" : "disabled"}>Clear</button></div>
          <p class="att-legend" data-role="legend">${n ? html`<strong>${n} selected</strong> · ` : ""}P Present · A Absent · PL Paid Leave · UL Unpaid Leave · R Rest Day · ? Expected</p>`
        : html`<p class="att-legend" data-role="legend">P Present · A Absent · PL Paid Leave · UL Unpaid Leave · R Rest Day</p>`}
      ${changes
        ? html`<div class="att-save" data-role="save-bar"><span><strong>${changes}</strong> change${changes === 1 ? "" : "s"} not saved</span><span><button type="button" class="btn btn-compact btn-ghost" data-act="discard" ${state.saving ? "disabled" : ""}>Discard</button> <button type="button" class="btn btn-primary" data-act="save" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save attendance"}</button></span></div>`
        : ""}`;
  }

  // Stage a status for days up to today; "clear" takes a recorded day back
  // to Not marked (an unsaved change is simply dropped).
  function stage(daysToSet, status) {
    for (const d of daysToSet) {
      if (d > today) continue;
      const rec = savedOf(d)?.status ?? null;
      const want = status === "clear" ? (rec ? "clear" : null) : status;
      if (want === null || want === rec) state.pending.delete(d);
      else state.pending.set(d, want);
    }
  }

  async function copyPrevious() {
    const s = person();
    const p = period();
    if (!s || !p) return;
    const prev = staffPeriod(s, addDays(p.start, -1));
    try {
      const rows = (await data.listAttendance(businessId, { staffId: s.id, from: prev.start, to: prev.end }, { pageSize: 100 })).rows;
      if (!rows.length) return toast("Nothing recorded in the previous period.", "danger");
      // The latest recorded status per weekday, applied to unmarked days up to today.
      const byWeekday = new Map();
      for (const l of [...rows].sort((a, b) => (a.date < b.date ? -1 : 1))) byWeekday.set(weekdayOf(l.date), l.status);
      let n = 0;
      for (const d of visibleDays(s, p)) {
        if (d > today || valueOf(d) || !byWeekday.has(weekdayOf(d))) continue;
        stage([d], byWeekday.get(weekdayOf(d)));
        n += 1;
      }
      toast(n ? `${n} day${n === 1 ? "" : "s"} copied. Check them, then Save.` : "No unmarked days to fill.", n ? "success" : "danger");
    } catch (err) {
      toast(err.message || "Couldn't load the previous period", "danger");
    }
    draw();
  }

  function draw() {
    if (!alive) return;
    const s = person();
    render(
      container,
      html`
        ${pageHeader({ title: "Attendance" })}
        ${needsReview()}
        <section class="card section">
          <div class="pick-row" data-role="pickers">
            <label class="pick">Employee <select class="select" data-role="pick-staff" aria-label="Employee">${state.staff.map((x) => html`<option value="${x.id}" ${x.id === state.staffId ? "selected" : ""}>${x.name}</option>`)}</select></label>
            <label class="pick">Period <select class="select" data-role="pick-period" aria-label="Pay period" ${s ? "" : "disabled"}>${periods().map((p) => html`<option value="${p.start}" ${p.start === state.periodStart ? "selected" : ""}>${range(p)}${p.start <= today && today <= p.end ? " (now)" : ""}</option>`)}</select></label>
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
        const reason = await formDialog({ title: "Correct what the helper sent?", intro: `${needReason.map((f) => short(f.date)).join(", ")} ${needReason.length === 1 ? "was" : "were"} sent by the helper. Your reason is kept in the history with the before and after.`, fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. They were on leave that day" }], submitLabel: "Save correction", onSubmit: (v) => v.reason.trim() });
        if (reason) {
          const again = await data.setAttendanceMany(state.staffId, days.filter((d) => needReason.some((f) => f.date === d.date)), reason);
          r = { saved: [...r.saved, ...again.saved], failed: [...r.failed.filter((f) => f.code !== "reason-required"), ...again.failed] };
        } else r = { ...r, failed: r.failed.filter((f) => f.code !== "reason-required") };
      }
      // Paid Leave allowance used up: the Owner decides, never silently.
      const overLimit = r.failed.filter((f) => f.code === "leave-allowance-used");
      if (overLimit.length) {
        const choice = await formDialog({
          title: "Paid Leave allowance has been fully used.",
          intro: `${person()?.name ?? "This helper"} has no Paid Leave days left for ${overLimit[0].date.slice(0, 4)}. What should ${overLimit.map((f) => short(f.date)).join(", ")} be?`,
          fields: [
            { name: "choice", label: "Record as", type: "select", value: "unpaid", options: [{ value: "unpaid", label: "Unpaid Leave instead" }, { value: "override", label: "Paid Leave anyway (override)" }] },
            { name: "reason", label: "Reason (for an override)", placeholder: "e.g. Family emergency" },
          ],
          submitLabel: "Save",
          onSubmit: (v) => {
            if (v.choice === "override" && v.reason.trim().length < 3) throw new Error("Say why you're giving Paid Leave beyond the allowance");
            return { choice: v.choice, reason: v.reason.trim() };
          },
        });
        if (choice) {
          const redo = overLimit.map((f) => ({ date: f.date, status: choice.choice === "override" ? "official_leave" : "unpaid_leave" }));
          const again = await data.setAttendanceMany(state.staffId, redo, null, choice.choice === "override" ? choice.reason : null);
          r = { saved: [...r.saved, ...again.saved], failed: [...r.failed.filter((f) => f.code !== "leave-allowance-used"), ...again.failed] };
        } else r = { ...r, failed: r.failed.filter((f) => f.code !== "leave-allowance-used") };
      }
      if (r.failed.length) toast(`${r.failed.length} day${r.failed.length === 1 ? "" : "s"} not saved: ${r.failed[0].error}`, "danger");
      else if (days.length > 1) toast(`${r.saved.length} days saved.`, "success");
      else toast("Saved.", "success");
      state.selected.clear();
      state.pending.clear();
      state.expected = false;
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

  const choose = async (staffId, periodStart) => {
    if (state.pending.size && !(await confirm({ title: "Discard unsaved changes?", body: `${state.pending.size} day${state.pending.size === 1 ? "" : "s"} you changed aren't saved yet.`, confirmLabel: "Discard", danger: true }))) return draw();
    state.pending.clear();
    state.expected = false;
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
    return undefined;
  };
  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const a = el.dataset.act;
    if (a === "cell") {
      const d = el.dataset.day;
      if (d > today) return;
      if (state.selected.has(d)) state.selected.delete(d);
      else state.selected.add(d);
      draw();
    } else if (a === "apply") {
      stage([...state.selected], el.dataset.status);
      state.selected.clear();
      draw();
    } else if (a === "fill") {
      state.expected = true;
      draw();
    } else if (a === "confirm-today") {
      const s = person();
      const p = period();
      if (!s || !p) return;
      const todo = visibleDays(s, p).filter((d) => d <= today && !valueOf(d));
      for (const d of todo) stage([d], expectedStatus(s, d));
      state.expected = true;
      toast(todo.length ? `${todo.length} day${todo.length === 1 ? "" : "s"} filled from the normal schedule. Change any exceptions, then Save.` : "Every day up to today is already filled.", "success");
      draw();
    } else if (a === "copy-prev") copyPrevious();
    else if (a === "discard") {
      state.pending.clear();
      state.selected.clear();
      state.expected = false;
      draw();
    } else if (a === "save") {
      const days = [...state.pending.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([date, status]) => ({ date, status }));
      if (days.length) save(days);
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
