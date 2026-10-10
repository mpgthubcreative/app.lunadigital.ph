// @vitest-environment jsdom
// Phase 10 screen: one compact row per expense, "Add expense" as one small
// form, View details with activity, Edit -> Save (only changes sent),
// ⋯ More -> Remove expense (reason required).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, expenseActivity } from "../../src/modules/expenses/index.js";
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
const NOW = () => new Date("2026-10-08T06:00:00Z");
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const session = (role = "owner", overrides) => sessionFixture({ roleTemplate: role, permissions: overrides ? resolvePermissions(role, overrides) : undefined });

const pack = {
  id: "expPACK00000000001",
  date: "2026-10-08",
  category: "packaging",
  amount: 200000,
  payee: "BoxCo",
  method: "gcash",
  reference: "918273645",
  recurring: false,
  notes: "Boxes for the week",
  status: "active",
  revision: 2,
  createdBy: { name: "Carlo" },
  createdAt: new Date("2026-10-08T06:10:00Z"),
  updatedBy: { name: "Carlo" },
  updatedAt: new Date("2026-10-08T06:15:00Z"),
  history: [
    { type: "created", at: new Date("2026-10-08T06:10:00Z"), actor: { name: "Carlo" }, label: "Added Packaging expense ₱2,000" },
    { type: "edited", at: new Date("2026-10-08T06:15:00Z"), actor: { name: "Carlo" }, label: "Amount changed ₱2,000 → ₱1,500" },
  ],
};
const rent = { ...pack, id: "expRENT00000000002", category: "rent", amount: 2500000, payee: "Landlord", method: "bank_transfer", reference: null, recurring: true, history: [] };

function deps(rows = [pack, rent]) {
  return { data: { listExpenses: vi.fn(async () => ({ rows, hasMore: false })) }, api: vi.fn(async () => ({ success: true })), toast: vi.fn(), now: NOW };
}

describe("Expenses page", () => {
  it("is titled by the workspace ('Operating Expenses') with one compact row per expense", async () => {
    mount(container, session(), deps());
    await flush();
    expect(container.querySelector("h1, .page-title").textContent).toMatch(/Operating Expenses/);
    expect([...container.querySelectorAll("thead th")].map((th) => th.textContent.trim())).toEqual(["", "Date", "Category", "Vendor / Payee", "Method", "Reference", "Amount", "Recurring", "Details"]);
    expect(container.querySelector(`[data-expense="${rent.id}"]`).textContent).toMatch(/Oct 8, 2026.*Rent.*Landlord.*Bank Transfer.*—.*₱25,000\.00.*Yes/s);
  });

  it("filters are sent to the paginated query (never the whole history)", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    const form = container.querySelector('[data-role="filters"]');
    form.elements.from.value = "2026-10-01";
    form.elements.to.value = "2026-10-08";
    form.elements.category.value = "packaging";
    form.elements.method.value = "gcash";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(d.data.listExpenses).toHaveBeenLastCalledWith("demo-distributor-a", { filters: { status: "active", from: "2026-10-01", to: "2026-10-08", category: "packaging", method: "gcash" }, cursor: null });
  });

  it("Add expense: one form; amount sent as integer centavos; date defaults to the business's today", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    container.querySelector('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    expect(form.elements.date.value).toBe("2026-10-08");
    expect(form.elements.date.getAttribute("max")).toBe("2026-10-08");
    form.elements.category.value = "packaging";
    form.elements.amount.value = "2,000.50";
    form.elements.payee.value = "BoxCo";
    form.elements.method.value = "gcash";
    form.elements.reference.value = "918273645";
    form.elements.recurring.value = "yes";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("expenses", { method: "POST", body: { action: "create", expense: { date: "2026-10-08", category: "packaging", amount: 200050, payee: "BoxCo", method: "gcash", reference: "918273645", recurring: true } } });
  });

  it("₱0 or a blank amount is caught in the form", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    container.querySelector('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    form.elements.amount.value = "0";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(form.querySelector('[data-role="error"]').textContent).toMatch(/more than ₱0/);
    expect(d.api).not.toHaveBeenCalled();
  });

  it("View details: every field, who/when, and a plain-language activity log", async () => {
    mount(container, session(), deps());
    await flush();
    container.querySelector(`[data-expense="${pack.id}"] [data-act="view"]`).click();
    const view = document.querySelector('[data-role="expense-view"]');
    expect(view.querySelector('[data-role="expense-fields"]').textContent).toMatch(/Oct 8, 2026.*₱2,000\.00.*Packaging.*BoxCo.*GCash.*918273645.*No.*Boxes for the week.*Carlo/s);
    expect(expenseActivity(pack, { timezone: "Asia/Manila" })).toEqual([expect.stringMatching(/2:10.*PM • Carlo • Added Packaging expense ₱2,000/), expect.stringMatching(/2:15.*PM • Carlo • Amount changed ₱2,000 → ₱1,500/)]);
  });

  it("Edit -> Save sends only what changed; ⋯ More -> Remove asks for a reason", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    container.querySelector(`[data-expense="${pack.id}"] [data-act="view"]`).click();
    document.querySelector('[data-role="expense-view"] [data-act="edit"]').click();
    await flush();
    let form = lastForm();
    form.elements.amount.value = "1500";
    form.elements.category.value = "supplies";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenCalledWith("expenses", { method: "POST", body: { action: "update", expenseId: pack.id, expectedRevision: 2, changes: { category: "supplies", amount: 150000 } } });
    container.querySelector(`[data-expense="${pack.id}"] [data-act="view"]`).click();
    document.querySelector('[data-role="expense-view"] [data-act="remove"]').click();
    await flush();
    form = lastForm();
    form.elements.reason.value = "Duplicate entry";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(d.api).toHaveBeenLastCalledWith("expenses", { method: "POST", body: { action: "remove", expenseId: pack.id, reason: "Duplicate entry" } });
  });

  it("view-only (expenses.view without create/update/delete): no Add, Edit or Remove", async () => {
    mount(container, session("staff", { grant: ["expenses.view"] }), deps());
    await flush();
    expect(container.querySelector('[data-act="new"]')).toBeNull();
    container.querySelector(`[data-expense="${pack.id}"] [data-act="view"]`).click();
    expect([...document.querySelectorAll('[data-role="expense-view"] .modal-footer button')].map((b) => b.textContent.trim())).toEqual(["Close"]);
  });

  it("a removed expense shows its badge and offers no actions", async () => {
    mount(container, session(), deps([{ ...pack, status: "removed" }]));
    await flush();
    container.querySelector(`[data-expense="${pack.id}"] [data-act="view"]`).click();
    const view = document.querySelector('[data-role="expense-view"]');
    expect(view.textContent).toMatch(/Removed/);
    expect([...view.querySelectorAll(".modal-footer button")].map((b) => b.textContent.trim())).toEqual(["Close"]);
  });
});
