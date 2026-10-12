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
import { SALARY_METHODS, businessDate, periodFor, addDays, parseCentavos } from "@shared/index.js";
import * as defaultData from "../household/data.js";
import { prepareProof } from "../../lib/image.js";
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
  return { paid: p.salary.amount, final: p.netPay, diff: p.netPay - p.salary.amount };
}

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
    ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="${label}">⋯</summary><div class="line-menu-list" role="menu">${items.map((i) => html`<button type="button" class="menu-item${i.danger ? " is-danger" : ""}" role="menuitem" data-x="${i.x}" data-id="${i.data?.id ?? ""}" data-kind="${i.data?.kind ?? ""}" data-amount="${i.data?.amount ?? ""}">${i.label}</button>`)}</div></details>`
    : "";

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, copy = (t) => navigator.clipboard?.writeText(t) } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["payroll.manage"] === true;
  const canRelease = perms["payroll.release"] === true;
  const canAdvances = perms["advances.manage"] === true;
  const businessId = session.business.id;
  const today = businessDate(session.business.timezone, now());
  const fromUrl = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("staff") || "";
  const state = { staffId: ID.test(fromUrl) ? fromUrl : "", staff: [], loading: true, error: null, periods: [], period: null, rows: [] };
  let alive = true;

  const periodQuery = () => (state.period && !state.period.mixed && !state.period.current ? { period: { start: state.period.start, end: state.period.end } } : state.period ? { period: { current: true } } : {});
  async function load() {
    state.loading = true;
    draw();
    try {
      if (!state.staff.length && data.activeStaff) state.staff = await data.activeStaff(businessId).catch(() => []);
      const { view } = await data.payrollApi({ action: "period", ...periodQuery(), ...(state.staffId ? { staffId: state.staffId } : {}) });
      state.periods = view.periods;
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

  function table() {
    if (!state.period) return emptyState({ iconName: "payroll", title: "No pay periods yet", body: "Add household staff with a start date and pay cycle. Their pay periods appear here by themselves." });
    const mixed = state.period.mixed === true;
    const rows = state.rows;
    const toPay = rows.filter((p) => p.status !== "released").reduce((t, p) => t + Math.max(0, p.netPay), 0);
    return html`<p class="chart-note" data-role="period-state">${mixed ? html`${badge("In progress", "info")} Each helper's own current pay period.` : state.period.state === "in_progress" ? html`${badge("In progress", "info")} Ends ${short(state.period.end)}. Updates as you record attendance and advances.` : html`${badge("Ended", "neutral")} ${short(state.period.start)} to ${short(state.period.end)}.`}${toPay ? html` · <strong>${formatCentavos(toPay)}</strong> still to pay` : ""}</p>
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
              <td class="row-actions" data-m="more">${openButton(p.id, `Open payroll of ${p.staffName}`, { act: "view" })}</td>
            </tr>`;
          })}</tbody></table></div>`}`;
  }

  function draw() {
    if (!alive) return;
    const hasMixed = !state.staffId && state.periods.filter((x) => x.current).length > 1;
    const mixed = state.period?.mixed === true;
    const names = state.staff.length ? state.staff : [...new Map(state.rows.map((r) => [r.staffId, { id: r.staffId, name: r.staffName }])).values()];
    render(
      container,
      html`
        ${pageHeader({ title: "Payroll", subtitle: "What to pay each helper for a pay period. It updates by itself from attendance and advances." })}
        <section class="card section" data-section="period">
          <div class="pick-row" data-role="pickers">
            <label class="pick">Employee <select class="select" data-role="pick-staff" aria-label="Employee"><option value="">Everyone</option>${names.map((x) => html`<option value="${x.id}" ${x.id === state.staffId ? "selected" : ""}>${x.name}</option>`)}</select></label>
            <label class="pick">Period <select class="select" data-role="period-select" aria-label="Pay period">${hasMixed ? html`<option value="current" ${mixed ? "selected" : ""}>Now (everyone)</option>` : ""}${state.periods.map((x) => html`<option value="${x.start}_${x.end}" ${!mixed && state.period && x.start === state.period.start && x.end === state.period.end ? "selected" : ""}>${periodName(x)}${x.current ? " (now)" : ""}</option>`)}</select></label>
            ${mayExport(session, "payroll") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("payroll")}` : ""}
          </div>
          ${state.error ? emptyState({ title: "Couldn't load", body: state.error }) : state.loading && !state.period?.start ? skeleton(5) : table()}
        </section>`
    );
    for (const btn of container.querySelectorAll('[data-act="export"]')) btn.classList.add("btn-ghost");
  }

  // ---------- One payroll, as a payslip ----------
  async function openView(id) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    let p = state.rows.find((r) => r.id === id) || null;
    let payrollId = id;
    let link = null; // shown once after paying / a new link
    let thm = null; // this year's 13th month: earned / given / left
    let calc = false; // "View calculation" open
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
    const advanceOf = async (advanceId) => (await data.listAdvances(businessId, { staffId: p.staffId }, { pageSize: 100 })).rows.find((a) => a.id === advanceId);

    const paint = () => {
      if (!p) return render(backdrop, html`<div class="modal"><div class="modal-body">${emptyState({ title: "Payroll not found" })}</div><div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button></div></div>`);
      const draft = p.status === "draft";
      const gap = earlyGap(p);
      const attendanceHref = `/attendance?staff=${encodeURIComponent(p.staffId)}&period=${p.periodStart}`;
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Payroll" data-role="payroll-view">
          <div class="modal-header"><h2 class="card-title">${p.staffName} · ${rowPeriod(p)}</h2></div>
          <div class="modal-body">
            ${p.automatic ? html`<p class="chart-note" data-role="automatic">Worked out automatically from attendance and advances.${today <= p.periodEnd ? ` The period is still ongoing (ends ${short(p.periodEnd)}).` : ""}</p>` : ""}
            ${gap ? html`<p class="chart-note" data-role="early">${badge("Early salary payment", "info")} Paid ${formatCentavos(gap.paid)} on ${short(p.salary.paidDate)}, before the period ended (${short(p.periodEnd)}). ${!gap.diff ? "The final take-home matches what was paid." : gap.diff > 0 ? html`Final take-home is now <strong>${formatCentavos(gap.final)}</strong>: <strong>${formatCentavos(gap.diff)} more</strong> than paid${today > p.periodEnd ? "" : " so far"}.` : html`Final take-home is now <strong>${formatCentavos(gap.final)}</strong>: <strong>${formatCentavos(-gap.diff)} less</strong> than paid${today > p.periodEnd ? "" : " so far"}.`}</p>` : ""}
            <h3 class="slip-head">Earnings</h3>
            <ul class="slip" data-role="earnings">
              <li data-line="basic"><span class="slip-what">Basic pay<small>${p.payableDays} paid days × ${formatCentavos(p.dailyWage)}</small></span><span class="slip-amt">${formatCentavos(p.basePay)}</span><span class="slip-act"><button type="button" class="btn btn-compact btn-ghost" data-x="calc">${calc ? "Hide" : "View calculation"}</button></span></li>
              ${calc ? html`<li class="slip-calc" data-role="calc"><span>${p.present} Present + ${p.officialLeave} Paid Leave = ${p.payableDays} paid days × ${formatCentavos(p.dailyWage)} = ${formatCentavos(p.basePay)}. Not paid: ${p.absent} Absent, ${p.unpaidLeave || 0} Unpaid Leave, ${p.restDay || 0} Rest Day${p.notMarked ? `, ${p.notMarked} not marked` : ""}. <a href="${attendanceHref}" data-link data-x="goto">View attendance</a></span></li>` : ""}
              ${(p.additions || []).map((a) => html`<li data-addition="${a.id}"><span class="slip-what">${a.type === "thirteenth" ? `13th month pay ${a.year}` : a.description}<small>${a.type === "thirteenth" ? "1/12 of the year's basic pay" : "Bonus you added"}</small></span><span class="slip-amt">${formatCentavos(a.amount)}</span><span class="slip-act">${draft && canManage ? lineMenu(`Actions for ${a.description}`, a.type === "bonus" ? [{ x: "edit-line", label: "Edit", data: { id: a.id, kind: "bonus" } }, { x: "remove-add", label: "Delete", danger: true, data: { id: a.id } }] : [{ x: "remove-add", label: "Remove", danger: true, data: { id: a.id } }]) : ""}</span></li>`)}
            </ul>
            <h3 class="slip-head">Deductions</h3>
            <ul class="slip" data-role="deductions">
              ${!(p.deductions || []).length && !(p.notTaken || []).length ? html`<li class="slip-none"><span class="stat-hint">None.</span></li>` : ""}
              ${(p.deductions || []).map((d) =>
                d.type === "advance"
                  ? html`<li data-deduction="${d.id}" data-advance="${d.advanceId}"><span class="slip-what">${d.description}<small>Cash advance · repayment plan</small></span><span class="slip-amt">− ${formatCentavos(d.amount)}</span><span class="slip-act">${draft && canAdvances ? lineMenu(`Actions for ${d.description}`, [{ x: "adv-view", label: "View advance", data: { id: d.advanceId } }, { x: "adv-amount", label: "Edit amount", data: { id: d.advanceId } }, { x: "adv-move", label: "Move to another payroll", data: { id: d.advanceId } }, { x: "adv-off", label: "Remove from this payroll", danger: true, data: { id: d.advanceId } }]) : html`<button type="button" class="btn btn-compact btn-ghost" data-x="adv-view" data-id="${d.advanceId}">View advance</button>`}</span></li>`
                  : html`<li data-deduction="${d.id}"><span class="slip-what">${d.description}<small>Deduction you added</small></span><span class="slip-amt">− ${formatCentavos(d.amount)}</span><span class="slip-act">${draft && canManage ? lineMenu(`Actions for ${d.description}`, [{ x: "edit-line", label: "Edit", data: { id: d.id, kind: "deduction" } }, { x: "remove", label: "Delete", danger: true, data: { id: d.id } }]) : ""}</span></li>`
              )}
              ${(p.notTaken || []).map((n) => html`<li class="slip-missed" data-not-taken="${n.advanceId}"><span class="slip-what">Scheduled deduction not taken<small>${n.description} · still owed${p.status === "released" ? "; the salary paid stays as it was" : ""}</small></span><span class="slip-amt">${formatCentavos(n.amount)}</span><span class="slip-act">${canAdvances ? lineMenu("Actions for the deduction not taken", [{ x: "nt-move", label: "Move to next payroll", data: { id: n.advanceId } }, { x: "nt-repaid", label: "Mark repaid separately", data: { id: n.advanceId, amount: n.amount } }, { x: "adv-view", label: "Edit repayment plan", data: { id: n.advanceId } }]) : ""}</span></li>`)}
            </ul>
            <ul class="slip slip-total"><li><span class="slip-what"><strong>Net pay (take-home)</strong></span><span class="slip-amt"><strong data-role="net">${formatCentavos(p.netPay)}</strong></span><span class="slip-act"></span></li></ul>
            ${thm && thm.remaining > 0 ? html`<p class="stat-hint" data-role="thirteenth">13th month ${thm.year}: ${formatCentavos(thm.remaining)} left to give (1/12 of ${formatCentavos(thm.basicPay)} basic pay, minus ${formatCentavos(thm.onPayrolls)} given).</p>` : ""}
            <dl class="dl dl-compact">
              <dt>Payment</dt><dd data-role="payment">${paymentState(p)[0]}${p.salary ? ` · ${formatCentavos(p.salary.amount)} on ${short(p.salary.paidDate)} by ${SALARY_METHODS[p.salary.method]?.label}${p.salary.reference ? ` · Ref ${p.salary.reference}` : ""}` : ""}${p.salary?.proof ? html` · <button type="button" class="btn-linklike" data-x="view-proof">See proof</button>` : ""}</dd>
              <dt>Received by the helper</dt><dd data-role="receipt">${receivedState(p)[0]}${p.receiptConfirmedVia === "staff-account" ? " (from their Luna account)" : p.receiptConfirmedVia === "employee-link" ? " (from the link)" : ""}</dd>
              ${p.dispute?.state === "open" ? html`<dt>Reported</dt><dd class="text-danger">Not received${p.dispute.note ? `: "${p.dispute.note}"` : ""}</dd>` : ""}
            </dl>
            ${link
              ? html`<div class="card section" data-role="receipt-link"><strong>Send this link to ${p.staffName}</strong>
                  <p class="stat-hint">If they don't use Luna, they tap it to confirm they received ${formatCentavos(p.salary?.amount ?? p.netPay)}. It works once and expires in 14 days.</p>
                  <input class="input" readonly value="${link}" data-role="link-text" />
                  <button type="button" class="btn btn-compact" data-x="copy">Copy link</button></div>`
              : ""}
            ${(p.history || []).length ? html`<details class="form-more"><summary>History</summary><ul class="list activity">${p.history.map((h) => html`<li>${h.label}${h.actor ? ` · ${h.actor.name}` : h.via === "employee-link" ? " · by the helper, via the secure link" : ""}</li>`)}</ul></details>` : ""}
          </div>
          <div class="modal-footer">
            ${draft && canManage ? html`<details class="line-menu line-menu-up"><summary class="btn">Add ▾</summary><div class="line-menu-list" role="menu"><button type="button" class="menu-item" data-x="add-bonus">Bonus</button><button type="button" class="menu-item" data-x="add">Other deduction</button><button type="button" class="menu-item" data-x="add-13th">13th month pay</button>${p.automatic ? "" : html`<button type="button" class="menu-item is-danger" data-x="delete">Reset to automatic</button>`}</div></details>` : ""}
            ${draft && canRelease ? html`<button type="button" class="btn btn-primary" data-x="release">Pay salary</button>` : ""}
            ${!draft && canRelease ? html`<details class="line-menu line-menu-up"><summary class="btn">More ▾</summary><div class="line-menu-list" role="menu">${!p.salary?.proof ? html`<button type="button" class="menu-item" data-x="add-proof">Add payment proof</button>` : ""}<button type="button" class="menu-item" data-x="correct">Correct payment</button>${p.receiptStatus === "awaiting" ? html`<button type="button" class="menu-item" data-x="newlink">New receipt link</button>` : ""}${p.dispute?.state === "open" ? html`<button type="button" class="menu-item" data-x="resolve">Answer "not received"</button>` : ""}</div></details>` : ""}
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
        const r = await formDialog({ title: "Add payment proof", intro: "A GCash or bank screenshot, or a PDF. It doesn't change the payment or the helper's confirmation.", fields: [{ name: "proof", label: "Proof", type: "file", accept: "image/jpeg,image/png,image/webp,application/pdf" }], submitLabel: "Upload", onSubmit: async (v) => { if (!v.proof) throw new Error("Choose a file"); return data.payrollApi({ action: "attachProof", payrollId, proof: await prepareProof(v.proof, { pdf: true }) }); } });
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
        if (await confirmDialog({ title: "Reset this payroll to automatic?", body: "Removes the bonuses and deductions you added here. Attendance and advance plans stay.", confirmLabel: "Reset", danger: true })) {
          if (await run(() => data.payrollApi({ action: "deleteDraft", payrollId }), "Payroll reset to automatic.")) close();
        }
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
        const ongoing = today < p.periodEnd;
        const r = await formDialog({
          title: `${ongoing ? "Early salary payment: " : ""}Pay ${formatCentavos(p.netPay)} to ${p.staffName}`,
          intro: ongoing
            ? `This pay period is still ongoing (ends ${short(p.periodEnd)}). Attendance after the payment date may still change the final salary; Luna shows any difference once the period ends. The helper confirms receiving it separately.`
            : "This locks the period's attendance. The helper then confirms receiving it from their Luna login (or a one-time link).",
          fields: [
            { name: "method", label: "Paid by", type: "select", value: "cash", options: methodOptions() },
            { name: "paidDate", label: "Date paid", type: "date", value: today, max: today },
            { name: "proof", label: "Proof (screenshot or PDF, optional)", type: "file", accept: "image/jpeg,image/png,image/webp,application/pdf" },
            { name: "reference", label: "Reference no. (optional)", more: true },
          ],
          submitLabel: "Mark paid",
          onSubmit: async (v) => {
            const proof = v.proof ? await prepareProof(v.proof, { pdf: true }) : null;
            const payment = { method: v.method, ...(v.reference ? { reference: v.reference } : {}), paidDate: v.paidDate || today };
            const target = p.automatic ? { staffId: p.staffId, periodStart: p.periodStart } : { payrollId };
            return data.payrollApi({ action: "release", ...target, payment, expectedNetPay: p.netPay, ...(proof ? { proof } : {}) });
          },
        });
        if (r) {
          payrollId = r.payrollId || payrollId;
          link = r.receiptToken ? receiptUrl(r.receiptToken) : null;
          toast(r.paymentTiming === "early" ? "Early salary payment recorded. Days after the payment date stay open." : "Salary marked paid.", "success");
          refresh();
        }
      } else if (x === "newlink") run(() => data.payrollApi({ action: "newReceiptLink", payrollId }), "New link ready; the old one no longer works.");
      return undefined;
    });
    paint();
    await refresh();
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
    if (el.dataset.act === "view") openView(el.dataset.id);
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
