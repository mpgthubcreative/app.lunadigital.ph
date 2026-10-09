// Pure dashboard view model: visible widgets (shared/dashboard.js) + the
// fetched metric documents -> what each card shows. No formulas here: money
// figures come from shared/finance.js financialSummary, counts straight
// from the documents. Nothing is invented: a missing document or field is
// "No data yet", never 0.

import { resolveDashboard, dashboardDocuments, dashboardCounts, widgetSourceKey, widgetValue, businessDate, formatQuantity, UNITS, isWidgetLive, FULFILLMENT_STATUSES, ATTENDANCE_STATUSES, TASK_STATUSES } from "@shared/index.js";
import { formatCentavos, formatNumber } from "../../lib/format.js";

// Row shapes per list widget (only fields everyone allowed to see the list may see).
const LIST_ROWS = {
  recentOrders: (o) => ({ id: o.id, title: `${o.orderNumber} · ${o.customer?.name ?? ""}`, detail: `${o.itemCount} item(s) · ${FULFILLMENT_STATUSES[o.fulfillmentStatus]?.label ?? o.fulfillmentStatus}` }),
  attendanceToday: (a) => ({ id: a.id, title: a.staffName, detail: ATTENDANCE_STATUSES[a.status]?.label ?? a.status }),
  payrollsToRelease: (p) => ({ id: p.id, title: `${p.staffName} · ${formatCentavos(p.netPay)}`, detail: `${p.periodStart} to ${p.periodEnd} · not yet paid` }),
  awaitingReceipt: (p) => ({ id: p.id, title: `${p.staffName} · ${formatCentavos(p.salary?.amount ?? p.netPay)}`, detail: `Paid ${p.salary?.paidDate ?? ""} · awaiting the employee's confirmation` }),
  advancesNotPaid: (a) => ({ id: a.id, title: `${a.staffName} · ${formatCentavos(a.amount)}`, detail: `${a.date}${a.description ? ` · ${a.description}` : ""} · not yet paid` }),
  spendingByCategory: (l) => ({ id: l.id, title: `${l.name} · ${formatCentavos(l.spent)} spent`, detail: l.budget === null ? "No category budget" : l.remaining < 0 ? `Budget ${formatCentavos(l.budget)} · over by ${formatCentavos(-l.remaining)}` : `Budget ${formatCentavos(l.budget)} · ${formatCentavos(l.remaining)} left` }),
  upcomingPayments: (s) => ({ id: s.id, title: `${s.description} · ${formatCentavos(s.amount)}`, detail: `Due ${s.dueDate}${s.payee ? ` · ${s.payee}` : ""}` }),
  recentExpenses: (e) => ({ id: e.id, title: `${e.categoryName ?? "Expense"} · ${formatCentavos(e.amount)}`, detail: `${e.date}${e.payee ? ` · ${e.payee}` : ""}` }),
  upcomingSupplierPayments: (p) => ({ id: p.id, title: `${p.supplierName} · ${formatCentavos(p.amount)}`, detail: `${p.description} · due ${p.dueDate}` }),
  tasksDueSoon: (t) => ({ id: t.id, title: t.title, detail: `Due ${t.dueDate}${t.assignee ? ` · ${t.assignee}` : ""} · ${TASK_STATUSES[t.status]?.label ?? t.status}` }),
  recentWeddingExpenses: (e) => ({ id: e.id, title: `${e.categoryName ?? "Expense"} · ${formatCentavos(e.amount)}`, detail: `${e.date}${e.payee ? ` · ${e.payee}` : ""}` }),
  // Invitations vs people, labelled separately.
  rsvpSummary: (r) =>
    r.row === "attending"
      ? { id: r.id, title: `Attending: ${r.attendingSeats} people`, detail: `${r.attending} invitation(s) of ${r.invitations}` }
      : r.row === "declined"
        ? { id: r.id, title: `Declined: ${r.declined} invitation(s)`, detail: `${r.declinedSeats} people` }
        : { id: r.id, title: `Awaiting RSVP: ${r.awaiting} invitation(s)`, detail: `${r.awaitingSeats} people not yet answered` },
  lowStockItems: (p) => ({ id: p.id, title: p.name, detail: `${p.sku} · ${formatQuantity(p.available)} ${UNITS[p.unit]?.label ?? p.unit} available · reorder at ${formatQuantity(p.reorderLevel)}` }),
};

export const NO_DATA = "No data yet";

// docs: { [source]: { status: "ok" | "missing" | "error", data } }
function valueFor(widget, docs) {
  if (!isWidgetLive(widget)) return { state: "empty" };
  const entry = docs[widgetSourceKey(widget)];
  if (!entry || entry.status === "loading") return { state: "loading" };
  if (entry.status === "error") return { state: "error" };
  if (entry.status !== "ok" || !entry.data) return { state: "empty" };
  const raw = widgetValue(widget, entry.data);
  return raw === null || raw === undefined ? { state: "empty" } : { state: "ok", raw };
}

function display(widget, result, currency) {
  if (result.state === "loading") return { text: "…", empty: true };
  if (result.state === "error") return { text: "Couldn't load", empty: true };
  if (result.state === "empty") return { text: NO_DATA, empty: true };
  return { text: widget.format === "money" ? formatCentavos(result.raw, currency) : formatNumber(result.raw), empty: false };
}

// range: { from, to } business-local days (default: the business's today).
export function dashboardPlan(session, now = new Date(), range = null) {
  const widgets = resolveDashboard({ entitlements: session.entitlements, permissions: session.member.permissions });
  const day = businessDate(session.business.timezone, now);
  const period = range || { from: day, to: day };
  // Count widgets (e.g. overdue tasks) are live queries against today, read
  // alongside the documents: { source: "count:<id>", collection, where, count: true }.
  const counts = dashboardCounts(widgets, day).map((c) => ({ source: c.key, collection: c.collection, where: c.where, count: true }));
  return { day, range: period, widgets, documents: [...dashboardDocuments(widgets, period), ...counts] };
}

export function buildDashboardView({ session, widgets, docs, lists = {} }) {
  const currency = session.business.currency || "PHP";
  const cards = widgets
    .filter((w) => w.kind === "stat")
    .map((w) => {
      const result = valueFor(w, docs);
      const shown = display(w, result, currency);
      return { id: w.id, section: w.section, label: w.label, value: shown.text, empty: shown.empty, state: result.state, hint: w.hint || "", note: w.note || "" };
    });
  const listViews = widgets
    .filter((w) => w.kind === "list")
    .map((w) => {
      const loaded = lists[w.id];
      const rows = loaded && loaded.status === "ok" && LIST_ROWS[w.id] ? loaded.rows.map(LIST_ROWS[w.id]) : [];
      return { id: w.id, label: w.label, empty: w.empty, ready: w.ready === true, status: w.ready ? (loaded ? loaded.status : "loading") : "not-ready", rows };
    });
  return { cards, lists: listViews };
}
