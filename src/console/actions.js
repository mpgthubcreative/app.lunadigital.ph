// Super Admin subscription actions (2026-10-19; access 2026-10-20): one ⋯
// menu and one set of dialogs, used by the Overview's Needs Attention rows,
// the Businesses list and a business's page. Destructive actions confirm
// first; deleting a business needs its exact name typed. Every action goes
// through POST /api/operator (ctx.call), which checks the operator and audits.
//
// Change access: the product stays; its term, paid-through date, add-ons
// and price change. Change product: only where there's a real choice
// (leaving an older plan: Luna Bridal Custom, a "+" plan).

import { html } from "../lib/html.js";
import { badge, rowMenu } from "../components/ui.js";
import { formDialog } from "../components/form-dialog.js";
import { confirmDialog } from "../components/feedback.js";
import { formatDayId } from "../lib/format.js";
import { SUBSCRIPTION_LABELS, SUBSCRIPTION_ACTIONS, SUBSCRIPTION_ACTION_HELP, planWorkspace, isCatalogPlan, priceLabel, planBilling, termLabel, addOnLabel, monthsText, BILLING_TYPES, ADJUSTMENT_TYPES } from "@shared/index.js";

export const peso = (c) => (c === null || c === undefined ? "—" : `${c < 0 ? "−" : ""}₱${(Math.abs(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const todayManila = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const toCentavos = (v, label, { optional = false } = {}) => {
  const s = String(v ?? "").replace(/[₱,\s]/g, "");
  if (optional && !s) return null;
  const n = Math.round(Number(s) * 100);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}: enter an amount more than ₱0`);
  return n;
};

// "Oct 20, 2027": always with the year (renewals and access ends are a year out).
export function dateText(day) {
  return day ? formatDayId(day) : "—";
}

// The date line for a subscription row, by product:
//   Distributor  Due Nov 20, 2026
//   Household    Access until Oct 19, 2027 / Renewal due Oct 20, 2027
//   Bridal       Access ends Oct 19, 2027
export function whenText(r) {
  if (r.attention) return `${r.attention.what} ${dateText(r.attention.date)}`;
  if (r.trial?.open && !r.trial.conversion) return `Trial ends ${dateText(r.trial.endsAt)}`;
  if (r.billingType === "term") return r.accessUntil ? `Access ends ${dateText(r.accessUntil)}` : "—";
  if (r.billingType === "annual") return r.accessUntil ? `Access until ${dateText(r.accessUntil)}` : r.dueDate ? `Payment due ${dateText(r.dueDate)}` : "—";
  return r.dueDate ? `Due ${dateText(r.dueDate)}` : "—";
}

const STATE = {
  active: ["Active", "success"],
  past_due: ["Past due", "warning"],
  suspended: ["Suspended", "danger"],
  cancelled: ["Cancelled", "neutral"],
  deleted: ["Deleted", "neutral"],
  expiring: ["Expiring soon", "warning"],
  expired: ["Expired", "danger"],
  extended: ["Extended", "info"],
  trial: ["Free trial", "info"],
  trial_ended: ["Trial ended", "danger"],
};
// The one status chip: what needs attention wins (7 days overdue, Due soon…).
export function stateChip(r) {
  if (r.attention && ["overdue", "due", "trial"].includes(r.attention.kind) && !["suspended", "cancelled", "deleted"].includes(r.status)) return badge(r.attention.label, r.attention.tone);
  const [label, tone] = STATE[r.state || r.status] ?? [SUBSCRIPTION_LABELS[r.status] ?? r.status ?? "—", "neutral"];
  return badge(label, tone);
}

const plansFor = (ctx, workspaceId) => ctx.plans.filter((p) => planWorkspace(p) === workspaceId && isCatalogPlan(p));
const planOf = (ctx, id) => ctx.plans.find((p) => p.id === id) ?? null;
// A product sold with terms (not an older plan from before 2026-10-19).
const sold = (p) => Boolean(p?.pricing?.billingType);
// Another product to move to: Bridal Standard ↔ Custom, or off an older plan.
const productChoice = (ctx, r) => {
  const cur = planOf(ctx, r.planId);
  return plansFor(ctx, r.workspaceTemplateId).some((p) => p.id !== r.planId) || !isCatalogPlan(cur) || !sold(cur);
};

// A subscription row on a phone: business name (strongest), plan, then the
// date that matters on its own line (never cut off), then the status chip.
// The ⋯ sits beside it (its own cell).
export function billingCell(r, sub) {
  return html`<td class="m-only"><div class="sa-mcell">
    <span class="m-title sa-wrap">${r.name}</span>
    ${sub ? html`<span class="m-sub sa-wrap">${sub}</span>` : ""}
    <span class="sa-when" data-role="m-when">${whenText(r)}</span>
    <span class="sa-mstate">${stateChip(r)}</span>
  </div></td>`;
}

// The ⋯ menu for a subscription / business row.
export function subscriptionMenu(r, { detail = false, ctx = null } = {}) {
  if (r.status === "deleted") return rowMenu(r.id, [{ act: "s-view", label: "Open" }, { act: "s-restore", label: "Restore business" }], { label: `Actions for ${r.name}` });
  const cur = ctx ? planOf(ctx, r.planId) : null;
  // A free trial (2026-10-21): nothing to record until a plan is chosen.
  const trial = r.trial?.open === true;
  const awaiting = trial && !r.trial.conversion;
  const items = [
    ...(detail ? [] : [{ act: "s-view", label: "Open" }]),
    ...(awaiting ? [] : [{ act: "s-pay", label: "Record payment" }]),
    // Wedding access: the Access choice covers the trial and the terms.
    ...(trial && r.billingType !== "term" ? [{ act: "s-convert", label: r.trial.conversion ? "Change chosen plan" : "Choose plan for customer" }, { act: "s-trial", label: "Restart free trial" }] : []),
    { act: "s-remind", label: "Send notification" },
    ...(!ctx || sold(cur) ? [{ act: "s-access", label: r.billingType === "term" ? "Access" : "Change access" }] : []),
    { act: "s-adjust", label: "Add discount / deduction" },
    { act: "s-date", label: r.billingType === "term" && r.paidThrough ? "Change access end" : "Change due date" },
    ...(!ctx || productChoice(ctx, r) ? [{ act: "s-plan", label: "Change product" }] : []),
    ...(detail ? [] : [{ act: "s-members", label: "Members" }]),
    { sep: true },
    ...(r.status === "active" ? [] : [{ act: "s-active", label: SUBSCRIPTION_ACTIONS.active }]),
    ...(r.status === "active" && r.billingType !== "term" ? [{ act: "s-past_due", label: SUBSCRIPTION_ACTIONS.past_due }] : []),
    ...(r.status === "suspended" ? [] : [{ act: "s-suspended", label: SUBSCRIPTION_ACTIONS.suspended }]),
    ...(r.status === "cancelled" ? [] : [{ act: "s-cancelled", label: SUBSCRIPTION_ACTIONS.cancelled, danger: true }]),
    { act: "s-delete", label: "Delete business", danger: true },
  ];
  return rowMenu(r.id, items, { label: `Actions for ${r.name}` });
}

// Opens / closes the ⋯ menus inside a console view (call first in onclick).
export function toggleMenus(e, root) {
  const btn = e.target.closest('[data-act="row-menu"]');
  const closeAll = (except) => root.querySelectorAll(".menu-wrap[data-menu] > .menu:not([hidden])").forEach((m) => m !== except && (m.hidden = true));
  if (btn) {
    const menu = btn.parentElement.querySelector(".menu");
    closeAll(menu);
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
    return true;
  }
  closeAll(null);
  return false;
}

// Wedding access (Luna Bridal): one Access choice, Free Trial / 3 Months —
// ₱499 / 6 Months — ₱799. It sets the authoritative entitlement on the server
// (badge, term, access end, upgrade rules all follow). Access is not payment.
async function termAccessDialog(ctx, r) {
  const plan = planOf(ctx, r.planId);
  const b = planBilling(plan);
  const current = r.trial?.open ? "trial" : String(r.termMonths ?? "");
  return formDialog({
    title: `Access · ${r.name}`,
    intro: "Access is not payment: a term's price becomes a bill to pay. Record the payment when you receive it.",
    fields: [
      { name: "access", label: "Access", type: "select", options: [{ value: "trial", label: "Free Trial" }, ...b.terms.map((t) => ({ value: String(t.months), label: `${t.months} Months — ${peso(t.price)}` }))], value: current },
      { name: "reason", label: "Reason", required: true },
    ],
    submitLabel: "Save",
    onSubmit: (x) => {
      if (x.access === current) throw new Error("Nothing changed");
      return ctx.call("setTermAccess", { businessId: r.id, access: x.access === "trial" ? "trial" : Number(x.access), reason: x.reason });
    },
  });
}

// Change access: term, paid through, add-ons, price. Sends only what changed.
async function changeAccessDialog(ctx, r) {
  if (r.billingType === "term") return termAccessDialog(ctx, r);
  const plan = planOf(ctx, r.planId);
  if (!sold(plan)) throw new Error(`${plan?.name ?? "This plan"} is an older plan: change the product first.`);
  const b = planBilling(plan);
  const term = r.billingType === "term";
  const qty = (id) => r.addOns?.find((a) => a.id === id)?.qty ?? 0;
  const currentTerm = r.billingType === "monthly" ? (r.prepaidNext ? r.termMonths : 1) : r.termMonths;
  const fields = [
    ...(b.terms.length > 1 ? [{ name: "termMonths", label: r.billingType === "monthly" ? "Next bill covers" : "Term", type: "select", options: b.terms.map((t) => ({ value: String(t.months), label: termLabel(plan, t.months) })), value: String(currentTerm ?? b.defaultTermMonths) }] : []),
    ...(term ? [] : [{ name: "paidThrough", label: "Paid through", type: "date", value: r.paidThrough ?? "", hint: "The last day already paid for. The next bill is due the day after." }]),
    // A flat add-on (Bridal Premium wedding link) is bought by the Owner and paid on its own bill.
    ...b.addOns.filter((a) => !a.flat).map((a) => ({ name: `addon-${a.id}`, label: addOnLabel(a), value: String(qty(a.id)), inputmode: "numeric", hint: "How many (0 for none)" })),
    { name: "price", label: `Price (₱ per ${r.billingType === "monthly" ? "month" : monthsText(r.termMonths ?? b.termMonths)})`, value: r.priceOverride ? String(r.priceOverride / 100) : "", inputmode: "decimal", hint: `Empty: the product's price (${priceLabel(plan)})` },
    { name: "reason", label: "Reason", required: true },
  ];
  return formDialog({
    title: `Change access · ${r.name}`,
    intro: `${plan.name} stays. Change the term, what's paid, extra capacity or the price.`,
    fields,
    submitLabel: "Save",
    onSubmit: (x) => {
      const changes = {};
      if (x.termMonths && Number(x.termMonths) !== currentTerm) changes.termMonths = Number(x.termMonths);
      if (!term && (x.paidThrough || null) !== (r.paidThrough ?? null)) changes.paidThrough = x.paidThrough || null;
      const addOns = {};
      for (const a of b.addOns) {
        const n = Number(String(x[`addon-${a.id}`] ?? "0").trim() || "0");
        if (!Number.isSafeInteger(n) || n < 0 || n > 50) throw new Error(`${a.label}: a whole number from 0 to 50`);
        addOns[a.id] = n;
      }
      if (b.addOns.some((a) => addOns[a.id] !== qty(a.id))) changes.addOns = addOns;
      const price = toCentavos(x.price, "Price", { optional: true });
      if (price !== (r.priceOverride ?? null)) changes.priceOverride = price;
      if (!Object.keys(changes).length) throw new Error("Nothing changed");
      return ctx.call("setAccess", { businessId: r.id, changes, reason: x.reason });
    },
  });
}

// + Add discount / deduction: a line taken off a bill (default: the next
// bill); the product's price never changes. Founding / referral discounts,
// loyalty credits, promos, a waived setup fee, manual adjustments.
export function adjustmentDialog(ctx, r, { invoiceId = null, title = null } = {}) {
  return formDialog({
    title: title ?? `Add discount / deduction · ${r.name}`,
    intro: invoiceId ? "Taken off this bill. Allowed until a payment is recorded on it." : "Taken off the next bill. Allowed until a payment is recorded on it.",
    fields: [
      { name: "type", label: "Type", type: "select", options: Object.entries(ADJUSTMENT_TYPES).map(([value, t]) => ({ value, label: t.label })), value: "discount" },
      { name: "description", label: "Description", required: true, suggestions: ["Founding discount", "Referral discount", "Loyalty credit", "Promo", "Setup fee waived", "Manual adjustment"] },
      { name: "amount", label: "Amount (₱)", inputmode: "decimal", required: true },
    ],
    submitLabel: "Add",
    onSubmit: (x) => ctx.call("addAdjustment", { businessId: r.id, ...(invoiceId ? { invoiceId } : {}), adjustment: { type: x.type, description: x.description.trim(), amount: toCentavos(x.amount, "Amount") } }),
  });
}

// Runs one menu action for row `r`. Returns true when something changed.
export async function runSubscriptionAction(ctx, act, r) {
  const ask = (title, intro, fields, submitLabel, send) => formDialog({ title, intro, fields, submitLabel, onSubmit: send });
  const done = (msg) => {
    ctx.toast(msg, "success");
    return true;
  };
  try {
    if (act === "s-view") return ctx.navigate(`/businesses?b=${r.id}`), false;
    if (act === "s-members") return ctx.navigate(`/businesses?b=${r.id}#members`), false;
    if (act === "s-pay") {
      const v = await ask(`Record payment · ${r.name}`, `${whenText(r)}. Credits the next ${r.termMonths && r.termMonths > 1 ? monthsText(r.termMonths) : "period"} and counts the income.`, [
        { name: "amount", label: "Amount (₱)", value: r.amount ? String(r.amount / 100) : "", inputmode: "decimal", required: true },
        { name: "paymentDate", label: "Paid on", type: "date", value: todayManila(), required: true },
        { name: "reference", label: "Reference (optional)" },
      ], "Mark paid", (x) => {
        const amount = toCentavos(x.amount, "Amount");
        return ctx.call("recordPayment", { businessId: r.id, payment: { amount, paymentDate: x.paymentDate, ...(x.reference.trim() ? { reference: x.reference.trim() } : {}) } });
      });
      return v ? done(v.paidThrough ? `Paid. Covered through ${formatDayId(v.paidThrough)}.` : "Payment recorded.") : false;
    }
    if (act === "s-convert") {
      const products = ctx.plans.filter((p) => planWorkspace(p) === r.workspaceTemplateId && isCatalogPlan(p) && sold(p));
      const choices = products.flatMap((p) => planBilling(p).terms.filter((t) => t.kind !== "trial").map((t) => ({ value: `${p.id}|${t.months}`, label: `${p.name} · ${termLabel(p, t.months)}${planBilling(p).setupFee ? ` + ${peso(planBilling(p).setupFee)} setup` : ""}` })));
      const v = await ask(`Choose plan · ${r.name}`, "Makes the first paid bill (from the day after the trial, or today if it has ended). The trial converts when it's paid.", [
        { name: "choice", label: "Plan", type: "select", options: choices, value: choices.find((c) => c.value.startsWith(`${r.planId}|12`))?.value ?? choices[0]?.value },
        { name: "reason", label: "Reason", required: true, hint: "e.g. Customer asked on Messenger" },
      ], "Choose plan", (x) => {
        const [planId, months] = x.choice.split("|");
        return ctx.call("convertTrial", { businessId: r.id, planId, termMonths: Number(months), reason: x.reason });
      });
      return v ? done(`Plan chosen. Paid access starts ${formatDayId(v.startDate)}.`) : false;
    }
    if (act === "s-trial") {
      const v = await ask(`Restart free trial · ${r.name}`, "Fresh trial dates from today. Their information stays; nothing is billed until a plan is chosen.", [
        { name: "days", label: "Days", value: "30", inputmode: "numeric", required: true },
        { name: "reason", label: "Reason", required: true },
      ], "Restart trial", (x) => {
        const days = Number(x.days);
        if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new Error("Days: 1 to 90");
        return ctx.call("restartTrial", { businessId: r.id, days, reason: x.reason });
      });
      return v ? done("Free trial restarted.") : false;
    }
    if (act === "s-remind") {
      const v = await ask(`Send notification · ${r.name}`, "The owners see it in Luna's notifications.", [{ name: "message", label: "Message (optional)", type: "textarea", hint: `Leave empty to send: ${whenText(r)}, the amount and how to pay.` }], "Send", (x) => ctx.call("sendReminder", { businessId: r.id, ...(x.message.trim() ? { message: x.message.trim() } : {}) }));
      return v ? done("Notification sent.") : false;
    }
    if (act === "s-adjust") {
      const v = await adjustmentDialog(ctx, r);
      return v ? done(`Added. Amount due now ${peso(v.amountDue)}.`) : false;
    }
    if (act === "s-access") {
      const v = await changeAccessDialog(ctx, r);
      return v ? done(v.warnings?.length ? `Saved. ${v.warnings[0]}` : v.amountDue ? `Access changed. ${peso(v.amountDue)} to collect (not counted until paid).` : "Access changed.") : false;
    }
    if (act === "s-date") {
      const term = r.billingType === "term" && r.paidThrough;
      const v = await ask(term ? `Access end · ${r.name}` : `Due date · ${r.name}`, term ? "A later date shows as Extended." : "When the next payment is due.", [
        { name: "date", label: term ? "Access ends" : "Due date", type: "date", value: (term ? r.accessUntil : r.dueDate) ?? todayManila(), required: true },
        { name: "reason", label: "Reason", required: true },
      ], "Save", (x) => ctx.call("setBillingDate", { businessId: r.id, date: x.date, reason: x.reason }));
      return v ? done("Date changed.") : false;
    }
    if (act === "s-plan") {
      const list = plansFor(ctx, r.workspaceTemplateId);
      const v = await ask(`Change product · ${r.name}`, r.billingType === "term" && r.paidThrough ? "The wedding, its data, its links and its access end stay. A pricier product is billed only the difference." : "The business, its data and its dates stay. The new product's price and included limits apply.", [
        { name: "planId", label: "Product", type: "select", options: list.map((p) => ({ value: p.id, label: `${p.name} · ${priceLabel(p)}` })), value: list.find((p) => p.id !== r.planId)?.id ?? list[0]?.id },
        { name: "agreedPrice", label: "Agreed price (₱, optional)", inputmode: "decimal", hint: "For a Custom wedding's quote; empty = the product's price." },
        { name: "reason", label: "Reason", required: true },
      ], "Change product", (x) => {
        const agreedPrice = toCentavos(x.agreedPrice, "Agreed price", { optional: true });
        return ctx.call("changePlan", { businessId: r.id, planId: x.planId, reason: x.reason, ...(agreedPrice ? { agreedPrice } : {}) });
      });
      return v ? done(v.upgradeDue ? `Product changed. Upgrade due: ${peso(v.upgradeDue)}.` : "Product changed.") : false;
    }
    const status = act.startsWith("s-") ? act.slice(2) : null;
    if (Object.hasOwn(SUBSCRIPTION_ACTIONS, status)) {
      const v = await ask(`${SUBSCRIPTION_ACTIONS[status]}?`, `${r.name}. ${SUBSCRIPTION_ACTION_HELP[status]}`, [{ name: "reason", label: "Reason", required: true }], SUBSCRIPTION_ACTIONS[status], (x) => ctx.call("setStatus", { businessId: r.id, status, reason: x.reason }));
      return v ? done(`${SUBSCRIPTION_LABELS[status]}.`) : false;
    }
    if (act === "s-delete") {
      const v = await ask(`Delete ${r.name}?`, `Access stops at once. Data is kept for 30 days and can be restored, then it can be purged. Type ${r.name} to confirm.`, [
        { name: "confirmName", label: `Type ${r.name}`, required: true, autocomplete: "off" },
        { name: "reason", label: "Reason (optional)" },
      ], "Delete business", (x) => {
        if (x.confirmName.trim() !== String(r.name).trim()) throw new Error(`Type the name exactly: ${r.name}`);
        return ctx.call("deleteBusiness", { businessId: r.id, confirmName: x.confirmName.trim(), ...(x.reason.trim() ? { reason: x.reason.trim() } : {}) });
      });
      return v ? done(`Deleted. Recoverable until ${formatDayId(v.purgeAfter)}.`) : false;
    }
    if (act === "s-restore") {
      const ok = await confirmDialog({ title: `Restore ${r.name}?`, body: "Access comes back with the status it had before.", confirmLabel: "Restore" });
      if (!ok) return false;
      await ctx.call("restoreBusiness", { businessId: r.id });
      return done("Restored.");
    }
  } catch (err) {
    ctx.toast(err.message || "Something went wrong", "danger");
  }
  return false;
}

export const billingTypeLabel = (t) => BILLING_TYPES[t]?.label ?? "";
// "Monthly subscription", "3-month access" (Household's or Bridal's chosen term), "12-month access".
export const billingText = (r) => (r.billingType === "annual" || r.billingType === "term" ? `${r.termMonths || 12}-month access` : billingTypeLabel(r.billingType));
// "12 months · ₱1,190", "Monthly · ₱499 (next bill: 3 months prepaid)".
export function termText(r) {
  if (r.billingType === "monthly") return `Monthly${r.prepaidNext ? ` · next bill covers ${monthsText(r.termMonths)}` : ""}`;
  return r.termMonths ? monthsText(r.termMonths) : "—";
}
