// Inventory = Work (Phase 18.5): "What stock do we have, and what needs
// attention?" One product = one compact row (Luna's operational-table
// standard); phones show a 2-line record with Adjust. Safe fields are edited in place (selling price, reorder level,
// status); stock is never typed over, only changed through Adjust (a signed
// quantity + reason, logged by the server). Everything else lives in
// View details: the full record, receiving, editing, delete-if-unused and
// the paginated movement history.
//
// Permissions:
//   inventory.view     the list and history (quantities)
//   inventory.costs    average cost, value and the cost side of history
//   products.manage    new product, inline price/reorder/status, edit, delete-if-unused
//   inventory.receive  stock receipts
//   inventory.adjust   adjustments and opening balances
// Every write goes to /api/products or /api/inventory, which re-check all
// of this server-side and compute the balances; the screen only asks.

import { html, render } from "../../lib/html.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, mobileCell, openButton, bindRowOpen, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { UNITS, ADJUSTMENT_REASONS, parseQuantity, parseCentavos, formatQuantity } from "@shared/index.js";
import * as defaultData from "./data.js";
import { productRow, historyRow, unitLabel, qty } from "./view.js";

const UNIT_OPTIONS = Object.entries(UNITS).map(([value, u]) => ({ value, label: `${u.label}${u.decimals ? ` (up to ${u.decimals} decimals)` : " (whole numbers)"}` }));
const REASON_OPTIONS = Object.entries(ADJUSTMENT_REASONS).map(([value, label]) => ({ value, label }));
const pesos = (centavos) => (centavos / 100).toFixed(2);

// "-3", "+2.5", "4" -> { type, quantity } for the product's unit.
export function parseAdjustment(text, unit) {
  const t = typeof text === "string" ? text.trim() : "";
  const sign = t.startsWith("-") || t.startsWith("−") ? -1 : 1;
  const magnitude = parseQuantity(t.replace(/^[+\-−]/, ""), unit);
  if (magnitude === 0) throw new Error("Enter a change other than 0");
  return { type: sign < 0 ? "adjustment_decrease" : "adjustment_increase", quantity: magnitude };
}

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast, exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const can = {
    manage: perms["products.manage"] === true,
    receive: perms["inventory.receive"] === true,
    adjust: perms["inventory.adjust"] === true,
    costs: perms["inventory.costs"] === true,
  };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  // The Dashboard links here as ?low=1 (low stock only).
  const lowFromUrl = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("low") === "1";
  const state = { status: "active", lowOnly: lowFromUrl, search: "", category: "", cursors: [], rows: [], costs: {}, hasMore: false, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    state.error = null;
    draw();
    try {
      const page = await data.listProducts(businessId, { status: state.status, lowOnly: state.lowOnly, search: state.search, category: state.category, cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.costs = can.costs ? await data.loadCostDocs(businessId, "productCosts", page.rows.map((r) => r.id)) : {};
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
    const primary = can.adjust ? html`<button type="button" class="btn btn-compact" data-act="${r.hasMovements ? "adjust" : "opening"}" data-id="${r.id}">${r.hasMovements ? "Adjust" : "Starting stock"}</button>` : "";
    const low = r.isLowStock ? html` ${badge("Low stock", "warning")}` : "";
    return html`<tr data-product="${r.id}" class="${r.isLowStock ? "row-warning" : ""}" data-open>
      ${mobileCell({ title: r.name, sub: `${r.sku} · ${r.reserved} set aside · ${r.price}`, end: html`${r.available} <small>${r.unit} left</small>` })}
      <td class="cell-strong">${r.sku}</td>
      <td>${r.name}${low}</td>
      <td class="col-secondary">${r.category}</td>
      <td class="col-secondary">${r.unit}</td>
      <td class="num cell-strong" data-col="available">${r.available}</td>
      <td class="num col-secondary" data-col="onHand">${r.onHand}</td>
      <td class="num col-secondary" data-col="reserved">${r.reserved}</td>
      ${can.costs ? html`<td class="num col-secondary" data-col="avgCost">${r.avgCost}</td><td class="num col-secondary${r.isLoss ? " text-danger" : ""}" data-col="profit">${r.profitPerUnit}</td>` : ""}
      <td class="num col-secondary" data-col="reorder">${editable("edit-reorder", r.id, r.reorderLevel, `Edit reorder level of ${r.name}`)}</td>
      <td class="num" data-col="price">${editable("edit-price", r.id, r.price, `Edit selling price of ${r.name}`)}</td>
      <td data-col="status">${statusCell}</td>
      <td class="row-actions" data-m="ctl">${primary}</td>
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
          end: mayExport(session, "inventory") ? html`<span class="visually-hidden" data-role="export-hint">${exportHint}</span>${exportButton("products", "Product list (Excel)")}${exportButton("inventory", "Stock levels (Excel)")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(6)
              : !rows.length
                ? emptyState({ iconName: "inventory", title: "No products", body: state.search ? "Nothing matches that search." : can.manage ? "Add your first product to start tracking stock." : "Products added by your team appear here." })
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
      title: `Selling price: ${p.name}`,
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

  // ---- stock ----
  async function adjust(p) {
    const ok = await formDialog({
      title: `Adjust ${p.name}`,
      intro: `Current: ${qty(p.onHand, p.unit)} on hand (${qty(p.available, p.unit)} available). Increases use the current average cost; decreases leave it unchanged.`,
      fields: [
        { name: "change", label: `Adjustment (${unitLabel(p.unit)}), e.g. -3 or +2`, required: true, inputmode: "decimal" },
        { name: "reason", label: "Reason", type: "select", options: REASON_OPTIONS, required: true },
        { name: "note", label: "Note", type: "textarea", hint: "Required when the reason is Other." },
      ],
      submitLabel: "Save",
      onSubmit: (v) => {
        const { type, quantity } = parseAdjustment(v.change, p.unit);
        return send("inventory", { action: type, productId: p.id, quantity, reason: v.reason, ...(v.note ? { note: v.note } : {}) });
      },
    });
    if (ok) await done("Inventory adjusted");
  }

  async function stockIn(kind, p) {
    const ok = await formDialog({
      title: kind === "receipt" ? `Receive ${p.name}` : `Starting stock: ${p.name}`,
      intro: kind === "opening" ? "Only possible before any other movement. Sets the starting stock and average cost." : "Updates the moving average cost.",
      fields: [
        { name: "quantity", label: `Quantity (${unitLabel(p.unit)})`, required: true, inputmode: "decimal" },
        { name: "unitCost", label: `Unit cost (${currency})`, required: true, inputmode: "decimal" },
        { name: "reference", label: kind === "receipt" ? "Reference (DR / invoice no.)" : "Reference" },
        { name: "note", label: "Note", type: "textarea", hint: kind === "opening" ? "A reference or a note is required (e.g. the stock count it comes from)." : "" },
      ],
      submitLabel: kind === "receipt" ? "Receive" : "Record",
      onSubmit: (v) => {
        const body = { action: kind, productId: p.id, quantity: parseQuantity(v.quantity, p.unit), unitCost: parseCentavos(v.unitCost) };
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
      { name: "sellingPrice", label: `Selling price (${currency})`, value: p ? pesos(p.sellingPrice) : "", required: true, inputmode: "decimal" },
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

  // ---- View details: full record, actions, paginated history ----
  async function openDetails(p) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const r = productRow(p, state.costs[p.id], { seesCosts: can.costs, currency });
    const rows = [];
    let hasMore = false;
    let error = null;
    const close = () => backdrop.remove();
    const paint = () =>
      render(
        backdrop,
        html`<div role="dialog" aria-modal="true" aria-label="Details for ${p.name}" class="modal modal-wide" data-role="details">
          <div class="modal-header"><h2 class="card-title">${p.sku} · ${p.name}</h2></div>
          <div class="modal-body">
            <dl class="dl dl-compact">
              <dt>Category</dt><dd>${r.category}</dd><dt>Unit</dt><dd>${r.unit}</dd>
              <dt>Stock left</dt><dd><strong>${r.available}</strong> to sell</dd><dt>In stock</dt><dd>${r.onHand}</dd><dt>Set aside for orders</dt><dd>${r.reserved}</dd>
              <dt>Reorder at</dt><dd>${r.reorderLevel}</dd><dt>Selling price</dt><dd>${r.price}</dd><dt>Status</dt><dd>${r.status}</dd>
              ${can.costs ? html`<dt>Cost (average)</dt><dd>${r.avgCost}</dd><dt>Profit per unit (est.)</dt><dd data-role="profit">${r.profitPerUnit}${r.margin !== "—" ? ` · ${r.margin} of the price` : ""}</dd><dt>Stock value (est.)</dt><dd>${r.value}</dd>` : ""}
              <dt>Movements</dt><dd>${p.movementCount || 0}</dd>
            </dl>
            ${can.costs ? html`<p class="stat-hint" data-role="cost-method">Cost is the average of what you paid for the stock you have; each delivery you receive updates it. Orders keep the cost from the day they were fulfilled, so past profit never changes. The Cost column below is your cost history.</p>` : ""}
            <h3 class="section-title">History</h3>
            <div data-role="history">
              ${error ? html`<p class="form-error">${error}</p>` : ""}
              ${!rows.length && !error ? emptyState({ title: "No movements yet" }) : ""}
              ${rows.length
                ? html`<div class="table-wrap"><table class="table table-compact"><thead><tr><th>Movement</th><th>When</th><th>By</th><th>Stock after</th><th>Reason / reference</th>${can.costs ? html`<th>Cost</th>` : ""}</tr></thead>
                    <tbody>${rows.map(
                      (h) => html`<tr data-tx="${h.id}"><td><strong>${h.label}</strong></td><td>${h.when}</td><td>${h.actor}</td><td>${h.balance}</td>
                        <td>${[h.reason, h.note, h.reference && `Ref ${h.reference}`].filter(Boolean).join(" · ")}</td>${can.costs ? html`<td data-col="cost">${h.cost || ""}</td>` : ""}</tr>`
                    )}</tbody></table></div>`
                : ""}
            </div>
          </div>
          <div class="modal-footer">
            ${hasMore ? html`<button type="button" class="btn" data-act="more">Load more</button>` : ""}
            ${can.receive && p.status === "active" ? html`<button type="button" class="btn" data-act="d-receipt">Receive</button>` : ""}
            ${can.adjust && !(p.movementCount > 0) ? html`<button type="button" class="btn" data-act="d-opening">Starting stock</button>` : ""}
            ${can.adjust && p.movementCount > 0 ? html`<button type="button" class="btn" data-act="d-adjust">Adjust</button>` : ""}
            ${can.manage ? html`<button type="button" class="btn" data-act="d-edit">Edit product</button>` : ""}
            ${can.manage && !(p.movementCount > 0) ? html`<button type="button" class="btn btn-danger" data-act="d-delete">Delete</button>` : ""}
            <button type="button" class="btn btn-primary" data-act="close">Close</button>
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
      paint();
    }
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
    await more();
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
