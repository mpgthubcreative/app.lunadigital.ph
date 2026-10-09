// Customer reads, straight from Firestore as the signed-in user (rules:
// membership + Customers module + customers.view; a customer's order
// history additionally needs orders.view). Every query is tenant-scoped
// and limited. All writes go through POST /api/customers.

import { getFirestoreLite } from "../../lib/firebase.js";
import { runListQuery } from "../../lib/query.js";
import { customersQuery } from "@shared/list-queries.js";

export const PAGE_SIZE = 25;
export const HISTORY_SIZE = 25;

const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// One page of customers by name. Search: name prefix (case-insensitive).
// (shared/list-queries.js: the Customers export reads the same query.)
export async function listCustomers(businessId, { status = "active", search = "", cursor = null, pageSize = PAGE_SIZE } = {}) {
  const page = await runListQuery(businessId, "customers", customersQuery({ status, search }), { cursor, pageSize });
  // A search shows its first matches (no further pages), as before.
  return search.trim() ? { rows: page.rows, hasMore: false } : page;
}

// The order editor's customer picker: active customers by name prefix.
export async function searchCustomers(businessId, term, max = 8) {
  if (!term.trim()) return [];
  return (await listCustomers(businessId, { status: "active", search: term, pageSize: max })).rows;
}

export async function getCustomer(businessId, customerId) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "customers", customerId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Newest orders for one customer (needs orders.view).
export async function listCustomerOrders(businessId, customerId, max = HISTORY_SIZE) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, getDocs } = lite;
  return docs(await getDocs(query(collection(db, "businesses", businessId, "orders"), where("customerId", "==", customerId), orderBy("createdAt", "desc"), limit(max))));
}
