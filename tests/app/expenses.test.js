// @vitest-environment jsdom
// Costs (Luna Business, Owner pilot 2026-10-19): one page, two sections.
// Operating Expenses: compact rows for the month, its total, ⋯ Edit /
// Remove, + Add item (Expense, Amount, Date up front). COGS: each product's
// current unit cost, ⋯ Edit, + Add item. No activity / added / changed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, expenseName } from "../../src/modules/expenses/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { centavosToCostUnits } from "../../shared/quantity.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const NOW = () => new Date("2026-10-18T06:00:00Z");
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (f) => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const session = (role = "owner", overrides) => sessionFixture({ roleTemplate: role, permissions: overrides ? resolvePermissions(role, overrides) : undefined });

const exp = (id, payee, amount, date, extra = {}) => ({ id, payee, amount, date, category: "rent", method: "cash", status: "active", revision: 1, createdBy: { name: "Carlo" }, createdAt: new Date(), updatedAt: new Date(), history: [{ label: "Added" }], ...extra });
const EXPENSES = [exp("expRENT000000000001", "Rent", 250000, "2026-10-01"), exp("expWATER00000000001", "Water", 100000, "2026-10-05"), exp("expSALARY0000000001", "Salary", 240000, "2026-10-15"), exp("expNOPAYEE000000001", null, 5000, "2026-10-16", { category: "utilities" })];
const PRODUCTS = [{ id: "prodKOPI000000001", name: "Hayst Kopi", status: "active" }, { id: "prodCHOCO00000001", name: "Hayst Choco", status: "active" }, { id: "prodNEW0000000001", name: "Hayst Matcha", status: "active" }];
const COSTS = { prodKOPI000000001: { avgCostUnits: centavosToCostUnits(4300) }, prodCHOCO00000001: { avgCostUnits: centavosToCostUnits(3850) }, prodNEW0000000001: { avgCostUnits: null } };
function deps({ expenses = EXPENSES } = {}) {
  return {
    data: { listExpenses: vi.fn(async () => ({ rows: expenses, hasMore: false })) },
    inventoryData: { listProducts: vi.fn(async () => ({ rows: PRODUCTS, hasMore: false })), loadCostDocs: vi.fn(async () => COSTS) },
    api: vi.fn(async () => ({ success: true })),
    toast: vi.fn(),
    now: NOW,
  };
}

describe("Costs page", () => {
  it("two sections: Operating Expenses (this month's rows + total) and COGS (unit cost per product); nothing technical", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    expect(container.querySelector("h1").textContent).toBe("Costs");
    expect([...container.querySelectorAll(".cost-title")].map((h) => h.textContent)).toEqual(["Operating Expenses", "COGS"]);
    expect(d.data.listExpenses).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ filters: { status: "active", from: "2026-10-01", to: "2026-10-31" } }));
    expect(container.querySelector('[data-role="month"]').textContent).toBe("Oct 2026");
    expect(container.querySelector('[data-role="opex-total"]').textContent).toBe("₱5,950");
    const rows = [...container.querySelectorAll('[data-role="expenses"] .wl-row')].map((li) => [li.querySelector(".wl-name").textContent, li.querySelector(".wl-amt").textContent]);
    expect(rows).toEqual([["Utilities", "₱50"], ["Salary", "₱2,400"], ["Water", "₱1,000"], ["Rent", "₱2,500"]]);
    const cogs = [...container.querySelectorAll('[data-role="cogs"] .wl-row')].map((li) => [li.querySelector(".wl-name").textContent, li.querySelector(".wl-amt").textContent]);
    expect(cogs).toEqual([["Hayst Choco", "₱38.50"], ["Hayst Kopi", "₱43"]]);
    expect(container.textContent).not.toMatch(/Activity|Added|Last changed|average|valuation|Stock value/i);
    expect([...container.querySelectorAll(".cost-add")].map((b) => b.textContent)).toEqual(["+ Add item", "+ Add item"]);
  });

  it("Add item asks Expense, Amount, Date first (the rest under More details); amount in centavos", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    container.querySelector('[data-act="exp-add"]').click();
    const f = lastForm();
    const shown = [...f.querySelectorAll("input, select, textarea")].filter((e) => !e.closest("details")).map((e) => e.name);
    expect(shown).toEqual(["payee", "amount", "date"]);
    expect(f.querySelector("details.form-more")).not.toBeNull();
    expect(f.elements.date.value).toBe("2026-10-18");
    f.elements.payee.value = "Internet";
    f.elements.amount.value = "1,299.50";
    submit(f);
    await flush();
    expect(d.api).toHaveBeenCalledWith("expenses", { method: "POST", body: { action: "create", expense: { date: "2026-10-18", category: "misc", amount: 129950, payee: "Internet", method: "cash", recurring: false } } });
    expect(d.toast).toHaveBeenCalledWith("Expense added.", "success");
  });

  it("a missing name or ₱0 is caught in the form; nothing is sent", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    container.querySelector('[data-act="exp-add"]').click();
    const f = lastForm();
    f.elements.amount.value = "100";
    submit(f);
    await flush();
    expect(f.querySelector('[data-role="error"]').textContent).toMatch(/what the expense is for/);
    f.elements.payee.value = "Rent";
    f.elements.amount.value = "0";
    submit(f);
    await flush();
    expect(f.querySelector('[data-role="error"]').textContent).toMatch(/more than ₱0/);
    expect(d.api).not.toHaveBeenCalled();
  });

  it("⋯ Edit sends only what changed; ⋯ Remove asks for a reason", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    const row = container.querySelector('[data-expense="expRENT000000000001"]');
    expect([...row.querySelectorAll(".menu-item")].map((b) => b.textContent)).toEqual(["Edit", "Remove"]);
    row.querySelector('[data-act="exp-edit"]').click();
    let f = lastForm();
    f.elements.amount.value = "2600";
    submit(f);
    await flush();
    expect(d.api).toHaveBeenLastCalledWith("expenses", { method: "POST", body: { action: "update", expenseId: "expRENT000000000001", expectedRevision: 1, changes: { amount: 260000 } } });
    container.querySelector('[data-expense="expRENT000000000001"] [data-act="exp-remove"]').click();
    f = lastForm();
    f.elements.reason.value = "Entered twice";
    submit(f);
    await flush();
    expect(d.api).toHaveBeenLastCalledWith("expenses", { method: "POST", body: { action: "remove", expenseId: "expRENT000000000001", reason: "Entered twice" } });
  });

  it("‹ › moves between months (never past this month)", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    expect(container.querySelector('[data-act="month-next"]').disabled).toBe(true);
    container.querySelector('[data-act="month-prev"]').click();
    await flush();
    expect(container.querySelector('[data-role="month"]').textContent).toBe("Sep 2026");
    expect(d.data.listExpenses).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ filters: { status: "active", from: "2026-09-01", to: "2026-09-30" } }));
  });

  it("COGS: + Add item offers products without a cost; ⋯ Edit sets the unit cost (centavos)", async () => {
    const d = deps();
    mount(container, session(), d);
    await flush();
    container.querySelector('[data-act="cogs-add"]').click();
    let f = lastForm();
    expect([...f.elements.productId.options].map((o) => o.textContent)).toEqual(["Hayst Matcha"]);
    f.elements.unitCost.value = "52";
    submit(f);
    await flush();
    expect(d.api).toHaveBeenLastCalledWith("products", { method: "POST", body: { action: "setUnitCost", productId: "prodNEW0000000001", unitCost: 5200 } });
    container.querySelector('[data-product="prodKOPI000000001"] [data-act="cogs-edit"]').click();
    f = lastForm();
    expect(f.elements.unitCost.value).toBe("43");
    f.elements.unitCost.value = "45.25";
    submit(f);
    await flush();
    expect(d.api).toHaveBeenLastCalledWith("products", { method: "POST", body: { action: "setUnitCost", productId: "prodKOPI000000001", unitCost: 4525 } });
    expect(d.toast).toHaveBeenCalledWith("Cost per unit saved.", "success");
  });

  it("who sees what: without inventory.costs no COGS; without products.manage COGS is read-only; view-only expenses have no Add / ⋯", async () => {
    let d = deps();
    mount(container, session("owner", { revoke: ["inventory.costs"] }), d);
    await flush();
    expect(container.querySelector('[data-section="cogs"]')).toBeNull();
    expect(d.inventoryData.loadCostDocs).not.toHaveBeenCalled();
    document.body.innerHTML = '<main id="content"></main>';
    container = document.getElementById("content");
    d = deps();
    mount(container, session("owner", { revoke: ["products.manage", "expenses.create", "expenses.update", "expenses.delete"] }), d);
    await flush();
    expect(container.querySelector('[data-role="cogs"] .wl-row')).not.toBeNull();
    expect(container.querySelector('[data-act="cogs-add"], [data-act="cogs-edit"], [data-act="exp-add"], [data-act="exp-edit"], [data-act="exp-remove"]')).toBeNull();
  });

  it("an empty month says so; the row name falls back to the category", async () => {
    mount(container, session(), deps({ expenses: [] }));
    await flush();
    expect(container.querySelector('[data-role="opex-empty"]').textContent).toBe("No operating expenses in Oct 2026.");
    expect(container.querySelector('[data-role="opex-total"]').textContent).toBe("₱0");
    expect(expenseName({ payee: null, category: "utilities" })).toBe("Utilities");
  });
});
