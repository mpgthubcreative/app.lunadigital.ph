// @vitest-environment jsdom
// Reseller Package screens (2026-10-31): the workspace navigation, the
// Owner's Resellers page (name-only add, link, Pay Commission, payouts), the
// reseller's private menu (owner price, selling price, commission, below
// owner price, customer-ready summary), the reseller block on an order, the
// commission report, and the Owner/Base Price label.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountResellers } from "../../src/modules/resellers/index.js";
import { renderResellerPage, customerSummary, priceFrom } from "../../src/app/reseller.js";
import { resellerBlock, editResellerSaleDialog } from "../../src/modules/resellers/sale.js";
import { mount as mountReports } from "../../src/modules/reports/index.js";
import { renderShell, shellNavigation } from "../../src/app/shell.js";
import { buildRoutes } from "../../src/app/routes.js";
import { MODULE_LOADERS } from "../../src/modules/loaders.js";
import { html, render } from "../../src/lib/html.js";
import { formatCentavos } from "../../src/lib/format.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const until = async (fn) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  return fn();
};
const shop = (role = "owner") => sessionFixture({ roleTemplate: role, planId: "reseller-basic", workspaceTemplateId: "reseller" });
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
let container;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><main id="content"></main>';
  container = document.getElementById("content");
});

describe("the Reseller workspace", () => {
  it("navigation: Orders · Inventory · Resellers · Reports + More; Share menu; Distributor never gets Resellers", () => {
    renderShell(document.getElementById("app"), shop());
    expect([...document.querySelectorAll(".tabbar .tab-link")].map((a) => a.textContent.trim())).toEqual(["Orders", "Inventory", "Resellers", "Reports", "More"]);
    expect(buildRoutes(shop()).map((r) => r.path)).toEqual(expect.arrayContaining(["/resellers", "/orders", "/inventory", "/payments", "/share-menu"]));
    expect(shellNavigation(sessionFixture()).map((m) => m.id)).not.toContain("resellers");
    expect(buildRoutes(sessionFixture()).map((r) => r.path)).not.toContain("/resellers");
    expect(typeof MODULE_LOADERS.resellers).toBe("function");
    // Staff: no Resellers.
    expect(shellNavigation(shop("staff")).map((m) => m.id)).not.toContain("resellers");
  });
});

const LIST = [
  { id: "resRiza000001", name: "Riza", status: "active", earned: 30000, paid: 10000, remaining: 20000, payoutStatus: "partial", orderCount: 1 },
  { id: "resVeah000001", name: "Veah", status: "inactive", earned: 0, paid: 0, remaining: 0, payoutStatus: "none", orderCount: 0 },
];
const DETAIL = {
  reseller: LIST[0],
  orders: [{ id: "ord000000001", orderNumber: "ORD-20261015-001", orderDate: "2026-10-15", customer: "Marian", total: 130000, fulfillmentStatus: "pending", paymentStatus: "unpaid", commission: { calculated: 35000, final: 30000, adjusted: true }, payout: { final: 30000, paid: 10000, remaining: 20000, status: "partial" } }],
  payouts: [{ id: "cpPayout00001", amount: 10000, date: "2026-10-15", method: "GCash", reference: null, notes: null, state: "paid", by: "owner", reversal: null }],
};
function fakeApi(extra = {}) {
  return vi.fn(async (path, opts) => {
    const b = opts?.body || {};
    if (b.action === "list") return { resellers: LIST };
    if (b.action === "detail") return DETAIL;
    if (b.action === "link") return { path: "/reseller#tokTOKtokTOKtokTOKtokTOKtokTOKtokTOKto" };
    if (b.action === "create") return { resellerId: "resYanie00001", path: "/reseller#newNEWnewNEWnewNEWnewNEWnewNEWnewNEWne" };
    if (b.action === "pay") return { paid: 20000, remaining: 10000, status: "partial" };
    if (extra[b.action]) return extra[b.action](b);
    return {};
  });
}

describe("Resellers page (Owner)", () => {
  it("rows: earned · paid · remaining · Unpaid / Partially Paid / Paid; inactive marked; totals", async () => {
    mountResellers(container, shop(), { api: fakeApi(), toast: () => {} });
    await flush();
    const row = container.querySelector('tr[data-reseller="resRiza000001"]');
    expect(row.textContent).toMatch(/Riza[\s\S]*₱300\.00[\s\S]*₱100\.00[\s\S]*₱200\.00[\s\S]*Partially Paid/);
    expect(container.querySelector('tr[data-reseller="resVeah000001"]').textContent).toMatch(/Inactive/);
    expect(container.querySelector('[data-role="totals"] [data-k="remaining"]').textContent).toBe("₱200.00");
  });

  it("+ Add reseller: Name only → Save → their link (Copy / Share)", async () => {
    const api = fakeApi();
    const copy = vi.fn(async () => {});
    mountResellers(container, shop(), { api, toast: () => {}, copy });
    await flush();
    container.querySelector('[data-act="add"]').click();
    const f = lastForm();
    expect([...f.querySelectorAll(".field label")].map((l) => l.textContent)[0]).toBe("Name *");
    expect(f.elements.phone).toBeUndefined();
    expect(f.elements.email).toBeUndefined();
    f.elements.name.value = "Yanie";
    submit(f);
    await until(() => document.querySelector('[data-role="reseller-view"]'));
    expect(api).toHaveBeenCalledWith("resellers", { method: "POST", body: { action: "create", reseller: { name: "Yanie" } } });
    await until(() => document.querySelector('[data-role="link-text"]'));
    expect(document.querySelector('[data-role="link-text"]').value).toMatch(/\/reseller#newNEW/);
    document.querySelector('[data-x="copy"]').click();
    await until(() => copy.mock.calls.length);
    expect(copy.mock.calls[0][0]).toMatch(/\/reseller#newNEW/);
  });

  it("details: summary, recent orders (Adjusted from), payouts; Pay Commission defaults to the remaining amount and refuses more", async () => {
    const api = fakeApi();
    mountResellers(container, shop(), { api, toast: () => {} });
    await flush();
    container.querySelector('tr[data-reseller="resRiza000001"] [data-act="open"]').click();
    await until(() => document.querySelector('[data-role="payouts"]'));
    const view = document.querySelector('[data-role="reseller-view"]');
    expect(view.querySelector('[data-role="summary"]').textContent).toMatch(/Commission earned\s*₱300\.00[\s\S]*Commission paid\s*₱100\.00[\s\S]*Remaining\s*₱200\.00/);
    expect(view.querySelector('[data-role="orders"]').textContent).toMatch(/Commission\s*₱300\.00 · Adjusted from ₱350\.00/);
    expect(view.querySelector('[data-role="payouts"]').textContent).toMatch(/Oct 15[\s\S]*₱100\.00 · GCash/);
    view.querySelector('[data-x="pay"]').click();
    const f = lastForm();
    expect(f.elements.amount.value).toBe("200");
    f.elements.amount.value = "250";
    await new Promise((r) => setTimeout(r, 750));
    submit(f);
    await flush();
    expect(f.closest(".modal-backdrop").textContent).toMatch(/more than the commission still owed/);
    f.elements.amount.value = "100";
    submit(f);
    await until(() => api.mock.calls.some((c) => c[1]?.body?.action === "pay"));
    expect(api.mock.calls.find((c) => c[1]?.body?.action === "pay")[1].body).toMatchObject({ action: "pay", resellerId: "resRiza000001", payout: { amount: 10000 } });
  });

  it("Staff (no resellers.manage / pay): no Add, no Pay", async () => {
    const s = shop();
    s.member.permissions = { ...s.member.permissions, "resellers.manage": false, "resellers.pay": false };
    mountResellers(container, s, { api: fakeApi(), toast: () => {} });
    await flush();
    expect(container.querySelector('[data-act="add"]')).toBeNull();
    container.querySelector('tr[data-reseller="resRiza000001"] [data-act="open"]').click();
    await until(() => document.querySelector('[data-role="payouts"]'));
    expect(document.querySelector('[data-x="pay"]')).toBeNull();
  });
});

const VIEW = {
  business: { name: "Res A", currency: "PHP" },
  reseller: { name: "Riza" },
  commission: { earned: 30000, paid: 10000, remaining: 20000, status: "partial" },
  fulfillment: ["pickup", "delivery"],
  paymentMethods: [{ id: "gcash", label: "GCash" }],
  products: [{ id: "prodA0000001", name: "Product A", category: "", unit: "pcs", unitLabel: "pcs", ownerPrice: 50000, sellingPrice: 50000, max: 10000 }],
  orders: [],
};
function menuFetch(calls, extra = {}) {
  return vi.fn(async (_u, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const out = extra[body.action] ? extra[body.action](body) : body.action === "view" ? VIEW : body.action === "order" ? { orderNumber: "ORD-20261015-001", total: 130000, ownerAmount: 100000, commission: 30000, items: [{ name: "Product A", quantity: 2000, unitLabel: "pcs", sellingPrice: 65000, lineSubtotal: 130000 }], payPath: "/pay/payTOKpayTOKpayTOKpayTOK" } : {};
    return { ok: true, status: 200, json: async () => ({ success: true, ...out }) };
  });
}

describe("the reseller's private menu (no login)", () => {
  it("knows the reseller from the link; owner price, selling price, live commission; her commission read-only", async () => {
    const calls = [];
    await renderResellerPage(container, { token: "tokTOKtokTOKtokTOKtokTOKtokTOKtokTOKto", fetchImpl: menuFetch(calls), origin: "https://app.test" });
    expect(container.querySelector('[data-role="who"]').textContent).toBe("Reseller: Riza");
    expect(container.querySelector('[data-role="my-commission"]').textContent).toMatch(/Earned\s*₱300\.00[\s\S]*Paid\s*₱100\.00[\s\S]*Remaining\s*₱200\.00[\s\S]*Partially Paid/);
    expect(container.querySelector('[data-role="my-commission"] button')).toBeNull();
    expect(container.querySelector('[data-role="owner-price"]').textContent).toBe("Owner price ₱500.00");
    expect(container.querySelector('[data-role="commission"]').textContent).toBe("Your commission ₱0.00");
    const price = container.querySelector('[data-role="price"]');
    price.value = "650";
    price.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector('[data-role="commission"]').textContent).toBe("Your commission ₱150.00");
    expect(calls[0]).toEqual({ action: "view", token: "tokTOKtokTOKtokTOKtokTOKtokTOKtokTOKto" });
  });

  it("below the owner price: the warning, and no order until it's fixed", async () => {
    const calls = [];
    await renderResellerPage(container, { token: "tokTOKtokTOKtokTOKtokTOKtokTOKtokTOKto", fetchImpl: menuFetch(calls) });
    const price = container.querySelector('[data-role="price"]');
    price.value = "450";
    price.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector('[data-role="below"]').textContent).toBe("Selling price is below the owner price.");
    container.querySelector('[data-act="inc"]').click();
    expect(container.querySelector('[data-act="review"]').disabled).toBe(true);
    // ₱0 commission (selling = owner) is fine.
    const again = container.querySelector('[data-role="price"]');
    again.value = "500";
    again.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector('[data-role="commission"]').textContent).toBe("Your commission ₱0.00");
    expect(container.querySelector('[data-act="review"]').disabled).toBe(false);
  });

  it("Review → Create order: customer total, owner amount, commission; the customer summary has selling prices only", async () => {
    const calls = [];
    const copy = vi.fn(async () => {});
    await renderResellerPage(container, { token: "tokTOKtokTOKtokTOKtokTOKtokTOKtokTOKto", fetchImpl: menuFetch(calls), copy, origin: "https://app.test" });
    const price = container.querySelector('[data-role="price"]');
    price.value = "650";
    price.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector('[data-act="inc"]').click();
    container.querySelector('[data-act="inc"]').click();
    expect(container.querySelector('[data-role="bar-total"]').textContent).toBe("₱1,300.00");
    container.querySelector('[data-act="review"]').click();
    expect(container.querySelector('[data-role="review-totals"]').textContent).toMatch(/Customer pays\s*₱1,300\.00[\s\S]*Owner amount\s*₱1,000\.00[\s\S]*Your commission\s*₱300\.00/);
    const form = container.querySelector('[data-role="form"]');
    form.elements.customerName.value = "Marian";
    form.querySelector('input[name="fulfillment"][value="pickup"]').checked = true;
    submit(form);
    await until(() => container.querySelector('[data-role="done"]'));
    expect(calls.find((c) => c.action === "order")).toMatchObject({ order: { customerName: "Marian", fulfillment: "pickup", items: [{ productId: "prodA0000001", quantity: 2000, sellingPrice: 65000 }] } });
    const summary = container.querySelector('[data-role="customer-summary"]').textContent;
    expect(summary).toMatch(/2 × Product A — ₱650\.00 = ₱1,300\.00/);
    expect(summary).toMatch(/Total: ₱1,300\.00/);
    expect(summary).toMatch(/https:\/\/app\.test\/pay\//);
    expect(summary).not.toMatch(/500|owner|commission/i);
    container.querySelector('[data-act="copy-summary"]').click();
    await until(() => copy.mock.calls.length);
    expect(copy.mock.calls[0][0]).toBe(summary);
  });

  it("an invalid / revoked link says so (no login asked)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "link-not-found", message: "x" }) }));
    await renderResellerPage(container, { token: "nope", fetchImpl });
    expect(container.querySelector('[data-role="message"]').textContent).toMatch(/isn't valid/);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("pure helpers: prices and the customer summary", () => {
    expect([priceFrom("650"), priceFrom("650.5"), priceFrom("1,250"), priceFrom("₱0"), priceFrom("-1"), priceFrom("abc")]).toEqual([65000, 65050, 125000, 0, null, null]);
    expect(customerSummary({ business: "Res A", orderNumber: "ORD-1", customer: "Marian", items: [{ name: "A", quantity: 1000, sellingPrice: 65000, lineSubtotal: 65000 }], total: 65000 })).toBe("Res A · Order ORD-1 for Marian\n1 × A — ₱650.00\nTotal: ₱650.00");
  });
});

describe("an order's reseller and commission (Owner)", () => {
  const money = (c) => formatCentavos(c, "PHP");
  it("the block: reseller, final commission, Adjusted from; a direct sale says so", () => {
    render(container, html`${resellerBlock({ resellerId: "resRiza000001", reseller: { name: "Riza" }, commission: { calculated: 30000, final: 25000, adjusted: true } }, money)}`);
    expect(container.querySelector('[data-role="reseller-name"]').textContent).toBe("Riza");
    expect(container.querySelector('[data-role="commission"]').textContent.replace(/\s+/g, " ")).toBe("₱250.00 Adjusted from ₱300.00");
    render(container, html`${resellerBlock({ resellerId: null }, money)}`);
    expect(container.textContent).toMatch(/Direct sale · no commission/);
  });

  it("Reseller & commission: final commission override (₱0 is valid), blank = back to calculated", async () => {
    const api = fakeApi({ editSale: () => ({ commission: {} }) });
    const order = { id: "ord000000001", orderNumber: "ORD-1", revision: 3, fulfillmentStatus: "pending", resellerId: "resRiza000001", reseller: { name: "Riza" }, items: [{ lineId: "L1", name: "Product A", unitPrice: 65000, basePrice: 50000, quantity: 2000 }], commission: { calculated: 30000, final: 30000, adjusted: false } };
    const p = editResellerSaleDialog({ order, api });
    await until(() => lastForm());
    const f = lastForm();
    expect(f.elements.price_L1.value).toBe("650");
    f.elements.finalCommission.value = "0";
    submit(f);
    await p;
    expect(api).toHaveBeenLastCalledWith("resellers", { method: "POST", body: { action: "editSale", orderId: "ord000000001", expectedRevision: 3, finalCommission: 0 } });
    const q = editResellerSaleDialog({ order: { ...order, commission: { calculated: 30000, final: 0, adjusted: true } }, api });
    await until(() => lastForm() && lastForm() !== f);
    const g = lastForm();
    g.elements.finalCommission.value = "";
    g.elements.resellerId.value = "";
    submit(g);
    await q;
    expect(api).toHaveBeenLastCalledWith("resellers", { method: "POST", body: { action: "editSale", orderId: "ord000000001", expectedRevision: 3, resellerId: null } });
  });
});

describe("Reports: reseller commissions", () => {
  it("Total Commission and one line per reseller with its payout state, for the chosen period", async () => {
    const api = vi.fn(async (path, opts) => {
      if (path === "resellers") return { report: { total: 125000, rows: [{ resellerId: "v", name: "Veah", earned: 50000, paid: 0, remaining: 50000, status: "unpaid" }, { resellerId: "y", name: "Yanie", earned: 45000, paid: 45000, remaining: 0, status: "paid" }, { resellerId: "r", name: "Riza", earned: 30000, paid: 10000, remaining: 20000, status: "partial" }] } };
      return { access: { financials: true }, range: { granularity: "day" }, overview: { grossSales: 0, ordersCreated: 0, fulfilledOrders: 0, estimatedOperatingProfit: 0 }, series: [], skuMargins: null };
    });
    mountReports(container, shop(), { api, now: () => new Date("2026-10-31T04:00:00Z") });
    await until(() => container.querySelector('[data-section="commissions"]'));
    const s = container.querySelector('[data-section="commissions"]');
    expect(s.querySelector('[data-total="commission"]').textContent).toMatch(/Total Commission\s*₱1,250\.00/);
    expect([...s.querySelectorAll('[data-role="commission-rows"] li')].map((li) => li.textContent.replace(/\s+/g, " ").trim())).toEqual(["Veah₱500.00Unpaid", "Yanie₱450.00Paid", "Riza₱300.00Paid ₱100.00 · Remaining ₱200.00"]);
    expect(api).toHaveBeenCalledWith("resellers", { method: "POST", body: { action: "report", from: "2026-10-01", to: "2026-10-31" } });
  });

  it("a Distributor business's Reports never ask for commissions", async () => {
    const api = vi.fn(async () => ({ access: { financials: true }, range: { granularity: "day" }, overview: { grossSales: 0, ordersCreated: 0, fulfilledOrders: 0, estimatedOperatingProfit: 0 }, series: [], skuMargins: null }));
    mountReports(container, sessionFixture(), { api, now: () => new Date("2026-10-31T04:00:00Z") });
    await flush();
    expect(api.mock.calls.some((c) => c[0] === "resellers")).toBe(false);
    expect(container.querySelector('[data-section="commissions"]')).toBeNull();
  });
});
