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

import { html, render } from "../../lib/html.js";
import { formatCentavos } from "../../lib/format.js";
import { ORDER_SOURCES, ORDER_SOURCE_IDS, computeTotals, parseQuantity, parseCentavos, formatQuantity, UNITS, canUseModule } from "@shared/index.js";

const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

// deps: { listActiveProducts() -> every active product, getProducts(ids) -> map, api,
//         searchCustomers?(term) -> active customers (Phase 9) }
// Customer: a saved customer (linked by id; the server copies its name and
// phone) or a walk-in name typed here. An already-linked order keeps its
// link unless the user unlinks it.
// 2026-10-22: three ways, all kept: a saved customer (Find saved customer →
// Use; Unlink keeps the customer record), a new customer typed here (Save to
// Customers makes the record and links this order to it, never merging with
// a look-alike), or Walk-in / No saved customer.
// prefill (a NEW order from Customers → Add order): { customerId, customer:
// { name, phone }, deliveryAddress } so the saved details aren't retyped.
// The order keeps its own copy: editing the customer later never changes it.
// Special prices (2026-10-25): with a saved customer linked, a product's
// price is that customer's special price when there is one. The server
// prices every line the same way (and is the authority); lines already on
// an order keep the price they were added at.
const defaultCustomerPrices = (businessId, customerId) => import("../customers/data.js").then((m) => m.listCustomerPrices(businessId, customerId));
export function openOrderEditor({ session, deps, order = null, prefill = null }) {
  const perms = session.member.permissions;
  const canDiscount = perms["orders.discount"] === true;
  const currency = session.business.currency || "PHP";
  const idempotencyKey = newKey();
  // Editing a fulfilled order is a correction: same screen, plus a reason.
  const correcting = order?.fulfillmentStatus === "fulfilled";
  const canLink = canUseModule({ entitlements: session.entitlements, permissions: perms }, "customers") && typeof deps.searchCustomers === "function";
  // Save to Customers: new orders, for whoever may add customers.
  const canSave = canLink && !order && perms["customers.manage"] === true && typeof deps.api === "function";
  const state = {
    customer: { name: (order ?? prefill)?.customer?.name ?? "", phone: (order ?? prefill)?.customer?.phone ?? "", notes: order?.customer?.notes ?? "" },
    customerId: (order ?? prefill)?.customerId ?? null,
    customerMatches: [],
    saveCustomer: false,
    created: null, // { key, customerId }: a customer this form already saved (a retry reuses it)
    // A source dropdown; the "where" note is asked only for Other. A note on
    // an older order (from the earlier free-text box) is kept as it was.
    source: order?.source ?? "",
    sourceNote: order?.sourceNote ?? "",
    deliveryAddress: (order ?? prefill)?.deliveryAddress ?? "",
    notes: order?.notes ?? "",
    reason: "",
    discountText: order ? (order.discount / 100).toFixed(2) : "0",
    // Open orders hold their quantity in reserve; a fulfilled order holds none.
    lines: (order?.items || []).map((l) => ({ productId: l.productId, sku: l.sku, name: l.name, unit: l.unit, unitPrice: l.unitPrice, special: l.customerPrice === true, quantityText: formatQuantity(l.quantity), reservedHere: correcting ? 0 : l.quantity, available: null })),
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
        for (const l of state.lines) l.available = products[l.productId]?.available ?? null;
        paintLines();
      });
    }

    function parsedLines() {
      return state.lines.map((l) => {
        if (!l.productId) return { ...l, quantity: null, blank: true };
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
            <div class="field"><label for="oeProduct">Add product</label><select class="input" id="oeProduct" name="product" data-role="product-select" disabled><option value="">Loading products…</option></select></div>
            <div class="oe-items-head" aria-hidden="true"><span>Product</span><span>Qty</span><span>Unit price</span><span>Total</span><span></span></div>
            <div class="oe-items" data-role="lines"></div>
            <p class="stat-hint oe-hint" data-role="items-hint" aria-live="polite"></p>
            <button type="button" class="btn btn-compact oe-add-item" data-act="add-item">+ Add Item</button>
          </section>
          <section class="oe-section" data-role="oe-money">
            ${canDiscount ? html`<div class="field oe-discount"><label for="oeDiscount">Discount (${currency})</label><input class="input" id="oeDiscount" name="discount" value="${state.discountText}" inputmode="decimal" autocomplete="off" /></div>` : ""}
            <dl class="dl oe-totals" data-role="totals"></dl>
            <details class="form-more" ${state.notes || correcting ? "open" : ""}><summary>Order notes${correcting ? " and reason" : ""}</summary>
              <div class="field"><label for="oeNotes">Order notes</label><textarea class="input" id="oeNotes" name="notes" rows="2" maxlength="500">${state.notes}</textarea></div>
              ${correcting ? html`<div class="field"><label for="oeReason">Reason for the change</label><textarea class="input" id="oeReason" name="reason" rows="2" maxlength="300" placeholder="e.g. Encoded 10 by mistake, customer ordered 8"></textarea><div class="stat-hint">Needed when quantities, products or the discount change.</div></div>` : ""}
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
      render(
        linkEl,
        html`<p class="oe-linked"><button type="button" class="btn-linklike" data-act="find-customer">Find saved customer</button> · <button type="button" class="btn-linklike" data-act="walk-in">Walk-in / No saved customer</button></p>
          ${canSave ? html`<label class="check oe-save" data-role="save-customer"><input type="checkbox" name="saveCustomer" ${state.saveCustomer ? "checked" : ""} /> <span>Save to Customers <span class="stat-hint">(for their next orders)</span></span></label>` : ""}
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
      if (!state.customerMatches.length) render(linkEl, html`<p class="stat-hint" data-role="no-customer">No saved customer starts with "${term}". It will be saved on the order as a walk-in.</p>`);
    }

    // A row's product choices: every active product (plus the row's own, if
    // it is no longer active, so an older order still shows what it holds).
    const productOptions = (l) => {
      const list = state.products || [];
      const own = l.productId && !list.some((p) => p.id === l.productId) ? [{ id: l.productId, sku: l.sku, name: l.name, sellingPrice: l.unitPrice }] : [];
      return html`<option value="" ${l.productId ? "" : "selected"}>${list.length || own.length ? "Choose a product…" : state.products === null ? "Loading products…" : "No active products yet"}</option>${[...own, ...list].map((p) => html`<option value="${p.id}" ${p.id === l.productId ? "selected" : ""}>${p.name} · ${formatCentavos(state.prices.get(p.id) ?? p.sellingPrice, currency)}${state.prices.has(p.id) ? " (special)" : ""}</option>`)}`;
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
            <span class="oe-item-price" data-col="unitPrice">${l.productId ? html`× ${formatCentavos(l.unitPrice, currency)}${state.lines[i].special ? html` <small class="oe-special" data-role="special-price">special</small>` : ""}` : ""}</span>
            <b class="oe-item-total" data-col="lineSubtotal">${l.quantity ? formatCentavos(computeTotals([l]).subtotal, currency) : "—"}</b>
            <button type="button" class="btn btn-compact btn-ghost oe-item-remove" data-act="remove" data-index="${i}" aria-label="Remove ${l.name || `item ${i + 1}`}">✕</button>
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
      const line = { productId: p.id, sku: p.sku, name: p.name, unit: p.unit, unitPrice: state.prices.get(p.id) ?? p.sellingPrice, special: state.prices.has(p.id), quantityText: i === null ? addQty : state.lines[i].quantityText || "1", reservedHere: state.reservedBy[p.id] || 0, available: p.available ?? null };
      if (i === null) state.lines.push(line);
      else state.lines[i] = line;
      state.hint = "";
      paintLines();
      form.elements[`qty-${i === null ? state.lines.length - 1 : i}`]?.focus();
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
              (p) => html`<option value="${p.id}">${p.sku} · ${p.name} · ${formatCentavos(state.prices.get(p.id) ?? p.sellingPrice, currency)}${state.prices.has(p.id) ? " (special)" : ""} · ${formatQuantity(p.available)} ${UNITS[p.unit]?.label ?? p.unit} left</option>`
            )}`
          : html`<option value="">No active products yet: add them in Inventory</option>`
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
      else if (t.name === "name") state.customer.name = t.value;
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
      if (t.name === "saveCustomer") state.saveCustomer = t.checked;
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
        const c = state.customerMatches.find((r) => r.id === el.dataset.id);
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
          paintLink();
          loadPrices();
        }
      }
      if (act === "unlink") {
        state.customerId = null;
        paintLink();
        loadPrices();
        form.elements.name.focus();
      }
      if (act === "walk-in") {
        state.customer.name = "Walk-in";
        state.customer.phone = "";
        state.saveCustomer = false;
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
      if (act === "add-item") {
        state.lines.push({ productId: null, sku: "", name: "", unit: null, unitPrice: 0, quantityText: "1", reservedHere: 0, available: null });
        state.hint = "";
        paintLines();
        form.elements[`item-${state.lines.length - 1}`]?.focus();
      }
    });

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
        // Save to Customers: the record first (name, contact, delivery
        // address), then the order linked to it. Once per form.
        let customerId = state.customerId;
        if (!customerId && canSave && state.saveCustomer) {
          const name = state.customer.name.trim();
          if (!name || /^walk-?in$/i.test(name)) throw new Error("Type the customer's name to save them to Customers");
          const k = JSON.stringify([name, state.customer.phone.trim(), state.deliveryAddress.trim()]);
          if (state.created?.key !== k) {
            state.busy = true;
            submitBtn.disabled = true;
            const r = await deps.api("customers", { method: "POST", body: { action: "create", customer: { name, ...(state.customer.phone.trim() ? { phone: state.customer.phone.trim() } : {}), ...(state.deliveryAddress.trim() ? { address: state.deliveryAddress.trim() } : {}) } } });
            state.created = { key: k, customerId: r.customerId };
          }
          customerId = state.created.customerId;
        }
        const payload = {
          customer: { name: state.customer.name, phone: state.customer.phone, notes: state.customer.notes },
          ...(customerId ? { customerId } : {}),
          source: state.source,
          // Other needs its note; any other source keeps an older order's note unchanged.
          sourceNote: state.source === "other" || state.source === order?.source ? state.sourceNote : "",
          deliveryAddress: state.deliveryAddress,
          items: p.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
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
