// Expense reads, straight from Firestore as the signed-in user (rules:
// membership + Expenses module + expenses.view). Every query is
// tenant-scoped, filtered and limited; the browser never loads the whole
// expense history. All writes go through POST /api/expenses.

import { getFirestoreLite } from "../../lib/firebase.js";

export const PAGE_SIZE = 25;

const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// filters: { status ("active" | "removed"), from?, to? (YYYY-MM-DD),
// category?, method?, search? (payee prefix, or an exact reference) }.
// Newest date first; `cursor` is the last row of the previous page.
export async function listExpenses(businessId, { filters = {}, cursor = null, pageSize = PAGE_SIZE } = {}) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, startAfter, startAt, endAt, getDocs, documentId } = lite;
  const ref = collection(db, "businesses", businessId, "expenses");
  const status = filters.status || "active";
  const term = (filters.search || "").trim();

  if (term) {
    const lower = term.toLocaleLowerCase("en");
    const [byPayee, byRef] = await Promise.all([
      getDocs(query(ref, where("status", "==", status), orderBy("payeeLower"), startAt(lower), endAt(`${lower}`), limit(pageSize))),
      getDocs(query(ref, where("status", "==", status), where("reference", "==", term), limit(pageSize))),
    ]);
    const seen = new Map();
    for (const e of [...docs(byRef), ...docs(byPayee)]) seen.set(e.id, e);
    return { rows: [...seen.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)), hasMore: false };
  }

  const constraints = [where("status", "==", status)];
  if (filters.category) constraints.push(where("category", "==", filters.category));
  if (filters.method) constraints.push(where("method", "==", filters.method));
  if (filters.from) constraints.push(where("date", ">=", filters.from));
  if (filters.to) constraints.push(where("date", "<=", filters.to));
  // Date, then document id: same-day expenses never skip or repeat across pages.
  constraints.push(orderBy("date", "desc"), orderBy(documentId(), "desc"));
  if (cursor) constraints.push(startAfter(cursor.date, cursor.id));
  constraints.push(limit(pageSize + 1));
  const rows = docs(await getDocs(query(ref, ...constraints)));
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}
