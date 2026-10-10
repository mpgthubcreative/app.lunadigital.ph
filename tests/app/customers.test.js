// @vitest-environment jsdom
// Phase 9 screens: the compact Customers page (one row per customer, View
// details with order history and activity, Edit -> Save, ⋯ More) and the
// order editor's saved-customer picker.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountCustomers, customerActivity } from "../../src/modules/customers/index.js";
import { openOrderEditor } from "../../src/modules/orders/editor.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const session = (role = "owner", overrides) => sessionFixture({ roleTemplate: role, permissions: overrides ? resolvePermissions(role, overrides) : undefined });
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);

const abc = {
  id: "custABC000000000001",
  name: "ABC Store",
  company: "ABC Trading",
  phone: "0917 123 4567",
  email: "owner@abc.ph",
  address: "12 Rizal St, Cebu",
  status: "active",
  revision: 2,
  stats: { orderCount: 3, totalOrdered: 2450000, outstandingBalance: 600000, lastOrderAt: new Date("2026-10-08T05:22:00Z"), lastOrderNumber: "BA-20261008-003" },
  history: [
    { type: "created", at: new Date("2026-10-01T02:00:00Z"), actor: { name: "Carlo" } },
    { type: "edited", at: new Date("2026-10-08T05:30:00Z"), actor: { name: "Marianne" }, label: "Phone changed 0917 000 0000 → 0917 123 4567" },
  ],
};
const neverOrdered = { ...abc, id: "custNEW000000000002", name: "New Mart", company: null, stats: { orderCount: 0, totalOrdered: 0, outstandingBalance: 0, lastOrderAt: null } };

function deps() {
  return {
    data: {
      listCustomers: vi.fn(async () => ({ rows: [abc, neverOrdered], hasMore: false })),
      listCustomerOrders: vi.fn(async () => [{ id: "o1", orderNumber: "BA-20261008-003", createdAt: new Date("2026-10-08T05:22:00Z"), total: 1000000, balance: 600000, paymentStatus: "partial", fulfillmentStatus: "fulfilled" }]),
    },
    api: vi.fn(async () => ({ success: true })),
    toast: vi.fn(),
  };
}

describe("Customers page", () => {
  it("one compact row per customer with the standard columns", async () => {
    mountCustomers(container, session("staff"), deps());
    await flush();
    expect([...container.querySelectorAll("thead th")].map((th) => th.textContent.trim())).toEqual(["", "Customer", "Company", "Phone", "Orders", "Total ordered", "Balance", "Last order", "Status", "Details"]);
    expect(container.querySelector(`[data-customer="${abc.id}"]`).textContent).toMatch(/ABC Store.*ABC Trading.*0917 123 4567.*3.*₱24,500\.00.*₱6,000\.00.*BA-20261008-003.*Active/s);
  });

  it("filter chips: none at the default (Active); Inactive shows a chip; × goes back to Active", async () => {
    const d = deps();
    mountCustomers(container, session("staff"), d);
    await flush();
    expect(container.querySelector('[data-chip="status"]')).toBeNull();
    const form = container.querySelector('[data-role="filters"]');
    form.elements.status.value = "inactive";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(container.querySelector('[data-chip="status"]').textContent).toMatch(/Inactive/);
    container.querySelector('[data-clear-filter="status"]').click();
    await flush();
    expect(container.querySelector('[data-role="filters"]').elements.status.value).toBe("active");
    expect(container.querySelector('[data-chip="status"]')).toBeNull();
  });

  it("View details: contact, stats, order history and plain-language activity", async () => {
    const d = deps();
    mountCustomers(container, session("staff"), d);
    await flush();
    container.querySelector(`[data-customer="${abc.id}"] [data-act="view"]`).click();
    await flush();
    const view = document.querySelector('[data-role="customer-view"]');
    expect(view.querySelector('[data-role="customer-stats"]').textContent).toMatch(/Orders\s*3.*Total ordered\s*₱24,500\.00.*Outstanding balance\s*₱6,000\.00/s);
    expect(d.data.listCustomerOrders).toHaveBeenCalledWith("demo-distributor-a", abc.id);
    expect(view.querySelector('[data-role="customer-orders"]').textContent).toMatch(/BA-20261008-003.*₱10,000\.00.*₱6,000\.00.*Partially paid.*Fulfilled/s);
    expect(customerActivity(abc, { timezone: "Asia/Manila" })[1]).toMatch(/1:30.*PM • Marianne • Phone changed 0917 000 0000 → 0917 123 4567/);
  });

  it("without orders.view the order history isn't requested", async () => {
    const d = deps();
    mountCustomers(container, session("staff", { revoke: ["orders.view"] }), d);
    await flush();
    container.querySelector(`[data-customer="${abc.id}"] [data-act="view"]`).click();
    await flush();
    expect(d.data.listCustomerOrders).not.toHaveBeenCalled();
    expect(document.querySelector('[data-role="customer-orders"]')).toBeNull();
  });

  it("customers.manage: New customer, Edit, ⋯ More (Deactivate; Delete only if never ordered)", async () => {
    const d = deps();
    mountCustomers(container, session("owner"), d);
    await flush();
    expect(container.querySelector('[data-act="new"]')).not.toBeNull();
    container.querySelector(`[data-customer="${abc.id}"] [data-act="view"]`).click();
    await flush();
    let menu = document.querySelector('[data-role="more-menu"]');
    expect([...menu.querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Deactivate customer"]);
    document.querySelector('[data-role="customer-view"] [data-act="close"]').click();
    container.querySelector(`[data-customer="${neverOrdered.id}"] [data-act="view"]`).click();
    await flush();
    menu = document.querySelector('[data-role="more-menu"]');
    expect([...menu.querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual(["Deactivate customer", "Delete customer"]);
  });

  it("without customers.manage: read-only", async () => {
    mountCustomers(container, session("staff", { revoke: ["customers.manage"] }), deps());
    await flush();
    expect(container.querySelector('[data-act="new"]')).toBeNull();
    container.querySelector(`[data-customer="${abc.id}"] [data-act="view"]`).click();
    await flush();
    expect([...document.querySelectorAll('[data-role="customer-view"] .modal-footer button')].map((b) => b.textContent.trim())).toEqual(["Close"]);
  });

  it("Edit -> Save sends only what changed", async () => {
    const d = deps();
    mountCustomers(container, session("owner"), d);
    await flush();
    container.querySelector(`[data-customer="${abc.id}"] [data-act="view"]`).click();
    await flush();
    document.querySelector('[data-role="customer-view"] [data-act="edit"]').click();
    await flush();
    const form = lastForm();
    form.elements.phone.value = "0918 555 0000";
    form.elements.company.value = "";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("customers", { method: "POST", body: { action: "update", customerId: abc.id, expectedRevision: 2, changes: { phone: "0918 555 0000", company: null } } });
  });

  it("a possible duplicate (same phone) is flagged after saving", async () => {
    const d = deps();
    d.api = vi.fn(async () => ({ success: true, customerId: "x", possibleDuplicate: { customerId: abc.id, name: "ABC Store" } }));
    mountCustomers(container, session("owner"), d);
    await flush();
    container.querySelector('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    form.elements.name.value = "ABC Store 2";
    form.elements.phone.value = "+63 917 123 4567";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api.mock.calls[0][1].body).toEqual({ action: "create", customer: { name: "ABC Store 2", phone: "+63 917 123 4567" } });
    expect(d.toast).toHaveBeenCalledWith(expect.stringMatching(/same phone as ABC Store/), "warning");
  });
});

describe("order editor: saved customer or walk-in", () => {
  const editorDeps = (over = {}) => ({ listActiveProducts: vi.fn(async () => []), getProducts: vi.fn(async () => ({})), searchCustomers: vi.fn(async () => [abc]), api: vi.fn(async () => ({ success: true })), ...over });
  const form = () => document.querySelector(".modal-backdrop form");

  it("Find saved customer -> Use links it; the payload carries customerId", async () => {
    const d = editorDeps();
    const done = openOrderEditor({ session: session("staff"), deps: d });
    form().elements.name.value = "abc";
    form().elements.name.dispatchEvent(new Event("input", { bubbles: true }));
    form().querySelector('[data-act="find-customer"]').click();
    await flush();
    expect(d.searchCustomers).toHaveBeenCalledWith("abc");
    form().querySelector('[data-act="use-customer"]').click();
    expect(form().elements.name.value).toBe("ABC Store");
    expect(form().elements.name.readOnly).toBe(true);
    expect(form().querySelector('[data-role="linked"]').textContent).toMatch(/Saved customer: ABC Store/);
    form().elements.source.value = "walk_in";
    form().elements.source.dispatchEvent(new Event("change", { bubbles: true }));
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api.mock.calls[0][1].body.order).toMatchObject({ customerId: abc.id, customer: { name: "ABC Store", phone: "0917 123 4567" } });
    await done;
  });

  it("walk-in: no customerId is sent", async () => {
    const d = editorDeps();
    const done = openOrderEditor({ session: session("staff"), deps: d });
    form().elements.name.value = "Juan";
    form().elements.name.dispatchEvent(new Event("input", { bubbles: true }));
    form().elements.source.value = "walk_in";
    form().elements.source.dispatchEvent(new Event("change", { bubbles: true }));
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api.mock.calls[0][1].body.order).not.toHaveProperty("customerId");
    await done;
  });

  it("editing a linked order keeps the link unless Unlink is pressed", async () => {
    const linked = { id: "o1", orderNumber: "BA-1", customerId: abc.id, customer: { name: "ABC Store", phone: "0917 123 4567" }, source: "viber", items: [], discount: 0, revision: 4, fulfillmentStatus: "pending" };
    let d = editorDeps();
    let done = openOrderEditor({ session: session("staff"), deps: d, order: linked });
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api.mock.calls[0][1].body.order.customerId).toBe(abc.id);
    await done;
    d = editorDeps();
    done = openOrderEditor({ session: session("staff"), deps: d, order: linked });
    form().querySelector('[data-act="unlink"]').click();
    expect(form().elements.name.readOnly).toBe(false);
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api.mock.calls[0][1].body.order).not.toHaveProperty("customerId");
    await done;
  });

  it("without customers.view there is no picker (walk-in only)", () => {
    openOrderEditor({ session: session("staff", { revoke: ["customers.view"] }), deps: editorDeps() });
    expect(form().querySelector('[data-act="find-customer"]')).toBeNull();
  });
});
