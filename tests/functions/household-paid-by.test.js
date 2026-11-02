// Luna Household "Paid by" (2026-11-02): ONE payer per expense (Mom / Dad /
// Shared / Other), stored in the same paidBy field the budget's payer totals
// (budgets/current.spentByPayer) use. Shared is its own payer, never split
// into Mom and Dad; older expenses without one stay unset (never guessed);
// the Excel Expenses sheet has one Paid By column; another household can't
// touch these expenses.

import { describe, it, expect, beforeEach } from "vitest";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createWorkbookHandler } from "../../netlify/functions/workbook.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { readXlsx } from "../../shared/xlsx.js";
import { payerTotals, HOUSEHOLD_PAYERS } from "../../shared/baby.js";
import { withRequestKey } from "../helpers/request-keys.js";

const H = "biz-home";
const OTHER = "biz-other-home";
let world;
let u;
const clock = new Date("2026-10-13T04:00:00Z");

beforeEach(async () => {
  world = await buildWorld();
  u = {};
  for (const [businessId, key] of [[H, "carlo"], [OTHER, "rosa"]]) {
    await createBusiness({ ...world, name: `Home ${key}`, planId: "household-plus", workspaceTemplateId: "household-payroll", businessId });
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: "owner", isAccountOwner: true });
    u[key] = x.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { budget: createBudgetHandler, expenses: createExpensesHandler };
async function api(kind, uid, body, businessId = H) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(withRequestKey(kind, body)) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const docAt = (p, b = H) => world.db.docs.get(`businesses/${b}/${p}`);
const budget = () => docAt("budgets/current") ?? {};
const category = async (name, uid = u.carlo, b = H) => ok(await api("budget", uid, { action: "createCategory", category: { name, budget: null } }, b), 201).categoryId;
const spend = async (cat, amount, payer, extra = {}) => ok(await api("expenses", u.carlo, { action: "create", expense: { date: "2026-10-05", category: cat, amount, method: "cash", ...(payer ? { paidBy: [{ name: payer, amount }] } : {}), ...extra } }), 201).expenseId;
const update = (id, changes) => api("expenses", u.carlo, { action: "update", expenseId: id, expectedRevision: docAt(`expenses/${id}`).revision, changes });

describe("Household Paid by", () => {
  it("one payer per expense (Mom, Dad, Shared, Other): stored once, totals per payer; Shared is never counted under Mom or Dad", async () => {
    expect(HOUSEHOLD_PAYERS).toEqual(["Mom", "Dad", "Shared", "Other"]);
    const g = await category("Groceries");
    const mom = await spend(g, 150000, "Mom", { payee: "SM Supermarket" });
    await spend(g, 80000, "Dad");
    await spend(g, 60000, "Shared");
    await spend(g, 10000, "Other");
    expect(docAt(`expenses/${mom}`).paidBy).toEqual([{ key: "mom", name: "Mom", amount: 150000 }]);
    expect(budget().spent).toBe(300000);
    expect(budget().spentByPayer).toEqual({ mom: 150000, dad: 80000, shared: 60000, other: 10000 });
    expect(payerTotals(budget()).map((p) => [p.name, p.amount])).toEqual([["Mom", 150000], ["Dad", 80000], ["Shared", 60000], ["Other", 10000]]);
  });

  it("a split (two payers) is refused: Shared is the one value for a shared expense", async () => {
    const g = await category("Groceries");
    const r = await api("expenses", u.carlo, { action: "create", expense: { date: "2026-10-05", category: g, amount: 1000, method: "cash", paidBy: [{ name: "Mom", amount: 500 }, { name: "Dad", amount: 500 }] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Choose one payer/);
    expect(budget().spent ?? 0).toBe(0);
  });

  it("edit Paid by moves the money between payers; an amount change keeps the payer and follows it; remove takes it out", async () => {
    const g = await category("Utilities");
    const id = await spend(g, 300000, "Mom");
    ok(await update(id, { paidBy: [{ name: "Dad", amount: 300000 }] }));
    expect(docAt(`expenses/${id}`).paidBy).toEqual([{ key: "dad", name: "Dad", amount: 300000 }]);
    expect(budget().spentByPayer).toMatchObject({ mom: 0, dad: 300000 });
    ok(await update(id, { amount: 350000 }));
    expect(docAt(`expenses/${id}`).paidBy).toEqual([{ key: "dad", name: "Dad", amount: 350000 }]);
    expect(budget().spentByPayer.dad).toBe(350000);
    ok(await api("expenses", u.carlo, { action: "remove", expenseId: id, reason: "Entered twice" }));
    expect(budget().spentByPayer.dad).toBe(0);
    expect(budget().spent).toBe(0);
  });

  it("an older expense without a payer stays unset (never guessed) and counts as Not set in the payer totals; a payer can be added later", async () => {
    const g = await category("Groceries");
    const id = await spend(g, 40000, null);
    expect(docAt(`expenses/${id}`).paidBy ?? null).toBeNull();
    await spend(g, 10000, "Mom");
    expect(payerTotals(budget()).map((p) => [p.key, p.amount])).toEqual([["mom", 10000], [null, 40000]]);
    ok(await update(id, { paidBy: [{ name: "Shared", amount: 40000 }] }));
    expect(budget().spentByPayer).toEqual({ mom: 10000, shared: 40000 });
  });

  it("Excel: the Expenses sheet has one Paid By column (Not specified for older expenses, blank never invented)", async () => {
    const g = await category("Groceries");
    await spend(g, 150000, "Mom", { payee: "SM Supermarket" });
    await spend(g, 20000, null, { payee: "Sari-sari" });
    const res = await createWorkbookHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "POST" }), body: JSON.stringify({ range: "month" }) });
    expect(res.statusCode).toBe(200);
    const rows = readXlsx(Buffer.from(res.body, "base64"), { sheet: "Expenses", maxRows: 100 }).rows;
    expect(rows[0]).toEqual(["Date", "Category", "Expense", "Amount", "Paid By"]);
    expect(rows[0].filter((h) => /paid/i.test(h))).toHaveLength(1);
    const data = rows.slice(1).filter((r) => r[0] !== "Total");
    expect(data.map((r) => [r[2], r[4]]).sort()).toEqual([["SM Supermarket", "Mom"], ["Sari-sari", "Not specified"]]);
  });

  it("tenant isolation: another household can't read or change these expenses; its payer totals stay its own", async () => {
    const g = await category("Groceries");
    const id = await spend(g, 50000, "Mom");
    const other = await api("expenses", u.rosa, { action: "update", expenseId: id, expectedRevision: 1, changes: { paidBy: [{ name: "Dad", amount: 50000 }] } }, OTHER);
    expect(other.status).toBeGreaterThanOrEqual(400);
    const cross = await api("expenses", u.rosa, { action: "update", expenseId: id, expectedRevision: 1, changes: { paidBy: [{ name: "Dad", amount: 50000 }] } }, H);
    expect(cross.status).toBe(403);
    expect(docAt(`expenses/${id}`).paidBy[0].name).toBe("Mom");
    const og = await category("Groceries", u.rosa, OTHER);
    ok(await api("expenses", u.rosa, { action: "create", expense: { date: "2026-10-05", category: og, amount: 7000, method: "cash", paidBy: [{ name: "Dad", amount: 7000 }] } }, OTHER), 201);
    expect(budget().spentByPayer).toEqual({ mom: 50000 });
    expect(docAt("budgets/current", OTHER).spentByPayer).toEqual({ dad: 7000 });
  });
});
