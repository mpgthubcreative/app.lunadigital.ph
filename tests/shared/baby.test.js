// Phase 15: the Baby Expense Tracker's shared rules: validation, the
// budget arithmetic, threshold levels, expense profiles, list specs and
// the export gates.

import { describe, it, expect } from "vitest";
import { validateCategoryInput, validateBudgetTotal, validateProviderInput, validateScheduleInput, budgetSummary, budgetLines, sortCategories, thresholdLevel, isValidRecordId, BabyError } from "../../shared/baby.js";
import { validateExpenseInput, EXPENSE_PROFILES, expenseProfile } from "../../shared/expenses.js";
import { providersQuery, scheduledPaymentsQuery, expensesQuery, categoriesQuery } from "../../shared/list-queries.js";
import { EXPORT_DATASETS } from "../../shared/export-datasets.js";
import { canExport } from "../../shared/exports.js";
import { computeEntitlements } from "../../shared/entitlements.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
import { resolvePermissions } from "../../shared/permissions.js";

const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

describe("budget arithmetic: Luna computes Spent and Remaining", () => {
  it("Remaining = Budget − Spent; no budget -> Remaining unknown, never 0", () => {
    expect(budgetSummary({ total: 15000000, spent: 2500000, upcoming: 2000000, upcomingCount: 1, expenseCount: 2 })).toEqual({ total: 15000000, spent: 2500000, remaining: 12500000, upcoming: 2000000, upcomingCount: 1, expenseCount: 2, percentUsed: 16.7 });
    expect(budgetSummary(null)).toMatchObject({ total: null, spent: 0, remaining: null, percentUsed: null });
    expect(budgetSummary({ total: 100, spent: 150 }).remaining).toBe(-50);
  });

  it("category lines: Category remaining = Category budget − Category spent; upcoming kept apart", () => {
    const doc = { spentByCategory: { a: 1000000, b: 1500000 }, upcomingByCategory: { a: 2000000 } };
    const lines = budgetLines(doc, [{ id: "a", name: "Medical", budget: 6000000, status: "active" }, { id: "b", name: "Nursery", budget: 4000000, status: "active" }, { id: "c", name: "Other", budget: null, status: "active" }]);
    expect(lines.map((l) => [l.name, l.spent, l.remaining, l.upcoming])).toEqual([["Medical", 1000000, 5000000, 2000000], ["Nursery", 1500000, 2500000, 0], ["Other", 0, null, 0]]);
  });

  it("threshold levels 75 / 90 / 100 (integer maths, no rounding drift)", () => {
    expect(thresholdLevel(7499, 10000)).toBe(0);
    expect(thresholdLevel(7500, 10000)).toBe(75);
    expect(thresholdLevel(8999, 10000)).toBe(75);
    expect(thresholdLevel(9000, 10000)).toBe(90);
    expect(thresholdLevel(10000, 10000)).toBe(100);
    expect(thresholdLevel(50000, 10000)).toBe(100);
    expect(thresholdLevel(5000, null)).toBe(0);
    expect(thresholdLevel(5000, 0)).toBe(0);
  });

  it("category order: position, then name, then id", () => {
    expect(sortCategories([{ id: "z", name: "B", order: 10 }, { id: "y", name: "A", order: 10 }, { id: "x", name: "C", order: 5 }]).map((c) => c.id)).toEqual(["x", "y", "z"]);
  });
});

describe("validation", () => {
  it("budgets are integer centavos >= 0, or null (cleared)", () => {
    expect(validateBudgetTotal(15000000)).toBe(15000000);
    expect(validateBudgetTotal(null)).toBeNull();
    for (const bad of [-1, 1.5, "100", 1e15]) expect(code(() => validateBudgetTotal(bad)), String(bad)).toBe("invalid-amount");
    expect(code(() => validateBudgetTotal(undefined))).toBe("invalid-input");
  });

  it("categories: a name, an optional budget, nothing else (no spent / useCount from the browser)", () => {
    expect(validateCategoryInput({ name: "  Medical  ", budget: 6000000 })).toEqual({ name: "Medical", budget: 6000000 });
    for (const bad of [{ name: "" }, { name: "x".repeat(41) }, { name: "A", spent: 1 }, { name: "A", useCount: 0 }, { name: "A", budget: -5 }]) expect(code(() => validateCategoryInput(bad)), JSON.stringify(bad)).toMatch(/invalid/);
    expect(code(() => validateCategoryInput({}, { partial: true }))).toBe("invalid-input");
  });

  it("providers: a known type, a valid email, plain text", () => {
    expect(validateProviderInput({ name: "ABC Clinic", type: "medical", email: "a@b.ph" })).toMatchObject({ name: "ABC Clinic", type: "medical", email: "a@b.ph" });
    expect(code(() => validateProviderInput({ name: "X", type: "customer" }))).toBe("invalid-input");
    expect(code(() => validateProviderInput({ name: "X", type: "other", email: "nope" }))).toBe("invalid-input");
    expect(code(() => validateProviderInput({ name: "X", type: "other", status: "active" }))).toBe("invalid-input");
  });

  it("scheduled payments: amount > 0, a day id, record ids; status / expenseId can't be sent", () => {
    const ok = { description: "Hospital deposit", category: "abcdefgh12", amount: 2000000, dueDate: "2026-12-15" };
    expect(validateScheduleInput(ok)).toMatchObject(ok);
    for (const extra of [{ amount: 0 }, { dueDate: "2026-13-01" }, { category: "Medical!" }, { status: "paid" }, { expenseId: "x" }]) expect(code(() => validateScheduleInput({ ...ok, ...extra })), JSON.stringify(extra)).toMatch(/invalid/);
  });

  it("record ids are 8-40 letters/digits (no paths)", () => {
    for (const id of ["abcdefgh", "A1b2C3d4E5"]) expect(isValidRecordId(id)).toBe(true);
    for (const id of ["short", "a/b/c/d/e/f", "../../xx12", "a".repeat(41), null]) expect(isValidRecordId(id)).toBe(false);
  });

  it("BabyError carries a code", () => {
    expect(new BabyError("stale", "x").code).toBe("stale");
  });
});

describe("Expense profiles: shared record rules, per-workspace meaning", () => {
  it("Distributor keeps its fixed categories and fields exactly; Baby takes tenant category ids + providerId", () => {
    const base = { date: "2026-10-10", amount: 100, method: "cash" };
    expect(validateExpenseInput({ ...base, category: "rent" }, { today: "2026-10-16" })).toMatchObject({ category: "rent" });
    expect(code(() => validateExpenseInput({ ...base, category: "rent", providerId: "abcdefgh12" }, { today: "2026-10-16", profile: EXPENSE_PROFILES.distributor }))).toBe("invalid-input");
    expect(validateExpenseInput({ ...base, category: "abcdefgh12", providerId: "abcdefgh34" }, { today: "2026-10-16", profile: EXPENSE_PROFILES["baby-expense"] })).toMatchObject({ category: "abcdefgh12", providerId: "abcdefgh34" });
    expect(code(() => validateExpenseInput({ ...base, category: "rent!" }, { today: "2026-10-16", profile: EXPENSE_PROFILES["baby-expense"] }))).toBe("invalid-input");
    // A Baby (tenant) category id is never a Distributor category.
    expect(code(() => validateExpenseInput({ ...base, category: "abcdefgh12" }, { today: "2026-10-16", profile: EXPENSE_PROFILES.distributor }))).toBe("invalid-input");
    expect(code(() => validateExpenseInput({ ...base, category: "abcdefgh12" }, { today: "2026-10-16" }))).toBe("invalid-input");
  });

  it("future dates are refused in both", () => {
    for (const p of Object.values(EXPENSE_PROFILES)) expect(code(() => validateExpenseInput({ date: "2026-10-17", amount: 1, method: "cash", category: p.categories === "fixed" ? "rent" : "abcdefgh12" }, { today: "2026-10-16", profile: p }))).toBe("invalid-input");
  });

  it("no profile for Household / Bridal / unknown workspaces (no default)", () => {
    for (const w of ["household-payroll", "bridal-expense", "", null, "__proto__", "toString"]) expect(expenseProfile(w), String(w)).toBeNull();
  });
});

describe("list specs (screens and Excel share them)", () => {
  it("Baby Expenses: provider filter is an indexed equality, never a scan", () => {
    expect(expensesQuery({ category: "c1", providerId: "p1", from: "2026-10-01" }).parts[0].where).toEqual([["status", "==", "active"], ["category", "==", "c1"], ["providerId", "==", "p1"], ["date", ">=", "2026-10-01"]]);
  });
  it("providers: active by default, type + name prefix", () => {
    expect(providersQuery({}).parts[0].where).toEqual([["status", "==", "active"]]);
    const w = providersQuery({ type: "medical", search: "ABC" }).parts[0].where;
    expect(w.slice(0, 3)).toEqual([["status", "==", "active"], ["type", "==", "medical"], ["nameLower", ">=", "abc"]]);
    expect(w[3][0]).toBe("nameLower");
    expect(w[3][2].startsWith("abc")).toBe(true);
  });
  it("payment schedule: Upcoming soonest first; Paid / Cancelled newest first; due-date range", () => {
    expect(scheduledPaymentsQuery({}).parts[0].orderBy[0]).toEqual(["dueDate", "asc"]);
    expect(scheduledPaymentsQuery({ status: "paid", from: "2026-10-01", to: "2026-10-31" }).parts[0]).toMatchObject({ where: [["status", "==", "paid"], ["dueDate", ">=", "2026-10-01"], ["dueDate", "<=", "2026-10-31"]], orderBy: [["dueDate", "desc"], ["__id__", "desc"]] });
  });
  it("categories: every line, display order", () => {
    expect(categoriesQuery().parts[0].orderBy[0]).toEqual(["order", "asc"]);
  });
});

describe("export gates: Baby datasets only in Baby; Distributor Expenses only in Distributor", () => {
  const access = (t, role = "owner") => ({ entitlements: computeEntitlements(PLAN_SEED.pro, {}, t), permissions: resolvePermissions(role) });
  it("each workspace sees only its own expense dataset", () => {
    for (const ds of ["budget", "babyExpenses", "providers", "paymentSchedule"]) {
      expect(canExport(access("baby-expense"), EXPORT_DATASETS[ds]), ds).toBe(true);
      for (const t of ["distributor", "household-payroll", "bridal-expense"]) expect(canExport(access(t), EXPORT_DATASETS[ds]), `${t}/${ds}`).toBe(false);
    }
    expect(canExport(access("distributor"), EXPORT_DATASETS.expenses)).toBe(true);
    expect(canExport(access("baby-expense"), EXPORT_DATASETS.expenses)).toBe(false);
  });
  it("Staff in Baby can't download Baby data (no view permission)", () => {
    for (const ds of ["budget", "babyExpenses", "providers", "paymentSchedule"]) expect(canExport(access("baby-expense", "staff"), EXPORT_DATASETS[ds]), ds).toBe(false);
  });
});
