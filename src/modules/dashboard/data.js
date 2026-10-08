// Reads the dashboard's metric documents straight from Firestore as the
// signed-in user; the rules decide (membership + permission + Dashboard
// module + subscription). One getDoc per document from dashboardDocuments():
// at most four, regardless of how many orders the business has. No
// collection is ever downloaded to compute a total.

import { getFirestoreLite } from "../../lib/firebase.js";

// documents: [{ source, collection, id }] -> { [source]: { status, data } }
export async function fetchMetricDocuments(businessId, documents) {
  if (!documents.length) return {};
  const { db, lite } = await getFirestoreLite();
  const { doc, getDoc } = lite;
  const entries = await Promise.all(
    documents.map(async (d) => {
      try {
        const snap = await getDoc(doc(db, "businesses", businessId, d.collection, d.id));
        return [d.source, snap.exists() ? { status: "ok", data: snap.data() } : { status: "missing", data: null }];
      } catch (err) {
        console.error(`dashboard: couldn't read ${d.collection}/${d.id}:`, err && err.code);
        return [d.source, { status: "error", data: null }];
      }
    })
  );
  return Object.fromEntries(entries);
}
