// Small presentational building blocks. Each returns SafeHtml from html``,
// so any data passed in is escaped automatically.
//
// Phase 18.5 adds the shared Luna primitives every workspace uses (no
// screen invents its own version): KPI strip, Needs attention, section,
// progress bar (SVG: the CSP forbids style=""), count tiles, item list,
// segmented control, row ⋯ menu, skeleton, the phone row summary, and the
// filter bar with removable chips.

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

// tone: "neutral" | "success" | "warning" | "danger" | "info" | "primary" | "accent"
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

export function emptyState({ title, body = "", iconName = "inbox", action = "" }) {
  return html`
    <div class="empty-state">
      ${icon(iconName)}
      <div class="empty-state-title">${title}</div>
      ${body ? html`<p class="empty-state-body">${body}</p>` : ""}
      ${action}
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

// ---------- Phase 18.5 primitives ----------

// A titled section (one topic, one surface). `link`: { href, label } for
// "where to go for more detail".
export function section({ title, hint = "", link = null, body, id = "", extra = "" }) {
  return html`
    <section class="card" ${id ? html`data-section="${id}"` : ""}>
      <div class="section-head">
        <h2>${title}${hint ? html` <span class="hint">${hint}</span>` : ""}</h2>
        ${link ? html`<a class="link-more" href="${link.href}" data-link>${link.label} ›</a>` : ""}${extra}
      </div>
      ${body}
    </section>
  `;
}

// items: [{ id, label, value, hint?, empty?, hintTone? }]
export function kpiStrip(items, { role = "kpis" } = {}) {
  return html`
    <div class="kpis" data-cols="${items.length}" data-role="${role}">
      ${items.map(
        (k) => html`<div class="kpi" data-widget="${k.id}">
          <div class="kpi-label">${k.label}</div>
          <div class="kpi-value${k.empty ? " is-empty" : ""}">${k.value}</div>
          ${k.hint ? html`<div class="kpi-hint${k.hintTone ? ` is-${k.hintTone}` : ""}">${k.hint}</div>` : ""}
        </div>`
      )}
    </div>
  `;
}

// items: [{ id, text, detail?, tone: "danger"|"warning"|"info", href? }]
export function attentionList(items, { clear = "All clear. Nothing needs you right now." } = {}) {
  if (!items.length) return html`<p class="all-clear" data-role="all-clear">✓ ${clear}</p>`;
  return html`<ul class="attention" data-role="attention">
    ${items.map((a) => {
      const inner = html`<span class="attention-dot tone-${a.tone || "info"}" aria-hidden="true"></span>
        <span class="attention-text">${a.text}${a.detail ? html`<small>${a.detail}</small>` : ""}</span>
        ${a.href ? html`<span class="attention-go" aria-hidden="true">›</span>` : ""}`;
      return html`<li data-attention="${a.id}">${a.href ? html`<a class="attention-item" href="${a.href}" data-link>${inner}</a>` : html`<div class="attention-item">${inner}</div>`}</li>`;
    })}
  </ul>`;
}

// Progress bar drawn in SVG (width attribute, CSP-safe). pct 0..100.
export function bar(pct, { tone = "", label = "", thick = false } = {}) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return html`<svg class="bar${thick ? " is-thick" : ""}" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${label || `${Math.round(p)}%`}"><rect class="bar-track" x="0" y="0" width="100" height="8" rx="4"></rect>${p > 0 ? html`<rect class="bar-fill${tone ? ` tone-${tone}` : ""}" x="0" y="0" width="${p.toFixed(2)}" height="8" rx="4"></rect>` : ""}</svg>`;
}

// Budget tone: over = danger, >= 90% = warning.
export const budgetTone = (used, total) => (total > 0 && used > total ? "danger" : total > 0 && used / total >= 0.9 ? "warning" : "");

// rows: [{ id, label, value, pct, tone? }]
export function barRows(rows, { role = "bars" } = {}) {
  return html`<div class="bar-rows" data-role="${role}">
    ${rows.map((r) => html`<div class="bar-row" data-row="${r.id}"><div class="bar-row-top"><span>${r.label}</span><span>${r.value}</span></div>${bar(r.pct, { tone: r.tone, label: `${r.label}: ${r.value}` })}</div>`)}
  </div>`;
}

// tiles: [{ id, label, value, href?, hot?, danger? }]
export function countTiles(tiles, { role = "counts" } = {}) {
  return html`<div class="count-tiles" data-role="${role}">
    ${tiles.map((t) => {
      const cls = `count-tile${t.hot ? " is-hot" : ""}${t.danger ? " is-danger" : ""}`;
      const inner = html`<b>${t.value}</b><span>${t.label}</span>`;
      return t.href ? html`<a class="${cls}" href="${t.href}" data-link data-count="${t.id}">${inner}</a>` : html`<div class="${cls}" data-count="${t.id}">${inner}</div>`;
    })}
  </div>`;
}

// rows: [{ id, title, sub?, end?, endSub?, href?, controls? }]
export function itemList(rows, { role = "items", scroll = false } = {}) {
  return html`<ul class="items${scroll ? " scroll-list" : ""}" data-role="${role}">
    ${rows.map((r) => {
      const inner = html`<span class="item-main"><span class="item-title">${r.title}</span>${r.sub ? html`<span class="item-sub">${r.sub}</span>` : ""}${r.controls ? html`<span class="item-controls">${r.controls}</span>` : ""}</span>
        ${r.end !== undefined && r.end !== null ? html`<span class="item-end">${r.end}${r.endSub ? html`<small>${r.endSub}</small>` : ""}</span>` : ""}`;
      return html`<li data-item="${r.id}">${r.href ? html`<a class="item" href="${r.href}" data-link>${inner}</a>` : html`<div class="item">${inner}</div>`}</li>`;
    })}
  </ul>`;
}

// options: [[value, label]]; data-act="seg" data-seg="<name>" data-value.
export function segmented(name, options, value, { label = "" } = {}) {
  return html`<div class="seg" role="group" aria-label="${label || name}" data-role="seg-${name}">
    ${options.map(([v, l]) => html`<button type="button" class="seg-btn${v === value ? " is-on" : ""}" aria-pressed="${v === value ? "true" : "false"}" data-act="seg" data-seg="${name}" data-value="${v}">${l}</button>`)}
  </div>`;
}

// The phone summary of a row (shown only below 720px; desktop shows columns).
export function mobileCell({ title, sub = "", end = "", endSub = "" }) {
  return html`<td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${title}</span>${sub ? html`<span class="m-sub">${sub}</span>` : ""}</div>${end !== "" && end !== null ? html`<div class="m-end">${end}${endSub ? html`<small>${endSub}</small>` : ""}</div>` : ""}</div></td>`;
}

// The row's "open details" affordance: a quiet chevron button (keeps the
// data-act/id hooks; the whole row is clickable too).
export function openButton(id, label, { act = "open", attr = "id" } = {}) {
  return html`<button type="button" class="btn-icon" data-act="${act}" data-${attr}="${id}" aria-label="${label}" title="${label}">${icon("chevron")}</button>`;
}

export function skeleton(lines = 4) {
  return html`<div class="skeleton" aria-busy="true" aria-label="Loading">${Array.from({ length: lines }, () => html`<div class="skeleton-line"></div>`)}</div>`;
}

// ---------- Filter bar ----------
// fields: [{ name, label, type: "select"|"date"|"search", options?: [[v,l]],
//            all?: "Any status", primary?: true, value }]
// Primary fields sit in the toolbar and apply on change; the rest live under
// "More filters". Active filters show as removable chips. The form keeps
// data-role="filters" so each screen's submit handler (and Download Excel,
// which sends the APPLIED filters) works as before.
export function filterBar({ fields, open = false, end = "", count = null, role = "filters" }) {
  const primary = fields.filter((f) => f.primary);
  const more = fields.filter((f) => !f.primary);
  const active = fields.filter((f) => f.value !== undefined && f.value !== null && f.value !== "");
  const control = (f) => {
    if (f.type === "select")
      return html`<select class="select" name="${f.name}" aria-label="${f.label}">
        <option value="">${f.all || `Any ${f.label.toLowerCase()}`}</option>
        ${f.options.map(([v, l]) => html`<option value="${v}" ${String(f.value ?? "") === String(v) ? "selected" : ""}>${l}</option>`)}
      </select>`;
    if (f.type === "search") return html`<input class="input grow" type="search" name="${f.name}" value="${f.value ?? ""}" placeholder="${f.placeholder || f.label}" aria-label="${f.label}" autocomplete="off" />`;
    return html`<input class="input" type="date" name="${f.name}" value="${f.value ?? ""}" ${f.max ? html`max="${f.max}"` : ""} aria-label="${f.label}" />`;
  };
  const chipText = (f) => (f.type === "select" ? (f.options.find(([v]) => String(v) === String(f.value))?.[1] ?? f.value) : f.type === "date" ? `${f.label}: ${f.value}` : `“${f.value}”`);
  const moreActive = more.some((f) => active.includes(f));
  return html`
    <form class="filter-form" data-role="${role}" data-auto-apply>
      <div class="toolbar">
        ${primary.map(control)}
        ${more.length ? html`<button type="button" class="btn btn-ghost" data-act="toggle-more" aria-expanded="${open || moreActive ? "true" : "false"}">${icon("filter")} More filters</button>` : ""}
        <button type="submit" class="visually-hidden" tabindex="-1">Apply</button>
        <div class="toolbar-end">${end}</div>
      </div>
      ${more.length ? html`<div class="more-filters" data-role="more-filters" ${open || moreActive ? "" : "hidden"}>${more.map((f) => html`<label>${f.label}${control(f)}</label>`)}</div>` : ""}
      ${active.length || count !== null
        ? html`<div class="chips" data-role="chips">
            ${active.map((f) => html`<span class="chip" data-chip="${f.name}">${chipText(f)}<button type="button" class="chip-x" data-clear-filter="${f.name}" aria-label="Remove filter ${chipText(f)}">×</button></span>`)}
            ${active.length > 1 ? html`<button type="button" class="chip-clear" data-clear-filter="*">Clear all</button>` : ""}
            ${count !== null ? html`<span class="result-count">${count}</span>` : ""}
          </div>`
        : ""}
    </form>
  `;
}

// Wires every filter form in `root`: a change applies at once (requestSubmit,
// so each screen's existing submit handler runs), × chips clear one field,
// "More filters" toggles. Search fields apply on Enter or after a pause.
export function bindFilterBar(root) {
  let timer = null;
  const submit = (form) => (typeof form.requestSubmit === "function" ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })));
  const onChange = (e) => {
    const form = e.target.closest("form[data-auto-apply]");
    if (!form || !root.contains(form) || e.target.type === "search") return;
    submit(form);
  };
  const onInput = (e) => {
    const form = e.target.closest("form[data-auto-apply]");
    if (!form || e.target.type !== "search") return;
    clearTimeout(timer);
    timer = setTimeout(() => form.isConnected && submit(form), 450);
  };
  const onClick = (e) => {
    const clear = e.target.closest("[data-clear-filter]");
    const toggle = e.target.closest('[data-act="toggle-more"]');
    const form = (clear || toggle)?.closest("form[data-auto-apply]");
    if (!form || !root.contains(form)) return;
    if (toggle) {
      const panel = form.querySelector('[data-role="more-filters"]');
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
      return;
    }
    const name = clear.dataset.clearFilter;
    for (const el of form.elements) if (el.name && (name === "*" || el.name === name)) el.value = "";
    submit(form);
  };
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("click", onClick);
  return () => {
    clearTimeout(timer);
    root.removeEventListener("change", onChange);
    root.removeEventListener("input", onInput);
    root.removeEventListener("click", onClick);
  };
}

// A row ⋯ menu. items: [{ act, label, danger?, sep? }] (data-id on each).
export function rowMenu(id, items, { label = "More actions" } = {}) {
  if (!items.length) return "";
  return html`<div class="menu-wrap" data-menu="${id}">
    <button type="button" class="btn-icon" data-act="row-menu" data-id="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="${label}">${icon("more")}</button>
    <div class="menu menu-down" role="menu" hidden>
      ${items.map((i) => (i.sep ? html`<div class="menu-sep" role="separator"></div>` : html`<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="${i.act}" data-id="${id}">${i.label}</button>`))}
    </div>
  </div>`;
}

// Opens/closes row menus inside `root` (one at a time; Escape/outside closes).
export function bindRowMenus(root) {
  const closeAll = (except = null) => {
    for (const m of root.querySelectorAll(".menu-wrap[data-menu] > .menu:not([hidden])")) {
      if (m === except) continue;
      m.hidden = true;
      m.parentElement.querySelector('[data-act="row-menu"]')?.setAttribute("aria-expanded", "false");
    }
  };
  const onClick = (e) => {
    const btn = e.target.closest('[data-act="row-menu"]');
    if (btn && root.contains(btn)) {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector(".menu");
      closeAll(menu);
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden) menu.querySelector(".menu-item")?.focus();
      return;
    }
    if (!e.target.closest(".menu-wrap[data-menu]")) closeAll();
    else if (e.target.closest(".menu-item")) closeAll();
  };
  const onKey = (e) => e.key === "Escape" && closeAll();
  root.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  return () => {
    root.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey);
  };
}

// Whole-row click opens details: clicks on a row (outside its controls)
// are forwarded to the row's [data-act="open"] button.
export function bindRowOpen(root, { act = "open" } = {}) {
  const onClick = (e) => {
    if (e.target.closest("button, a, select, input, label, .menu-wrap, textarea")) return;
    const row = e.target.closest("tr[data-open]");
    if (!row || !root.contains(row)) return;
    row.querySelector(`[data-act="${act}"]`)?.click();
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}
