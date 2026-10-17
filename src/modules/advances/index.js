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
// filtered to that helper; ?give=1 opens Give an advance (Dashboard).
// Owner-pilot polish (2026-10-16): Give an advance = Helper, Amount, Deduct
// on (Next payroll / Split repayment / No payroll deduction), with what's
// available shown and checked before sending; date (today), method (last
// used, else Cash), reference, proof and note under More options. The
// result shows what's owed now and the next deduction.

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
  let openGive = params.get("give") === "1" && canManage;
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
      if (openGive) {
        openGive = false;
        setTimeout(() => give(), 0);
      }
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

  // Owner-pilot UX (2026-10-17): one card per helper is the whole working
  // area: name, Outstanding / Available / Next deduction, [Give advance]
  // [⋯ More], then that helper's current advances right under it (no
  // separate "Open advances" section). Repaid ones are behind ⋯ More;
  // Voided records sit at the very bottom of the page.
  function helperCard(p) {
    const sum = advanceSummary(p.advances);
    const cap = p.staff && Number.isSafeInteger(p.staff.advanceLimit) ? advanceCapacity(p.staff, p.advances) : null;
    const open = p.advances.filter((a) => a.status === "not_yet_paid" || (a.status === "paid" && advanceRemaining(a) > 0));
    const done = p.advances.filter((a) => a.status === "paid" && advanceRemaining(a) === 0);
    const more = [{ x: "repaid", label: `Repaid advances (${done.length})` }];
    return html`<section class="card section adv-card" data-owe="${p.id}">
      <div class="adv-card-head"><h2 class="card-title">${p.name}</h2>${sum.notTaken ? badge(`${formatCentavos(sum.notTaken)} not taken`, "warning") : ""}</div>
      <dl class="adv-summary">
        <dt>Outstanding</dt><dd data-role="outstanding">${formatCentavos(sum.outstanding)}</dd>
        ${cap ? html`<dt>Available</dt><dd data-role="available">${formatCentavos(cap.available)}</dd>` : ""}
        <dt>Next deduction</dt><dd data-role="next">${sum.next ? html`${formatCentavos(sum.next.amount)} <small>· ${periodText(sum.next)}</small>` : "—"}</dd>
      </dl>
      <div class="adv-card-actions">
        ${canManage && p.staff ? html`<button type="button" class="btn btn-primary" data-act="give" data-staff="${p.id}">Give advance</button>` : ""}
        <details class="line-menu"><summary class="btn" aria-label="More for ${p.name}">⋯ More</summary><div class="line-menu-list" role="menu">${more.map((i) => html`<button type="button" class="menu-item" role="menuitem" data-act="${i.x}" data-staff="${p.id}">${i.label}</button>`)}</div></details>
      </div>
      ${open.length ? html`<ul class="adv-list" data-role="advances">${open.map(advanceRow)}</ul>` : html`<p class="stat-hint" data-role="none-owed">Nothing owed.</p>`}
    </section>`;
  }

  function advanceRow(a) {
    const owed = advanceRemaining(a);
    const repaid = a.status === "paid" && owed === 0;
    const state_ = a.status === "paid" ? (repaid ? badge("Repaid", "success") : a.receipt?.state === "confirmed" ? badge("Confirmed", "success") : badge("Not confirmed", "warning")) : badge(ADVANCE_STATUSES[a.status]?.label ?? a.status, a.status === "requested" ? "warning" : "neutral");
    const items = [{ x: "details", label: "Details" }];
    if (canManage && a.status === "paid" && owed > 0) items.push({ x: "plan", label: "Edit repayment plan" }, { x: "repay", label: "Record a repayment" });
    if (a.status === "paid" && a.proof) items.push({ x: "proof", label: "View proof" });
    if (canManage && a.status === "paid" && !a.proof) items.push({ x: "add-proof", label: "Add proof" });
    if (canManage && a.status === "not_yet_paid") items.push({ x: "release", label: "Mark given" });
    // Destructive last: delete (money never given) or void (given).
    if (canManage && a.status === "paid") items.push({ x: "void", label: "Delete / Void advance", danger: true, sep: true });
    if (canManage && a.status !== "paid") items.push({ x: "delete", label: "Delete advance", danger: true, sep: true });
    const plan = (a.schedule || []).filter((e) => e.state === "planned");
    return html`<li class="adv-row" data-advance="${a.id}">
      <div class="adv-main"><strong>${formatCentavos(a.amount)} · ${short(a.paidDate || a.date)}</strong>
        <small>${a.status === "paid" ? (repaid ? "Fully repaid" : html`${formatCentavos(owed)} owed · ${plan.length ? `Deduct ${plan.map((e) => `${formatCentavos(e.amount)} ${periodText(e)}`).join(" · ")}` : "No deduction planned"}`) : a.status === "not_yet_paid" ? "Approved, not given yet" : a.status === "requested" ? "Asked by the helper" : "Not approved"}${a.description ? ` · ${a.description}` : ""}</small></div>
      <div class="adv-end">${state_}<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="Actions for the ${formatCentavos(a.amount)} advance">⋯</summary><div class="line-menu-list" role="menu">${items.map((i) => html`${i.sep ? html`<div class="menu-sep" role="separator"></div>` : ""}<button type="button" class="menu-item${i.danger ? " is-danger" : ""}" role="menuitem" data-x="${i.x}" data-id="${a.id}">${i.label}</button>`)}</div></details></div>
    </li>`;
  }

  // ⋯ More -> Repaid advances (history, read-only list with each row's ⋯).
  function showRepaid(staffId) {
    const p = people().find((x) => x.id === staffId);
    const done = (p?.advances || []).filter((a) => a.status === "paid" && advanceRemaining(a) === 0);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    render(backdrop, html`<div class="modal" role="dialog" aria-modal="true" aria-label="Repaid advances" data-role="repaid"><div class="modal-header"><h2 class="card-title">${p?.name ?? ""} · Repaid advances</h2></div><div class="modal-body">${done.length ? html`<ul class="adv-list" data-role="advances-repaid">${done.map(advanceRow)}</ul>` : html`<p class="stat-hint">None yet.</p>`}</div><div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button></div></div>`);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop || e.target.closest('[data-x="close"]')) return backdrop.remove();
      const el = e.target.closest("[data-x]");
      const a = el && done.find((x) => x.id === el.dataset.id);
      if (!a) return undefined;
      el.closest("details")?.removeAttribute("open");
      if (el.dataset.x === "proof") viewProof({ title: `Advance proof · ${a.staffName}`, load: async () => (await api({ action: "proof", advanceId: a.id })).proof });
      else details(a);
      return undefined;
    });
  }

  function draw() {
    if (!alive) return;
    const requests = state.rows.filter((a) => a.status === "requested");
    const list = people();
    render(
      container,
      html`
        ${pageHeader({ title: "Advances" })}
        ${canManage && requests.length
          ? html`<section class="card section" data-section="requests"><h2 class="card-title">Asked by your helpers (${requests.length})</h2>
              <ul class="request-list" data-role="advance-requests">${requests.map(
                (a) => html`<li data-advance="${a.id}"><div class="request-main"><strong>${a.staffName}</strong> asks for ${formatCentavos(a.requestedAmount ?? a.amount)}<small>${formatDayId(a.date)}${a.description ? ` · "${a.description}"` : ""}</small></div>
                  <div class="request-actions"><button type="button" class="btn btn-compact" data-act="reject" data-id="${a.id}">Reject</button><button type="button" class="btn btn-compact btn-primary" data-act="approve" data-id="${a.id}">Approve</button></div></li>`
              )}</ul></section>`
          : ""}
        <div class="pick-row page-pickers" data-role="pickers">
          <label class="pick">Employee <select class="select" data-role="pick-staff" aria-label="Employee"><option value="">Everyone</option>${state.staff.map((x) => html`<option value="${x.id}" ${x.id === state.staffId ? "selected" : ""}>${x.name}</option>`)}</select></label>
        </div>
        ${state.error
          ? html`<section class="card section">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : state.loading && !state.rows.length
            ? html`<section class="card section">${skeleton(4)}</section>`
            : list.length
              ? html`<div data-role="summaries">${list.map(helperCard)}</div>`
              : html`<section class="card section">${emptyState({ iconName: "advance", title: "No household staff yet", body: "Add the people you pay on the Household Staff page." })}</section>`}
        <p class="voided-link page-foot"><button type="button" class="btn-linklike" data-act="voided">Voided records ›</button></p>`
    );
    for (const btn of container.querySelectorAll('[data-act="export"]')) btn.classList.add("btn-ghost");
  }

  const METHOD_KEY = "luna.advance.method";
  const lastMethod = () => {
    try {
      const m = localStorage.getItem(METHOD_KEY);
      return SALARY_METHODS[m] ? m : "cash";
    } catch {
      return "cash";
    }
  };
  const availableFor = (s) => (s && Number.isSafeInteger(s.advanceLimit) ? advanceCapacity(s, state.rows.filter((a) => a.staffId === s.id)).available : null);

  async function give(preset = "") {
    if (!state.staff.length) return toast("Add household staff first.", "danger");
    const chosen = preset || state.staffId || state.staff[0].id;
    const first = state.staff.find((s) => s.id === chosen) || state.staff[0];
    const r = await formDialog({
      title: "Give an advance",
      intro: state.staff.length === 1 || preset || state.staffId ? (availableFor(first) !== null ? `Available to advance: ${formatCentavos(availableFor(first))}.` : "") : "",
      fields: [
        { name: "staffId", label: "Helper", type: "select", value: first.id, options: state.staff.map((s) => ({ value: s.id, label: availableFor(s) !== null ? `${s.name} · ${formatCentavos(availableFor(s))} available` : s.name })) },
        { name: "amount", label: "Amount (₱)", required: true, inputmode: "decimal" },
        { name: "plan", label: "Deduct on", type: "select", value: "next", options: [{ value: "next", label: "Next unpaid payroll" }, { value: "split", label: "Split repayment" }, { value: "none", label: "No payroll deduction" }] },
        { name: "date", label: "Date given", type: "date", value: today, max: today, more: true, default: true },
        { name: "method", label: "How", type: "select", value: lastMethod(), options: methodOptions(), more: true },
        { name: "reference", label: "Reference (optional)", more: true },
        { name: "proof", label: "Proof (screenshot or PDF, optional)", type: "file", accept: "image/jpeg,image/png,image/webp,application/pdf", more: true },
        { name: "description", label: "Note (optional)", more: true, placeholder: "e.g. Fare home" },
      ],
      submitLabel: "Give advance",
      moreLabel: "More options",
      onSubmit: async (v) => {
        const s = state.staff.find((x) => x.id === v.staffId);
        const amount = parseCentavos(v.amount);
        const avail = availableFor(s);
        if (avail !== null && amount > avail) throw new Error(`Maximum available is ${formatCentavos(avail)}.`);
        const proof = v.proof ? await prepareProof(v.proof, { pdf: true }) : null;
        const res = await api({ action: "give", advance: { staffId: v.staffId, date: v.date || today, amount, method: v.method, plan: v.plan === "none" || v.plan === "split" ? "none" : "next", ...(v.description?.trim() ? { description: v.description.trim() } : {}), ...(v.reference?.trim() ? { reference: v.reference.trim() } : {}) }, ...(proof ? { proof } : {}) });
        try {
          localStorage.setItem(METHOD_KEY, v.method);
        } catch {
          /* per-device convenience only */
        }
        return { ...res, amount, plan: v.plan, staff: s };
      },
    });
    if (!r) return undefined;
    // Split: the plan editor for this new advance (the money is already recorded).
    let schedule = r.schedule;
    if (r.plan === "split") {
      const planned = await editPlan({ advance: { id: r.advanceId, amount: r.amount, deductedAmount: 0, repaidAmount: 0, status: "paid", schedule: [] }, staff: r.staff, today, api });
      if (planned?.schedule) schedule = planned.schedule;
    }
    await quickResult({ name: r.staffName || r.staff?.name, amount: r.amount, outstanding: r.outstanding, next: (schedule || []).find((e) => e.state === "planned") || null, available: r.available });
    load();
    return undefined;
  }

  // The result at a glance (one tap to close).
  function quickResult({ name, amount, outstanding, next, available }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      document.body.appendChild(backdrop);
      render(
        backdrop,
        html`<div class="modal" role="dialog" aria-modal="true" aria-label="Advance given" data-role="advance-result">
          <div class="modal-header"><h2 class="card-title">${name}</h2></div>
          <div class="modal-body">
            <dl class="adv-result">
              <dt>Advance given</dt><dd>${formatCentavos(amount)}</dd>
              <dt>Outstanding</dt><dd data-role="result-outstanding">${formatCentavos(outstanding ?? amount)}</dd>
              <dt>Next deduction</dt><dd>${next ? html`${formatCentavos(next.amount)} <small>${periodText(next)}</small>` : "None planned"}</dd>
              ${available !== null && available !== undefined ? html`<dt>Still available</dt><dd>${formatCentavos(available)}</dd>` : ""}
            </dl>
            <p class="pay-status">${badge("Waiting for confirmation", "warning")}</p>
          </div>
          <div class="modal-footer"><button type="button" class="btn btn-primary" data-x="close">OK</button></div>
        </div>`
      );
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop || event.target.closest('[data-x="close"]')) {
          backdrop.remove();
          resolve();
        }
      });
    });
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

  async function showVoided() {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const paint = (body) => render(backdrop, html`<div class="modal" role="dialog" aria-modal="true" aria-label="Voided advances" data-role="voided"><div class="modal-header"><h2 class="card-title">Voided advances</h2></div><div class="modal-body">${body}</div><div class="modal-footer"><button type="button" class="btn" data-x="close">Close</button></div></div>`);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop || e.target.closest('[data-x="close"]')) backdrop.remove();
    });
    paint(html`<p class="stat-hint">Loading…</p>`);
    try {
      const { voided } = await api({ action: "voided", ...(state.staffId ? { staffId: state.staffId } : {}) });
      paint(voided.length ? html`<ul class="slip">${voided.map((v) => html`<li><span class="slip-what">${v.staffName} · ${v.date ? short(v.date) : ""}<small>${v.at ? short(v.at.slice(0, 10)) : ""}${v.by ? ` by ${v.by}` : ""} · ${v.reason}</small></span><span class="slip-amt">${formatCentavos(v.amount)}</span><span class="slip-act"></span></li>`)}</ul>` : html`<p class="stat-hint">No voided advances.</p>`);
    } catch (err) {
      paint(html`<p class="form-error">${err.message || "Couldn't load"}</p>`);
    }
  }

  const staffOf = (a) => state.staff.find((s) => s.id === a.staffId) || { payCycle: "semi_monthly" };
  const onClick = async (event) => {
    const el = event.target.closest("[data-act], [data-x]");
    if (!el || !container.contains(el)) return undefined;
    el.closest("details")?.removeAttribute("open");
    const a = state.rows.find((r) => r.id === el.dataset.id);
    const act = el.dataset.act || el.dataset.x;
    try {
      if (act === "give") return give(el.dataset.staff || "");
      if (act === "voided") return showVoided();
      if (act === "repaid") return showRepaid(el.dataset.staff);
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
          armMs: 700, // a money step: only a deliberate press gives it
          onSubmit: async (v) => {
            const proof = v.proof ? await prepareProof(v.proof, { pdf: true }) : null;
            return api({ action: "markPaid", advanceId: a.id, release: { paidDate: v.paidDate || today, method: v.method, ...(v.reference ? { reference: v.reference } : {}) }, ...(proof ? { proof } : {}) });
          },
        });
        if (r) load();
      } else if (act === "delete") {
        if (await confirmDialog({ title: `Delete this ${formatCentavos(a.amount)} advance?`, body: "No money has been released, so this will remove the advance and its planned payroll deductions.", confirmLabel: "Delete advance", danger: true })) {
          await api({ action: "delete", advanceId: a.id });
          toast("Advance deleted.", "success");
          load();
        }
      } else if (act === "void") {
        const activity = (a.repayments || []).length || (a.schedule || []).some((e) => e.state === "applied") || a.receipt?.state === "confirmed";
        const reason = await formDialog({
          title: `Void the ${formatCentavos(a.amount)} advance (${a.staffName})`,
          intro: activity
            ? "This advance already has repayment activity. Voiding it will reverse its related repayments/deductions and preserve the history. A deduction already taken by a paid salary needs that payroll voided first (Luna will say which)."
            : "The money was recorded as given. Voiding cancels what's owed on it and removes its planned payroll deductions. An audit record is kept.",
          fields: [{ name: "reason", label: "Reason", required: true, placeholder: "e.g. Entered twice, Wrong employee" }],
          submitLabel: "Continue",
          onSubmit: (v) => {
            if (v.reason.trim().length < 3) throw new Error("Say why (at least 3 characters)");
            return v.reason.trim();
          },
        });
        if (reason && (await confirmDialog({ title: "Void this advance?", body: `Reason: ${reason}. It leaves the active list; you can still see it under Voided records.`, confirmLabel: "Void advance", danger: true }))) {
          await api({ action: "void", advanceId: a.id, reason });
          toast("Advance voided. Its history is kept under Voided records.", "success");
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
