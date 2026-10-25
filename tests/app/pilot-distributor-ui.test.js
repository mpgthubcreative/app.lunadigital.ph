// @vitest-environment jsdom
// Distributor pilot readiness (2026-10-25), on screen: Customers → Who owes
// us (total, balance, oldest unpaid, what makes it up, opening balance
// payment) and special prices in New Order (the price the server will use,
// marked "special"; lines already on an order keep theirs).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountCustomers } from "../../src/modules/customers/index.js";
import { openOrderEditor } from "../../src/modules/orders/editor.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
  history.replaceState(null, "", "/customers");
});
const owner = () => sessionFixture({ roleTemplate: "owner", workspaceTemplateId: "distributor" });
const empty = { rows: [], hasMore: false };
const ABC = { id: "cABC", name: "ABC Restaurant", status: "active", stats: { outstandingBalance: 50000, orderCount: 1 } };
const JUAN = { id: "cJUAN", name: "Juan Store", status: "active", stats: { outstandingBalance: 185000, orderCount: 0 } };

describe("Customers → Who owes us", () => {
  it("TOTAL UNPAID, one row per customer (balance, oldest unpaid), View shows what makes it up; an opening balance can be paid", async () => {
    const api = vi.fn(async () => ({ success: true, balance: 0 }));
    const data = {
      listCustomers: vi.fn(async () => ({ rows: [ABC, JUAN], hasMore: false })),
      listCustomersWithBalance: vi.fn(async () => [JUAN, ABC]),
      listUnpaidOrders: vi.fn(async () => [{ id: "o1", customerId: "cABC", orderNumber: "BA-1001", orderDate: "2026-10-13", balance: 50000, amountPaid: 0, total: 50000, fulfillmentStatus: "pending" }]),
      listOpenOpeningBalances: vi.fn(async () => [{ id: `ob${"a".repeat(30)}`, customerId: "cJUAN", effectiveDay: "2026-10-01", balance: 185000, status: "open", note: "From the old notebook" }]),
      listCustomerOrders: vi.fn(async () => []),
      listCustomerPrices: vi.fn(async () => []),
    };
    mountCustomers(container, owner(), { data, api, toast: () => {} });
    await flush();
    container.querySelector('[data-seg="view"][data-value="owed"]').click();
    await flush();
    expect(container.querySelector('[data-role="total-unpaid-amount"]').textContent).toBe("₱2,350.00");
    const rows = [...container.querySelectorAll('[data-role="receivables"] tbody tr')].map((tr) => [tr.querySelector(".cell-strong").textContent, tr.querySelector('[data-col="balance"]').textContent, tr.querySelector('[data-col="oldest"]').textContent]);
    expect(rows[0][0]).toBe("Juan Store");
    expect(rows[0][1]).toBe("₱1,850.00");
    expect(rows[1][0]).toBe("ABC Restaurant");
    expect(container.querySelector('[data-role="walkin-note"]').textContent).toMatch(/walk-in/);
    // View: what makes up Juan's balance (the opening balance), with Record payment.
    container.querySelector('[data-act="view-owed"][data-id="cJUAN"]').click();
    await flush();
    const items = document.querySelector('[data-role="balance-items"]');
    expect(items.textContent).toMatch(/Opening balance[\s\S]*₱1,850\.00 due[\s\S]*From the old notebook/);
    items.querySelector('[data-act="ob-pay"]').click();
    await flush();
    const f = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    f.elements.amount.value = "500";
    f.elements.method.value = "gcash";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const body = api.mock.calls.find(([, o]) => o.body.action === "payOpening")[1].body;
    expect(body).toMatchObject({ action: "payOpening", openingBalanceId: `ob${"a".repeat(30)}`, amount: 50000, method: "gcash" });
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
});

describe("New Order: special prices", () => {
  const products = [
    { id: "pSIO", sku: "SIO-1", name: "Siomai", unit: "pcs", sellingPrice: 5500, available: 100000, status: "active" },
    { id: "pTOC", sku: "TOC-1", name: "Tocino", unit: "pcs", sellingPrice: 12000, available: 100000, status: "active" },
  ];
  const deps = (over = {}) => ({ listActiveProducts: vi.fn(async () => products), getProducts: vi.fn(async () => ({})), searchCustomers: vi.fn(async () => []), api: vi.fn(async () => ({ success: true })), listCustomerPrices: vi.fn(async () => [{ productId: "pSIO", price: 5000 }]), ...over });
  const form = () => document.querySelector(".modal-backdrop form");
  const pick = (id) => {
    form().elements.product.value = id;
    form().elements.product.dispatchEvent(new Event("change", { bubbles: true }));
  };
  it("a linked customer's special price shows (marked special); other products and walk-ins use the normal price", async () => {
    const d = deps();
    openOrderEditor({ session: owner(), deps: d, prefill: { customerId: "cABC", customer: { name: "ABC Restaurant", phone: "" } } });
    await flush();
    expect(d.listCustomerPrices).toHaveBeenCalledWith("cABC");
    expect([...form().elements.product.options].map((o) => o.textContent).join("|")).toMatch(/Siomai · ₱50\.00 \(special\)/);
    pick("pSIO");
    pick("pTOC");
    const prices = [...form().querySelectorAll('[data-col="unitPrice"]')].map((x) => x.textContent.replace(/\s+/g, " ").trim());
    expect(prices).toEqual(["× ₱50.00 special", "× ₱120.00"]);
    // Unlinking the customer: back to normal prices.
    form().querySelector('[data-act="unlink"]')?.click();
    await flush();
    expect([...form().querySelectorAll('[data-col="unitPrice"]')].map((x) => x.textContent.trim())[0]).toBe("× ₱55.00");
  });
  it("editing an existing order: its lines keep the price they were added at", async () => {
    const d = deps({ listCustomerPrices: vi.fn(async () => [{ productId: "pSIO", price: 4000 }]) });
    const order = { id: "o1", orderNumber: "BA-1", customerId: "cABC", customer: { name: "ABC Restaurant" }, source: "phone", fulfillmentStatus: "pending", discount: 0, revision: 2, items: [{ productId: "pSIO", sku: "SIO-1", name: "Siomai", unit: "pcs", unitPrice: 5000, quantity: 2000, customerPrice: true }] };
    openOrderEditor({ session: owner(), deps: d, order });
    await flush();
    expect([...form().querySelectorAll('[data-col="unitPrice"]')].map((x) => x.textContent.replace(/\s+/g, " ").trim())).toEqual(["× ₱50.00 special"]);
  });
});
