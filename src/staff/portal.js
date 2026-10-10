// Household staff screen (Phase 18.6): a kasambahay's own simple Luna. No
// menu, no tables: one screen with big buttons.
//
//   Today          "I'm here today" (Present) and the other day types
//   Ask            Leave / rest day ahead · Cash advance
//   My salary      this pay period so far, past salaries, "I received it"
//   My requests    what's waiting, approved or not approved
//   My advances    what's left to repay
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
  const state = { me: null, error: "", panel: null, busy: false, message: "", formError: "" };
  const currency = session.business.currency || "PHP";
  const money = (c) => formatCentavos(c ?? 0, currency);
  const can = { attendance: session.member.permissions?.["attendance.self"] === true, advance: session.member.permissions?.["advances.self"] === true, salary: session.member.permissions?.["payroll.self"] === true };

  async function load() {
    try {
      state.me = (await api("me")).me;
      state.error = "";
    } catch (err) {
      state.error = err.message || "Couldn't load. Check your connection.";
    }
    draw();
  }

  const pill = (text, tone) => html`<span class="badge badge-${tone}">${text}</span>`;

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
      return html`<section class="card staff-card staff-panel" data-panel="advance">
        <h2 class="staff-h">Ask for a cash advance</h2>
        <form class="form" data-role="advance-form" novalidate>
          <div class="field"><label for="sAmt">How much? (₱)</label><input class="input input-big" id="sAmt" name="amount" inputmode="decimal" required /></div>
          <div class="field"><label for="sWhy">What is it for? (optional)</label><input class="input" id="sWhy" name="reason" maxlength="200" /></div>
          ${err}
          <div class="staff-actions"><button type="button" class="btn" data-act="close">Cancel</button><button type="submit" class="btn btn-primary" ${state.busy ? "disabled" : ""}>Send request</button></div>
        </form>
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
                  ${panel(m)}${state.panel ? "" : html`${todayCard(m)}${askCard()}`}${salaryCard(m)}${requestsCard(m)}${advancesCard(m)}`}
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
    if (act === "present") return send({ action: "attendance", date: state.me.today, status: "present" }, "Sent. Your employer will approve it.");
    if (act === "received") return send({ action: "received", payrollId: el.dataset.id }, "Thank you! Your employer can see you received it.");
    if (act === "notReceived") return send({ action: "notReceived", payrollId: el.dataset.id }, "We told your employer. They'll check the payment.");
    return undefined;
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = event.target;
    if (f.dataset.role === "advance-form") {
      const amount = parseCentavos(f.elements.amount.value);
      if (!(amount > 0)) {
        state.formError = "Enter an amount, e.g. 1500";
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
