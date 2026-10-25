// @vitest-environment jsdom
// Distributor 2026-10-22: the customer's payment page (/pay/{token}), the
// Owner's Payment link sheet, Not accepted / Receipt, the New Order
// customer choices (saved / new + Save to Customers / Walk-in) and the
// Customer profile's figures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderPayPage } from "../../src/app/pay.js";
import { openPayLinkSheet } from "../../src/modules/payments/link-sheet.js";
import { showReceipt, rejectPaymentDialog } from "../../src/modules/payments/actions.js";
import { openOrderEditor } from "../../src/modules/orders/editor.js";
import { mount as mountCustomers } from "../../src/modules/customers/index.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
let root;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app");
});
const TOKEN = "T".repeat(32);
const VIEW = {
  success: true,
  business: { name: "Northwind Frozen" },
  currency: "PHP",
  order: { orderNumber: "NW-20261022-004", customer: "ABC Store", total: 500000, paid: 200000, pending: 0, due: 300000, payable: true, cancelled: false },
  instructions: "GCash 0917 123 4567 (Ana R.)\nBDO 0012-3456-7890",
  methods: [{ id: "gcash", label: "GCash" }, { id: "maya", label: "Maya" }, { id: "bank_transfer", label: "Bank transfer" }],
  payments: [{ amount: 200000, method: "GCash", reference: "1234567891234", date: "2026-10-20", state: "verified", receipt: { business: "Northwind Frozen", orderNumber: "NW-20261022-004", customer: "ABC Store", amount: 200000, method: "GCash", reference: "1234567891234", date: "2026-10-20", status: "Verified" } }],
};
const PROOF = { contentType: "image/jpeg", dataBase64: "/9j/4AAQ" };

function server(view = VIEW, submit = async () => ({ status: 201, body: { success: true, state: "for_verification", alreadyRecorded: false } })) {
  const calls = [];
  const fetchImpl = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const r = body.action === "view" ? { status: view.status ?? 200, body: view } : await submit(body);
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fetchImpl, calls, submits: () => calls.filter((c) => c.action === "submit") };
}
const $ = (sel) => root.querySelector(sel);
const text = (sel) => $(sel)?.textContent.replace(/\s+/g, " ").trim();
const type = (name, value) => {
  const el = root.querySelector(`[name="${name}"]`);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const pick = async (file) => {
  const el = root.querySelector('[name="proof"]');
  Object.defineProperty(el, "files", { value: [file], configurable: true });
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
};
const send = async () => {
  root.querySelector('[data-role="pay-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
};
const page = async (s, opts = {}) => {
  const prepareProof = opts.prepareProof ?? vi.fn(async () => PROOF);
  const detect = opts.detect ?? vi.fn(async () => null);
  await renderPayPage(root, { token: TOKEN, fetchImpl: s.fetchImpl, prepareProof, detect, warm: () => {} });
  await flush();
  return { prepareProof, detect };
};
const shot = (type = "image/png", name = "gcash.png") => new File([new Uint8Array([1, 2, 3])], name, { type });

describe("the customer's payment page", () => {
  it("one column: business, order no., customer, total / paid / amount due, how to pay, GCash / Maya / Bank transfer; no Luna navigation", async () => {
    const s = server();
    await page(s);
    expect(s.calls[0]).toEqual({ action: "view", token: TOKEN });
    expect(text('[data-role="business"]')).toBe("Northwind Frozen");
    expect(text(".pay-h1")).toBe("Order NW-20261022-004");
    expect(text('[data-role="customer"]')).toBe("ABC Store");
    expect([text('[data-role="total"]'), text('[data-role="paid"]'), text('[data-role="due"] b')]).toEqual(["₱5,000.00", "₱2,000.00", "₱3,000.00"]);
    expect($('[data-role="instructions"] .pay-instructions').textContent).toBe("GCash 0917 123 4567 (Ana R.)\nBDO 0012-3456-7890");
    expect([...root.querySelectorAll(".pay-method")].map((l) => l.textContent.trim())).toEqual(["GCash", "Maya", "Bank transfer"]);
    expect(root.querySelector('[name="amount"]').value).toBe("3000.00");
    expect(root.querySelector(".tabbar, .sidebar, nav")).toBeNull();
    // A verified payment: its receipt with method and reference.
    const r = $('[data-role="receipt"]');
    expect([r.querySelector('[data-role="receipt-method"]').textContent, r.querySelector('[data-role="receipt-reference"]').textContent, r.querySelector('[data-role="receipt-status"]').textContent]).toEqual(["GCash", "1234567891234", "✓ Verified"]);
  });

  it("screenshot only: kept, nothing read, still enough; the submit carries the converted screenshot and no reference", async () => {
    const s = server();
    const { prepareProof } = await page(s);
    await pick(shot());
    expect(prepareProof).toHaveBeenCalledTimes(1);
    expect(text('[data-role="proof-state"]')).toBe("Added ✓ gcash.png");
    expect(text('[data-role="ref-hint"]')).toMatch(/Couldn't read a reference\. The screenshot alone is enough/);
    type("amount", "1500");
    await send();
    expect(s.submits()[0]).toMatchObject({ action: "submit", token: TOKEN, payment: { amount: 150000, method: "gcash" }, proof: PROOF, website: "" });
    expect(s.submits()[0].payment).not.toHaveProperty("reference");
    expect(s.submits()[0].idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(text('[data-role="sent"]')).toMatch(/^Payment sent ✓ ₱1,500\.00 via GCash\. Northwind Frozen will verify it/);
  });

  it("reference only (Maya), no screenshot", async () => {
    const s = server();
    await page(s);
    root.querySelector('[name="method"][value="maya"]').checked = true;
    root.querySelector('[name="method"][value="maya"]').dispatchEvent(new Event("change", { bubbles: true }));
    type("reference", "my-77 88 99");
    await send();
    expect(s.submits()[0].payment).toEqual({ amount: 300000, method: "maya", reference: "MY778899" });
    expect(s.submits()[0]).not.toHaveProperty("proof");
  });

  it("screenshot + the reference read from it (editable); a corrected reference is what's sent", async () => {
    const s = server();
    const detect = vi.fn(async (file) => (file.type === "image/jpeg" ? "1234567891234" : null));
    await page(s, { detect });
    await pick(shot());
    expect(root.querySelector('[name="reference"]').value).toBe("1234567891234");
    expect(text('[data-role="ref-hint"]')).toBe("Read from the screenshot: check it and correct it if needed.");
    type("reference", "1234567891235");
    await send();
    expect(s.submits()[0].payment.reference).toBe("1234567891235");
    expect(s.submits()[0].proof).toEqual(PROOF);
  });

  it("extraction failing doesn't block; a HEIC screenshot is converted first and the JPEG is what's read", async () => {
    const s = server();
    const prepareProof = vi.fn(async () => PROOF);
    const detect = vi.fn(async () => {
      throw new Error("OCR crashed");
    });
    await page(s, { prepareProof, detect });
    const heic = shot("image/heic", "IMG_0042.HEIC");
    await pick(heic);
    expect(prepareProof).toHaveBeenCalledWith(heic);
    expect(detect.mock.calls[0][0].type).toBe("image/jpeg");
    expect(text('[data-role="ref-hint"]')).toMatch(/Couldn't read a reference/);
    await send();
    expect(s.submits()).toHaveLength(1);
  });

  it("a file that isn't a photo is refused in place; neither screenshot nor reference: a clear error, nothing sent; more than due: refused", async () => {
    const s = server();
    await page(s, { prepareProof: vi.fn(async () => { throw new Error("That file isn't a photo. Choose a photo or screenshot from your phone or computer."); }) });
    await pick(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(text('[data-role="pay-error"]')).toMatch(/isn't a photo/);
    await send();
    expect(text('[data-role="pay-error"]')).toBe("Add the payment screenshot or the reference number");
    type("reference", "1234567891234");
    type("amount", "3000.01");
    await send();
    expect(text('[data-role="pay-error"]')).toBe("That's more than the amount due (₱3,000.00)");
    expect(s.submits()).toHaveLength(0);
  });

  it("the server's answer is shown (e.g. a reference already sent); the same key is reused for the retry", async () => {
    let n = 0;
    const s = server(VIEW, async () => (++n === 1 ? { status: 409, body: { success: false, error: "duplicate-reference", message: "This reference number was already submitted." } } : { status: 201, body: { success: true } }));
    await page(s);
    type("reference", "1234567891234");
    await send();
    expect(text('[data-role="pay-error"]')).toBe("This reference number was already submitted.");
    await send();
    expect(s.submits()[1].idempotencyKey).toBe(s.submits()[0].idempotencyKey);
  });

  it("waiting / not accepted (with why) / fully paid; a bad link explains", async () => {
    const paid = { ...VIEW, order: { ...VIEW.order, paid: 400000, pending: 100000, due: 0, payable: false }, payments: [...VIEW.payments, { amount: 100000, method: "Maya", reference: null, date: "2026-10-22", state: "for_verification" }, { amount: 50000, method: "GCash", reference: "1111222233334", date: "2026-10-21", state: "not_accepted", reason: "Screenshot shows ₱400" }] };
    await page(server(paid));
    expect(root.querySelector('[data-role="pay-form"]')).toBeNull();
    expect(text('[data-role="paid-full"]')).toBe("Thank you! Your payment is waiting for verification.");
    expect([...root.querySelectorAll(".pay-chip")].map((c) => c.textContent)).toEqual(["Verified", "Waiting for verification", "Not accepted"]);
    expect(text('[data-role="reason"]')).toBe("Screenshot shows ₱400");
    root.innerHTML = "";
    await page(server({ status: 404, success: false, error: "link-not-found", message: "x" }));
    expect(text('[data-role="pay-problem"]')).toBe("This payment link isn't valid. Ask the business for the current link.");
  });
});

describe("the Owner's side", () => {
  const owner = () => sessionFixture({ roleTemplate: "owner" });
  const staff = () => sessionFixture({ roleTemplate: "staff" });
  const order = { id: "ordNW000000000001", orderNumber: "NW-20261022-004", total: 500000, balance: 300000 };

  it("Payment link: the link with Copy and View, the payment instructions (Owner can edit them); Replace link only with payments.verify", async () => {
    const api = vi.fn(async (endpoint, { body }) => (endpoint === "payments" ? { token: TOKEN, path: `/pay/${TOKEN}` } : body.action === "get" ? { settings: { paymentInstructions: "GCash 0917 123 4567" } } : { settings: { paymentInstructions: body.settings.paymentInstructions } }));
    const copy = vi.fn(async () => {});
    const toast = vi.fn();
    openPayLinkSheet({ order, api, toast, session: owner(), origin: "https://app.example", copy });
    await flush();
    const sheet = document.querySelector('[data-role="pay-link-sheet"]');
    expect(api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "payLink", orderId: order.id } });
    expect(sheet.querySelector('[data-role="pay-link-url"]').value).toBe(`https://app.example/pay/${TOKEN}`);
    expect(sheet.querySelector('[data-role="pay-link-view"]').getAttribute("href")).toBe(`/pay/${TOKEN}`);
    expect(sheet.querySelector('[data-role="instructions"]').textContent).toBe("GCash 0917 123 4567");
    sheet.querySelector('[data-act="copy"]').click();
    await flush();
    expect(copy).toHaveBeenCalledWith(`https://app.example/pay/${TOKEN}`);
    expect(toast).toHaveBeenCalledWith("Payment link copied ✓", "success");
    expect(sheet.querySelector('[data-act="replace"]')).toBeTruthy();
    document.body.innerHTML = '<div id="app"></div>';
    openPayLinkSheet({ order, api, toast, session: staff(), origin: "https://app.example", copy });
    await flush();
    expect(document.querySelector('[data-act="replace"]')).toBeNull();
    expect(document.querySelector('[data-act="instructions"]')).toBeNull();
  });

  it("Receipt: business, order, customer, amount, method, reference, payment date, Verified; Not accepted sends void with the customer-facing reason", async () => {
    const p = { id: "pay1", orderNumber: "NW-20261022-004", customerName: "ABC Store", amount: 200000, method: "bank_transfer", reference: "BDOREF445566", receivedDay: "2026-10-22", state: "verified" };
    showReceipt({ payment: p, businessName: "Northwind Frozen" });
    const r = document.querySelector('[data-role="receipt"]');
    expect([...r.querySelectorAll("dt")].map((x) => x.textContent)).toEqual(["Business", "Order", "Customer", "Method", "Reference", "Payment date"]);
    expect([...r.querySelectorAll("dd")].map((x) => x.textContent)).toEqual(["Northwind Frozen", "NW-20261022-004", "ABC Store", "Bank transfer", "BDOREF445566", "Oct 22, 2026"]);
    expect(r.querySelector('[data-role="receipt-amount"]').textContent).toBe("₱2,000.00");
    // 2026-10-25: a payment confirmation, never presented as an official (BIR) receipt.
    expect(r.querySelector(".pay-receipt-title").textContent).toBe("Payment confirmation");
    expect(r.querySelector('[data-role="receipt-note"]').textContent).toBe("Not an official receipt.");
    expect(r.getAttribute("aria-label")).toBe("Payment confirmation");
    const api = vi.fn(async () => ({ voided: true }));
    const done = rejectPaymentDialog({ payment: { ...p, state: "for_verification" }, api });
    const f = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    f.elements.reason.value = "Screenshot shows ₱1,800";
    f.dispatchEvent(new Event("submit", { cancelable: true }));
    await done;
    expect(api).toHaveBeenCalledWith("payments", { method: "POST", body: { action: "void", paymentId: "pay1", reason: "Screenshot shows ₱1,800" } });
  });
});

describe("New Order: saved, new or walk-in customer", () => {
  const form = () => document.querySelector(".modal-backdrop form");
  const deps = (api) => ({ listActiveProducts: vi.fn(async () => []), getProducts: vi.fn(async () => ({})), searchCustomers: vi.fn(async () => []), api });
  const owner = () => sessionFixture({ roleTemplate: "owner" });
  const typeIn = (name, value) => {
    form().elements[name].value = value;
    form().elements[name].dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("new customer + Save to Customers: the customer is saved (name, contact, delivery address), then the order is linked to it; a retry doesn't save them twice", async () => {
    let fail = true;
    const api = vi.fn(async (endpoint) => {
      if (endpoint === "customers") return { customerId: "custNEW0000000001" };
      if (fail) {
        fail = false;
        throw new Error("Network down");
      }
      return { orderNumber: "NW-1" };
    });
    const done = openOrderEditor({ session: owner(), deps: deps(api) });
    typeIn("name", "Lim Mart");
    typeIn("phone", "0917 555 0101");
    typeIn("deliveryAddress", "8 Osmeña Blvd");
    const box = form().querySelector('[name="saveCustomer"]');
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(form().querySelector('[data-role="error"]').textContent).toBe("Network down");
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(api.mock.calls.filter(([e]) => e === "customers")).toEqual([["customers", { method: "POST", body: { action: "create", customer: { name: "Lim Mart", phone: "0917 555 0101", address: "8 Osmeña Blvd" } } }]]);
    expect(api.mock.calls.at(-1)[1].body.order).toMatchObject({ customerId: "custNEW0000000001", customer: { name: "Lim Mart" }, deliveryAddress: "8 Osmeña Blvd" });
    await done;
  });

  it("new customer, not saved: a one-time name on the order, no customer record; Walk-in fills 'Walk-in' and the source", async () => {
    const api = vi.fn(async () => ({ orderNumber: "NW-2" }));
    let done = openOrderEditor({ session: owner(), deps: deps(api) });
    typeIn("name", "Juan (one time)");
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(api.mock.calls.map(([e]) => e)).toEqual(["orders"]);
    expect(api.mock.calls[0][1].body.order).not.toHaveProperty("customerId");
    await done;
    done = openOrderEditor({ session: owner(), deps: deps(api) });
    form().querySelector('[data-act="walk-in"]').click();
    expect([form().elements.name.value, form().elements.source.value]).toEqual(["Walk-in", "walk_in"]);
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(api.mock.calls.at(-1)[1].body.order).toMatchObject({ customer: { name: "Walk-in" }, source: "walk_in" });
    expect(api.mock.calls.at(-1)[1].body.order).not.toHaveProperty("customerId");
    await done;
  });

  it("Save to Customers is offered only to whoever may add customers", () => {
    const s = sessionFixture({ roleTemplate: "staff" });
    delete s.member.permissions["customers.manage"];
    openOrderEditor({ session: s, deps: deps(vi.fn()) });
    expect(form().querySelector('[name="saveCustomer"]')).toBeNull();
    expect(form().querySelector('[data-act="walk-in"]')).toBeTruthy();
  });
});

describe("Customer profile: the recurring customer hub", () => {
  it("total orders, total purchased, outstanding balance; the 5 most recent orders with their balance, View orders shows all", async () => {
    const c = { id: "custABC000000000001", name: "ABC Store", phone: "0917 123 4567", address: "12 Rizal St", status: "active", revision: 1, stats: { orderCount: 7, totalOrdered: 2450000, outstandingBalance: 300000, lastOrderAt: new Date("2026-10-22T05:00:00Z"), lastOrderNumber: "NW-7" }, history: [] };
    const orders = Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, orderNumber: `NW-${7 - i}`, createdAt: new Date("2026-10-22T05:00:00Z"), total: 350000, balance: i === 0 ? 300000 : 0, paymentStatus: i === 0 ? "partial" : "paid", fulfillmentStatus: "fulfilled" }));
    const container = document.createElement("main");
    document.body.appendChild(container);
    mountCustomers(container, sessionFixture({ roleTemplate: "owner" }), { data: { listCustomers: vi.fn(async () => ({ rows: [c], hasMore: false })), listCustomerOrders: vi.fn(async () => orders), searchCustomers: vi.fn(async () => []) }, api: vi.fn(), toast: vi.fn() });
    await flush();
    container.querySelector(`[data-customer="${c.id}"] [data-act="view"]`).click();
    await flush();
    const v = document.querySelector('[data-role="customer-view"]');
    expect([v.querySelector('[data-role="order-count"]').textContent, v.querySelector('[data-role="total-purchased"]').textContent, v.querySelector('[data-role="outstanding"]').textContent]).toEqual(["7", "₱24,500.00", "₱3,000.00"]);
    expect([...v.querySelectorAll(".page-actions .btn")].map((b) => b.textContent)).toEqual(["Add order", "View orders"]);
    expect(v.querySelectorAll('[data-role="customer-orders"] .cp-order')).toHaveLength(5);
    expect(v.querySelector('[data-role="balance"]').textContent).toBe("₱3,000.00 due");
    v.querySelector('[data-act="all-orders"]').click();
    expect(document.querySelectorAll('[data-role="customer-orders"] .cp-order')).toHaveLength(7);
  });
});
