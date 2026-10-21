// Owner-pilot (Bridal UX): the wedding's "needs attention" items for the
// bell (no Wedding Dashboard in the navigation any more). Worked out from
// the records each time; an item goes away only when it's actually done
// (the payment is paid or cancelled, the task completed or re-dated).
// READ is not RESOLVED: each item carries this person's seen mark
// (members/{uid}/inboxState/attention, shared with Household).
//
//   paymentOverdue  a scheduled supplier payment past its due date
//   paymentDue      one due within DUE_SOON_DAYS (today included)
//   taskOverdue     an open task past its due date
//
// Payments need vendorpayments.view, tasks need tasks.view. Nothing is stored.

import { businessDate, addDays } from "../../../shared/metrics.js";
import { DUE_SOON_DAYS } from "../../../shared/wedding.js";
import { readAttentionState } from "./notifications.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const enc = encodeURIComponent;
const MAX_ROWS = 300;

export async function weddingAttention({ tenant, business, permissions = {}, uid = null, now = new Date() }) {
  const today = businessDate(business.timezone, now);
  const soon = addDays(today, DUE_SOON_DAYS);
  const when = (d) => (d === today ? "today" : d === addDays(today, -1) ? "yesterday" : d === addDays(today, 1) ? "tomorrow" : dayText(d));
  const todos = [];
  const todo = (group, kind, about, text, href, sort) => todos.push({ id: `${kind}:${about}`.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 120), staffId: group, name: group === "money" ? "Expenses" : "Tasks", kind, text, href, sort });

  const [payments, tasks] = await Promise.all([
    permissions["vendorpayments.view"] === true ? tenant.collection("supplierPayments").where("status", "==", "upcoming").limit(MAX_ROWS).get() : null,
    permissions["tasks.view"] === true ? tenant.collection("weddingTasks").where("open", "==", true).limit(MAX_ROWS).get() : null,
  ]);
  for (const d of payments?.docs || []) {
    const p = d.data();
    if (typeof p.dueDate !== "string" || p.dueDate > soon) continue;
    const who = p.supplierName || "a supplier";
    const href = p.supplierId ? `/wedding-suppliers?supplier=${enc(p.supplierId)}` : "/wedding-suppliers";
    if (p.dueDate < today) todo("money", "paymentOverdue", d.id, `${who}: ${p.description} (${peso(p.amount)}) is overdue, due ${when(p.dueDate)}.`, href, `0${p.dueDate}`);
    else todo("money", "paymentDue", d.id, `${who}: ${p.description} (${peso(p.amount)}) is due ${when(p.dueDate)}.`, href, `1${p.dueDate}`);
  }
  for (const d of tasks?.docs || []) {
    const t = d.data();
    if (typeof t.dueDate === "string" && t.dueDate < today) todo("tasks", "taskOverdue", d.id, `"${t.title}" was due ${when(t.dueDate)}.`, `/wedding-tasks?task=${enc(d.id)}`, `0${t.dueDate}`);
  }
  const seen = uid ? await readAttentionState({ tenant, uid }) : () => false;
  const order = { money: 0, tasks: 1 };
  return {
    asOf: today,
    todos: todos.sort((a, b) => order[a.staffId] - order[b.staffId] || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0)).map(({ sort, ...t }) => ({ ...t, read: seen(t.id) })),
  };
}
