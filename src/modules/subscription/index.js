// Subscription (Phase 18.6): the workspace Owner's Luna plan and payments.
// "What plan do I have, how much do I owe, how do I pay, and has Luna
// confirmed it?" Reads and submits through /api/subscription (own business
// only). Sending a payment only puts it For Verification: Luna confirms it.
//
// Continue with Luna (2026-10-21): during or after the free trial the page
// opens with the plans for this workspace (6 / 12 months; Bridal: Luna
// Bridal; a wedding already on legacy Luna Bridal Custom keeps seeing its
// own). The Owner chooses one; its first bill (with
// Distributor's one-time setup fee) appears under Bills to pay. Paying it
// continues the same workspace with all its information.

import { html, render } from "../../lib/html.js";
import { pageHeader, card, emptyState, badge, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { api as defaultApi } from "../../lib/api.js";
import { prepareProof, PHOTO_OR_PDF_ACCEPT } from "../../lib/image.js";
import { bindReferenceDetection, detectReference } from "../../lib/payment-reference.js";
import { SUBSCRIPTION_LABELS, businessDate } from "@shared/index.js";
import { INVOICE_STATUSES, PAYMENT_STATUSES, PROOF_MAX_BYTES, BILLING_TIMEZONE } from "@shared/billing.js";
import { TRIAL_DAYS, TRIAL_ENDED_MESSAGE } from "@shared/trial.js";

const STATUS_TONE = { active: "success", past_due: "warning", suspended: "danger", cancelled: "neutral" };
const monthName = (period) => new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });
const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

function readRaw(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}
// Screenshot (shrunk in the browser) or a PDF receipt (as is, max 3 MB).
// How the plan is billed (2026-10-20): monthly (a prepaid starter covers
// its months), prepaid access for the chosen term, or 12-month wedding
// access (no automatic renewal).
const forMonths = (n) => (n === 12 ? "12 months" : n === 1 ? "1 month" : `${n} months`);
function priceLine(s, money) {
  const b = s.billing;
  if (!b) return s.monthlyAmount ? `${money(s.monthlyAmount)} a month` : "";
  if (!b.amount) return "";
  if (b.type === "monthly") return b.termMonths > 1 ? `${money(b.amount)} for ${forMonths(b.termMonths)}, then monthly` : `${money(b.amount)} a month`;
  return `${money(b.amount)} for ${forMonths(b.termMonths || 12)}`;
}
function nextLine(s) {
  const b = s.billing;
  if (b?.type === "term") return b.dueDate ? `Payment due ${formatDayId(b.dueDate)}` : b.accessUntil ? `Access ends ${formatDayId(b.accessUntil)} · no automatic renewal` : "";
  if (b?.type === "annual" && b.accessUntil && b.dueDate) return `Access until ${formatDayId(b.accessUntil)} · renewal due ${formatDayId(b.dueDate)}`;
  if (b?.dueDate) return `${b.type === "annual" ? "Payment due" : "Due"} ${formatDayId(b.dueDate)}`;
  return s.nextRenewal ? `Next renewal ${formatDayId(s.nextRenewal)}` : s.current ? `${monthName(s.current.period)} · due ${formatDayId(s.current.dueDate)}` : "";
}

export async function prepareSubscriptionProof(file) {
  if (!file) return null;
  if (file.type === "application/pdf") {
    if (file.size > PROOF_MAX_BYTES) throw new Error("The PDF is larger than 3 MB");
    return { contentType: "application/pdf", dataBase64: await readRaw(file) };
  }
  return prepareProof(file);
}

// "6 Months — ₱1,299 + ₱250 setup", "12 Months — ₱2,390 — BEST VALUE",
// "Luna Bridal — ₱499", "Luna Bridal Custom — starts ₱2,990".
const whole = (c) => `₱${(c / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
export function optionLabel(o, t) {
  const price = `${o.priceIsMinimum ? "starts " : ""}${whole(t.price)}`;
  const head = o.terms.length === 1 ? o.name : `${t.months} Months`;
  return `${head} — ${price}${o.setupFee > 0 ? ` + ${whole(o.setupFee)} setup` : ""}`;
}

export function mount(container, session, { api = defaultApi, toast = defaultToast, now = () => new Date(), detect = detectReference } = {}) {
  const state = { loading: true, error: null, s: null, choosing: false };
  let alive = true;
  const money = (c) => formatCentavos(c ?? 0, session.business.currency || "PHP");
  const owner = session.member.isAccountOwner === true || session.member.roleTemplate === "owner";

  // Continue with Luna: the plans; the chosen one is marked.
  function continueSection(s) {
    const t = s.trial;
    const chosen = t.conversion;
    const length = Math.round((Date.parse(`${t.endsAt}T00:00:00Z`) - Date.parse(`${t.startedAt}T00:00:00Z`)) / 86400000) + 1 || TRIAL_DAYS;
    return html`<section class="section" data-role="continue">
      ${t.ended
        ? html`<div class="banner banner-danger" role="alert" data-role="trial-ended">${TRIAL_ENDED_MESSAGE}</div>`
        : html`<p class="stat-note" data-role="trial-status">Free trial · day ${Math.min(t.day, length)} of ${length} · ends ${formatDayId(t.endsAt)}</p>`}
      ${card({
        body: html`<div class="plan-options" data-role="plan-options">
            ${s.options.flatMap((o) =>
              o.terms.map((term) => {
                const picked = chosen && chosen.planId === o.planId && chosen.termMonths === term.months;
                return html`<button type="button" class="plan-option ${picked ? "is-picked" : ""}" data-act="choose" data-plan="${o.planId}" data-months="${term.months}" ${owner && !state.choosing ? "" : "disabled"} aria-pressed="${picked ? "true" : "false"}">
                  <span class="plan-option-name">${optionLabel(o, term)}${term.bestValue ? html` <span class="badge badge-success" data-role="best-value">BEST VALUE</span>` : ""}</span>
                  ${o.tagline && o.terms.length === 1 ? html`<span class="plan-option-sub">${o.tagline}</span>` : ""}
                  ${o.priceIsMinimum ? html`<span class="plan-option-sub">Your custom design is quoted by Luna.</span>` : ""}
                  ${picked ? html`<span class="plan-option-sub" data-role="chosen">Chosen · pay the bill below to continue</span>` : ""}
                </button>`;
              })
            )}
          </div>
          ${owner ? html`<p class="stat-note">${chosen ? "Paid access starts " + formatDayId(chosen.startDate) + ". You can change your choice until you pay." : "Choose a plan. Your workspace and everything in it stay the same."}</p>` : html`<p class="stat-note" data-role="owner-only">Ask the workspace owner to choose a plan.</p>`}`,
      })}
    </section>`;
  }

  async function load() {
    state.loading = true;
    draw();
    try {
      state.s = (await api("subscription")).subscription;
      state.error = null;
    } catch (err) {
      state.error = err.message || "Couldn't load your subscription.";
    }
    state.loading = false;
    draw();
  }

  // A bill: what it's for, then its breakdown (charges, then what's taken off).
  const billTitle = (inv) => (inv.kind === "upgrade" ? "Upgrade" : inv.kind === "addon" ? inv.lines?.[0]?.label ?? "Add-on" : monthName(inv.period));
  function billRow(inv) {
    const waiting = inv.status === "for_verification";
    const lines = inv.lines || [];
    const adjustments = inv.adjustments || [];
    const showLines = lines.length > 1 || adjustments.length > 0;
    return html`<div class="bill-row" data-period="${inv.period}" data-bill="${inv.id}">
      <div class="bill-main">
        <div class="bill-title">${billTitle(inv)} ${badge(INVOICE_STATUSES[inv.status]?.label ?? inv.status, INVOICE_STATUSES[inv.status]?.tone ?? "neutral")}</div>
        <div class="stat-hint">${inv.planName} · due ${formatDayId(inv.dueDate)}${inv.amountPaid > 0 ? ` · ${money(inv.amountPaid)} already paid` : ""}</div>
        ${showLines ? html`<dl class="bill-lines" data-role="bill-lines">${lines.map((l) => html`<dt>${l.label}</dt><dd>${money(l.amount)}</dd>`)}${adjustments.map((a) => html`<dt>${a.description}</dt><dd class="bill-minus">−${money(a.amount)}</dd>`)}<dt class="bill-total">Amount due</dt><dd class="bill-total">${money(inv.amountDue)}</dd></dl>` : ""}
      </div>
      <div class="bill-end">
        <div class="bill-amount">${money(inv.balance)}</div>
        ${waiting ? html`<span class="stat-hint">Waiting for Luna to confirm</span>` : html`<button type="button" class="btn btn-primary btn-compact" data-act="pay" data-period="${inv.period}" data-id="${inv.id}">Pay</button>`}
      </div>
    </div>`;
  }

  function draw() {
    if (!alive) return;
    const s = state.s;
    const open = s ? s.openInvoices.filter((i) => i.balance > 0) : [];
    const totalDue = open.filter((i) => i.status === "due").reduce((t, i) => t + i.balance, 0);
    render(
      container,
      html`
        ${s?.trial?.open
          ? pageHeader({ title: "Continue with Luna", subtitle: "Choose a plan to keep using your workspace. Nothing you've added is lost." })
          : pageHeader({ title: "Subscription", subtitle: "Your Luna plan, what you owe and your payments to Luna." })}
        ${state.error
          ? card({ body: emptyState({ title: "Couldn't load", body: state.error }) })
          : state.loading || !s
            ? card({ body: skeleton(4) })
            : html`
              ${s.trial?.open ? continueSection(s) : ""}
              ${s.trial?.open && !s.trial.conversion ? "" : html`<section class="card hero-card" data-role="plan">
                <div class="kpis" data-cols="3">
                  <div class="kpi"><div class="kpi-label">Plan</div><div class="kpi-value">${s.plan.name}</div><div class="kpi-hint" data-role="price">${priceLine(s, money)}</div></div>
                  <div class="kpi"><div class="kpi-label">Status</div><div class="kpi-value">${badge(SUBSCRIPTION_LABELS[s.status] ?? s.status, STATUS_TONE[s.status] ?? "neutral")}</div><div class="kpi-hint">${s.paidThrough ? `Paid through ${formatDayId(s.paidThrough)}` : "Not paid yet"}</div></div>
                  <div class="kpi" data-role="amount-due"><div class="kpi-label">Amount due</div><div class="kpi-value">${money(totalDue)}</div><div class="kpi-hint" data-role="next">${nextLine(s)}</div></div>
                </div>
              </section>`}
              ${s.trial?.open && !s.trial.conversion ? "" : html`<section class="section" data-role="bills">
                <h2 class="section-title">Bills</h2>
                ${card({ body: open.length ? html`<div class="bill-list">${open.map(billRow)}</div>` : emptyState({ iconName: "check", title: "You're all paid up", body: s.paidThrough ? `Paid through ${formatDayId(s.paidThrough)}.` : "Nothing to pay right now." }) })}
              </section>`}
              <section class="section" data-role="how-to-pay">
                <h2 class="section-title">How to pay</h2>
                ${card({
                  body: s.instructions
                    ? html`<dl class="dl dl-compact">
                        <dt>Method</dt><dd>Bank transfer</dd>
                        <dt>Bank</dt><dd>${s.instructions.bankName}</dd>
                        <dt>Account name</dt><dd>${s.instructions.accountName}</dd>
                        <dt>Account number</dt><dd data-role="account-number">${s.instructions.accountNumber}</dd>
                      </dl>
                      ${s.instructions.instructions ? html`<p class="stat-note">${s.instructions.instructions}</p>` : ""}
                      <p class="stat-note">Transfer the amount, then press <b>Pay</b> on the bill and add your screenshot or the reference number. Luna confirms it, usually within a business day.</p>`
                    : emptyState({ title: "Payment details coming soon", body: "Luna will share its bank details here." }),
                })}
              </section>
              <section class="section" data-role="history">
                <h2 class="section-title">Payment history</h2>
                ${card({
                  body: s.payments.length
                    ? html`<div class="table-wrap"><table class="table table-compact rows">
                        <thead><tr><th class="m-only"></th><th>For</th><th class="num">Amount</th><th>Paid on</th><th class="col-secondary">Reference</th><th>Status</th></tr></thead>
                        <tbody>${s.payments.map(
                          (p) => html`<tr data-payment="${p.id}">
                            <td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${monthName(p.period)}</span><span class="m-sub">${formatDayId(p.paymentDate)}${p.reference ? ` · ref ${p.reference}` : " · screenshot"}${p.rejectionReason ? ` · ${p.rejectionReason}` : ""}</span></div><div class="m-end">${money(p.amountSubmitted)}<small>${p.statusLabel}</small></div></div></td>
                            <td>${monthName(p.period)}</td><td class="num">${money(p.amountSubmitted)}</td><td>${formatDayId(p.paymentDate)}</td><td class="col-secondary">${p.reference || "Screenshot"}</td>
                            <td>${badge(PAYMENT_STATUSES[p.status]?.label ?? p.status, PAYMENT_STATUSES[p.status]?.tone ?? "neutral")}${p.rejectionReason ? html`<div class="stat-hint" data-role="reason">${p.rejectionReason}</div>` : ""}</td>
                          </tr>`
                        )}</tbody></table></div>`
                    : emptyState({ title: "No payments yet", body: "Payments you send to Luna appear here." }),
                })}
              </section>`}
      `
    );
  }

  function payDialog(inv) {
    const idempotencyKey = newKey();
    const today = businessDate(BILLING_TIMEZONE, now());
    return formDialog({
      title: `Pay ${inv.kind === "upgrade" ? "the upgrade" : inv.kind === "addon" ? `the ${inv.lines?.[0]?.label ?? "add-on"}` : monthName(inv.period)}`,
      intro: `Transfer ${money(inv.balance)} to Luna's account, then add your screenshot or the reference number (one is enough). Luna confirms it; until then it shows For Verification.`,
      fields: [
        { name: "amount", label: "Amount you sent (₱)", value: (inv.balance / 100).toFixed(2), inputmode: "decimal", required: true },
        { name: "paymentDate", label: "Date you paid", type: "date", value: today, max: today, required: true },
        { name: "proof", label: "Screenshot or receipt", type: "file", accept: PHOTO_OR_PDF_ACCEPT },
        { name: "reference", label: "Reference number", hint: "Filled in from the screenshot when Luna can read it; or type it." },
        { name: "note", label: "Note (optional)", type: "textarea" },
      ],
      submitLabel: "Send payment",
      onFormChange: (form) => bindReferenceDetection(form, { detect }),
      onSubmit: async (v) => {
        const amount = Math.round(Number(String(v.amount).replace(/[₱,\s]/g, "")) * 100);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter the amount you sent");
        if (!v.proof && !v.reference.trim()) throw new Error("Add your screenshot or the reference number (one is enough)");
        const proof = await prepareSubscriptionProof(v.proof);
        return api("subscription", { method: "POST", body: { action: "submit", idempotencyKey, payment: { period: inv.period, ...(inv.id ? { invoiceId: inv.id } : {}), amount, paymentDate: v.paymentDate, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}), ...(v.note && v.note.trim() ? { note: v.note.trim() } : {}) }, ...(proof ? { proof } : {}) } });
      },
    });
  }

  async function choose(planId, termMonths) {
    if (state.choosing) return;
    state.choosing = true;
    draw();
    try {
      await api("subscription", { method: "POST", body: { action: "choose", planId, termMonths } });
      toast("Plan chosen. Pay the bill below to continue with Luna.", "success");
      state.choosing = false;
      await load();
      container.querySelector('[data-role="bills"]')?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    } catch (err) {
      state.choosing = false;
      draw();
      toast(err.message || "Couldn't choose that plan", "danger");
    }
  }

  const onClick = async (e) => {
    const pick = e.target.closest('[data-act="choose"]');
    if (pick && container.contains(pick)) return choose(pick.dataset.plan, Number(pick.dataset.months));
    const el = e.target.closest('[data-act="pay"]');
    if (!el || !container.contains(el) || !state.s) return;
    const inv = state.s.openInvoices.find((i) => (el.dataset.id ? i.id === el.dataset.id : i.period === el.dataset.period));
    if (!inv) return;
    try {
      const r = await payDialog(inv);
      if (r) {
        toast(r.alreadySubmitted ? "Already sent: nothing was duplicated." : "Payment sent. Luna will confirm it.", "success");
        load();
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  container.addEventListener("click", onClick);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
  };
}
