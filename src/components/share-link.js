// "Send this link" dialog (Phase 18.6): shows a one-time link (account
// activation) exactly once, with Copy and a ready-to-send message. The link
// is never stored in the browser; closing the dialog drops it.
//
// shareLinkDialog({ title, intro, link, rows: [[label, value]], message, copy })
// resolves when closed.

import { html, render } from "../lib/html.js";

export const activationUrl = (token, origin = window.location.origin) => `${origin}/activate#${token}`;

export function shareLinkDialog({ title, intro = "", link, rows = [], message = "", copy = (t) => navigator.clipboard?.writeText(t), toast = () => {} }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const text = message ? `${message}\n${link}` : link;
    render(
      backdrop,
      html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="sl-title" data-role="share-link">
        <div class="modal-header"><h2 class="card-title" id="sl-title">${title}</h2></div>
        <div class="modal-body">
          ${intro ? html`<p class="stat-note">${intro}</p>` : ""}
          ${rows.length ? html`<dl class="dl dl-compact">${rows.map(([k, v]) => html`<dt>${k}</dt><dd><strong>${v}</strong></dd>`)}</dl>` : ""}
          <div class="field"><label for="sl-link">Link (works once)</label><input class="input" id="sl-link" readonly value="${link}" data-role="link-text" /></div>
          <p class="stat-hint">Send it by Messenger, Viber or SMS. Luna shows it only now; you can make a new one later if it's lost.</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-x="copy-message">Copy message</button>
          <button type="button" class="btn btn-primary" data-x="copy">Copy link</button>
          <button type="button" class="btn btn-ghost" data-x="close">Done</button>
        </div>
      </div>`
    );
    const close = () => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve();
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    backdrop.addEventListener("click", async (e) => {
      const x = e.target.closest("[data-x]")?.dataset.x;
      if (x === "close") return close();
      if (x === "copy" || x === "copy-message") {
        try {
          await copy(x === "copy" ? link : text);
          toast(x === "copy" ? "Link copied." : "Message copied.", "success");
        } catch {
          backdrop.querySelector('[data-role="link-text"]').select();
          toast("Copy the link from the box.", "neutral");
        }
      }
      return undefined;
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-x="copy"]').focus();
  });
}
