// Example empty states (2026-10-25): a short message, 2–4 realistic
// examples drawn like the real rows (but quiet, marked "Example", not
// tappable) and one obvious Add button. Visual guidance only: examples are
// never saved, never counted in a total, never exported. Once a module has
// real records its page shows those instead.

import { html } from "../lib/html.js";

// title / body: the short message; items: [{ name, sub?, end? }];
// add: { act, label } (the page's own Add action); helper: one quiet line.
// wrap: the second line wraps instead of being cut short (phones).
export function examplesState({ title, body = "", items = [], add = null, helper = "", role = "examples", wrap = false }) {
  return html`<section class="ex-state${wrap ? " ex-wrap" : ""}" data-role="${role}" aria-label="Examples">
    <p class="ex-title">${title}</p>
    ${body ? html`<p class="stat-hint ex-body">${body}</p>` : ""}
    <ul class="wl-list ex-list" aria-hidden="true">${items.map((i) => html`<li class="wl-row ex-row" data-example><span class="wl-main"><span class="wl-name">${i.name}</span>${i.sub ? html`<span class="wl-sub">${i.sub}</span>` : ""}</span>${i.end ? html`<span class="ex-end">${i.end}</span>` : ""}<span class="ex-tag">Example</span></li>`)}</ul>
    ${add ? html`<p class="ex-add"><button type="button" class="btn btn-primary" data-act="${add.act}">${add.label}</button></p>` : ""}
    ${helper ? html`<p class="stat-hint ex-helper">${helper}</p>` : ""}
  </section>`;
}
