// Payroll = Work (Phase 18.5): "How much should each person receive?"
// One compact row per person per pay period, opened on "To pay"; "Paid
// history" (released, with receipt confirmations) is the same list
// filtered to Paid, so the Household story Attendance → Payroll →
// Advances → History needs no extra module.
//   Employee | Period | Days | Basic pay | Additions | Deductions | Net pay |
//   Payment | Received | View
// Everything is computed by the server from attendance and advances. Phase
// 18.6: three obvious actions on an unpaid payroll (Add deduction, Add
// bonus, Add 13th month pay); Gross = basic + additions, Net = gross -
// deductions. The Owner's payment (Not paid / Paid / Disputed, with an
// optional GCash / bank screenshot) and the employee's "Received" are
// separate: paying gives a one-time link, and staff with a Luna login can
// confirm from their own screen.
// Owner-pilot batch (2026-10-11): payroll is automatic. "By period" opens on
// the current pay period with everyone on payroll (from Household Staff:
// pay cycle, cutoffs, start / end dates); nobody prepares anything. A period
// nobody touched is worked out by the server on the fly (nothing stored);
// paying it, or adding a bonus / deduction, stores it once. A salary may be
// paid before the period ends (an early payment): the days after the
// payment date stay open and the final pay is shown against what was paid.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, segmented, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { PAYROLL_STATUSES, RECEIPT_STATUSES, SALARY_METHODS, PAY_CYCLES, businessDate, periodFor, addDays, parseCentavos } from "@shared/index.js";
import * as defaultData from "../household/data.js";
import { prepareProof } from "../../lib/image.js";

const RECEIPT_TONE = { none: "neutral", awaiting: "warning", confirmed: "success" };
// The Owner's payment and the employee's confirmation, in plain words.
export const paymentState = (p) => (p.status !== "released" ? ["Not paid", "warning"] : p.ownerPayment === "disputed" ? ["Disputed", "danger"] : ["Paid", "success"]);
export const receivedState = (p) => (p.status !== "released" ? ["—", "neutral"] : p.receiptStatus === "confirmed" ? ["Received", "success"] : p.dispute?.state === "open" ? ["Not received", "danger"] : ["Not confirmed", "warning"]);
const daysText = (p) => [[p.present, "P"], [p.officialLeave, "PL"], [p.unpaidLeave, "UL"], [p.restDay, "R"], [p.absent, "A"]].filter(([n]) => n).map(([n, k]) => `${n} ${k}`).join(" · ") || "No days";
const METHOD_ORDER = ["cash", "gcash", "bank_transfer", "maya", "other"];
const period = (p) => `${formatDayId(p.periodStart)} – ${formatDayId(p.periodEnd)}`;
const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");
export const periodName = (x) => (x.start.slice(0, 7) === x.end.slice(0, 7) ? `${short(x.start)}–${Number(x.end.slice(8))}` : `${short(x.start)} – ${short(x.end)}`);
function earlyGapNote(p, today) {
  const g = earlyGap(p);
  if (!g) return "";
  const ended = today > p.periodEnd;
  return html`<p class="chart-note" data-role="early">${badge("Early salary payment", "info")} Paid ${formatCentavos(g.paid)} on ${short(p.salary.paidDate)}, before the period ended (${short(p.periodEnd)}). ${!g.diff ? "The final take-home matches what was paid." : g.diff > 0 ? html`Final take-home is now <strong>${formatCentavos(g.final)}</strong>: <strong>${formatCentavos(g.diff)} more</strong> than paid${ended ? "" : " so far"}.` : html`Final take-home is now <strong>${formatCentavos(g.final)}</strong>: <strong>${formatCentavos(-g.diff)} less</strong> than paid${ended ? "" : " so far"}.`} ${ended ? "" : "Days after the payment date can still change it."}</p>`;
}
// After an early payment: what was paid vs the final take-home now.
export function earlyGap(p) {
  if (p.status !== "released" || p.paymentTiming !== "early" || !p.salary) return null;
  return { paid: p.salary.amount, final: p.netPay, diff: p.netPay - p.salary.amount };
}
export const receiptUrl = (token, origin = window.location.origin) => `${origin}/receipt#${token}`;

// The last few periods of a person's cycle, newest first (to prepare).
export function recentPeriods(cycle, today, count = 4) {
  const out = [];
  let p = periodFor(cycle, today);
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = periodFor(cycle, addDays(p.start, -1));
  }
  return out;
}

// The stored proof image, fetched from the server (payroll.view).
async function viewProof(payrollId, title, api = defaultData.payrollApi) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  document.body.appendChild(backdrop);
  const paint = (body) => render(backdrop, html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${title}" data-role="proof-viewer"><div class="modal-header"><h2 class="card-title">${title}</h2></div><div class="modal-body proof-body">${body}</div><div class="modal-footer"><button type="button" class="btn btn-primary" data-act="close">Close</button></div></div>`);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest('[data-act="close"]')) backdrop.remove();
  });
  paint(html`<p class="stat-hint">Loading…</p>`);
  try {
    const { proof } = await api({ action: "proof", payrollId });
    if (!/^image\/(jpeg|png|webp)$/.test(proof.contentType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof.dataBase64 || "")) throw new Error("Unexpected file");
    paint(html`<img class="proof-image" alt="${title}" src="data:${proof.contentType};base64,${proof.dataBase64}" />`);
  } catch (err) {
    paint(html`<p class="form-error">${err.message || "Couldn't load the proof."}</p>`);
  }
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, copy = (t) => navigator.clipboard?.writeText(t) } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["payroll.manage"] === true;
  const canRelease = perms["payroll.release"] === true;
  const businessId = session.business.id;
  const today = businessDate(session.business.timezone, now());
  const state = { view: "period", staffId: "", status: "", from: "", to: "", cursors: [], rows: [], hasMore: false, staff: [], loading: true, error: null, periods: [], period: null, periodRows: [] };
  let alive = true;
  // "awaiting" = paid, receipt not yet confirmed.
  const filters = () => Object.fromEntries(Object.entries({ staffId: state.staffId, status: state.view === "all" ? state.status : "", receiptStatus: state.view === "awaiting" ? "awaiting" : "", from: state.from, to: state.to }).filter(([, v]) => v));

  async function load() {
    state.loading = true;
    draw();
    try {
      if (state.view === "period") {
        const { view } = await data.payrollApi({ action: "period", ...(state.period ? { period: state.period.mixed || state.period.current ? { current: true } : { start: state.period.start, end: state.period.end } } : {}) });
        state.periods = view.periods;
        state.period = view.period;
        state.periodRows = view.rows;
        state.error = null;
        state.loading = false;
        return draw();
      }
      if (!state.staff.length) state.staff = await data.activeStaff(businessId);
      const page = await data.listPayrolls(businessId, filters(), { cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("payroll: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load payroll.";
    }
    state.loading = false;
    draw();
  }

  const VIEWS = [["period", "By period"], ["awaiting", "Not confirmed"], ["all", "All records"]];
  const STATUS_OPTIONS = [["draft", "Not paid"], ["released", "Paid"]];
  const payBadge = (p) => (p.status === "released" && p.paymentTiming === "early" ? badge(p.ownerPayment === "disputed" ? "Disputed" : "Paid early", p.ownerPayment === "disputed" ? "danger" : "success") : badge(...paymentState(p)));

  // Owner-pilot batch: one pay period, everyone on payroll for it.
  function periodView() {
    if (!state.period) return emptyState({ iconName: "payroll", title: "No pay periods yet", body: "Add household staff with a start date and pay cycle. Their pay periods appear here by themselves." });
    // Several pay cycles at once: "Now" = everyone's own current period.
    const mixed = state.period.mixed === true;
    const i = mixed ? state.periods.filter((x) => x.current).length - 1 : state.periods.findIndex((x) => x.start === state.period.start && x.end === state.period.end);
    const older = state.periods[i + 1];
    const newer = mixed ? null : i > 0 ? state.periods[i - 1] : null;
    const hasMixed = state.periods.filter((x) => x.current).length > 1;
    const rows = state.periodRows;
    const toPay = rows.filter((p) => p.status !== "released").reduce((t, p) => t + Math.max(0, p.netPay), 0);
    return html`<div class="period-bar" data-role="period-bar">
        <button type="button" class="btn btn-icon" data-act="period" data-key="${older ? `${older.start}_${older.end}` : ""}" aria-label="Older period" ${older ? "" : "disabled"}>‹</button>
        <select class="select" data-role="period-select" aria-label="Pay period">${hasMixed ? html`<option value="current" ${mixed ? "selected" : ""}>Now (everyone)</option>` : ""}${state.periods.map((x) => html`<option value="${x.start}_${x.end}" ${!mixed && x.start === state.period.start && x.end === state.period.end ? "selected" : ""}>${periodName(x)}${x.current ? " (now)" : ""}</option>`)}</select>
        <button type="button" class="btn btn-icon" data-act="period" data-key="${newer ? (newer.current && hasMixed ? "current" : `${newer.start}_${newer.end}`) : ""}" aria-label="Newer period" ${newer ? "" : "disabled"}>›</button>
      </div>
      <p class="chart-note" data-role="period-state">${mixed ? html`${badge("In progress", "info")} Each person's own pay period (their cutoffs differ). Updates as you approve attendance, leave and advances.` : state.period.state === "in_progress" ? html`${badge("In progress", "info")} Ends ${short(state.period.end)}. Updates as you approve attendance, leave and advances.` : html`${badge("Ended", "neutral")} ${short(state.period.start)} to ${short(state.period.end)}.`}${toPay ? html` · <strong>${formatCentavos(toPay)}</strong> still to pay` : ""}</p>
      ${!rows.length
        ? emptyState({ iconName: "staff", title: "Nobody on payroll for this period", body: "Payroll follows each person's start date, end date and pay cycle on Household Staff." })
        : html`<div class="table-wrap"><table class="table table-compact rows" data-role="period-payrolls">
          <thead><tr><th class="m-only"></th><th>Employee</th><th class="col-secondary">Days</th><th class="num col-secondary">Basic pay</th><th class="num col-secondary">Bonus / 13th</th><th class="num col-secondary">Deductions</th><th class="num">Net pay</th><th>Payment</th><th>Received</th><th><span class="visually-hidden">Details</span></th></tr></thead>
          <tbody>${rows.map((p) => {
            const gap = earlyGap(p);
            return html`<tr data-payroll="${p.id}" data-open>
              ${mobileCell({ title: p.staffName, sub: `${mixed ? `${periodName({ start: p.periodStart, end: p.periodEnd })} · ` : ""}${daysText(p)}${p.status === "released" ? ` · ${p.paymentTiming === "early" ? "Paid early" : "Paid"} · ${receivedState(p)[0]}` : " · Not paid"}`, end: formatCentavos(p.netPay), endSub: gap && gap.diff ? `paid ${formatCentavos(gap.paid)}` : p.status === "released" ? "paid" : "to pay" })}
              <td class="cell-strong">${p.staffName}${mixed ? html`<span class="cell-sub">${periodName({ start: p.periodStart, end: p.periodEnd })}</span>` : ""}</td>
              <td class="col-secondary">${daysText(p)}${p.notMarked ? html` <span class="stat-hint">(${p.notMarked} not marked)</span>` : ""}</td>
              <td class="num col-secondary">${formatCentavos(p.basePay)}</td><td class="num col-secondary">${p.additionsTotal ? formatCentavos(p.additionsTotal) : "—"}</td><td class="num col-secondary">${formatCentavos(p.deductionsTotal)}</td>
              <td class="num"><strong>${formatCentavos(p.netPay)}</strong>${gap && gap.diff ? html`<span class="cell-sub">paid ${formatCentavos(gap.paid)}</span>` : ""}</td>
              <td data-col="payment">${payBadge(p)}</td>
              <td data-col="received">${badge(...receivedState(p))}</td>
              <td class="row-actions" data-m="more">${openButton(p.id, `Open payroll of ${p.staffName}`, { act: "view" })}</td>
            </tr>`;
          })}</tbody></table></div>`}`;
  }
  const EMPTY = {
    draft: ["Nothing to pay right now", "Prepare payroll for a pay period once attendance is marked."],
    awaiting: ["Nothing waiting", "Everyone confirmed receiving their salary."],
    released: ["No paid salaries yet", "Salaries you release appear here with their receipt confirmation."],
    "": ["No payroll records yet", "Payroll you pay or change appears here. Use By period to see every pay period."],
  };

  function draw() {
    if (!alive) return;
    const listStatus = state.view === "awaiting" ? "awaiting" : state.status;
    const [emptyTitle, emptyBody] = EMPTY[listStatus] ?? EMPTY[""];
    const header = pageHeader({ title: "Payroll", subtitle: "Every pay period appears by itself from Household Staff. Take-home = basic pay from approved attendance, plus bonus or 13th month, minus advances and deductions." });
    const tabs = html`<div class="toolbar">${segmented("view", VIEWS, state.view, { label: "Show" })}</div>`;
    if (state.view === "period") {
      render(container, html`${header}${tabs}<section class="card" data-section="period">${state.error ? emptyState({ title: "Couldn't load", body: state.error }) : state.loading && !state.period?.start ? skeleton(5) : periodView()}</section>`);
      return;
    }
    render(
      container,
      html`
        ${header}
        ${tabs}
        ${filterBar({
          fields: [
            { name: "staffId", label: "Employee", type: "select", primary: true, all: "All employees", options: state.staff.map((x) => [x.id, x.name]), value: state.staffId },
            ...(state.view === "all" ? [{ name: "status", label: "Payment", type: "select", all: "Paid and not paid", options: STATUS_OPTIONS, value: state.status }] : []),
            { name: "from", label: "Periods from", type: "date", value: state.from },
            { name: "to", label: "Periods to", type: "date", value: state.to },
          ],
          end: html`${mayExport(session, "payroll") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("payroll")}` : ""}`,
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "payroll", title: emptyTitle, body: emptyBody })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="payrolls">
                    <thead><tr><th class="m-only"></th><th>Employee</th><th>Period</th><th class="col-secondary">Days</th><th class="num col-secondary">Basic pay</th><th class="num col-secondary">Bonus / 13th</th><th class="num col-secondary">Deductions</th><th class="num">Net pay</th><th>Payment</th><th>Received</th><th><span class="visually-hidden">Details</span></th></tr></thead>
                    <tbody>${state.rows.map(
                      (p) => html`<tr data-payroll="${p.id}" data-open>
                        ${mobileCell({ title: p.staffName, sub: `${period(p)} · ${daysText(p)}`, end: formatCentavos(p.netPay), endSub: p.status === "released" ? receivedState(p)[0] : "to pay" })}
                        <td class="cell-strong">${p.staffName}</td><td>${period(p)}</td>
                        <td class="col-secondary">${daysText(p)}${p.notMarked ? html` <span class="stat-hint">(${p.notMarked} not marked)</span>` : ""}</td>
                        <td class="num col-secondary">${formatCentavos(p.basePay)}</td><td class="num col-secondary">${p.additionsTotal ? formatCentavos(p.additionsTotal) : "—"}</td><td class="num col-secondary">${formatCentavos(p.deductionsTotal)}</td>
                        <td class="num"><strong>${formatCentavos(p.netPay)}</strong></td>
                        <td data-col="payment">${badge(...paymentState(p))}</td>
                        <td data-col="received">${badge(...receivedState(p))}</td>
                        <td class="row-actions" data-m="more">${openButton(p.id, `Open payroll of ${p.staffName}`, { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager">
                    <button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button>
                    <button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button>
                  </div>`}
        </section>`
    );
  }

  // `row`: a period row worked out automatically (nothing stored yet). The
  // first change stores it (prepare: once per person + period).
  async function openView(id, row = null) {
    let payrollId = id;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    let p = null;
    let link = null; // shown once after release / new link
    let thm = null; // this year's 13th month: earned / given / left
    const close = () => {
      backdrop.remove();
      load();
    };
    const refresh = async () => {
      p = await data.getPayroll(businessId, payrollId);
      if (!p && row && row.id === payrollId) p = row;
      thm = null;
      paint();
      if (p && p.status === "draft" && canManage) {
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
      row = null;
      return payrollId;
    };
    const run = async (fn, message) => {
      try {
        await ensure();
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
    const paint = () => {
      if (!p) return render(backdrop, html`<div class="modal"><div class="modal-body">${emptyState({ title: "Payroll not found" })}</div><div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button></div></div>`);
      const draft = p.status === "draft";
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Payroll" data-role="payroll-view">
          <div class="modal-header"><h2 class="card-title">${p.staffName} · ${period(p)}</h2></div>
          <div class="modal-body">
            <p class="stat-hint">${daysText(p)}${p.notMarked ? ` · ${p.notMarked} not marked (not paid)` : ""} · ${formatCentavos(p.dailyWage)} a day</p>
            ${p.automatic ? html`<p class="chart-note" data-role="automatic">Worked out automatically from approved attendance and released advances. ${today <= p.periodEnd ? `The period is still ongoing (ends ${short(p.periodEnd)}).` : ""}</p>` : ""}
            ${earlyGapNote(p, today)}
            <table class="table table-compact pay-breakdown" data-role="breakdown"><tbody>
              <tr><td>Basic pay <span class="stat-hint">${p.payableDays} paid days</span></td><td class="num">${formatCentavos(p.basePay)}</td><td></td></tr>
              ${(p.additions || []).map((a) => html`<tr data-addition="${a.id}"><td>+ ${a.description}${a.type === "thirteenth" ? html` <span class="stat-hint">13th month ${a.year}</span>` : ""}</td><td class="num">${formatCentavos(a.amount)}</td><td class="row-actions">${draft && canManage ? html`<button type="button" class="btn btn-compact btn-ghost" data-x="remove-add" data-id="${a.id}">Remove</button>` : ""}</td></tr>`)}
              <tr class="is-subtotal"><td>Gross pay</td><td class="num">${formatCentavos(p.grossPay ?? p.basePay + (p.additionsTotal || 0))}</td><td></td></tr>
              ${(p.deductions || []).map(
                (d) => html`<tr><td>− ${d.type === "advance" ? "" : "Deduction: "}${d.description}</td><td class="num">${formatCentavos(d.amount)}</td>
                  <td class="row-actions">${draft && canManage ? (d.type === "manual" ? html`<button type="button" class="btn btn-compact btn-ghost" data-x="remove" data-id="${d.id}">Remove</button>` : html`<button type="button" class="btn btn-compact btn-ghost" data-x="defer" data-id="${d.advanceId}">Deduct next payroll</button>`) : ""}</td></tr>`
              )}
              <tr class="is-total"><td><strong>Net pay (take-home)</strong></td><td class="num"><strong data-role="net">${formatCentavos(p.netPay)}</strong></td><td></td></tr>
            </tbody></table>
            ${thm ? html`<p class="stat-hint" data-role="thirteenth">13th month ${thm.year}: ${formatCentavos(thm.entitlement)} earned so far (1/12 of ${formatCentavos(thm.basicPay)} basic pay, this payroll included) · ${formatCentavos(thm.onPayrolls)} given · <strong>${formatCentavos(thm.remaining)} left</strong></p>` : ""}
            <dl class="dl dl-compact">
              <dt>Payment</dt><dd data-role="payment">${p.paymentTiming === "early" && p.status === "released" ? "Paid early" : paymentState(p)[0]}${p.salary ? ` · ${formatDayId(p.salary.paidDate)} by ${SALARY_METHODS[p.salary.method]?.label}${p.salary.reference ? ` · Ref ${p.salary.reference}` : ""}` : ""}${p.salary?.proof ? html` · <button type="button" class="btn-linklike" data-x="view-proof">See proof</button>` : ""}</dd>
              <dt>Received by employee</dt><dd data-role="receipt">${receivedState(p)[0]}${p.receiptConfirmedVia === "staff-account" ? " (from their Luna account)" : p.receiptConfirmedVia === "employee-link" ? " (from the link)" : ""}</dd>
              ${p.dispute?.state === "open" ? html`<dt>Reported</dt><dd class="text-danger">Not received${p.dispute.note ? `: "${p.dispute.note}"` : ""}</dd>` : ""}
            </dl>
            <h3 class="section-title visually-hidden">Deductions</h3>
            ${(p.deductions || []).length
              ? html`<table class="table table-compact" data-role="deductions"><tbody>${p.deductions.map(
                  (d) => html`<tr><td>${d.type === "advance" ? "Advance" : "Deduction"}</td><td>${d.description}</td><td class="num">${formatCentavos(d.amount)}</td>
                    <td class="row-actions">${draft && canManage ? (d.type === "manual" ? html`<button type="button" class="btn btn-compact" data-x="remove" data-id="${d.id}">Remove</button>` : html`<button type="button" class="btn btn-compact" data-x="defer" data-id="${d.advanceId}">Deduct next payroll</button>`) : ""}</td></tr>`
                )}</tbody></table>`
              : html`<p class="stat-hint">No deductions.</p>`}
            ${link
              ? html`<div class="card section" data-role="receipt-link"><strong>Send this link to ${p.staffName}</strong>
                  <p class="stat-hint">They tap it to confirm they received ${formatCentavos(p.salary?.amount ?? p.netPay)}. It works once and expires in 14 days. It won't be shown again; make a new one if needed.</p>
                  <input class="input" readonly value="${link}" data-role="link-text" />
                  <button type="button" class="btn btn-compact" data-x="copy">Copy link</button></div>`
              : ""}
            <ul class="list activity">${(p.history || []).map((h) => html`<li>${h.label}${h.actor ? ` · ${h.actor.name}` : h.via === "employee-link" ? " · by the employee, via the secure link" : ""}</li>`)}</ul>
          </div>
          <div class="modal-footer">
            ${draft && canManage ? html`<button type="button" class="btn" data-x="add">Add deduction</button><button type="button" class="btn" data-x="add-bonus">Add bonus</button><button type="button" class="btn" data-x="add-13th">Add 13th month pay</button>${p.automatic ? "" : html`<button type="button" class="btn btn-danger-ghost" data-x="delete">Reset to automatic</button>`}` : ""}
            ${draft && canRelease ? html`<button type="button" class="btn btn-primary" data-x="release">Pay salary</button>` : ""}
            ${!draft && canRelease && !p.salary?.proof ? html`<button type="button" class="btn" data-x="add-proof">Add payment proof</button>` : ""}
            ${!draft && canRelease && p.dispute?.state === "open" ? html`<button type="button" class="btn" data-x="resolve">Answer "not received"</button>` : ""}
            ${!draft && p.receiptStatus === "awaiting" && canRelease ? html`<button type="button" class="btn" data-x="newlink">New receipt link</button>` : ""}
            <button type="button" class="btn" data-x="close">Close</button>
          </div>
        </div>`
      );
    };
    backdrop.addEventListener("click", async (event) => {
      if (event.target === backdrop) return close();
      const el = event.target.closest("[data-x]");
      if (!el) return;
      const x = el.dataset.x;
      if (x === "close") close();
      else if (x === "copy") {
        try {
          await copy(link);
          toast("Link copied.", "success");
        } catch {
          toast("Copy the link from the box.", "neutral");
        }
      } else if (x === "remove") run(() => data.payrollApi({ action: "removeDeduction", payrollId, deductionId: el.dataset.id }));
      else if (x === "remove-add") run(() => data.payrollApi({ action: "removeAddition", payrollId, additionId: el.dataset.id }));
      else if (x === "add-bonus") {
        const r = await formDialog({ title: `Add a bonus for ${p.staffName}`, intro: "A bonus is extra pay you choose to give. It's separate from 13th month pay.", fields: [{ name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" }, { name: "description", label: "What for? (optional)", placeholder: "e.g. Christmas bonus" }], submitLabel: "Add bonus", onSubmit: async (v) => data.payrollApi({ action: "addAddition", payrollId: await ensure(), addition: { type: "bonus", amount: parseCentavos(v.amount), ...(v.description.trim() ? { description: v.description.trim() } : {}) } }) });
        if (r) refresh();
      } else if (x === "add-13th") {
        const left = thm?.remaining;
        const r = await formDialog({
          title: `Add 13th month pay for ${p.staffName}`,
          intro: thm ? `13th month pay is 1/12 of the basic pay earned in ${thm.year}: ${formatCentavos(thm.entitlement)} so far, ${formatCentavos(thm.onPayrolls)} already given, ${formatCentavos(left)} left. You can give it all now or part of it.` : "13th month pay is 1/12 of the basic pay earned this year. Luna works out how much is left.",
          fields: [{ name: "amount", label: "Amount (₱)", value: left ? String(left / 100) : "", inputmode: "decimal", hint: "Leave as is to give everything that's left." }],
          submitLabel: "Add 13th month pay",
          onSubmit: async (v) => data.payrollApi({ action: "addAddition", payrollId: await ensure(), addition: { type: "thirteenth", ...(v.amount.trim() ? { amount: parseCentavos(v.amount) } : {}) } }),
        });
        if (r) refresh();
      } else if (x === "add-proof") {
        const r = await formDialog({ title: "Add payment proof", intro: "A screenshot of the GCash or bank transfer. It doesn't change the payment or the employee's confirmation.", fields: [{ name: "proof", label: "Screenshot", type: "file", accept: "image/jpeg,image/png,image/webp" }], submitLabel: "Upload", onSubmit: async (v) => { if (!v.proof) throw new Error("Choose a screenshot"); return data.payrollApi({ action: "attachProof", payrollId, proof: await prepareProof(v.proof) }); } });
        if (r) {
          toast("Proof added.", "success");
          refresh();
        }
      } else if (x === "view-proof") viewProof(payrollId, `Payment proof · ${p.staffName}`);
      else if (x === "resolve") {
        const r = await formDialog({ title: "Answer the not-received report", intro: `${p.staffName} said the salary didn't arrive. Check the payment, then say what happened.`, fields: [{ name: "note", label: "What happened?", required: true, placeholder: "e.g. Sent again by GCash, Ref 1234" }], submitLabel: "Save", onSubmit: (v) => data.payrollApi({ action: "resolveDispute", payrollId, note: v.note }) });
        if (r) refresh();
      } else if (x === "defer") run(() => data.payrollApi({ action: "deferAdvance", payrollId, advanceId: el.dataset.id }), "Moved to the next payroll.");
      else if (x === "add") {
        const r = await formDialog({ title: "Add deduction", fields: [{ name: "description", label: "Description", required: true }, { name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" }], onSubmit: async (v) => data.payrollApi({ action: "addDeduction", payrollId: await ensure(), deduction: { description: v.description, amount: parseCentavos(v.amount) } }) });
        if (r) refresh();
      } else if (x === "delete") {
        if (await confirmDialog({ title: "Reset this payroll to automatic?", body: "Removes the bonuses and deductions you added here. Attendance stays; advances are worked out again.", confirmLabel: "Reset", danger: true })) {
          if (await run(() => data.payrollApi({ action: "deleteDraft", payrollId }), "Payroll reset to automatic.")) close();
        }
      } else if (x === "release") {
        const ongoing = today < p.periodEnd;
        const r = await formDialog({
          title: `${ongoing ? "Early salary payment: " : ""}Pay ${formatCentavos(p.netPay)} to ${p.staffName}`,
          intro: ongoing
            ? `This pay period is still ongoing (ends ${short(p.periodEnd)}). Attendance after the payment date may still change the final salary; Luna shows any difference once the period ends. The employee confirms receiving it separately.`
            : "This locks the period's attendance. The employee then confirms receiving it (from their Luna login, or a one-time link you send).",
          fields: [
            { name: "method", label: "Paid by", type: "select", value: "cash", options: METHOD_ORDER.filter((k) => SALARY_METHODS[k]).map((value) => ({ value, label: SALARY_METHODS[value].label })) },
            { name: "paidDate", label: "Date paid", type: "date", value: today, max: today },
            { name: "proof", label: "Proof (GCash / bank screenshot, optional)", type: "file", accept: "image/jpeg,image/png,image/webp" },
            { name: "reference", label: "Reference no. (optional)", more: true },
          ],
          submitLabel: "Mark paid",
          onSubmit: async (v) => {
            const proof = v.proof ? await prepareProof(v.proof) : null;
            const payment = { method: v.method, ...(v.reference ? { reference: v.reference } : {}), paidDate: v.paidDate || today };
            const target = p.automatic ? { staffId: p.staffId, periodStart: p.periodStart } : { payrollId };
            return data.payrollApi({ action: "release", ...target, payment, expectedNetPay: p.netPay, ...(proof ? { proof } : {}) });
          },
        });
        if (r) {
          payrollId = r.payrollId || payrollId;
          row = null;
          link = receiptUrl(r.receiptToken);
          toast(r.paymentTiming === "early" ? "Early salary payment recorded. Days after the payment date stay open." : "Salary marked paid.", "success");
          refresh();
        }
      } else if (x === "newlink") run(() => data.payrollApi({ action: "newReceiptLink", payrollId }), "New link ready; the old one no longer works.");
    });
    await refresh();
  }

  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const a = el.dataset.act;
    if (a === "seg" && el.dataset.seg === "view") {
      state.view = el.dataset.value;
      state.status = "";
      state.cursors = [];
      load();
    } else if (a === "period" && el.dataset.key) choosePeriod(el.dataset.key);
    else if (a === "view") openView(el.dataset.id, state.view === "period" ? state.periodRows.find((r) => r.id === el.dataset.id) || null : null);
    else if (a === "next" && state.rows.length) {
      state.cursors.push(state.rows.at(-1));
      load();
    } else if (a === "prev") {
      state.cursors.pop();
      load();
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const f = event.target.elements;
    if (f.from.value && f.to.value && f.from.value > f.to.value) return toast("The start date is after the end date.", "danger");
    Object.assign(state, { staffId: f.staffId.value, status: f.status ? f.status.value : "", from: f.from.value, to: f.to.value, cursors: [] });
    load();
  };
  function choosePeriod(key) {
    if (key === "current") state.period = { current: true };
    else {
      const [start, end] = key.split("_");
      state.period = { start, end };
    }
    load();
  }
  const onChange = (event) => {
    if (event.target.dataset.role === "period-select") choosePeriod(event.target.value);
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  container.addEventListener("change", onChange);
  const unbindExport = bindExport(container, filters, { toast, deps: exportDeps });
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
    container.removeEventListener("change", onChange);
    unbindExport();
    unbindFilters();
    unbindRows();
  };
}
