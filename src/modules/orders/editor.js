// New / edit order dialog, built for speed when an order arrives by chat or
// phone: customer -> source -> delivery address (if delivered) -> pick
// products -> quantities -> (discount) -> notes -> create. Totals shown here are a PREVIEW from shared/orders.js;
// the server re-reads every product and computes the real totals.
// One idempotency key per dialog: double-clicks and retries can't create a
// second order.
// Items (2026-10-22): one compact row per item — product ▾ · qty · × unit
// price · line total · ✕ — any number of them on ONE order. "+ Add Item"
// adds a row; "Add product" is a quick pick. Choosing a product that is
// already on the order adds to that row's quantity (one line per product,
// as the server requires); a row's product can be changed or the row
// removed until Create order. Create order stays the only primary action.
// Quick Add Product (2026-11-01): "+ Quick Add Product" makes a product right
// here (Name + Price; Category / Stock / COGS optional) and puts it on the
// order, without leaving New Order. No stock entered → Track inventory OFF
// (sellable at once); stock entered → ON. Products that don't track
// inventory show no "available" figure and are never out of stock.

import { html, render } from "../../lib/html.js";
import { formatCentavos } from "../../lib/format.js";
import { ORDER_SOURCES, ORDER_SOURCE_IDS, computeTotals, parseQuantity, parseCentavos, formatQuantity, UNITS, canUseModule, snapshotWorkspaceTemplateId, lineCommission, phoneKey, addressKey, maskedPhone } from "@shared/index.js";

const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

// deps: { listActiveProducts() -> every active product, getProducts(ids) -> map, api,
//         searchCustomers?(term) -> active customers (Phase 9) }
// Customer: a saved customer (linked by id; the server copies its name and
// phone) or a walk-in name typed here. An already-linked order keeps its
// link unless the user unlinks it.
// 2026-10-22: three ways, all kept: a saved customer (Find saved customer →
// Use; Unlink keeps the customer record), a new customer typed here, or
// Walk-in / No saved customer.
// 2026-11-03: a customer typed on a NEW order is saved to Customers by the
// server, no extra step (same name + same phone / address = that customer).
// Same name only is a warning, not a match: "Similar customers found" lists
// them (masked phone, address) with "Use this customer" and "Create as new
// customer"; the order isn't created until the Owner picks one (never a
// silent merge, never a forced rename). Editing an order: Find saved customer,
// or "Save as a new customer".
// Reseller workspace (2026-11-03, Owner / Admin with resellers.pay): "Sold
// by" (Direct sale or a reseller) and, per line, Owner ₱200 · Sell [250] ·
// Commission [50]: the commission is calculated (sell − owner) × qty, and a
// typed one is the line's final commission ("₱40 · adjusted from ₱50");
// clearing it goes back to the calculated one.
// prefill (a NEW order from Customers → Add order): { customerId, customer:
// { name, phone }, deliveryAddress } so the saved details aren't retyped.
// The order keeps its own copy: editing the customer later never changes it.
// Special prices (2026-10-25): with a saved customer linked, a product's
// price is that customer's special price when there is one. The server
// prices every line the same way (and is the authority); lines already on
// an order keep the price they were added at.
const defaultCustomerPrices = (businessId, customerId) => import("../customers/data.js").then((m) => m.listCustomerPrices(businessId, customerId));
// A line's reseller fields: owner price, selling price text, line commission
// override text ("" = calculated) and whether it had one (clearing sends null).
function resellerFields(l) {
  const text = (c) => (Number.isSafeInteger(c) ? (c / 100).toFixed(2).replace(/\.00$/, "") : "");
  return Number.isSafeInteger(l.basePrice) ? { basePrice: l.basePrice, sellText: text(l.unitPrice), commText: text(l.finalCommission), hadOverride: Number.isSafeInteger(l.finalCommission) } : { basePrice: null, sellText: "", commText: "", hadOverride: false };
}
export function openOrderEditor({ session, deps, order = null, prefill = null }) {
  const perms = session.member.permissions;
  const canDiscount = perms["orders.discount"] === true;
  const currency = session.business.currency || "PHP";
  const idempotencyKey = newKey();
  // Editing a fulfilled order is a correction: same screen, plus a reason.
  const correcting = order?.fulfillmentStatus === "fulfilled";
  const canLink = canUseModule({ entitlements: session.entitlements, permissions: perms }, "customers") && typeof deps.searchCustomers === "function";
  // Editing an order with no saved customer: "Save as a new customer" (customers.manage).
  const canSave = canLink && Boolean(order) && perms["customers.manage"] === true && typeof deps.api === "function";
  // Reseller sales right here (Owner / Admin).
  const resellerWs = snapshotWorkspaceTemplateId(session.entitlements) === "reseller";
  const canResell = resellerWs && perms["resellers.pay"] === true && canUseModule({ entitlements: session.entitlements, permissions: perms }, "resellers") && typeof deps.api === "function";
  const asText = (c) => (Number.isSafeInteger(c) ? (c / 100).toFixed(2).replace(/\.00$/, "") : "");
  // Quick Add Product: whoever may add products (Inventory module), not while correcting.
  const canQuickAdd = !correcting && typeof deps.api === "function" && perms["products.manage"] === true && canUseModule({ entitlements: session.entitlements, permissions: perms }, "inventory");
  const canCost = perms["inventory.costs"] === true;
  const priceLabel = snapshotWorkspaceTemplateId(session.entitlements) === "reseller" ? "Owner/Base Price" : "Price";
  const availableOf = (p) => (p && p.trackInventory !== false ? p.available ?? null : null);
  const state = {
    customer: { name: (order ?? prefill)?.customer?.name ?? "", phone: (order ?? prefill)?.customer?.phone ?? "", notes: order?.customer?.notes ?? "" },
    customerId: (order ?? prefill)?.customerId ?? null,
    customerMatches: [],
    // Same-name customers waiting for the Owner's choice; newCustomer = "Create as new customer".
    sameName: [],
    sameNameFor: null,
    newCustomer: false,
    created: null, // { key, customerId }: a customer this form already saved (a retry reuses it)
    resellerId: order?.resellerId ?? null,
    resellers: null,
    // A source dropdown; the "where" note is asked only for Other. A note on
    // an older order (from the earlier free-text box) is kept as it was.
    source: order?.source ?? "",
    sourceNote: order?.sourceNote ?? "",
    deliveryAddress: (order ?? prefill)?.deliveryAddress ?? "",
    notes: order?.notes ?? "",
    reason: "",
    discountText: order ? (order.discount / 100).toFixed(2) : "0",
    // Open orders hold their quantity in reserve; a fulfilled order holds none.
    lines: (order?.items || []).map((l) => ({ productId: l.productId, sku: l.sku, name: l.name, unit: l.unit, unitPrice: l.unitPrice, special: l.customerPrice === true, quantityText: formatQuantity(l.quantity), reservedHere: correcting ? 0 : l.quantity, available: null, ...resellerFields(l) })),
    // What this (open) order already holds per product: a row switched back
    // to one of them counts it as available again.
    reservedBy: Object.fromEntries((order?.items || []).map((l) => [l.productId, correcting ? 0 : l.quantity])),
    hint: "",
    products: null, // every active product, for the dropdown (null = loading)
    prices: new Map(), // the linked customer's special prices (productId → centavos)
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
        for (const l of state.lines) l.available = availableOf(products[l.productId]);
        paintLines();
      });
    }

    // Reseller sale: the owner price (kept from the line, else the product's),
    // the selling price typed (blank = the owner price) and the commission.
    const ownerOf = (l) => (Number.isSafeInteger(l.basePrice) ? l.basePrice : l.productPrice ?? l.unitPrice);
    function resold(l, quantity) {
      const basePrice = ownerOf(l);
      let unitPrice = basePrice;
      let sellError = "";
      if (l.sellText.trim()) {
        try {
          unitPrice = parseCentavos(l.sellText.replace(/[₱,\s]/g, ""));
        } catch {
          sellError = "Selling price: an amount like 250 or 250.50";
        }
      }
      const calc = quantity ? lineCommission({ quantity, unitPrice, basePrice }) : 0;
      let final = Math.max(0, calc);
      let override = null;
      let commError = "";
      if (l.commText.trim()) {
        try {
          override = parseCentavos(l.commText.replace(/[₱,\s]/g, ""));
          final = override;
        } catch {
          commError = "Commission: an amount like 40, or blank for the calculated one";
        }
      }
      if (!commError && override === null && calc < 0) commError = "Selling price is below the owner price: type the commission (₱0 or more) to accept it";
      return { unitPrice, basePrice, calc, final, override, sellError, commError };
    }
    function parsedLines() {
      return state.lines.map((l) => {
        if (!l.productId) return { ...l, quantity: null, blank: true };
        let out;
        try {
          out = { ...l, quantity: parseQuantity(l.quantityText, l.unit) };
        } catch (err) {
          out = { ...l, quantity: null, qtyError: err.message };
        }
        if (!canResell || !state.resellerId) return out;
        const r = resold(l, out.quantity);
        return { ...out, unitPrice: r.unitPrice, resell: r };
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
      // A whole-order final commission (set in Reseller & commission) stays
      // until a line commission is typed (the server does the same).
      const wholeOrder = order?.commission?.adjusted === true && order.commission.scope !== "lines" && state.resellerId === order.resellerId && !lines.some((l) => l.resell && (l.resell.override !== null || l.hadOverride));
      const resell = canResell && state.resellerId ? { owner: valid.reduce((t, l) => t + computeTotals([{ ...l, unitPrice: l.resell.basePrice }]).subtotal, 0), calc: valid.reduce((t, l) => t + l.resell.calc, 0), final: wholeOrder ? order.commission.final : valid.reduce((t, l) => t + l.resell.final, 0), wholeOrder } : null;
      try {
        return { ...computeTotals(valid, discount), lines, resell };
      } catch {
        return { ...computeTotals(valid, 0), lines, resell, discountError: "Discount is more than the subtotal" };
      }
    }

    const sourceOptions = ORDER_SOURCE_IDS.map((id) => html`<option value="${id}" ${state.source === id ? "selected" : ""}>${ORDER_SOURCES[id].label}</option>`);

    render(
      backdrop,
      html`<form class="modal modal-wide form" role="dialog" aria-modal="true" aria-labelledby="oe-title" novalidate>
        <div class="modal-header"><h2 class="card-title" id="oe-title">${order ? `Edit ${order.orderNumber}` : "New order"}</h2></div>
        <div class="modal-body">
          ${correcting ? html`<p class="form-notice" data-role="correcting">This order is fulfilled. Saving corrects stock, sales and COGS automatically and keeps the original in the activity log.</p>` : ""}
          <section class="oe-section" data-role="oe-customer">
            <div class="oe-pair">
              <div class="field"><label for="oeName">Customer name *</label><input class="input" id="oeName" name="name" value="${state.customer.name}" autocomplete="off" ${state.customerId ? "readonly" : ""} /></div>
              <div class="field"><label for="oePhone">Contact</label><input class="input" id="oePhone" name="phone" value="${state.customer.phone}" inputmode="tel" autocomplete="off" ${state.customerId ? "readonly" : ""} /></div>
            </div>
            <div data-role="customer-link"></div>
            <div class="field"><label for="oeAddress">Delivery address</label><textarea class="input" id="oeAddress" name="deliveryAddress" rows="2" maxlength="300" placeholder="Leave blank for pick-up or walk-in">${state.deliveryAddress}</textarea></div>
            <div class="oe-pair">
              <div class="field"><label for="oeSource">Where did the order come from?</label><select class="input" id="oeSource" name="source"><option value="" ${state.source ? "" : "selected"}>Not set</option>${sourceOptions}</select></div>
              <div class="field" data-role="source-other" ${state.source === "other" ? "" : "hidden"}><label for="oeSourceNote">Where? *</label><input class="input" id="oeSourceNote" name="sourceNote" value="${state.source === "other" ? state.sourceNote : ""}" maxlength="120" placeholder="e.g. Instagram, referral" autocomplete="off" /></div>
            </div>
          </section>
          <section class="oe-section" data-role="oe-products">
            ${canResell ? html`<div class="field"><label for="oeSeller">Sold by</label><select class="input" id="oeSeller" name="seller" data-role="seller"><option value="">Direct sale (no reseller)</option>${order?.resellerId ? html`<option value="${order.resellerId}" selected>${order.reseller?.name ?? "Reseller"}</option>` : ""}</select></div>` : ""}
            <div class="field"><label for="oeProduct">Add product</label><select class="input" id="oeProduct" name="product" data-role="product-select" disabled><option value="">Loading products…</option></select></div>
            <div class="oe-items-head" aria-hidden="true"><span>Product</span><span>Qty</span><span>Unit price</span><span>Total</span><span></span></div>
            <div class="oe-items" data-role="lines"></div>
            <p class="stat-hint oe-hint" data-role="items-hint" aria-live="polite"></p>
            <div class="oe-add-row"><button type="button" class="btn btn-compact oe-add-item" data-act="add-item">+ Add Item</button>${canQuickAdd ? html`<button type="button" class="btn btn-compact" data-act="quick-add">+ Quick Add Product</button>` : ""}</div>
            ${canQuickAdd
              ? html`<div class="oe-quick" data-role="quick-add" hidden>
                  <h3 class="oe-quick-title">Quick Add Product</h3>
                  <div class="oe-pair">
                    <div class="field"><label for="qaName">Product name *</label><input class="input" id="qaName" name="qaName" maxlength="120" autocomplete="off" placeholder="e.g. Nipple Tape" /></div>
                    <div class="field"><label for="qaPrice">${priceLabel} (${currency}) *</label><input class="input" id="qaPrice" name="qaPrice" inputmode="decimal" autocomplete="off" placeholder="e.g. 250" /></div>
                  </div>
                  <details class="form-more"><summary>Category, stock${canCost ? ", COGS" : ""} (optional)</summary>
                    <div class="field"><label for="qaCategory">Category</label><input class="input" id="qaCategory" name="qaCategory" maxlength="60" autocomplete="off" /></div>
                    <div class="oe-pair">
                      <div class="field"><label for="qaStock">Stock on hand</label><input class="input" id="qaStock" name="qaStock" inputmode="numeric" autocomplete="off" placeholder="Blank = not tracked" /></div>
                      ${canCost ? html`<div class="field"><label for="qaCost">COGS (${currency})</label><input class="input" id="qaCost" name="qaCost" inputmode="decimal" autocomplete="off" placeholder="Optional, 0 is fine" /></div>` : ""}
                    </div>
                    <p class="stat-hint">Leave stock blank to sell without tracking inventory. Enter it to track stock from now on.</p>
                  </details>
                  <p class="form-error" data-role="qa-error" role="alert" hidden></p>
                  <div class="oe-quick-actions"><button type="button" class="btn btn-compact" data-act="qa-cancel">Cancel</button><button type="button" class="btn btn-compact btn-primary" data-act="qa-save">Add product</button></div>
                </div>`
              : ""}
          </section>
          <section class="oe-section" data-role="oe-money">
            ${canDiscount ? html`<div class="field oe-discount"><label for="oeDiscount">Discount (${currency})</label><input class="input" id="oeDiscount" name="discount" value="${state.discountText}" inputmode="decimal" autocomplete="off" /></div>` : ""}
            <dl class="dl oe-totals" data-role="totals"></dl>
            <details class="form-more" ${state.notes || correcting ? "open" : ""}><summary>Order notes${correcting ? " and reason" : ""}</summary>
              <div class="field"><label for="oeNotes">Order notes</label><textarea class="input" id="oeNotes" name="notes" rows="2" maxlength="500">${state.notes}</textarea></div>
              ${correcting ? html`<div class="field"><label for="oeReason">Reason for the change</label><textarea class="input" id="oeReason" name="reason" rows="2" maxlength="300" placeholder="e.g. Encoded 10 by mistake, customer ordered 8"></textarea><div class="stat-hint">Needed when quantities, products, selling prices or the discount change.</div></div>` : ""}
            </details>
          </section>
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
    const productSelect = form.querySelector('[data-role="product-select"]');
    const otherEl = form.querySelector('[data-role="source-other"]');
    const errorEl = form.querySelector('[data-role="error"]');
    const submitBtn = form.querySelector('[data-act="submit"]');
    const linkEl = form.querySelector('[data-role="customer-link"]');

    // Saved-customer link: "Find saved customer" -> Use, or Unlink -> walk-in.
    function paintLink() {
      form.elements.name.readOnly = Boolean(state.customerId);
      form.elements.phone.readOnly = Boolean(state.customerId);
      if (state.customerId) {
        // Supporting information: quieter than the customer's own details.
        render(linkEl, html`<p class="oe-linked" data-role="linked">Saved customer: <strong>${state.customer.name}</strong> · <button type="button" class="btn-linklike" data-act="unlink">Unlink</button></p>`);
        return;
      }
      if (!canLink) return render(linkEl, html``);
      const typed = state.customer.name.trim();
      const autoSave = !order && typed && !/^walk-?in$/i.test(typed);
      render(
        linkEl,
        html`<p class="oe-linked"><button type="button" class="btn-linklike" data-act="find-customer">Find saved customer</button> · <button type="button" class="btn-linklike" data-act="walk-in">Walk-in / No saved customer</button>${canSave && typed && !/^walk-?in$/i.test(typed) ? html` · <button type="button" class="btn-linklike" data-act="save-new">Save as a new customer</button>` : ""}</p>
          ${state.sameName.length
            ? html`<div class="oe-similar" data-role="similar-customers"><p class="oe-similar-title">Similar customers found</p>
                <ul class="list">${state.sameName.map(
                  (c) => html`<li class="oe-similar-row"><span><b>${c.name}</b>${maskedPhone(c.phone) ? html` · ${maskedPhone(c.phone)}` : ""}${c.address ? html`<span class="stat-hint"> · ${c.address}</span>` : ""}</span><button type="button" class="btn btn-compact" data-act="use-customer" data-id="${c.id}">Use this customer</button></li>`
                )}</ul>
                <button type="button" class="btn btn-compact" data-act="new-customer">Create as new customer</button>
                ${!state.customer.phone.trim() && !state.deliveryAddress.trim() ? html`<p class="stat-hint" data-role="similar-tip">Consider adding a phone number, an address or a clearer name (e.g. "${typed} - BGC") so you can tell them apart later.</p>` : ""}
              </div>`
            : autoSave
              ? html`<p class="stat-hint" data-role="auto-save">${state.newCustomer ? `${typed} will be saved as a new customer.` : "Saved to Customers automatically when you create the order."}</p>`
              : ""}
          ${state.customerMatches.length
            ? html`<ul class="list" data-role="customer-matches">${state.customerMatches.map(
                (c) => html`<li><button type="button" class="btn btn-compact" data-act="use-customer" data-id="${c.id}">Use</button> ${c.name}${c.company ? ` · ${c.company}` : ""}${c.phone ? ` · ${c.phone}` : ""}</li>`
              )}</ul>`
            : ""}`
      );
    }

    async function findCustomer() {
      const term = form.elements.name.value.trim();
      if (!term) {
        errorEl.textContent = "Type part of the customer's name first";
        errorEl.hidden = false;
        return;
      }
      errorEl.hidden = true;
      try {
        state.customerMatches = await deps.searchCustomers(term);
      } catch {
        state.customerMatches = [];
      }
      paintLink();
      if (!state.customerMatches.length) render(linkEl, html`<p class="stat-hint" data-role="no-customer">No saved customer starts with "${term}".${order ? "" : " They're saved to Customers when you create the order."}</p>`);
    }

    // Same name, no matching phone / address: the Owner chooses (2026-11-03).
    // Returns true when the order may go ahead.
    async function checkSameName() {
      const typed = state.customer.name.trim();
      if (order || state.customerId || state.newCustomer || !canLink || !typed || /^walk-?in$/i.test(typed)) {
        state.sameName = [];
        return true;
      }
      const key = typed.replace(/\s+/g, " ").toLocaleLowerCase("en");
      let rows = [];
      try {
        rows = (await deps.searchCustomers(typed)).filter((c) => (c.name || "").replace(/\s+/g, " ").toLocaleLowerCase("en") === key);
      } catch {
        rows = []; // the server still never merges on a name alone
      }
      if (state.customer.name.trim() !== typed) return false; // typed on meanwhile
      const pk = phoneKey(state.customer.phone);
      const ak = addressKey(state.deliveryAddress);
      const strong = rows.filter((c) => (pk && phoneKey(c.phone || "") === pk) || (ak && addressKey(c.address || "") === ak));
      // One clear match (same name + phone / address): the server links it.
      state.sameName = strong.length === 1 ? [] : rows;
      state.sameNameFor = typed;
      paintLink();
      return !state.sameName.length;
    }

    // A row's product choices: every active product (plus the row's own, if
    // it is no longer active, so an older order still shows what it holds).
    const productOptions = (l) => {
      const list = state.products || [];
      const own = l.productId && !list.some((p) => p.id === l.productId) ? [{ id: l.productId, sku: l.sku, name: l.name, sellingPrice: l.unitPrice }] : [];
      return html`<option value="" ${l.productId ? "" : "selected"}>${list.length || own.length ? "Choose a product…" : state.products === null ? "Loading products…" : canQuickAdd ? "No products yet: use + Quick Add Product" : "No active products yet"}</option>${[...own, ...list].map((p) => html`<option value="${p.id}" ${p.id === l.productId ? "selected" : ""}>${p.name} · ${formatCentavos(state.prices.get(p.id) ?? p.sellingPrice, currency)}${state.prices.has(p.id) ? " (special)" : ""}</option>`)}`;
    };
    const unitOf = (l) => UNITS[l.unit]?.label ?? l.unit ?? "";
    function paintLines() {
      const p = preview();
      render(
        linesEl,
        html`${p.lines.map(
          (l, i) => html`<div class="oe-item" data-line="${l.productId || ""}" data-index="${i}">
            <select class="select oe-item-product" name="item-${i}" data-item-index="${i}" aria-label="Product for item ${i + 1}">${productOptions(l)}</select>
            <input class="input input-qty oe-item-qty" name="qty-${i}" data-line-index="${i}" value="${state.lines[i].quantityText}" inputmode="${UNITS[l.unit]?.decimals ? "decimal" : "numeric"}" aria-label="Quantity for ${l.name || `item ${i + 1}`}" autocomplete="off" ${l.productId ? "" : "disabled"} />
            <span class="oe-item-price" data-col="unitPrice">${l.productId ? (l.resell ? html`<small class="oe-owner-k">Owner</small> ${formatCentavos(l.resell.basePrice, currency)}` : html`× ${formatCentavos(l.unitPrice, currency)}${state.lines[i].special ? html` <small class="oe-special" data-role="special-price">special</small>` : ""}`) : ""}</span>
            <b class="oe-item-total" data-col="lineSubtotal">${l.quantity ? formatCentavos(computeTotals([l]).subtotal, currency) : "—"}</b>
            <button type="button" class="btn btn-compact btn-ghost oe-item-remove" data-act="remove" data-index="${i}" aria-label="Remove ${l.name || `item ${i + 1}`}">✕</button>
            ${l.resell && l.productId
              ? html`<div class="oe-item-resell" data-role="resell">
                  <label class="oe-resell-field"><span>Sell</span><input class="input input-compact" name="sell-${i}" data-sell-index="${i}" value="${state.lines[i].sellText}" placeholder="${asText(l.resell.basePrice)}" inputmode="decimal" autocomplete="off" aria-label="Selling price for ${l.name}" /></label>
                  <label class="oe-resell-field"><span>Commission</span><input class="input input-compact" name="comm-${i}" data-comm-index="${i}" value="${state.lines[i].commText}" placeholder="${asText(Math.max(0, l.resell.calc))}" inputmode="decimal" autocomplete="off" aria-label="Final commission for ${l.name}" /></label>
                  <span class="stat-hint oe-resell-note" data-role="comm-note"></span>
                </div>`
              : ""}
            ${l.qtyError ? html`<div class="form-error oe-item-note">${l.qtyError}</div>` : l.productId && l.available !== null && l.available !== undefined ? html`<div class="stat-hint oe-item-note">${formatQuantity(l.available + (l.reservedHere || 0))} ${unitOf(l)} available</div>` : ""}
          </div>`
        )}`
      );
      form.querySelector('[data-role="items-hint"]').textContent = state.hint;
      paintTotals();
    }

    // Product p on row i (null: a new row). Already on another row: that
    // row's quantity grows instead (one line per product).
    function setProduct(i, p, { addQty = "1" } = {}) {
      const other = state.lines.findIndex((l, j) => j !== i && l.productId === p.id);
      if (other >= 0) {
        const row = state.lines[other];
        const here = i === null ? addQty : state.lines[i].quantityText || "1";
        try {
          row.quantityText = formatQuantity(parseQuantity(row.quantityText, row.unit) + parseQuantity(here, row.unit));
        } catch {
          /* a quantity being typed: leave it for the person to fix */
        }
        if (i !== null) state.lines.splice(i, 1);
        state.hint = `${p.name} is already on this order: its quantity is now ${row.quantityText}.`;
        paintLines();
        form.elements[`qty-${state.lines.indexOf(row)}`]?.focus();
        return;
      }
      const line = { productId: p.id, sku: p.sku, name: p.name, unit: p.unit, unitPrice: state.prices.get(p.id) ?? p.sellingPrice, productPrice: p.sellingPrice, special: state.prices.has(p.id), quantityText: i === null ? addQty : state.lines[i].quantityText || "1", reservedHere: state.reservedBy[p.id] || 0, available: availableOf(p), basePrice: null, sellText: "", commText: "", hadOverride: false };
      if (i === null) state.lines.push(line);
      else state.lines[i] = line;
      state.hint = "";
      paintLines();
      form.elements[`qty-${i === null ? state.lines.length - 1 : i}`]?.focus();
    }

    function paintTotals() {
      const p = preview();
      const adjusted = p.resell && p.resell.final !== Math.max(0, p.resell.calc);
      render(
        totalsEl,
        html`${p.resell ? html`<dt>Owner amount</dt><dd data-total="owner">${formatCentavos(p.resell.owner, currency)}</dd>` : ""}
          <dt>${p.resell ? "Customer subtotal" : "Subtotal"}</dt><dd data-total="subtotal">${formatCentavos(p.subtotal, currency)}</dd>
          <dt>Discount</dt><dd data-total="discount">${formatCentavos(p.discount, currency)}${p.discountError ? html` <span class="form-error">${p.discountError}</span>` : ""}</dd>
          <dt>${p.resell ? "Customer total" : "Total"}</dt><dd data-total="total"><strong>${formatCentavos(p.total, currency)}</strong></dd>
          ${p.resell ? html`<dt>Commission</dt><dd data-total="commission">${formatCentavos(p.resell.final, currency)}${adjusted ? html` <small class="stat-hint">· adjusted from ${formatCentavos(Math.max(0, p.resell.calc), currency)}${p.resell.wholeOrder ? " (set for the whole order; typing a line commission replaces it)" : ""}</small>` : ""}</dd>` : ""}`
      );
      for (const [i, l] of p.lines.entries()) {
        const row = linesEl.querySelectorAll(".oe-item")[i];
        if (!row) continue;
        row.querySelector('[data-col="lineSubtotal"]').textContent = l.quantity ? formatCentavos(computeTotals([l]).subtotal, currency) : "—";
        // The row's note follows the typing: what's available, or why the quantity won't do.
        let note = row.querySelector(".oe-item-note");
        const text = l.qtyError || (l.productId && l.available !== null && l.available !== undefined ? `${formatQuantity(l.available + (l.reservedHere || 0))} ${unitOf(l)} available` : "");
        if (!note && text) {
          note = document.createElement("div");
          row.appendChild(note);
        }
        if (note) {
          note.className = `${l.qtyError ? "form-error" : "stat-hint"} oe-item-note`;
          note.textContent = text;
        }
        // Reseller line: "₱40 · adjusted from ₱50", or why a figure won't do.
        const commNote = row.querySelector('[data-role="comm-note"]');
        if (commNote && l.resell) {
          const r = l.resell;
          const bad = r.sellError || r.commError;
          commNote.className = `${bad ? "form-error" : "stat-hint"} oe-resell-note`;
          commNote.textContent = bad || (r.override !== null && r.override !== Math.max(0, r.calc) ? `${formatCentavos(r.final, currency)} · adjusted from ${formatCentavos(Math.max(0, r.calc), currency)}` : l.quantity ? `Commission ${formatCentavos(r.final, currency)}` : "");
        }
        if (l.resell) row.querySelector('[data-col="unitPrice"]').title = `Selling ${formatCentavos(l.resell.unitPrice, currency)}`;
      }
    }

    // Quick pick: every active product, by name. Picking one already on the
    // order adds 1 to it (see setProduct).
    function paintProducts() {
      if (state.products === null) return;
      productSelect.disabled = !state.products.length;
      render(
        productSelect,
        state.products.length
          ? html`<option value="">Choose a product (${state.products.length})…</option>${state.products.map(
              (p) => html`<option value="${p.id}">${p.sku} · ${p.name} · ${formatCentavos(state.prices.get(p.id) ?? p.sellingPrice, currency)}${state.prices.has(p.id) ? " (special)" : ""}${p.trackInventory === false ? "" : ` · ${formatQuantity(p.available)} ${UNITS[p.unit]?.label ?? p.unit} left`}</option>`
            )}`
          : html`<option value="">${canQuickAdd ? "No products yet: use + Quick Add Product below" : "No active products yet: add them in Inventory"}</option>`
      );
      productSelect.value = "";
    }

    deps
      .listActiveProducts()
      .then((rows) => (state.products = rows.filter((p) => p.status === "active")))
      .catch(() => (state.products = []))
      .then(() => {
        paintProducts();
        paintLines(); // the rows' product lists
        if (state.customerId) loadPrices();
      });

    // Sold by ▾: the active resellers (and the order's own, even if inactive now).
    const sellerEl = form.querySelector('[data-role="seller"]');
    if (canResell) {
      deps
        .api("resellers", { method: "POST", body: { action: "list" } })
        .then((r) => (state.resellers = (r.resellers || []).filter((x) => x.status === "active" || x.id === state.resellerId)))
        .catch(() => (state.resellers = []))
        .then(() => {
          render(sellerEl, html`<option value="">Direct sale (no reseller)</option>${state.resellers.map((r) => html`<option value="${r.id}" ${r.id === state.resellerId ? "selected" : ""}>${r.status === "active" ? r.name : `${r.name} (inactive)`}</option>`)}`);
        });
    }
    function setSeller(id) {
      const was = state.resellerId;
      state.resellerId = id || null;
      // Becoming a reseller sale: each line's owner price is its current price.
      if (!was && state.resellerId) for (const l of state.lines) if (l.productId && !Number.isSafeInteger(l.basePrice)) Object.assign(l, { basePrice: l.productPrice ?? l.unitPrice, sellText: "", commText: "" });
      paintLines();
    }

    // The linked customer's special prices; the lines NEW to this order
    // follow them (a line already on the order keeps its price).
    const onOrder = new Set((order?.items || []).map((l) => l.productId));
    let pricesFor;
    async function loadPrices() {
      const id = state.customerId;
      pricesFor = id;
      let rows = [];
      if (id) {
        try {
          rows = await (deps.listCustomerPrices ? deps.listCustomerPrices(id) : defaultCustomerPrices(session.business.id, id));
        } catch {
          rows = [];
        }
      }
      if (pricesFor !== id) return; // a newer pick came first
      state.prices = new Map(rows.map((r) => [r.productId, r.price]));
      const byId = new Map((state.products || []).map((p) => [p.id, p]));
      for (const l of state.lines) {
        if (!l.productId || onOrder.has(l.productId)) continue;
        if (state.prices.has(l.productId)) Object.assign(l, { unitPrice: state.prices.get(l.productId), special: true });
        else if (byId.has(l.productId)) Object.assign(l, { unitPrice: byId.get(l.productId).sellingPrice, special: false });
      }
      if (state.products) paintProducts();
      paintLines();
    }
    if (state.customerId) loadPrices();

    form.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.lineIndex !== undefined) state.lines[Number(t.dataset.lineIndex)].quantityText = t.value;
      else if (t.dataset.sellIndex !== undefined) state.lines[Number(t.dataset.sellIndex)].sellText = t.value;
      else if (t.dataset.commIndex !== undefined) state.lines[Number(t.dataset.commIndex)].commText = t.value;
      else if (t.name === "name") {
        state.customer.name = t.value;
        // A different name: any earlier choice about same-name customers is void.
        if (state.sameNameFor !== null && t.value.trim() !== state.sameNameFor) Object.assign(state, { sameName: [], sameNameFor: null, newCustomer: false });
      }
      else if (t.name === "phone") state.customer.phone = t.value;
      else if (t.name === "sourceNote") state.sourceNote = t.value;
      else if (t.name === "deliveryAddress") state.deliveryAddress = t.value;
      else if (t.name === "notes") state.notes = t.value;
      else if (t.name === "discount") state.discountText = t.value;
      else if (t.name === "reason") state.reason = t.value;
      paintTotals();
    });
    form.addEventListener("change", (e) => {
      const t = e.target;
      if (t.name === "seller") setSeller(t.value);
      if (t.name === "name" || t.name === "phone" || t.name === "deliveryAddress") checkSameName();
      if (t.name === "source") {
        state.source = t.value;
        otherEl.hidden = state.source !== "other";
        if (state.source === "other") form.elements.sourceNote.focus();
      }
      if (t.name === "product" && t.value) {
        const p = (state.products || []).find((r) => r.id === t.value);
        if (p) setProduct(null, p);
        paintProducts();
      }
      // A row's own product ▾: set or switch it (combined if already on the order).
      if (t.dataset.itemIndex !== undefined && t.value) {
        const p = (state.products || []).find((r) => r.id === t.value);
        if (p) setProduct(Number(t.dataset.itemIndex), p);
      }
    });
    form.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const act = el.dataset.act;
      if (act === "cancel") close(null);
      if (act === "find-customer") findCustomer();
      if (act === "use-customer") {
        const c = [...state.customerMatches, ...state.sameName].find((r) => r.id === el.dataset.id);
        if (c) {
          state.customerId = c.id;
          state.customer.name = c.name;
          state.customer.phone = c.phone || "";
          form.elements.name.value = state.customer.name;
          form.elements.phone.value = state.customer.phone;
          // The saved delivery address, unless one was already typed for this order.
          if (!state.deliveryAddress.trim() && c.address) {
            state.deliveryAddress = c.address;
            form.elements.deliveryAddress.value = c.address;
          }
          state.customerMatches = [];
          state.sameName = [];
          paintLink();
          loadPrices();
        }
      }
      if (act === "new-customer") {
        state.newCustomer = true;
        state.sameName = [];
        paintLink();
      }
      if (act === "save-new") saveNewCustomer();
      if (act === "unlink") {
        state.customerId = null;
        paintLink();
        loadPrices();
        form.elements.name.focus();
      }
      if (act === "walk-in") {
        state.customer.name = "Walk-in";
        state.customer.phone = "";
        Object.assign(state, { sameName: [], sameNameFor: null, newCustomer: false });
        form.elements.name.value = "Walk-in";
        form.elements.phone.value = "";
        if (!state.source) {
          state.source = "walk_in";
          form.elements.source.value = "walk_in";
        }
        state.customerMatches = [];
        paintLink();
      }
      if (act === "remove") {
        state.lines.splice(Number(el.dataset.index), 1);
        state.hint = "";
        paintLines();
        paintProducts();
      }
      if (act === "quick-add") openQuickAdd();
      if (act === "qa-cancel") closeQuickAdd();
      if (act === "qa-save") quickAdd();
      if (act === "add-item") {
        state.lines.push({ productId: null, sku: "", name: "", unit: null, unitPrice: 0, quantityText: "1", reservedHere: 0, available: null, basePrice: null, sellText: "", commText: "", hadOverride: false });
        state.hint = "";
        paintLines();
        form.elements[`item-${state.lines.length - 1}`]?.focus();
      }
    });

    // ---------- Quick Add Product ----------
    const quickEl = form.querySelector('[data-role="quick-add"]');
    function openQuickAdd() {
      if (!quickEl) return;
      quickEl.hidden = false;
      quickEl.querySelector('[data-role="qa-error"]').hidden = true;
      form.elements.qaName.focus();
    }
    function closeQuickAdd() {
      if (!quickEl) return;
      quickEl.hidden = true;
      for (const n of ["qaName", "qaPrice", "qaCategory", "qaStock", "qaCost"]) if (form.elements[n]) form.elements[n].value = "";
    }
    const money = (text) => text.replace(/[₱,\s]/g, "");
    let quickBusy = false;
    async function quickAdd() {
      if (quickBusy) return;
      const err = quickEl.querySelector('[data-role="qa-error"]');
      err.hidden = true;
      const v = (n) => (form.elements[n]?.value ?? "").trim();
      try {
        if (!v("qaName")) throw new Error("Enter the product name");
        if (!v("qaPrice")) throw new Error(`Enter the ${priceLabel.toLowerCase()}`);
        let price;
        try {
          price = parseCentavos(money(v("qaPrice")));
        } catch {
          throw new Error(`${priceLabel}: enter an amount like 250 or 250.50`);
        }
        const product = { name: v("qaName"), sellingPrice: price };
        if (v("qaCategory")) product.category = v("qaCategory");
        if (v("qaStock")) {
          try {
            product.stock = parseQuantity(v("qaStock").replace(/,/g, ""), "pcs");
          } catch {
            throw new Error("Stock: a whole number, 0 or more, or leave it blank");
          }
        }
        if (canCost && v("qaCost")) {
          try {
            product.unitCost = parseCentavos(money(v("qaCost")));
          } catch {
            throw new Error("COGS: an amount like 180 or 0, or leave it blank");
          }
        }
        quickBusy = true;
        quickEl.querySelector('[data-act="qa-save"]').disabled = true;
        const r = await deps.api("products", { method: "POST", body: { action: "quickAdd", product } });
        const p = { ...r.product, id: r.productId };
        state.products = [...(state.products || []), p].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        closeQuickAdd();
        paintProducts();
        setProduct(null, p);
        state.hint = `${p.name} added to your products${p.trackInventory === false ? " (stock not tracked)" : ""} and to this order.`;
        form.querySelector('[data-role="items-hint"]').textContent = state.hint;
      } catch (e) {
        err.textContent = e.message || "Couldn't add the product.";
        err.hidden = false;
      } finally {
        quickBusy = false;
        const b = quickEl.querySelector('[data-act="qa-save"]');
        if (b) b.disabled = false;
      }
    }
    // Enter inside Quick Add adds the product (it never submits the order).
    quickEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT") {
        e.preventDefault();
        quickAdd();
      }
    });

    // A reseller line for the server: its selling price and, when typed, its
    // final commission (cleared after having one = back to the calculated one).
    function resellItem(l) {
      const r = l.resell;
      return { sellingPrice: r.unitPrice, ...(r.override !== null ? { finalCommission: r.override } : l.hadOverride ? { finalCommission: null } : {}) };
    }
    // Editing an order with no saved customer: save the typed one as a new
    // customer and link the order to them (Save changes keeps the link).
    async function saveNewCustomer() {
      const name = state.customer.name.trim();
      if (!name || /^walk-?in$/i.test(name)) return;
      errorEl.hidden = true;
      try {
        const k = JSON.stringify([name, state.customer.phone.trim(), state.deliveryAddress.trim()]);
        if (state.created?.key !== k) {
          const r = await deps.api("customers", { method: "POST", body: { action: "create", customer: { name, ...(state.customer.phone.trim() ? { phone: state.customer.phone.trim() } : {}), ...(state.deliveryAddress.trim() ? { address: state.deliveryAddress.trim() } : {}) } } });
          state.created = { key: k, customerId: r.customerId };
        }
        state.customerId = state.created.customerId;
        paintLink();
      } catch (err) {
        errorEl.textContent = err.message || "Couldn't save the customer.";
        errorEl.hidden = false;
      }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (state.busy) return;
      errorEl.hidden = true;
      try {
        const p = preview();
        const blank = p.lines.findIndex((l) => l.blank);
        if (blank >= 0) throw new Error(`Choose a product for item ${blank + 1}, or remove it`);
        const bad = p.lines.find((l) => !l.quantity);
        if (bad) throw new Error(`${bad.name}: ${bad.qtyError || "enter a quantity more than 0"}`);
        if (p.discountError) throw new Error(p.discountError);
        const badResell = p.lines.find((l) => l.resell && (l.resell.sellError || l.resell.commError));
        if (badResell) throw new Error(`${badResell.name}: ${badResell.resell.sellError || badResell.resell.commError}`);
        // Same name as someone in Customers, nothing else matching: choose first.
        state.busy = true;
        submitBtn.disabled = true;
        const clear = await checkSameName();
        state.busy = false;
        submitBtn.disabled = false;
        if (!clear) throw new Error("A customer with this name already exists. Choose “Use this customer” or “Create as new customer”.");
        const customerId = state.customerId;
        const payload = {
          customer: { name: state.customer.name, phone: state.customer.phone, notes: state.customer.notes },
          ...(customerId ? { customerId } : {}),
          source: state.source,
          // Other needs its note; any other source keeps an older order's note unchanged.
          sourceNote: state.source === "other" || state.source === order?.source ? state.sourceNote : "",
          deliveryAddress: state.deliveryAddress,
          items: p.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, ...(canResell && state.resellerId ? resellItem(l) : {}) })),
          // Sold by: sent by the Owner / Admin (absent = unchanged for others).
          ...(canResell ? { resellerId: state.resellerId } : {}),
          ...(!order && !customerId && state.newCustomer ? { newCustomer: true } : {}),
          notes: state.notes,
          ...(canDiscount ? { discount: p.discount } : order ? { discount: order.discount } : {}),
        };
        state.busy = true;
        submitBtn.disabled = true;
        const body = order
          ? { action: "update", orderId: order.id, expectedRevision: order.revision, order: payload, ...(correcting && state.reason.trim() ? { reason: state.reason.trim() } : {}) }
          : { action: "create", idempotencyKey, order: payload };
        close(await deps.api("orders", { method: "POST", body }));
      } catch (err) {
        state.busy = false;
        submitBtn.disabled = false;
        errorEl.textContent = err.message || "Couldn't save the order.";
        errorEl.hidden = false;
      }
    });

    document.addEventListener("keydown", onKey);
    paintLink();
    paintLines();
    form.elements.name.focus();
  });
}
