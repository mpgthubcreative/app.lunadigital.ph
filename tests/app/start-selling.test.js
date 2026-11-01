// @vitest-environment jsdom
// Start taking orders before inventory is finished (2026-11-01), in the
// browser: the "How do you want to start?" card on Orders, Quick Add Product
// inside New Order, and "Stock not tracked" in Inventory.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/orders/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";
import { productRow, NOT_TRACKED } from "../../src/modules/inventory/view.js";

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const session = (role, extra = {}) => sessionFixture({ roleTemplate: role, ...extra });
const modal = () => document.querySelector(".modal-backdrop");
const tape = { id: "prodTAPE00000000001", sku: "NIPPLE-TAPE-AB12", name: "Nipple Tape", unit: "pcs", sellingPrice: 25000, available: 0, onHand: 0, reserved: 0, trackInventory: false, status: "active" };

function deps({ products = [], api } = {}) {
  return {
    data: { listOrders: vi.fn(async () => ({ rows: [], hasMore: false })), getOrder: vi.fn(), getOrderCosts: vi.fn(), getProducts: vi.fn(async () => ({})) },
    listActiveProducts: vi.fn(async () => products),
    api:
      api ||
      vi.fn(async (path, opts) => {
        if (path === "products" && opts.body.action === "quickAdd") return { success: true, productId: tape.id, product: { ...tape, name: opts.body.product.name, sellingPrice: opts.body.product.sellingPrice, ...(opts.body.product.stock !== undefined ? { trackInventory: true, available: opts.body.product.stock } : {}) } };
        return { success: true, orderId: "newOrder000000000001", orderNumber: "ORD-20261101-001" };
      }),
    toast: vi.fn(),
  };
}
const type = (form, name, value) => {
  form.elements[name].value = value;
  form.elements[name].dispatchEvent(new Event("input", { bubbles: true }));
};

describe('"How do you want to start?" on Orders', () => {
  it("no orders yet: the three choices only; Add products as I go opens New Order straight away", async () => {
    const d = deps();
    mount(container, session("owner"), d);
    await flush();
    const card = container.querySelector('[data-role="start-card"]');
    expect(card.querySelector(".start-title").textContent).toBe("How do you want to start?");
    expect([...card.querySelectorAll(".start-option b")].map((b) => b.textContent)).toEqual(["Add products as I go", "Import my products", "Set up inventory manually"]);
    expect(card.querySelector('[data-role="start-import"]').getAttribute("href")).toBe("/imports");
    expect(card.querySelector('[data-role="start-inventory"]').getAttribute("href")).toBe("/inventory");
    expect(card.textContent).toMatch(/start taking orders now and complete your product list later/);
    card.querySelector('[data-act="new"]').click();
    await flush();
    expect(modal().querySelector("#oe-title").textContent).toBe("New order");
  });

  it("not shown once there are orders, nor to someone who can't create orders", async () => {
    const d = deps();
    d.data.listOrders = vi.fn(async () => ({ rows: [{ id: "o1", orderNumber: "ORD-1", orderDate: "2026-10-08", customer: { name: "A" }, items: [], total: 0, balance: 0, paymentStatus: "unpaid", fulfillmentStatus: "pending" }], hasMore: false }));
    mount(container, session("owner"), d);
    await flush();
    expect(container.querySelector('[data-role="start-card"]')).toBeNull();
    container.innerHTML = "";
    mount(container, sessionFixture({ roleTemplate: "staff", permissions: { ...resolvePermissions("staff"), "orders.create": false } }), deps());
    await flush();
    expect(container.querySelector('[data-role="start-card"]')).toBeNull();
  });
});

describe("Quick Add Product inside New Order", () => {
  async function openNew(s = session("owner"), d = deps()) {
    mount(container, s, d);
    await flush();
    container.querySelector('.page-header [data-act="new"], [data-act="new"]').click();
    await flush();
    return { d, form: modal().querySelector("form") };
  }

  it("TEST CASE 1: no products → Quick Add 'Nipple Tape' ₱250 → added to this order, stays on New Order, Create order sends it", async () => {
    const { d, form } = await openNew();
    expect(form.querySelector('[data-role="product-select"]').textContent).toMatch(/No products yet: use \+ Quick Add Product/);
    form.querySelector('[data-act="quick-add"]').click();
    const q = form.querySelector('[data-role="quick-add"]');
    expect(q.hidden).toBe(false);
    expect([...q.querySelectorAll("label")].map((l) => l.textContent)).toEqual(["Product name *", "Price (PHP) *", "Category", "Stock on hand", "COGS (PHP)"]);
    form.elements.qaName.value = "Nipple Tape";
    form.elements.qaPrice.value = "250";
    q.querySelector('[data-act="qa-save"]').click();
    await flush();
    expect(d.api).toHaveBeenCalledWith("products", { method: "POST", body: { action: "quickAdd", product: { name: "Nipple Tape", sellingPrice: 25000 } } });
    expect(q.hidden).toBe(true);
    const row = form.querySelector('.oe-item[data-line="prodTAPE00000000001"]');
    expect(row).not.toBeNull();
    expect(row.textContent).not.toMatch(/available/);
    expect(form.querySelector('[data-role="items-hint"]').textContent).toMatch(/Nipple Tape added to your products \(stock not tracked\) and to this order/);
    expect(form.querySelector('[data-total="total"]').textContent).toMatch(/250\.00/);
    type(form, "name", "Maria Santos");
    form.querySelector('[data-act="submit"]').click();
    await flush();
    const create = d.api.mock.calls.find(([p, o]) => p === "orders" && o.body.action === "create");
    expect(create[1].body.order.items).toEqual([{ productId: "prodTAPE00000000001", quantity: 1000 }]);
  });

  it("TEST CASE 2 (stock entered), Enter key adds the product and never submits the order; plain errors", async () => {
    const { d, form } = await openNew();
    form.querySelector('[data-act="quick-add"]').click();
    const q = form.querySelector('[data-role="quick-add"]');
    q.querySelector('[data-act="qa-save"]').click();
    await flush();
    expect(q.querySelector('[data-role="qa-error"]').textContent).toBe("Enter the product name");
    form.elements.qaName.value = "White Top";
    form.elements.qaPrice.value = "abc";
    q.querySelector('[data-act="qa-save"]').click();
    await flush();
    expect(q.querySelector('[data-role="qa-error"]').textContent).toMatch(/Price: enter an amount like 250/);
    form.elements.qaPrice.value = "350";
    form.elements.qaStock.value = "2";
    form.elements.qaCost.value = "0";
    form.elements.qaStock.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("products", { method: "POST", body: { action: "quickAdd", product: { name: "White Top", sellingPrice: 35000, stock: 2000, unitCost: 0 } } });
    expect(d.api.mock.calls.some(([p]) => p === "orders")).toBe(false);
    expect(form.querySelector('[data-role="items-hint"]').textContent).not.toMatch(/not tracked/);
  });

  it("an untracked product in the picker shows no stock figure; Staff (no products.manage) gets no Quick Add; Reseller says Owner/Base Price; no COGS field without cost access", async () => {
    const { form } = await openNew(session("owner"), deps({ products: [tape] }));
    expect(form.querySelector('[data-role="product-select"]').textContent).not.toMatch(/left/);
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const staff = await openNew(session("staff"));
    expect(staff.form.querySelector('[data-act="quick-add"]')).toBeNull();
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const res = await openNew(sessionFixture({ roleTemplate: "owner", planId: "reseller-basic", workspaceTemplateId: "reseller" }));
    expect(res.form.querySelector('label[for="qaPrice"]').textContent).toBe("Owner/Base Price (PHP) *");
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    const noCost = await openNew(sessionFixture({ roleTemplate: "owner", permissions: { ...resolvePermissions("owner"), "inventory.costs": false } }));
    expect(noCost.form.querySelector('[name="qaCost"]')).toBeNull();
  });
});

describe("Inventory: Stock not tracked", () => {
  it("an untracked product shows 'Not tracked', never '0'; a tracked one shows its stock", () => {
    expect(productRow(tape, null, { seesCosts: false })).toMatchObject({ tracked: false, available: NOT_TRACKED, onHand: "—", reserved: "—" });
    expect(productRow({ ...tape, trackInventory: undefined, available: 30000, onHand: 30000 }, null, { seesCosts: false })).toMatchObject({ tracked: true, available: "30", onHand: "30" });
  });
});
