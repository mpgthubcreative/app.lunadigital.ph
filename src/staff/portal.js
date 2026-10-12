// Household staff screen (Owner-pilot simplification batch): the helper
// reviews and confirms; the Owner records and manages. Four tabs:
//   Home           what needs their confirmation now, at a glance
//   My Attendance  a pay period's totals (Present 11 days…), View details,
//                  Confirm attendance, Report a correction
//   My Salary      what they were paid (with proof), I received it /
//                  I didn't receive it, and this period so far
//   My Advances    amount received, date, what's left, the planned
//                  deduction (set by the employer), proof, I received it
// No editing of attendance, payroll or repayment plans here: a correction
// is reported in one sentence and the employer fixes it. Everything comes
// from /api/me (their OWN record only, enforced by the server).

import { html, render } from "../lib/html.js";
import { api as defaultApi } from "../lib/api.js";
import { formatCentavos, formatDayId } from "../lib/format.js";
import { lunaMark } from "../components/icons.js";
import { ATTENDANCE_STATUSES } from "@shared/index.js";
import { viewProof } from "../components/proof-viewer.js";

const label = (s) => ATTENDANCE_STATUSES[s]?.label ?? s;
const shortDay = (d) => formatDayId(d).replace(/, \d{4}$/, "");
const span = (a, b) => (a.slice(0, 7) === b.slice(0, 7) ? `${shortDay(a)}–${Number(b.slice(8))}` : `${shortDay(a)} – ${shortDay(b)}`);
const days = (n) => `${n} day${n === 1 ? "" : "s"}`;
const TABS = [["home", "Home"], ["attendance", "Attendance"], ["salary", "Salary"], ["advances", "Advances"]];

export function mountStaffPortal(root, session, { api = defaultApi, onSignOut = () => {} } = {}) {
  const state = { me: null, error: "", tab: "home", period: null, details: false, reporting: false, busy: false, message: "", formError: "" };
  const currency = session.business.currency || "PHP";
  const money = (c) => formatCentavos(c ?? 0, currency);
  const can = { attendance: session.member.permissions?.["attendance.self"] === true, advance: session.member.permissions?.["advances.self"] === true, salary: session.member.permissions?.["payroll.self"] === true };
  const tabs = TABS.filter(([k]) => k === "home" || (k === "attendance" && can.attendance) || (k === "salary" && can.salary) || (k === "advances" && can.advance));

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
  const toConfirm = (m) => ({
    salaries: (m.salaries || []).filter((s) => s.receipt === "not_confirmed"),
    advances: (m.advances || []).filter((a) => a.status === "paid" && a.received === "awaiting"),
    attendance: m.sheet && m.sheet.canConfirm && (!m.sheet.confirmation || !m.sheet.confirmation.current) && m.sheet.current,
  });
  const owed = (m) => (m.advances || []).filter((a) => a.status === "paid").reduce((t, a) => t + (a.remaining || 0), 0);

  function home(m) {
    const c = toConfirm(m);
    const items = [
      ...(can.attendance && c.attendance ? [html`<li><span>Attendance ${span(m.sheet.start, m.sheet.end)}</span><button type="button" class="btn btn-compact btn-primary" data-act="tab" data-tab="attendance">Review</button></li>`] : []),
      ...(can.salary ? c.salaries.map((s) => html`<li><span>Salary ${money(s.netPay)} · ${span(s.period.start, s.period.end)}</span><button type="button" class="btn btn-compact btn-primary" data-act="tab" data-tab="salary">Confirm</button></li>`) : []),
      ...(can.advance ? c.advances.map((a) => html`<li><span>Advance ${money(a.amount)} · ${shortDay(a.releasedOn || a.date)}</span><button type="button" class="btn btn-compact btn-primary" data-act="tab" data-tab="advances">Confirm</button></li>`) : []),
    ];
    const s = m.sheet;
    return html`
      <section class="card staff-card" data-section="to-confirm">
        <h2 class="staff-h">To confirm</h2>
        ${items.length ? html`<ul class="staff-todo" data-role="to-confirm">${items}</ul>` : html`<p class="staff-note" data-role="all-done">Nothing to confirm right now. Thank you!</p>`}
      </section>
      <section class="card staff-card staff-glance">
        ${can.attendance && s ? html`<button type="button" class="staff-glance-row" data-act="tab" data-tab="attendance"><span>This period · ${span(s.start, s.end)}</span><strong>${days(s.counts.present)} present</strong></button>` : ""}
        ${can.salary ? html`<button type="button" class="staff-glance-row" data-act="tab" data-tab="salary"><span>Estimated take-home so far</span><strong>${money(m.period.estimate.netPay)}</strong></button>` : ""}
        ${can.advance ? html`<button type="button" class="staff-glance-row" data-act="tab" data-tab="advances"><span>Advance still owed</span><strong>${money(owed(m))}</strong></button>` : ""}
      </section>`;
  }

  function attendance(m) {
    const s = m.sheet;
    const c = s.counts;
    const rows = [["Present", c.present], ["Rest Day", c.restDay], ["Absent", c.absent], ["Paid Leave", c.officialLeave], ["Unpaid Leave", c.unpaidLeave], ...(c.notMarked && s.end <= m.today ? [["Not marked", c.notMarked]] : [])].filter(([l, n]) => n || l === "Present");
    const conf = s.confirmation;
    return html`<section class="card staff-card" data-section="attendance">
      <h2 class="staff-h">My attendance</h2>
      <div class="sheet-nav">
        <button type="button" class="btn btn-compact" data-act="period" data-period="${s.prev ?? ""}" ${s.prev ? "" : "disabled"} aria-label="Previous pay period">‹</button>
        <strong data-role="sheet-period">${span(s.start, s.end)}</strong>
        <button type="button" class="btn btn-compact" data-act="period" data-period="${s.next ?? ""}" ${s.next ? "" : "disabled"} aria-label="Next pay period">›</button>
      </div>
      <dl class="staff-totals" data-role="totals">${rows.map(([l, n]) => html`<dt>${l}</dt><dd>${days(n)}</dd>`)}</dl>
      <button type="button" class="btn btn-block" data-act="details">${state.details ? "Hide details" : "View details"}</button>
      ${state.details ? html`<ul class="staff-days-list" data-role="days">${s.days.filter((d) => d.lock !== "Before your start date" && d.lock !== "After your last day").map((d) => html`<li><span>${shortDay(d.date)}</span><span>${d.status ? label(d.status) : d.pending ? `${label(d.pending)} (sent)` : html`<small>Not recorded</small>`}</span></li>`)}</ul>` : ""}
      ${s.canConfirm
        ? conf && conf.current
          ? html`<p class="staff-note" data-role="confirmed">${pill("Confirmed", "success")} You confirmed this attendance${conf.at ? ` on ${shortDay(conf.at.slice(0, 10))}` : ""}.</p>`
          : html`${conf ? html`<p class="staff-note">${pill("Changed", "warning")} Your employer changed some days after you confirmed. Please check again.</p>` : ""}<button type="button" class="btn btn-primary btn-block btn-big" data-act="confirm-attendance" ${state.busy ? "disabled" : ""}>Confirm attendance</button><p class="staff-note">Confirm means: I reviewed the attendance recorded for me.</p>`
        : html`<p class="staff-note">This pay period hasn't started yet.</p>`}
      ${state.reporting
        ? html`<form class="form" data-role="correction-form" novalidate>
            <div class="field"><label for="cDate">Which day? (optional)</label><select class="input input-big" id="cDate" name="date"><option value="">Not one day / several days</option>${s.days.filter((d) => d.date <= m.today && d.lock !== "Before your start date" && d.lock !== "After your last day").map((d) => html`<option value="${d.date}">${shortDay(d.date)}${d.status ? ` · ${label(d.status)}` : ""}</option>`)}</select></div>
            <div class="field"><label for="cMsg">What's wrong?</label><textarea class="input" id="cMsg" name="message" rows="3" maxlength="300" placeholder="e.g. I was present on Oct 8, not absent"></textarea></div>
            ${state.formError ? html`<p class="form-error" role="alert">${state.formError}</p>` : ""}
            <div class="staff-actions"><button type="button" class="btn" data-act="cancel-report">Cancel</button><button type="submit" class="btn btn-primary" ${state.busy ? "disabled" : ""}>Send to my employer</button></div>
          </form>`
        : html`<button type="button" class="btn btn-block" data-act="report">Report a correction</button>`}
      ${(m.corrections || []).length ? html`<h3 class="staff-h2">My reports</h3><ul class="staff-list" data-role="reports">${m.corrections.map((x) => html`<li><div class="staff-row"><span>${x.date ? `${shortDay(x.date)} · ` : ""}${x.message}${x.answer ? html`<br /><small>${x.answer}</small>` : ""}</span>${x.state === "open" ? pill("Sent", "warning") : pill("Done", "success")}</div></li>`)}</ul>` : ""}
    </section>`;
  }

  function salary(m) {
    const e = m.period.estimate;
    const paid = (m.salaries || []).filter((s) => s.state === "paid");
    return html`<section class="card staff-card" data-section="salary">
      <h2 class="staff-h">My salary</h2>
      ${paid.length
        ? html`<ul class="staff-list" data-role="salaries">${paid.map(
            (s) => html`<li data-salary="${s.id}">
              <div class="staff-row"><span><strong>${money(s.netPay)}</strong><br /><small>${span(s.period.start, s.period.end)} · paid ${s.payment?.paidDate ? shortDay(s.payment.paidDate) : ""}${s.payment?.method ? ` by ${s.payment.method}` : ""}${s.payment?.early ? " (early)" : ""}</small></span>
              ${s.receipt === "received" ? pill("Received", "success") : s.receipt === "not_received" ? pill("Reported not received", "danger") : pill("Please confirm", "warning")}</div>
              <div class="staff-actions">${s.payment?.hasProof ? html`<button type="button" class="btn" data-act="proof" data-kind="salary" data-id="${s.id}">View proof</button>` : ""}${s.receipt === "not_confirmed" || s.receipt === "not_received" ? html`<button type="button" class="btn btn-primary" data-act="received" data-id="${s.id}">I received my salary</button>${s.receipt === "not_confirmed" ? html`<button type="button" class="btn" data-act="notReceived" data-id="${s.id}">I didn't receive it</button>` : ""}` : ""}</div>
              <details class="staff-details"><summary>See the breakdown</summary><dl class="dl dl-compact">
                <dt>Basic pay</dt><dd>${money(s.basicPay)}</dd>
                ${s.additions.map((a) => html`<dt>${a.description || a.type}</dt><dd>+ ${money(a.amount)}</dd>`)}
                ${s.deductions.map((d) => html`<dt>${d.description}</dt><dd>− ${money(d.amount)}</dd>`)}
                <dt><strong>Take-home</strong></dt><dd><strong>${money(s.netPay)}</strong></dd>
              </dl></details>
            </li>`
          )}</ul>`
        : html`<p class="staff-note">Paid salaries will show here.</p>`}
      <div class="staff-period" data-role="period">
        <div class="staff-period-head"><span>This pay period · ${span(m.period.start, m.period.end)}</span>${pill("So far", "neutral")}</div>
        <dl class="dl dl-compact staff-money">
          <dt>Basic pay so far</dt><dd>${money(e.basicPay)}</dd>
          ${e.additions ? html`<dt>Bonus / 13th month</dt><dd>+ ${money(e.additions)}</dd>` : ""}
          ${e.deductions ? html`<dt>Advance and other deductions</dt><dd>− ${money(e.deductions)}</dd>` : ""}
          <dt><strong>Estimated take-home</strong></dt><dd><strong data-role="estimate">${money(e.netPay)}</strong></dd>
        </dl>
      </div>
    </section>`;
  }

  function advances(m) {
    const list = (m.advances || []).filter((a) => a.status === "paid");
    return html`<section class="card staff-card" data-section="advances">
      <h2 class="staff-h">My cash advances</h2>
      ${list.length ? html`<p class="staff-note">Still owed in total: <strong data-role="owed">${money(owed(m))}</strong>. Your employer plans when it's taken from your salary.</p>` : html`<p class="staff-note">Advances your employer gives you will show here.</p>`}
      <ul class="staff-list" data-role="advances">${list.map(
        (a) => html`<li data-advance="${a.id}">
          <dl class="staff-totals">
            <dt>Amount received</dt><dd><strong>${money(a.amount)}</strong></dd>
            <dt>Date</dt><dd>${shortDay(a.releasedOn || a.date)}</dd>
            <dt>Remaining balance</dt><dd>${a.remaining ? money(a.remaining) : "Fully repaid"}</dd>
            ${a.remaining ? html`<dt>Planned deduction</dt><dd>${a.planned.length ? a.planned.map((p) => `${money(p.amount)} ${span(p.periodStart, p.periodEnd)}`).join(", ") : "Not planned yet"}</dd>` : ""}
          </dl>
          <div class="staff-actions">${a.hasProof ? html`<button type="button" class="btn" data-act="proof" data-kind="advance" data-id="${a.id}">View proof</button>` : ""}${a.received === "awaiting" ? html`<button type="button" class="btn btn-primary" data-act="advance-received" data-id="${a.id}">I received this advance</button>` : pill("Received", "success")}</div>
        </li>`
      )}</ul>
    </section>`;
  }

  function draw() {
    const m = state.me;
    const tab = tabs.some(([k]) => k === state.tab) ? state.tab : "home";
    render(
      root,
      html`<div class="staff-app" data-role="staff-portal" data-workspace="household-payroll">
        <header class="staff-top">
          <div class="brand">${lunaMark()}<span class="brand-text">${session.business.name}</span></div>
          <button type="button" class="btn btn-ghost" data-act="signout">Sign out</button>
        </header>
        ${m ? html`<nav class="staff-tabs" aria-label="Sections">${tabs.map(([k, l]) => html`<button type="button" class="staff-tab${k === tab ? " is-on" : ""}" data-act="tab" data-tab="${k}" aria-current="${k === tab ? "page" : "false"}">${l}</button>`)}</nav>` : ""}
        <main class="staff-main" id="content" tabindex="-1">
          ${state.error
            ? html`<section class="card staff-card"><p>${state.error}</p><button type="button" class="btn" data-act="reload">Try again</button></section>`
            : !m
              ? html`<p class="staff-note">Loading…</p>`
              : html`${tab === "home" ? html`<h1 class="staff-hello">Hi, ${m.staff.name.split(" ")[0]}!</h1>` : ""}
                  ${state.message ? html`<p class="form-notice" role="status" data-role="message">${state.message}</p>` : ""}
                  ${tab === "home" ? home(m) : tab === "attendance" ? attendance(m) : tab === "salary" ? salary(m) : advances(m)}`}
        </main>
      </div>`
    );
  }

  async function send(body, done) {
    state.busy = true;
    state.formError = "";
    state.message = "";
    draw();
    try {
      await api("me", { method: "POST", body });
      state.message = done;
      state.reporting = false;
      await load();
    } catch (err) {
      state.formError = err.message || "Couldn't send. Try again.";
      if (!state.reporting) state.message = state.formError;
    }
    state.busy = false;
    draw();
  }

  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act]");
    if (!el) return undefined;
    const act = el.dataset.act;
    if (act === "signout") return onSignOut();
    if (act === "reload") return load();
    if (act === "tab") {
      state.tab = el.dataset.tab;
      state.message = "";
      state.reporting = false;
      draw();
      return root.querySelector("#content")?.focus?.();
    }
    if (act === "period" && el.dataset.period) {
      state.period = el.dataset.period;
      state.details = false;
      return load();
    }
    if (act === "details") {
      state.details = !state.details;
      return draw();
    }
    if (act === "report") {
      state.reporting = true;
      state.formError = "";
      return draw();
    }
    if (act === "cancel-report") {
      state.reporting = false;
      return draw();
    }
    if (act === "confirm-attendance") return send({ action: "confirmAttendance", periodStart: state.me.sheet.start }, "Thank you! Your employer can see you confirmed it.");
    if (act === "received") return send({ action: "received", payrollId: el.dataset.id }, "Thank you! Your employer can see you received it.");
    if (act === "notReceived") return send({ action: "notReceived", payrollId: el.dataset.id }, "We told your employer. They'll check the payment.");
    if (act === "advance-received") return send({ action: "advanceReceived", advanceId: el.dataset.id }, "Thank you! Your employer can see you received it.");
    if (act === "proof") return viewProof({ title: el.dataset.kind === "advance" ? "Advance proof" : "Salary proof", load: async () => (await api("me", { method: "POST", body: { action: "proof", kind: el.dataset.kind, recordId: el.dataset.id } })).proof });
    return undefined;
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = event.target;
    if (f.dataset.role !== "correction-form") return undefined;
    const message = f.elements.message.value.trim();
    if (message.length < 3) {
      state.formError = "Say what's wrong, e.g. \"I was present on Oct 8\".";
      return draw();
    }
    return send({ action: "reportCorrection", message, ...(f.elements.date.value ? { date: f.elements.date.value } : {}) }, "Sent. Your employer will check and fix it.");
  });

  draw();
  return load();
}

export { isStaffPortalSession } from "./is-staff.js";
