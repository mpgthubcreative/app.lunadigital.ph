// Luna Export Core, server side (Phase 12.5). Every Excel download runs
// through runExport():
//
//   1. access   requireTenant (membership, subscription, the dataset's
//               module + export permission; done by the endpoint) and here
//               again: module usable + every view permission + export
//               permission (canExport).
//   2. filters  validated against the dataset's schema (unknown filters,
//               bad values and ranges are refused).
//   3. rows     the dataset's builder reads with the SAME query specs as the
//               on-screen lists (shared/list-queries.js), page by page
//               (1,000 per read), until every matching row is in, or refuses
//               the export once it passes EXPORT_MAX_ROWS (no truncation).
//               Builders read restricted data (costs, money) only when the
//               caller may receive it; they never fetch-then-hide.
//   4. file     writeXlsx (shared/xlsx.js: formula-safe text, no formulas)
//               plus an "Export info" sheet (business, filters, rows, who,
//               when in the business timezone) and document properties.
//   5. trace    one small auditLog entry (dataset, filters, row count; no
//               exported data) and usage/{month} exportsGenerated /
//               rowsExported counters for future metering (no limits yet).

import { writeXlsx } from "../../../shared/xlsx.js";
import { EXPORT_MAX_ROWS, ExportError, TOO_MANY_ROWS_MESSAGE, validateExportFilters, canExport, describeFilters, pairsSheet, exportFileName } from "../../../shared/exports.js";
import { ID, mergeParts } from "../../../shared/list-queries.js";
import { businessDate } from "../../../shared/metrics.js";
import { monthKey } from "./usage.js";

const READ_PAGE = 1000;
const tooMany = () => new ExportError("too-many-rows", TOO_MANY_ROWS_MESSAGE);

// Every row of a list-query spec, at most `max` (more -> too-many-rows).
export async function readRows({ tenant, collection, spec, FieldPath, max = EXPORT_MAX_ROWS }) {
  const field = (f) => (f === ID ? FieldPath.documentId() : f);
  const base = (part) => {
    let q = tenant.collection(collection);
    for (const [f, op, v] of part.where) q = q.where(field(f), op, v);
    for (const [f, dir] of part.orderBy) q = q.orderBy(field(f), dir);
    return q;
  };
  const toRow = (d) => ({ id: d.id, ...d.data() });

  if (spec.parts.length > 1) {
    const results = await Promise.all(
      spec.parts.map(async (part) => {
        const cap = part.limit ?? max + 1;
        const docs = (await base(part).limit(cap).get()).docs;
        if (!part.limit && docs.length > max) throw tooMany();
        return docs.map(toRow);
      })
    );
    const rows = mergeParts(spec, results);
    if (rows.length > max) throw tooMany();
    return rows;
  }

  const query = base(spec.parts[0]);
  const rows = [];
  let last = null;
  for (;;) {
    const want = Math.min(READ_PAGE, max + 1 - rows.length);
    const snap = await (last ? query.startAfter(last) : query).limit(want).get();
    rows.push(...snap.docs.map(toRow));
    if (rows.length > max) throw tooMany();
    if (snap.docs.length < want) return rows;
    last = snap.docs[snap.docs.length - 1];
  }
}

// Documents by id (one batched read per 300), as a Map id -> data|null.
export async function readByIds({ db, tenant, collection, ids }) {
  const out = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 300) {
    const refs = unique.slice(i, i + 300).map((id) => tenant.doc(collection, id));
    const snaps = refs.length ? await db.getAll(...refs) : [];
    snaps.forEach((s) => out.set(s.id, s.exists ? s.data() : null));
  }
  return out;
}

export async function runExport({ db, ctx, admin, descriptor, builder, rawFilters, now = new Date(), maxRows = EXPORT_MAX_ROWS }) {
  const { permissions, entitlements, business, tenant } = ctx;
  if (!canExport({ entitlements, permissions }, descriptor)) throw new ExportError("not-allowed", "You can't download this data.");
  const today = businessDate(business.timezone, now);
  const filters = validateExportFilters(descriptor, rawFilters, { today });
  const FieldPath = admin.firestore.FieldPath;

  const built = await builder({
    db,
    tenant,
    filters,
    permissions,
    entitlements,
    business,
    timezone: business.timezone,
    today,
    now,
    maxRows,
    readRows: (collection, spec) => readRows({ tenant, collection, spec, FieldPath, max: maxRows }),
    readByIds: (collection, ids) => readByIds({ db, tenant, collection, ids }),
  });

  const actor = { uid: ctx.uid, name: ctx.user?.name || "", email: ctx.user?.email || "" };
  const info = pairsSheet({
    name: "Export info",
    timezone: business.timezone,
    rows: [
      ["Business", "text", business.name],
      ["Data", "text", descriptor.label],
      ["Filters", "text", describeFilters(descriptor, filters)],
      ["Rows", "integer", built.rowCount],
      ["Exported by", "text", actor.name || actor.email || actor.uid],
      ["Exported at", "datetime", now, `Business time (${business.timezone})`],
      ["Source", "text", "Luna Business OS", built.note || "Generated from Luna's records at the time of export."],
    ],
  });
  const fileName = exportFileName(descriptor.label, { from: filters.from ?? null, to: filters.to ?? null, day: today });
  const bytes = writeXlsx([...built.sheets, info], { title: `${descriptor.label} — ${business.name}`, created: now });

  const FieldValue = admin.firestore.FieldValue;
  const stamp = FieldValue.serverTimestamp();
  const month = monthKey(business.timezone, now);
  const batch = db.batch();
  batch.set(tenant.collection("auditLog").doc(), { type: "export.generated", dataset: descriptor.id, filters, rowCount: built.rowCount, actor, at: stamp });
  batch.set(tenant.doc("usage", month), { period: month, exportsGenerated: FieldValue.increment(1), rowsExported: FieldValue.increment(built.rowCount), updatedAt: stamp }, { merge: true });
  await batch.commit();

  return { fileName, bytes, rowCount: built.rowCount, filters };
}
