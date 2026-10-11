// Household staff screen (Phase 18.6): a kasambahay's own simple Luna. No
// menu, no tables: one screen with big buttons.
//
//   Today          "I'm here today" (Present) and the other day types
//   My attendance  a pay period, one row per date: choose each day's status
//                  (or select days and mark them together), review, submit
//                  all at once. Approved days are read-only.
//   Ask            Leave / rest day ahead · Cash advance
//   My salary      this pay period so far, past salaries, "I received it"
//   My requests    what's waiting, approved or not approved
//   My advances    what's left to repay
// Owner-pilot batch: the cash advance limit the employer set (Limit,
// Outstanding, Available); a request above what's available is stopped
// here and refused by the server too.
//
// Everything comes from /api/me (their OWN record only). Nothing they send
// changes pay until their employer approves it; the screen says so.

import { html, render } from "../lib/html.js";
import { api as defaultApi } from "../lib/api.js";
import { formatCentavos, formatDayId } from "../lib/format.js";
import { lunaMark } from "../components/icons.js";
import { ATTENDANCE_STATUSES, parseCentavos } from "@shared/index.js";

const DAY_TYPES = ["present", "official_leave", "unpaid_leave", "rest_day", "absent"];
const STATE_LABEL = { pending: "Waiting", approved: "Approved", rejected: "Not approved" };
const STATE_TONE = { pending: "warning", approved: "success", rejected: "neutral" };
const label = (s) => ATTENDANCE_STATUSES[s]?.label ?? s;
const shortDay = (d) => formatDayId(d).replace(/, \d{4}$/, "");

export function mountStaffPortal(root, session, { api = defaultApi, onSignOut = () => {} } = {}) {
  const state = { me: null, error: "", panel: null, busy: false, message: "", formError: "", period: null, edits: {}, selected: new Set(), review: false };
  const currency = session.business.currency || "PHP";
  const money = (c) => formatCentavos(c ?? 0, currency);
  const can = { attendance: session.member.permissions?.["attendance.self"] === true, advance: session.member.permissions?.["advances.self"] === true, salary: session.member.permissions?.["payroll.self"] === true };

  async function load() {
    try {
      state.me = (await api(state.period ? `me?period=${state.period}` : "me")).me;
      state.error = "";
    } catch (err) {
      state.error = err.message || "Couldn't load. Check your connection.";
    }
    draw();
  }

  const pill = (text, tone) => html`<span class="badge badge-${tone}">${text}</span>`;
  // What they can still ask for right now (null = no limit set).
  const roomFor = (cap) => (!cap || cap.limit === null ? null : Math.max(0, cap.available - cap.requested));
  function blockedText(cap) {
    if (!cap || cap.limit === null || roomFor(cap) > 0) return "";
    if (cap.limit === 0) return "Cash advances aren't available for you right now. Ask your employer.";
    if (cap.outstanding > 0 && cap.outstanding + cap.approved >= cap.limit) return `You still have ${money(cap.outstanding)} to repay before you can request another advance.`;
    return "You can't request more right now. Wait for your employer to answer your other request.";
  }
  const limitBox = (cap) =>
    cap && cap.limit !== null
      ? html`<dl class="advance-limit" data-role="advance-limit">
          <dt>Limit</dt><dd>${money(cap.limit)}</dd>
          <dt>Outstanding</dt><dd>${money(cap.outstanding)}</dd>
          ${cap.approved ? html`<dt>Approved, not given yet</dt><dd>${money(cap.approved)}</dd>` : ""}
          ${cap.requested ? html`<dt>Waiting for approval</dt><dd>${money(cap.requested)}</dd>` : ""}
          <dt class="is-available">Available</dt><dd class="is-available" data-role="available">${money(roomFor(cap))}</dd>
        </dl>`
      : "";

  function todayCard(m) {
    const pending = m.period.days.find((d) => d.date === m.today)?.pending;
    return html`<section class="card staff-card" data-section="today">
      <h2 class="staff-h">Today · ${shortDay(m.today)}</h2>
      ${m.todayStatus
        ? html`<p class="staff-big" data-role="today-status">${label(m.todayStatus)} ${pill("Recorded", "success")}</p>`
        : pending
          ? html`<p class="staff-big" data-role="today-status">${label(pending)} ${pill("Waiting for approval", "warning")}</p>`
          : html`<p class="staff-note">Not marked yet.</p>`}
      ${can.attendance && !m.todayStatus
        ? html`<button type="button" class="btn btn-primary btn-block btn-big" data-act="present">I'm here today</button>
            <button type="button" class="btn btn-block" data-act="panel" data-panel="day">Something else (leave, rest day, absent)</button>`
        : ""}
    </section>`;
  }

  function askCard() {
    if (!can.attendance && !can.advance) return "";
    return html`<section class="card staff-card" data-section="ask">
      <h2 class="staff-h">Ask your employer</h2>
      <div class="staff-actions">
        ${can.attendance ? html`<button type="button" class="btn btn-big" data-act="panel" data-panel="leave">Leave or rest day</button>` : ""}
        ${can.advance ? html`<button type="button" class="btn btn-big" data-act="panel" data-panel="advance">Cash advance</button>` : ""}
      </div>
      <p class="staff-note">Your employer approves first. Nothing changes your pay until then.</p>
    </section>`;
  }

  function panel(m) {
    if (!state.panel) return "";
    const today = m.today;
    const err = state.formError ? html`<p class="form-error" role="alert">${state.formError}</p>` : "";
    if (state.panel === "advance") {
      const cap = m.advanceLimit;
      const blocked = blockedText(cap);
      return html`<section class="card staff-card staff-panel" data-panel="advance">
        <h2 class="staff-h">Cash advance</h2>
        ${limitBox(cap)}
        ${blocked
          ? html`<p class="form-notice" role="status" data-role="advance-blocked">${blocked}</p><div class="staff-actions"><button type="button" class="btn" data-act="close">Back</button></div>`
          : html`
        <form class="form" data-role="advance-form" novalidate>
          <div class="field"><label for="sAmt">How much? (₱)</label><input class="input input-big" id="sAmt" name="amount" inputmode="decimal" required /></div>
          <div class="field"><label for="sWhy">What is it for? (optional)</label><input class="input" id="sWhy" name="reason" maxlength="200" /></div>
          ${err}
          <div class="staff-actions"><button type="button" class="btn" data-act="close">Cancel</button><button type="submit" class="btn btn-primary" ${state.busy ? "disabled" : ""}>Send request</button></div>
        </form>`}
      </section>`;
    }
    const ahead = state.panel === "leave";
    const types = ahead ? ["official_leave", "unpaid_leave", "rest_day"] : DAY_TYPES.filter((t) => t !== "present");
    return html`<section class="card staff-card staff-panel" data-panel="${state.panel}">
      <h2 class="staff-h">${ahead ? "Leave or rest day" : "Today is…"}</h2>
      <form class="form" data-role="day-form" novalidate>
        <div class="field"><label for="sDate">Date</label><input class="input input-big" type="date" id="sDate" name="date" value="${ahead ? "" : today}" ${ahead ? html`min="${today}"` : html`max="${today}"`} required /></div>
        <fieldset class="field staff-choices"><legend>Type</legend>
          ${types.map((t, i) => html`<label class="staff-choice"><input type="radio" name="status" value="${t}" ${i === 0 ? "checked" : ""} /> <span>${label(t)}</span><small>${ATTENDANCE_STATUSES[t].payable ? "paid" : "not paid"}</small></label>`)}
        </fieldset>
        <div class="field"><label for="sNote">Note (optional)</label><input class="input" id="sNote" name="note" maxlength="200" /></div>
        ${err}
        <div class="staff-actions"><button type="button" class="btn" data-act="close">Cancel</button><button type="submit" class="btn btn-primary" ${state.busy ? "disabled" : ""}>Send for approval</button></div>
      </form>
    </section>`;
  }

  // ---- My attendance: the pay-period sheet (Owner-pilot polish) ----
  const weekday = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", timeZone: "UTC" });
  // What a day can be set to: future days only leave / rest day.
  const typesFor = (date, today) => (date > today ? DAY_TYPES.filter((t) => ATTENDANCE_STATUSES[t].ahead) : DAY_TYPES);
  // The value shown in a row: an unsent change, else what's waiting.
  const shownStatus = (d) => (d.date in state.edits ? state.edits[d.date] : d.pending ?? "");
  // The changes to send: rows whose value differs from what's waiting / recorded.
  const changes = (sheet) => sheet.days.filter((d) => !d.lock && d.date in state.edits && state.edits[d.date] && state.edits[d.date] !== (d.pending ?? d.status ?? "")).map((d) => ({ date: d.date, status: state.edits[d.date] }));

  function dayRow(d, today) {
    const sel = state.selected.has(d.date);
    const when = html`<span class="sheet-date"><strong>${shortDay(d.date)}</strong> <small>${weekday(d.date)}</small></span>`;
    if (d.lock) {
      if (d.lock === "Before your start date" || d.lock === "After your last day") return html`<li class="sheet-row is-off" data-day="${d.date}"><span class="sheet-check" aria-hidden="true"></span>${when}<small class="sheet-lock">${d.lock}</small></li>`;
      return html`<li class="sheet-row is-locked" data-day="${d.date}"><span class="sheet-check" aria-hidden="true"></span>${when}<span class="sheet-value">${d.status ? html`${label(d.status)} ${pill(d.lock === "Approved by your employer" ? "Approved" : "Paid", "success")}` : html`<small class="sheet-lock">${d.lock}</small>`}</span></li>`;
    }
    const value = shownStatus(d);
    const edited = d.date in state.edits && state.edits[d.date] !== (d.pending ?? "");
    return html`<li class="sheet-row${sel ? " is-selected" : ""}${edited ? " is-edited" : ""}" data-day="${d.date}">
      <label class="sheet-check"><input type="checkbox" data-sel="${d.date}" ${sel ? "checked" : ""} aria-label="Select ${shortDay(d.date)}" /></label>
      ${when}
      <span class="sheet-value">
        <select class="input sheet-select" data-day-status="${d.date}" aria-label="Status for ${shortDay(d.date)}">
          <option value="" ${value ? "" : "selected"}>${d.status && !d.pending ? `${label(d.status)} (recorded)` : "Not marked"}</option>
          ${typesFor(d.date, today).map((t) => html`<option value="${t}" ${value === t ? "selected" : ""}>${label(t)}</option>`)}
        </select>
        ${d.pending && !edited ? html`<small class="sheet-flag is-wait">Waiting</small>` : d.rejected && !edited ? html`<small class="sheet-flag">Not approved: ${label(d.rejected)}</small>` : edited ? html`<small class="sheet-flag is-new">Not sent yet</small>` : ""}
      </span>
    </li>`;
  }

  function sheetCard(m) {
    if (!can.attendance || !m.sheet) return "";
    const s = m.sheet;
    const open = s.days.filter((d) => !d.lock);
    const pend = changes(s);
    if (state.review) {
      return html`<section class="card staff-card" data-section="sheet-review">
        <h2 class="staff-h">Check before sending</h2>
        <p class="staff-note">${shortDay(s.start)} to ${shortDay(s.end)} · ${pend.length} day${pend.length === 1 ? "" : "s"}. Your employer approves each day.</p>
        <ul class="staff-list" data-role="review">${pend.map((c) => html`<li><div class="staff-row"><span>${shortDay(c.date)} <small>${weekday(c.date)}</small></span><strong>${label(c.status)}</strong></div></li>`)}</ul>
        <form class="form" data-role="sheet-form" novalidate>
          <div class="field"><label for="sSheetNote">Note for your employer (optional)</label><input class="input" id="sSheetNote" name="note" maxlength="200" /></div>
          ${state.formError ? html`<p class="form-error" role="alert">${state.formError}</p>` : ""}
          <div class="staff-actions"><button type="button" class="btn" data-act="sheet-back">Back</button><button type="submit" class="btn btn-primary" ${state.busy ? "disabled" : ""}>Submit attendance</button></div>
        </form>
      </section>`;
    }
    return html`<section class="card staff-card" data-section="sheet">
      <h2 class="staff-h">My attendance</h2>
      <div class="sheet-nav">
        <button type="button" class="btn btn-compact" data-act="sheet-period" data-period="${s.prev ?? ""}" ${s.prev ? "" : "disabled"} aria-label="Previous pay period">‹</button>
        <strong data-role="sheet-period">${shortDay(s.start)} – ${shortDay(s.end)}</strong>
        <button type="button" class="btn btn-compact" data-act="sheet-period" data-period="${s.next ?? ""}" ${s.next ? "" : "disabled"} aria-label="Next pay period">›</button>
      </div>
      ${s.paid ? html`<p class="staff-note">This salary is already paid. Ask your employer about any change.</p>` : ""}
      ${open.length
        ? html`<div class="sheet-bulk" data-role="bulk">
            <span class="staff-note">${state.selected.size ? `${state.selected.size} selected:` : "Select days, then:"}</span>
            <button type="button" class="btn btn-compact" data-act="bulk" data-status="present" ${state.selected.size ? "" : "disabled"}>Present</button>
            <button type="button" class="btn btn-compact" data-act="bulk" data-status="rest_day" ${state.selected.size ? "" : "disabled"}>Rest Day</button>
            <button type="button" class="btn btn-compact btn-ghost" data-act="${state.selected.size ? "sel-clear" : "sel-open"}">${state.selected.size ? "Clear selection" : "Select all open days"}</button>
          </div>`
        : ""}
      <ul class="sheet-list" data-role="sheet">${s.days.map((d) => dayRow(d, m.today))}</ul>
      ${open.length
        ? html`<div class="staff-actions"><button type="button" class="btn btn-primary btn-big" data-act="sheet-review" ${pend.length ? "" : "disabled"}>${pend.length ? `Review ${pend.length} day${pend.length === 1 ? "" : "s"}` : "Choose a status for a day"}</button></div>
            <p class="staff-note">Days your employer approved can't be changed here. Ask them to correct it.</p>`
        : ""}
    </section>`;
  }

  function salaryCard(m) {
    if (!can.salary) return "";
    const e = m.period.estimate;
    return html`<section class="card staff-card" data-section="salary">
      <h2 class="staff-h">My salary</h2>
      <div class="staff-period" data-role="period">
        <div class="staff-period-head"><span>This pay period · ${shortDay(m.period.start)} to ${shortDay(m.period.end)}</span>${pill(e.prepared ? "Being prepared" : "So far", "neutral")}</div>
        <div class="staff-days" aria-label="Days this pay period">${m.period.days.map((d) => html`<span class="staff-day${d.status ? ` is-${d.status}` : d.pending ? " is-pending" : ""}${d.date === m.today ? " is-today" : ""}" title="${shortDay(d.date)}: ${d.status ? label(d.status) : d.pending ? `${label(d.pending)} (waiting)` : "not marked"}">${Number(d.date.slice(8))}</span>`)}</div>
        <dl class="dl dl-compact staff-money">
          <dt>Basic pay so far</dt><dd>${money(e.basicPay)}</dd>
          ${e.additions ? html`<dt>Bonus / 13th month</dt><dd>+ ${money(e.additions)}</dd>` : ""}
          ${e.deductions ? html`<dt>Advance and other deductions</dt><dd>− ${money(e.deductions)}</dd>` : ""}
          <dt><strong>Estimated take-home</strong></dt><dd><strong data-role="estimate">${money(e.netPay)}</strong></dd>
        </dl>
        <p class="staff-note">${m.period.counts.present} present · ${m.period.counts.officialLeave} paid leave · ${m.staff.dailyWage ? `${money(m.staff.dailyWage)} a day` : ""}</p>
      </div>
      ${m.salaries.filter((s) => s.state === "paid").length
        ? html`<ul class="staff-list" data-role="salaries">${m.salaries
            .filter((s) => s.state === "paid")
            .map(
              (s) => html`<li data-salary="${s.id}">
                <div class="staff-row"><span><strong>${money(s.netPay)}</strong><br /><small>${shortDay(s.period.start)} to ${shortDay(s.period.end)} · paid ${s.payment?.paidDate ? shortDay(s.payment.paidDate) : ""}${s.payment?.method ? ` by ${s.payment.method}` : ""}</small></span>
                ${s.receipt === "received" ? pill("Received", "success") : s.receipt === "not_received" ? pill("Reported not received", "danger") : pill("Please confirm", "warning")}</div>
                ${s.receipt === "not_confirmed" || s.receipt === "not_received"
                  ? html`<div class="staff-actions"><button type="button" class="btn btn-primary" data-act="received" data-id="${s.id}">I received my salary</button>${s.receipt === "not_confirmed" ? html`<button type="button" class="btn" data-act="notReceived" data-id="${s.id}">I didn't receive it</button>` : ""}</div>`
                  : ""}
                <details class="staff-details"><summary>See the breakdown</summary><dl class="dl dl-compact">
                  <dt>Basic pay</dt><dd>${money(s.basicPay)}</dd>
                  ${s.additions.map((a) => html`<dt>${a.description || a.type}</dt><dd>+ ${money(a.amount)}</dd>`)}
                  ${s.deductions.map((d) => html`<dt>${d.description}</dt><dd>− ${money(d.amount)}</dd>`)}
                  <dt><strong>Take-home</strong></dt><dd><strong>${money(s.netPay)}</strong></dd>
                </dl></details>
              </li>`
            )}</ul>`
        : html`<p class="staff-note">Paid salaries will show here.</p>`}
    </section>`;
  }

  function requestsCard(m) {
    if (!m.requests.length) return "";
    return html`<section class="card staff-card" data-section="requests">
      <h2 class="staff-h">My requests</h2>
      <ul class="staff-list" data-role="requests">${m.requests.slice(0, 8).map((r) => html`<li><div class="staff-row"><span>${label(r.status)} · ${shortDay(r.date)}${r.answer ? html`<br /><small>${r.answer}</small>` : ""}</span>${pill(STATE_LABEL[r.state] ?? r.state, STATE_TONE[r.state] ?? "neutral")}</div></li>`)}</ul>
    </section>`;
  }

  function advancesCard(m) {
    if (!m.advances.length) return "";
    return html`<section class="card staff-card" data-section="advances">
      <h2 class="staff-h">My cash advances</h2>
      <ul class="staff-list" data-role="advances">${m.advances.map(
        (a) => html`<li><div class="staff-row"><span><strong>${money(a.amount)}</strong>${a.requested && a.requested !== a.amount ? html` <small>(asked ${money(a.requested)})</small>` : ""}<br /><small>${a.reason || shortDay(a.date)}${a.status === "paid" ? ` · ${money(a.remaining)} left to repay` : ""}${a.installment && a.status !== "rejected" ? ` · ${money(a.installment)} each payday` : ""}${a.answer ? ` · ${a.answer}` : ""}</small></span>
          ${pill(a.status === "requested" ? "Waiting" : a.status === "rejected" ? "Not approved" : a.status === "paid" ? (a.remaining ? "Repaying" : "Repaid") : "Approved", a.status === "requested" ? "warning" : a.status === "rejected" ? "neutral" : "success")}</div></li>`
      )}</ul>
    </section>`;
  }

  function draw() {
    const m = state.me;
    render(
      root,
      html`<div class="staff-app" data-role="staff-portal" data-workspace="household-payroll">
        <header class="staff-top">
          <div class="brand">${lunaMark()}<span class="brand-text">${session.business.name}</span></div>
          <button type="button" class="btn btn-ghost" data-act="signout">Sign out</button>
        </header>
        <main class="staff-main" id="content" tabindex="-1">
          ${state.error
            ? html`<section class="card staff-card"><p>${state.error}</p><button type="button" class="btn" data-act="reload">Try again</button></section>`
            : !m
              ? html`<p class="staff-note">Loading…</p>`
              : html`<h1 class="staff-hello">Hi, ${m.staff.name.split(" ")[0]}!</h1>
                  ${state.message ? html`<p class="form-notice" role="status" data-role="message">${state.message}</p>` : ""}
                  ${panel(m)}${state.panel ? "" : html`${state.review ? "" : html`${todayCard(m)}${askCard()}`}${sheetCard(m)}`}${state.review ? "" : html`${salaryCard(m)}${requestsCard(m)}${advancesCard(m)}`}`}
        </main>
      </div>`
    );
  }

  async function send(body, done) {
    state.busy = true;
    state.formError = "";
    draw();
    try {
      await api("me", { method: "POST", body });
      state.panel = null;
      state.message = done;
      await load();
    } catch (err) {
      state.formError = err.message || "Couldn't send. Try again.";
      if (!state.panel) state.message = state.formError;
    }
    state.busy = false;
    draw();
  }

  // One submission for the whole sheet: all days or none (the server says
  // which days weren't allowed).
  async function sendSheet(days, note) {
    state.busy = true;
    state.formError = "";
    draw();
    try {
      const r = await api("me", { method: "POST", body: { action: "attendanceDays", days, ...(note ? { note } : {}) } });
      state.review = false;
      state.edits = {};
      state.selected = new Set();
      state.message = r.sent ? `Sent ${r.sent} day${r.sent === 1 ? "" : "s"}. Your employer will approve them.` : "Nothing new to send.";
      await load();
    } catch (err) {
      state.formError = err.message || "Couldn't send. Try again.";
    }
    state.busy = false;
    draw();
  }

  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "signout") return onSignOut();
    if (act === "reload") return load();
    if (act === "panel") {
      state.panel = el.dataset.panel;
      state.formError = "";
      state.message = "";
      return draw();
    }
    if (act === "close") {
      state.panel = null;
      return draw();
    }
    if (act === "sheet-period" && el.dataset.period) {
      state.period = el.dataset.period;
      state.edits = {};
      state.selected = new Set();
      return load();
    }
    if (act === "bulk") {
      for (const d of state.selected) state.edits[d] = el.dataset.status;
      // A future day can't be Present: those keep their value.
      if (el.dataset.status === "present") for (const d of state.selected) if (d > state.me.today) delete state.edits[d];
      state.selected = new Set();
      return draw();
    }
    if (act === "sel-clear") {
      state.selected = new Set();
      return draw();
    }
    if (act === "sel-open") {
      state.selected = new Set(state.me.sheet.days.filter((d) => !d.lock).map((d) => d.date));
      return draw();
    }
    if (act === "sheet-review") {
      state.review = true;
      state.formError = "";
      draw();
      return root.querySelector('[data-section="sheet-review"]')?.scrollIntoView?.({ block: "start" });
    }
    if (act === "sheet-back") {
      state.review = false;
      return draw();
    }
    if (act === "present") return send({ action: "attendance", date: state.me.today, status: "present" }, "Sent. Your employer will approve it.");
    if (act === "received") return send({ action: "received", payrollId: el.dataset.id }, "Thank you! Your employer can see you received it.");
    if (act === "notReceived") return send({ action: "notReceived", payrollId: el.dataset.id }, "We told your employer. They'll check the payment.");
    return undefined;
  });
  root.addEventListener("change", (event) => {
    const t = event.target;
    if (t.dataset.sel) {
      if (t.checked) state.selected.add(t.dataset.sel);
      else state.selected.delete(t.dataset.sel);
      return draw();
    }
    if (t.dataset.dayStatus) {
      state.edits[t.dataset.dayStatus] = t.value;
      return draw();
    }
    return undefined;
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = event.target;
    if (f.dataset.role === "sheet-form") {
      const days = changes(state.me.sheet);
      const note = f.elements.note.value.trim();
      return sendSheet(days, note);
    }
    if (f.dataset.role === "advance-form") {
      const amount = parseCentavos(f.elements.amount.value);
      if (!(amount > 0)) {
        state.formError = "Enter an amount, e.g. 1500";
        return draw();
      }
      const room = roomFor(state.me?.advanceLimit);
      if (room !== null && amount > room) {
        state.formError = `You can request up to ${money(room)} right now.`;
        return draw();
      }
      return send({ action: "advance", amount, ...(f.elements.reason.value.trim() ? { reason: f.elements.reason.value.trim() } : {}) }, "Sent. Your employer will answer your request.");
    }
    if (f.dataset.role === "day-form") {
      const status = f.elements.status.value;
      if (!f.elements.date.value) {
        state.formError = "Choose the date.";
        return draw();
      }
      return send({ action: "attendance", date: f.elements.date.value, status, ...(f.elements.note.value.trim() ? { note: f.elements.note.value.trim() } : {}) }, `Sent: ${label(status)} on ${shortDay(f.elements.date.value)}. Waiting for approval.`);
    }
    return undefined;
  });

  draw();
  return load();
}

export { isStaffPortalSession } from "./is-staff.js";
