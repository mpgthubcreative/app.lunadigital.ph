// Public menu / order page (Owner pilot): /store/{slug}. No login. The
// customer browses the store's products, taps quantities (the total is
// computed as they tap), reviews, gives name + mobile (+ address for
// delivery) and places the order. The server (/api/store) prices every
// line again and creates ONE normal Luna order; the store fulfils it from
// Orders. One idempotency key per order, so a double tap or a retry after
// a dropped connection can't order twice.

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";
import { formatCentavos } from "../lib/format.js";
import { formatQuantity, lineAmount, QTY_SCALE, PAYMENT_METHODS, STORE_FULFILLMENT } from "@shared/index.js";

const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
export const storeSlugFrom = (pathname) => {
  const m = /^\/store\/([^/?#]+)\/?$/.exec(pathname || "");
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
};

async function call(body, fetchImpl) {
  const res = await fetchImpl("/api/store", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || "Something went wrong. Please try again."), { status: res.status, code: data.error });
  return data;
}

export function renderStorePage(root, { slug = storeSlugFrom(window.location.pathname), fetchImpl = (...a) => window.fetch(...a) } = {}) {
  const state = { status: "loading", message: "", store: null, products: [], term: "", qty: new Map(), step: "menu", form: { name: "", phone: "", fulfillment: "", address: "", paymentMethod: "", notes: "", website: "" }, key: newKey(), busy: false, error: "", result: null };
  const money = (c) => formatCentavos(c, state.store?.currency || "PHP").replace(/\.00$/, "");
  const byId = (id) => state.products.find((p) => p.id === id);
  const lines = () => state.products.filter((p) => (state.qty.get(p.id) || 0) > 0).map((p) => ({ p, q: state.qty.get(p.id), sub: lineAmount(state.qty.get(p.id), p.price) }));
  const totals = () => {
    const l = lines();
    return { lines: l, items: l.reduce((n, x) => n + x.q, 0), total: l.reduce((n, x) => n + x.sub, 0) };
  };
  const ways = () => Object.keys(STORE_FULFILLMENT).filter((k) => state.store?.[k]);

  function row(p) {
    const q = state.qty.get(p.id) || 0;
    const note = p.soldOut ? "Sold out" : p.left !== null ? `Only ${formatQuantity(p.left)} left` : "";
    return html`<li class="store-row${q ? " is-picked" : ""}${p.soldOut ? " is-out" : ""}" data-product="${p.id}">
      <span class="store-info"><span class="store-name">${p.name}</span><span class="store-price">${money(p.price)}${p.unitLabel && p.unit !== "pcs" ? ` / ${p.unitLabel}` : ""}</span>${note ? html`<span class="store-left" data-role="left">${note}</span>` : ""}</span>
      ${p.soldOut
        ? ""
        : html`<span class="co-qty">
            <button type="button" class="co-step" data-act="dec" data-id="${p.id}" aria-label="One less ${p.name}" ${q > 0 ? "" : "disabled"}>−</button>
            <span class="co-num store-num" data-role="qty" aria-live="polite">${formatQuantity(q)}</span>
            <button type="button" class="co-step" data-act="inc" data-id="${p.id}" aria-label="One more ${p.name}" ${q + QTY_SCALE <= p.max ? "" : "disabled"}>+</button>
          </span>`}
    </li>`;
  }

  function menuList() {
    const t = state.term.trim().toLocaleLowerCase("en");
    const shown = t ? state.products.filter((p) => `${p.name} ${p.category}`.toLocaleLowerCase("en").includes(t)) : state.products;
    if (!state.products.length) return html`<p class="store-empty">No products on the menu yet. Please check back soon.</p>`;
    if (!shown.length) return html`<p class="store-empty">Nothing matches "${state.term}".</p>`;
    const groups = [];
    for (const p of shown) {
      const g = groups.at(-1);
      if (g && g.category === p.category) g.items.push(p);
      else groups.push({ category: p.category, items: [p] });
    }
    return html`${groups.map((g) => html`${g.category && groups.length > 1 ? html`<h2 class="store-cat">${g.category}</h2>` : ""}<ul class="store-list">${g.items.map(row)}</ul>`)}`;
  }

  function bar() {
    const t = totals();
    return t.lines.length
      ? html`<div class="store-bar" data-role="bar"><span class="store-bar-sum"><b data-role="bar-total">${money(t.total)}</b><span data-role="bar-items">${formatQuantity(t.items)} ${t.items === QTY_SCALE ? "item" : "items"}</span></span><button type="button" class="btn btn-primary" data-act="review">Review order</button></div>`
      : "";
  }

  function summary() {
    const t = totals();
    return html`<ul class="store-lines" data-role="lines">${t.lines.map((l) => html`<li class="co-line"><span class="co-line-main"><span class="co-name">${l.p.name}</span><span class="co-sub">${formatQuantity(l.q)} × ${money(l.p.price)}</span></span><b class="co-amt">${money(l.sub)}</b></li>`)}</ul>
      <dl class="co-totals"><div><dt>Total items</dt><dd>${formatQuantity(t.items)}</dd></div><div class="co-grand"><dt>Total</dt><dd data-role="total">${money(t.total)}</dd></div></dl>`;
  }

  function checkout() {
    const f = state.form;
    const w = ways();
    const methods = state.store.paymentMethods || [];
    const fulfillment = f.fulfillment || (w.length === 1 ? w[0] : "");
    const t = totals();
    return html`<section class="store-checkout" data-role="checkout">
      <button type="button" class="btn btn-ghost btn-compact" data-act="back">← Back to menu</button>
      <h2 class="section-title">Your order</h2>
      ${summary()}
      <form class="store-form" data-role="form" novalidate>
        <div class="field"><label for="st-name">Your name *</label><input class="input" id="st-name" name="name" maxlength="120" autocomplete="name" value="${f.name}" required /></div>
        <div class="field"><label for="st-phone">Mobile number *</label><input class="input" id="st-phone" name="phone" type="tel" inputmode="tel" maxlength="40" autocomplete="tel" placeholder="0917 123 4567" value="${f.phone}" required /></div>
        ${w.length > 1
          ? html`<fieldset class="field store-choice"><legend>Pickup or delivery? *</legend>${w.map((k) => html`<label class="store-pill"><input type="radio" name="fulfillment" value="${k}" ${fulfillment === k ? "checked" : ""} /> ${STORE_FULFILLMENT[k].label}</label>`)}</fieldset>`
          : html`<p class="store-only" data-role="only">${STORE_FULFILLMENT[w[0]].label} only</p>`}
        ${fulfillment === "delivery" ? html`<div class="field"><label for="st-address">Delivery address *</label><textarea class="input" id="st-address" name="address" rows="2" maxlength="300" autocomplete="street-address">${f.address}</textarea></div>` : ""}
        ${methods.length
          ? html`<fieldset class="field store-choice"><legend>How will you pay? *</legend>${methods.map((m) => html`<label class="store-pill"><input type="radio" name="paymentMethod" value="${m}" ${f.paymentMethod === m ? "checked" : ""} /> ${PAYMENT_METHODS[m]?.label ?? m}</label>`)}</fieldset>`
          : ""}
        <div class="field"><label for="st-notes">Notes (optional)</label><input class="input" id="st-notes" name="notes" maxlength="300" autocomplete="off" value="${f.notes}" placeholder="e.g. landmark, preferred time" /></div>
        <div class="store-trap" aria-hidden="true"><label for="st-website">Website</label><input id="st-website" name="website" tabindex="-1" autocomplete="off" value="" /></div>
        <p class="form-error" data-role="error" role="alert" ${state.error ? "" : "hidden"}>${state.error}</p>
        <button type="submit" class="btn btn-primary store-place" data-act="place" ${state.busy || !t.lines.length ? "disabled" : ""}>${state.busy ? "Placing order…" : `Place order · ${money(t.total)}`}</button>
        <p class="stat-hint">The store will contact you to confirm and arrange payment.</p>
      </form>
    </section>`;
  }

  function done() {
    const r = state.result;
    return html`<section class="store-done" data-role="done">
      <h2 class="card-title">Thank you! Your order was sent.</h2>
      <p class="store-number" data-role="order-number">${r.orderNumber}</p>
      <ul class="store-lines">${r.items.map((l) => html`<li class="co-line"><span class="co-line-main"><span class="co-name">${l.name}</span><span class="co-sub">${formatQuantity(l.quantity)} ${l.unitLabel}</span></span><b class="co-amt">${money(l.lineSubtotal)}</b></li>`)}</ul>
      <dl class="co-totals"><div class="co-grand"><dt>Total</dt><dd>${money(r.total)}</dd></div></dl>
      <p>${r.sourceNote ? html`<b>${r.sourceNote}</b>. ` : ""}${state.store.name} will contact you at ${state.form.phone} to confirm.</p>
      <button type="button" class="btn" data-act="again">Place another order</button>
    </section>`;
  }

  function draw() {
    const s = state.store;
    document.title = s ? `${s.name} · Order online` : "Order online · Luna";
    let body;
    if (state.status === "loading") body = html`<p class="store-empty">Loading the menu…</p>`;
    else if (state.status === "error") body = html`<div class="card store-card"><h1 class="card-title">Store not available</h1><p data-role="message">${state.message}</p></div>`;
    else if (!s.open) body = html`<div class="card store-card" data-role="closed"><h1 class="card-title">${s.name}</h1><p>This store isn't taking orders online right now. Please check back later or message the store directly.</p></div>`;
    else
      body = html`<header class="store-head"><h1 class="store-title">${s.name}</h1>${s.note ? html`<p class="store-note">${s.note}</p>` : ""}</header>
        ${state.step === "done"
          ? done()
          : state.step === "checkout"
            ? checkout()
            : html`${state.products.length > 8 ? html`<input class="input co-search" type="search" data-role="search" placeholder="Search the menu" aria-label="Search the menu" autocomplete="off" value="${state.term}" />` : ""}
              <div data-role="menu">${menuList()}</div>
              <div data-role="bar-slot">${bar()}</div>`}`;
    render(root, html`<main class="store-page" data-role="store-page">${body}<footer class="store-foot">${lunaMark()} Orders by Luna</footer></main>`);
  }

  // Taps redraw just the row and the bar (focus stays on the button).
  function paintRow(p) {
    const li = root.querySelector(`[data-product="${p.id}"]`);
    if (li) {
      const tmp = document.createElement("ul");
      render(tmp, row(p));
      li.replaceWith(tmp.firstElementChild);
    }
    const slot = root.querySelector('[data-role="bar-slot"]');
    if (slot) render(slot, bar());
  }

  function readForm() {
    const form = root.querySelector('[data-role="form"]');
    if (!form) return;
    const fd = new FormData(form);
    for (const k of ["name", "phone", "address", "notes", "website"]) if (fd.has(k)) state.form[k] = String(fd.get(k));
    if (fd.has("fulfillment")) state.form.fulfillment = String(fd.get("fulfillment"));
    if (fd.has("paymentMethod")) state.form.paymentMethod = String(fd.get("paymentMethod"));
  }

  async function load() {
    try {
      const r = await call({ action: "view", slug }, fetchImpl);
      state.store = r.store;
      state.products = r.products;
      // Keep what's still orderable after a reload of the menu.
      for (const [id, q] of state.qty) {
        const p = byId(id);
        if (!p || p.soldOut) state.qty.delete(id);
        else if (q > p.max) state.qty.set(id, p.max);
      }
      state.status = "ok";
    } catch (err) {
      state.status = "error";
      state.message = err.status === 404 ? "This store link isn't valid. Ask the store for its current link." : err.message;
    }
  }

  async function place() {
    if (state.busy) return;
    readForm();
    const f = state.form;
    const w = ways();
    const fulfillment = f.fulfillment || (w.length === 1 ? w[0] : "");
    const missing = !f.name.trim() ? "Enter your name." : !f.phone.trim() ? "Enter your mobile number." : !fulfillment ? "Choose pickup or delivery." : fulfillment === "delivery" && !f.address.trim() ? "Enter the delivery address." : state.store.paymentMethods?.length && !f.paymentMethod ? "Choose how you'll pay." : "";
    if (missing) {
      state.error = missing;
      return draw();
    }
    state.busy = true;
    state.error = "";
    draw();
    try {
      const order = { name: f.name, phone: f.phone, fulfillment, items: lines().map((l) => ({ productId: l.p.id, quantity: l.q })) };
      if (fulfillment === "delivery") order.address = f.address;
      if (state.store.paymentMethods?.length) order.paymentMethod = f.paymentMethod;
      if (f.notes.trim()) order.notes = f.notes;
      const r = await call({ action: "order", slug, idempotencyKey: state.key, order, website: f.website }, fetchImpl);
      state.result = r.order;
      state.step = "done";
      state.qty.clear();
      state.key = newKey();
    } catch (err) {
      state.error = err.message;
      // Stock changed: show what's left now (the cart keeps what still fits).
      if (err.code === "sold-out") {
        state.key = newKey();
        await load();
      }
    }
    state.busy = false;
    draw();
    root.querySelector('[data-role="done"], [data-role="error"]:not([hidden])')?.scrollIntoView?.({ block: "center" });
  }

  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const p = el.dataset.id ? byId(el.dataset.id) : null;
    if ((act === "inc" || act === "dec") && p) {
      const q = state.qty.get(p.id) || 0;
      const next = act === "inc" ? Math.min(p.max, q + QTY_SCALE) : Math.max(0, q - QTY_SCALE);
      if (next > 0) state.qty.set(p.id, next);
      else state.qty.delete(p.id);
      paintRow(p);
      root.querySelector(`[data-product="${p.id}"] [data-act="${act}"]`)?.focus();
      return;
    }
    if (act === "review") {
      state.step = "checkout";
      draw();
      window.scrollTo?.(0, 0);
    } else if (act === "back") {
      readForm();
      state.step = "menu";
      state.error = "";
      draw();
    } else if (act === "again") {
      state.step = "menu";
      state.result = null;
      state.form = { ...state.form, notes: "", website: "" };
      load().then(draw);
    }
  });
  root.addEventListener("input", (e) => {
    if (e.target.dataset?.role === "search") {
      state.term = e.target.value;
      const menu = root.querySelector('[data-role="menu"]');
      if (menu) render(menu, menuList());
    }
  });
  root.addEventListener("change", (e) => {
    // Pickup <-> delivery shows / hides the address.
    if (e.target.name === "fulfillment") {
      readForm();
      draw();
    }
  });
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    place();
  });

  draw();
  if (!slug) {
    state.status = "error";
    state.message = "This store link isn't valid. Ask the store for its current link.";
    draw();
    return Promise.resolve();
  }
  return load().then(draw);
}
