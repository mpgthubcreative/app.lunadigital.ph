// Export & Backup (Owner-pilot): the business's Excel downloads on ONE page
// under More, in every workspace, so they aren't part of the everyday
// screens.
//   Download Master Backup   one workbook with every record (the Owner who
//                            may export; /api/backup)
//   Single lists             each list of this workspace, whole (the usual
//                            per-dataset export permission)
// One place to gate later (a paid unlock); nothing is blocked today.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { exportButton, bindExport, saveBlob } from "../../lib/export.js";
import { apiDownload } from "../../lib/api.js";
import { EXPORT_DATASETS } from "@shared/export-datasets.js";
import { exportListsFor, canBackup } from "../../app/routes.js";

// The whole list for each download (tasks: done ones too).
const FILTERS = { weddingTasks: { state: "all" } };

export function mount(container, session, { toast = defaultToast, exportDeps = {}, download = apiDownload, save = saveBlob } = {}) {
  const ids = exportListsFor(session);
  const backup = canBackup(session);
  render(
    container,
    html`
      ${pageHeader({ title: "Export & Backup" })}
      ${backup
        ? html`<section class="wl-section" data-section="backup">
            <button type="button" class="btn btn-primary" data-act="backup">Download Master Backup</button>
            <p class="stat-hint">One Excel file with everything in Luna for ${session.business.name}: every record, including removed and archived ones. Keep it somewhere safe.</p>
          </section>`
        : ""}
      ${ids.length
        ? html`<h2 class="wl-group-title">Single lists</h2><ul class="wl-list" data-role="downloads">${ids.map(
            (id) => html`<li class="wl-row" data-download="${id}"><span class="wl-main"><span class="wl-name">${EXPORT_DATASETS[id].label}</span></span>${exportButton(id, "Download")}</li>`
          )}</ul>`
        : !backup
          ? emptyState({ title: "Nothing to download", body: "Downloads aren't available for your account." })
          : ""}`
  );
  const unbind = bindExport(container, (id) => ({ ...(FILTERS[id] || {}) }), { toast, deps: exportDeps });
  const onClick = async (event) => {
    const btn = event.target.closest('[data-act="backup"]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const text = btn.textContent;
    btn.textContent = "Preparing…";
    try {
      const { blob, fileName } = await download("backup", {});
      save(fileName, blob);
      toast("Master Backup downloaded.", "success");
    } catch (err) {
      toast(err.message || "Couldn't prepare the backup.", "danger");
    } finally {
      btn.disabled = false;
      btn.textContent = text;
    }
  };
  container.addEventListener("click", onClick);
  return () => {
    unbind();
    container.removeEventListener("click", onClick);
  };
}
