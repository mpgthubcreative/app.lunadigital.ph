// @vitest-environment jsdom
// Luna Household Grocery List screens: Owner (My Grocery List | Sample
// Grocery List, Bought (n) fold, Clear bought, Record grocery expense),
// household staff in their portal (tick only; add when allowed), the
// navigation (under More; phone tabs unchanged) and the Expenses hand-off.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountGrocery } from "../../src/modules/household/grocery.js";
import { mount as mountExpenses } from "../../src/modules/household/expenses.js";
import { mountStaffPortal } from "../../src/staff/portal.js";
import { MODULE_LOADERS } from "../../src/modules/loaders.js";
import { buildRoutes } from "../../src/app/routes.js";
import { renderShell } from "../../src/app/shell.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const home = (role = "owner") => sessionFixture({ roleTemplate: role, planId: "household-plus", workspaceTemplateId: "household-payroll" });
let container;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><main id="content"></main>';
  container = document.getElementById("content");
});
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const $ = (sel, root = container) => root.querySelector(sel);
const $$ = (sel, root = container) => [...root.querySelectorAll(sel)];

const ROWS = [
  { id: "itemEggs000001", name: "Eggs", nameLower: "eggs", qty: "2 trays", category: "Dairy & Eggs", bought: false },
  { id: "itemRice000001", name: "Rice", nameLower: "rice", qty: "5 kg", category: "Pantry", bought: false },
  { id: "itemSalt000001", name: "Salt", nameLower: "salt", qty: null, category: "Pantry", bought: true, boughtAt: new Date("2026-10-16T02:00:00Z") },
];
function fakeData(extra = {}) {
  const rows = ROWS.map((r) => ({ ...r }));
  return {
    rows,
    listGrocery: vi.fn(async () => rows.map((r) => ({ ...r }))),
    grocerySettings: vi.fn(async () => ({ staffCanAdd: false })),
    groceryApi: vi.fn(async (b) => (b.action === "addMany" ? { added: b.items.length, items: [] } : {})),
    ...extra,
  };
}

describe("navigation", () => {
  it("Grocery List sits under More; phone tabs stay Payroll · Attendance · Expenses + More", async () => {
    const s = home();
    expect(buildRoutes(s).map((r) => r.path)).toContain("/grocery-list");
    renderShell(document.getElementById("app"), s);
    expect($$(".tabbar .tab-link", document).map((a) => a.textContent.trim())).toEqual(["Payroll", "Attendance", "Expenses", "More"]);
    expect($$(".nav-link", document).map((a) => a.textContent.trim())).toEqual(["Payroll", "Attendance", "Expenses", "Advances", "Household Staff", "Bills", "Grocery List", "Export & Backup", "Users", "Subscription", "Settings"]);
    expect((await MODULE_LOADERS.grocery(s)).mount).toBe(mountGrocery);
  });
  it("the kasambahay's account: Grocery List only through their portal; no money routes", () => {
    const paths = buildRoutes(home("household_staff")).map((r) => r.path);
    for (const p of ["/expenses", "/payment-schedule", "/budget"]) expect(paths).not.toContain(p);
  });
});

describe("Owner: My Grocery List", () => {
  it("active items first (by category), one line each with qty · category; bought folded into Bought (1)", async () => {
    mountGrocery(container, home(), { data: fakeData() });
    await flush();
    expect($$('[data-role="grocery"] .wl-name').map((e) => e.textContent)).toEqual(["Eggs", "Rice"]);
    expect($('[data-item="itemEggs000001"] .wl-sub').textContent).toBe("2 trays · Dairy & Eggs");
    const fold = $('[data-role="bought"]');
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary").textContent).toBe("Bought (1)");
    expect($('[data-role="record-expense"]').getAttribute("href")).toBe("/expenses?add=groceries");
    expect($('[data-act="clear"]')).toBeTruthy();
  });

  it("ticking an item moves it to Bought at once and saves", async () => {
    const data = fakeData();
    mountGrocery(container, home(), { data });
    await flush();
    const box = $('[data-item="itemEggs000001"] .gl-check');
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect($('[data-role="bought"] summary').textContent).toBe("Bought (2)");
    expect(data.groceryApi).toHaveBeenCalledWith({ action: "check", itemId: "itemEggs000001", bought: true });
  });

  it("+ Add item: Item, Qty, Category", async () => {
    const data = fakeData();
    mountGrocery(container, home(), { data });
    await flush();
    $('[data-act="new"]').click();
    await flush();
    const f = lastForm();
    expect([...f.elements].filter((e) => e.name).map((e) => e.name)).toEqual(["name", "qty", "category"]);
    f.elements.name.value = "Dish soap";
    f.elements.qty.value = "2 bottles";
    f.elements.category.value = "Household Supplies";
    submit(f);
    await flush();
    expect(data.groceryApi).toHaveBeenCalledWith({ action: "add", item: { name: "Dish soap", qty: "2 bottles", category: "Household Supplies" } });
  });

  it("Sample Grocery List: + Add one, or select several -> Add selected; items on the list show On list ✓", async () => {
    const data = fakeData();
    mountGrocery(container, home(), { data });
    await flush();
    $('[data-act="seg"][data-value="sample"]').click();
    await flush();
    expect($$(".wl-sample-group .wl-group-title").map((e) => e.textContent)).toContain("Fresh Produce");
    expect($$('[data-role="added"]').length).toBe(2); // Eggs and Rice are on the list
    $('[aria-label="Add Onion"]').click();
    await flush();
    expect(data.groceryApi).toHaveBeenCalledWith({ action: "addMany", items: [{ name: "Onion", category: "Fresh Produce" }], source: "sample" });
    $('[data-act="seg"][data-value="sample"]').click();
    for (const n of ["Garlic", "Diapers"]) {
      const b = $(`[aria-label="Select ${n}"]`);
      b.checked = true;
      b.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect($('[data-act="add-picked"]').textContent).toBe("Add selected (2)");
    $('[data-act="add-picked"]').click();
    await flush();
    expect(data.groceryApi).toHaveBeenLastCalledWith({ action: "addMany", items: [{ name: "Garlic", category: "Fresh Produce" }, { name: "Diapers", category: "Baby" }], source: "sample" });
  });

  it("Helpers can add items: the Owner's switch", async () => {
    const data = fakeData();
    mountGrocery(container, home(), { data, toast: () => {} });
    await flush();
    const sw = $('[data-act="staff-add"]');
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(data.groceryApi).toHaveBeenCalledWith({ action: "settings", staffCanAdd: true });
  });
});

describe("Household staff (portal)", () => {
  const staffSession = () => ({ ...home("household_staff"), member: { ...home("household_staff").member, permissions: { "attendance.self": true, "payroll.self": true, "advances.self": true, "grocery.view": true, "grocery.check": true } } });
  const me = { staff: { name: "Loriza Ibanez" }, salaries: [], advances: [], sheet: null, period: { estimate: { netPay: 0 } } };

  it("a Grocery tab: tick items; no + Add, no ⋯, no Clear, no Record expense (unless the Owner allows adding)", async () => {
    const data = fakeData();
    const root = document.getElementById("app");
    mountStaffPortal(root, staffSession(), { api: async () => ({ me }), loadGrocery: async () => ({ mount: (el, s, o) => mountGrocery(el, s, { ...o, data }) }) });
    await flush();
    expect($$(".staff-tab", root).map((b) => b.textContent)).toContain("Grocery");
    $('[data-tab="grocery"]', root).click();
    await flush();
    expect($$('[data-role="grocery"] .wl-name', root).map((e) => e.textContent)).toEqual(["Eggs", "Rice"]);
    expect($('[data-act="new"]', root)).toBeNull();
    expect($(".line-menu", root)).toBeNull();
    expect($('[data-act="clear"]', root)).toBeNull();
    expect($('[data-role="record-expense"]', root)).toBeNull();
    const box = $('[data-item="itemRice000001"] .gl-check', root);
    expect(box.disabled).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(data.groceryApi).toHaveBeenCalledWith({ action: "check", itemId: "itemRice000001", bought: true });
  });

  it("with \"Helpers can add items\" on, staff get + Add item and Add selected", async () => {
    const data = fakeData({ grocerySettings: vi.fn(async () => ({ staffCanAdd: true })) });
    mountGrocery(container, staffSession(), { data, portal: true });
    await flush();
    expect($('[data-act="new"]')).toBeTruthy();
    expect($('[data-act="staff-add"]')).toBeNull();
  });
});

describe("Expenses hand-off", () => {
  it("/expenses?add=groceries opens Record grocery expense with Groceries and today; the Owner types the total", async () => {
    const data = {
      householdMonth: vi.fn(async () => null),
      listCategories: vi.fn(async () => [{ id: "catGroceries01", name: "Groceries", status: "active" }]),
      listExpenses: vi.fn(async () => ({ rows: [], hasMore: false })),
      expensesApi: vi.fn(async () => ({ expenseId: "expNew0000001" })),
      budgetApi: vi.fn(),
    };
    mountExpenses(container, home(), { data, now: () => new Date("2026-10-17T04:00:00Z"), location: { search: "?add=groceries" } });
    await flush();
    const f = lastForm();
    expect(f.closest(".modal").textContent).toContain("Record grocery expense");
    expect(f.elements.category.value).toBe("Groceries");
    expect(f.elements.date.value).toBe("2026-10-17");
    f.elements.amount.value = "2350";
    submit(f);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", expense: { date: "2026-10-17", amount: 235000, method: "cash", category: "catGroceries01" } });
  });
});
