// Owner-pilot Bridal: the read-only Sample Checklist (Tasks) and Sample
// Budget (Money). One compact line per sample item, grouped:
//   CEREMONY
//   Church / ceremony venue                       + Add
//   Officiant / priest              Optional      Added ✓
// Nothing is a record until + Add (the module turns it into a normal task
// or a Planned Money line). Content: @shared/wedding-samples.js.

import { html } from "../../lib/html.js";
import { sampleKey } from "@shared/wedding-samples.js";

// groups: SAMPLE_*; added: Set of lower-cased titles already on her list.
export function sampleList({ groups, added, canAdd, intro, role }) {
  return html`<p class="stat-hint wl-sample-intro">${intro}</p>
    ${groups.map(
      (g) => html`<section class="wl-section wl-sample-group" data-sample-group="${g.id}">
        <h2 class="wl-cat-head"><span class="wl-group-title">${g.label}</span>${g.optional && !g.note ? html`<span class="wl-cat-counts">· optional</span>` : ""}</h2>
        ${g.note ? html`<p class="stat-hint wl-sample-note" data-role="sample-note">${g.note}</p>` : ""}
        <ul class="wl-list" data-role="${role}">${g.items.map((it, i) => {
          if (it.heading) return html`<li class="wl-sample-sub" data-role="sample-sub">${it.heading}</li>`;
          const done = added.has(sampleKey(it.title));
          return html`<li class="wl-row wl-sample" data-sample="${g.id}:${i}"><span class="wl-main"><span class="wl-name">${it.title}</span>${it.both ? html`<small class="wl-opt">Bride & Groom</small>` : ""}${it.optional ? html`<small class="wl-opt">Optional</small>` : ""}</span>${done ? html`<span class="wl-added" data-role="added">Added ✓</span>` : canAdd ? html`<button type="button" class="btn btn-compact" data-act="sample-add" data-group="${g.id}" data-i="${i}" aria-label="Add ${it.title}">+ Add</button>` : ""}</li>`;
        })}</ul>
      </section>`
    )}`;
}
// The sample item a + Add button points at.
export const sampleItem = (groups, el) => {
  const g = groups.find((x) => x.id === el.dataset.group);
  const item = g?.items[Number(el.dataset.i)];
  return item ? { group: g, item } : null;
};
