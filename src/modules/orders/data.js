// Order reads, straight from Firestore as the signed-in user (rules:
// membership + Orders module + orders.view; orderCosts additionally needs
// dashboard.financials). Every query is tenant-scoped, newest first, and
// limited. All writes go through POST /api/orders.

import { getFirestoreLite } from "../../lib/firebase.js";

export const PAGE_SIZE = 25;

const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// filters: { fulfillmentStatus?, paymentStatus?, source?, day? (YYYY-MM-DD) }
export async function listOrders(businessId, { filters = {}, cursor = null, pageSize = PAGE_SIZE } = {}) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = lite;
  const constraints = [];
  if (filters.fulfillmentStatus) constraints.push(where("fulfillmentStatus", "==", filters.fulfillmentStatus));
  if (filters.paymentStatus) constraints.push(where("paymentStatus", "==", filters.paymentStatus));
  if (filters.source) constraints.push(where("source", "==", filters.source));
  if (filters.day) constraints.push(where("orderDate", "==", filters.day));
  constraints.push(orderBy("createdAt", "desc"));
  if (cursor) constraints.push(startAfter(cursor.createdAt));
  constraints.push(limit(pageSize + 1));
  const rows = docs(await getDocs(query(collection(db, "businesses", businessId, "orders"), ...constraints)));
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

export async function getOrder(businessId, orderId) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "orders", orderId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Only call with dashboard.financials (the rules refuse everyone else).
export async function getOrderCosts(businessId, orderId) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "orderCosts", orderId));
  return snap.exists() ? snap.data() : null;
}

// Current product documents for the given ids (availability / today's price
// in the order form). Display only; the server re-reads them when saving.
export async function getProducts(businessId, ids) {
  if (!ids.length) return {};
  const { db, lite } = await getFirestoreLite();
  const out = {};
  await Promise.all(
    ids.map(async (id) => {
      const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "products", id));
      if (snap.exists()) out[id] = { id, ...snap.data() };
    })
  );
  return out;
}

// Dashboard: newest five orders.
export async function listRecentOrders(businessId, max = 5) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, orderBy, limit, getDocs } = lite;
  return docs(await getDocs(query(collection(db, "businesses", businessId, "orders"), orderBy("createdAt", "desc"), limit(max))));
}
