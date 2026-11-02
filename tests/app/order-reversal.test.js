// @vitest-environment jsdom
// Reseller Package update (2026-11-03) on screen: a fulfilled order's
// Fulfillment ▾ can go back (Reverse fulfillment, with a reason) or be
// cancelled; ⋯ More is the one place to manage it; Delete only shows for an
// order with no history. A reseller sale's details lead with the
// Owner/Base Price (Sell / Commission beside it). New Order: Sold by and,
// per line, Owner · Sell · Commission (calculated, or the Owner's final
// "₱40 · adjusted from ₱50"), sent as the line's selling price and commission.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/orders/index.js";
import { openOrderEditor } from "../../src/modules/orders/editor.js";
import { historyRows } from "../../src/modules/orders/view.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const shop = (role = "owner") => sessionFixture({ roleTemplate: role, planId: "reseller-basic", workspaceTemplateId: "reseller" });
const line = (over = {}) => ({ lineId: "L1", productId: "prodTAPE0000000001", sku: "TAPE", name: "Nipple Tape", unit: "pcs", quantity: 2000, unitPrice: 25000, basePrice: 20000, commission: 10000, lineSubtotal: 50000, ...over });
const base = {
  orderDate: "2026-11-03",
  source: "other",
  customer: { name: "Ana Lopez" },
  itemCount: 1,
  discount: 0,
  amountPaid: 0,
  paymentCount: 0,
  paymentStatus: "unpaid",
  createdBy: { name: "Owner" },
  createdAt: new Date("2026-11-03T01:00:00Z"),
};
const resale = { ...base, id: "order0000000000000021", orderNumber: "ORD-20261103-021", items: [line({ finalCommission: 8000 })], subtotal: 50000, total: 50000, balance: 50000, fulfillmentStatus: "fulfilled", revision: 4, resellerId: "resRIZA000000000001", reseller: { id: "resRIZA000000000001", name: "Riza" }, commission: { calculated: 10000, final: 8000, adjusted: true, scope: "lines" }, statusHistory: [{ type: "created", at: new Date("2026-11-03T01:00:00Z"), actor: { name: "Owner" } }, { type: "fulfilled", at: new Date("2026-11-03T02:00:00Z"), actor: { name: "Owner" } }] };
const reopened = { ...base, id: "order0000000000000022", orderNumber: "ORD-20261103-022", items: [line({ basePrice: undefined, commission: undefined, unitPrice: 20000, lineSubtotal: 40000 })], subtotal: 40000, total: 40000, balance: 40000, fulfillmentStatus: "ready", revision: 6, statusHistory: [{ type: "created", actor: { name: "Owner" } }, { type: "fulfilled", actor: { name: "Owner" } }, { type: "reopened", from: "fulfilled", to: "ready", reason: "Not picked up yet", actor: { name: "Owner" } }] };
const fresh = { ...reopened, id: "order0000000000000023", orderNumber: "ORD-20261103-023", fulfillmentStatus: "pending", revision: 1, statusHistory: [{ type: "created", actor: { name: "Owner" } }] };

function deps(api = vi.fn(async () => ({ success: true, fulfillmentStatus: "ready" }))) {
  const rows = [resale, reopened, fresh];
  return {
    data: { listOrders: vi.fn(async () => ({ rows, hasMore: false })), getOrder: vi.fn(async (_b, id) => rows.find((o) => o.id === id)), getOrderCosts: vi.fn(async () => ({ cogs: 16000, grossProfit: 34000, lines: [{ lineId: "L1", costConsumed: 16000 }] })), getProducts: vi.fn(async () => ({})) },
    listActiveProducts: vi.fn(async () => []),
    payments: { listOrderPayments: vi.fn(async () => []) },
    api,
    toast: vi.fn(),
  };
}
async function openDetail(s, id, d = deps()) {
  mount(container, s, d);
  await flush();
  container.querySelector(`[data-act="open"][data-id="${id}"]`).click();
  await flush();
  return { d, detail: document.querySelector('[data-role="detail"]') };
}
const reset = () => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
};
const moreItems = (detail) => [...detail.querySelectorAll('[data-role="more-menu"] button')].map((b) => b.textContent.trim());
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);

describe("a fulfilled order can be put back", () => {
  it("Fulfillment ▾ on a fulfilled row offers Pending / Preparing / Ready / Cancelled to the Owner; choosing Ready asks for a reason and sends reopen", async () => {
    const d = deps();
    mount(container, shop(), d);
    await flush();
    const select = container.querySelector(`select[data-act="fulfillment"][data-id="${resale.id}"]`);
    expect([...select.options].map((o) => o.value)).toEqual(["pending", "preparing", "ready", "fulfilled", "cancelled"]);
    expect(select.value).toBe("fulfilled");
    select.value = "ready";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const f = lastForm();
    expect(f.textContent).toMatch(/Tracked stock comes back and is set aside for this order again/);
    expect(f.elements.stage.value).toBe("ready");
    f.elements.reason.value = "Marked fulfilled by mistake";
    f.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("orders", { method: "POST", body: { action: "reopen", orderId: resale.id, stage: "ready", reason: "Marked fulfilled by mistake", expectedRevision: 4 } });
  });

  it("Staff (no orders.correct) only see the Fulfilled badge", async () => {
    mount(container, shop("staff"), deps());
    await flush();
    expect(container.querySelector(`select[data-act="fulfillment"][data-id="${resale.id}"]`)).toBeNull();
  });

  it("⋯ More: Reverse fulfillment and Cancel order for a fulfilled order; Delete only for an order with no history", async () => {
    let { detail } = await openDetail(shop(), resale.id);
    expect(moreItems(detail)).toEqual(["Reseller & commission", "Payment link", "Record payment", "Reverse fulfillment", "Cancel order"]);
    reset();
    ({ detail } = await openDetail(shop(), reopened.id));
    expect(moreItems(detail)).not.toContain("Delete order");
    expect(moreItems(detail)).toContain("Cancel order");
    reset();
    ({ detail } = await openDetail(shop(), fresh.id));
    expect(moreItems(detail)).toContain("Delete order");
  });

  it("the activity log says what happened in plain words", () => {
    const rows = historyRows(reopened, { timezone: "Asia/Manila" });
    expect(rows.at(-1).headline).toMatch(/Fulfillment reversed · Reason: Not picked up yet/);
    expect(rows.at(-1).effects).toEqual(["Back to Ready · stock back and set aside again · sales and COGS reversed"]);
  });
});

describe("internal reseller sale: Owner/Base Price first", () => {
  it("2 × Owner ₱200 / Sell ₱250: line shows Owner/Base Price ₱200 and Owner amount ₱400; Sell ₱250 · Commission ₱80 adjusted from ₱100; Customer total ₱500", async () => {
    const { detail } = await openDetail(shop(), resale.id);
    const item = detail.querySelector('[data-role="resale-line"]');
    expect(item.querySelector('[data-role="owner-price"]').textContent).toBe("Owner/Base Price ₱200.00");
    expect(item.querySelector(".od-amt").textContent).toBe("₱400.00");
    expect(item.querySelector('[data-role="sell-line"]').textContent).toMatch(/Sell ₱250\.00 · Commission ₱80\.00 · adjusted from ₱100\.00/);
    expect(detail.querySelector('[data-role="owner-amount"]').textContent).toBe("₱400.00");
    expect(detail.querySelector('[data-role="total"]').textContent).toBe("₱500.00");
    expect(detail.querySelector('[data-role="totals"]').textContent).toMatch(/Customer total/);
    expect(detail.querySelector('[data-role="commission"]').textContent).toMatch(/₱80\.00/);
  });
});

describe("New Order: Sold by and the line's Sell / Commission (Owner / Admin)", () => {
  const products = [{ id: "prodTAPE0000000001", sku: "TAPE", name: "Nipple Tape", unit: "pcs", sellingPrice: 20000, status: "active", trackInventory: false }];
  const editorDeps = (api) => ({ listActiveProducts: vi.fn(async () => products), getProducts: vi.fn(async () => ({})), searchCustomers: vi.fn(async () => []), api });
  const form = () => document.querySelector(".modal-backdrop form");
  const set = (name, value, ev = "input") => {
    form().elements[name].value = value;
    form().elements[name].dispatchEvent(new Event(ev, { bubbles: true }));
  };

  it("Riza sells ₱250 over owner ₱200: commission ₱50 calculated; typing ₱40 shows '₱40 · adjusted from ₱50' and sends finalCommission; the totals show Owner amount, Customer total, Commission", async () => {
    const api = vi.fn(async (endpoint) => (endpoint === "resellers" ? { resellers: [{ id: "resRIZA000000000001", name: "Riza", status: "active" }, { id: "resOLD0000000000001", name: "Old", status: "inactive" }] } : { orderNumber: "ORD-1" }));
    const done = openOrderEditor({ session: shop(), deps: editorDeps(api) });
    await flush();
    expect([...form().elements.seller.options].map((o) => o.textContent)).toEqual(["Direct sale (no reseller)", "Riza"]);
    set("name", "Walk-in");
    set("product", products[0].id, "change");
    set("seller", "resRIZA000000000001", "change");
    const row = form().querySelector(".oe-item");
    expect(row.querySelector('[data-col="unitPrice"]').textContent).toMatch(/Owner ₱200\.00/);
    set("sell-0", "250");
    expect(row.querySelector('[data-role="comm-note"]').textContent).toBe("Commission ₱50.00");
    set("comm-0", "40");
    expect(row.querySelector('[data-role="comm-note"]').textContent).toBe("₱40.00 · adjusted from ₱50.00");
    const totals = form().querySelector('[data-role="totals"]').textContent;
    expect(totals).toMatch(/Owner amount₱200\.00/);
    expect(totals).toMatch(/Customer total₱250\.00/);
    expect(totals).toMatch(/Commission₱40\.00 · adjusted from ₱50\.00/);
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const body = api.mock.calls.find(([e]) => e === "orders")[1].body;
    expect(body.order).toMatchObject({ resellerId: "resRIZA000000000001", items: [{ productId: products[0].id, quantity: 1000, sellingPrice: 25000, finalCommission: 4000 }] });
    await done;
  });

  it("below the owner price without a commission: refused on screen; Staff never see Sold by or the commission fields", async () => {
    const api = vi.fn(async (endpoint) => (endpoint === "resellers" ? { resellers: [{ id: "resRIZA000000000001", name: "Riza", status: "active" }] } : { orderNumber: "ORD-2" }));
    openOrderEditor({ session: shop(), deps: editorDeps(api) });
    await flush();
    set("name", "Walk-in");
    set("product", products[0].id, "change");
    set("seller", "resRIZA000000000001", "change");
    set("sell-0", "180");
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(form().querySelector('[data-role="error"]').textContent).toMatch(/below the owner price/);
    expect(api.mock.calls.filter(([e]) => e === "orders")).toEqual([]);
    form().querySelector('[data-act="cancel"]').click();
    openOrderEditor({ session: shop("staff"), deps: editorDeps(vi.fn(async () => ({ orderNumber: "X" }))) });
    await flush();
    expect(form().elements.seller).toBeUndefined();
    expect(form().querySelector('[data-role="resell"]')).toBeNull();
  });

  it("editing a reseller order: an override shows in the field; clearing it sends null (back to calculated)", async () => {
    const order = { ...resale, fulfillmentStatus: "pending", items: [line({ quantity: 1000, lineSubtotal: 25000, finalCommission: 4000, commission: 5000 })] };
    const api = vi.fn(async (endpoint) => (endpoint === "resellers" ? { resellers: [{ id: "resRIZA000000000001", name: "Riza", status: "active" }] } : { orderId: order.id }));
    openOrderEditor({ session: shop(), deps: editorDeps(api), order });
    await flush();
    expect(form().elements["comm-0"].value).toBe("40");
    expect(form().elements["sell-0"].value).toBe("250");
    set("comm-0", "");
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const body = api.mock.calls.find(([e]) => e === "orders")[1].body;
    expect(body).toMatchObject({ action: "update", order: { resellerId: "resRIZA000000000001", items: [{ sellingPrice: 25000, finalCommission: null }] } });
  });
});
