// @vitest-environment jsdom
// Luna Household "Paid by" on the Expenses screen (2026-11-02): one tap in
// the expense form (Mom / Dad / Shared / Other), "Oct 5 · Mom" on the row,
// "Paid by" in Details ("Not specified" for older expenses), and the
// Category + Paid by filters working together with the month.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, filterRows, payerTotalsOf, payerChoices, monthRows, UNSET_PAYER } from "../../src/modules/household/expenses.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const NOW = () => new Date("2026-10-16T04:00:00Z");
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const $ = (sel) => container.querySelector(sel);
const $$ = (sel) => [...container.querySelectorAll(sel)];
const flat = (el) => el.textContent.replace(/\s+/g, " ").trim();
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

const CATS = [
  { id: "catGroceries01", name: "Groceries", budget: null, status: "active", useCount: 3, revision: 1 },
  { id: "catUtilities01", name: "Utilities", budget: null, status: "active", useCount: 1, revision: 1 },
];
const pb = (name, amount) => [{ key: name.toLowerCase(), name, amount }];
const ex = (id, category, amount, payee, payer, date = "2026-10-05") => ({ id, date, category, amount, payee, method: "cash", status: "active", revision: 1, history: [], ...(payer ? { paidBy: pb(payer, amount) } : {}) });
const EXPS = [
  ex("expMom0000001", "catGroceries01", 150000, "SM Supermarket", "Mom", "2026-10-02"),
  ex("expDad0000001", "catGroceries01", 80000, "Puregold", "Dad"),
  ex("expShared0001", "catGroceries01", 60000, "S&R", "Shared"),
  ex("expDadUtil001", "catUtilities01", 300000, "Meralco", "Dad"),
  ex("expOld0000001", "catUtilities01", 20000, "Water", null),
];
const MONTH = { month: "2026-10", spent: 610000, billsRemaining: 0, payroll: [{ id: "pay1", staffName: "Loriza", amount: 556500, paidDate: "2026-10-15" }], bills: [] };
function fakeData(extra = {}) {
  return {
    householdMonth: vi.fn(async (m) => (m === "2026-10" ? MONTH : { ...MONTH, month: m, spent: 0, payroll: [], bills: [] })),
    listCategories: vi.fn(async () => CATS.map((c) => ({ ...c }))),
    listExpenses: vi.fn(async (b, f) => ({ rows: f.from.startsWith("2026-10") ? EXPS.map((e) => ({ ...e })) : [ex("expNov0000001", "catGroceries01", 5000, "Bakery", "Mom", "2026-09-03")], hasMore: false })),
    budgetApi: vi.fn(async () => ({ categoryId: "catNew0000001" })),
    expensesApi: vi.fn(async () => ({ expenseId: "expNew0000001" })),
    scheduleApi: vi.fn(async () => ({})),
    attachExpenseProof: vi.fn(async () => ({})),
    expenseProof: vi.fn(async () => ({ proof: null })),
    ...extra,
  };
}
const mountExp = async (data = fakeData()) => {
  mount(container, sessionFixture({ roleTemplate: "owner", workspaceTemplateId: "household-payroll" }), { data, now: NOW, location: { search: "" }, confirm: async () => true, toast: () => {} });
  await flush();
  return data;
};
const pick = (role, value) => {
  const s = $(`[data-role="${role}"]`);
  s.value = value;
  s.dispatchEvent(new Event("change", { bubbles: true }));
};
const shownNames = () => $$(".wl-name").map((e) => e.textContent);

describe("Paid by in the expense form", () => {
  it("one tap: Mom / Dad / Shared / Other between Category and Date; each records ONE payer with the whole amount", async () => {
    for (const payer of ["Mom", "Dad", "Shared", "Other"]) {
      document.body.innerHTML = '<main id="content"></main>';
      container = document.getElementById("content");
      const data = await mountExp();
      $('[data-act="new"]').click();
      await flush();
      const form = lastForm();
      const radios = [...form.querySelectorAll('input[name="paidBy"]')];
      expect(radios.map((r) => r.value)).toEqual(["Mom", "Dad", "Shared", "Other"]);
      expect(form.querySelector('[data-field="paidBy"] legend').textContent).toBe("Paid by");
      form.elements.amount.value = "1,500";
      form.elements.category.value = "Groceries";
      radios.find((r) => r.value === payer).checked = true;
      form.elements.payee.value = "SM Supermarket";
      submit(form);
      await flush();
      expect(data.expensesApi).toHaveBeenCalledWith({ action: "create", expense: { date: "2026-10-16", amount: 150000, method: "cash", category: "catGroceries01", payee: "SM Supermarket", paidBy: [{ name: payer, amount: 150000 }] } });
    }
  });

  it("no payer chosen: nothing invented (no paidBy sent)", async () => {
    const data = await mountExp();
    $('[data-act="new"]').click();
    await flush();
    const form = lastForm();
    form.elements.amount.value = "200";
    form.elements.category.value = "Groceries";
    submit(form);
    await flush();
    expect(data.expensesApi.mock.calls[0][0].expense).not.toHaveProperty("paidBy");
  });

  it("Edit: the current payer is selected; changing it sends the new payer; an older expense left blank sends no paidBy", async () => {
    const data = await mountExp();
    $('[data-row="expMom0000001"] summary').click();
    $('[data-row="expMom0000001"] [data-act="edit"]').click();
    await flush();
    let form = lastForm();
    expect(form.querySelector('input[name="paidBy"]:checked').value).toBe("Mom");
    form.querySelector('input[name="paidBy"][value="Dad"]').checked = true;
    submit(form);
    await flush();
    expect(data.expensesApi).toHaveBeenCalledWith({ action: "update", expenseId: "expMom0000001", expectedRevision: 1, changes: { paidBy: [{ name: "Dad", amount: 150000 }] } });
    data.expensesApi.mockClear();
    $('[data-row="expOld0000001"] [data-act="edit"]').click();
    await flush();
    form = lastForm();
    expect(form.querySelector('input[name="paidBy"]:checked')).toBeNull();
    form.elements.notes.value = "Maynilad";
    submit(form);
    await flush();
    expect(data.expensesApi.mock.calls[0][0].changes).toEqual({ notes: "Maynilad" });
  });
});

describe("Paid by on the list", () => {
  it("rows stay one line: 'Oct 5 · Mom'; an older expense shows just its date; Details says Not specified", async () => {
    await mountExp();
    expect(flat($('[data-row="expMom0000001"] .hx-sub'))).toBe("Oct 2 · Mom");
    expect(flat($('[data-row="expShared0001"] .hx-sub'))).toBe("Oct 5 · Shared");
    expect(flat($('[data-row="expOld0000001"] .hx-sub'))).toBe("Oct 5");
    $('[data-row="expOld0000001"] [data-act="view"]').click();
    await flush();
    expect(flat(document.querySelector(".modal-backdrop"))).toMatch(/Paid by\s*Not specified/);
  });

  it("Paid by totals for the month (each expense once; salaries aren't expenses; Not specified last)", async () => {
    await mountExp();
    expect(flat($('[data-role="payer-totals"]'))).toBe("Paid by Dad ₱3,800.00 · Mom ₱1,500.00 · Shared ₱600.00 · Not specified ₱200.00");
  });
});

describe("Filters: Category + Paid by with the month", () => {
  it("Paid by: All, the usual payers, then Not specified; each payer shows only its expenses; Shared never appears under Mom or Dad", async () => {
    await mountExp();
    expect($$('[data-role="f-payer"] option').map((o) => o.textContent)).toEqual(["All", "Mom", "Dad", "Shared", "Other", "Not specified"]);
    expect(shownNames()).toContain("Payroll · Loriza");
    pick("f-payer", "mom");
    expect(shownNames()).toEqual(["SM Supermarket"]);
    expect(flat($('[data-role="filter-total"]'))).toBe("Showing ₱1,500.00 · 1 item");
    pick("f-payer", "dad");
    expect(shownNames().sort()).toEqual(["Meralco", "Puregold"]);
    pick("f-payer", "shared");
    expect(shownNames()).toEqual(["S&R"]);
    pick("f-payer", "other");
    expect($('[data-role="none"]').textContent).toBe("Nothing matches these filters this month.");
    pick("f-payer", UNSET_PAYER);
    expect(shownNames()).toEqual(["Water"]);
    pick("f-payer", "");
    expect(shownNames()).toHaveLength(6);
    expect($('[data-role="filter-total"]')).toBeNull();
  });

  it("Category + Paid by together; changing one keeps the other; the month keeps both", async () => {
    await mountExp();
    pick("f-category", "catGroceries01");
    pick("f-payer", "dad");
    expect(shownNames()).toEqual(["Puregold"]);
    expect($('[data-role="f-category"]').value).toBe("catGroceries01");
    expect(flat($('[data-role="payer-totals"]'))).toBe("Paid by Mom ₱1,500.00 · Dad ₱800.00 · Shared ₱600.00");
    pick("f-category", "catUtilities01");
    expect($('[data-role="f-payer"]').value).toBe("dad");
    expect(shownNames()).toEqual(["Meralco"]);
    $('[data-act="month-prev"]').click();
    await flush();
    expect($('[data-role="f-payer"]').value).toBe("dad");
    expect($('[data-role="f-category"]').value).toBe("catUtilities01");
    expect($('[data-role="none"]').textContent).toBe("Nothing matches these filters this month.");
  });

  it("helpers: one payer per expense, unpaid bills / salaries excluded by a payer filter", () => {
    const rows = monthRows({ expenses: EXPS, payroll: MONTH.payroll, bills: [{ id: "b1", kind: "bill", description: "PLDT", category: "catUtilities01", amount: 2000, dueDate: "2026-10-20" }], categories: CATS });
    expect(filterRows(rows, { payer: "shared" }).map((r) => r.id)).toEqual(["expShared0001"]);
    expect(filterRows(rows, { category: "catUtilities01" }).map((r) => r.id).sort()).toEqual(["b1", "expDadUtil001", "expOld0000001"]);
    expect(filterRows(rows, { category: "catUtilities01", payer: "dad" }).map((r) => r.id)).toEqual(["expDadUtil001"]);
    expect(payerTotalsOf(rows).reduce((t, p) => t + p.amount, 0)).toBe(EXPS.reduce((t, e) => t + e.amount, 0));
    expect(payerChoices([ex("x1", "c", 1, "", "Lola")]).map((p) => p.name)).toEqual(["Mom", "Dad", "Shared", "Other", "Lola"]);
  });
});
