// Reads the dashboard's metric documents straight from Firestore as the
// signed-in user; the rules decide (membership + permission + Dashboard
// module + subscription). One getDoc per document from dashboardDocuments():
// a few per source (at most ~72 for a full year), regardless of how many
// orders the business has. No
// collection is ever downloaded to compute a total.

import { getFirestoreLite } from "../../lib/firebase.js";
import { listLowStock } from "../inventory/data.js";
import { listRecentOrders } from "../orders/data.js";
import { combineDashboardDocs } from "@shared/dashboard.js";

// Ready list widgets -> their (small, limited) query.
const LIST_FETCHERS = {
  recentOrders: (businessId) => listRecentOrders(businessId, 5),
  lowStockItems: (businessId) => listLowStock(businessId, 5),
};

// widgets: ready list widgets -> { [widgetId]: { status, rows } }
export async function fetchDashboardLists(businessId, widgets) {
  const entries = await Promise.all(
    widgets
      .filter((w) => LIST_FETCHERS[w.id])
      .map(async (w) => {
        try {
          return [w.id, { status: "ok", rows: await LIST_FETCHERS[w.id](businessId) }];
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
