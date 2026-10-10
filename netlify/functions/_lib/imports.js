// Distributor imports (Phase 12), server side.
//
//   preview  every mapped row is converted and validated HERE (the browser
//            only parses the file), duplicates are found within the file and
//            against the business (SKU index; customer name + phone), and the
//            job + its normalized rows are stored server-side:
//              imports/{jobId}            summary (readable with imports.run)
//              imports/{jobId}/rows/{NNN} up to 200 rows + per-row results
//   commit   imports exactly what was previewed (never re-sent data), in
//            time-boxed batches (Netlify's synchronous limit), resumable.
//            Each row is created in ONE transaction with its "done" marker
//            (createProduct / createCustomer hooks), so retries, double
//            clicks and concurrent commit calls never create a row twice.
//            The plan's importsPerMonth is checked and counted once, when
//            the job starts committing. Existing records are never updated.
//   cancel   a previewed job that won't be imported.

import { IMPORT_TYPES, IMPORT_MAX_ROWS, IMPORT_CHUNK_ROWS, IMPORT_PREVIEW_TTL_MS, IMPORT_SCHEMA_VERSION, ImportError, convertRow, duplicateKeys } from "../../../shared/imports.js";
import { InventoryError } from "../../../shared/inventory.js";
import { CustomerError } from "../../../shared/customers.js";
import { createProduct } from "./inventory.js";
import { createCustomer } from "./customers.js";
import { checkMonthlyLimit, prepareMonthlyAlerts, meterActivity, noteLimitReached } from "./metering.js";

const TX_OPTIONS = { maxAttempts: 10 };
const JOB_ID = /^[A-Za-z0-9]{8,40}$/;
const COMMIT_BUDGET_MS = 6000;
const chunkId = (i) => String(i).padStart(3, "0");
const ROW_DONE = Object.assign(new Error("row already imported"), { code: "row-done" });
const ROW_DUPLICATE = Object.assign(new Error("duplicate"), { code: "row-duplicate" });

function jobRef(tenant, jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new ImportError("invalid-job", "Invalid import");
  return tenant.doc("imports", jobId);
}

function cleanFileName(name) {
  const base = typeof name === "string" ? name.split(/[\\/]/).pop().trim() : "";
  if (!base || base.length > 120 || !/\.(xlsx|csv)$/i.test(base)) throw new ImportError("invalid-input", "The file must be an .xlsx or .csv file");
  return base;
}

async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

// ---------- preview ----------

export async function previewImport({ db, tenant, FieldValue, type, fileName, rows, mapping = null, actor, now = new Date() }) {
  const def = IMPORT_TYPES[type];
  if (!def) throw new ImportError("invalid-type", "Choose Products or Customers");
  const file = cleanFileName(fileName);
  if (!Array.isArray(rows) || !rows.length) throw new ImportError("empty", "The file has no data rows");
  if (rows.length > IMPORT_MAX_ROWS) throw new ImportError("too-many-rows", `At most ${IMPORT_MAX_ROWS} rows per import`);
  const keys = def.fields.map((f) => f.key);
  const mapped = {};
  if (mapping !== null) {
    if (typeof mapping !== "object" || Array.isArray(mapping)) throw new ImportError("invalid-input", "Invalid column mapping");
    for (const [k, v] of Object.entries(mapping)) {
      if (!keys.includes(k)) throw new ImportError("invalid-input", `Unknown field ${k}`);
      if (v !== null && (typeof v !== "string" || v.length > 120)) throw new ImportError("invalid-input", "Invalid column name");
      mapped[k] = v;
    }
  }

  // 1. Shape: each row -> input or errors.
  const results = rows.map((r) => {
    if (!r || typeof r !== "object" || !Number.isSafeInteger(r.n) || r.n < 1 || !r.values || typeof r.values !== "object" || Array.isArray(r.values)) throw new ImportError("invalid-input", "Invalid row");
    const c = convertRow(type, r.values);
    return { n: r.n, values: Object.fromEntries(keys.filter((k) => typeof r.values[k] === "string").map((k) => [k, r.values[k]])), input: c.input ?? null, status: c.errors ? "error" : "ready", action: c.errors ? "none" : "create", messages: c.errors ?? [] };
  });
  const valid = results.filter((r) => r.input);

  // 2. Duplicates within the file.
  if (type === "products") {
    const first = new Map();
    for (const r of valid) {
      const { sku } = duplicateKeys(type, r.input);
      if (first.has(sku)) Object.assign(r, { status: "error", action: "none", messages: [`SKU ${sku} is also on row ${first.get(sku)} of this file`] });
      else first.set(sku, r.n);
    }
  } else {
    const exact = new Map();
    const byPhone = new Map();
    for (const r of valid) {
      const k = duplicateKeys(type, r.input);
      const exactKey = `${k.nameLower}|${k.phoneKey ?? ""}`;
      if (exact.has(exactKey)) Object.assign(r, { status: "warning", action: "skip", messages: [`Same customer as row ${exact.get(exactKey)} — skipped`] });
      else {
        exact.set(exactKey, r.n);
        if (k.phoneKey && byPhone.has(k.phoneKey)) Object.assign(r, { status: "warning", messages: [`Same phone as row ${byPhone.get(k.phoneKey)} — possible duplicate`] });
        else if (k.phoneKey) byPhone.set(k.phoneKey, r.n);
      }
    }
  }

  // 3. Duplicates against the business (bounded: at most one read per row).
  const live = valid.filter((r) => r.action === "create");
  if (type === "products") {
    const skus = [...new Set(live.map((r) => r.input.sku))];
    const taken = new Set(await inChunks(skus, 100, async (part) => (await Promise.all(part.map((s) => tenant.doc("skuIndex", s).get()))).filter((s) => s.exists).map((s) => s.id)));
    for (const r of live) if (taken.has(r.input.sku)) Object.assign(r, { status: "warning", action: "skip", messages: [`SKU ${r.input.sku} already exists in Luna — skipped (imports never change existing products)`] });
  } else {
    const phones = [...new Set(live.map((r) => duplicateKeys(type, r.input).phoneKey).filter(Boolean))];
    const names = [...new Set(live.map((r) => duplicateKeys(type, r.input).nameLower))];
    const existing = [];
    for (let i = 0; i < phones.length; i += 30) existing.push(...(await tenant.collection("customers").where("phoneKey", "in", phones.slice(i, i + 30)).get()).docs.map((d) => d.data()));
    for (let i = 0; i < names.length; i += 30) existing.push(...(await tenant.collection("customers").where("nameLower", "in", names.slice(i, i + 30)).get()).docs.map((d) => d.data()));
    for (const r of live) {
      const k = duplicateKeys(type, r.input);
      const same = existing.find((c) => c.nameLower === k.nameLower && (c.phoneKey ?? null) === (k.phoneKey ?? null));
      if (same) Object.assign(r, { status: "warning", action: "skip", messages: [`Already a customer (${same.name}) — skipped`] });
      else {
        const phone = k.phoneKey && existing.find((c) => c.phoneKey === k.phoneKey);
        const name = existing.find((c) => c.nameLower === k.nameLower);
        if (phone) Object.assign(r, { status: "warning", messages: [...r.messages, `Same phone as existing customer ${phone.name} — possible duplicate`] });
        else if (name) Object.assign(r, { status: "warning", messages: [...r.messages, `A customer named ${name.name} already exists — possible duplicate`] });
      }
    }
  }

  // 4. Store the job and its rows.
  const counts = {
    total: results.length,
    ready: results.filter((r) => r.status === "ready").length,
    warning: results.filter((r) => r.status === "warning").length,
    error: results.filter((r) => r.status === "error").length,
    warningToCreate: results.filter((r) => r.status === "warning" && r.action === "create").length,
    toSkip: results.filter((r) => r.action === "skip").length,
  };
  const ref = tenant.collection("imports").doc();
  const stamp = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(ref, {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    type,
    fileName: file,
    mapping: mapped,
    status: "previewed",
    counts,
    chunks: Math.ceil(results.length / IMPORT_CHUNK_ROWS),
    includeWarnings: null,
    result: null,
    createdBy: actor,
    createdAt: stamp,
    expiresAt: now.getTime() + IMPORT_PREVIEW_TTL_MS,
    committedBy: null,
    committedAt: null,
    completedAt: null,
    revision: 1,
  });
  for (let i = 0; i * IMPORT_CHUNK_ROWS < results.length; i++) {
    batch.set(ref.collection("rows").doc(chunkId(i)), { index: i, rows: results.slice(i * IMPORT_CHUNK_ROWS, (i + 1) * IMPORT_CHUNK_ROWS), results: {} });
  }
  await batch.commit();
  return { jobId: ref.id, type, fileName: file, counts, rows: results.map((r) => ({ n: r.n, status: r.status, action: r.action, messages: r.messages })) };
}

// ---------- commit ----------

const eligible = (row, includeWarnings) => row.action === "create" && (row.status === "ready" || (row.status === "warning" && includeWarnings));

// Phase 18: the quota is checked against the business's CURRENT effective
// limit (read in this transaction); the import is counted when it starts
// writing rows, with the 80% / 100% warnings. A refused commit isn't counted.
const limitError = (code, message, details) => Object.assign(new ImportError(code, code === "import-limit-reached" ? `This month's import limit (${details.limit}) has been reached. Contact Luna to raise it.` : message), { details });
async function startCommit(args) {
  try {
    return await startCommitOnce(args);
  } catch (err) {
    if (err && err.code === "import-limit-reached" && err.details) await noteLimitReached({ db: args.db, tenant: args.tenant, FieldValue: args.FieldValue, ...err.details });
    throw err;
  }
}
async function startCommitOnce({ db, tenant, FieldValue, business, entitlements, ref, includeWarnings, actor, now }) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ImportError("not-found", "Import not found");
    const job = snap.data();
    if (job.status !== "previewed") return job;
    if (now.getTime() > job.expiresAt) {
      tx.update(ref, { status: "expired", revision: job.revision + 1 });
      return { ...job, status: "expired" };
    }
    const quota = await checkMonthlyLimit(tx, { tenant, meterId: "excelImports", timezone: business.timezone, now, error: limitError, entitlements });
    const alerts = await prepareMonthlyAlerts(tx, { tenant, meterId: "excelImports", period: quota.period, before: quota.used, after: quota.used + 1, limit: quota.limit });
    const stamp = FieldValue.serverTimestamp();
    meterActivity(tx, { tenant, FieldValue, timezone: business.timezone, now, period: quota.period, counts: { excelImports: 1 } });
    alerts.commit({ FieldValue });
    tx.update(ref, { status: "committing", includeWarnings: includeWarnings === true, committedBy: actor, committedAt: stamp, revision: job.revision + 1 });
    return { ...job, status: "committing", includeWarnings: includeWarnings === true };
  }, TX_OPTIONS);
}

async function importRow({ db, tenant, FieldValue, type, chunkRef, index, row, actor }) {
  const hooks = {
    read: async (tx) => {
      const c = await tx.get(chunkRef);
      if (c.data().results?.[index]) throw ROW_DONE;
      if (type === "customers") {
        // Re-check at commit time: someone may have added it since the preview.
        const k = { nameLower: row.input.name.toLocaleLowerCase("en"), phoneKey: duplicateKey(row.input) };
        const same = await tx.get(tenant.collection("customers").where("nameLower", "==", k.nameLower).where("phoneKey", "==", k.phoneKey).limit(1));
        if (!same.empty) throw ROW_DUPLICATE;
      }
    },
    write: (tx, id) => tx.update(chunkRef, { [`results.${index}`]: { outcome: "created", id } }),
  };
  const mark = (outcome, reason) =>
    db.runTransaction(async (tx) => {
      const c = await tx.get(chunkRef);
      if (c.data().results?.[index]) return;
      tx.update(chunkRef, { [`results.${index}`]: { outcome, reason } });
    }, TX_OPTIONS);
  try {
    if (type === "products") await createProduct({ db, tenant, FieldValue, input: row.input, actor, hooks });
    else await createCustomer({ db, tenant, FieldValue, input: row.input, actor, hooks });
    return "created";
  } catch (err) {
    if (err === ROW_DONE) return "done";
    // A concurrent commit of the same row won the create (ALREADY_EXISTS on
    // the SKU index / document): if it recorded the row, we're done;
    // otherwise someone else holds the key -> skipped.
    if (err && err.code === 6) {
      const c = (await chunkRef.get()).data();
      if (c.results?.[index]) return "done";
      return mark("skipped", "Already exists in Luna (created at the same time)").then(() => "skipped");
    }
    if (err === ROW_DUPLICATE) return mark("skipped", "Already a customer (added since the preview)").then(() => "skipped");
    if (err instanceof InventoryError && err.code === "duplicate-sku") return mark("skipped", "SKU now exists in Luna (added since the preview)").then(() => "skipped");
    if (err instanceof InventoryError || err instanceof CustomerError) return mark("failed", err.message).then(() => "failed");
    throw err;
  }
}
const duplicateKey = (input) => duplicateKeys("customers", input).phoneKey ?? null;

function summarize(job, chunks) {
  const out = { created: 0, skipped: 0, failed: 0, notImported: 0 };
  for (const c of chunks) {
    c.rows.forEach((row, i) => {
      const r = c.results?.[i];
      if (r) out[r.outcome === "created" ? "created" : r.outcome === "skipped" ? "skipped" : "failed"] += 1;
      else if (row.action === "skip") out.skipped += 1;
      else out.notImported += 1; // errors, and warnings not included
    });
  }
  return out;
}

// Imports up to a time budget; call again until { done: true }.
export async function commitImport({ db, tenant, FieldValue, business, entitlements, jobId, includeWarnings = false, actor, now = new Date(), budgetMs = COMMIT_BUDGET_MS, canImport }) {
  const ref = jobRef(tenant, jobId);
  const pre = await ref.get();
  if (!pre.exists) throw new ImportError("not-found", "Import not found");
  if (canImport && !canImport(pre.data().type)) throw new ImportError("not-allowed", "You can't import this kind of data");
  const job = await startCommit({ db, tenant, FieldValue, business, entitlements, ref, includeWarnings, actor, now });
  if (job.status === "expired") throw new ImportError("expired", "This preview is more than 24 hours old. Upload the file again.");
  if (job.status === "cancelled") throw new ImportError("cancelled", "This import was cancelled");
  if (job.status === "completed") return { jobId, done: true, status: "completed", result: job.result };

  const started = Date.now();
  let processed = 0;
  let remaining = 0;
  const chunks = [];
  for (let i = 0; i < job.chunks; i++) {
    const chunkRef = ref.collection("rows").doc(chunkId(i));
    const chunk = (await chunkRef.get()).data();
    for (let j = 0; j < chunk.rows.length; j++) {
      const row = chunk.rows[j];
      if (!eligible(row, job.includeWarnings) || chunk.results?.[j]) continue;
      if (Date.now() - started > budgetMs) {
        remaining += 1;
        continue;
      }
      await importRow({ db, tenant, FieldValue, type: job.type, chunkRef, index: j, row, actor });
      processed += 1;
    }
    chunks.push((await chunkRef.get()).data());
  }
  if (remaining) return { jobId, done: false, status: "committing", processed, remaining };

  const result = summarize(job, chunks);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const j = snap.data();
    if (j.status !== "committing") return;
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, { status: "completed", result, completedAt: stamp, revision: j.revision + 1 });
    tx.set(tenant.collection("auditLog").doc(), { type: "import.completed", importId: jobId, importType: j.type, fileName: j.fileName, result, includeWarnings: j.includeWarnings, actor, at: stamp });
  }, TX_OPTIONS);
  return { jobId, done: true, status: "completed", processed, result };
}

export async function cancelImport({ db, tenant, FieldValue, jobId, actor, canImport }) {
  const ref = jobRef(tenant, jobId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ImportError("not-found", "Import not found");
    const job = snap.data();
    if (canImport && !canImport(job.type)) throw new ImportError("not-allowed", "You can't import this kind of data");
    if (job.status !== "previewed") throw new ImportError("not-cancellable", "Only an import that hasn't started can be cancelled");
    tx.update(ref, { status: "cancelled", cancelledBy: actor, cancelledAt: FieldValue.serverTimestamp(), revision: job.revision + 1 });
    return { jobId, status: "cancelled" };
  }, TX_OPTIONS);
}
