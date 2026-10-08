// Import History reads, straight from Firestore as the signed-in user
// (rules: membership + Imports module + imports.run). Bounded: 25 jobs per
// page; a job's rows are at most 10 chunk documents (2,000 rows).

import { getFirestoreLite } from "../../lib/firebase.js";

export const PAGE_SIZE = 25;
const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

export async function listImports(businessId, { cursor = null, pageSize = PAGE_SIZE } = {}) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, orderBy, limit, startAfter, getDocs } = lite;
  const constraints = [orderBy("createdAt", "desc")];
  if (cursor) constraints.push(startAfter(cursor.createdAt));
  constraints.push(limit(pageSize + 1));
  const rows = docs(await getDocs(query(collection(db, "businesses", businessId, "imports"), ...constraints)));
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

// Every row of one import with its result, in order.
export async function getImportRows(businessId, importId) {
  const { db, lite } = await getFirestoreLite();
  const { collection, getDocs } = lite;
  const chunks = docs(await getDocs(collection(db, "businesses", businessId, "imports", importId, "rows"))).sort((a, b) => a.index - b.index);
  return chunks.flatMap((c) => c.rows.map((r, i) => ({ ...r, result: c.results?.[i] ?? null })));
}
