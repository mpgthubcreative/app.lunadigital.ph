// Super Admin subscription actions (2026-10-19): one ⋯ menu and one set of
// dialogs, used by the Overview's Needs Attention rows, the Businesses list
// and a business's page. Destructive actions confirm first; deleting a
// business needs its exact name typed. Every action goes through
// POST /api/operator (ctx.call), which checks the operator and audits.

import { html } from "../lib/html.js";
import { badge, rowMenu } from "../components/ui.js";
import { formDialog } from "../components/form-dialog.js";
import { confirmDialog } from "../components/feedback.js";
import { formatDayId } from "../lib/format.js";
import { SUBSCRIPTION_LABELS, SUBSCRIPTION_ACTIONS, SUBSCRIPTION_ACTION_HELP, planWorkspace, isCatalogPlan, priceLabel, BILLING_TYPES } from "@shared/index.js";

export const peso = (c) => (c === null || c === undefined ? "—" : `${c < 0 ? "−" : ""}₱${(Math.abs(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const todayManila = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

// "Oct 25" this year, "Oct 19, 2027" otherwise.
export function dateText(day, today = todayManila()) {
  if (!day) return "—";
  const full = formatDayId(day);
  return day.slice(0, 4) === today.slice(0, 4) ? full.replace(/, \d{4}$/, "") : full;
}

// The date line for a subscription row, by billing type.
export function whenText(r) {
  if (r.attention) return `${r.attention.what} ${dateText(r.attention.date)}`;
  if (r.billingType === "term") return r.accessUntil ? `Access until ${dateText(r.accessUntil)}` : "—";
  if (r.dueDate) return `${r.billingType === "annual" ? (r.renewal ? "Renewal due" : "Payment due") : "Next due"} ${dateText(r.dueDate)}`;
  return "—";
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
};
// The one status chip: what needs attention wins (7 days overdue, Due soon…).
export function stateChip(r) {
  if (r.attention && ["overdue", "due"].includes(r.attention.kind) && !["suspended", "cancelled", "deleted"].includes(r.status)) return badge(r.attention.label, r.attention.tone);
  const [label, tone] = STATE[r.state || r.status] ?? [SUBSCRIPTION_LABELS[r.status] ?? r.status ?? "—", "neutral"];
  return badge(label, tone);
}

// The ⋯ menu for a subscription / business row.
export function subscriptionMenu(r, { detail = false } = {}) {
  if (r.status === "deleted") return rowMenu(r.id, [{ act: "s-view", label: "Open" }, { act: "s-restore", label: "Restore business" }], { label: `Actions for ${r.name}` });
  const items = [
    ...(detail ? [] : [{ act: "s-view", label: "Open" }]),
    { act: "s-pay", label: "Record payment" },
    { act: "s-remind", label: "Send notification" },
    { act: "s-date", label: r.billingType === "term" && r.paidThrough ? "Change access end" : "Change due date" },
    { act: "s-plan", label: "Change plan" },
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

const plansFor = (ctx, workspaceId) => ctx.plans.filter((p) => planWorkspace(p) === workspaceId && isCatalogPlan(p));

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
      const v = await ask(`Record payment · ${r.name}`, `${whenText(r)}. Credits the next period and counts the income.`, [
        { name: "amount", label: "Amount (₱)", value: r.amount ? String(r.amount / 100) : "", inputmode: "decimal", required: true },
        { name: "paymentDate", label: "Paid on", type: "date", value: todayManila(), required: true },
        { name: "reference", label: "Reference (optional)" },
      ], "Mark paid", (x) => {
        const amount = Math.round(Number(String(x.amount).replace(/[₱,\s]/g, "")) * 100);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter an amount more than ₱0");
        return ctx.call("recordPayment", { businessId: r.id, payment: { amount, paymentDate: x.paymentDate, ...(x.reference.trim() ? { reference: x.reference.trim() } : {}) } });
      });
      return v ? done(v.paidThrough ? `Paid. Covered through ${formatDayId(v.paidThrough)}.` : "Payment recorded.") : false;
    }
    if (act === "s-remind") {
      const v = await ask(`Send notification · ${r.name}`, "The owners see it in Luna's notifications.", [{ name: "message", label: "Message (optional)", type: "textarea", hint: `Leave empty to send: ${whenText(r)}, the amount and how to pay.` }], "Send", (x) => ctx.call("sendReminder", { businessId: r.id, ...(x.message.trim() ? { message: x.message.trim() } : {}) }));
      return v ? done("Notification sent.") : false;
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
      const v = await ask(`Change plan · ${r.name}`, "New price and limits apply now. Nothing is deleted.", [
        { name: "planId", label: "Plan", type: "select", options: list.map((p) => ({ value: p.id, label: `${p.name} · ${priceLabel(p)}` })), value: list.some((p) => p.id === r.planId) ? r.planId : list[0]?.id },
        { name: "reason", label: "Reason", required: true },
      ], "Change plan", (x) => ctx.call("changePlan", { businessId: r.id, planId: x.planId, reason: x.reason }));
      return v ? done("Plan changed.") : false;
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
