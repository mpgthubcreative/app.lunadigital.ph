// Runs a shared list-query spec (shared/list-queries.js) in the browser,
// as the signed-in user, under the Firestore rules. The server exports run
// the same specs, so a download matches the list.

import { getFirestoreLite } from "./firebase.js";
import { ID, mergeParts } from "@shared/list-queries.js";

const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// One page: { rows, hasMore }. `cursor` is the last row of the previous page.
// A multi-part spec (a search) returns its first matches, unpaginated.
export async function runListQuery(businessId, collectionName, spec, { cursor = null, pageSize = 25 } = {}) {
  const { db, lite } = await getFirestoreLite();
  const { collection, query, where, orderBy, limit, startAfter, getDocs, documentId } = lite;
  const ref = collection(db, "businesses", businessId, collectionName);
  const field = (f) => (f === ID ? documentId() : f);
  const base = (part) => [...part.where.map(([f, op, v]) => where(field(f), op, v)), ...part.orderBy.map(([f, dir]) => orderBy(field(f), dir))];

  if (spec.parts.length > 1) {
    const results = await Promise.all(spec.parts.map(async (part) => docs(await getDocs(query(ref, ...base(part), limit(part.limit ?? pageSize))))));
    return { rows: mergeParts(spec, results), hasMore: false };
  }
  const [part] = spec.parts;
  const constraints = base(part);
  if (cursor) constraints.push(startAfter(...part.orderBy.map(([f]) => (f === ID ? cursor.id : cursor[f]))));
  constraints.push(limit(pageSize + 1));
  const rows = docs(await getDocs(query(ref, ...constraints)));
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}
