// Inventory: products, balances, receipts, adjustments, opening balances
// and paginated movement history. What each member sees and can do comes
// from their permissions:
//   inventory.view     the list and history (quantities)
//   inventory.costs    average cost, value and the cost side of history
//   products.manage    create / edit / deactivate / delete-if-unused
//   inventory.receive  stock receipts
//   inventory.adjust   adjustments and opening balances
// Every write goes to /api/products or /api/inventory, which re-check all
// of this server-side and compute the balances; the screen only asks.

import { html, render } from "../../lib/html.js";
import { pageHeader, card, emptyState, badge } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { UNITS, ADJUSTMENT_REASONS, parseQuantity, parseCentavos, formatQuantity } from "@shared/index.js";
import * as defaultData from "./data.js";
import { productRow, historyRow, unitLabel } from "./view.js";

const UNIT_OPTIONS = Object.entries(UNITS).map(([value, u]) => ({ value, label: `${u.label}${u.decimals ? ` (up to ${u.decimals} decimals)` : " (whole numbers)"}` }));
const REASON_OPTIONS = Object.entries(ADJUSTMENT_REASONS).map(([value, label]) => ({ value, label }));
const pesos = (centavos) => (centavos / 100).toFixed(2);

export function mount(container, session, { data = defaultData, api = defaultApi, toast = defaultToast } = {}) {
  const perms = session.member.permissions;
  const can = {
    manage: perms["products.manage"] === true,
    receive: perms["inventory.receive"] === true,
    adjust: perms["inventory.adjust"] === true,
    costs: perms["inventory.costs"] === true,
  };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const state = { status: "active", lowOnly: false, search: "", cursors: [], rows: [], costs: {}, hasMore: false, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    state.error = null;
    draw();
    try {
      const page = await data.listProducts(businessId, { status: state.status, lowOnly: state.lowOnly, search: state.search, cursor: state.cursors.at(-1) || null });
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

  function rowActions(r, product) {
    const buttons = [html`<button type="button" class="btn" data-act="history" data-id="${r.id}">History</button>`];
    if (can.receive && product.status === "active") buttons.push(html`<button type="button" class="btn" data-act="receipt" data-id="${r.id}">Receive</button>`);
    if (can.adjust && !r.hasMovements) buttons.push(html`<button type="button" class="btn" data-act="opening" data-id="${r.id}">Opening</button>`);
    if (can.adjust && r.hasMovements) buttons.push(html`<button type="button" class="btn" data-act="adjust" data-id="${r.id}">Adjust</button>`);
    if (can.manage) {
      buttons.push(html`<button type="button" class="btn" data-act="edit" data-id="${r.id}">Edit</button>`);
      buttons.push(html`<button type="button" class="btn" data-act="status" data-id="${r.id}">${product.status === "active" ? "Deactivate" : "Activate"}</button>`);
    }
    return buttons;
  }

  function draw() {
    if (!alive) return;
    const rows = state.rows.map((p) => ({ product: p, row: productRow(p, state.costs[p.id], { seesCosts: can.costs, currency }) }));
    render(
      container,
      html`
        ${pageHeader({
          title: "Inventory",
          subtitle: "Products, stock on hand, reservations and movements.",
          actions: can.manage ? html`<button type="button" class="btn btn-primary" data-act="new">New product</button>` : "",
        })}
        <form class="section card filters" data-role="filters">
          <div class="stat-grid">
            <div class="field"><label for="invSearch">Search name or exact SKU</label><input class="input" id="invSearch" name="search" value="${state.search}" autocomplete="off" /></div>
            <div class="field"><label for="invStatus">Status</label>
              <select class="select" id="invStatus" name="status">
                <option value="active" ${state.status === "active" ? "selected" : ""}>Active</option>
                <option value="inactive" ${state.status === "inactive" ? "selected" : ""}>Inactive</option>
              </select></div>
            <div class="field"><label for="invLow">Show</label>
              <select class="select" id="invLow" name="low">
                <option value="all" ${state.lowOnly ? "" : "selected"}>All products</option>
                <option value="low" ${state.lowOnly ? "selected" : ""}>Low stock only</option>
              </select></div>
            <div class="field"><label>&nbsp;</label><button type="submit" class="btn">Apply</button></div>
          </div>
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !rows.length
                ? emptyState({ iconName: "inventory", title: "No products", body: state.search ? "Nothing matches that search." : can.manage ? "Add your first product to start tracking stock." : "Products added by your team appear here." })
                : html`<div class="table-wrap"><table class="table" data-role="products">
                    <thead><tr>
                      <th>SKU</th><th>Product</th><th>Category</th><th>Unit</th>
                      <th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th>
                      ${can.costs ? html`<th class="num">Avg cost</th><th class="num">Value (est.)</th>` : ""}
                      <th class="num">Price</th><th class="num">Reorder at</th><th>Status</th><th></th>
                    </tr></thead>
                    <tbody>
                      ${rows.map(
                        ({ product, row: r }) => html`<tr data-product="${r.id}">
                          <td>${r.sku}</td><td>${r.name}</td><td>${r.category}</td><td>${r.unit}</td>
                          <td class="num">${r.onHand}</td><td class="num">${r.reserved}</td><td class="num">${r.available}</td>
                          ${can.costs ? html`<td class="num" data-col="avgCost">${r.avgCost}</td><td class="num" data-col="value">${r.value}</td>` : ""}
                          <td class="num">${r.price}</td><td class="num">${r.reorderLevel}</td>
                          <td>${r.isLowStock ? badge("Low stock", "warning") : r.status === "active" ? badge("Active", "success") : badge("Inactive", "neutral")}</td>
                          <td><div class="page-actions">${rowActions(r, product)}</div></td>
                        </tr>`
                      )}
                    </tbody>
                  </table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
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

  function productFields(p = null) {
    return [
      { name: "sku", label: "SKU", value: p ? p.sku : "", required: true, hint: "Unique in your business. Letters, digits, . - _" },
      { name: "name", label: "Product name", value: p ? p.name : "", required: true },
      { name: "category", label: "Category", value: p ? p.category : "" },
      { name: "unit", label: "Unit", type: "select", options: UNIT_OPTIONS, value: p ? p.unit : "pcs", disabled: Boolean(p && p.movementCount > 0), hint: p && p.movementCount > 0 ? "Locked once stock has moved." : "" },
      { name: "sellingPrice", label: `Selling price (${currency})`, value: p ? pesos(p.sellingPrice) : "", required: true, inputmode: "decimal" },
      { name: "reorderLevel", label: "Reorder level", value: p ? formatQuantity(p.reorderLevel) : "0", inputmode: "decimal", hint: "Low stock when available is at or below this." },
    ];
  }

  async function openProduct(p = null) {
    const result = await formDialog({
      title: p ? `Edit ${p.name}` : "New product",
      fields: productFields(p),
      submitLabel: p ? "Save" : "Create product",
      onSubmit: (v) => {
        const unit = p && p.movementCount > 0 ? p.unit : v.unit;
        const product = { sku: v.sku, name: v.name, category: v.category, unit, sellingPrice: parseCentavos(v.sellingPrice), reorderLevel: parseQuantity(v.reorderLevel || "0", unit) };
        if (p && p.movementCount > 0) delete product.unit;
        return send("products", p ? { action: "update", productId: p.id, changes: product } : { action: "create", product });
      },
    });
    if (result) await done(p ? "Product updated" : "Product created");
  }

  async function openMovement(kind, p) {
    const titles = { receipt: `Receive ${p.name}`, opening: `Opening balance: ${p.name}`, adjust: `Adjust ${p.name}` };
    const fields = [];
    if (kind === "adjust") fields.push({ name: "direction", label: "Change", type: "select", options: [{ value: "adjustment_decrease", label: "Decrease (damage, loss, count)" }, { value: "adjustment_increase", label: "Increase (count correction, found)" }] });
    fields.push({ name: "quantity", label: `Quantity (${unitLabel(p.unit)})`, required: true, inputmode: "decimal" });
    if (kind !== "adjust") fields.push({ name: "unitCost", label: `Unit cost (${currency})`, required: true, inputmode: "decimal", hint: kind === "receipt" ? "Purchase cost per unit. Updates the moving average cost." : "Cost per unit of the counted stock." });
    if (kind === "adjust") fields.push({ name: "reason", label: "Reason", type: "select", options: REASON_OPTIONS, required: true });
    fields.push({ name: "reference", label: kind === "receipt" ? "Reference (DR / invoice no.)" : "Reference" });
    fields.push({ name: "note", label: "Note", type: "textarea", hint: kind === "opening" ? "A reference or a note is required (e.g. the stock count it comes from)." : kind === "adjust" ? "Required when the reason is Other." : "" });

    const intro = kind === "adjust" ? "Increases use the current average cost; decreases leave the average unchanged." : kind === "opening" ? "Only possible before any other movement. Sets the starting stock and average cost." : "";
    const result = await formDialog({
      title: titles[kind],
      intro,
      fields,
      submitLabel: kind === "receipt" ? "Receive" : "Record",
      onSubmit: (v) => {
        const body = { action: kind === "adjust" ? v.direction : kind, productId: p.id, quantity: parseQuantity(v.quantity, p.unit) };
        if (kind !== "adjust") body.unitCost = parseCentavos(v.unitCost);
        if (kind === "adjust") body.reason = v.reason;
        if (v.reference) body.reference = v.reference;
        if (v.note) body.note = v.note;
        return send("inventory", body);
      },
    });
    if (result) await done(kind === "receipt" ? "Stock received" : "Inventory updated");
  }

  async function toggleStatus(p) {
    const status = p.status === "active" ? "inactive" : "active";
    try {
      await send("products", { action: "setStatus", productId: p.id, status });
      await done(status === "active" ? "Product activated" : "Product deactivated");
    } catch (err) {
      toast(err.message, "danger");
    }
  }

  async function openHistory(p) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    const rows = [];
    let hasMore = false;
    let error = null;
    const close = () => backdrop.remove();
    const paint = () =>
      render(
        backdrop,
        html`<div role="dialog" aria-modal="true" aria-label="History for ${p.name}" class="modal modal-wide">
          <div class="modal-header"><h2 class="card-title">History: ${p.sku} · ${p.name}</h2></div>
          <div class="modal-body" data-role="history">
            ${error ? html`<p class="form-error">${error}</p>` : ""}
            ${!rows.length && !error ? emptyState({ title: "No movements yet" }) : ""}
            ${rows.map(
              (h) => html`<div class="card history-item" data-tx="${h.id}">
                <strong>${h.label}</strong> <span class="stat-hint">${h.when} · ${h.actor}</span>
                <div class="stat-hint">${h.balance}</div>
                ${h.reason || h.note || h.reference ? html`<div class="stat-hint">${[h.reason, h.note, h.reference && `Ref ${h.reference}`].filter(Boolean).join(" · ")}</div>` : ""}
                ${h.cost ? html`<div class="stat-hint" data-col="cost">${h.cost}</div>` : ""}
              </div>`
            )}
          </div>
          <div class="modal-footer">
            ${hasMore ? html`<button type="button" class="btn" data-act="more">Load more</button>` : ""}
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
    backdrop.addEventListener("click", (event) => {
      const act = event.target.closest("[data-act]")?.dataset.act;
      if (event.target === backdrop || act === "close") close();
      if (act === "more") more();
    });
    paint();
    await more();
  }

  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const p = el.dataset.id ? find(el.dataset.id) : null;
    switch (el.dataset.act) {
      case "new":
        return openProduct();
      case "edit":
        return openProduct(p);
      case "receipt":
      case "opening":
        return openMovement(el.dataset.act, p);
      case "adjust":
        return openMovement("adjust", p);
      case "status":
        return toggleStatus(p);
      case "history":
        return openHistory(p);
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
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const form = event.target;
    state.search = form.elements.search.value;
    state.status = form.elements.status.value;
    state.lowOnly = form.elements.low.value === "low";
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  load();

  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
