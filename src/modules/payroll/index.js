// Payroll (Owner-pilot simplification batch): "How much should I pay this
// helper for this period?"
//   Employee ▾ (Everyone / one helper)   Period ▾ (Now / a pay period)
// Payroll is automatic: every pay period appears by itself from Household
// Staff (pay cycle, cutoffs incl. 14 / 29, start / end dates); nobody
// prepares anything. A period nobody touched is worked out by the server
// on the fly (nothing stored); the first real action stores it once. With
// different cutoffs, "Now (everyone)" shows each helper's own current period.
//
// A payroll reads like a payslip; every line says what it is, where it came
// from and what can be done with it:
//   Basic pay            View calculation (days × daily wage) · View attendance
//   Bonus                ⋯ Edit / Delete            (until paid)
//   13th month pay       ⋯ Remove                   (Luna works it out)
//   Advance (date)       ⋯ View advance / Edit amount / Move to another payroll /
//                          Remove from this payroll (still owed: "not taken")
//   Other deduction      ⋯ Edit / Delete            (until paid)
//   Scheduled deduction not taken   ⋯ Move to next payroll / Mark repaid separately
// A paid salary is never edited in place: "Correct payment" keeps the
// original and records the reason, who, when, before and after. A salary
// may be paid early (before the period ends): days after the payment date
// stay open; the final take-home is shown against what was paid. The
// helper's "received" confirmation is their own, separate step.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { SALARY_METHODS, businessDate, periodFor, addDays, parseCentavos, daysIn, paidTotal, staffPeriod } from "@shared/index.js";
import * as defaultData from "../household/data.js";
import { prepareProof, PHOTO_OR_PDF_ACCEPT } from "../../lib/image.js";
import { viewProof } from "../../components/proof-viewer.js";
import { editAmount, moveTo, takeOff, repay, methodOptions } from "../advances/plan.js";

// The Owner's payment and the employee's confirmation, in plain words.
export const paymentState = (p) => (p.status !== "released" ? ["Not paid", "warning"] : p.ownerPayment === "disputed" ? ["Disputed", "danger"] : p.paymentTiming === "early" ? ["Paid early", "success"] : ["Paid", "success"]);
export const receivedState = (p) => (p.status !== "released" ? ["—", "neutral"] : p.receiptStatus === "confirmed" ? ["Received", "success"] : p.dispute?.state === "open" ? ["Not received", "danger"] : ["Not confirmed", "warning"]);
const daysText = (p) => [[p.present, "P"], [p.officialLeave, "PL"], [p.unpaidLeave, "UL"], [p.restDay, "R"], [p.absent, "A"]].filter(([n]) => n).map(([n, k]) => `${n} ${k}`).join(" · ") || "No days";
const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");
export const periodName = (x) => (x.start.slice(0, 7) === x.end.slice(0, 7) ? `${short(x.start)}–${Number(x.end.slice(8))}` : `${short(x.start)} – ${short(x.end)}`);
const rowPeriod = (p) => periodName({ start: p.periodStart, end: p.periodEnd });
export const receiptUrl = (token, origin = window.location.origin) => `${origin}/receipt#${token}`;
const ID = /^[A-Za-z0-9]{8,40}$/;

// After an early payment: what was paid vs the final take-home now.
export function earlyGap(p) {
  if (p.status !== "released" || p.paymentTiming !== "early" || !p.salary) return null;
  return { paid: paidTotal(p), final: p.netPay, diff: p.netPay - paidTotal(p) };
}
const range = (a, b) => (a === b ? short(a) : periodName({ start: a, end: b }));

// The last few periods of a cycle, newest first.
export function recentPeriods(cycle, today, count = 4) {
  const out = [];
  let p = periodFor(cycle, today);
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = periodFor(cycle, addDays(p.start, -1));
  }
  return out;
}

// A line's ⋯ menu (a native disclosure: works by touch and keyboard).
const lineMenu = (label, items) =>
  items.length
    ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="${label}">⋯</summary><div class="line-menu-list" role="menu">${items.map((i) => html`${i.sep ? html`<div class="menu-sep" role="separator"></div>` : ""}<button type="button" class="menu-item${i.danger ? " is-danger" : ""}" role="menuitem" data-x="${i.x}" data-id="${i.data?.id ?? ""}" data-kind="${i.data?.kind ?? ""}" data-amount="${i.data?.amount ?? ""}">${i.label}</button>`)}</div></details>`
    : "";

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, copy = (t) => navigator.clipboard?.writeText(t) } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["payroll.manage"] === true;
  const canRelease = perms["payroll.release"] === true;
  const canAdvances = perms["advances.manage"] === true;
  const businessId = session.business.id;
  const today = businessDate(session.business.timezone, now());
  const fromUrl = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("staff") || "";
  // ?period=<start>_<end> (bell links) opens that pay period.
  const periodParam = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("period") || "");
  const state = { staffId: ID.test(fromUrl) ? fromUrl : "", staff: [], people: null, loading: true, error: null, periods: [], period: periodParam ? { start: periodParam[1], end: periodParam[2] } : null, rows: [] };
  let alive = true;

  const periodQuery = () => (state.period && !state.period.mixed && !state.period.current ? { period: { start: state.period.start, end: state.period.end } } : state.period ? { period: { current: true } } : {});
  async function load() {
    state.loading = true;
    draw();
    try {
      if (!state.staff.length && data.activeStaff) state.staff = await data.activeStaff(businessId).catch(() => []);
      const { view } = await data.payrollApi({ action: "period", ...periodQuery(), ...(state.staffId ? { staffId: state.staffId } : {}) });
      state.periods = view.periods;
      if (view.people) state.people = view.people;
      state.period = view.period;
      state.rows = view.rows;
      state.error = null;
    } catch (err) {
      console.error("payroll: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load payroll.";
    }
    state.loading = false;
    draw();
  }

  // ⋯ per payroll: View details; Delete (unpaid) / Void (paid) last.
  // Owner-pilot cleanup: always visible. An automatic payroll has nothing
  // saved, so Delete explains that instead of doing nothing.
  const rowMenu = (p) => html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="Actions for ${p.staffName}'s payroll">⋯</summary><div class="line-menu-list" role="menu">
      <button type="button" class="menu-item" role="menuitem" data-act="view" data-id="${p.id}">View details</button>
      ${canRelease && p.status === "released" && p.salary ? html`<button type="button" class="menu-item" role="menuitem" data-act="correct-payroll" data-id="${p.id}">Correct payroll</button><button type="button" class="menu-item" role="menuitem" data-act="correct-payment" data-id="${p.id}">Correct payment</button>` : ""}
      ${canManage && p.status === "draft" ? html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item is-danger" role="menuitem" data-act="delete-payroll" data-id="${p.id}">Delete payroll</button>` : ""}
      ${canRelease && p.status === "released" ? html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item is-danger" role="menuitem" data-act="void-payroll" data-id="${p.id}">Void payroll</button>` : ""}
    </div></details>`;

  // Delete a saved, unpaid payroll (the period goes back to automatic).
  async function deletePayroll(p) {
    if (p.automatic) {
      await confirmDialog({ title: `Nothing saved for ${p.staffName}'s ${rowPeriod(p)} payroll`, body: `Luna works this payroll out by itself from attendance and advances, so there's no saved record to delete. It stays until the period is paid. To stop paying ${p.staffName}, deactivate them or set an end date on Household Staff.`, confirmLabel: "OK" });
      return false;
    }
    if (!(await confirmDialog({ title: `Delete ${p.staffName}'s ${rowPeriod(p)} payroll?`, body: "This removes the saved payroll record and manual payroll entries. Attendance, Staff and Advances will remain. The period is then worked out automatically again (planned advance deductions stay planned and still owed).", confirmLabel: "Delete payroll", danger: true }))) return false;
    try {
      await data.payrollApi({ action: "deleteDraft", payrollId: p.id });
      toast("Payroll deleted. The period is worked out automatically again.", "success");
      return true;
    } catch (err) {
      toast(err.message || "Couldn't delete", "danger");
      return false;
    }
  }
  // Void a PAID payroll: reason + explicit confirmation; reversals kept.
  async function voidPaid(p) {
    const reason = await formDialog({
      title: `Void ${p.staffName}'s ${rowPeriod(p)} payroll`,
      intro: `This payroll has already been recorded as paid (${formatCentavos(p.salary?.amount ?? p.netPay)}). Voiding it reverses the payroll: advance deductions go back to what's owed, its days unlock, and the period shows as unpaid again. An audit record of what was originally recorded is kept, including the helper's confirmation and the proof.`,
      fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Entered for the wrong helper" }],
      submitLabel: "Continue",
      onSubmit: (v) => {
        if (v.reason.trim().length < 3) throw new Error("Say why (at least 3 characters)");
        return v.reason.trim();
      },
    });
    if (!reason) return false;
    if (!(await confirmDialog({ title: "Void this paid payroll?", body: `Reason: ${reason}. It leaves the active payroll; you can still see it under Voided records.`, confirmLabel: "Void payroll", danger: true }))) return false;
    try {
      await data.payrollApi({ action: "void", payrollId: p.id, reason });
      toast("Payroll voided. Its history is kept under Voided records.", "success");
      return true;
    } catch (err) {
      toast(err.message || "Couldn't void", "danger");
      return false;
    }
  }
  async function showVoided() {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const paint = (body) => render(backdrop, html`<div class="modal" role="dialog" aria-modal="true" aria-label="Voided payrolls" data-role="voided"><div class="modal-header"><h2 class="card-title">Voided payrolls</h2></div><div class="modal-body">${body}</div><div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button></div></div>`);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop || e.target.closest('[data-x="close"]')) backdrop.remove();
    });
    paint(html`<p class="stat-hint">Loading…</p>`);
    try {
      const { voided } = await data.payrollApi({ action: "voided", ...(state.staffId ? { staffId: state.staffId } : {}) });
      paint(voided.length ? html`<ul class="slip">${voided.map((v) => html`<li><span class="slip-what">${v.staffName} · ${periodName(v.period)}<small>${v.at ? short(v.at.slice(0, 10)) : ""}${v.by ? ` by ${v.by}` : ""} · ${v.reason}</small></span><span class="slip-amt">${v.amountPaid !== null ? formatCentavos(v.amountPaid) : "—"}</span><span class="slip-act"></span></li>`)}</ul>` : html`<p class="stat-hint">No voided payrolls.</p>`);
    } catch (err) {
      paint(html`<p class="form-error">${err.message || "Couldn't load"}</p>`);
    }
  }

  function table() {
    if (!state.period) return emptyState({ iconName: "payroll", title: "No pay periods yet", body: "Add household staff with a start date and pay cycle. Their pay periods appear here by themselves." });
    const mixed = state.period.mixed === true;
    const rows = state.rows;
    const toPay = rows.filter((p) => p.status !== "released").reduce((t, p) => t + Math.max(0, p.netPay), 0);
    // Owner-pilot UX (2026-10-17): Payroll is home: the period's status and
    // the three figures that matter (prepaid is part of what was paid).
    const paid = rows.filter((p) => p.status === "released").reduce((t, p) => t + paidTotal(p), 0);
    const prepaid = rows.filter((p) => p.status === "released").reduce((t, p) => t + (p.salary?.prepaid?.amount || 0), 0);
    return html`<div class="pay-summary" data-role="period-state">
        <span class="pay-summary-state">${mixed ? html`${badge("In progress", "info")} Each helper's own period` : state.period.state === "in_progress" ? html`${badge("In progress", "info")} Ends ${short(state.period.end)}` : html`${badge("Ended", "neutral")} ${short(state.period.start)} to ${short(state.period.end)}`}</span>
        <dl class="pay-figures" data-role="pay-figures">
          <div><dt>Paid</dt><dd data-k="paid">${formatCentavos(paid)}</dd></div>
          <div><dt>Still to pay</dt><dd data-k="toPay">${formatCentavos(toPay)}</dd></div>
          ${prepaid ? html`<div><dt>Prepaid <small>(in paid)</small></dt><dd data-k="prepaid">${formatCentavos(prepaid)}</dd></div>` : ""}
        </dl>
      </div>
      ${!rows.length
        ? emptyState({ iconName: "staff", title: "Nobody on payroll for this period", body: "Payroll follows each helper's start date, end date and pay cycle on Household Staff." })
        : html`<div class="table-wrap"><table class="table table-compact rows" data-role="period-payrolls">
          <thead><tr><th class="m-only"></th><th>Employee</th><th class="col-secondary">Days</th><th class="num col-secondary">Basic pay</th><th class="num col-secondary">Bonus / 13th</th><th class="num col-secondary">Deductions</th><th class="num">Net pay</th><th>Payment</th><th>Received</th><th><span class="visually-hidden">Details</span></th></tr></thead>
          <tbody>${rows.map((p) => {
            const gap = earlyGap(p);
            return html`<tr data-payroll="${p.id}" data-open>
              ${mobileCell({ title: p.staffName, sub: `${mixed ? `${rowPeriod(p)} · ` : ""}${daysText(p)} · ${paymentState(p)[0]}${p.status === "released" ? ` · ${receivedState(p)[0]}` : ""}${p.notTaken?.length ? " · deduction not taken" : ""}`, end: formatCentavos(p.netPay), endSub: gap && gap.diff ? `paid ${formatCentavos(gap.paid)}` : p.status === "released" ? "paid" : "to pay" })}
              <td class="cell-strong">${p.staffName}${mixed ? html`<span class="cell-sub">${rowPeriod(p)}</span>` : ""}</td>
              <td class="col-secondary">${daysText(p)}${p.notMarked ? html` <span class="stat-hint">(${p.notMarked} not marked)</span>` : ""}</td>
              <td class="num col-secondary">${formatCentavos(p.basePay)}</td><td class="num col-secondary">${p.additionsTotal ? formatCentavos(p.additionsTotal) : "—"}</td><td class="num col-secondary">${formatCentavos(p.deductionsTotal)}</td>
              <td class="num"><strong>${formatCentavos(p.netPay)}</strong>${gap && gap.diff ? html`<span class="cell-sub">paid ${formatCentavos(gap.paid)}</span>` : ""}</td>
              <td data-col="payment">${badge(...paymentState(p))}</td>
              <td data-col="received">${badge(...receivedState(p))}</td>
              <td class="row-actions" data-m="more"><span class="visually-hidden">${openButton(p.id, `Open payroll of ${p.staffName}`, { act: "view" })}</span>${canRelease && p.status === "draft" && p.netPay > 0 ? html`<button type="button" class="btn btn-compact btn-primary row-pay" data-act="pay" data-id="${p.id}" aria-label="Pay ${p.staffName}">Pay</button>` : ""}${rowMenu(p)}</td>
            </tr>`;
          })}</tbody></table></div>`}`;
  }

  function draw() {
    if (!alive) return;
    const hasMixed = !state.staffId && state.periods.filter((x) => x.current).length > 1;
    const mixed = state.period?.mixed === true;
    // Owner-pilot cleanup: the server's list, by the same rule as the rows.
    const names = state.people || (state.staff.length ? state.staff : [...new Map(state.rows.map((r) => [r.staffId, { id: r.staffId, name: r.staffName }])).values()]);
    render(
      container,
      html`
        ${pageHeader({ title: "Payroll" })}
        <section class="card section" data-section="period">
          <div class="pick-row" data-role="pickers">
            <label class="pick">Employee <select class="select" data-role="pick-staff" aria-label="Employee"><option value="">Everyone</option>${names.map((x) => html`<option value="${x.id}" ${x.id === state.staffId ? "selected" : ""}>${x.name}</option>`)}</select></label>
            <label class="pick">Period <select class="select" data-role="period-select" aria-label="Pay period">${hasMixed ? html`<option value="current" ${mixed ? "selected" : ""}>Now (everyone)</option>` : ""}${state.periods.map((x) => html`<option value="${x.start}_${x.end}" ${!mixed && state.period && x.start === state.period.start && x.end === state.period.end ? "selected" : ""}>${periodName(x)}${x.current ? " (now)" : ""}</option>`)}</select></label>
          </div>
          ${state.error ? emptyState({ title: "Couldn't load", body: state.error }) : state.loading && !state.period?.start ? skeleton(5) : table()}
        </section>
        <p class="voided-link page-foot"><button type="button" class="btn-linklike" data-act="voided">Voided records ›</button></p>`
    );
    for (const btn of container.querySelectorAll('[data-act="export"]')) btn.classList.add("btn-ghost");
  }

  // ---------- One payroll, as a payslip ----------
  async function openView(id, then = null) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    let p = state.rows.find((r) => r.id === id) || null;
    let payrollId = id;
    let link = null; // shown once after paying / a new link
    let thm = null; // this year's 13th month: earned / given / left
    let calc = false; // "View calculation" open
    let correcting = false; // Owner-pilot polish: Correct payroll mode (paid)
    let detailsOpen = false;
    let releasing = false; // the Pay salary form is open (one at a time)
    // Pay flow (Owner pilot 2026-10-18): Pay -> Review payroll (read-only;
    // nothing is created) -> Continue to payment -> payment details -> only
    // "Pay salary" pays -> paid. reviewing: null | "list" (opened from the
    // row's Pay: Close closes) | "panel" (from this payslip: Back returns).
    let reviewing = then === "release" && p?.status === "draft" && canRelease ? "list" : null;
    let justPaid = 0; // the amount just paid (the success line after Pay salary)
    const staffRec = () => state.staff.find((s) => s.id === p?.staffId) || { payCycle: p?.payCycle || "semi_monthly" };
    const close = () => {
      backdrop.remove();
      load();
    };
    // Fresh figures from the server (stored or worked out now).
    const refresh = async () => {
      try {
        const { view } = await data.payrollApi({ action: "period", period: { start: p.periodStart, end: p.periodEnd }, staffId: p.staffId });
        p = view.rows.find((r) => r.staffId === p.staffId) || p;
        payrollId = p.id;
      } catch {
        /* keep what we have */
      }
      thm = null;
      paint();
      if (p.status === "draft" && canManage) {
        try {
          thm = await data.payrollApi({ action: "thirteenth", staffId: p.staffId, year: Number(p.periodEnd.slice(0, 4)) });
          paint();
        } catch {
          /* optional */
        }
      }
    };
    // An automatic payroll is stored before the first change to it.
    const ensure = async () => {
      if (!p?.automatic) return payrollId;
      const r = await data.payrollApi({ action: "prepare", staffId: p.staffId, periodStart: p.periodStart });
      payrollId = r.payrollId;
      p = { ...p, automatic: false, id: payrollId };
      return payrollId;
    };
    const run = async (fn, message) => {
      try {
        const r = await fn();
        if (message) toast(message, "success");
        if (r && r.receiptToken) link = receiptUrl(r.receiptToken);
        await refresh();
        return r;
      } catch (err) {
        toast(err.message || "Something went wrong", "danger");
        return null;
      }
    };
    // After payment: what was actually paid vs the final salary (attendance
    // completed, or a Correct payroll), and what Luna does with a difference.
    const reconcileBlock = (q) => {
      const r = q.reconcile;
      const corrected = (q.corrections || []).length > 0;
      const parts =
        r.ended && !r.waiting && r.diff
          ? html`<dl class="owe-figures" data-role="early">
              <dt>Actually paid</dt><dd>${formatCentavos(r.paid)}</dd>
              <dt>${corrected ? "Corrected entitlement" : "Final salary"}</dt><dd>${formatCentavos(r.final)}</dd>
            </dl>`
          : "";
      let status = "";
      if (!r.ended) status = html`<p class="stat-hint" data-role="reconcile">${badge("Paid early", "info")} The period ends ${short(q.periodEnd)}. Record the remaining days as they happen; Luna settles the difference after that.</p>`;
      else if (r.waiting) status = html`<p class="stat-hint" data-role="reconcile">${badge("Waiting for attendance", "warning")} Record the remaining ${r.unrecorded} day${r.unrecorded === 1 ? "" : "s"} on Attendance to settle the difference.</p>`;
      else if (r.settled || (r.overpaid && !r.outstanding)) status = html`<p class="stat-hint" data-role="reconcile">${badge("Settled", "success")} ${r.overpaid ? `The ${formatCentavos(r.overpaid)} paid but not earned is settled.` : "Everything paid was earned."}</p>`;
      else if (r.outstanding) status = html`<div class="reconcile-row" data-role="reconcile"><p class="stat-hint">${badge("Salary overpayment", "warning")} <strong>${formatCentavos(r.outstanding)}</strong> paid but not earned.${r.carriedTo?.length ? ` It comes off ${r.carriedTo.map((t) => range(t.periodStart, t.periodEnd)).join(", ")}.` : ""} It isn't a cash advance.</p>${canRelease ? lineMenu("Salary overpayment actions", [{ x: "ovp-keep", label: "Keep on next payroll", data: { id: q.id } }, { x: "ovp-move", label: "Move to another payroll", data: { id: q.id } }, { x: "ovp-repay", label: "Mark repaid separately", data: { id: q.id, amount: r.outstanding } }, { x: "ovp-waive", label: "Waive", data: { id: q.id, amount: r.outstanding }, sep: true }]) : ""}</div>`;
      else if (r.additionalDue) status = html`<div class="reconcile-row" data-role="reconcile"><p class="stat-hint">${badge("Additional salary due", "warning")} <strong>${formatCentavos(r.additionalDue)}</strong> more was earned than paid.</p>${canRelease ? html`<button type="button" class="btn btn-compact btn-primary" data-x="pay-additional">Record additional payment</button>` : ""}</div>`;
      return html`${parts}${status}`;
    };
    const advanceOf = async (advanceId) => (await data.listAdvances(businessId, { staffId: p.staffId }, { pageSize: 100 })).rows.find((a) => a.id === advanceId);

    // Owner-pilot polish (2026-10-16): the payslip reads in a few seconds.
    // Default: confirmation status, then Basic pay, each bonus / deduction,
    // the prepaid salary (paid early for upcoming days), and the total.
    // Calculation, payment details and history fold under "View details".
    // "Correct payroll" (paid only) puts a ⋯ on each line that can be wrong.
    const firstName = (n) => String(n || "").split(" ")[0];
    const statusLine = (q) => {
      if (q.status !== "released") return badge(q.automatic ? "Not paid yet · worked out automatically" : "Not paid yet", "neutral");
      if (q.receiptStatus === "confirmed") return badge(`Confirmed by ${firstName(q.receiptView?.confirmedBy || q.staffName)}${q.receiptView?.confirmedAt ? ` on ${short(businessDate(session.business.timezone, new Date(q.receiptView.confirmedAt)))}` : ""}`, "success");
      if (q.dispute?.state === "open") return badge("Reported not received", "danger");
      return badge("Not yet confirmed", "warning");
    };
    // Basic pay as it was when the salary was paid (early: earned so far).
    const basicShown = (q) => {
      if (q.status !== "released" || !q.salary) return q.basePay;
      if (q.salary.atPayment) return q.salary.atPayment.basePay;
      if (q.paymentTiming === "early") return (q.salary.earned ?? q.salary.amount) + (q.deductionsTotal || 0) - (q.additionsTotal || 0);
      return q.basePay;
    };
    // The helper's receipt (Owner pilot 2026-10-19): Opened and Confirmed are separate facts.
    const when = (iso) => {
      const d = new Date(iso);
      const tz = session.business.timezone;
      return `${formatDayId(businessDate(tz, d))} · ${d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: tz }).toUpperCase()}`;
    };
    const receiptFacts = (v) => html`<dl class="dl dl-compact receipt-facts" data-role="receipt">
        <dt>Receipt</dt><dd data-role="receipt-status">${v.status === "confirmed" ? badge("Confirmed", "success") : v.status === "not_received" ? badge("Reported not received", "danger") : badge("Not confirmed yet", "warning")}</dd>
        <dt>Opened</dt><dd data-role="receipt-opened">${v.openedAt ? when(v.openedAt) : "Not opened yet"}</dd>
        ${v.status === "confirmed"
          ? html`${v.confirmedBy ? html`<dt>Confirmed by</dt><dd data-role="receipt-by">${v.confirmedBy}</dd>` : ""}${v.verifiedVia ? html`<dt>Verified via</dt><dd data-role="receipt-via">${v.verifiedVia}</dd>` : ""}${v.confirmedAt ? html`<dt>Confirmed</dt><dd data-role="receipt-at">${when(v.confirmedAt)}</dd>` : ""}`
          : ""}
      </dl>`;
    const fixMenu = (label, items) => (correcting && canRelease ? lineMenu(label, items) : "");

    // Step 2: what will be paid, read-only. Opening it creates or changes nothing.
    const reviewPaint = () => {
      const ongoing = today < p.periodEnd;
      const attendanceHref = `/attendance?staff=${encodeURIComponent(p.staffId)}&period=${p.periodStart}`;
      const deductionLabel = (d) => (d.type === "overpayment" ? "Previous salary overpayment" : d.type === "advance" ? "Advance deduction" : d.description);
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="pr-review-title" data-role="payroll-review">
          <div class="modal-header"><h2 class="card-title" id="pr-review-title">Review payroll</h2></div>
          <div class="modal-body">
            <p class="pay-status" data-role="review-who"><strong>${p.staffName} · ${rowPeriod(p)}</strong></p>
            <ul class="slip" data-role="review-lines">
              <li data-line="basic"><span class="slip-what">Basic pay<small>${p.payableDays} paid days × ${formatCentavos(p.dailyWage)}</small></span><span class="slip-amt">${formatCentavos(p.basePay)}</span><span class="slip-act"><button type="button" class="btn btn-compact btn-ghost" data-x="calc">${calc ? "Hide" : "View calculation"}</button></span></li>
              ${calc ? html`<li class="slip-calc" data-role="calc"><span>${p.present} Present + ${p.officialLeave} Paid Leave = ${p.payableDays} paid days × ${formatCentavos(p.dailyWage)} = ${formatCentavos(p.basePay)}. Not paid: ${p.absent} Absent, ${p.unpaidLeave || 0} Unpaid Leave, ${p.restDay || 0} Rest Day${p.notMarked ? `, ${p.notMarked} not marked` : ""}. <a href="${attendanceHref}" data-link data-x="goto">View attendance</a></span></li>` : ""}
              ${(p.additions || []).map((a) => html`<li data-addition="${a.id}"><span class="slip-what">${a.type === "thirteenth" ? `13th month pay ${a.year}` : a.description}</span><span class="slip-amt">${formatCentavos(a.amount)}</span><span class="slip-act"></span></li>`)}
              ${(p.deductions || []).map((d) => html`<li data-deduction="${d.id}"><span class="slip-what">${deductionLabel(d)}</span><span class="slip-amt">− ${formatCentavos(d.amount)}</span><span class="slip-act"></span></li>`)}
            </ul>
            <ul class="slip slip-total slip-total-paid"><li><span class="slip-what"><strong>To pay</strong></span><span class="slip-amt"><strong data-role="review-net">${formatCentavos(p.netPay)}</strong></span><span class="slip-act"></span></li></ul>
            ${ongoing ? html`<p class="stat-hint" data-role="review-ongoing">The period is still ongoing (ends ${short(p.periodEnd)}): this is what's earned so far. You can also pay the upcoming days on the next step.</p>` : ""}
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" data-x="${reviewing === "panel" ? "review-back" : "close"}">${reviewing === "panel" ? "Back" : "Close"}</button>
            <button type="button" class="btn btn-primary" data-x="continue-pay" ${releasing ? "disabled" : ""}>Continue to payment</button>
          </div>
        </div>`
      );
    };

    const paint = () => {
      if (!p) return render(backdrop, html`<div class="modal"><div class="modal-body">${emptyState({ title: "Payroll not found" })}</div><div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button></div></div>`);
      if (reviewing && (p.status !== "draft" || !canRelease)) reviewing = null;
      if (reviewing) return reviewPaint();
      const draft = p.status === "draft";
      const paid = p.status === "released" && p.salary;
      const attendanceHref = `/attendance?staff=${encodeURIComponent(p.staffId)}&period=${p.periodStart}`;
      const prepaid = paid ? p.salary.prepaid : null;
      const totalPaid = paid ? paidTotal(p) : 0;
      const r = p.reconcile;
      const advMenu = (d) =>
        draft && canAdvances
          ? lineMenu(`Actions for ${d.description}`, [{ x: "adv-view", label: "View advance", data: { id: d.advanceId } }, { x: "adv-amount", label: "Edit amount", data: { id: d.advanceId } }, { x: "adv-move", label: "Move to another payroll", data: { id: d.advanceId } }, { x: "adv-off", label: "Remove from this payroll", danger: true, data: { id: d.advanceId } }])
          : correcting
            ? fixMenu(`Correct ${d.description}`, [{ x: "fix-adv", label: "Correct amount", data: { id: d.advanceId, amount: d.amount } }, { x: "adv-view", label: "View advance", data: { id: d.advanceId } }, { x: "fix-adv-off", label: "Remove from this payroll", danger: true, data: { id: d.advanceId, amount: d.amount } }])
            : "";
      const manualMenu = (line, kind) =>
        draft && canManage
          ? lineMenu(`Actions for ${line.description}`, kind === "thirteenth" ? [{ x: "remove-add", label: "Remove", danger: true, data: { id: line.id } }] : [{ x: "edit-line", label: "Edit", data: { id: line.id, kind } }, { x: kind === "bonus" ? "remove-add" : "remove", label: "Delete", danger: true, data: { id: line.id } }])
          : fixMenu(`Correct ${line.description}`, [...(kind === "thirteenth" ? [] : [{ x: "fix-line", label: "Edit amount or label", data: { id: line.id, kind } }]), { x: "fix-remove", label: "Remove", danger: true, data: { id: line.id, kind } }]);
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Payroll" data-role="payroll-view">
          <div class="modal-header"><h2 class="card-title">${p.staffName} · ${rowPeriod(p)}</h2></div>
          <div class="modal-body">
            ${justPaid ? html`<p class="chart-note" data-role="paid-success">${badge("Paid", "success")} ${formatCentavos(paid ? totalPaid : justPaid)} to ${p.staffName}.</p>` : ""}
            <p class="pay-status" data-role="pay-status">${statusLine(p)}${paid ? html`<span class="stat-hint">${p.paymentTiming === "early" ? "Paid early" : "Paid"} ${short(p.salary.paidDate)} · ${SALARY_METHODS[p.salary.method]?.label ?? ""}</span>` : ""}</p>
            ${correcting ? html`<p class="chart-note" data-role="correcting">${badge("Correcting", "info")} Tap ⋯ on the line that's wrong. The payment itself (${formatCentavos(totalPaid)}) stays as it was; Luna settles any difference. Basic pay follows attendance: <a href="${attendanceHref}" data-link data-x="goto">correct the days</a>.</p>` : ""}
            <ul class="slip" data-role="summary">
              <li data-line="basic"><span class="slip-what">Basic pay<small>${paid && p.paymentTiming === "early" ? `Earned through ${short(p.salary.paidDate)}` : `${p.payableDays} paid days × ${formatCentavos(p.dailyWage)}`}</small></span><span class="slip-amt">${formatCentavos(basicShown(p))}</span><span class="slip-act"><button type="button" class="btn btn-compact btn-ghost" data-x="calc">${calc ? "Hide" : "View calculation"}</button></span></li>
              ${calc ? html`<li class="slip-calc" data-role="calc"><span>${p.present} Present + ${p.officialLeave} Paid Leave = ${p.payableDays} paid days × ${formatCentavos(p.dailyWage)} = ${formatCentavos(p.basePay)}${paid && basicShown(p) !== p.basePay ? ` (${formatCentavos(basicShown(p))} when paid)` : ""}. Not paid: ${p.absent} Absent, ${p.unpaidLeave || 0} Unpaid Leave, ${p.restDay || 0} Rest Day${p.notMarked ? `, ${p.notMarked} not marked` : ""}. <a href="${attendanceHref}" data-link data-x="goto">View attendance</a></span></li>` : ""}
              ${(p.additions || []).map((a) => html`<li data-addition="${a.id}"><span class="slip-what">${a.type === "thirteenth" ? `13th month pay ${a.year}` : a.description}<small>${a.type === "thirteenth" ? "1/12 of the year's basic pay" : "Bonus"}</small></span><span class="slip-amt">${formatCentavos(a.amount)}</span><span class="slip-act">${manualMenu(a, a.type === "thirteenth" ? "thirteenth" : "bonus")}</span></li>`)}
              ${(p.deductions || []).map((d) =>
                d.type === "overpayment"
                  ? html`<li data-deduction="${d.id}" data-overpayment="${d.sourcePayrollId}"><span class="slip-what">Previous salary overpayment<small>From ${range(d.sourcePeriod.start, d.sourcePeriod.end)}</small></span><span class="slip-amt">− ${formatCentavos(d.amount)}</span><span class="slip-act">${canRelease ? lineMenu("Actions for the previous salary overpayment", [{ x: "ovp-source", label: "View source", data: { id: d.sourcePayrollId } }, { x: "ovp-move", label: "Move to another payroll", data: { id: d.sourcePayrollId } }, { x: "ovp-repay", label: "Mark repaid separately", data: { id: d.sourcePayrollId, amount: d.amount } }, { x: "ovp-waive", label: "Waive", data: { id: d.sourcePayrollId, amount: d.amount }, sep: true }]) : ""}</span></li>`
                  : d.type === "advance"
                    ? html`<li data-deduction="${d.id}" data-advance="${d.advanceId}"><span class="slip-what">Advance deduction<small>${d.description.replace(/^Advance /, "Advance of ")}</small></span><span class="slip-amt">− ${formatCentavos(d.amount)}</span><span class="slip-act">${advMenu(d)}</span></li>`
                    : html`<li data-deduction="${d.id}"><span class="slip-what">${d.description}<small>Deduction</small></span><span class="slip-amt">− ${formatCentavos(d.amount)}</span><span class="slip-act">${manualMenu(d, "deduction")}</span></li>`
              )}
              ${(p.notTaken || []).map((n) => html`<li class="slip-missed" data-not-taken="${n.advanceId}"><span class="slip-what">Scheduled deduction not taken<small>${n.description} · still owed</small></span><span class="slip-amt">${formatCentavos(n.amount)}</span><span class="slip-act">${canAdvances ? lineMenu("Actions for the deduction not taken", [{ x: "nt-move", label: "Move to next payroll", data: { id: n.advanceId } }, { x: "nt-repaid", label: "Mark repaid separately", data: { id: n.advanceId, amount: n.amount } }, { x: "adv-view", label: "Edit repayment plan", data: { id: n.advanceId } }]) : ""}</span></li>`)}
              ${prepaid || (correcting && paid && p.paymentTiming === "early") ? html`<li data-line="prepaid"><span class="slip-what">Prepaid salary${prepaid ? ` ${range(prepaid.from, prepaid.to)}` : ""}<small>Paid early for upcoming days · not a cash advance</small></span><span class="slip-amt">${formatCentavos(prepaid?.amount ?? 0)}</span><span class="slip-act">${fixMenu("Correct the prepaid salary", [{ x: "fix-prepaid", label: "Correct prepaid salary", data: { id: p.id, amount: prepaid?.days ?? 0 } }])}</span></li>` : ""}
            </ul>
            <ul class="slip slip-total slip-total-paid"><li><span class="slip-what"><strong>${paid ? "Total paid" : "To pay"}</strong></span><span class="slip-amt"><strong data-role="net">${formatCentavos(paid ? totalPaid : p.netPay)}</strong></span><span class="slip-act"></span></li></ul>
            ${paid && p.receiptView ? receiptFacts(p.receiptView) : ""}
            ${paid && r && (r.overpaid || r.additionalDue || r.waiting || !r.ended || r.diff) ? reconcileBlock(p) : ""}
            ${p.dispute?.state === "open" ? html`<p class="text-danger" data-role="dispute">Reported not received${p.dispute.note ? `: "${p.dispute.note}"` : ""}</p>` : ""}
            ${link
              ? html`<div class="card section" data-role="receipt-link"><strong>Send this link to ${p.staffName}</strong>
                  <p class="stat-hint">They open it, sign in to their Luna account and confirm they received ${formatCentavos(p.salary?.amount ?? p.netPay)}. It expires in 14 days.</p>
                  ${staffRec().login ? "" : html`<p class="stat-hint" data-role="needs-login">${p.staffName} needs a Luna login to confirm. Create one under Household Staff.</p>`}
                  <input class="input" readonly value="${link}" data-role="link-text" aria-label="Receipt link" />
                  <button type="button" class="btn btn-compact" data-x="copy">Copy link</button></div>`
              : ""}
            <details class="form-more" data-role="details" ${detailsOpen ? "open" : ""}><summary data-x="details">View details</summary>
              ${p.automatic ? html`<p class="chart-note" data-role="automatic">Worked out automatically from attendance and advances.${today <= p.periodEnd ? ` The period is still ongoing (ends ${short(p.periodEnd)}).` : ""}</p>` : ""}
              <dl class="dl dl-compact">
                <dt>Final salary${today > p.periodEnd ? "" : " so far"}</dt><dd data-role="final">${formatCentavos(p.netPay)}</dd>
                <dt>Payment</dt><dd data-role="payment">${paymentState(p)[0]}${p.salary ? ` · ${formatCentavos(p.salary.amount)} on ${short(p.salary.paidDate)} by ${SALARY_METHODS[p.salary.method]?.label}${p.salary.reference ? ` · Ref ${p.salary.reference}` : ""}` : ""}${p.salary?.proof ? html` · <button type="button" class="btn-linklike" data-x="view-proof">See proof</button>` : ""}</dd>
              </dl>
              ${thm && thm.remaining > 0 ? html`<p class="stat-hint" data-role="thirteenth">13th month ${thm.year}: ${formatCentavos(thm.remaining)} left to give (1/12 of ${formatCentavos(thm.basicPay)} basic pay, minus ${formatCentavos(thm.onPayrolls)} given).</p>` : ""}
              ${(p.history || []).length ? html`<h3 class="slip-head">History</h3><ul class="list activity" data-role="history">${p.history.map((h) => html`<li>${h.label}${h.actor ? ` · ${h.actor.name}` : h.via === "employee-link" ? " · by the helper, via the secure link" : ""}</li>`)}</ul>` : ""}
            </details>
          </div>
          <div class="modal-footer">
            ${draft && canManage ? html`<details class="line-menu line-menu-up"><summary class="btn">Add ▾</summary><div class="line-menu-list" role="menu"><button type="button" class="menu-item" data-x="add-bonus">Bonus</button><button type="button" class="menu-item" data-x="add">Other deduction</button><button type="button" class="menu-item" data-x="add-13th">13th month pay</button>${p.automatic ? "" : html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item is-danger" data-x="delete">Delete payroll</button>`}</div></details>` : ""}
            ${draft && canRelease ? html`<button type="button" class="btn btn-primary" data-x="release">Pay</button>` : ""}
            ${correcting ? html`<button type="button" class="btn btn-primary" data-x="done-correcting">Done</button>` : ""}
            ${!draft && canRelease && !correcting ? html`<button type="button" class="btn" data-x="correct-payroll" data-role="correct-payroll-btn">Correct payroll</button>` : ""}
            ${!draft && canRelease && !correcting ? html`<details class="line-menu line-menu-up"><summary class="btn">More ▾</summary><div class="line-menu-list" role="menu"><button type="button" class="menu-item" data-x="correct-payroll">Correct payroll</button><button type="button" class="menu-item" data-x="correct">Correct payment</button>${!p.salary?.proof ? html`<button type="button" class="menu-item" data-x="add-proof">Add payment proof</button>` : ""}${p.receiptStatus === "awaiting" ? html`<button type="button" class="menu-item" data-x="newlink">New receipt link</button>` : ""}${p.dispute?.state === "open" ? html`<button type="button" class="menu-item" data-x="resolve">Answer "not received"</button>` : ""}<div class="menu-sep" role="separator"></div><button type="button" class="menu-item is-danger" data-x="void">Void payroll</button></div></details>` : ""}
            <button type="button" class="btn" data-x="close">Close</button>
          </div>
        </div>`
      );
    };

    backdrop.addEventListener("click", async (event) => {
      if (event.target === backdrop) return close();
      const el = event.target.closest("[data-x]");
      if (!el) return undefined;
      el.closest("details")?.removeAttribute("open");
      const x = el.dataset.x;
      const advApi = (body) => data.advancesApi(body);
      if (x === "close") close();
      else if (x === "goto") backdrop.remove();
      else if (x === "calc") {
        calc = !calc;
        paint();
      } else if (x === "copy") {
        try {
          await copy(link);
          toast("Link copied.", "success");
        } catch {
          toast("Copy the link from the box.", "neutral");
        }
      } else if (x === "remove") {
        if (await confirmDialog({ title: "Delete this deduction?", body: "The take-home goes up by that amount. The change is kept in the payroll history.", confirmLabel: "Delete", danger: true })) run(() => data.payrollApi({ action: "removeDeduction", payrollId, deductionId: el.dataset.id }), "Deduction deleted.");
      } else if (x === "remove-add") {
        if (await confirmDialog({ title: "Remove this from the payroll?", body: "The take-home goes down by that amount. The change is kept in the payroll history.", confirmLabel: "Remove", danger: true })) run(() => data.payrollApi({ action: "removeAddition", payrollId, additionId: el.dataset.id }), "Removed.");
      } else if (x === "details") {
        event.preventDefault();
        detailsOpen = !detailsOpen;
        paint();
      } else if (x === "correct-payroll") {
        correcting = true;
        paint();
      } else if (x === "done-correcting") {
        correcting = false;
        paint();
      } else if (x === "fix-line" || x === "fix-remove" || x === "fix-adv" || x === "fix-adv-off" || x === "fix-prepaid") {
        const reasonField = { name: "reason", label: "Reason", required: true, placeholder: "e.g. I typed the wrong amount" };
        const send = (change, reason) => data.payrollApi({ action: "correctPayroll", payrollId, change, reason: reason.trim() });
        let r = null;
        if (x === "fix-line" || x === "fix-remove") {
          const line = el.dataset.kind === "deduction" ? (p.deductions || []).find((d) => d.id === el.dataset.id) : (p.additions || []).find((a) => a.id === el.dataset.id);
          if (!line) return undefined;
          r =
            x === "fix-line"
              ? await formDialog({ title: `Correct ${line.description}`, intro: "The payment stays as it was. Luna settles any difference (salary overpayment or additional salary due).", fields: [{ name: "description", label: "Label", value: line.description, required: true }, { name: "amount", label: "Amount (₱)", value: String(line.amount / 100), required: true, inputmode: "decimal" }, reasonField], submitLabel: "Save correction", onSubmit: (v) => send({ op: "line", lineId: line.id, amount: parseCentavos(v.amount), description: v.description.trim() }, v.reason) })
              : await formDialog({ title: `Remove ${line.description}?`, intro: `${formatCentavos(line.amount)} comes off this payroll's breakdown. The payment stays as it was.`, fields: [reasonField], submitLabel: "Remove", onSubmit: (v) => send({ op: "line", lineId: line.id, remove: true }, v.reason) });
        } else if (x === "fix-adv" || x === "fix-adv-off") {
          const d = (p.deductions || []).find((q) => q.type === "advance" && q.advanceId === el.dataset.id);
          if (!d) return undefined;
          r =
            x === "fix-adv"
              ? await formDialog({ title: "Correct the advance deduction", intro: `Deducted now: ${formatCentavos(d.amount)}. A lower amount leaves the rest owed (it shows as "not taken": move it to the next payroll or record a repayment). The advance itself stays.`, fields: [{ name: "amount", label: "Correct amount (₱)", value: String(d.amount / 100), required: true, inputmode: "decimal" }, reasonField], submitLabel: "Save correction", onSubmit: (v) => send({ op: "advance", advanceId: d.advanceId, amount: parseCentavos(v.amount) }, v.reason) })
              : await formDialog({ title: "Remove this advance deduction?", intro: `${formatCentavos(d.amount)} is owed again on the advance (nothing is deleted). The payment stays as it was.`, fields: [reasonField], submitLabel: "Remove", onSubmit: (v) => send({ op: "advance", advanceId: d.advanceId, amount: 0 }, v.reason) });
        } else {
          const first = addDays(p.salary.paidDate, 1);
          const left = first <= p.periodEnd ? daysIn({ start: first, end: p.periodEnd }) : [];
          r = await formDialog({
            title: "Correct prepaid salary",
            intro: `The total paid (${formatCentavos(paidTotal(p))}) stays as it was; this says which part was for upcoming days. The original and your reason are kept.`,
            fields: [{ name: "days", label: "Prepaid days", type: "select", value: String(p.salary.prepaid?.days ?? 0), options: [{ value: "0", label: "None" }, ...left.map((d, i) => ({ value: String(i + 1), label: `${i + 1} day${i ? "s" : ""} (${range(left[0], d)}): ${formatCentavos((i + 1) * (p.dailyWage || 0))}` }))] }, reasonField],
            submitLabel: "Save correction",
            onSubmit: (v) => send({ op: "prepaid", days: Number(v.days) }, v.reason),
          });
        }
        if (r) {
          toast(r.unchanged ? "Nothing changed." : "Payroll corrected; the payment stays as it was.", "success");
          refresh();
        }
      } else if (x === "edit-line") {
        const line = el.dataset.kind === "bonus" ? (p.additions || []).find((a) => a.id === el.dataset.id) : (p.deductions || []).find((d) => d.id === el.dataset.id);
        if (!line) return undefined;
        const r = await formDialog({ title: el.dataset.kind === "bonus" ? "Edit bonus" : "Edit deduction", fields: [{ name: "description", label: "What for", value: line.description, required: true }, { name: "amount", label: "Amount (₱)", value: String(line.amount / 100), required: true, inputmode: "decimal" }], submitLabel: "Save", onSubmit: (v) => data.payrollApi({ action: "editLine", payrollId, lineId: line.id, changes: { amount: parseCentavos(v.amount), description: v.description.trim() } }) });
        if (r) {
          toast("Saved.", "success");
          refresh();
        }
      } else if (x === "add-bonus") {
        const r = await formDialog({ title: `Add a bonus for ${p.staffName}`, intro: "Extra pay you choose to give. It's separate from 13th month pay.", fields: [{ name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" }, { name: "description", label: "What for? (optional)", placeholder: "e.g. Christmas bonus" }], submitLabel: "Add bonus", onSubmit: async (v) => data.payrollApi({ action: "addAddition", payrollId: await ensure(), addition: { type: "bonus", amount: parseCentavos(v.amount), ...(v.description.trim() ? { description: v.description.trim() } : {}) } }) });
        if (r) refresh();
      } else if (x === "add-13th") {
        const left = thm?.remaining;
        const r = await formDialog({
          title: `Add 13th month pay for ${p.staffName}`,
          intro: thm ? `13th month pay is 1/12 of the basic pay earned in ${thm.year}: ${formatCentavos(thm.entitlement)} so far, ${formatCentavos(thm.onPayrolls)} already given, ${formatCentavos(left)} left.` : "13th month pay is 1/12 of the basic pay earned this year. Luna works out how much is left.",
          fields: [{ name: "amount", label: "Amount (₱)", value: left ? String(left / 100) : "", inputmode: "decimal", hint: "Leave as is to give everything that's left." }],
          submitLabel: "Add 13th month pay",
          onSubmit: async (v) => data.payrollApi({ action: "addAddition", payrollId: await ensure(), addition: { type: "thirteenth", ...(v.amount.trim() ? { amount: parseCentavos(v.amount) } : {}) } }),
        });
        if (r) refresh();
      } else if (x === "add") {
        const r = await formDialog({ title: "Add a deduction", fields: [{ name: "description", label: "What for", required: true, placeholder: "e.g. Broken plate" }, { name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" }], onSubmit: async (v) => data.payrollApi({ action: "addDeduction", payrollId: await ensure(), deduction: { description: v.description, amount: parseCentavos(v.amount) } }) });
        if (r) refresh();
      } else if (x === "add-proof") {
        const r = await formDialog({ title: "Add payment proof", intro: "A GCash or bank screenshot, or a PDF. It doesn't change the payment or the helper's confirmation.", fields: [{ name: "proof", label: "Proof", type: "file", accept: PHOTO_OR_PDF_ACCEPT }], submitLabel: "Upload", onSubmit: async (v) => { if (!v.proof) throw new Error("Choose a file"); return data.payrollApi({ action: "attachProof", payrollId, proof: await prepareProof(v.proof, { pdf: true }) }); } });
        if (r) {
          toast("Proof added.", "success");
          refresh();
        }
      } else if (x === "view-proof") viewProof({ title: `Payment proof · ${p.staffName}`, load: async () => (await data.payrollApi({ action: "proof", payrollId })).proof });
      else if (x === "resolve") {
        const r = await formDialog({ title: "Answer the not-received report", intro: `${p.staffName} said the salary didn't arrive. Check the payment, then say what happened.`, fields: [{ name: "note", label: "What happened?", required: true, placeholder: "e.g. Sent again by GCash, Ref 1234" }], submitLabel: "Save", onSubmit: (v) => data.payrollApi({ action: "resolveDispute", payrollId, note: v.note }) });
        if (r) refresh();
      } else if (x === "correct") {
        const r = await formDialog({
          title: "Correct this payment",
          intro: "The original payment stays in the history; your reason, the date and the before / after are kept.",
          fields: [
            { name: "amount", label: "Amount paid (₱)", value: String(p.salary.amount / 100), inputmode: "decimal" },
            { name: "paidDate", label: "Date paid", type: "date", value: p.salary.paidDate, max: today },
            { name: "method", label: "Paid by", type: "select", value: p.salary.method, options: methodOptions() },
            { name: "reference", label: "Reference", value: p.salary.reference || "" },
            { name: "reason", label: "Reason", required: true, placeholder: "e.g. I typed the wrong amount" },
          ],
          submitLabel: "Save correction",
          onSubmit: (v) => {
            const correction = {};
            const amount = parseCentavos(v.amount);
            if (amount !== p.salary.amount) correction.amount = amount;
            if (v.paidDate && v.paidDate !== p.salary.paidDate) correction.paidDate = v.paidDate;
            if (v.method !== p.salary.method) correction.method = v.method;
            if ((v.reference.trim() || null) !== (p.salary.reference || null)) correction.reference = v.reference.trim();
            if (!Object.keys(correction).length) throw new Error("Nothing changed");
            return data.payrollApi({ action: "correctPayment", payrollId, correction, reason: v.reason });
          },
        });
        if (r) {
          toast("Payment corrected; the original is kept in the history.", "success");
          refresh();
        }
      } else if (x === "delete") {
        if (await deletePayroll({ ...p, id: payrollId })) close();
      } else if (x === "void") {
        if (await voidPaid({ ...p, id: payrollId })) close();
      } else if (x === "adv-view") {
        backdrop.remove();
        window.history.pushState({}, "", `/advances?staff=${encodeURIComponent(p.staffId)}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      } else if (x === "adv-amount" || x === "adv-move" || x === "adv-off" || x === "nt-move" || x === "nt-repaid") {
        try {
          const a = await advanceOf(el.dataset.id);
          if (!a) throw new Error("Advance not found");
          let r = null;
          if (x === "adv-amount") r = await editAmount({ advance: a, periodStart: p.periodStart, api: advApi });
          else if (x === "adv-move") r = await moveTo({ advance: a, fromPeriodStart: p.periodStart, staff: staffRec(), today, api: advApi });
          else if (x === "adv-off") {
            if (await confirmDialog({ title: "Remove from this payroll?", body: "It won't be deducted now. The advance is still owed; it shows as \"not taken\" so you can move it or record a repayment.", confirmLabel: "Remove from payroll" })) r = await takeOff({ advance: a, periodStart: p.periodStart, api: advApi });
          } else if (x === "nt-move") r = await data.payrollApi({ action: "deferAdvance", payrollId: p.id, advanceId: a.id });
          else r = await repay({ advance: a, today, api: advApi, notTakenPeriod: p.periodStart, amount: Number(el.dataset.amount) });
          if (r) {
            toast(x === "nt-repaid" ? "Repayment recorded." : "Repayment plan updated. What's owed didn't change.", "success");
            refresh();
          }
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
      } else if (x === "release") {
        // Step 2: Review payroll (read-only).
        if (releasing || p.status !== "draft" || !canRelease) return undefined;
        reviewing = reviewing || "panel";
        calc = false;
        paint();
      } else if (x === "review-back") {
        reviewing = null;
        paint();
      } else if (x === "continue-pay") {
        // Step 3: payment details. Only its own "Pay salary" button pays;
        // one form at a time; the button arms after a moment so the tap that
        // opened it can't press it. Back / Cancel returns to Review, unpaid.
        if (releasing || !reviewing || p.status !== "draft") return undefined;
        releasing = true;
        paint();
        const ongoing = today < p.periodEnd;
        // Upcoming days of the period (after today) that can be paid now.
        const upcoming = ongoing ? daysIn({ start: addDays(today, 1), end: p.periodEnd }) : [];
        const wage = p.dailyWage || 0;
        const prepaidOptions = [{ value: "0", label: "No, only what's earned so far" }, ...upcoming.map((d, i) => ({ value: String(i + 1), label: `${i + 1} upcoming day${i ? "s" : ""} (${range(upcoming[0], d)}): +${formatCentavos((i + 1) * wage)}` }))];
        let sent = 0;
        const r = await formDialog({
          title: `${ongoing ? "Early salary payment: " : ""}Pay ${formatCentavos(p.netPay)} to ${p.staffName}`,
          intro: ongoing
            ? `This pay period is still ongoing (ends ${short(p.periodEnd)}). Earned through ${short(today)}: ${formatCentavos(p.netPay)}. You can also pay the upcoming days now (prepaid salary, not a cash advance). Upcoming days stay unmarked; Luna settles any difference after the period ends. The helper confirms receiving it separately.`
            : "This locks the period's attendance. The helper then confirms receiving it from their Luna login (or a one-time link).",
          fields: [
            { name: "method", label: "Paid by", type: "select", value: "cash", options: methodOptions() },
            { name: "paidDate", label: "Date paid", type: "date", value: today, max: today },
            ...(ongoing ? [{ name: "prepaidDays", label: "Also pay upcoming days (prepaid salary)?", type: "select", value: String(upcoming.length), options: prepaidOptions }] : []),
            { name: "proof", label: "Proof (screenshot or PDF, optional)", type: "file", accept: PHOTO_OR_PDF_ACCEPT },
            { name: "reference", label: "Reference no. (optional)", more: true },
          ],
          submitLabel: "Pay salary",
          cancelLabel: "Back",
          armMs: 700,
          onSubmit: async (v) => {
            const proof = v.proof ? await prepareProof(v.proof, { pdf: true }) : null;
            const payment = { method: v.method, ...(v.reference ? { reference: v.reference } : {}), paidDate: v.paidDate || today, ...(ongoing && Number(v.prepaidDays) > 0 ? { prepaidDays: Number(v.prepaidDays) } : {}) };
            sent = p.netPay + (payment.prepaidDays || 0) * wage;
            const target = p.automatic ? { staffId: p.staffId, periodStart: p.periodStart } : { payrollId };
            return data.payrollApi({ action: "release", ...target, payment, expectedNetPay: p.netPay, ...(proof ? { proof } : {}) });
          },
        });
        releasing = false;
        if (!r) paint(); // back to Review
        else {
          // Step 4: paid.
          reviewing = null;
          justPaid = sent;
          payrollId = r.payrollId || payrollId;
          link = r.receiptToken ? receiptUrl(r.receiptToken) : null;
          toast(r.paymentTiming === "early" ? `Early salary payment recorded${r.prepaid ? `, including ${r.prepaid.days} prepaid day${r.prepaid.days === 1 ? "" : "s"}` : ""}. Upcoming days stay open.` : "Salary marked paid.", "success");
          refresh();
        }
      } else if (x.startsWith("ovp-") || x === "pay-additional") {
        const sourceId = el.dataset.id || payrollId;
        const src = sourceId === p.id ? p : null;
        let r = null;
        try {
          if (x === "ovp-source") {
            const m = /_(\d{4}-\d{2}-\d{2})$/.exec(sourceId);
            backdrop.remove();
            const s0 = staffRec();
            state.staffId = p.staffId;
            state.period = { start: m[1], end: staffPeriod(s0, m[1]).end };
            await load();
            return openView(sourceId);
          }
          if (x === "ovp-keep") r = await data.payrollApi({ action: "overpayment", payrollId: sourceId, change: { op: "keep" } });
          else if (x === "ovp-move") {
            const s0 = staffRec();
            const opts = [];
            let q = staffPeriod(s0, addDays(today, 0));
            for (let i = 0; i < 6; i++) {
              opts.push(q);
              q = staffPeriod(s0, addDays(q.end, 1));
            }
            r = await formDialog({ title: "Move the salary overpayment", intro: "It stays owed; only the payroll it comes off changes.", fields: [{ name: "to", label: "Take it from", type: "select", value: opts[1]?.start, options: opts.map((o) => ({ value: o.start, label: range(o.start, o.end) })) }], submitLabel: "Move", onSubmit: (v) => data.payrollApi({ action: "overpayment", payrollId: sourceId, change: { op: "move", periodStart: v.to } }) });
          } else if (x === "ovp-repay") {
            r = await formDialog({ title: "Salary overpayment repaid separately", intro: "Money given back outside payroll. It lowers what's owed right away.", fields: [{ name: "amount", label: "Amount (₱)", value: String(Number(el.dataset.amount) / 100), required: true, inputmode: "decimal" }, { name: "date", label: "Date", type: "date", value: today, max: today }, { name: "method", label: "How", type: "select", value: "cash", options: methodOptions() }, { name: "note", label: "Note (optional)", more: true }], submitLabel: "Record repayment", onSubmit: (v) => data.payrollApi({ action: "overpayment", payrollId: sourceId, change: { op: "repay", amount: parseCentavos(v.amount), date: v.date || today, method: v.method, ...(v.note.trim() ? { note: v.note.trim() } : {}) } }) });
          } else if (x === "ovp-waive") {
            r = await formDialog({ title: "Waive the salary overpayment?", intro: `${formatCentavos(Number(el.dataset.amount))} won't be taken back. The reason is kept in the history.`, fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Holiday bonus instead" }], submitLabel: "Waive", onSubmit: (v) => data.payrollApi({ action: "overpayment", payrollId: sourceId, change: { op: "waive", reason: v.reason.trim() } }) });
          } else if (x === "pay-additional") {
            const due = src?.reconcile?.additionalDue ?? 0;
            r = await formDialog({ title: `Additional salary for ${p.staffName}`, intro: `${formatCentavos(due)} more was earned than paid early. The early payment stays as it was.`, fields: [{ name: "amount", label: "Amount paid now (₱)", value: String(due / 100), required: true, inputmode: "decimal" }, { name: "method", label: "Paid by", type: "select", value: "cash", options: methodOptions() }, { name: "paidDate", label: "Date paid", type: "date", value: today, max: today }], submitLabel: "Record payment", onSubmit: (v) => data.payrollApi({ action: "payAdditional", payrollId: sourceId, payment: { amount: parseCentavos(v.amount), method: v.method, paidDate: v.paidDate || today } }) });
          }
          if (r) {
            toast("Saved.", "success");
            refresh();
          }
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
      } else if (x === "newlink") run(() => data.payrollApi({ action: "newReceiptLink", payrollId }), "New link ready; the old one no longer works.");
      return undefined;
    });
    paint();
    await refresh();
    // From the row's ⋯ (e.g. Correct payment): open that action directly.
    // (The row's Pay opens Review, set up above.)
    if (then && then !== "release") backdrop.querySelector(`[data-x="${then}"]`)?.click();
  }

  function choosePeriod(key) {
    if (key === "current") state.period = { current: true };
    else {
      const [start, end] = key.split("_");
      state.period = { start, end };
    }
    load();
  }
  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    el.closest("details")?.removeAttribute("open");
    const p = state.rows.find((r) => r.id === el.dataset.id);
    if (el.dataset.act === "view") openView(el.dataset.id);
    else if (el.dataset.act === "correct-payment") openView(el.dataset.id, "correct");
    else if (el.dataset.act === "correct-payroll") openView(el.dataset.id, "correct-payroll");
    else if (el.dataset.act === "pay") openView(el.dataset.id, "release");
    else if (el.dataset.act === "delete-payroll" && p) deletePayroll(p).then((ok) => ok && load());
    else if (el.dataset.act === "void-payroll" && p) voidPaid(p).then((ok) => ok && load());
    else if (el.dataset.act === "voided") showVoided();
  };
  const onChange = (event) => {
    if (event.target.dataset.role === "period-select") choosePeriod(event.target.value);
    if (event.target.dataset.role === "pick-staff") {
      state.staffId = event.target.value;
      state.period = null;
      load();
    }
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  const unbindExport = bindExport(container, () => Object.fromEntries(Object.entries({ staffId: state.staffId, from: state.period?.start || "", to: state.period?.mixed ? state.period?.end : state.period?.start || "" }).filter(([, v]) => v)), { toast, deps: exportDeps });
  const unbindRows = bindRowOpen(container, { act: "view" });
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    unbindExport();
    unbindRows();
  };
}
