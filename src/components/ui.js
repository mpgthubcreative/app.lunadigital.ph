// Small presentational building blocks. Each returns SafeHtml from html``,
// so any data passed in is escaped automatically.

import { html } from "../lib/html.js";
import { icon } from "./icons.js";

export function pageHeader({ title, subtitle = "", actions = "" }) {
  return html`
    <header class="page-header">
      <div>
        <h1 class="page-title">${title}</h1>
        ${subtitle ? html`<p class="page-subtitle">${subtitle}</p>` : ""}
      </div>
      ${actions ? html`<div class="page-actions">${actions}</div>` : ""}
    </header>
  `;
}

// tone: "neutral" | "success" | "warning" | "danger" | "info" | "primary"
export function badge(text, tone = "neutral") {
  return html`<span class="badge badge-${tone}">${text}</span>`;
}

// empty: the value is a placeholder ("No data yet", "…"), styled quietly.
// note: longer explanatory text shown under the card (e.g. what an estimate excludes).
export function statCard({ label, value = "—", hint = "", empty = false, note = "", id = "" }) {
  return html`
    <div class="card stat-card" ${id ? html`data-widget="${id}"` : ""}>
      <div class="stat-label">${label}</div>
      <div class="stat-value${empty ? " is-empty" : ""}">${value}</div>
      ${hint ? html`<div class="stat-hint">${hint}</div>` : ""}
      ${note ? html`<p class="stat-note">${note}</p>` : ""}
    </div>
  `;
}

export function emptyState({ title, body = "", iconName = "inbox" }) {
  return html`
    <div class="empty-state">
      ${icon(iconName)}
      <div class="empty-state-title">${title}</div>
      ${body ? html`<p class="empty-state-body">${body}</p>` : ""}
    </div>
  `;
}

export function card({ title, actions = "", body }) {
  return html`
    <section class="card">
      ${title
        ? html`<div class="card-header"><h2 class="card-title">${title}</h2>${actions}</div>`
        : ""}
      <div class="card-body">${body}</div>
    </section>
  `;
}

export function meter({ label, used, limit, format = (n) => String(n), showPercent = false }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  // The real percentage (can exceed 100 when a limit was lowered below usage).
  const real = limit > 0 ? Math.round((used / limit) * 100) : used > 0 ? 100 : 0;
  return html`
    <div class="meter-row">
      <div class="meter-head">
        <span>${label}</span>
        <span class="meter-value">${format(used)} / ${format(limit)}${showPercent ? html` <span class="meter-pct" data-role="percent">${real}%</span>` : ""}</span>
      </div>
      <progress class="meter" max="100" value="${pct}" aria-label="${label}"></progress>
    </div>
  `;
}
