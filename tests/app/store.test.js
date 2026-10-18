// @vitest-environment jsdom
// Owner pilot: the public menu page (/store/{slug}) and Orders → Share menu.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderStorePage, storeSlugFrom } from "../../src/app/store.js";
import { openShareMenu } from "../../src/modules/orders/share-menu.js";
import { mount as mountOrders } from "../../src/modules/orders/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const Q = (n) => n * 1000;
const until = async (fn) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  return fn();
};
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
let root;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app");
});

const STORE = { name: "Hayst Kopi", open: true, note: "Delivered within Taguig", currency: "PHP", pickup: true, delivery: true, paymentMethods: ["cod", "gcash"] };
const KOPI = { id: "prodKOPI000001", name: "Hayst Kopi", category: "Coffee", unit: "pcs", unitLabel: "pcs", price: 7500, soldOut: false, left: null, max: Q(99) };
const CHOCO = { id: "prodCHOCO00001", name: "Hayst Choco", category: "Coffee", unit: "pcs", unitLabel: "pcs", price: 7500, soldOut: false, left: Q(2), max: Q(2) };
const MATCHA = { id: "prodMATCHA0001", name: "Matcha", category: "Tea", unit: "pcs", unitLabel: "pcs", price: 9000, soldOut: true, left: null, max: 0 };

function server({ store = STORE, products = [CHOCO, KOPI, MATCHA], order = null } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.action === "view") return { ok: true, json: async () => ({ store, products }) };
    if (order instanceof Error) return { ok: false, status: order.status, json: async () => ({ error: order.code, message: order.message }) };
    return { ok: true, json: async () => ({ order: order || { orderNumber: "ORD-20261018-004", total: 22500, currency: "PHP", replayed: false, items: [{ name: "Hayst Kopi", quantity: Q(2), unitLabel: "pcs", lineSubtotal: 15000 }, { name: "Hayst Choco", quantity: Q(1), unitLabel: "pcs", lineSubtotal: 7500 }], sourceNote: "Delivery · GCash" } }) };
  });
  return { fetchImpl, calls };
}
const tap = (id, act, n = 1) => {
  for (let i = 0; i < n; i++) root.querySelector(`[data-product="${id}"] [data-act="${act}"]`).click();
};
const text = (sel) => root.querySelector(sel)?.textContent.trim();

describe("public menu page", () => {
  it("reads the slug from /store/{slug}", () => {
    expect(storeSlugFrom("/store/hayst-kopi")).toBe("hayst-kopi");
    expect(storeSlugFrom("/store/Hayst-Kopi/")).toBe("hayst-kopi");
    expect(storeSlugFrom("/store/")).toBe("");
    expect(storeSlugFrom("/store/a/b")).toBe("");
  });

  it("menu: name, price, sold out / only N left, steppers capped; the bar totals as you tap; no bar while empty", async () => {
    const { fetchImpl, calls } = server();
    await renderStorePage(root, { slug: "hayst-kopi", fetchImpl });
    expect(calls[0]).toEqual({ action: "view", slug: "hayst-kopi" });
    expect(text(".store-title")).toBe("Hayst Kopi");
    expect([...root.querySelectorAll(".store-cat")].map((h) => h.textContent)).toEqual(["Coffee", "Tea"]);
    expect(text(`[data-product="${CHOCO.id}"] [data-role="left"]`)).toBe("Only 2 left");
    expect(text(`[data-product="${MATCHA.id}"] [data-role="left"]`)).toBe("Sold out");
    expect(root.querySelector(`[data-product="${MATCHA.id}"] [data-act="inc"]`)).toBeNull();
    expect(root.querySelector('[data-role="bar"]')).toBeNull();
    tap(KOPI.id, "inc", 2);
    tap(CHOCO.id, "inc", 3); // capped at 2
    expect(text(`[data-product="${CHOCO.id}"] [data-role="qty"]`)).toBe("2");
    expect(root.querySelector(`[data-product="${CHOCO.id}"] [data-act="inc"]`).disabled).toBe(true);
    tap(CHOCO.id, "dec");
    expect(text('[data-role="bar-total"]')).toBe("₱225");
    expect(text('[data-role="bar-items"]')).toBe("3 items");
    expect(root.querySelector("table")).toBeNull();
  });

  it("review -> details -> Place order sends ids + quantities + one key (no prices); a double tap sends once; the thank-you shows the order number", async () => {
    const { fetchImpl, calls } = server();
    await renderStorePage(root, { slug: "hayst-kopi", fetchImpl });
    tap(KOPI.id, "inc", 2);
    tap(CHOCO.id, "inc");
    root.querySelector('[data-act="review"]').click();
    expect(text('[data-role="total"]')).toBe("₱225");
    const form = root.querySelector('[data-role="form"]');
    // Missing details are said before anything is sent.
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(text('[data-role="error"]')).toBe("Enter your name.");
    const f = root.querySelector('[data-role="form"]');
    f.elements.name.value = "Marian Santos";
    f.elements.phone.value = "0917 123 4567";
    f.querySelector('input[name="fulfillment"][value="delivery"]').checked = true;
    f.querySelector('input[name="fulfillment"][value="delivery"]').dispatchEvent(new Event("change", { bubbles: true }));
    const g = root.querySelector('[data-role="form"]');
    expect(g.elements.address).toBeTruthy(); // delivery asks for the address
    g.elements.address.value = "12 Mabini St, Taguig";
    g.querySelector('input[name="paymentMethod"][value="gcash"]').checked = true;
    g.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    g.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(() => root.querySelector('[data-role="done"]'));
    const orders = calls.filter((c) => c.action === "order");
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ slug: "hayst-kopi", website: "", order: { name: "Marian Santos", phone: "0917 123 4567", fulfillment: "delivery", address: "12 Mabini St, Taguig", paymentMethod: "gcash", items: [{ productId: CHOCO.id, quantity: Q(1) }, { productId: KOPI.id, quantity: Q(2) }] } });
    expect(orders[0].idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(JSON.stringify(orders[0])).not.toMatch(/price|total/i);
    expect(text('[data-role="order-number"]')).toBe("ORD-20261018-004");
    expect(root.textContent).toMatch(/will contact you at 0917 123 4567/);
  });

  it("closed store, bad link, and a sold-out refusal reloads the menu", async () => {
    await renderStorePage(root, { slug: "hayst-kopi", fetchImpl: server({ store: { ...STORE, open: false }, products: [] }).fetchImpl });
    expect(root.querySelector('[data-role="closed"]').textContent).toMatch(/isn't taking orders online right now/);
    await renderStorePage(root, { slug: "nope", fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ message: "x" }) }) });
    expect(text('[data-role="message"]')).toMatch(/isn't valid/);

    root.replaceWith(Object.assign(document.createElement("div"), { id: "app" }));
    root = document.getElementById("app");
    const s = server({ order: Object.assign(new Error("Some items just sold out or there isn't enough left. Check the quantities and try again."), { status: 409, code: "sold-out" }) });
    await renderStorePage(root, { slug: "hayst-kopi", fetchImpl: s.fetchImpl });
    tap(KOPI.id, "inc");
    root.querySelector('[data-act="review"]').click();
    const f = root.querySelector('[data-role="form"]');
    f.elements.name.value = "Ana";
    f.elements.phone.value = "09171234567";
    f.querySelector('input[name="fulfillment"][value="pickup"]').checked = true;
    f.querySelector('input[name="paymentMethod"][value="cod"]').checked = true;
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(() => root.querySelector('[data-role="error"]:not([hidden])')?.textContent.includes("sold out"));
    expect(s.calls.filter((c) => c.action === "view")).toHaveLength(2);
  });
});

describe("Orders → Share menu", () => {
  const session = (role) => sessionFixture({ roleTemplate: role, permissions: resolvePermissions(role) });
  const settings = { open: false, displayName: "Biz A", slug: "biz-a", note: "", pickup: true, delivery: false, paymentMethods: ["cash", "gcash"], hiddenProductIds: [] };

  it("the Orders header has Share menu for staff too", async () => {
    mountOrders(root, session("staff"), { data: { listOrders: vi.fn(async () => ({ rows: [], hasMore: false })) }, listActiveProducts: vi.fn(async () => []), api: vi.fn(), toast: vi.fn() });
    await flush();
    expect(root.querySelector('[data-act="share-menu"]').textContent).toBe("Share menu");
  });

  it("everyone: the link + Copy / Preview; no settings without settings.manage", async () => {
    const api = vi.fn(async () => ({ settings, path: "/store/biz-a", canManage: false }));
    const copy = vi.fn(async () => {});
    const toast = vi.fn();
    openShareMenu({ session: session("staff"), api, toast, listActiveProducts: vi.fn(), origin: "https://app.example", copy, share: null });
    await until(() => document.querySelector('[data-role="link"]'));
    expect(document.querySelector('[data-role="link"]').value).toBe("https://app.example/store/biz-a");
    expect(document.querySelector('[data-x="preview"]').getAttribute("href")).toBe("/store/biz-a");
    expect(document.querySelector('[data-role="store-status"]').textContent).toMatch(/Closed/);
    expect(document.querySelector('[data-role="store-settings"]')).toBeNull();
    expect(document.querySelector('[data-x="open"]')).toBeNull();
    document.querySelector('[data-x="copy"]').click();
    await flush();
    expect(copy).toHaveBeenCalledWith("https://app.example/store/biz-a");
    expect(toast).toHaveBeenCalledWith("Menu link copied.", "success");
  });

  it("Owner: open / close in one tap; settings save the whole form; products hidden only when the list was opened", async () => {
    let current = { ...settings };
    const api = vi.fn(async (_e, { body }) => {
      if (body.action === "save") current = { ...current, ...body.settings };
      return { settings: current, path: `/store/${current.slug}`, canManage: true };
    });
    const products = [{ id: "prodA00000001", name: "A", status: "active" }, { id: "prodB00000001", name: "B", status: "active" }];
    openShareMenu({ session: session("owner"), api, toast: vi.fn(), listActiveProducts: vi.fn(async () => products), origin: "https://app.example", share: null });
    await until(() => document.querySelector('[data-x="open"]'));
    const box = document.querySelector('[data-x="open"]');
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => api.mock.calls.length === 2 && document.querySelector('[data-x="open"]')?.checked);
    expect(document.querySelector('[data-role="store-status"]')).toBeNull(); // the toggle says it
    expect(api.mock.calls[1][1].body).toEqual({ action: "save", settings: { open: true } });

    const form = document.querySelector('[data-role="settings-form"]');
    form.elements.slug.value = "Biz-A-Coffee";
    form.querySelector('input[name="delivery"]').checked = true;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(() => api.mock.calls.length === 3);
    expect(api.mock.calls[2][1].body.settings).toEqual({ displayName: "Biz A", note: "", slug: "biz-a-coffee", pickup: true, delivery: true, paymentMethods: ["cash", "gcash"] });

    const fold = document.querySelector('[data-role="products-fold"]');
    fold.open = true;
    fold.dispatchEvent(new Event("toggle"));
    await until(() => document.querySelectorAll('input[name="show"]').length === 2);
    document.querySelector('input[name="show"][value="prodB00000001"]').checked = false;
    document.querySelector('[data-role="settings-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(() => api.mock.calls.length === 4);
    expect(api.mock.calls[3][1].body.settings.hiddenProductIds).toEqual(["prodB00000001"]);
  });

  it("Owner: a failed open / closed tap says why (Store settings folded) and the toggle stays as it was", async () => {
    const api = vi.fn(async (_e, { body }) => {
      if (body.action === "save") throw new Error("You're offline. Check your connection.");
      return { settings, path: "/store/biz-a", canManage: true };
    });
    const toast = vi.fn();
    openShareMenu({ session: session("owner"), api, toast, listActiveProducts: vi.fn(), origin: "https://app.example", share: null });
    await until(() => document.querySelector('[data-x="open"]'));
    const box = document.querySelector('[data-x="open"]');
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => toast.mock.calls.length === 1);
    expect(toast).toHaveBeenCalledWith("You're offline. Check your connection.", "danger");
    expect(document.querySelector('[data-x="open"]').checked).toBe(false);
  });
});
