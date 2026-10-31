// A reseller's private menu (Reseller Package, 2026-10-31): /reseller#{token}.
// No login: the link IS the reseller (Luna knows it's Riza; she never picks
// her name). The token stays in the address's # part (never sent to the
// server as a page address) so a bookmark keeps working.
//   My commission   earned · paid · remaining · Unpaid / Partially Paid /
//                   Paid (read-only: only the Owner records payouts)
//   Sell            each product: Owner price, Your selling price (remembered),
//                   Your commission; quantities; below the owner price shows
//                   "Selling price is below the owner price." and can't be
//                   ordered
//   Review order    the customer total, the owner's amount and her
//                   commission; the customer's name (mobile optional),
//                   pickup or delivery, payment method
//   Done            the order number, a customer-ready summary (her selling
//                   prices only: never the owner price or commission) to
//                   copy, and the customer's payment link
//   My orders       her own orders only: status, payment, commission
// The server (/api/reseller-menu) prices every line again from her link.

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";
import { formatCentavos, formatDayId } from "../lib/format.js";
import { formatQuantity, lineAmount, QTY_SCALE, STORE_FULFILLMENT, COMMISSION_STATUSES, BELOW_OWNER_PRICE, FULFILLMENT_STATUSES, PAYMENT_STATUSES } from "@shared/index.js";

const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
// "650", "650.50", "1,250" → centavos; anything else → null.
export function priceFrom(text) {
  const t = String(text ?? "").trim().replace(/,/g, "").replace(/^₱\s*/, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  return m ? Number(m[1]) * 100 + Number(((m[2] || "") + "00").slice(0, 2)) : null;
}
const pesos = (c) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

async function call(body, fetchImpl) {
  const res = await fetchImpl("/api/reseller-menu", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || "Something went wrong. Please try again."), { status: res.status, code: data.error });
  return data;
}

// What she can send her customer: her selling prices and the total only.
export function customerSummary({ business, orderNumber, customer, items, total, payUrl, currency = "PHP" }) {
  const m = (c) => formatCentavos(c, currency);
  return [`${business} · Order ${orderNumber}${customer ? ` for ${customer}` : ""}`, ...items.map((l) => `${formatQuantity(l.quantity)} × ${l.name} — ${m(l.sellingPrice)}${l.quantity !== QTY_SCALE ? ` = ${m(l.lineSubtotal)}` : ""}`), `Total: ${m(total)}`, ...(payUrl ? [`Pay here: ${payUrl}`] : [])].join("\n");
}

export function renderResellerPage(root, { token = window.location.hash.slice(1), fetchImpl = (...a) => window.fetch(...a), copy = (t) => navigator.clipboard?.writeText(t), origin = window.location.origin } = {}) {
  const state = { status: "loading", message: "", view: null, prices: new Map(), typed: new Map(), qty: new Map(), step: "menu", form: { customerName: "", customerPhone: "", fulfillment: "", address: "", paymentMethod: "", notes: "" }, key: newKey(), busy: false, error: "", result: null, term: "" };
  const currency = () => state.view?.business.currency || "PHP";
  const money = (c) => formatCentavos(c ?? 0, currency());
  const products = () => state.view?.products || [];
  const byId = (id) => products().find((p) => p.id === id);
  const sellingOf = (p) => (state.prices.has(p.id) ? state.prices.get(p.id) : p.sellingPrice);
  // The typed price: valid amount or not, below the owner price or not.
  const priceState = (p) => {
    const typed = state.typed.has(p.id) ? state.typed.get(p.id) : pesos(sellingOf(p));
    const value = priceFrom(typed);
    return { typed, value, invalid: value === null, below: value !== null && value < p.ownerPrice };
  };
  const lines = () =>
    products()
      .filter((p) => (state.qty.get(p.id) || 0) > 0)
      .map((p) => {
        const q = state.qty.get(p.id);
        const s = priceState(p);
        const price = s.value ?? 0;
        return { p, q, price, bad: s.invalid || s.below, sub: lineAmount(q, price), owner: lineAmount(q, p.ownerPrice) };
      });
  const totals = () => {
    const l = lines();
    const total = l.reduce((n, x) => n + x.sub, 0);
    const owner = l.reduce((n, x) => n + x.owner, 0);
    return { lines: l, items: l.reduce((n, x) => n + x.q, 0), total, owner, commission: total - owner, bad: l.some((x) => x.bad) };
  };

  function commissionCard() {
    const c = state.view.commission;
    return html`<section class="card rs-card" data-role="my-commission">
      <h2 class="rs-h">My commission</h2>
      <dl class="rs-figs">
        <div><dt>Earned</dt><dd data-k="earned">${money(c.earned)}</dd></div>
        <div><dt>Paid</dt><dd data-k="paid">${money(c.paid)}</dd></div>
        <div><dt>Remaining</dt><dd data-k="remaining">${money(c.remaining)}</dd></div>
      </dl>
      <p class="stat-hint" data-role="payout-status">${c.status === "none" ? "No commission yet." : COMMISSION_STATUSES[c.status]?.label}</p>
    </section>`;
  }

  function row(p) {
    const q = state.qty.get(p.id) || 0;
    const s = priceState(p);
    const commission = s.value !== null && !s.below ? s.value - p.ownerPrice : null;
    return html`<li class="store-row rs-row${q ? " is-picked" : ""}" data-product="${p.id}">
      <span class="store-info">
        <span class="store-name">${p.name}</span>
        <span class="rs-prices">
          <span class="rs-owner" data-role="owner-price">Owner price ${money(p.ownerPrice)}</span>
          <label class="rs-sell">Your selling price <input class="input rs-price${s.invalid || s.below ? " is-invalid" : ""}" data-role="price" data-id="${p.id}" inputmode="decimal" autocomplete="off" value="${s.typed}" aria-label="Your selling price for ${p.name}" /></label>
          ${s.below ? html`<span class="form-error rs-warn" data-role="below" role="alert">${BELOW_OWNER_PRICE}</span>` : s.invalid ? html`<span class="form-error rs-warn" data-role="invalid">Enter a price like 650 or 650.50</span>` : html`<span class="rs-commission" data-role="commission">Your commission ${money(commission)}</span>`}
        </span>
      </span>
      <span class="co-qty">
        <button type="button" class="co-step" data-act="dec" data-id="${p.id}" aria-label="One less ${p.name}" ${q > 0 ? "" : "disabled"}>−</button>
        <span class="co-num store-num" data-role="qty" aria-live="polite">${formatQuantity(q)}</span>
        <button type="button" class="co-step" data-act="inc" data-id="${p.id}" aria-label="One more ${p.name}" ${q + QTY_SCALE <= p.max ? "" : "disabled"}>+</button>
      </span>
    </li>`;
  }

  function menuList() {
    const t = state.term.trim().toLocaleLowerCase("en");
    const shown = t ? products().filter((p) => `${p.name} ${p.category}`.toLocaleLowerCase("en").includes(t)) : products();
    if (!products().length) return html`<p class="store-empty">No products to sell right now.</p>`;
    if (!shown.length) return html`<p class="store-empty">Nothing matches "${state.term}".</p>`;
    return html`<ul class="store-list" data-role="products">${shown.map(row)}</ul>`;
  }

  function bar() {
    const t = totals();
    if (!t.lines.length) return "";
    return html`<div class="store-bar" data-role="bar"><span class="store-bar-sum"><b data-role="bar-total">${money(t.total)}</b><span data-role="bar-commission">${t.bad ? "Check the prices" : `Your commission ${money(t.commission)}`}</span></span><button type="button" class="btn btn-primary" data-act="review" ${t.bad ? "disabled" : ""}>Review order</button></div>`;
  }

  function summary() {
    const t = totals();
    return html`<ul class="store-lines" data-role="lines">${t.lines.map((l) => html`<li class="co-line"><span class="co-line-main"><span class="co-name">${l.p.name}</span><span class="co-sub">${formatQuantity(l.q)} × ${money(l.price)}</span></span><b class="co-amt">${money(l.sub)}</b></li>`)}</ul>
      <dl class="co-totals" data-role="review-totals">
        <div class="co-grand"><dt>Customer pays</dt><dd data-role="total">${money(t.total)}</dd></div>
        <div><dt>Owner amount</dt><dd data-role="owner-amount">${money(t.owner)}</dd></div>
        <div><dt>Your commission</dt><dd data-role="review-commission">${money(t.commission)}</dd></div>
      </dl>`;
  }

  function checkout() {
    const f = state.form;
    const ways = state.view.fulfillment;
    const methods = state.view.paymentMethods || [];
    const fulfillment = f.fulfillment || (ways.length === 1 ? ways[0] : "");
    const t = totals();
    return html`<section class="store-checkout" data-role="checkout">
      <button type="button" class="btn btn-ghost btn-compact" data-act="back">← Back</button>
      <h2 class="section-title">Review order</h2>
      ${summary()}
      <form class="store-form" data-role="form" novalidate>
        <div class="field"><label for="rs-name">Customer's name *</label><input class="input" id="rs-name" name="customerName" maxlength="120" value="${f.customerName}" required /></div>
        <div class="field"><label for="rs-phone">Customer's mobile (optional)</label><input class="input" id="rs-phone" name="customerPhone" type="tel" inputmode="tel" maxlength="40" placeholder="0917 123 4567" value="${f.customerPhone}" /></div>
        <fieldset class="field store-choice"><legend>Pickup or delivery? *</legend>${ways.map((k) => html`<label class="store-pill"><input type="radio" name="fulfillment" value="${k}" ${fulfillment === k ? "checked" : ""} /> ${STORE_FULFILLMENT[k].label}</label>`)}</fieldset>
        ${fulfillment === "delivery" ? html`<div class="field"><label for="rs-address">Delivery address *</label><textarea class="input" id="rs-address" name="address" rows="2" maxlength="300">${f.address}</textarea></div>` : ""}
        ${methods.length ? html`<fieldset class="field store-choice"><legend>How will the customer pay? (optional)</legend>${methods.map((m) => html`<label class="store-pill"><input type="radio" name="paymentMethod" value="${m.id}" ${f.paymentMethod === m.id ? "checked" : ""} /> ${m.label}</label>`)}</fieldset>` : ""}
        <div class="field"><label for="rs-notes">Notes (optional)</label><input class="input" id="rs-notes" name="notes" maxlength="300" value="${f.notes}" /></div>
        <p class="form-error" data-role="error" role="alert" ${state.error ? "" : "hidden"}>${state.error}</p>
        <button type="submit" class="btn btn-primary store-place" data-act="place" ${state.busy || !t.lines.length || t.bad ? "disabled" : ""}>${state.busy ? "Creating order…" : `Create order · ${money(t.total)}`}</button>
        <p class="stat-hint">The business confirms the order and the payment.</p>
      </form>
    </section>`;
  }

  function done() {
    const r = state.result;
    const payUrl = r.payPath ? `${origin}${r.payPath}` : "";
    return html`<section class="store-done" data-role="done">
      <h2 class="card-title">Order created</h2>
      <p class="store-number" data-role="order-number">${r.orderNumber}</p>
      <dl class="co-totals" data-role="done-totals">
        <div class="co-grand"><dt>Customer pays</dt><dd>${money(r.total)}</dd></div>
        <div><dt>Owner amount</dt><dd>${money(r.ownerAmount)}</dd></div>
        <div><dt>Your commission</dt><dd data-role="done-commission">${money(r.commission)}</dd></div>
      </dl>
      <h3 class="rs-h">For your customer</h3>
      <pre class="rs-customer" data-role="customer-summary">${customerSummary({ business: state.view.business.name, orderNumber: r.orderNumber, customer: state.form.customerName, items: r.items, total: r.total, payUrl, currency: currency() })}</pre>
      <div class="link-actions"><button type="button" class="btn btn-primary" data-act="copy-summary">Copy for customer</button>${payUrl ? html`<a class="btn" href="${payUrl}" target="_blank" rel="noopener" data-role="pay-link">Payment link</a>` : ""}</div>
      <p class="stat-hint">Your customer sees your selling prices only. They pay the business on the payment link; the business confirms it.</p>
      <button type="button" class="btn" data-act="again">Create another order</button>
    </section>`;
  }

  function myOrders() {
    const list = state.view.orders || [];
    return html`<section class="card rs-card" data-role="my-orders">
      <h2 class="rs-h">My orders</h2>
      ${list.length
        ? html`<ul class="store-lines">${list.map(
            (o) => html`<li class="co-line" data-order="${o.orderNumber}"><span class="co-line-main"><span class="co-name">${o.orderNumber} · ${o.customer}</span><span class="co-sub">${formatDayId(o.orderDate).replace(/, \d{4}$/, "")} · ${FULFILLMENT_STATUSES[o.fulfillmentStatus]?.label ?? o.fulfillmentStatus} · ${PAYMENT_STATUSES[o.paymentStatus]?.label ?? o.paymentStatus} · Commission ${money(o.commission)}${o.commission && o.payout !== "none" ? ` (${COMMISSION_STATUSES[o.payout]?.label})` : ""}</span></span><span class="co-amt"><b>${money(o.total)}</b>${o.fulfillmentStatus !== "cancelled" && o.paymentStatus !== "paid" ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="paylink" data-order="${o.orderNumber}">Payment link</button>` : ""}</span></li>`
          )}</ul>`
        : html`<p class="stat-hint">Orders you create appear here.</p>`}
    </section>`;
  }

  function draw() {
    const v = state.view;
    document.title = v ? `${v.business.name} · ${v.reseller.name}` : "Reseller menu · Luna";
    let body;
    if (state.status === "loading") body = html`<p class="store-empty">Loading your menu…</p>`;
    else if (state.status === "error") body = html`<div class="card store-card"><h1 class="card-title">Link not available</h1><p data-role="message">${state.message}</p></div>`;
    else
      body = html`<header class="store-head"><h1 class="store-title">${v.business.name}</h1><p class="store-note" data-role="who">Reseller: <b>${v.reseller.name}</b></p></header>
        ${state.step === "done"
          ? done()
          : state.step === "checkout"
            ? checkout()
            : html`${commissionCard()}
              ${products().length > 8 ? html`<input class="input co-search" type="search" data-role="search" placeholder="Search products" aria-label="Search products" autocomplete="off" value="${state.term}" />` : ""}
              <div data-role="menu">${menuList()}</div>
              <div data-role="bar-slot">${bar()}</div>
              ${myOrders()}`}`;
    render(root, html`<main class="store-page rs-page" data-role="reseller-page">${body}<footer class="store-foot">${lunaMark()} Orders by Luna</footer></main>`);
  }

  // A tap or a typed price redraws only its row and the bar (focus stays).
  function paintRow(p, keepFocus = false) {
    const li = root.querySelector(`[data-product="${p.id}"]`);
    if (li) {
      const input = li.querySelector('[data-role="price"]');
      const caret = keepFocus && input ? input.selectionStart : null;
      const tmp = document.createElement("ul");
      render(tmp, row(p));
      li.replaceWith(tmp.firstElementChild);
      if (keepFocus) {
        const next = root.querySelector(`[data-product="${p.id}"] [data-role="price"]`);
        next?.focus();
        if (caret !== null) next?.setSelectionRange?.(caret, caret);
      }
    }
    const slot = root.querySelector('[data-role="bar-slot"]');
    if (slot) render(slot, bar());
  }

  function readForm() {
    const form = root.querySelector('[data-role="form"]');
    if (!form) return;
    const fd = new FormData(form);
    for (const k of ["customerName", "customerPhone", "address", "notes"]) if (fd.has(k)) state.form[k] = String(fd.get(k));
    if (fd.has("fulfillment")) state.form.fulfillment = String(fd.get("fulfillment"));
    if (fd.has("paymentMethod")) state.form.paymentMethod = String(fd.get("paymentMethod"));
  }

  async function load() {
    try {
      state.view = await call({ action: "view", token }, fetchImpl);
      for (const [id, q] of state.qty) {
        const p = byId(id);
        if (!p) state.qty.delete(id);
        else if (q > p.max) state.qty.set(id, p.max);
      }
      state.status = "ok";
    } catch (err) {
      state.status = "error";
      state.message = err.status === 404 ? "This reseller link isn't valid. Ask the business for your current link." : err.message;
    }
  }

  // Remember a valid price as her default for next time (best effort).
  async function savePrice(p) {
    const s = priceState(p);
    if (s.invalid || s.below || s.value === p.sellingPrice) return;
    state.prices.set(p.id, s.value);
    try {
      await call({ action: "setPrice", token, productId: p.id, price: s.value }, fetchImpl);
    } catch {
      /* kept on this page; the order sends the price anyway */
    }
  }

  async function place() {
    if (state.busy) return;
    readForm();
    const f = state.form;
    const ways = state.view.fulfillment;
    const fulfillment = f.fulfillment || (ways.length === 1 ? ways[0] : "");
    const missing = !f.customerName.trim() ? "Enter the customer's name." : !fulfillment ? "Choose pickup or delivery." : fulfillment === "delivery" && !f.address.trim() ? "Enter the delivery address." : "";
    if (missing) {
      state.error = missing;
      return draw();
    }
    const t = totals();
    if (t.bad) {
      state.error = BELOW_OWNER_PRICE;
      return draw();
    }
    state.busy = true;
    state.error = "";
    draw();
    try {
      const order = { customerName: f.customerName, fulfillment, items: t.lines.map((l) => ({ productId: l.p.id, quantity: l.q, sellingPrice: l.price })) };
      if (f.customerPhone.trim()) order.customerPhone = f.customerPhone;
      if (fulfillment === "delivery") order.address = f.address;
      if (f.paymentMethod) order.paymentMethod = f.paymentMethod;
      if (f.notes.trim()) order.notes = f.notes;
      state.result = await call({ action: "order", token, idempotencyKey: state.key, order }, fetchImpl);
      for (const l of t.lines) state.prices.set(l.p.id, l.price);
      state.step = "done";
      state.qty.clear();
      state.key = newKey();
      await load();
    } catch (err) {
      state.error = err.message;
      if (err.code === "sold-out") {
        state.key = newKey();
        await load();
      }
    }
    state.busy = false;
    draw();
    root.querySelector('[data-role="done"], [data-role="error"]:not([hidden])')?.scrollIntoView?.({ block: "center" });
  }

  root.addEventListener("click", async (e) => {
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
      state.form = { customerName: "", customerPhone: "", fulfillment: "", address: "", paymentMethod: "", notes: "" };
      draw();
    } else if (act === "copy-summary") {
      const r = state.result;
      const text = customerSummary({ business: state.view.business.name, orderNumber: r.orderNumber, customer: state.form.customerName, items: r.items, total: r.total, payUrl: r.payPath ? `${origin}${r.payPath}` : "", currency: currency() });
      try {
        await copy(text);
        el.textContent = "Copied";
      } catch {
        /* the text is on screen */
      }
    } else if (act === "paylink") {
      try {
        const { payPath } = await call({ action: "payLink", token, orderNumber: el.dataset.order }, fetchImpl);
        const url = `${origin}${payPath}`;
        try {
          await copy(url);
          el.textContent = "Link copied";
        } catch {
          window.open?.(url, "_blank", "noopener");
        }
      } catch (err) {
        el.textContent = err.message;
      }
    }
  });
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset?.role === "search") {
      state.term = t.value;
      const menu = root.querySelector('[data-role="menu"]');
      if (menu) render(menu, menuList());
    } else if (t.dataset?.role === "price") {
      const p = byId(t.dataset.id);
      if (!p) return;
      state.typed.set(p.id, t.value);
      paintRow(p, true);
    }
  });
  root.addEventListener("change", (e) => {
    if (e.target.dataset?.role === "price") {
      const p = byId(e.target.dataset.id);
      if (p) savePrice(p);
    }
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
  if (!token) {
    state.status = "error";
    state.message = "This reseller link isn't valid. Ask the business for your current link.";
    draw();
    return Promise.resolve();
  }
  return load().then(draw);
}
