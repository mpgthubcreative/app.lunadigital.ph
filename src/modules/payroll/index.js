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

  const VIEWS = [["draft", "To pay"], ["awaiting", "Not confirmed"], ["released", "Paid history"], ["", "All"]];
  const EMPTY = {
    draft: ["Nothing to pay right now", "Prepare payroll for a pay period once attendance is marked."],
    awaiting: ["Nothing waiting", "Everyone confirmed receiving their salary."],
    released: ["No paid salaries yet", "Salaries you release appear here with their receipt confirmation."],
    "": ["No payroll yet", "Prepare a payroll for a pay period once attendance is marked."],
  };

  function draw() {
    if (!alive) return;
    const [emptyTitle, emptyBody] = EMPTY[state.status] ?? EMPTY[""];
    render(
      container,
      html`
        ${pageHeader({ title: "Payroll", subtitle: "What each person takes home: basic pay from attendance, plus bonus or 13th month, minus advances and deductions.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="prepare">Prepare payroll</button>` : "" })}
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
    let thm = null; // this year's 13th month: earned / given / left
    const close = () => {
      backdrop.remove();
      load();
    };
    const refresh = async () => {
      p = await data.getPayroll(businessId, payrollId);
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
            <p class="stat-hint">${daysText(p)}${p.notMarked ? ` · ${p.notMarked} not marked (not paid)` : ""} · ${formatCentavos(p.dailyWage)} a day</p>
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
              <dt>Payment</dt><dd data-role="payment">${paymentState(p)[0]}${p.salary ? ` · ${formatDayId(p.salary.paidDate)} by ${SALARY_METHODS[p.salary.method]?.label}${p.salary.reference ? ` · Ref ${p.salary.reference}` : ""}` : ""}${p.salary?.proof ? html` · <button type="button" class="btn-linklike" data-x="view-proof">See proof</button>` : ""}</dd>
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
            ${draft && canManage ? html`<button type="button" class="btn" data-x="add">Add deduction</button><button type="button" class="btn" data-x="add-bonus">Add bonus</button><button type="button" class="btn" data-x="add-13th">Add 13th month pay</button><button type="button" class="btn btn-danger-ghost" data-x="delete">Delete</button>` : ""}
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
        const r = await formDialog({ title: `Add a bonus for ${p.staffName}`, intro: "A bonus is extra pay you choose to give. It's separate from 13th month pay.", fields: [{ name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" }, { name: "description", label: "What for? (optional)", placeholder: "e.g. Christmas bonus" }], submitLabel: "Add bonus", onSubmit: (v) => data.payrollApi({ action: "addAddition", payrollId, addition: { type: "bonus", amount: parseCentavos(v.amount), ...(v.description.trim() ? { description: v.description.trim() } : {}) } }) });
        if (r) refresh();
      } else if (x === "add-13th") {
        const left = thm?.remaining;
        const r = await formDialog({
          title: `Add 13th month pay for ${p.staffName}`,
          intro: thm ? `13th month pay is 1/12 of the basic pay earned in ${thm.year}: ${formatCentavos(thm.entitlement)} so far, ${formatCentavos(thm.onPayrolls)} already given, ${formatCentavos(left)} left. You can give it all now or part of it.` : "13th month pay is 1/12 of the basic pay earned this year. Luna works out how much is left.",
          fields: [{ name: "amount", label: "Amount (₱)", value: left ? String(left / 100) : "", inputmode: "decimal", hint: "Leave as is to give everything that's left." }],
          submitLabel: "Add 13th month pay",
          onSubmit: (v) => data.payrollApi({ action: "addAddition", payrollId, addition: { type: "thirteenth", ...(v.amount.trim() ? { amount: parseCentavos(v.amount) } : {}) } }),
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
        const r = await formDialog({ title: "Add deduction", fields: [{ name: "description", label: "Description", required: true }, { name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" }], onSubmit: (v) => data.payrollApi({ action: "addDeduction", payrollId, deduction: { description: v.description, amount: parseCentavos(v.amount) } }) });
        if (r) refresh();
      } else if (x === "delete") {
        if (await confirmDialog({ title: "Delete this payroll?", body: "Attendance stays; its advances go back to the next payroll.", confirmLabel: "Delete", danger: true })) {
          if (await run(() => data.payrollApi({ action: "deleteDraft", payrollId }), "Payroll deleted.")) close();
        }
      } else if (x === "release") {
        const r = await formDialog({
          title: `Pay ${formatCentavos(p.netPay)} to ${p.staffName}`,
          intro: "This locks the period's attendance. The employee then confirms receiving it (from their Luna login, or a one-time link you send).",
          fields: [
            { name: "method", label: "Paid by", type: "select", value: "cash", options: METHOD_ORDER.filter((k) => SALARY_METHODS[k]).map((value) => ({ value, label: SALARY_METHODS[value].label })) },
            { name: "paidDate", label: "Date paid", type: "date", value: today, max: today },
            { name: "proof", label: "Proof (GCash / bank screenshot, optional)", type: "file", accept: "image/jpeg,image/png,image/webp" },
            { name: "reference", label: "Reference no. (optional)", more: true },
          ],
          submitLabel: "Mark paid",
          onSubmit: async (v) => {
            const proof = v.proof ? await prepareProof(v.proof) : null;
            return data.payrollApi({ action: "release", payrollId, payment: { method: v.method, ...(v.reference ? { reference: v.reference } : {}), paidDate: v.paidDate || today }, ...(proof ? { proof } : {}) });
          },
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
