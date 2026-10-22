// An order's payment link (2026-10-22), from the order's details:
//   Payment link  [https://…/pay/…]  [Copy]  [View]
//   What the customer sees: amount due ₱3,000 and your payment instructions
//   (Edit instructions: settings.manage)        Replace link (payments.verify)
// The link is made on first use (POST /api/payments payLink) and stays the
// same until replaced; replacing stops the old link at once.

import { html, render } from "../../lib/html.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog } from "../../components/feedback.js";
import { formatCentavos } from "../../lib/format.js";
import { MAX_PAYMENT_INSTRUCTIONS } from "@shared/index.js";

export function openPayLinkSheet({ order, api, toast, session, origin = window.location.origin, copy = (t) => navigator.clipboard?.writeText(t), confirm = confirmDialog }) {
  const perms = session.member.permissions;
  const canEditInstructions = perms["settings.manage"] === true;
  const canReplace = perms["payments.verify"] === true;
  const currency = session.business.currency || "PHP";
  const state = { status: "loading", path: "", instructions: null, error: "" };
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  document.body.appendChild(backdrop);
  const url = () => `${origin}${state.path}`;
  return new Promise((resolve) => {
    const close = () => {
      backdrop.remove();
      resolve(null);
    };
    const draw = () =>
      render(
        backdrop,
        html`<div class="modal" role="dialog" aria-modal="true" aria-label="Payment link" data-role="pay-link-sheet">
          <div class="modal-header"><h2 class="card-title">Payment link · ${order.orderNumber}</h2></div>
          <div class="modal-body">
            ${state.status === "loading"
              ? html`<p class="stat-hint">Getting the link…</p>`
              : state.status === "error"
                ? html`<p class="form-error" role="alert">${state.error}</p>`
                : html`<p class="stat-note">Send this to the customer. They see the amount due (${formatCentavos(order.balance ?? order.total, currency)}) and your payment instructions, and send a screenshot or reference. You verify it in Luna.</p>
                  <div class="pl-link"><input class="input" readonly value="${url()}" data-role="pay-link-url" aria-label="Payment link" /><button type="button" class="btn btn-primary" data-act="copy">Copy</button><a class="btn" href="${state.path}" target="_blank" rel="noopener" data-role="pay-link-view">View</a></div>
                  <h3 class="section-title">Payment instructions</h3>
                  ${state.instructions === null ? html`<p class="stat-hint">Loading…</p>` : state.instructions ? html`<p class="pl-instructions" data-role="instructions">${state.instructions}</p>` : html`<p class="stat-hint" data-role="no-instructions">None yet. Add your GCash / Maya number and bank account so customers know where to pay.</p>`}
                  ${canEditInstructions ? html`<button type="button" class="btn btn-compact" data-act="instructions">${state.instructions ? "Edit instructions" : "Add instructions"}</button>` : ""}`}
          </div>
          <div class="modal-footer">
            ${state.status === "ready" && canReplace ? html`<button type="button" class="btn btn-ghost" data-act="replace">Replace link</button>` : ""}
            <button type="button" class="btn" data-act="close">Close</button>
          </div>
        </div>`
      );
    const fetchLink = async (rotate = false) => {
      try {
        const r = await api("payments", { method: "POST", body: { action: "payLink", orderId: order.id, ...(rotate ? { rotate: true } : {}) } });
        state.path = r.path;
        state.status = "ready";
      } catch (err) {
        state.status = "error";
        state.error = err.message || "Couldn't get the payment link.";
      }
      draw();
    };
    backdrop.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (e.target === backdrop || act === "close") return close();
      if (act === "copy") {
        try {
          await copy(url());
          toast("Payment link copied ✓", "success");
        } catch {
          backdrop.querySelector('[data-role="pay-link-url"]')?.select();
          toast("Select the link and copy it.", "info");
        }
      }
      if (act === "replace") {
        if (!(await confirm({ title: "Replace the payment link?", body: "The old link stops working at once. Send the new one to the customer.", confirmLabel: "Replace link", danger: true }))) return undefined;
        state.status = "loading";
        draw();
        await fetchLink(true);
        toast("New payment link ready. The old one no longer works.", "success");
      }
      if (act === "instructions") {
        const r = await formDialog({
          title: "Payment instructions",
          intro: "Shown on every payment link (and nowhere else).",
          fields: [{ name: "text", label: "Where customers pay", type: "textarea", rows: 4, maxlength: MAX_PAYMENT_INSTRUCTIONS, value: state.instructions || "", placeholder: "e.g. GCash 0917 123 4567 (Ana R.)\nBDO 0012-3456-7890 (Ana Reyes)" }],
          submitLabel: "Save",
          onSubmit: (v) => api("storefront", { method: "POST", body: { action: "save", settings: { paymentInstructions: v.text } } }),
        });
        if (r) {
          state.instructions = r.settings?.paymentInstructions ?? "";
          toast("Payment instructions saved.", "success");
          draw();
        }
      }
      return undefined;
    });
    draw();
    fetchLink();
    api("storefront", { method: "POST", body: { action: "get" } })
      .then((r) => (state.instructions = r.settings?.paymentInstructions || ""))
      .catch(() => (state.instructions = ""))
      .then(() => backdrop.isConnected && draw());
  });
}
