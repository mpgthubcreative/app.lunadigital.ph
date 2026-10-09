// Payment reads, straight from Firestore as the signed-in user (rules:
// membership + Payments module + payments.view). Tenant-scoped, limited,
// newest first. Screenshots are NOT read from Storage by the browser; they
// come through POST /api/payments { action: "proof" } after a server check.

import { getFirestoreLite } from "../../lib/firebase.js";
import { runListQuery } from "../../lib/query.js";
import { paymentsQuery } from "@shared/list-queries.js";

export const PAGE_SIZE = 25;
const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// filters: { state?, method?, from?, to? (received day) } (shared/list-queries.js).
export async function listPayments(businessId, { filters = {}, cursor = null, pageSize = PAGE_SIZE } = {}) {
  return runListQuery(businessId, "payments", paymentsQuery(filters), { cursor, pageSize });
}

// Every payment of one order (order detail), oldest first.
export async function listOrderPayments(businessId, orderId) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, getDocs } = lite;
  return docs(await getDocs(query(collection(db, "businesses", businessId, "payments"), where("orderId", "==", orderId), orderBy("createdAt", "asc"), limit(50))));
}
