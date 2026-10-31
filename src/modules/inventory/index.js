// Inventory = Work (Phase 18.5): "What stock do we have, and what needs
// attention?" One product = one compact row (Luna's operational-table
// standard); phones show a 2-line record with Adjust. Safe fields are edited in place (selling price, reorder level,
// status); stock is never typed over, only changed through Adjust (a signed
// quantity + reason, logged by the server). Everything else lives in
// View details: the essentials (stock left, category, unit, price), Receive,
// Adjust, Edit product, delete-if-unused and the folded movement history.
//
// Permissions:
//   inventory.view     the list and history (quantities)
//   inventory.costs    average cost, value and the cost side of history
//   products.manage    new product, inline price/reorder/status, edit, delete-if-unused
//   inventory.receive  stock receipts
//   inventory.adjust   adjustments and opening balances
// Every write goes to /api/products or /api/inventory, which re-check all
// of this server-side and compute the balances; the screen only asks.
//
// Show on Menu (2026-10-26, with Orders): one tap per active product, ON =
// customers can order it from the store link today (it still needs stock
// left). It isn't stock and it isn't Active: OFF keeps the product, its
// stock, costs and history. Saved through /api/storefront (products.manage).

import { html, render } from "../../lib/html.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { UNITS, ADJUSTMENT_REASONS, parseQuantity, parseCentavos, parseCost, formatQuantity, isModuleEnabled, snapshotWorkspaceTemplateId } from "@shared/index.js";
import * as defaultData from "./data.js";
import { productRow, historyRow, unitLabel, qty } from "./view.js";

const UNIT_OPTIONS = Object.entries(UNITS).map(([value, u]) => ({ value, label: `${u.label}${u.decimals ? ` (up to ${u.decimals} decimals)` : " (whole numbers)"}` }));
const REASON_OPTIONS = Object.entries(ADJUSTMENT_REASONS).map(([value, label]) => ({ value, label }));
const pesos = (centavos) => (centavos / 100).toFixed(2);
// One request key per stock dialog: Save tapped twice, or sent again after a
// slow network, changes stock once (the server keeps one movement).
const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

// Stock count (2026-10-22): the stock on hand the user counted, as a scaled
// quantity for the product's unit (0 or more; the unit's decimals).
export function parseStockOnHand(text, unit) {
  const t = typeof text === "string" ? text.trim().replace(/,/g, "") : "";
  if (!t) throw new Error("Enter the stock on hand");
  if (/^[-−]/.test(t)) throw new Error("Stock on hand can't be less than 0");
  try {
    return parseQuantity(t, unit);
  } catch (err) {
    throw new Error(UNITS[unit]?.decimals ? `Enter a number with up to ${UNITS[unit].decimals} decimal places, e.g. 12.5` : `Enter a whole number of ${unitLabel(unit)}, e.g. 47`);
  }
}
// "Current: 50 pcs · New: 47 pcs · Change: −3 pcs" (display only; the server
// works out the real change from the stock it reads when saving).
export function countPreview(current, text, unit) {
  let next;
  try {
    next = parseStockOnHand(text, unit);
  } catch {
    return "";
  }
  const d = next - current;
  return `Current: ${qty(current, unit)} · New: ${qty(next, unit)} · Change: ${d === 0 ? "none" : `${d > 0 ? "+" : "−"}${qty(Math.abs(d), unit)}`}`;
}

// What an empty Products page shows (examples only: no stock, no movements).
export const PRODUCT_EXAMPLES = Object.freeze([
  { name: "Chicken Siomai", sub: "SIO-001 · ₱55 each", end: "Available 24" },
  { name: "Pork Tocino", sub: "TOC-001 · ₱120 each", end: "Available 8 · Low stock" },
  { name: "Beef Tapa", sub: "TAP-001 · ₱145 each", end: "Out of stock" },
]);

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast, exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const can = {
    manage: perms["products.manage"] === true,
    receive: perms["inventory.receive"] === true,
    adjust: perms["inventory.adjust"] === true,
    costs: perms["inventory.costs"] === true,
  };
  const businessId = session.business.id;
  // Reseller Package (2026-10-31): the product's price is the Owner/Base
  // Price (what the business expects for one unit; resellers sell above it).
  const priceName = snapshotWorkspaceTemplateId(session.entitlements) === "reseller" ? "Owner/Base Price" : "Selling price";
  const currency = session.business.currency || "PHP";
  // The Dashboard links here as ?low=1 (low stock only).
  const lowFromUrl = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("low") === "1";
  const state = { status: "active", lowOnly: lowFromUrl, search: "", category: "", cursors: [], rows: [], costs: {}, hasMore: false, loading: true, error: null, menuHidden: null };
  let alive = true;
  // Show on Menu: only where there's a store link (the Orders module).
  const menuApplies = isModuleEnabled(session.entitlements, "orders");
  const loadMenu = () =>
    menuApplies && state.menuHidden === null
      ? api("storefront", { method: "POST", body: { action: "menu" } }).then((r) => (state.menuHidden = new Set(r.hiddenProductIds || [])), () => null)
      : null;

  const unfiltered = () => !state.search && !state.lowOnly && state.status !== "inactive" && !state.category && !state.cursors.length;
  async function load() {
    state.loading = true;
    state.error = null;
    draw();
    try {
      const [page] = await Promise.all([data.listProducts(businessId, { status: state.status, lowOnly: state.lowOnly, search: state.search, category: state.category, cursor: state.cursors.at(-1) || null }), loadMenu()]);
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.costs = can.costs ? await data.loadCostDocs(businessId, "productCosts", page.rows.map((r) => r.id)) : {};
      // No active products and no filter: examples, unless inactive products exist.
      state.others = page.rows.length || unfiltered() === false ? null : await data.listProducts(businessId, { status: "inactive", pageSize: 1 }).then((p) => p.rows.length > 0, () => true);
    } catch (err) {
      console.error("inventory: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load products. Check your connection and try again.";
    }
    state.loading = false;
    if (alive) draw();
  }

  const editable = (act, id, text, label) =>
    can.manage ? html`<button type="button" class="cell-edit" data-act="${act}" data-id="${id}" aria-label="${label}" title="${label}">${text}</button>` : text;

  function rowCells({ product: p, row: r }) {
    const statusCell = can.manage
      ? html`<select class="select select-compact" data-act="status" data-id="${r.id}" aria-label="Status of ${r.name}">
          <option value="active" ${p.status === "active" ? "selected" : ""}>Active</option>
          <option value="inactive" ${p.status === "inactive" ? "selected" : ""}>Inactive</option>
        </select>`
      : r.status === "active" ? badge("Active", "success") : badge("Inactive", "neutral");
    const onMenu = state.menuHidden && p.status === "active" ? !state.menuHidden.has(r.id) : null;
    const menuSwitch =
      onMenu === null
        ? ""
        : html`<span class="menu-toggle" data-role="menu-toggle"><span class="menu-toggle-label">Menu</span>${can.manage ? html`<button type="button" class="menu-switch" role="switch" aria-checked="${onMenu}" data-act="menu" data-id="${r.id}" aria-label="Show ${r.name} on menu">${onMenu ? "ON" : "OFF"}</button>` : html`<b class="menu-state">${onMenu ? "ON" : "OFF"}</b>`}</span>`;
    const primary = can.adjust ? html`<button type="button" class="btn btn-compact" data-act="${r.hasMovements ? "adjust" : "opening"}" data-id="${r.id}">${r.hasMovements ? "Update stock" : "Starting stock"}</button>` : "";
    const low = r.isLowStock ? html` ${badge("Low stock", "warning")}` : "";
    return html`<tr data-product="${r.id}" class="${r.isLowStock ? "row-warning" : ""}" data-open>
      ${mobileCell({ title: r.name, sub: `${r.sku} · ${r.reserved} set aside · ${r.price}`, end: html`${r.available} <small>${r.unit} left</small>` })}
      <td class="cell-strong">${r.sku}</td>
      <td>${r.name}${low}${menuSwitch ? html`<div class="menu-toggle-d">${menuSwitch}</div>` : ""}</td>
      <td class="col-secondary">${r.category}</td>
      <td class="col-secondary">${r.unit}</td>
      <td class="num cell-strong" data-col="available">${r.available}</td>
      <td class="num col-secondary" data-col="onHand">${r.onHand}</td>
      <td class="num col-secondary" data-col="reserved">${r.reserved}</td>
      ${can.costs ? html`<td class="num col-secondary" data-col="avgCost">${r.avgCost}</td><td class="num col-secondary${r.isLoss ? " text-danger" : ""}" data-col="profit">${r.profitPerUnit}</td>` : ""}
      <td class="num col-secondary" data-col="reorder">${editable("edit-reorder", r.id, r.reorderLevel, `Edit reorder level of ${r.name}`)}</td>
      <td class="num" data-col="price">${editable("edit-price", r.id, r.price, `Edit selling price of ${r.name}`)}</td>
      <td data-col="status">${statusCell}</td>
      <td class="row-actions" data-m="ctl">${menuSwitch ? html`<span class="menu-toggle-m">${menuSwitch}</span>` : ""}${primary}</td>
      <td class="row-actions" data-m="more">${openButton(r.id, `View details of ${r.name}`, { act: "details" })}</td>
    </tr>`;
  }

  function draw() {
    if (!alive) return;
    const rows = state.rows.map((p) => ({ product: p, row: productRow(p, state.costs[p.id], { seesCosts: can.costs, currency }) }));
    render(
      container,
      html`
        ${pageHeader({
          title: "Inventory",
          subtitle: "Stock left to sell, and what's running low. Stock left = in stock − set aside for open orders.",
          actions: can.manage ? html`<button type="button" class="btn btn-primary" data-act="new">+ New product</button>` : "",
        })}
        ${filterBar({
          fields: [
            { name: "search", label: "Search name or exact SKU", type: "search", primary: true, value: state.search },
            { name: "low", label: "Stock", type: "select", primary: true, all: "All stock levels", options: [["low", "Low stock only"]], value: state.lowOnly ? "low" : "" },
            { name: "status", label: "Status", type: "select", all: "Active products", options: [["inactive", "Inactive products"]], value: state.status === "inactive" ? "inactive" : "" },
            { name: "category", label: "Category (exact)", type: "search", value: state.category },
          ],
          end: "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(6)
              : !rows.length
                ? !unfiltered() || state.others !== false
                  ? emptyState({ iconName: "inventory", title: "No products", body: "Nothing matches that search." })
                  : examplesState({ title: "No products yet", body: "Each product, with the stock you have left:", items: PRODUCT_EXAMPLES, helper: can.manage ? "Tap + New product to add your first one and its starting stock." : "Products added by your team appear here.", role: "product-examples", wrap: true })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="products">
                    <thead><tr>
                      <th class="m-only"></th><th>SKU</th><th>Product</th><th class="col-secondary">Category</th><th class="col-secondary">Unit</th>
                      <th class="num" title="In stock minus what's set aside for open orders">Stock left</th><th class="num col-secondary" title="Everything on your shelves">In stock</th><th class="num col-secondary" title="Held for open orders until they're fulfilled or cancelled">Set aside</th>
                      ${can.costs ? html`<th class="num col-secondary" title="Average cost of the stock you have">Cost (avg)</th><th class="num col-secondary" title="Selling price minus average cost (estimate)">Profit / unit</th>` : ""}
                      <th class="num col-secondary">Reorder at</th><th class="num">Price</th><th>Status</th><th><span class="visually-hidden">Actions</span></th><th><span class="visually-hidden">Details</span></th>
                    </tr></thead>
                    <tbody>${rows.map(rowCells)}</tbody>
                  </table></div>
                  <div class="pager">
                    <button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button>
                    <button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button>
                  </div>`}
        </section>
      `
    );
  }

  const find = (id) => state.rows.find((p) => p.id === id);
  const done = (message) => {
    toast(message, "success");
    return load();
  };
  // API errors carry safe messages; rethrow so the dialog shows them.
  const send = async (path, body) => {
    try {
      return await api(path, { method: "POST", body });
    } catch (err) {
      throw new Error(err.message || "Request failed.");
    }
  };
  const updateProduct = (p, changes) => send("products", { action: "update", productId: p.id, changes });

  // ---- inline edits ----
  async function editPrice(p) {
    const ok = await formDialog({
      title: `${priceName}: ${p.name}`,
      fields: [{ name: "price", label: `Price (${currency})`, value: pesos(p.sellingPrice), inputmode: "decimal", required: true }],
      submitLabel: "Save",
      onSubmit: (v) => updateProduct(p, { sellingPrice: parseCentavos(v.price) }),
    });
    if (ok) await done("Price updated");
  }

  async function editReorder(p) {
    const ok = await formDialog({
      title: `Reorder level: ${p.name}`,
      intro: "Low stock when available is at or below this.",
      fields: [{ name: "reorder", label: `Reorder level (${unitLabel(p.unit)})`, value: formatQuantity(p.reorderLevel), inputmode: "decimal", required: true }],
      submitLabel: "Save",
      onSubmit: (v) => updateProduct(p, { reorderLevel: parseQuantity(v.reorder, p.unit) }),
    });
    if (ok) await done("Reorder level updated");
  }

  async function setStatus(p, status, selectEl) {
    if (status === p.status) return;
    try {
      await send("products", { action: "setStatus", productId: p.id, status });
      await done(status === "active" ? "Product activated" : "Product deactivated");
    } catch (err) {
      if (selectEl) selectEl.value = p.status;
      toast(err.message, "danger");
    }
  }

  // Show on Menu ON / OFF: flips at once, saved in the background (put back
  // if the server refuses).
  async function toggleMenu(p) {
    if (!p || !state.menuHidden || !can.manage) return;
    const show = state.menuHidden.has(p.id);
    const apply = (on) => {
      if (on) state.menuHidden.delete(p.id);
      else state.menuHidden.add(p.id);
      draw();
    };
    apply(show);
    try {
      await api("storefront", { method: "POST", body: { action: "showOnMenu", productId: p.id, show } });
      toast(show ? `${p.name} is on the menu` : `${p.name} is off the menu`, "success");
    } catch (err) {
      apply(!show);
      toast(err.message || "Couldn't change the menu", "danger");
    }
  }

  // ---- stock ----
  // Update stock (2026-10-22): count, enter the number, save. The server
  // turns the count into the adjustment (count − on hand) in its own
  // transaction; nobody works out a + or − here.
  async function adjust(p) {
    const idempotencyKey = newKey();
    const ok = await formDialog({
      title: `Update stock: ${p.name}`,
      intro: `Current stock: ${qty(p.onHand, p.unit)}${p.reserved ? ` (${qty(p.reserved, p.unit)} set aside for orders)` : ""}.`,
      fields: [
        { name: "onHand", label: `Stock on hand (${unitLabel(p.unit)})`, required: true, inputmode: UNITS[p.unit]?.decimals ? "decimal" : "numeric", hint: "Enter the quantity you have now. Luna will update the inventory based on this number." },
        { name: "reason", label: "Reason", type: "select", options: REASON_OPTIONS, value: "count_correction", required: true },
        { name: "note", label: "Note", type: "textarea", hint: "Required when the reason is Other." },
      ],
      submitLabel: "Save",
      onFormChange: (form) => {
        const input = form.elements.onHand;
        if (input.dataset.preview) return;
        input.dataset.preview = "1";
        const out = document.createElement("div");
        out.className = "stat-hint count-preview";
        out.dataset.role = "count-preview";
        input.closest(".field").appendChild(out);
        input.addEventListener("input", () => (out.textContent = countPreview(p.onHand, input.value, p.unit)));
      },
      onSubmit: (v) => {
        const onHand = parseStockOnHand(v.onHand, p.unit);
        if (onHand === p.onHand) throw new Error(`Stock on hand is already ${qty(onHand, p.unit)}. Nothing to change.`);
        if (onHand < (p.reserved || 0)) throw new Error(`${qty(p.reserved, p.unit)} are set aside for open orders, so stock on hand can't be less than that`);
        if (v.reason === "other" && !v.note.trim()) throw new Error("Explain the change in the note (Reason: Other)");
        return send("inventory", { action: "count", idempotencyKey, productId: p.id, onHand, reason: v.reason, ...(v.note ? { note: v.note } : {}) });
      },
    });
    if (ok) await done(`Stock updated: ${qty(ok.balance?.onHand ?? 0, p.unit)}`);
  }

  // Starting stock / Receive (2026-10-22): the quantity and the Cost per
  // unit; Reference and Note are optional, under More details (Luna records
  // who and when anyway). The cost per unit is the product's cost basis:
  // starting stock sets it, a delivery averages into it; fulfilled orders'
  // COGS, Reports and the Costs page all use that same one figure.
  async function stockIn(kind, p) {
    const idempotencyKey = newKey();
    const ok = await formDialog({
      title: kind === "receipt" ? `Receive ${p.name}` : `Starting stock: ${p.name}`,
      intro: kind === "opening" ? "What you have now and what one unit cost you. Only before any other stock movement." : "",
      fields: [
        { name: "quantity", label: kind === "receipt" ? `Quantity received (${unitLabel(p.unit)})` : `Starting stock (${unitLabel(p.unit)})`, required: true, inputmode: UNITS[p.unit]?.decimals ? "decimal" : "numeric" },
        { name: "unitCost", label: `Cost per unit (${currency})`, required: true, inputmode: "decimal", hint: "What one unit costs you. Luna uses this to calculate COGS and profit." },
        { name: "reference", label: kind === "receipt" ? "Reference (DR / invoice no.)" : "Reference", more: true },
        { name: "note", label: "Note", type: "textarea", more: true },
      ],
      moreLabel: "More details",
      submitLabel: kind === "receipt" ? "Receive" : "Record",
      onSubmit: (v) => {
        const body = { action: kind, idempotencyKey, productId: p.id, quantity: parseQuantity(v.quantity, p.unit), unitCost: parseCost(v.unitCost) };
        if (v.reference) body.reference = v.reference;
        if (v.note) body.note = v.note;
        return send("inventory", body);
      },
    });
    if (ok) await done(kind === "receipt" ? "Stock received" : "Starting stock recorded");
  }

  // ---- product master ----
  function productFields(p = null) {
    return [
      { name: "sku", label: "SKU", value: p ? p.sku : "", required: true, hint: "Unique in your business. Letters, digits, . - _" },
      { name: "name", label: "Product name", value: p ? p.name : "", required: true },
      { name: "category", label: "Category", value: p ? p.category : "" },
      { name: "unit", label: "Unit", type: "select", options: UNIT_OPTIONS, value: p ? p.unit : "pcs", disabled: Boolean(p && p.movementCount > 0), hint: p && p.movementCount > 0 ? "Locked once stock has moved." : "" },
      { name: "sellingPrice", label: `${priceName} (${currency})`, value: p ? pesos(p.sellingPrice) : "", required: true, inputmode: "decimal", ...(priceName === "Selling price" ? {} : { hint: "What the business expects for one unit. Resellers set their own selling price above it." }) },
      { name: "reorderLevel", label: "Reorder level", value: p ? formatQuantity(p.reorderLevel) : "0", inputmode: "decimal", hint: "Shows Low stock when stock left is at or below this." },
    ];
  }

  async function openProduct(p = null) {
    const result = await formDialog({
      title: p ? `Edit ${p.name}` : "New product",
      fields: productFields(p),
      submitLabel: p ? "Save" : "Create product",
      onSubmit: (v) => {
        const locked = p && p.movementCount > 0;
        const unit = locked ? p.unit : v.unit;
        const product = { sku: v.sku, name: v.name, category: v.category, unit, sellingPrice: parseCentavos(v.sellingPrice), reorderLevel: parseQuantity(v.reorderLevel || "0", unit) };
        if (locked) delete product.unit;
        return send("products", p ? { action: "update", productId: p.id, changes: product } : { action: "create", product });
      },
    });
    if (result) await done(p ? "Product updated" : "Product created");
  }

  // ---- View details (Owner pilot): SKU · Name, Category, Unit, Stock left,
  // Selling price; Receive / Adjust / Edit product, Close quiet. The full
  // record (in stock, set aside, costs) stays in the data and the export;
  // the movement history is folded and read only when opened.
  async function openDetails(p) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const r = productRow(p, state.costs[p.id], { seesCosts: can.costs, currency });
    const rows = [];
    let hasMore = false;
    let error = null;
    let loaded = false;
    let historyOpen = false;
    const close = () => backdrop.remove();
    const field = (k, v, role = "") => html`<div class="pd-field"${role ? html` data-role="${role}"` : ""}><dt>${k}</dt><dd>${v}</dd></div>`;
    const paint = () =>
      render(
        backdrop,
        html`<div role="dialog" aria-modal="true" aria-label="Details for ${p.name}" class="modal pd" data-role="details">
          <div class="modal-header"><h2 class="card-title pd-title">${p.sku} · ${p.name}</h2>${p.status === "active" ? "" : html`<p class="pd-flag">${badge("Inactive", "neutral")}</p>`}</div>
          <div class="modal-body">
            <div class="pd-stock" data-role="stock-left"><span>Stock left</span><b>${r.available} ${r.unit}</b></div>
            <dl class="pd-fields">
              ${field("Category", r.category)}${field("Unit", r.unit)}
              ${p.sellingPrice > 0 ? field(priceName, r.price, "price") : ""}
            </dl>
            <details class="dd-fold dd-quiet" data-role="fold-history" ${historyOpen ? "open" : ""}><summary><span class="dd-when-closed">View stock history</span><span class="dd-when-open">Hide stock history</span></summary>
              <div data-role="history">
                ${error ? html`<p class="form-error">${error}</p>` : ""}
                ${!loaded && !error ? html`<p class="stat-hint">Loading…</p>` : ""}
                ${loaded && !rows.length && !error ? html`<p class="stat-hint">No movements yet.</p>` : ""}
                ${rows.length
                  ? html`<ul class="dd-lines">${rows.map(
                      (h) => html`<li class="dd-line" data-tx="${h.id}"><span class="dd-date"><b>${h.label}</b></span><span class="dd-amt">${h.when.replace(/,? \d{1,2}:\d{2}.*$/, "")}</span>
                        <span class="dd-line-sub">${[h.actor !== "—" ? h.actor : "", h.reason, h.note, h.reference && `Ref ${h.reference}`].filter(Boolean).join(" · ")}${can.costs && h.cost ? html`<span data-col="cost"> · ${h.cost}</span>` : ""}</span></li>`
                    )}</ul>`
                  : ""}
                ${hasMore ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="more">Load more</button>` : ""}
              </div>
            </details>
          </div>
          <div class="modal-footer">
            ${can.receive && p.status === "active" ? html`<button type="button" class="btn" data-act="d-receipt">Receive</button>` : ""}
            ${can.adjust && !(p.movementCount > 0) ? html`<button type="button" class="btn" data-act="d-opening">Starting stock</button>` : ""}
            ${can.adjust && p.movementCount > 0 ? html`<button type="button" class="btn" data-act="d-adjust">Update stock</button>` : ""}
            ${can.manage ? html`<button type="button" class="btn" data-act="d-edit">Edit product</button>` : ""}
            ${can.manage && !(p.movementCount > 0) ? html`<button type="button" class="btn btn-danger-ghost" data-act="d-delete">Delete</button>` : ""}
            <button type="button" class="btn btn-ghost" data-act="close">Close</button>
          </div>
        </div>`
      );
    async function more() {
      try {
        const page = await data.listHistory(businessId, p.id, { beforeSeq: rows.length ? rows.at(-1).seq : null });
        const costs = can.costs ? await data.loadCostDocs(businessId, "inventoryTransactionCosts", page.rows.map((t) => t.id)) : {};
        rows.push(...page.rows.map((t) => historyRow(t, costs[t.id], { seesCosts: can.costs, currency })));
        hasMore = page.hasMore;
      } catch (err) {
        console.error("inventory: history failed:", err && (err.code || err.message));
        error = "Couldn't load history.";
      }
      loaded = true;
      paint();
    }
    backdrop.addEventListener(
      "toggle",
      (event) => {
        if (!event.target.matches?.('[data-role="fold-history"]')) return;
        historyOpen = event.target.open;
        if (historyOpen && !loaded && !error) more();
      },
      true
    );
    backdrop.addEventListener("click", async (event) => {
      const act = event.target.closest("[data-act]")?.dataset.act;
      if (event.target === backdrop || act === "close") return close();
      if (act === "more") return more();
      const next = { "d-receipt": () => stockIn("receipt", p), "d-opening": () => stockIn("opening", p), "d-adjust": () => adjust(p), "d-edit": () => openProduct(p) }[act];
      if (next) {
        close();
        return next();
      }
      if (act === "d-delete") {
        const yes = await confirmDialog({ title: `Delete ${p.name}?`, body: "Only products that never had stock can be deleted. This can't be undone.", confirmLabel: "Delete", danger: true });
        if (!yes) return;
        try {
          await send("products", { action: "delete", productId: p.id });
          close();
          await done("Product deleted");
        } catch (err) {
          toast(err.message, "danger");
        }
      }
    });
    paint();
  }

  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.tagName === "SELECT") return;
    const p = el.dataset.id ? find(el.dataset.id) : null;
    switch (el.dataset.act) {
      case "new":
        return openProduct();
      case "edit-price":
        return editPrice(p);
      case "edit-reorder":
        return editReorder(p);
      case "adjust":
        return adjust(p);
      case "opening":
        return stockIn("opening", p);
      case "details":
        return openDetails(p);
      case "menu":
        return toggleMenu(p);
      case "next":
        state.cursors.push(state.rows.at(-1));
        return load();
      case "prev":
        state.cursors.pop();
        return load();
      default:
        return undefined;
    }
  };
  const onChange = (event) => {
    const el = event.target;
    if (el.dataset.act === "status") setStatus(find(el.dataset.id), el.value, el);
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const form = event.target;
    state.search = form.elements.search.value;
    state.status = form.elements.status.value || "active";
    state.lowOnly = form.elements.low.value === "low";
    state.category = form.elements.category.value.trim();
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "details" });
  // Both downloads use the APPLIED filters (what the list shows), every page.
  const unbindExport = bindExport(container, () => Object.fromEntries([["status", state.status], ["lowOnly", state.lowOnly], ["search", state.search.trim()], ["category", state.category]].filter(([, v]) => v)), { toast, deps: exportDeps });
  load();

  return () => {
    alive = false;
    unbindExport();
    unbindFilters();
    unbindRows();
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
  };
}
