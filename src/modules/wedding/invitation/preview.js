// Owner-pilot Bridal: the guest's invitation, previewed INSIDE Luna, with an
// Owner-only bar on top (Copy guest link / Share / Open as guest / Close).
// The page itself is the public invitation in preview mode: answers aren't
// sent and the address bar is left alone. A guest opening their own link
// never sees this bar (it only exists in the signed-in app).

import { html, render } from "../../../lib/html.js";

// actions: [{ id, label, href? }]; onAction(id) for the buttons.
export async function openInvitePreview({ token = "", fetchImpl, note = "Preview: what your guest sees", actions = [], onAction = () => {} }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop inv-preview-backdrop";
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  render(
    backdrop,
    html`<div class="inv-preview" role="dialog" aria-modal="true" aria-label="Invitation preview" data-role="invite-preview">
      <div class="inv-preview-bar" data-role="owner-bar"><span class="inv-preview-note">${note}</span><span class="inv-preview-actions">${actions.map((a) => (a.href ? html`<a class="btn btn-compact" href="${a.href}" target="_blank" rel="noopener" data-pv="${a.id}">${a.label}</a>` : html`<button type="button" class="btn btn-compact" data-pv="${a.id}">${a.label}</button>`))}<button type="button" class="btn btn-compact btn-primary" data-pv="close">Close</button></span></div>
      <div class="inv-preview-body" data-role="invite-preview-body"></div>
    </div>`
  );
  backdrop.addEventListener("click", (ev) => {
    const id = ev.target.closest("[data-pv]")?.dataset.pv;
    if (id === "close") close();
    else if (id && !ev.target.closest("a[data-pv]")) onAction(id, ev.target.closest("[data-pv]"));
  });
  const { renderInvitePage } = await import("./renderer.js");
  await renderInvitePage(backdrop.querySelector('[data-role="invite-preview-body"]'), { token, ...(fetchImpl ? { fetchImpl } : {}), preview: true });
  return { close, backdrop };
}

// Copy text; true when the clipboard took it.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
export const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";
