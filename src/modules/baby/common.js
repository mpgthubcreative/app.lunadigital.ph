// Small helpers shared by the Baby screens (Phase 15).

import { html, render } from "../../lib/html.js";
import { when } from "../orders/view.js";

// A category's CURRENT name (renames show everywhere), else the name the
// record was saved with.
export const categoryName = (names, rec) => names.get(rec.category) ?? rec.categoryName ?? "—";

export const optionsOf = (list, { blank = null, include = null } = {}) => {
  const rows = list.map((x) => ({ value: x.id, label: x.name }));
  // Keep a record's current (possibly inactive) choice selectable.
  if (include && !rows.some((r) => r.value === include.value)) rows.push(include);
  return blank ? [{ value: "", label: blank }, ...rows] : rows;
};

// "Oct 9, 2026, 2:15 PM • Camille • Budget changed ₱150,000 → ₱180,000"
export const activityLines = (history, timezone) => (history || []).map((h) => [when(h.at, timezone), h.actor?.name ?? "", (h.label || h.type) + (h.reason ? ` · Reason: ${h.reason}` : "")].filter(Boolean).join(" • "));

// A read-only "View details" dialog: rows [[label, value]], activity lines,
// and footer buttons [{ act, label, danger? }]. onAction(act) -> true closes.
export function detailsDialog({ title, badgeHtml = "", rows, activity = [], actions = [], onAction }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop is-panel";
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  render(
    backdrop,
    html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${title}" data-role="details">
      <div class="modal-header"><h2 class="card-title">${title}</h2>${badgeHtml ? html`<div class="page-actions">${badgeHtml}</div>` : ""}</div>
      <div class="modal-body">
        <dl class="dl dl-compact" data-role="fields">${rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        ${activity.length ? html`<h3 class="section-title">Activity</h3><ul class="list activity" data-role="activity">${activity.map((l) => html`<li>${l}</li>`)}</ul>` : ""}
      </div>
      <div class="modal-footer">
        ${actions.map((a) => html`<button type="button" class="btn${a.danger ? " btn-danger" : ""}" data-act="${a.act}">${a.label}</button>`)}
        <button type="button" class="btn" data-act="close">Close</button>
      </div>
    </div>`
  );
  backdrop.addEventListener("click", async (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (ev.target === backdrop || act === "close") return close();
    if (act && (await onAction(act))) close();
    return undefined;
  });
  return close;
}

export const blankToNull = (v) => (typeof v === "string" && v.trim() === "" ? null : v);
