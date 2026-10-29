// Payroll (Owner-pilot simplification batch; 2026-10-29: the Everyone
// overview, under More): "What does everyone get this cutoff?"
//   Employee ▾ (Everyone by default / one helper)   Period ▾ (Now / a pay period)
// One compact row per helper: paid days, basic pay, advances, bonuses, other
// deductions, prepaid salary (when paid early), net pay, payment, and the
// helper's confirmation. Tap a helper: their payslip for the SAME cutoff
// (./payslip.js: Pay · Payment link · More actions); closing it comes back
// here unchanged. The cutoff is shared with Attendance & Pay and Advances
// (../household/scope.js).
// Payroll is automatic: every pay period appears by itself from Household
// Staff (pay cycle, cutoffs incl. 14 / 29, start / end dates); nobody
// prepares anything. A period nobody touched is worked out by the server
// on the fly (nothing stored); the first real action stores it once. With
// different cutoffs, "Now (everyone)" shows each helper's own current period.
// A paid salary is never edited in place: Correct payroll / payment keeps
// the original and records the reason, who, when, before and after.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos } from "../../lib/format.js";
import { bindExport } from "../../lib/export.js";
import { periodFor, addDays, paidTotal } from "@shared/index.js";
import * as defaultData from "../household/data.js";
import { getScope, setScope } from "../household/scope.js";
import { createPayslips, paymentState, receivedState, periodName, earlyGap, short, rowPeriod, payParts } from "./payslip.js";

export { paymentState, receivedState, periodName, receiptUrl, earlyGap, payParts } from "./payslip.js";

const ID = /^[A-Za-z0-9]{8,40}$/;

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

// What an empty Payroll page shows (examples only: never a payroll, total or export).
const PROOF = "With GCash or a bank transfer, the screenshot you attach shows on the payslip. Paid in cash? Your helper confirms they received it.";
export const PAYROLL_EXAMPLES = Object.freeze([
  { name: "Maria Santos", sub: "Basic pay ₱8,000 · Advance deduction −₱1,000", end: "Net ₱7,000" },
  { name: "Ana Reyes", sub: "Basic pay ₱9,000 · Bonus ₱500", end: "Net ₱9,500" },
]);

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, copy = (t) => navigator.clipboard?.writeText(t) } = {}) {
  const businessId = session.business.id;
  const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const fromUrl = params.get("staff") || "";
  // ?period=<start>_<end> (bell links) opens that pay period; else the cutoff
  // chosen on Attendance & Pay / Advances; else now.
  const periodParam = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(params.get("period") || "");
  const scope = getScope(businessId);
  const state = { staffId: ID.test(fromUrl) ? fromUrl : "", staff: [], people: null, loading: true, error: null, periods: [], period: periodParam ? { start: periodParam[1], end: periodParam[2] } : scope.period, rows: [] };
  let alive = true;
  const payslips = createPayslips({ session, data, toast, now, copy, staff: () => state.staff, rows: () => state.rows, onClose: () => load() });
  const { canRelease } = payslips.flags;

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
      if (state.period && !state.period.mixed) setScope(businessId, { period: state.period });
    } catch (err) {
      console.error("payroll: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load payroll.";
    }
    state.loading = false;
    draw();
  }

  // ⋯ per payroll: View details, Payment link, Correct; Delete (unpaid) / Void (paid) last.
  // An automatic payroll has nothing saved, so Delete explains that instead of doing nothing.
  const rowMenu = (p) => html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="Actions for ${p.staffName}'s payroll">⋯</summary><div class="line-menu-list" role="menu">
      <button type="button" class="menu-item" role="menuitem" data-act="view" data-id="${p.id}">View details</button>
      <button type="button" class="menu-item" role="menuitem" data-act="paylink" data-id="${p.id}">Payment link</button>
      ${canRelease && p.status === "released" && p.salary ? html`<button type="button" class="menu-item" role="menuitem" data-act="correct-any" data-id="${p.id}">Correct payroll / payment</button>` : ""}
      ${payslips.flags.canManage && p.status === "draft" ? html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item is-danger" role="menuitem" data-act="delete-payroll" data-id="${p.id}">Delete payroll</button>` : ""}
      ${canRelease && p.status === "released" ? html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item is-danger" role="menuitem" data-act="void-payroll" data-id="${p.id}">Void payroll</button>` : ""}
    </div></details>`;

  function table() {
    if (!state.period) return html`${examplesState({ title: "No pay periods yet", body: "Each cutoff, Luna works out every helper's pay:", items: PAYROLL_EXAMPLES, helper: `Add household staff with a start date and pay cycle; their pay periods appear here by themselves. ${PROOF}`, role: "payroll-examples", wrap: true })}<p class="ex-add"><a class="btn btn-primary" href="/household-staff" data-link>+ Add staff</a></p>`;
    const mixed = state.period.mixed === true;
    const rows = state.rows;
    const toPay = rows.filter((p) => p.status !== "released").reduce((t, p) => t + Math.max(0, p.netPay), 0);
    // The period's status and the figures that matter (prepaid is part of what was paid).
    const paid = rows.filter((p) => p.status === "released").reduce((t, p) => t + paidTotal(p), 0);
    const prepaid = rows.reduce((t, p) => t + payParts(p).prepaid, 0);
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
          <thead><tr><th class="m-only"></th><th>Employee</th><th class="num col-secondary">Paid days</th><th class="num col-secondary">Basic pay</th><th class="num col-secondary">Advances</th><th class="num col-secondary">Bonuses</th><th class="num col-secondary">Other deductions</th>${prepaid ? html`<th class="num col-secondary">Prepaid</th>` : ""}<th class="num">Net pay</th><th>Payment</th><th>Staff confirmation</th><th><span class="visually-hidden">Details</span></th></tr></thead>
          <tbody>${rows.map((p) => {
            const gap = earlyGap(p);
            const x = payParts(p);
            return html`<tr data-payroll="${p.id}" data-open>
              ${mobileCell({ title: p.staffName, sub: `${mixed ? `${rowPeriod(p)} · ` : ""}${x.paidDays} paid day${x.paidDays === 1 ? "" : "s"} · ${paymentState(p)[0]}${p.status === "released" ? ` · ${receivedState(p)[0]}` : ""}${p.notTaken?.length ? " · deduction not taken" : ""}`, end: formatCentavos(p.netPay), endSub: gap && gap.diff ? `paid ${formatCentavos(gap.paid)}` : p.status === "released" ? "paid" : "to pay" })}
              <td class="cell-strong">${p.staffName}${mixed ? html`<span class="cell-sub">${rowPeriod(p)}</span>` : ""}</td>
              <td class="num col-secondary" data-col="days">${x.paidDays}${p.notMarked ? html` <span class="stat-hint">(${p.notMarked} not marked)</span>` : ""}</td>
              <td class="num col-secondary">${formatCentavos(x.basic)}</td>
              <td class="num col-secondary" data-col="advances">${x.advances ? `− ${formatCentavos(x.advances)}` : "—"}</td>
              <td class="num col-secondary" data-col="bonuses">${x.bonuses ? formatCentavos(x.bonuses) : "—"}</td>
              <td class="num col-secondary" data-col="other">${x.other ? `− ${formatCentavos(x.other)}` : "—"}</td>
              ${prepaid ? html`<td class="num col-secondary" data-col="prepaid">${x.prepaid ? formatCentavos(x.prepaid) : "—"}</td>` : ""}
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
    const act = el.dataset.act;
    if (act === "view") payslips.openView(el.dataset.id);
    else if (act === "pay") payslips.openView(el.dataset.id, "release");
    else if (act === "correct-any") payslips.openView(el.dataset.id, "correct-any");
    else if (act === "paylink" && p) payslips.paymentLink(p);
    else if (act === "delete-payroll" && p) payslips.deletePayroll(p).then((ok) => ok && load());
    else if (act === "void-payroll" && p) payslips.voidPaid(p).then((ok) => ok && load());
    else if (act === "voided") payslips.showVoided(state.staffId);
  };
  const onChange = (event) => {
    if (event.target.dataset.role === "period-select") choosePeriod(event.target.value);
    if (event.target.dataset.role === "pick-staff") {
      // Same cutoff for the helper (the server falls back to their own
      // current period when it isn't one of theirs).
      state.staffId = event.target.value;
      if (state.period?.mixed) state.period = null;
      setScope(businessId, { staffId: state.staffId });
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
