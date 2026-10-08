// New / edit order dialog, built for speed when an order arrives by chat or
// phone: customer -> source -> add products -> quantities -> (discount) ->
// notes -> create. Totals shown here are a PREVIEW from shared/orders.js;
// the server re-reads every product and computes the real totals.
// One idempotency key per dialog: double-clicks and retries can't create a
// second order.

import { html, render } from "../../lib/html.js";
import { formatCentavos } from "../../lib/format.js";
import { ORDER_SOURCES, ORDER_SOURCE_IDS, computeTotals, parseQuantity, parseCentavos, formatQuantity, UNITS } from "@shared/index.js";

const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

// deps: { searchProducts(term) -> rows, getProducts(ids) -> map, api }
export function openOrderEditor({ session, deps, order = null }) {
  const perms = session.member.permissions;
  const canDiscount = perms["orders.discount"] === true;
  const currency = session.business.currency || "PHP";
  const idempotencyKey = newKey();
  const state = {
    customer: { name: order?.customer?.name ?? "", phone: order?.customer?.phone ?? "", notes: order?.customer?.notes ?? "" },
    source: order?.source ?? "messenger",
    sourceNote: order?.sourceNote ?? "",
    notes: order?.notes ?? "",
    discountText: order ? (order.discount / 100).toFixed(2) : "0",
    lines: (order?.items || []).map((l) => ({ productId: l.productId, sku: l.sku, name: l.name, unit: l.unit, unitPrice: l.unitPrice, quantityText: formatQuantity(l.quantity), reservedHere: l.quantity, available: null })),
    results: [],
    error: "",
    busy: false,
  };

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const close = (value) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
    };

    // Availability of products already on an edited order.
    if (order) {
      deps.getProducts(state.lines.map((l) => l.productId)).then((products) => {
        for (const l of state.lines) l.available = products[l.productId]?.available ?? null;
        paintLines();
      });
    }

    function parsedLines() {
      return state.lines.map((l) => {
        try {
          return { ...l, quantity: parseQuantity(l.quantityText, l.unit) };
        } catch (err) {
          return { ...l, quantity: null, qtyError: err.message };
        }
      });
    }

    function preview() {
      const lines = parsedLines();
      let discount = 0;
      try {
        discount = canDiscount ? parseCentavos(state.discountText || "0") : order?.discount ?? 0;
      } catch {
        discount = 0;
      }
      const valid = lines.filter((l) => l.quantity);
      try {
        return { ...computeTotals(valid, discount), lines };
      } catch {
        return { ...computeTotals(valid, 0), lines, discountError: "Discount is more than the subtotal" };
      }
    }

    const sourceOptions = ORDER_SOURCE_IDS.map((id) => html`<option value="${id}" ${id === state.source ? "selected" : ""}>${ORDER_SOURCES[id].label}</option>`);

    render(
      backdrop,
      html`<form class="modal modal-wide form" role="dialog" aria-modal="true" aria-labelledby="oe-title" novalidate>
        <div class="modal-header"><h2 class="card-title" id="oe-title">${order ? `Edit ${order.orderNumber}` : "New order"}</h2></div>
        <div class="modal-body">
          <div class="stat-grid">
            <div class="field"><label for="oeName">Customer name *</label><input class="input" id="oeName" name="name" value="${state.customer.name}" autocomplete="off" /></div>
            <div class="field"><label for="oePhone">Phone</label><input class="input" id="oePhone" name="phone" value="${state.customer.phone}" inputmode="tel" autocomplete="off" /></div>
            <div class="field"><label for="oeSource">Source</label><select class="select" id="oeSource" name="source">${sourceOptions}</select></div>
            <div class="field"><label for="oeSourceNote">Source note</label><input class="input" id="oeSourceNote" name="sourceNote" value="${state.sourceNote}" autocomplete="off" /></div>
          </div>
          <div class="field"><label for="oeSearch">Add product (name or exact SKU)</label>
            <div class="page-actions"><input class="input" id="oeSearch" name="search" autocomplete="off" /><button type="button" class="btn" data-act="search">Search</button></div>
          </div>
          <div data-role="results"></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="num">Available</th><th class="num">Price</th><th class="num">Quantity</th><th class="num">Subtotal</th><th></th></tr></thead><tbody data-role="lines"></tbody></table></div>
          <div class="stat-grid">
            ${canDiscount ? html`<div class="field"><label for="oeDiscount">Discount (${currency})</label><input class="input" id="oeDiscount" name="discount" value="${state.discountText}" inputmode="decimal" autocomplete="off" /></div>` : ""}
            <div class="field"><label for="oeNotes">Order notes</label><textarea class="input" id="oeNotes" name="notes" rows="2" maxlength="500">${state.notes}</textarea></div>
          </div>
          <dl class="dl" data-role="totals"></dl>
          <p class="form-error" data-role="error" role="alert" hidden></p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" data-act="submit">${order ? "Save changes" : "Create order"}</button>
        </div>
      </form>`
    );
    const form = backdrop.querySelector("form");
    const linesEl = form.querySelector('[data-role="lines"]');
    const totalsEl = form.querySelector('[data-role="totals"]');
    const resultsEl = form.querySelector('[data-role="results"]');
    const errorEl = form.querySelector('[data-role="error"]');
    const submitBtn = form.querySelector('[data-act="submit"]');

    function paintLines() {
      const p = preview();
      render(
        linesEl,
        html`${p.lines.map(
          (l, i) => html`<tr data-line="${l.productId}">
            <td>${l.sku} · ${l.name}</td>
            <td class="num">${l.available === null ? "…" : `${formatQuantity(l.available + (l.reservedHere || 0))} ${UNITS[l.unit]?.label ?? l.unit}`}</td>
            <td class="num">${formatCentavos(l.unitPrice, currency)}</td>
            <td class="num"><input class="input" name="qty-${i}" data-line-index="${i}" value="${state.lines[i].quantityText}" inputmode="decimal" aria-label="Quantity for ${l.name}" autocomplete="off" />${l.qtyError ? html`<div class="form-error">${l.qtyError}</div>` : ""}</td>
            <td class="num" data-col="lineSubtotal">${l.quantity ? formatCentavos(computeTotals([l]).subtotal, currency) : "—"}</td>
            <td><button type="button" class="btn" data-act="remove" data-index="${i}">Remove</button></td>
          </tr>`
        )}`
      );
      paintTotals();
    }

    function paintTotals() {
      const p = preview();
      render(
        totalsEl,
        html`<dt>Subtotal</dt><dd data-total="subtotal">${formatCentavos(p.subtotal, currency)}</dd>
          <dt>Discount</dt><dd data-total="discount">${formatCentavos(p.discount, currency)}${p.discountError ? html` <span class="form-error">${p.discountError}</span>` : ""}</dd>
          <dt>Total</dt><dd data-total="total"><strong>${formatCentavos(p.total, currency)}</strong></dd>`
      );
      for (const [i, l] of p.lines.entries()) {
        const cell = linesEl.querySelectorAll('[data-col="lineSubtotal"]')[i];
        if (cell) cell.textContent = l.quantity ? formatCentavos(computeTotals([l]).subtotal, currency) : "—";
      }
    }

    function paintResults() {
      render(
        resultsEl,
        state.results.length
          ? html`<ul class="list">${state.results.map(
              (p) => html`<li><button type="button" class="btn" data-act="add" data-id="${p.id}" ${state.lines.some((l) => l.productId === p.id) ? "disabled" : ""}>Add</button>
                ${p.sku} · ${p.name} · ${formatCentavos(p.sellingPrice, currency)} · ${formatQuantity(p.available)} ${UNITS[p.unit]?.label ?? p.unit} available</li>`
            )}</ul>`
          : ""
      );
    }

    async function search() {
      const term = form.elements.search.value.trim();
      if (!term) return;
      try {
        state.results = (await deps.searchProducts(term)).filter((p) => p.status === "active");
        if (!state.results.length) state.results = [];
      } catch {
        state.results = [];
      }
      paintResults();
      if (!state.results.length) render(resultsEl, html`<p class="stat-hint">No active product matches.</p>`);
    }

    form.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.lineIndex !== undefined) state.lines[Number(t.dataset.lineIndex)].quantityText = t.value;
      else if (t.name === "name") state.customer.name = t.value;
      else if (t.name === "phone") state.customer.phone = t.value;
      else if (t.name === "sourceNote") state.sourceNote = t.value;
      else if (t.name === "notes") state.notes = t.value;
      else if (t.name === "discount") state.discountText = t.value;
      paintTotals();
    });
    form.addEventListener("change", (e) => {
      if (e.target.name === "source") state.source = e.target.value;
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.name === "search") {
        e.preventDefault();
        search();
      }
    });
    form.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const act = el.dataset.act;
      if (act === "cancel") close(null);
      if (act === "search") search();
      if (act === "add") {
        const p = state.results.find((r) => r.id === el.dataset.id);
        if (p && !state.lines.some((l) => l.productId === p.id)) {
          state.lines.push({ productId: p.id, sku: p.sku, name: p.name, unit: p.unit, unitPrice: p.sellingPrice, quantityText: "1", reservedHere: 0, available: p.available });
          paintLines();
          paintResults();
        }
      }
      if (act === "remove") {
        state.lines.splice(Number(el.dataset.index), 1);
        paintLines();
        paintResults();
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (state.busy) return;
      errorEl.hidden = true;
      try {
        const p = preview();
        const bad = p.lines.find((l) => !l.quantity);
        if (bad) throw new Error(`${bad.name}: ${bad.qtyError || "enter a quantity"}`);
        if (p.discountError) throw new Error(p.discountError);
        const payload = {
          customer: { name: state.customer.name, phone: state.customer.phone, notes: state.customer.notes },
          source: state.source,
          sourceNote: state.sourceNote,
          items: p.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
          notes: state.notes,
          ...(canDiscount ? { discount: p.discount } : order ? { discount: order.discount } : {}),
        };
        state.busy = true;
        submitBtn.disabled = true;
        const body = order ? { action: "update", orderId: order.id, expectedRevision: order.revision, order: payload } : { action: "create", idempotencyKey, order: payload };
        close(await deps.api("orders", { method: "POST", body }));
      } catch (err) {
        state.busy = false;
        submitBtn.disabled = false;
        errorEl.textContent = err.message || "Couldn't save the order.";
        errorEl.hidden = false;
      }
    });

    document.addEventListener("keydown", onKey);
    paintLines();
    form.elements.name.focus();
  });
}
