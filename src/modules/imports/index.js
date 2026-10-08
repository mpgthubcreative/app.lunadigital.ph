// Imports (Phase 12, Distributor): Products and Customers from .xlsx/.csv.
//   1. choose what to import, download the template if needed, pick a file
//      (parsed here in the browser with shared/xlsx.js / shared/csv.js)
//   2. map columns (auto-guessed from the header row)
//   3. "Check rows": the SERVER validates every row and finds duplicates;
//      Ready / Warning / Error, filterable, downloadable (.xlsx)
//   4. confirm -> imported in batches with progress; nothing is written
//      before this step, and existing records are never changed
// Import History lists every job with its outcome and row details.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, card } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { IMPORT_TYPES, IMPORT_STATUSES, IMPORT_MAX_ROWS, ROW_STATUSES, autoMap, validateMapping, mapRows, canUseModule } from "@shared/index.js";
import { readXlsx, writeXlsx, isXlsx } from "@shared/xlsx.js";
import { parseCsv } from "@shared/csv.js";
import * as defaultData from "./data.js";
import { when } from "../orders/view.js";

const STATUS_TONE = { ready: "success", warning: "warning", error: "danger" };
const JOB_TONE = { previewed: "info", committing: "warning", completed: "success", cancelled: "neutral", expired: "neutral" };
const ROWS_PER_PAGE = 50;

// File bytes -> { headers, rows } (first sheet; first non-empty row = headers).
export function readSpreadsheet(fileName, bytes) {
  let table;
  if (/\.xlsx$/i.test(fileName) || isXlsx(bytes)) table = readXlsx(bytes, { maxRows: IMPORT_MAX_ROWS + 1 }).rows;
  else if (/\.csv$/i.test(fileName)) table = parseCsv(new TextDecoder("utf-8").decode(bytes), { maxRows: IMPORT_MAX_ROWS + 1 });
  else throw new Error("Choose an .xlsx or .csv file");
  const start = table.findIndex((r) => r.some((c) => String(c).trim() !== ""));
  if (start < 0) throw new Error("The file is empty");
  return { headers: table[start].map((h) => String(h).trim()), rows: table.slice(start + 1), headerRow: start + 1 };
}

export function templateWorkbook(type) {
  const def = IMPORT_TYPES[type];
  const example = type === "products" ? ["WINGS-1KG", "Chicken Wings 1kg", "Frozen", "pcs", 250.5, 10] : ["ABC Store", "ABC Trading", "0917 123 4567", "owner@abcstore.ph", "12 Rizal St, Cebu City", "Delivers Tuesdays"];
  return writeXlsx([{ name: def.label, rows: [def.fields.map((f) => f.label + (f.required ? " *" : "")), example] }]);
}

export function mount(container, session, { api = defaultApi, data = defaultData, toast = defaultToast, download = defaultDownload, readFile = (file) => file.arrayBuffer() } = {}) {
  const perms = session.member.permissions;
  const access = { entitlements: session.entitlements, permissions: perms };
  const types = Object.entries(IMPORT_TYPES).filter(([, d]) => canUseModule(access, d.module) && perms[d.permission] === true).map(([id]) => id);
  const businessId = session.business.id;
  const timezone = session.business.timezone;
  const s = { step: "choose", type: types[0] ?? null, file: null, sheet: null, mapping: {}, preview: null, filter: "all", page: 0, includeWarnings: false, progress: null, result: null, error: null, busy: false, history: { rows: [], loading: true, cursors: [], hasMore: false } };
  let alive = true;

  async function loadHistory() {
    try {
      const page = await data.listImports(businessId, { cursor: s.history.cursors.at(-1) || null });
      Object.assign(s.history, { rows: page.rows, hasMore: page.hasMore, loading: false, error: null });
    } catch (err) {
      Object.assign(s.history, { loading: false, error: "Couldn't load import history." });
    }
    draw();
  }

  const def = () => IMPORT_TYPES[s.type];
  const filteredRows = () => (s.preview ? s.preview.rows.filter((r) => s.filter === "all" || r.status === s.filter) : []);
  const valuesFor = (n) => s.mappedRows.find((r) => r.n === n)?.values ?? {};

  function chooseStep() {
    if (!types.length) return emptyState({ title: "Nothing to import", body: "You need permission to manage products or customers to import them." });
    return html`<form class="form" data-role="choose">
      <div class="filters filters-inline">
        <select class="select" name="type" aria-label="What to import">${types.map((t) => html`<option value="${t}" ${s.type === t ? "selected" : ""}>${IMPORT_TYPES[t].label}</option>`)}</select>
        <button type="button" class="btn" data-act="template">Download template (.xlsx)</button>
        <input class="input" type="file" name="file" accept=".xlsx,.csv" aria-label="Spreadsheet" />
      </div>
      <p class="stat-hint">Up to ${IMPORT_MAX_ROWS} rows, first sheet only. Nothing is saved until you confirm. Existing ${def().label.toLowerCase()} are never changed: matching rows are skipped.</p>
      ${s.type === "products" ? html`<p class="stat-hint">Products start with 0 stock. Enter stock afterwards with Inventory → Opening count.</p>` : ""}
    </form>`;
  }

  function mapStep() {
    const opts = (sel) => html`<option value="" ${sel === null ? "selected" : ""}>— not in my file —</option>${s.sheet.headers.map((h, i) => html`<option value="${i}" ${sel === i ? "selected" : ""}>${h || `Column ${i + 1}`}</option>`)}`;
    return html`<form class="form" data-role="mapping">
      <p class="stat-hint">${s.file.name} · ${s.sheet.rows.length} data rows. Match each Luna field to a column of your file.</p>
      <div class="table-wrap"><table class="table table-compact"><thead><tr><th>Luna field</th><th>Your column</th><th>First row</th></tr></thead><tbody>
        ${def().fields.map((f) => html`<tr><td>${f.label}${f.required ? " *" : ""}</td><td><select class="select" name="${f.key}" aria-label="${f.label}">${opts(s.mapping[f.key])}</select></td><td class="stat-hint">${s.mapping[f.key] === null || s.mapping[f.key] === undefined ? "" : String(s.sheet.rows[0]?.[s.mapping[f.key]] ?? "")}</td></tr>`)}
      </tbody></table></div>
      <div class="modal-footer"><button type="button" class="btn" data-act="restart">Start over</button><button type="submit" class="btn btn-primary" ${s.busy ? "disabled" : ""}>Check rows</button></div>
    </form>`;
  }

  function previewStep() {
    const c = s.preview.counts;
    const rows = filteredRows();
    const pageRows = rows.slice(s.page * ROWS_PER_PAGE, (s.page + 1) * ROWS_PER_PAGE);
    const toImport = c.ready + (s.includeWarnings ? c.warningToCreate : 0);
    const cols = def().fields.slice(0, 3);
    return html`<div data-role="preview">
      <div class="stat-grid">
        ${[["all", "All rows", c.total], ["ready", "Ready", c.ready], ["warning", "Warnings", c.warning], ["error", "Errors", c.error]].map(([k, l, v]) => html`<button type="button" class="card stat-card ${s.filter === k ? "is-active" : ""}" data-act="filter" data-filter="${k}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></button>`)}
      </div>
      <div class="table-wrap"><table class="table table-compact" data-table="preview"><thead><tr><th>Row</th><th>Status</th>${cols.map((f) => html`<th>${f.label}</th>`)}<th>Message</th></tr></thead><tbody>
        ${pageRows.map((r) => html`<tr data-row="${r.n}"><td>${r.n}</td><td>${badge(r.action === "skip" ? "Skip" : ROW_STATUSES[r.status], STATUS_TONE[r.status])}</td>${cols.map((f) => html`<td>${valuesFor(r.n)[f.key] ?? ""}</td>`)}<td class="stat-hint">${r.messages.join(" · ")}</td></tr>`)}
      </tbody></table></div>
      <div class="modal-footer">
        <button type="button" class="btn" data-act="prev" ${s.page ? "" : "disabled"}>Previous</button>
        <button type="button" class="btn" data-act="next" ${(s.page + 1) * ROWS_PER_PAGE < rows.length ? "" : "disabled"}>Next</button>
        <button type="button" class="btn" data-act="download-preview" ${rows.length ? "" : "disabled"}>Download these rows (.xlsx)</button>
      </div>
      ${c.warningToCreate ? html`<label class="checkbox"><input type="checkbox" name="includeWarnings" ${s.includeWarnings ? "checked" : ""} /> Also import ${c.warningToCreate} row(s) with warnings (possible duplicates)</label>` : ""}
      <div class="modal-footer">
        <button type="button" class="btn" data-act="cancel-job">Cancel import</button>
        <button type="button" class="btn btn-primary" data-act="commit" ${toImport && !s.busy ? "" : "disabled"}>Import ${toImport} ${def().label.toLowerCase()}</button>
      </div>
    </div>`;
  }

  function doneStep() {
    const r = s.result;
    return html`<div data-role="result">
      ${s.progress && !r ? html`<p data-role="progress">Importing… ${s.progress.processed} done, ${s.progress.remaining} to go.</p>` : ""}
      ${r ? html`<p data-role="result-summary"><strong>${r.created}</strong> created · ${r.skipped} skipped · ${r.failed} failed · ${r.notImported} not imported</p>
          <div class="modal-footer"><button type="button" class="btn btn-primary" data-act="restart">Import another file</button></div>` : ""}
    </div>`;
  }

  function historyCard() {
    const h = s.history;
    const body = h.error
      ? emptyState({ title: "Couldn't load", body: h.error })
      : h.loading
        ? emptyState({ title: "Loading…" })
        : !h.rows.length
          ? emptyState({ title: "No imports yet" })
          : html`<div class="table-wrap"><table class="table table-compact" data-table="history"><thead><tr><th>Date</th><th>Type</th><th>File</th><th class="num">Rows</th><th class="num">Created</th><th class="num">Skipped</th><th class="num col-secondary">Not imported</th><th>Status</th><th class="col-secondary">By</th><th></th></tr></thead><tbody>
              ${h.rows.map((j) => html`<tr data-import="${j.id}"><td>${when(j.createdAt, timezone)}</td><td>${IMPORT_TYPES[j.type]?.label ?? j.type}</td><td>${j.fileName}</td><td class="num">${j.counts?.total ?? 0}</td><td class="num">${j.result?.created ?? "—"}</td><td class="num">${j.result ? j.result.skipped : "—"}</td><td class="num col-secondary">${j.result ? j.result.notImported + j.result.failed : "—"}</td><td>${badge(IMPORT_STATUSES[j.status] ?? j.status, JOB_TONE[j.status] || "neutral")}</td><td class="col-secondary">${j.createdBy?.name ?? ""}</td><td class="row-actions"><button type="button" class="btn btn-compact" data-act="view" data-id="${j.id}">View details</button></td></tr>`)}
            </tbody></table></div>
            <div class="modal-footer"><button type="button" class="btn" data-act="hprev" ${h.cursors.length ? "" : "disabled"}>Previous</button><button type="button" class="btn" data-act="hnext" ${h.hasMore ? "" : "disabled"}>Next</button></div>`;
    return card({ title: "Import history", body });
  }

  function draw() {
    if (!alive) return;
    const step = s.step === "choose" ? chooseStep() : s.step === "map" ? mapStep() : s.step === "preview" ? previewStep() : doneStep();
    render(
      container,
      html`${pageHeader({ title: "Imports", subtitle: "Bring products and customers in from a spreadsheet." })}
        <section class="section" data-role="new-import">${card({ title: s.type ? `Import ${def().label.toLowerCase()}` : "Import", body: html`${s.error ? html`<p class="form-error" role="alert">${s.error}</p>` : ""}${step}` })}</section>
        <section class="section">${historyCard()}</section>`
    );
  }

  const fail = (err) => {
    s.busy = false;
    s.error = err.message || "Something went wrong.";
    draw();
  };

  async function onFile(file) {
    s.error = null;
    try {
      const bytes = new Uint8Array(await readFile(file));
      s.sheet = readSpreadsheet(file.name, bytes);
      if (s.sheet.rows.length > IMPORT_MAX_ROWS) throw new Error(`The file has more than ${IMPORT_MAX_ROWS} data rows. Split it into smaller files.`);
      if (!s.sheet.rows.length) throw new Error("The file has a header row but no data rows");
      s.file = { name: file.name };
      s.mapping = autoMap(s.type, s.sheet.headers);
      s.step = "map";
    } catch (err) {
      s.error = err.message;
    }
    draw();
  }

  async function check() {
    s.error = null;
    try {
      validateMapping(s.type, s.mapping, s.sheet.headers.length);
      s.mappedRows = mapRows(s.type, s.sheet.rows, s.mapping, { headerRow: s.sheet.headerRow });
      if (!s.mappedRows.length) throw new Error("No rows with data in the mapped columns");
      s.busy = true;
      draw();
      const mappingNames = Object.fromEntries(Object.entries(s.mapping).map(([k, i]) => [k, i === null || i === undefined ? null : s.sheet.headers[i] || `Column ${i + 1}`]));
      s.preview = await api("imports", { method: "POST", body: { action: "preview", type: s.type, fileName: s.file.name, rows: s.mappedRows, mapping: mappingNames } });
      Object.assign(s, { busy: false, step: "preview", filter: "all", page: 0, includeWarnings: false });
      draw();
      loadHistory();
    } catch (err) {
      fail(err);
    }
  }

  async function commit() {
    s.busy = true;
    s.step = "done";
    s.progress = { processed: 0, remaining: 0 };
    draw();
    try {
      for (let guard = 0; guard < 200; guard++) {
        const r = await api("imports", { method: "POST", body: { action: "commit", jobId: s.preview.jobId, includeWarnings: s.includeWarnings } });
        if (r.done) {
          s.result = r.result;
          break;
        }
        s.progress = { processed: s.progress.processed + (r.processed || 0), remaining: r.remaining };
        draw();
      }
      s.busy = false;
      toast(`Import finished: ${s.result.created} created`, "success");
      draw();
      loadHistory();
    } catch (err) {
      fail(err);
    }
  }

  function downloadPreviewRows() {
    const fields = def().fields;
    const rows = filteredRows().map((r) => [r.n, r.action === "skip" ? "Skip" : ROW_STATUSES[r.status], ...fields.map((f) => valuesFor(r.n)[f.key] ?? ""), r.messages.join(" · ")]);
    download(`luna-import-${s.type}-${s.filter}.xlsx`, writeXlsx([{ name: def().label, rows: [["Row", "Status", ...fields.map((f) => f.label), "Message"], ...rows] }]));
  }

  async function openDetails(job) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const view = { rows: null, filter: "all", error: null };
    const outcome = (r) => (r.result ? { created: "Created", skipped: "Skipped", failed: "Failed" }[r.result.outcome] : r.action === "skip" ? "Skipped" : r.status === "error" ? "Error" : job.status === "completed" ? "Not imported" : ROW_STATUSES[r.status]);
    const shown = () => (view.rows || []).filter((r) => view.filter === "all" || outcome(r) === view.filter);
    const paint = () =>
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Import" data-role="import-view">
          <div class="modal-header"><h2 class="card-title">${IMPORT_TYPES[job.type]?.label} · ${job.fileName}</h2></div>
          <div class="modal-body">
            <dl class="dl dl-compact"><dt>Status</dt><dd>${IMPORT_STATUSES[job.status] ?? job.status}</dd><dt>Started by</dt><dd>${job.createdBy?.name ?? ""} · ${when(job.createdAt, timezone)}</dd>
              ${job.result ? html`<dt>Result</dt><dd>${job.result.created} created · ${job.result.skipped} skipped · ${job.result.failed} failed · ${job.result.notImported} not imported</dd>` : ""}</dl>
            <div class="filters filters-inline"><select class="select" name="outcome" aria-label="Show">${["all", "Created", "Skipped", "Failed", "Not imported", "Error", "Ready", "Warning"].map((o) => html`<option value="${o}" ${view.filter === o ? "selected" : ""}>${o === "all" ? "All rows" : o}</option>`)}</select>
              <button type="button" class="btn btn-compact" data-act="download-details" ${view.rows && shown().length ? "" : "disabled"}>Download these rows (.xlsx)</button></div>
            ${view.error ? html`<p class="form-error">${view.error}</p>` : view.rows === null ? html`<p class="stat-hint">Loading…</p>` : html`<div class="table-wrap"><table class="table table-compact" data-table="import-rows"><thead><tr><th>Row</th><th>Outcome</th><th>Message</th></tr></thead><tbody>${shown().slice(0, 200).map((r) => html`<tr><td>${r.n}</td><td>${outcome(r)}</td><td class="stat-hint">${[...(r.messages || []), r.result?.reason].filter(Boolean).join(" · ")}</td></tr>`)}</tbody></table></div>${shown().length > 200 ? html`<p class="stat-hint">Showing 200 of ${shown().length}; the download has them all.</p>` : ""}`}
          </div>
          <div class="modal-footer"><button type="button" class="btn" data-act="close">Close</button></div>
        </div>`
      );
    paint();
    data
      .getImportRows(businessId, job.id)
      .then((rows) => (view.rows = rows))
      .catch(() => (view.error = "Couldn't load the rows."))
      .then(paint);
    backdrop.addEventListener("change", (e) => {
      if (e.target.name === "outcome") {
        view.filter = e.target.value;
        paint();
      }
    });
    backdrop.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (e.target === backdrop || act === "close") backdrop.remove();
      if (act === "download-details") {
        const fields = IMPORT_TYPES[job.type].fields;
        download(`luna-import-${job.id}-${view.filter}.xlsx`, writeXlsx([{ name: "Rows", rows: [["Row", "Outcome", ...fields.map((f) => f.label), "Message"], ...shown().map((r) => [r.n, outcome(r), ...fields.map((f) => r.values?.[f.key] ?? ""), [...(r.messages || []), r.result?.reason].filter(Boolean).join(" · ")])] }]));
      }
    });
  }

  const onClick = async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const act = el.dataset.act;
    if (act === "template") download(`luna-${s.type}-template.xlsx`, templateWorkbook(s.type));
    if (act === "restart") {
      Object.assign(s, { step: "choose", file: null, sheet: null, preview: null, result: null, progress: null, error: null });
      draw();
    }
    if (act === "filter") {
      s.filter = el.dataset.filter;
      s.page = 0;
      draw();
    }
    if (act === "next") (s.page += 1), draw();
    if (act === "prev") (s.page -= 1), draw();
    if (act === "download-preview") downloadPreviewRows();
    if (act === "commit") commit();
    if (act === "cancel-job") {
      try {
        await api("imports", { method: "POST", body: { action: "cancel", jobId: s.preview.jobId } });
        Object.assign(s, { step: "choose", preview: null });
        toast("Import cancelled", "neutral");
        draw();
        loadHistory();
      } catch (err) {
        fail(err);
      }
    }
    if (act === "view") openDetails(s.history.rows.find((j) => j.id === el.dataset.id));
    if (act === "hnext") s.history.cursors.push(s.history.rows.at(-1)), loadHistory();
    if (act === "hprev") s.history.cursors.pop(), loadHistory();
  };
  const onChange = (e) => {
    if (e.target.name === "type") {
      s.type = e.target.value;
      draw();
    } else if (e.target.name === "file" && e.target.files?.[0]) onFile(e.target.files[0]);
    else if (e.target.name === "includeWarnings") {
      s.includeWarnings = e.target.checked;
      draw();
    } else if (s.step === "map" && e.target.closest('[data-role="mapping"]')) {
      s.mapping[e.target.name] = e.target.value === "" ? null : Number(e.target.value);
      draw();
    }
  };
  const onSubmit = (e) => {
    if (e.target.dataset.role !== "mapping") return;
    e.preventDefault();
    check();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  draw();
  loadHistory();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
  };
}

function defaultDownload(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
