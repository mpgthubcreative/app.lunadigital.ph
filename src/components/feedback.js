// Toasts and confirmation dialogs. The browser's alert/confirm are never
// used — they block the page and can't be styled or tested.

import { html, render } from "../lib/html.js";

let toastRegion = null;

// tone: "neutral" | "success" | "danger"
export function toast(message, tone = "neutral", durationMs = 4000) {
  if (!toastRegion) {
    toastRegion = document.createElement("div");
    toastRegion.className = "toast-region";
    toastRegion.setAttribute("role", "status");
    toastRegion.setAttribute("aria-live", "polite");
    document.body.appendChild(toastRegion);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${tone}`;
  el.textContent = message;
  toastRegion.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// Resolves true when confirmed, false when cancelled/dismissed.
export function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    render(
      backdrop,
      html`
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="modal-header"><h2 class="card-title" id="confirm-title">${title}</h2></div>
          <div class="modal-body"><p>${body}</p></div>
          <div class="modal-footer">
            <button type="button" class="btn" data-action="cancel">${cancelLabel}</button>
            <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-action="confirm">${confirmLabel}</button>
          </div>
        </div>
      `
    );

    const previousFocus = document.activeElement;
    const close = (result) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(false);
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(false);
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action) close(action === "confirm");
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-action="cancel"]').focus();
  });
}
