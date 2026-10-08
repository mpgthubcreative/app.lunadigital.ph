// Payment reads, straight from Firestore as the signed-in user (rules:
// membership + Payments module + payments.view). Tenant-scoped, limited,
// newest first. Screenshots are NOT read from Storage by the browser; they
// come through POST /api/payments { action: "proof" } after a server check.

import { getFirestoreLite } from "../../lib/firebase.js";

export const PAGE_SIZE = 25;
const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// filters: { state?, method? }
export async function listPayments(businessId, { filters = {}, cursor = null, pageSize = PAGE_SIZE } = {}) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = lite;
  const constraints = [];
  if (filters.state) constraints.push(where("state", "==", filters.state));
  if (filters.method) constraints.push(where("method", "==", filters.method));
  constraints.push(orderBy("createdAt", "desc"));
  if (cursor) constraints.push(startAfter(cursor.createdAt));
  constraints.push(limit(pageSize + 1));
  const rows = docs(await getDocs(query(collection(db, "businesses", businessId, "payments"), ...constraints)));
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

// Every payment of one order (order detail), oldest first.
export async function listOrderPayments(businessId, orderId) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, getDocs } = lite;
  return docs(await getDocs(query(collection(db, "businesses", businessId, "payments"), where("orderId", "==", orderId), orderBy("createdAt", "asc"), limit(50))));
}
