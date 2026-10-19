// Download Excel (Owner pilot, 2026-10-18): ONE clean workbook for the
// workspace (shared/workbook.js). Server only, reads only:
//
//   1. access   the endpoint ran requireTenant (membership, subscription,
//               data.export); here every sheet also needs its module and
//               view permission, so a member gets only the sheets of the
//               screens they can open. Always this business: the tenant
//               comes from requireTenant, never from the request.
//   2. rows     the same list specs as the screens (shared/list-queries.js),
//               every row; past EXPORT_MAX_ROWS in one sheet the download
//               is refused (choose a shorter range), never truncated.
//   3. file     workbookSheet (shared/exports.js): one bold frozen header
//               row with filters, ₱ amounts as numbers, real dates,
//               readable text only (no ids, JSON or field names).
//   4. trace    one auditLog entry (range, sheet names, rows; no data) and
//               the export meters, like every Luna export.

import { writeXlsx } from "../../../../shared/xlsx.js";
import { workbookSheet, EXPORT_MAX_ROWS, ExportError, canExport } from "../../../../shared/exports.js";
import { WORKBOOK_PERMISSION, WorkbookError, workbookKind, workbookHasRange, resolveWorkbookRange, workbookFileName } from "../../../../shared/workbook.js";
import { EXPORT_DATASETS } from "../../../../shared/export-datasets.js";
import { canUseModule } from "../../../../shared/modules.js";
import { businessDate } from "../../../../shared/metrics.js";
import { readRows, readByIds } from "../export-core.js";
import { monthKey } from "../usage.js";
import { meterActivity } from "../metering.js";
import { householdSheets } from "./household.js";
import { bridalSheets } from "./bridal.js";
import { businessSheets } from "./business.js";
import { BABY_BUILDERS } from "../exports/baby.js";
import { SUMMARY_BUILDERS } from "../exports/summaries.js";

const TOO_MANY = "This download has too many rows. Choose a shorter range and try again.";
const KIND_TITLE = { household: "Luna Household", bridal: "Luna Bridal", business: "Luna Business", baby: "Luna Baby" };

// Luna Baby (not in the brief): its lists as clean sheets, from the
// existing list builders (the ones its Download Excel used before).
async function babySheets(x) {
  const builders = { ...SUMMARY_BUILDERS, ...BABY_BUILDERS };
  const sheets = [];
  for (const d of Object.values(EXPORT_DATASETS)) {
    if (!d.workspaces?.includes("baby-expense") || !builders[d.id] || !canExport({ entitlements: x.entitlements, permissions: x.permissions }, d)) continue;
    const filters = { ...(d.filters.from && x.range.from ? { from: x.range.from } : {}), ...(d.filters.to && x.range.to ? { to: x.range.to } : {}) };
    const built = await builders[d.id]({ ...x, filters, maxRows: EXPORT_MAX_ROWS });
    sheets.push({ name: built.table.name || d.label, columns: built.table.columns.filter((c) => !c.needs || c.needs.every((p) => x.permissions[p] === true)), rows: built.table.rows });
  }
  return sheets;
}

export async function buildWorkbook({ db, ctx, admin, input, now = new Date() }) {
  const { permissions, entitlements, business, tenant } = ctx;
  if (permissions?.[WORKBOOK_PERMISSION] !== true) throw new WorkbookError("not-allowed", "You can't download Excel files for this business.");
  const timezone = business.timezone || "Asia/Manila";
  const kind = workbookKind(entitlements);
  const today = businessDate(timezone, now);
  const range = workbookHasRange(kind) ? resolveWorkbookRange(input, { today }) : { range: "all", from: null, to: null, fileLabel: "", label: "The whole wedding" };
  const FieldPath = admin.firestore.FieldPath;
  const x = {
    db,
    tenant,
    business,
    permissions,
    entitlements,
    timezone,
    today,
    now,
    range,
    can: (moduleId, ...perms) => canUseModule({ entitlements, permissions }, moduleId) && perms.every((p) => permissions[p] === true),
    readRows: (collection, spec) => readRows({ tenant, collection, spec, FieldPath, max: EXPORT_MAX_ROWS }),
    readByIds: (collection, ids) => readByIds({ db, tenant, collection, ids }),
    readAll: async (collection) => {
      const snap = await tenant.collection(collection).limit(EXPORT_MAX_ROWS + 1).get();
      if (snap.docs.length > EXPORT_MAX_ROWS) throw new ExportError("too-many-rows", TOO_MANY);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
  };

  let parts;
  try {
    parts = kind === "household" ? await householdSheets(x) : kind === "bridal" ? await bridalSheets(x) : kind === "baby" ? await babySheets(x) : await businessSheets(x);
  } catch (err) {
    if (err instanceof ExportError && err.code === "too-many-rows") throw new WorkbookError("too-many-rows", kind === "bridal" ? "This wedding has too many records for one file. Contact Luna support." : TOO_MANY);
    throw err;
  }
  if (!parts.length) throw new WorkbookError("not-allowed", "There's nothing you can download here.");

  const sheets = parts.map((p) => workbookSheet({ ...p, timezone }));
  const rowCount = parts.reduce((n, p) => n + p.rows.length, 0);
  let coupleNames = "";
  if (kind === "bridal") coupleNames = (await readByIds({ db, tenant, collection: "weddingSetup", ids: ["current"] })).get("current")?.coupleNames ?? "";
  const fileName = workbookFileName(kind, { range, businessName: business.name, coupleNames });
  const bytes = writeXlsx(sheets, { title: `${KIND_TITLE[kind]} — ${business.name || ""}${range.label ? ` · ${range.label}` : ""}`, created: now });

  const FieldValue = admin.firestore.FieldValue;
  const actor = { uid: ctx.uid, name: ctx.user?.name || "", email: ctx.user?.email || "" };
  const month = monthKey(timezone, now);
  const batch = db.batch();
  // The download record: business, workspace, time, file size; and the meters (downloads + bytes).
  batch.set(tenant.collection("auditLog").doc(), { type: "export.generated", dataset: "workbook", businessId: tenant.businessId, workspaceTemplateId: ctx.workspace?.templateId ?? null, bytes: bytes.length, range: { range: range.range, from: range.from, to: range.to }, sheets: parts.map((p) => p.name), rowCount, actor, at: FieldValue.serverTimestamp() });
  meterActivity(batch, { tenant, FieldValue, timezone, now, period: month, counts: { exportsGenerated: 1, rowsExported: rowCount, exportBytes: bytes.length } });
  await batch.commit();
  return { bytes, fileName, rowCount, sheets: parts.map((p) => p.name) };
}
