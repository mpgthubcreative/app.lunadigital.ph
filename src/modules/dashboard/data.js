// Reads the dashboard's metric documents straight from Firestore as the
// signed-in user; the rules decide (membership + permission + Dashboard
// module + subscription). One getDoc per document from dashboardDocuments():
// a few per source (at most ~72 for a full year), regardless of how many
// orders the business has. No
// collection is ever downloaded to compute a total.

import { getFirestoreLite } from "../../lib/firebase.js";
import { listLowStock } from "../inventory/data.js";
import { listRecentOrders } from "../orders/data.js";
import { listAttendance, listPayrolls, listAdvances } from "../household/data.js";
import { getBudget, listCategories, listScheduled, listBabyExpenses } from "../baby/data.js";
import { budgetLines } from "@shared/baby.js";
import { listSupplierPayments, listTasks, listWeddingExpenses, getGuestTotals } from "../wedding/data.js";
import { rsvpSummary } from "@shared/wedding.js";
import { combineDashboardDocs } from "@shared/dashboard.js";

// Ready list widgets -> their (small, limited) query. ctx: { today }.
const first = (page) => page.rows;
const LIST_FETCHERS = {
  recentOrders: (businessId) => listRecentOrders(businessId, 5),
  lowStockItems: (businessId) => listLowStock(businessId, 5),
  attendanceToday: (businessId, { today }) => listAttendance(businessId, { from: today, to: today }, { pageSize: 10 }).then(first),
  payrollsToRelease: (businessId) => listPayrolls(businessId, { status: "draft" }).then((p) => p.rows.slice(0, 5)),
  awaitingReceipt: (businessId) => listPayrolls(businessId, { receiptStatus: "awaiting" }).then((p) => p.rows.slice(0, 5)),
  advancesNotPaid: (businessId) => listAdvances(businessId, { status: "not_yet_paid" }).then((p) => p.rows.slice(0, 5)),
  // Phase 15 (Baby): the budget lines (as of now), soonest payments, latest expenses.
  spendingByCategory: async (businessId) => {
    const [budget, categories] = await Promise.all([getBudget(businessId), listCategories(businessId)]);
    return budgetLines(budget, categories).filter((l) => l.status === "active" || l.spent);
  },
  upcomingPayments: (businessId) => listScheduled(businessId, { status: "upcoming" }, { pageSize: 5 }).then(first),
  recentExpenses: (businessId) => listBabyExpenses(businessId, { status: "active" }, { pageSize: 5 }).then(first),
  // Phase 16 (Wedding): soonest supplier payments, open tasks by due date
  // (overdue first), latest expenses, and the RSVP totals as a short list.
  upcomingSupplierPayments: (businessId) => listSupplierPayments(businessId, { status: "upcoming" }, { pageSize: 5 }).then(first),
  tasksDueSoon: async (businessId, { today }) => (await listTasks(businessId, { state: "open" }, { today, pageSize: 20 })).rows.filter((t) => t.dueDate).slice(0, 5),
  recentWeddingExpenses: (businessId) => listWeddingExpenses(businessId, { status: "active" }, { pageSize: 5 }).then(first),
  rsvpSummary: async (businessId) => {
    const t = rsvpSummary(await getGuestTotals(businessId));
    return t.invitations ? [{ id: "attending", ...t, row: "attending" }, { id: "declined", ...t, row: "declined" }, { id: "awaiting", ...t, row: "awaiting" }] : [];
  },
};

// widgets: ready list widgets -> { [widgetId]: { status, rows } }
export async function fetchDashboardLists(businessId, widgets, ctx = {}) {
  const entries = await Promise.all(
    widgets
      .filter((w) => LIST_FETCHERS[w.id])
      .map(async (w) => {
        try {
          return [w.id, { status: "ok", rows: await LIST_FETCHERS[w.id](businessId, ctx) }];
        } catch (err) {
          console.error(`dashboard: list ${w.id} failed:`, err && err.code);
          return [w.id, { status: "error", rows: [] }];
        }
      })
  );
  return Object.fromEntries(entries);
}

// documents: [{ source, collection, ids }] (shared/dashboard.js) ->
// { [source]: { status, data } }. A period's documents are summed with the
// same function Reports uses (combineDashboardDocs); none at all is
// "missing" ("No data yet"), never 0.
export async function fetchMetricDocuments(businessId, documents) {
  if (!documents.length) return {};
  const { db, lite } = await getFirestoreLite();
  const { doc, getDoc } = lite;
  const entries = await Promise.all(
    documents.map(async (d) => {
      try {
        if (d.count) {
          const q = lite.query(lite.collection(db, "businesses", businessId, d.collection), ...d.where.map(([f, op, v]) => lite.where(f, op, v)));
          return [d.source, { status: "ok", data: { count: (await lite.getCount(q)).data().count } }];
        }
        const snaps = await Promise.all(d.ids.map((id) => getDoc(doc(db, "businesses", businessId, d.collection, id))));
        const data = combineDashboardDocs(d.source, snaps.map((s) => (s.exists() ? s.data() : null)));
        return [d.source, data ? { status: "ok", data } : { status: "missing", data: null }];
      } catch (err) {
        console.error(`dashboard: couldn't read ${d.collection}:`, err && err.code);
        return [d.source, { status: "error", data: null }];
      }
    })
  );
  return Object.fromEntries(entries);
}
