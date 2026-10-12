// Advances (Owner-pilot simplification batch): "How much does this helper
// owe now, and when will it be repaid?"
//   Employee ▾ (Everyone / one helper)
//   per helper: Outstanding · Next planned deduction · Balance after planned
//               (and Limit / Available when a limit is set)
//   one row per advance: amount, what's owed, its repayment plan, whether
//   the helper confirmed receiving it; ⋯ Edit repayment plan / Record a
//   repayment / Proof / Details
// The Owner gives an advance directly ("Give an advance": released now,
// optional GCash / bank proof); the helper confirms receiving it from their
// own screen. Advance -> outstanding balance -> repayment plan -> actual
// repayment: a plan never lowers what's owed; only a paid payroll's
// deduction or a separate repayment does. Requests a helper sent (older
// flow) still show in a compact list. ?staff=<id> / ?advance=<id> open
// filtered to that helper.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { ADVANCE_STATUSES, SALARY_METHODS, SCHEDULE_STATES, businessDate, parseCentavos, advanceRemaining, advanceCapacity, advanceSummary } from "@shared/index.js";
import * as defaultData from "../household/data.js";
import { prepareProof } from "../../lib/image.js";
import { viewProof } from "../../components/proof-viewer.js";
import { editPlan, repay, periodText, methodOptions } from "./plan.js";

const ID = /^[A-Za-z0-9]{8,40}$/;
const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");
const planText = (a) => {
  const open = (a.schedule || []).filter((e) => e.state === "planned");
  return open.length ? open.map((e) => `${formatCentavos(e.amount)} ${periodText(e)}`).join(" · ") : "No deduction planned";
};

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const canManage = session.member.permissions["advances.manage"] === true;
  const businessId = session.business.id;
  const today = businessDate(session.business.timezone, now());
  const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  let fromAdvance = ID.test(params.get("advance") || "") ? params.get("advance") : null;
  const state = { staffId: ID.test(params.get("staff") || "") ? params.get("staff") : "", staff: [], rows: [], loading: true, error: null };
  let alive = true;
  const api = (body) => data.advancesApi(body);

  async function load() {
    state.loading = true;
    draw();
    try {
      if (!state.staff.length) state.staff = await data.activeStaff(businessId);
      const all = (await data.listAdvances(businessId, state.staffId ? { staffId: state.staffId } : {}, { pageSize: 200 })).rows;
      if (fromAdvance) {
        const hit = all.find((r) => r.id === fromAdvance);
        fromAdvance = null;
        if (hit && hit.staffId !== state.staffId) {
          state.staffId = hit.staffId;
          return load();
        }
      }
      state.rows = all;
      state.error = null;
    } catch (err) {
      console.error("advances: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load advances.";
    }
    state.loading = false;
    draw();
    return undefined;
  }

  const people = () => {
    const ids = state.staffId ? [state.staffId] : [...new Set([...state.staff.map((s) => s.id), ...state.rows.filter((a) => a.status === "paid" && advanceRemaining(a) > 0).map((a) => a.staffId)])];
    return ids.map((id) => ({ id, staff: state.staff.find((s) => s.id === id), name: state.staff.find((s) => s.id === id)?.name ?? state.rows.find((a) => a.staffId === id)?.staffName ?? "Staff", advances: state.rows.filter((a) => a.staffId === id) }));
  };

  function summaryCard(p) {
    const sum = advanceSummary(p.advances);
    const cap = p.staff && Number.isSafeInteger(p.staff.advanceLimit) ? advanceCapacity(p.staff, p.advances) : null;
    if (!sum.outstanding && !cap && !state.staffId) return "";
    return html`<div class="owe-card" data-owe="${p.id}">
      <div class="owe-name"><strong>${p.name}</strong>${sum.notTaken ? html` ${badge(`${formatCentavos(sum.notTaken)} not taken`, "warning")}` : ""}</div>
      <dl class="owe-figures">
        <dt>Outstanding balance</dt><dd data-role="outstanding">${formatCentavos(sum.outstanding)}</dd>
        <dt>Next planned deduction</dt><dd>${sum.next ? html`${formatCentavos(sum.next.amount)} <small>${periodText(sum.next)}</small>` : "—"}</dd>
        <dt>Balance after planned</dt><dd>${formatCentavos(sum.balanceAfterPlanned)}</dd>
        ${cap ? html`<dt>Limit · available</dt><dd>${formatCentavos(cap.limit)} · <strong>${formatCentavos(cap.available)}</strong></dd>` : ""}
      </dl>
    </div>`;
  }

  function advanceRow(a) {
    const owed = advanceRemaining(a);
    const repaid = a.status === "paid" && owed === 0;
    const state_ = a.status === "paid" ? (repaid ? badge("Repaid", "success") : a.receipt?.state === "confirmed" ? badge("Received", "success") : badge("Not confirmed", "warning")) : badge(ADVANCE_STATUSES[a.status]?.label ?? a.status, a.status === "requested" ? "warning" : "neutral");
    const items = [{ x: "details", label: "Details" }];
    if (canManage && a.status === "paid" && owed > 0) items.push({ x: "plan", label: "Edit repayment plan" }, { x: "repay", label: "Record a repayment" });
    if (a.status === "paid" && a.proof) items.push({ x: "proof", label: "View proof" });
    if (canManage && a.status === "paid" && !a.proof) items.push({ x: "add-proof", label: "Add proof" });
    if (canManage && a.status === "not_yet_paid") items.push({ x: "release", label: "Mark given" }, { x: "delete", label: "Delete", danger: true });
    return html`<li class="adv-row" data-advance="${a.id}">
      <div class="adv-main"><strong>${formatCentavos(a.amount)}</strong> ${state.staffId ? "" : html`· ${a.staffName} `}<small>${short(a.paidDate || a.date)}${a.description ? ` · ${a.description}` : ""}</small>
        <small>${a.status === "paid" ? (repaid ? "Fully repaid" : html`<strong>${formatCentavos(owed)} owed</strong> · ${planText(a)}`) : a.status === "not_yet_paid" ? "Approved, not given yet" : a.status === "requested" ? "Asked by the helper" : "Not approved"}</small></div>
      <div class="adv-end">${state_}<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="Actions for the ${formatCentavos(a.amount)} advance">⋯</summary><div class="line-menu-list" role="menu">${items.map((i) => html`<button type="button" class="menu-item${i.danger ? " is-danger" : ""}" role="menuitem" data-x="${i.x}" data-id="${a.id}">${i.label}</button>`)}</div></details></div>
    </li>`;
  }

  function draw() {
    if (!alive) return;
    const requests = state.rows.filter((a) => a.status === "requested");
    const open = state.rows.filter((a) => a.status === "not_yet_paid" || (a.status === "paid" && advanceRemaining(a) > 0));
    const done = state.rows.filter((a) => a.status === "paid" && advanceRemaining(a) === 0);
    render(
      container,
      html`
        ${pageHeader({ title: "Advances", subtitle: "What each helper owes, and when it will be taken from salary.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="give">Give an advance</button>` : "" })}
        ${canManage && requests.length
          ? html`<section class="card section" data-section="requests"><h2 class="card-title">Asked by your helpers (${requests.length})</h2>
              <ul class="request-list" data-role="advance-requests">${requests.map(
                (a) => html`<li data-advance="${a.id}"><div class="request-main"><strong>${a.staffName}</strong> asks for ${formatCentavos(a.requestedAmount ?? a.amount)}<small>${formatDayId(a.date)}${a.description ? ` · "${a.description}"` : ""}</small></div>
                  <div class="request-actions"><button type="button" class="btn btn-compact" data-act="reject" data-id="${a.id}">Reject</button><button type="button" class="btn btn-compact btn-primary" data-act="approve" data-id="${a.id}">Approve</button></div></li>`
              )}</ul></section>`
          : ""}
        <section class="card section" data-section="owed">
          <div class="pick-row" data-role="pickers">
            <label class="pick">Employee <select class="select" data-role="pick-staff" aria-label="Employee"><option value="">Everyone</option>${state.staff.map((x) => html`<option value="${x.id}" ${x.id === state.staffId ? "selected" : ""}>${x.name}</option>`)}</select></label>
            ${mayExport(session, "advances") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("advances")}` : ""}
          </div>
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading && !state.rows.length
              ? skeleton(4)
              : html`<div class="owe-cards" data-role="summaries">${people().map(summaryCard)}</div>
                ${!open.length && !done.length
                  ? emptyState({ iconName: "advance", title: "No advances", body: "Advances you give appear here with what's still owed." })
                  : html`<h3 class="slip-head">Open advances</h3>
                    ${open.length ? html`<ul class="adv-list" data-role="advances">${open.map(advanceRow)}</ul>` : html`<p class="stat-hint">Nothing owed right now.</p>`}
                    ${done.length ? html`<details class="form-more"><summary>Repaid (${done.length})</summary><ul class="adv-list" data-role="advances-repaid">${done.map(advanceRow)}</ul></details>` : ""}`}`}
        </section>`
    );
    for (const btn of container.querySelectorAll('[data-act="export"]')) btn.classList.add("btn-ghost");
  }

  async function give() {
    if (!state.staff.length) return toast("Add household staff first.", "danger");
    const limits = state.staff.filter((s) => Number.isSafeInteger(s.advanceLimit)).map((s) => `${s.name}: ${formatCentavos(advanceCapacity(s, state.rows.filter((a) => a.staffId === s.id)).available ?? 0)} available`);
    const r = await formDialog({
      title: "Give an advance",
      intro: `It's taken from the next payroll that isn't paid yet; you can change the plan after.${limits.length && !state.staffId ? ` ${limits.join(" · ")}.` : ""}`,
      fields: [
        { name: "staffId", label: "Helper", type: "select", value: state.staffId || state.staff[0].id, options: state.staff.map((s) => ({ value: s.id, label: s.name })) },
        { name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" },
        { name: "date", label: "Date given", type: "date", value: today, max: today },
        { name: "method", label: "How", type: "select", value: "cash", options: methodOptions() },
        { name: "proof", label: "Proof (screenshot or PDF, optional)", type: "file", accept: "image/jpeg,image/png,image/webp,application/pdf" },
        { name: "description", label: "What for (optional)", more: true, placeholder: "e.g. Fare home" },
        { name: "installment", label: "Take from each payroll (₱, optional)", more: true, inputmode: "decimal", hint: "Blank = all of it from the next payroll." },
        { name: "reference", label: "Reference (optional)", more: true },
      ],
      submitLabel: "Give advance",
      onSubmit: async (v) => {
        const proof = v.proof ? await prepareProof(v.proof, { pdf: true }) : null;
        const inst = String(v.installment || "").trim() ? parseCentavos(v.installment) : null;
        return api({ action: "give", advance: { staffId: v.staffId, date: v.date || today, amount: parseCentavos(v.amount), method: v.method, ...(v.description?.trim() ? { description: v.description.trim() } : {}), ...(inst ? { installment: inst } : {}), ...(v.reference?.trim() ? { reference: v.reference.trim() } : {}) }, ...(proof ? { proof } : {}) });
      },
    });
    if (r) {
      toast(`Advance given. Deduct ${r.schedule.map((e) => `${formatCentavos(e.amount)} ${periodText(e)}`).join(", ")}.`, "success");
      load();
    }
    return undefined;
  }

  async function details(a) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    render(
      backdrop,
      html`<div class="modal" role="dialog" aria-modal="true" aria-label="Advance" data-role="advance-view">
        <div class="modal-header"><h2 class="card-title">${a.staffName} · ${formatCentavos(a.amount)}</h2></div>
        <div class="modal-body">
          <dl class="dl dl-compact">
            <dt>Given</dt><dd>${a.paidDate ? `${formatDayId(a.paidDate)} by ${SALARY_METHODS[a.method]?.label ?? a.method}${a.reference ? ` · Ref ${a.reference}` : ""}` : "Not yet"}</dd>
            ${a.description ? html`<dt>What for</dt><dd>${a.description}</dd>` : ""}
            <dt>Still owed</dt><dd><strong>${formatCentavos(a.status === "paid" ? advanceRemaining(a) : 0)}</strong></dd>
            <dt>Helper confirmed</dt><dd>${a.receipt?.state === "confirmed" ? "Yes, received" : a.status === "paid" ? "Not yet" : "—"}</dd>
          </dl>
          ${(a.schedule || []).length ? html`<h3 class="slip-head">Repayment plan</h3><ul class="slip">${a.schedule.map((e) => html`<li><span class="slip-what">${periodText(e)}<small>${SCHEDULE_STATES[e.state]?.label ?? e.state}</small></span><span class="slip-amt">${formatCentavos(e.amount)}</span><span class="slip-act"></span></li>`)}</ul>` : ""}
          ${(a.repayments || []).length ? html`<h3 class="slip-head">Repaid separately</h3><ul class="slip">${a.repayments.map((r) => html`<li><span class="slip-what">${short(r.date)} · ${SALARY_METHODS[r.method]?.label ?? r.method}${r.note ? html`<small>${r.note}</small>` : ""}</span><span class="slip-amt">${formatCentavos(r.amount)}</span><span class="slip-act"></span></li>`)}</ul>` : ""}
          <details class="form-more"><summary>History</summary><ul class="list activity">${(a.history || []).map((h) => html`<li>${h.label}${h.actor ? ` · ${h.actor.name}` : ""}</li>`)}</ul></details>
        </div>
        <div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button></div>
      </div>`
    );
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop || event.target.closest('[data-x="close"]')) backdrop.remove();
    });
  }

  const staffOf = (a) => state.staff.find((s) => s.id === a.staffId) || { payCycle: "semi_monthly" };
  const onClick = async (event) => {
    const el = event.target.closest("[data-act], [data-x]");
    if (!el || !container.contains(el)) return undefined;
    el.closest("details")?.removeAttribute("open");
    const a = state.rows.find((r) => r.id === el.dataset.id);
    const act = el.dataset.act || el.dataset.x;
    try {
      if (act === "give") return give();
      if (!a) return undefined;
      if (act === "details") return details(a);
      if (act === "plan") {
        if (await editPlan({ advance: a, staff: staffOf(a), today, api })) {
          toast("Repayment plan saved. What's owed didn't change.", "success");
          load();
        }
      } else if (act === "repay") {
        if (await repay({ advance: a, today, api })) {
          toast("Repayment recorded.", "success");
          load();
        }
      } else if (act === "proof") viewProof({ title: `Advance proof · ${a.staffName}`, load: async () => (await api({ action: "proof", advanceId: a.id })).proof });
      else if (act === "add-proof") {
        const r = await formDialog({ title: "Add proof", intro: "A GCash or bank screenshot, or a PDF. The helper can see it on their own screen.", fields: [{ name: "proof", label: "Proof", type: "file", accept: "image/jpeg,image/png,image/webp,application/pdf" }], submitLabel: "Upload", onSubmit: async (v) => { if (!v.proof) throw new Error("Choose a file"); return api({ action: "attachProof", advanceId: a.id, proof: await prepareProof(v.proof, { pdf: true }) }); } });
        if (r) load();
      } else if (act === "release") {
        const r = await formDialog({
          title: `Give ${formatCentavos(a.amount)} to ${a.staffName}`,
          intro: "Taken from the next payroll that isn't paid yet; you can change the plan after.",
          fields: [
            { name: "paidDate", label: "Date given", type: "date", value: today, max: today },
            { name: "method", label: "How", type: "select", value: "cash", options: methodOptions() },
            { name: "proof", label: "Proof (optional)", type: "file", accept: "image/jpeg,image/png,image/webp,application/pdf" },
            { name: "reference", label: "Reference (optional)", more: true },
          ],
          submitLabel: "Mark given",
          onSubmit: async (v) => {
            const proof = v.proof ? await prepareProof(v.proof, { pdf: true }) : null;
            return api({ action: "markPaid", advanceId: a.id, release: { paidDate: v.paidDate || today, method: v.method, ...(v.reference ? { reference: v.reference } : {}) }, ...(proof ? { proof } : {}) });
          },
        });
        if (r) load();
      } else if (act === "delete") {
        if (await confirmDialog({ title: "Delete this advance?", body: "Only an advance not given yet can be deleted.", confirmLabel: "Delete", danger: true })) {
          await api({ action: "delete", advanceId: a.id });
          load();
        }
      } else if (act === "approve") {
        const asked = a.requestedAmount ?? a.amount;
        const person = state.staff.find((s) => s.id === a.staffId);
        const cap = person && Number.isSafeInteger(person.advanceLimit) ? advanceCapacity(person, state.rows.filter((x) => x.staffId === a.staffId), { exclude: a.id }) : null;
        const r = await formDialog({
          title: `Approve ${a.staffName}'s advance`,
          intro: `${a.staffName} asked for ${formatCentavos(asked)}${a.description ? ` (${a.description})` : ""}. ${cap ? `Limit ${formatCentavos(cap.limit)} · outstanding ${formatCentavos(cap.outstanding)} · available ${formatCentavos(cap.available)}. ` : ""}Approving doesn't move money: mark it given when you hand it over.`,
          fields: [
            { name: "amount", label: "Approved amount (₱)", value: String(asked / 100), inputmode: "decimal", required: true },
            { name: "installment", label: "Take from each payroll (₱, optional)", inputmode: "decimal", hint: "Leave blank to take it all from the next payroll." },
            { name: "note", label: "Message to them (optional)" },
          ],
          submitLabel: "Approve",
          onSubmit: (v) => api({ action: "decide", advanceId: a.id, decision: { decision: "approve", ...(v.note.trim() ? { note: v.note.trim() } : {}) }, approval: { amount: parseCentavos(v.amount), ...(String(v.installment || "").trim() ? { installment: parseCentavos(v.installment) } : {}) } }),
        });
        if (r) {
          toast("Approved. Mark it given when you hand over the money.", "success");
          load();
        }
      } else if (act === "reject") {
        const r = await formDialog({ title: `Reject ${a.staffName}'s request?`, fields: [{ name: "note", label: "Message to them (optional)", placeholder: "e.g. Next month" }], submitLabel: "Reject", onSubmit: (v) => api({ action: "decide", advanceId: a.id, decision: { decision: "reject", ...(v.note.trim() ? { note: v.note.trim() } : {}) } }) });
        if (r) {
          toast("Request rejected.", "success");
          load();
        }
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
    return undefined;
  };
  const onChange = (event) => {
    if (event.target.dataset.role !== "pick-staff") return;
    state.staffId = event.target.value;
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  const unbindExport = bindExport(container, () => (state.staffId ? { staffId: state.staffId } : {}), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    unbindExport();
  };
}
