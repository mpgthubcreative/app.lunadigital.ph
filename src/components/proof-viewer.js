// A payment / advance proof served privately by the API (never a public
// URL): an image is shown inline; a PDF opens from a temporary local link.
// load() -> { contentType, dataBase64 }.

import { html, render } from "../lib/html.js";

const IMAGE = /^image\/(jpeg|png|webp)$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export async function viewProof({ title, load }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  document.body.appendChild(backdrop);
  let blobUrl = null;
  const close = () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    backdrop.remove();
  };
  const paint = (body) => render(backdrop, html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${title}" data-role="proof-viewer"><div class="modal-header"><h2 class="card-title">${title}</h2></div><div class="modal-body proof-body">${body}</div><div class="modal-footer"><button type="button" class="btn btn-primary" data-act="close">Close</button></div></div>`);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest('[data-act="close"]')) close();
  });
  paint(html`<p class="stat-hint">Loading…</p>`);
  try {
    const proof = await load();
    if (!B64.test(proof?.dataBase64 || "")) throw new Error("Unexpected file");
    if (IMAGE.test(proof.contentType)) return paint(html`<img class="proof-image" alt="${title}" src="data:${proof.contentType};base64,${proof.dataBase64}" />`);
    if (proof.contentType === "application/pdf") {
      const bytes = Uint8Array.from(atob(proof.dataBase64), (c) => c.charCodeAt(0));
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      return paint(html`<p>This proof is a PDF.</p><a class="btn" href="${blobUrl}" target="_blank" rel="noopener" download="proof.pdf" data-role="open-pdf">Open the PDF</a>`);
    }
    throw new Error("Unexpected file");
  } catch (err) {
    paint(html`<p class="form-error">${err.message || "Couldn't load the proof."}</p>`);
  }
  return undefined;
}
