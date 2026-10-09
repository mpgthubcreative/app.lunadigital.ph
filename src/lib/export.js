// "Download Excel" for any screen (Phase 12.5): sends the dataset id and
// the screen's CURRENT filters to POST /api/exports, which re-checks
// access, reads every matching row (not just this page) and returns the
// .xlsx. The browser never builds the workbook from what it happens to
// hold, and never decides what the user may see.

import { html } from "./html.js";
import { apiDownload } from "./api.js";
import { EXPORT_DATASETS } from "@shared/export-datasets.js";
import { canExport, EXPORT_MAX_ROWS } from "@shared/exports.js";

export const exportHint = `Downloads every row that matches these filters, not just this page (up to ${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows).`;

export const mayExport = (session, datasetId) => canExport({ entitlements: session.entitlements, permissions: session.member.permissions }, EXPORT_DATASETS[datasetId]);

// The button; `dataset` goes in data-export.
export const exportButton = (datasetId, label = "Download Excel") =>
  html`<button type="button" class="btn btn-compact" data-act="export" data-export="${datasetId}" title="${exportHint}">${label}</button>`;

export function saveBlob(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Runs one export; resolves to { fileName, rows } or throws ApiError (the
// caller shows its message, e.g. "too many rows -> narrow your filters").
export async function runExport(datasetId, filters, { download = apiDownload, save = saveBlob } = {}) {
  const { blob, fileName, rows } = await download("exports", { dataset: datasetId, filters });
  save(fileName, blob);
  return { fileName, rows };
}

// Wires every [data-act="export"] button in `root` to the filters the
// screen has APPLIED (what the list shows): disables the button while
// running, reports the outcome through `toast`. Returns an unbind function.
export function bindExport(root, getFilters, { toast, deps = {} } = {}) {
  const onClick = async (event) => {
    const btn = event.target.closest('[data-act="export"]');
    if (!btn || !root.contains(btn) || btn.disabled) return;
    const datasetId = btn.dataset.export;
    btn.disabled = true;
    const text = btn.textContent;
    btn.textContent = "Preparing…";
    try {
      const { rows } = await runExport(datasetId, getFilters(datasetId), deps);
      toast?.(`Downloaded ${rows.toLocaleString("en-US")} row${rows === 1 ? "" : "s"}.`, "success");
    } catch (err) {
      toast?.(err.message || "Couldn't prepare the download.", "danger");
    } finally {
      btn.disabled = false;
      btn.textContent = text;
    }
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}
