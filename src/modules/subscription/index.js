// Subscription (Phase 18.6): the workspace Owner's Luna plan and payments.
// "What plan do I have, how much do I owe, how do I pay, and has Luna
// confirmed it?" Reads and submits through /api/subscription (own business
// only). Sending a payment only puts it For Verification: Luna confirms it.

import { html, render } from "../../lib/html.js";
import { pageHeader, card, emptyState, badge, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { api as defaultApi } from "../../lib/api.js";
import { prepareProof } from "../../lib/image.js";
import { SUBSCRIPTION_LABELS, businessDate } from "@shared/index.js";
import { INVOICE_STATUSES, PAYMENT_STATUSES, PROOF_MAX_BYTES, BILLING_TIMEZONE } from "@shared/billing.js";

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
export async function prepareSubscriptionProof(file) {
  if (!file) throw new Error("Attach your payment screenshot or receipt");
  if (file.type === "application/pdf") {
    if (file.size > PROOF_MAX_BYTES) throw new Error("The PDF is larger than 3 MB");
    return { contentType: "application/pdf", dataBase64: await readRaw(file) };
  }
  return prepareProof(file);
}

export function mount(container, session, { api = defaultApi, toast = defaultToast, now = () => new Date() } = {}) {
  const state = { loading: true, error: null, s: null };
  let alive = true;
  const money = (c) => formatCentavos(c ?? 0, session.business.currency || "PHP");

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

  function billRow(inv) {
    const waiting = inv.status === "for_verification";
    return html`<div class="bill-row" data-period="${inv.period}">
      <div class="bill-main">
        <div class="bill-title">${monthName(inv.period)} ${badge(INVOICE_STATUSES[inv.status]?.label ?? inv.status, INVOICE_STATUSES[inv.status]?.tone ?? "neutral")}</div>
        <div class="stat-hint">${inv.planName} · due ${formatDayId(inv.dueDate)}${inv.amountPaid > 0 ? ` · ${money(inv.amountPaid)} already paid` : ""}</div>
      </div>
      <div class="bill-end">
        <div class="bill-amount">${money(inv.balance)}</div>
        ${waiting ? html`<span class="stat-hint">Waiting for Luna to confirm</span>` : html`<button type="button" class="btn btn-primary btn-compact" data-act="pay" data-period="${inv.period}">Pay</button>`}
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
        ${pageHeader({ title: "Subscription", subtitle: "Your Luna plan, what you owe and your payments to Luna." })}
        ${state.error
          ? card({ body: emptyState({ title: "Couldn't load", body: state.error }) })
          : state.loading || !s
            ? card({ body: skeleton(4) })
            : html`
              <section class="card hero-card" data-role="plan">
                <div class="kpis" data-cols="3">
                  <div class="kpi"><div class="kpi-label">Plan</div><div class="kpi-value">${s.plan.name}</div><div class="kpi-hint">${s.monthlyAmount ? `${money(s.monthlyAmount)} a month` : ""}</div></div>
                  <div class="kpi"><div class="kpi-label">Status</div><div class="kpi-value">${badge(SUBSCRIPTION_LABELS[s.status] ?? s.status, STATUS_TONE[s.status] ?? "neutral")}</div><div class="kpi-hint">${s.paidThrough ? `Paid through ${formatDayId(s.paidThrough)}` : "Not paid yet"}</div></div>
                  <div class="kpi" data-role="amount-due"><div class="kpi-label">Amount due</div><div class="kpi-value">${money(totalDue)}</div><div class="kpi-hint">${s.nextRenewal ? `Next renewal ${formatDayId(s.nextRenewal)}` : s.current ? `${monthName(s.current.period)} · due ${formatDayId(s.current.dueDate)}` : ""}</div></div>
                </div>
              </section>
              <section class="section" data-role="bills">
                <h2 class="section-title">Bills</h2>
                ${card({ body: open.length ? html`<div class="bill-list">${open.map(billRow)}</div>` : emptyState({ iconName: "check", title: "You're all paid up", body: s.paidThrough ? `Paid through ${formatDayId(s.paidThrough)}.` : "Nothing to pay right now." }) })}
              </section>
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
                      <p class="stat-note">Transfer the amount, then press <b>Pay</b> on the bill and upload your screenshot. Luna confirms it, usually within a business day.</p>`
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
                            <td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${monthName(p.period)}</span><span class="m-sub">${formatDayId(p.paymentDate)} · ref ${p.reference}${p.rejectionReason ? ` · ${p.rejectionReason}` : ""}</span></div><div class="m-end">${money(p.amountSubmitted)}<small>${p.statusLabel}</small></div></div></td>
                            <td>${monthName(p.period)}</td><td class="num">${money(p.amountSubmitted)}</td><td>${formatDayId(p.paymentDate)}</td><td class="col-secondary">${p.reference}</td>
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
      title: `Pay ${monthName(inv.period)}`,
      intro: `Transfer ${money(inv.balance)} to Luna's account, then tell us the details. Luna confirms it; until then it shows For Verification.`,
      fields: [
        { name: "amount", label: "Amount you sent (₱)", value: (inv.balance / 100).toFixed(2), inputmode: "decimal", required: true },
        { name: "paymentDate", label: "Date you paid", type: "date", value: today, max: today, required: true },
        { name: "reference", label: "Reference number", required: true, hint: "From your bank app or receipt" },
        { name: "proof", label: "Screenshot or receipt", type: "file", accept: "image/jpeg,image/png,image/webp,application/pdf" },
        { name: "note", label: "Note (optional)", type: "textarea" },
      ],
      submitLabel: "Send payment",
      onSubmit: async (v) => {
        const amount = Math.round(Number(String(v.amount).replace(/[₱,\s]/g, "")) * 100);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter the amount you sent");
        const proof = await prepareSubscriptionProof(v.proof);
        return api("subscription", { method: "POST", body: { action: "submit", idempotencyKey, payment: { period: inv.period, amount, paymentDate: v.paymentDate, reference: v.reference.trim(), ...(v.note && v.note.trim() ? { note: v.note.trim() } : {}) }, proof } });
      },
    });
  }

  const onClick = async (e) => {
    const el = e.target.closest('[data-act="pay"]');
    if (!el || !container.contains(el) || !state.s) return;
    const inv = state.s.openInvoices.find((i) => i.period === el.dataset.period);
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
