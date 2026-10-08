// Inventory reads, straight from Firestore as the signed-in user (rules:
// membership + Inventory module + inventory.view; costs need
// inventory.costs). Every query is tenant-scoped and limited; nothing loads
// a whole collection. All writes go through /api/products and /api/inventory.

import { getFirestoreLite } from "../../lib/firebase.js";

export const PAGE_SIZE = 25;
export const HISTORY_PAGE_SIZE = 20;

const path = (bid, collection) => ["businesses", bid, collection];

function docs(snap) {
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// One page of products. `cursor` is the last row of the previous page.
// Search: name prefix (case-insensitive) or an exact SKU.
export async function listProducts(businessId, { status = "active", lowOnly = false, search = "", cursor = null, pageSize = PAGE_SIZE } = {}) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, startAfter, startAt, endAt, getDocs, documentId } = lite;
  const ref = collection(db, ...path(businessId, "products"));
  const term = search.trim();

  if (term) {
    const lowerTerm = term.toLocaleLowerCase("en");
    const [byName, bySku] = await Promise.all([
      getDocs(query(ref, where("status", "==", status), orderBy("nameLower"), startAt(lowerTerm), endAt(`${lowerTerm}\uf8ff`), limit(pageSize))),
      getDocs(query(ref, where("sku", "==", term.toUpperCase()), limit(1))),
    ]);
    const seen = new Map();
    for (const p of [...docs(bySku), ...docs(byName)]) if (p.status === status && (!lowOnly || p.isLowStock)) seen.set(p.id, p);
    return { rows: [...seen.values()], hasMore: false };
  }

  const constraints = [where("status", "==", status)];
  if (lowOnly) constraints.push(where("isLowStock", "==", true));
  // Name, then document id: duplicate names never skip or repeat across pages.
  constraints.push(orderBy("nameLower"), orderBy(documentId()));
  if (cursor) constraints.push(startAfter(cursor.nameLower, cursor.id));
  constraints.push(limit(pageSize + 1));
  const rows = docs(await getDocs(query(ref, ...constraints)));
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

// Cost documents for the given ids, at most 30 per `in` query.
export async function loadCostDocs(businessId, collectionName, ids) {
  if (!ids.length) return {};
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, documentId, getDocs } = lite;
  const out = {};
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await getDocs(query(collection(db, ...path(businessId, collectionName)), where(documentId(), "in", ids.slice(i, i + 30))));
    for (const d of snap.docs) out[d.id] = d.data();
  }
  return out;
}

// Newest-first movement history for one product, paginated by seq.
export async function listHistory(businessId, productId, { beforeSeq = null, pageSize = HISTORY_PAGE_SIZE } = {}) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = lite;
  const constraints = [where("productId", "==", productId), orderBy("seq", "desc")];
  if (beforeSeq !== null) constraints.push(startAfter(beforeSeq));
  constraints.push(limit(pageSize + 1));
  const rows = docs(await getDocs(query(collection(db, ...path(businessId, "inventoryTransactions")), ...constraints)));
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

// Dashboard: the low-stock list (one equality query, limit 5).
export async function listLowStock(businessId, max = 5) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, limit, getDocs } = lite;
  return docs(await getDocs(query(collection(db, ...path(businessId, "products")), where("isLowStock", "==", true), limit(max))));
}
