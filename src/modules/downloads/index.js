// Downloads (Owner-pilot Bridal UX): the workspace's Excel downloads on one
// page under More, so they aren't part of the everyday screens. Which lists
// appear comes from the template (`downloads`) and the usual per-dataset
// export check (entitlement + permission). Each downloads the whole current
// list through the Export Core. One place to gate later (a paid unlock):
// nothing is blocked today.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { exportButton, bindExport } from "../../lib/export.js";
import { EXPORT_DATASETS } from "@shared/export-datasets.js";
import { downloadsFor } from "../../app/routes.js";

// The whole list for each download (tasks: done ones too).
const FILTERS = { weddingTasks: { state: "all" } };

export function mount(container, session, { toast = defaultToast, exportDeps = {} } = {}) {
  const ids = downloadsFor(session);
  const label = (id) => EXPORT_DATASETS[id].label;
  render(
    container,
    html`
      ${pageHeader({ title: "Downloads" })}
      ${ids.length
        ? html`<ul class="wl-list" data-role="downloads">${ids.map(
            (id) => html`<li class="wl-row" data-download="${id}"><span class="wl-main"><span class="wl-name">${label(id)}</span><span class="wl-sub">Excel (.xlsx), the whole list</span></span>${exportButton(id, "Download")}</li>`
          )}</ul>`
        : emptyState({ title: "Nothing to download", body: "Downloads aren't available for your account." })}`
  );
  const unbind = bindExport(container, (id) => ({ ...(FILTERS[id] || {}) }), { toast, deps: exportDeps });
  return () => unbind();
}
