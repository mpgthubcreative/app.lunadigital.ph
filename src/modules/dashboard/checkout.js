// Business Dashboard checkout (Owner pilot): the fastest way to ring up an
// order. One line per active product:
//   Rice 25kg                        [-]  2  [+]
//   RICE-25 · ₱1,250 · 12 sack left
// then an order summary computed as you tap (line subtotals, total items,
// total) and one "Create order". Customer details are optional (a blank
// name is a walk-in). Creating posts the SAME orders "create" action as the
// Orders screen (one idempotency key per order, so a double tap can't make
// two); the order then lives in Orders, open (not fulfilled): reservations,
// totals, payments and fulfillment all stay with the existing engines.
// Prices and totals here are a PREVIEW; the server re-reads every product.

import { html, render } from "../../lib/html.js";
import { formatCentavos } from "../../lib/format.js";
import { ORDER_SOURCES, ORDER_SOURCE_IDS, computeTotals, parseQuantity, formatQuantity, UNITS, QTY_SCALE } from "@shared/index.js";
import { listProducts } from "../inventory/data.js";

const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
const unitOf = (p) => UNITS[p.unit]?.label ?? p.unit ?? "";
const WALK_IN = "Walk-in";

export async function listActiveProducts(businessId) {
  const rows = [];
  for (let cursor = null, more = true; more; ) {
    const page = await listProducts(businessId, { status: "active", cursor, pageSize: 200 });
    rows.push(...page.rows);
    more = page.hasMore && page.rows.length > 0;
    cursor = page.rows[page.rows.length - 1];
  }
  return rows;
}

// host: a persistent element (the dashboard re-renders around it).
// deps: { api, toast, listActiveProducts?(businessId), onCreated?(result) }
export function mountCheckout(host, session, deps) {
  const currency = session.business.currency || "PHP";
  const load = deps.listActiveProducts || listActiveProducts;
  const state = { products: null, error: false, term: "", qty: new Map(), text: new Map(), customer: { name: "", source: "walk_in", note: "" }, key: newKey(), busy: false };
  let alive = true;

  const money = (c) => formatCentavos(c, currency).replace(/\.00$/, "");
  const byId = (id) => (state.products || []).find((p) => p.id === id);
  // Typed or tapped quantity -> { quantity (scaled) | null, error }.
  const lineOf = (p) => {
    const t = state.text.get(p.id);
    if (t === undefined) return { quantity: state.qty.get(p.id) || 0 };
    if (!t.trim()) return { quantity: 0 };
    try {
      return { quantity: parseQuantity(t, p.unit) };
    } catch (err) {
      return { quantity: null, error: err.message };
    }
  };
  const chosen = () =>
    (state.products || [])
      .map((p) => ({ p, ...lineOf(p) }))
      .filter((l) => l.quantity !== 0);
  const left = (p) => (p.available ?? 0) - (lineOf(p).quantity || 0);

  function shell() {
    const opt = (id) => html`<option value="${id}" ${state.customer.source === id ? "selected" : ""}>${ORDER_SOURCES[id].label}</option>`;
    render(
      host,
      html`<section class="card co" data-section="checkout">
        <div class="co-main">
          <input class="input co-search" type="search" data-role="co-search" placeholder="Search products" aria-label="Search products" autocomplete="off" value="${state.term}" />
          <ul class="co-list" data-role="co-products"></ul>
        </div>
        <aside class="co-side">
          <h2 class="section-title">Order summary</h2>
          <div data-role="co-summary"></div>
          <details class="co-customer" data-role="co-customer">
            <summary>Customer <span class="co-optional">optional</span></summary>
            <div class="field"><label for="coName">Name</label><input class="input" id="coName" data-c="name" maxlength="120" placeholder="${WALK_IN}" autocomplete="off" value="${state.customer.name}" /></div>
            <div class="field"><label for="coSource">Source</label><select class="input" id="coSource" data-c="source">${ORDER_SOURCE_IDS.filter((id) => id !== "other").map(opt)}</select></div>
            <div class="field"><label for="coNote">Note</label><input class="input" id="coNote" data-c="note" maxlength="500" autocomplete="off" value="${state.customer.note}" /></div>
          </details>
          <p class="form-error" data-role="co-error" role="alert" hidden></p>
          <button type="button" class="btn btn-primary co-create" data-act="co-create" disabled>Create order</button>
        </aside>
      </section>`
    );
    paintProducts();
    paintSummary();
  }

  function productRow(p) {
    const l = lineOf(p);
    const q = l.quantity || 0;
    const step = QTY_SCALE;
    const out = (p.available ?? 0) <= 0;
    const shown = state.text.get(p.id) ?? (q ? formatQuantity(q) : "0");
    return html`<li class="co-row${q ? " is-picked" : ""}${out ? " is-out" : ""}" data-product="${p.id}">
      <span class="co-info"><span class="co-name">${p.name}</span><span class="co-sub">${p.sku} · ${money(p.sellingPrice)} · <span data-role="left">${out ? "Out of stock" : `${formatQuantity(Math.max(0, left(p)))} ${unitOf(p)} left`}</span></span>${l.error ? html`<span class="form-error">${l.error}</span>` : ""}</span>
      <span class="co-qty">
        <button type="button" class="co-step" data-act="co-dec" data-id="${p.id}" aria-label="One less ${p.name}" ${q > 0 ? "" : "disabled"}>−</button>
        <input class="co-num" data-role="co-num" data-id="${p.id}" inputmode="decimal" value="${shown}" aria-label="Quantity of ${p.name}" autocomplete="off" />
        <button type="button" class="co-step" data-act="co-inc" data-id="${p.id}" aria-label="One more ${p.name}" ${(l.quantity ?? 0) + step <= (p.available ?? 0) ? "" : "disabled"}>+</button>
      </span>
    </li>`;
  }

  function paintProducts() {
    const list = host.querySelector('[data-role="co-products"]');
    if (!list) return;
    if (state.error) return render(list, html`<li class="co-empty">Couldn't load the products. Try again in a moment.</li>`);
    if (state.products === null) return render(list, html`<li class="co-empty">Loading products…</li>`);
    if (!state.products.length) return render(list, html`<li class="co-empty">No products yet. <a href="/inventory" data-link>Add them in Inventory</a>.</li>`);
    const t = state.term.trim().toLocaleLowerCase("en");
    const rows = t ? state.products.filter((p) => `${p.name} ${p.sku}`.toLocaleLowerCase("en").includes(t)) : state.products;
    render(list, rows.length ? html`${rows.map(productRow)}` : html`<li class="co-empty">No product matches "${state.term}".</li>`);
  }

  // One row in place (keeps focus on the stepper / the typed box).
  function paintRow(p, { keepInput = false } = {}) {
    const li = host.querySelector(`[data-product="${p.id}"]`);
    if (!li) return;
    if (keepInput) {
      const l = lineOf(p);
      const q = l.quantity || 0;
      li.classList.toggle("is-picked", q > 0);
      li.querySelector('[data-role="left"]').textContent = (p.available ?? 0) <= 0 ? "Out of stock" : `${formatQuantity(Math.max(0, left(p)))} ${unitOf(p)} left`;
      li.querySelector('[data-act="co-dec"]').disabled = !(q > 0);
      li.querySelector('[data-act="co-inc"]').disabled = !((l.quantity ?? 0) + QTY_SCALE <= (p.available ?? 0));
      return;
    }
    const tmp = document.createElement("ul");
    render(tmp, productRow(p));
    li.replaceWith(tmp.firstElementChild);
  }

  function paintSummary() {
    const el = host.querySelector('[data-role="co-summary"]');
    if (!el) return;
    const lines = chosen();
    const bad = lines.find((l) => l.quantity === null || l.quantity < 0);
    const valid = lines.filter((l) => l.quantity > 0).map((l) => ({ ...l, unitPrice: l.p.sellingPrice }));
    const totals = computeTotals(valid.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })));
    const items = valid.reduce((n, l) => n + l.quantity, 0);
    render(
      el,
      valid.length
        ? html`<ul class="co-lines" data-role="co-lines">${valid.map(
            (l, i) => html`<li class="co-line" data-line="${l.p.id}"><span class="co-line-main"><span class="co-name">${l.p.name}</span><span class="co-sub">${formatQuantity(l.quantity)} ${unitOf(l.p)} × ${money(l.unitPrice)}</span></span><b class="co-amt">${money(totals.lines[i].lineSubtotal)}</b></li>`
          )}</ul>
          <dl class="co-totals"><div><dt>Total items</dt><dd data-role="co-items">${formatQuantity(items)}</dd></div><div class="co-grand"><dt>Total</dt><dd data-role="co-total">${money(totals.total)}</dd></div></dl>`
        : html`<p class="co-none" data-role="co-none">Tap + on a product to start an order.</p>`
    );
    const btn = host.querySelector('[data-act="co-create"]');
    btn.disabled = state.busy || !valid.length || Boolean(bad);
    btn.textContent = state.busy ? "Creating…" : valid.length ? `Create order · ${money(totals.total)}` : "Create order";
  }

  function setQty(p, q) {
    state.text.delete(p.id);
    if (q > 0) state.qty.set(p.id, q);
    else state.qty.delete(p.id);
  }

  async function create() {
    if (state.busy) return;
    const errEl = host.querySelector('[data-role="co-error"]');
    errEl.hidden = true;
    const lines = chosen().filter((l) => l.quantity > 0);
    if (!lines.length) return;
    state.busy = true;
    paintSummary();
    const name = state.customer.name.trim();
    try {
      const result = await deps.api("orders", {
        method: "POST",
        body: {
          action: "create",
          idempotencyKey: state.key,
          order: {
            customer: { name: name || WALK_IN, phone: "", notes: "" },
            source: state.customer.source,
            sourceNote: "",
            deliveryAddress: "",
            items: lines.map((l) => ({ productId: l.p.id, quantity: l.quantity })),
            notes: state.customer.note.trim(),
          },
        },
      });
      if (!alive) return;
      deps.toast(`Order ${result.orderNumber} created`, "success");
      // A fresh cart (and key) for the next order; stock re-read.
      state.qty.clear();
      state.text.clear();
      state.customer = { name: "", source: "walk_in", note: "" };
      state.key = newKey();
      state.busy = false;
      shell();
      refresh();
      deps.onCreated?.(result);
    } catch (err) {
      state.busy = false;
      if (!alive) return;
      errEl.textContent = err.message || "Couldn't create the order.";
      errEl.hidden = false;
      paintSummary();
    }
  }

  const onClick = (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !host.contains(el)) return;
    const p = byId(el.dataset.id);
    if (el.dataset.act === "co-inc" && p) {
      const q = lineOf(p).quantity || 0;
      setQty(p, Math.min(p.available ?? 0, q + QTY_SCALE));
    } else if (el.dataset.act === "co-dec" && p) {
      const q = lineOf(p).quantity || 0;
      setQty(p, Math.max(0, q - QTY_SCALE));
    } else if (el.dataset.act === "co-create") return void create();
    else return;
    paintRow(p);
    host.querySelector(`[data-product="${p.id}"] [data-act="${el.dataset.act}"]`)?.focus();
    paintSummary();
  };
  const onInput = (e) => {
    const t = e.target;
    if (t.dataset.role === "co-search") {
      state.term = t.value;
      return paintProducts();
    }
    if (t.dataset.role === "co-num") {
      const p = byId(t.dataset.id);
      if (!p) return;
      state.text.set(p.id, t.value);
      paintRow(p, { keepInput: true });
      return paintSummary();
    }
    if (t.dataset.c) state.customer[t.dataset.c] = t.value;
  };
  const onChange = (e) => {
    const t = e.target;
    if (t.dataset.c) state.customer[t.dataset.c] = t.value;
    // Leaving a typed box settles it (blank -> 0; an error stays shown).
    if (t.dataset.role === "co-num") {
      const p = byId(t.dataset.id);
      const l = p && lineOf(p);
      if (l && l.quantity !== null) {
        setQty(p, l.quantity);
        paintRow(p);
        paintSummary();
      }
    }
  };
  const onFocus = (e) => {
    if (e.target.dataset?.role === "co-num") e.target.select?.();
  };
  host.addEventListener("click", onClick);
  host.addEventListener("input", onInput);
  host.addEventListener("change", onChange);
  host.addEventListener("focusin", onFocus);

  function refresh() {
    load(session.business.id)
      .then((rows) => {
        state.products = rows.filter((p) => p.status === "active").sort((a, b) => a.name.localeCompare(b.name));
        state.error = false;
      })
      .catch((err) => {
        console.error("checkout: products failed:", err && (err.code || err.message));
        state.error = true;
      })
      .then(() => {
        if (!alive) return;
        paintProducts();
        paintSummary();
      });
  }
  shell();
  refresh();
  return () => {
    alive = false;
    host.removeEventListener("click", onClick);
    host.removeEventListener("input", onInput);
    host.removeEventListener("change", onChange);
    host.removeEventListener("focusin", onFocus);
  };
}

