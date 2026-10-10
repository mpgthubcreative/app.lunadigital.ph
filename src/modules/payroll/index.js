// Payroll = Work (Phase 18.5): "How much should each person receive?"
// One compact row per person per pay period, opened on "To pay"; "Paid
// history" (released, with receipt confirmations) is the same list
// filtered to Paid, so the Household story Attendance → Payroll →
// Advances → History needs no extra module.
//   Employee | Period | Daily wage | P / L / A | Payable days | Base pay |
//   Deductions | Net pay | Salary | Receipt | View
// Everything is computed by the server from attendance and advances. Paid
// (released) and receipt confirmed are separate: releasing gives a one-time
// link the employee opens to confirm they received the money.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, segmented, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { PAYROLL_STATUSES, RECEIPT_STATUSES, SALARY_METHODS, PAY_CYCLES, businessDate, periodFor, addDays, parseCentavos } from "@shared/index.js";
import * as defaultData from "../household/data.js";

const RECEIPT_TONE = { none: "neutral", awaiting: "warning", confirmed: "success" };
const period = (p) => `${formatDayId(p.periodStart)} – ${formatDayId(p.periodEnd)}`;
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

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, copy = (t) => navigator.clipboard?.writeText(t) } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["payroll.manage"] === true;
  const canRelease = perms["payroll.release"] === true;
  const businessId = session.business.id;
  const today = businessDate(session.business.timezone, now());
  const state = { staffId: "", status: "draft", from: "", to: "", cursors: [], rows: [], hasMore: false, staff: [], loading: true, error: null };
  let alive = true;
  // "awaiting" = paid, receipt not yet confirmed.
  const filters = () => Object.fromEntries(Object.entries({ staffId: state.staffId, status: state.status === "awaiting" ? "" : state.status, receiptStatus: state.status === "awaiting" ? "awaiting" : "", from: state.from, to: state.to }).filter(([, v]) => v));

  async function load() {
    state.loading = true;
    draw();
    try {
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

  const VIEWS = [["draft", "To pay"], ["awaiting", "Awaiting receipt"], ["released", "Paid history"], ["", "All"]];
  const EMPTY = {
    draft: ["Nothing to pay right now", "Prepare payroll for a pay period once attendance is marked."],
    awaiting: ["No receipts waiting", "Every released salary has been confirmed by the person who received it."],
    released: ["No paid salaries yet", "Salaries you release appear here with their receipt confirmation."],
    "": ["No payroll yet", "Prepare a payroll for a pay period once attendance is marked."],
  };

  function draw() {
    if (!alive) return;
    const [emptyTitle, emptyBody] = EMPTY[state.status] ?? EMPTY[""];
    render(
      container,
      html`
        ${pageHeader({ title: "Payroll", subtitle: "What each person should receive: worked out from attendance, with paid advances deducted in full.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="prepare">Prepare payroll</button>` : "" })}
        <div class="toolbar">${segmented("status", VIEWS, state.status, { label: "Show" })}</div>
        ${filterBar({
          fields: [
            { name: "staffId", label: "Employee", type: "select", primary: true, all: "All employees", options: state.staff.map((x) => [x.id, x.name]), value: state.staffId },
            { name: "from", label: "Periods from", type: "date", value: state.from },
            { name: "to", label: "Periods to", type: "date", value: state.to },
          ],
          end: html`<input type="hidden" name="status" value="${state.status}" />${mayExport(session, "payroll") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("payroll")}` : ""}`,
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "payroll", title: emptyTitle, body: emptyBody })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="payrolls">
                    <thead><tr><th class="m-only"></th><th>Employee</th><th>Period</th><th class="num col-secondary">Daily wage</th><th class="col-secondary">P / L / A</th><th class="num">Payable days</th><th class="num col-secondary">Base pay</th><th class="num col-secondary">Deductions</th><th class="num">Net pay</th><th>Salary</th><th>Receipt</th><th><span class="visually-hidden">Details</span></th></tr></thead>
                    <tbody>${state.rows.map(
                      (p) => html`<tr data-payroll="${p.id}" data-open>
                        ${mobileCell({ title: p.staffName, sub: `${period(p)} · ${p.present} / ${p.officialLeave} / ${p.absent} P/L/A`, end: formatCentavos(p.netPay), endSub: p.status === "released" ? (RECEIPT_STATUSES[p.receiptStatus]?.label ?? "Paid") : "to pay" })}
                        <td class="cell-strong">${p.staffName}</td><td>${period(p)}</td><td class="num col-secondary">${formatCentavos(p.dailyWage)}</td>
                        <td class="col-secondary">${p.present} / ${p.officialLeave} / ${p.absent}${p.notMarked ? html` <span class="stat-hint">(${p.notMarked} not marked)</span>` : ""}</td>
                        <td class="num">${p.payableDays}</td><td class="num col-secondary">${formatCentavos(p.basePay)}</td><td class="num col-secondary">${formatCentavos(p.deductionsTotal)}</td>
                        <td class="num"><strong>${formatCentavos(p.netPay)}</strong></td>
                        <td>${badge(PAYROLL_STATUSES[p.status]?.label ?? p.status, p.status === "released" ? "success" : "warning")}</td>
                        <td>${badge(RECEIPT_STATUSES[p.receiptStatus]?.label ?? "—", RECEIPT_TONE[p.receiptStatus] || "neutral")}</td>
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

  async function prepare() {
    if (!state.staff.length) return toast("Add household staff first.", "danger");
    const first = state.staff[0];
    const options = (s) => recentPeriods(s.payCycle, today).map((p) => ({ value: p.start, label: `${formatDayId(p.start)} – ${formatDayId(p.end)}${p.start <= today && p.end >= today ? " (current)" : ""}` }));
    const r = await formDialog({
      title: "Prepare payroll",
      intro: `Pay periods follow each person's pay cycle (${first.name}: ${PAY_CYCLES[first.payCycle]?.label}). Paid advances are deducted automatically.`,
      fields: [
        { name: "staffId", label: "Employee", type: "select", value: first.id, options: state.staff.map((s) => ({ value: s.id, label: `${s.name} · ${PAY_CYCLES[s.payCycle]?.label}` })) },
        { name: "periodStart", label: "Pay period", type: "select", value: options(first)[1]?.value ?? options(first)[0].value, options: [...new Map(state.staff.flatMap(options).map((o) => [o.value, o])).values()].sort((a, b) => (a.value < b.value ? 1 : -1)), hint: "Only periods that match the employee's cycle are accepted." },
      ],
      submitLabel: "Prepare",
      onSubmit: (v) => data.payrollApi({ action: "prepare", staffId: v.staffId, periodStart: v.periodStart }),
    });
    if (r) {
      toast(r.existing ? "That payroll already exists." : "Payroll prepared.", "success");
      await load();
      openView(r.payrollId);
    }
  }

  async function openView(payrollId) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    let p = null;
    let link = null; // shown once after release / new link
    const close = () => {
      backdrop.remove();
      load();
    };
    const refresh = async () => {
      p = await data.getPayroll(businessId, payrollId);
      paint();
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
    const paint = () => {
      if (!p) return render(backdrop, html`<div class="modal"><div class="modal-body">${emptyState({ title: "Payroll not found" })}</div><div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button></div></div>`);
      const draft = p.status === "draft";
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Payroll" data-role="payroll-view">
          <div class="modal-header"><h2 class="card-title">${p.staffName} · ${period(p)}</h2></div>
          <div class="modal-body">
            <dl class="dl dl-compact">
              <dt>Daily wage</dt><dd>${formatCentavos(p.dailyWage)}</dd>
              <dt>Present / Official Leave / Absent</dt><dd>${p.present} / ${p.officialLeave} / ${p.absent}${p.notMarked ? ` (${p.notMarked} not marked, not paid)` : ""}</dd>
              <dt>Payable days</dt><dd>${p.payableDays}</dd>
              <dt>Base pay</dt><dd>${formatCentavos(p.basePay)}</dd>
              <dt>Deductions</dt><dd>${formatCentavos(p.deductionsTotal)}</dd>
              <dt>Net pay</dt><dd><strong data-role="net">${formatCentavos(p.netPay)}</strong></dd>
              <dt>Salary</dt><dd>${PAYROLL_STATUSES[p.status]?.label}${p.salary ? ` · ${formatDayId(p.salary.paidDate)} via ${SALARY_METHODS[p.salary.method]?.label}${p.salary.reference ? ` · Ref ${p.salary.reference}` : ""}` : ""}</dd>
              <dt>Receipt</dt><dd data-role="receipt">${RECEIPT_STATUSES[p.receiptStatus]?.label ?? "—"}</dd>
            </dl>
            <h3 class="section-title">Deductions</h3>
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
            ${draft && canManage ? html`<button type="button" class="btn" data-x="add">Add deduction</button><button type="button" class="btn btn-danger" data-x="delete">Delete</button>` : ""}
            ${draft && canRelease ? html`<button type="button" class="btn btn-primary" data-x="release">Pay salary</button>` : ""}
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
      else if (x === "defer") run(() => data.payrollApi({ action: "deferAdvance", payrollId, advanceId: el.dataset.id }), "Moved to the next payroll.");
      else if (x === "add") {
        const r = await formDialog({ title: "Add deduction", fields: [{ name: "description", label: "Description", required: true }, { name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" }], onSubmit: (v) => data.payrollApi({ action: "addDeduction", payrollId, deduction: { description: v.description, amount: parseCentavos(v.amount) } }) });
        if (r) refresh();
      } else if (x === "delete") {
        if (await confirmDialog({ title: "Delete this payroll?", body: "Attendance stays; its advances go back to the next payroll.", confirmLabel: "Delete", danger: true })) {
          if (await run(() => data.payrollApi({ action: "deleteDraft", payrollId }), "Payroll deleted.")) close();
        }
      } else if (x === "release") {
        const r = await formDialog({
          title: `Pay ${formatCentavos(p.netPay)} to ${p.staffName}`,
          intro: "This locks the period's attendance. Luna then gives you a one-time link for the employee to confirm receipt.",
          fields: [
            { name: "method", label: "Paid via", type: "select", value: "cash", options: Object.entries(SALARY_METHODS).map(([value, m]) => ({ value, label: m.label })) },
            { name: "reference", label: "Reference (optional)" },
            { name: "paidDate", label: "Paid date", type: "date", value: today, max: today },
          ],
          submitLabel: "Mark paid",
          onSubmit: (v) => data.payrollApi({ action: "release", payrollId, payment: { method: v.method, ...(v.reference ? { reference: v.reference } : {}), paidDate: v.paidDate || today } }),
        });
        if (r) {
          link = receiptUrl(r.receiptToken);
          toast("Salary marked paid.", "success");
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
    if (a === "prepare") prepare();
    else if (a === "seg" && el.dataset.seg === "status") {
      state.status = el.dataset.value;
      state.cursors = [];
      load();
    }
    else if (a === "view") openView(el.dataset.id);
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
    Object.assign(state, { staffId: f.staffId.value, status: f.status.value, from: f.from.value, to: f.to.value, cursors: [] });
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, filters, { toast, deps: exportDeps });
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
    unbindExport();
    unbindFilters();
    unbindRows();
  };
}
