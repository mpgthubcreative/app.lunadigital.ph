// "Share menu" (Owner pilot): the business's public menu / order link.
// Anyone who sees Orders can copy, share or preview it; the store's
// settings (open / closed, name, link name, pickup / delivery, payment
// choices, products shown) are for settings.manage (the Owner). Customers'
// orders arrive in Orders like any other order (source "Online store").
//
// 2026-10-22: Online ordering On / Off is stated up front (Off: customers
// who open the link see that ordering is unavailable), and the Store link
// (a customer creates a NEW order) is told apart from an order's Payment
// link (a customer pays an EXISTING order; Orders → the order). They are
// separate links with separate security (a public store slug vs a secret
// per-order token).
// openShareMenu({ session, api, toast, listActiveProducts, origin?, host? })
// resolves when closed. host: render as a page into that element (More →
// Share menu) instead of a dialog.

import { html, render } from "../../lib/html.js";
import { pageHeader } from "../../components/ui.js";
import { STORE_PAYMENT_METHOD_IDS, PAYMENT_METHODS, STORE_FULFILLMENT } from "@shared/index.js";

export function openShareMenu({ session, api, toast, listActiveProducts, origin = window.location.origin, share = typeof navigator !== "undefined" && navigator.share ? (d) => navigator.share(d) : null, copy = (t) => navigator.clipboard?.writeText(t), host = null }) {
  return new Promise((resolve) => {
    const state = { status: "loading", message: "", settings: null, path: "", canManage: false, busy: false, error: "", products: null };
    const backdrop = host || document.createElement("div");
    if (!host) backdrop.className = "modal-backdrop";
    const link = () => `${origin}${state.path}`;

    function settingsForm(s) {
      const hidden = new Set(s.hiddenProductIds);
      return html`<details class="sm-settings" data-role="store-settings">
        <summary>Store settings</summary>
        <form data-role="settings-form" novalidate>
          <div class="field"><label for="sm-name">Store name</label><input class="input" id="sm-name" name="displayName" maxlength="80" value="${s.displayName}" /></div>
          <div class="field"><label for="sm-note">Note to customers <span class="co-optional">optional</span></label><input class="input" id="sm-note" name="note" maxlength="200" value="${s.note}" placeholder="e.g. Orders before 3pm are delivered today" /></div>
          <div class="field"><label for="sm-slug">Link name</label><input class="input" id="sm-slug" name="slug" maxlength="50" value="${s.slug}" autocomplete="off" /><div class="stat-hint">${origin}/store/<b>${s.slug}</b> · changing it stops the old link.</div></div>
          <fieldset class="field"><legend>How customers get their order</legend>${Object.keys(STORE_FULFILLMENT).map((k) => html`<label class="sm-check"><input type="checkbox" name="${k}" ${s[k] ? "checked" : ""} /> ${STORE_FULFILLMENT[k].label}</label>`)}</fieldset>
          <div class="field"><label for="sm-pay">Payment instructions <span class="co-optional">shown on order payment links</span></label><textarea class="input" id="sm-pay" name="paymentInstructions" rows="3" maxlength="500" placeholder="e.g. GCash 0917 123 4567 (Ana R.)">${s.paymentInstructions || ""}</textarea></div>
          <fieldset class="field"><legend>Payment choices shown</legend>${STORE_PAYMENT_METHOD_IDS.map((m) => html`<label class="sm-check"><input type="checkbox" name="pm" value="${m}" ${s.paymentMethods.includes(m) ? "checked" : ""} /> ${PAYMENT_METHODS[m].label}</label>`)}</fieldset>
          <details class="sm-products" data-role="products-fold">
            <summary>Products shown <span class="co-optional">${hidden.size ? `${hidden.size} hidden` : "all active products with a price"}</span></summary>
            <div data-role="products">${state.products === null ? html`<p class="stat-hint">Loading…</p>` : state.products.length ? state.products.map((p) => html`<label class="sm-check"><input type="checkbox" name="show" value="${p.id}" ${hidden.has(p.id) ? "" : "checked"} /> ${p.name}</label>`) : html`<p class="stat-hint">No active products yet.</p>`}</div>
          </details>
          <p class="form-error" data-role="settings-error" role="alert" ${state.error ? "" : "hidden"}>${state.error}</p>
          <button type="submit" class="btn btn-primary" data-x="save" ${state.busy ? "disabled" : ""}>${state.busy ? "Saving…" : "Save settings"}</button>
        </form>
      </details>`;
    }

    // Online ordering On / Off first: what customers who open the link get.
    const ordering = (s) => html`<section class="sm-ordering" data-role="online-ordering">
        <div class="sm-ordering-row"><span class="sm-ordering-label">Online ordering</span>
          ${state.canManage
            ? html`<span class="seg" role="group" aria-label="Online ordering"><button type="button" class="seg-btn${s.open ? " is-on" : ""}" data-x="on" aria-pressed="${s.open}" ${state.busy ? "disabled" : ""}>On</button><button type="button" class="seg-btn${s.open ? "" : " is-on"}" data-x="off" aria-pressed="${!s.open}" ${state.busy ? "disabled" : ""}>Off</button></span>`
            : html`<b class="${s.open ? "tone-success" : "tone-muted"}" data-role="store-status">${s.open ? "On" : "Off"}</b>`}</div>
        <p class="${s.open ? "stat-hint" : "sm-off"}" data-role="ordering-note">${s.open ? "Customers can place orders from your store link. They arrive in Orders as \"Online store\"; nothing is fulfilled until you do it there." : "Online ordering is currently off. Customers who open your store link will see that ordering is unavailable."}</p>
      </section>`;
    function body() {
      const s = state.settings;
      return state.status === "loading"
        ? html`<p class="stat-hint">Loading…</p>`
        : state.status === "error"
          ? html`<p class="form-error" data-role="message">${state.message}</p>`
          : html`${ordering(s)}
              <div class="field"><label for="sm-link">Store link <span class="co-optional">customers create a new order</span></label><input class="input" id="sm-link" readonly value="${link()}" data-role="link" /></div>
              <div class="sm-actions">
                <button type="button" class="btn btn-primary" data-x="copy">Copy</button>
                ${share ? html`<button type="button" class="btn" data-x="share">Share</button>` : ""}
                <a class="btn" href="${state.path}" target="_blank" rel="noopener" data-x="preview">Preview</a>
              </div>
              <p class="stat-hint" data-role="link-kinds">To get paid for an order you already have, send its Payment link instead (Orders → the order → Payment link). It's a different, private link for that one order.</p>
              ${state.canManage ? settingsForm(s) : ""}`;
    }
    function draw() {
      render(
        backdrop,
        host
          ? html`<div data-role="share-menu" class="sm-page">${pageHeader({ title: "Share menu" })}<section class="card"><div class="card-body">${body()}</div></section></div>`
          : html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="sm-title" data-role="share-menu">
          <div class="modal-header"><h2 class="card-title" id="sm-title">Share menu</h2></div>
          <div class="modal-body">${body()}</div>
          <div class="modal-footer"><button type="button" class="btn btn-ghost" data-x="close">Close</button></div>
        </div>`
      );
    }

    async function save(changes, okText) {
      state.busy = true;
      state.error = "";
      draw();
      try {
        const r = await api("storefront", { method: "POST", body: { action: "save", settings: changes } });
        state.settings = r.settings;
        state.path = r.path;
        toast(okText, "success");
      } catch (err) {
        state.error = err.message || "Couldn't save the settings.";
        // The form's error line is out of sight while Store settings is folded (e.g. the open / closed tap).
        if (!backdrop.querySelector('[data-role="store-settings"]')?.open) toast(state.error, "danger");
      }
      state.busy = false;
      const wasOpen = backdrop.querySelector('[data-role="store-settings"]')?.open;
      const productsOpen = backdrop.querySelector('[data-role="products-fold"]')?.open;
      draw();
      if (wasOpen) backdrop.querySelector('[data-role="store-settings"]').open = true;
      if (productsOpen) backdrop.querySelector('[data-role="products-fold"]').open = true;
    }

    const close = () => {
      document.removeEventListener("keydown", onKey);
      if (!host) backdrop.remove();
      resolve();
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    backdrop.addEventListener("click", async (e) => {
      const x = e.target.closest("[data-x]")?.dataset.x;
      if (x === "close" || (!host && e.target === backdrop)) return close();
      if ((x === "on" || x === "off") && state.settings && state.settings.open !== (x === "on")) {
        return save({ open: x === "on" }, x === "on" ? "Online ordering is on." : "Online ordering is off. Customers who open the link see that ordering is unavailable.");
      }
      if (x === "copy") {
        try {
          await copy(link());
          toast("Store link copied.", "success");
        } catch {
          backdrop.querySelector('[data-role="link"]').select();
          toast("Copy the link from the box.", "neutral");
        }
      }
      if (x === "share") {
        try {
          await share({ title: state.settings.displayName, text: `Order from ${state.settings.displayName}`, url: link() });
        } catch {
          /* cancelled */
        }
      }
      return undefined;
    });
    backdrop.addEventListener(
      "toggle",
      (e) => {
        if (e.target.dataset?.role !== "products-fold" || !e.target.open || state.products !== null) return;
        Promise.resolve(listActiveProducts(session.business.id))
          .then((rows) => (state.products = rows.filter((p) => p.status === "active").sort((a, b) => a.name.localeCompare(b.name))))
          .catch(() => (state.products = []))
          .then(() => {
            const box = backdrop.querySelector('[data-role="products"]');
            if (box) render(box, state.products.length ? html`${state.products.map((p) => html`<label class="sm-check"><input type="checkbox" name="show" value="${p.id}" ${state.settings.hiddenProductIds.includes(p.id) ? "" : "checked"} /> ${p.name}</label>`)}` : html`<p class="stat-hint">No active products yet.</p>`);
          });
      },
      true
    );
    backdrop.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const changes = {
        displayName: String(fd.get("displayName") || ""),
        note: String(fd.get("note") || ""),
        paymentInstructions: String(fd.get("paymentInstructions") || ""),
        slug: String(fd.get("slug") || "").trim().toLowerCase(),
        pickup: fd.has("pickup"),
        delivery: fd.has("delivery"),
        paymentMethods: fd.getAll("pm").map(String),
      };
      // Only when the list was opened (unopened = unchanged).
      if (state.products !== null) {
        const shown = new Set(fd.getAll("show").map(String));
        changes.hiddenProductIds = state.products.filter((p) => !shown.has(p.id)).map((p) => p.id);
      }
      save(changes, "Store settings saved.");
    });
    if (!host) {
      document.addEventListener("keydown", onKey);
      document.body.appendChild(backdrop);
    }
    draw();
    api("storefront", { method: "POST", body: { action: "get" } })
      .then((r) => {
        state.settings = r.settings;
        state.path = r.path;
        state.canManage = r.canManage === true;
        state.status = "ok";
      })
      .catch((err) => {
        state.status = "error";
        state.message = err.message || "Couldn't load the menu link.";
      })
      .then(() => {
        draw();
        backdrop.querySelector('[data-x="copy"]')?.focus();
      });
  });
}
