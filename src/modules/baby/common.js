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
// sections (Owner-pilot Bridal Details): extra read-only lists, e.g.
// { title: "Payment history", lines: ["₱10,000 paid Oct 1 · proof ✓"], empty: "Nothing paid yet." }.
// Hierarchy (2026-10-18), all optional:
//   subtitle      a quiet line under the title (e.g. the category)
//   hero          html shown first, above the rows (the key figures)
//   section.fold  { open: "View payment history", close: "Hide payment history" }:
//                 the section is collapsed until tapped
//   section lines may be { date, amount, sub? } (date left, amount right,
//                 a quiet second line) instead of text
//   activityFold  true: Activity is collapsed behind "View activity"
export function detailsDialog({ title, subtitle = "", badgeHtml = "", hero = "", rows, sections = [], activity = [], activityFold = false, actions = [], onAction }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop is-panel";
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  render(
    backdrop,
    html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${title}" data-role="details">
      <div class="modal-header dd-head"><div class="dd-titles"><h2 class="card-title dd-title">${title}</h2>${subtitle ? html`<p class="dd-sub" data-role="subtitle">${subtitle}</p>` : ""}</div>${badgeHtml ? html`<div class="page-actions">${badgeHtml}</div>` : ""}</div>
      <div class="modal-body">
        ${hero}
        ${rows.some(([, v]) => v !== null && v !== undefined && v !== "") ? html`<dl class="dl dl-compact" data-role="fields">${rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : ""}
        ${sections.map((sec) => {
          const list = sec.lines.length
            ? html`<ul class="list activity${typeof sec.lines[0] === "object" ? " dd-lines" : ""}" data-role="section">${sec.lines.map((l) => (typeof l === "object" ? html`<li class="dd-line"><span class="dd-date">${l.date}</span><b class="dd-amt">${l.amount}</b>${l.sub ? html`<small class="dd-line-sub">${l.sub}</small>` : ""}</li>` : html`<li>${l}</li>`))}</ul>`
            : html`<p class="stat-hint">${sec.empty || "None."}</p>`;
          return sec.fold
            ? html`<details class="dd-fold" data-role="fold-${sec.key || "section"}"><summary><span class="dd-when-closed">${sec.fold.open}</span><span class="dd-when-open">${sec.fold.close}</span></summary><h3 class="section-title">${sec.title}</h3>${list}</details>`
            : html`<h3 class="section-title">${sec.title}</h3>${list}`;
        })}
        ${activity.length
          ? activityFold
            ? html`<details class="dd-fold dd-quiet" data-role="fold-activity"><summary><span class="dd-when-closed">View activity</span><span class="dd-when-open">Hide activity</span></summary><ul class="list activity" data-role="activity">${activity.map((l) => html`<li>${l}</li>`)}</ul></details>`
            : html`<h3 class="section-title">Activity</h3><ul class="list activity" data-role="activity">${activity.map((l) => html`<li>${l}</li>`)}</ul>`
          : ""}
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
