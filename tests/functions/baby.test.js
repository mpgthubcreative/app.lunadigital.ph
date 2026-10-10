// Phase 15: Baby Expense Tracker on the server: Budget & Categories, Baby
// Expenses (the Expenses Core with the Baby sink), Providers, the Payment
// Schedule (Upcoming -> exactly one expense), threshold alerts, exports,
// and workspace / tenant isolation.

import { describe, it, expect, beforeEach } from "vitest";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createProvidersHandler } from "../../netlify/functions/providers.js";
import { createScheduleHandler } from "../../netlify/functions/schedule.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createExportsHandler } from "../../netlify/functions/exports.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request, clearInboxes } from "../helpers/tenants.js";
import { notificationId } from "../../shared/notifications.js";
import { budgetSummary, budgetLines, payerTotals } from "../../shared/baby.js";
import { readXlsx } from "../../shared/xlsx.js";
import { reportRows } from "../../shared/exports.js";

const NOW = new Date("2026-10-16T04:00:00Z"); // Oct 16, 12:00 Manila
const B = "biz-baby";
const B2 = "biz-baby-2";
const P = "₱";
let world;
let u;
let clock;

beforeEach(async () => {
  world = await buildWorld();
  clock = NOW;
  await createBusiness({ ...world, name: "Reyes Baby", planId: "growth", workspaceTemplateId: "baby-expense", businessId: B });
  await createBusiness({ ...world, name: "Cruz Baby", planId: "starter", workspaceTemplateId: "baby-expense", businessId: B2 });
  await createBusiness({ ...world, name: "Santos Household", planId: "growth", workspaceTemplateId: "household-payroll", businessId: "biz-home" });
  u = {};
  const add = async (key, businessId, role, extra = {}) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@baby.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner", ...extra });
    u[key] = x.uid;
  };
  await add("camille", B, "owner");
  await add("paolo", B, "manager");
  await add("yaya", B, "staff");
  await add("nopay", B, "manager", { permissionOverrides: { revoke: ["expenses.create"] } });
  await add("other", B2, "owner");
  await add("home", "biz-home", "owner");
  clearInboxes(world.db);
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { budget: createBudgetHandler, providers: createProvidersHandler, schedule: createScheduleHandler, expenses: createExpensesHandler };
async function api(kind, uid, body, businessId = B) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p, businessId = B) => world.db.docs.get(`businesses/${businessId}/${p}`);
const budget = () => docAt("budgets/current");
const summary = () => budgetSummary(budget());
const pathsUnder = (prefix) => [...world.db.docs.keys()].filter((k) => k.startsWith(prefix));

async function category(name, budgetCentavos = null, uid = u.camille) {
  const r = await api("budget", uid, { action: "createCategory", category: { name, budget: budgetCentavos } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.categoryId;
}
async function expense(input, uid = u.camille) {
  const r = await api("expenses", uid, { action: "create", expense: { date: "2026-10-10", method: "cash", ...input } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.expenseId;
}
// Phase 18.6: the Baby total budget is the sum of the category budgets.
async function setCategoryBudget(categoryId, budgetCentavos, uid = u.camille) {
  const r = await api("budget", uid, { action: "updateCategory", categoryId, changes: { budget: budgetCentavos } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
// ₱150,000 = Medical 60k + Nursery 40k + Clothing 10k + Savings buffer 40k.
async function scenarioBudget() {
  const c = { medical: await category("Medical", 6000000), nursery: await category("Nursery", 4000000), clothing: await category("Clothing", 1000000) };
  c.buffer = await category("Savings buffer", 4000000);
  return c;
}

describe("THE live scenario: ₱150,000 budget, Medical ₱60,000, Nursery ₱40,000, Clothing ₱10,000", () => {
  it("record, edit, remove: Spent / Remaining / category remaining follow exactly", async () => {
    const c = await scenarioBudget();
    const med = await expense({ category: c.medical, amount: 1000000, payee: "ABC Women's Clinic" });
    const nur = await expense({ category: c.nursery, amount: 1500000 });
    expect(summary()).toMatchObject({ total: 15000000, spent: 2500000, remaining: 12500000, expenseCount: 2 });
    const lines = () => Object.fromEntries(budgetLines(budget(), [{ id: c.medical, name: "Medical", budget: 6000000 }, { id: c.nursery, name: "Nursery", budget: 4000000 }]).map((l) => [l.name, l.remaining]));
    expect(lines()).toEqual({ Medical: 5000000, Nursery: 2500000 });

    const doc = docAt(`expenses/${nur}`);
    expect((await api("expenses", u.paolo, { action: "update", expenseId: nur, expectedRevision: doc.revision, changes: { amount: 1200000 } })).status).toBe(200);
    expect(summary()).toMatchObject({ spent: 2200000, remaining: 12800000 });
    expect(docAt(`expenses/${nur}`).history.at(-1)).toMatchObject({ type: "edited", label: `Amount changed ${P}15,000 → ${P}12,000`, actor: { uid: u.paolo } });

    expect((await api("expenses", u.camille, { action: "remove", expenseId: med, reason: "Entered twice" })).status).toBe(200);
    expect(summary()).toMatchObject({ spent: 1200000, remaining: 13800000, expenseCount: 1 });
    expect(lines()).toEqual({ Medical: 6000000, Nursery: 2800000 });
    expect(docAt(`expenses/${med}`)).toMatchObject({ status: "removed", removalReason: "Entered twice" });
    // The selected-period figures (day + month) agree.
    expect(docAt("spendingMetrics/2026-10-10")).toMatchObject({ period: "day", spent: 1200000, count: 1 });
    expect(docAt("spendingMetrics/2026-10")).toMatchObject({ period: "month", spent: 1200000, count: 1 });
  });

  it("a budget change is not spending, recalculates Remaining, and is audited (previous -> new, actor)", async () => {
    const c = await scenarioBudget();
    const before = summary();
    expect(before.total).toBe(15000000); // the sum of the category budgets
    await setCategoryBudget(c.buffer, 7000000);
    expect(summary()).toMatchObject({ total: 18000000, spent: before.spent, remaining: 18000000 - before.spent });
    expect(budget().history.at(-1)).toMatchObject({ label: `Savings buffer budget changed ${P}40,000 → ${P}70,000 · total budget now ${P}180,000`, from: 4000000, to: 7000000, actor: { uid: u.camille, name: "camille" } });
    expect(pathsUnder(`businesses/${B}/spendingMetrics/`)).toEqual([]);
  });

  it("Phase 18.6: the total can't be typed; it follows category adds, budget edits and deletes", async () => {
    expect(summary().total).toBeNull(); // no budget yet: expenses are still tracked
    const r = await api("budget", u.camille, { action: "setTotal", total: 100 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("budget-total-automatic");
    const a = await category("Hospital", 8000000);
    expect(summary().total).toBe(8000000);
    const b = await category("Clothing"); // no budget: total unchanged
    expect(summary().total).toBe(8000000);
    await setCategoryBudget(b, 1000000);
    expect(summary().total).toBe(9000000);
    expect((await api("budget", u.camille, { action: "deleteCategory", categoryId: a })).status).toBe(200);
    expect(summary().total).toBe(1000000);
    // Hiding a category keeps its budget in the total (its spending still counts).
    expect((await api("budget", u.camille, { action: "setCategoryStatus", categoryId: b, status: "inactive" })).status).toBe(200);
    expect(summary().total).toBe(1000000);
  });

  it("Baby spending never touches Distributor sinks (no sales, COGS, operating expenses, report rollups)", async () => {
    const c = await scenarioBudget();
    await expense({ category: c.medical, amount: 500000 });
    for (const col of ["financialMetrics", "metrics", "reportRollups"]) expect(pathsUnder(`businesses/${B}/${col}/`), col).toEqual([]);
  });

  it("the browser can't send totals: unknown fields (spent, total, categoryName) are refused", async () => {
    const c = await scenarioBudget();
    for (const extra of [{ spent: 1 }, { categoryName: "x" }, { scheduleId: "abcdefgh12" }]) {
      const r = await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: c.medical, amount: 100, ...extra } });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await api("budget", u.camille, { action: "setTotal", total: 100, spent: 5 })).status).toBe(400);
  });
});

describe("Baby Expenses: the Expenses Core with Baby rules", () => {
  it("future dates are refused (upcoming money belongs in the Payment Schedule)", async () => {
    const c = await scenarioBudget();
    const r = await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-17", method: "cash", category: c.medical, amount: 100 } });
    expect(r.status).toBe(400);
  });

  it("Distributor's fixed categories are refused; only the family's own active categories count", async () => {
    const c = await scenarioBudget();
    expect((await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: "rent", amount: 100 } })).status).toBe(400);
    expect((await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: "zzzzzzzzzzzz", amount: 100 } })).body.error).toBe("invalid-category");
    await api("budget", u.camille, { action: "setCategoryStatus", categoryId: c.clothing, status: "inactive" });
    expect((await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: c.clothing, amount: 100 } })).body.error).toBe("invalid-category");
  });

  it("Provider and Payee are separate; the provider's name is snapshotted, kept after rename or deactivation", async () => {
    const c = await scenarioBudget();
    const p = (await api("providers", u.camille, { action: "create", provider: { name: "ABC Women's Clinic", type: "medical", phone: "0917 000 0000" } })).body.providerId;
    // Phase 18.6: the payee (who received the money) can differ from the provider.
    const other = await expense({ category: c.medical, amount: 100000, providerId: p, payee: "Dr. Reyes (clinic doctor)" });
    expect(docAt(`expenses/${other}`)).toMatchObject({ providerId: p, providerName: "ABC Women's Clinic", payee: "Dr. Reyes (clinic doctor)" });
    // No payee given: the provider received the money.
    const id = await expense({ category: c.medical, amount: 250000, providerId: p });
    expect(docAt(`expenses/${id}`)).toMatchObject({ providerId: p, providerName: "ABC Women's Clinic", payee: "ABC Women's Clinic" });
    await api("providers", u.camille, { action: "update", providerId: p, changes: { name: "ABC Clinic (new name)" } });
    await api("providers", u.camille, { action: "setStatus", providerId: p, status: "inactive" });
    expect(docAt(`expenses/${id}`).payee).toBe("ABC Women's Clinic");
    expect(docAt(`providers/${p}`).history.map((h) => h.label)).toEqual(["Added ABC Women's Clinic", "Name changed ABC Women's Clinic → ABC Clinic (new name)", "Deactivated"]);
    const r = await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: c.medical, amount: 100, providerId: p } });
    expect(r.body.error).toBe("invalid-provider");
  });

  it("changing an expense's category moves its spending between the budget lines", async () => {
    const c = await scenarioBudget();
    const id = await expense({ category: c.medical, amount: 300000 });
    await api("expenses", u.camille, { action: "update", expenseId: id, changes: { category: c.nursery } });
    expect(budget().spentByCategory).toMatchObject({ [c.medical]: 0, [c.nursery]: 300000 });
    expect(docAt(`expenses/${id}`)).toMatchObject({ categoryName: "Nursery" });
  });
});

describe("Categories", () => {
  it("suggested categories are offered once; names are unique (case-insensitive)", async () => {
    const r = await api("budget", u.camille, { action: "setupCategories" });
    expect(r.body.created).toBe(11);
    expect((await api("budget", u.camille, { action: "setupCategories" })).body.created).toBe(0);
    expect((await api("budget", u.camille, { action: "createCategory", category: { name: "medical" } })).body.error).toBe("duplicate-category");
    expect(budget().categoryCount).toBe(11);
  });

  it("a used category can't be deleted (deactivate instead); an unused one can", async () => {
    const c = await scenarioBudget();
    await expense({ category: c.medical, amount: 100 });
    expect((await api("budget", u.camille, { action: "deleteCategory", categoryId: c.medical })).body.error).toBe("category-in-use");
    expect((await api("budget", u.camille, { action: "deleteCategory", categoryId: c.clothing })).status).toBe(200);
    expect(docAt(`expenseCategories/${c.clothing}`)).toBeUndefined();
    expect(budget().categoryCount).toBe(3);
  });

  it("a category used only by a scheduled payment can't be deleted either", async () => {
    const c = await scenarioBudget();
    await api("schedule", u.camille, { action: "create", payment: { description: "Crib balance", category: c.clothing, amount: 100, dueDate: "2026-11-01" } });
    expect((await api("budget", u.camille, { action: "deleteCategory", categoryId: c.clothing })).body.error).toBe("category-in-use");
  });

  it("category budget changes are recorded on the budget history", async () => {
    const c = await scenarioBudget();
    await api("budget", u.camille, { action: "updateCategory", categoryId: c.nursery, changes: { budget: 4500000 } });
    expect(budget().history.at(-1)).toMatchObject({ label: `Nursery budget changed ${P}40,000 → ${P}45,000 · total budget now ${P}155,000`, from: 4000000, to: 4500000 });
  });
});

describe("Payment Schedule -> exactly one Baby Expense", () => {
  async function deposit(c) {
    const r = await api("schedule", u.camille, { action: "create", payment: { description: "Hospital deposit", category: c.medical, amount: 2000000, dueDate: "2026-12-15" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.scheduleId;
  }
  const expenseDocs = () => pathsUnder(`businesses/${B}/expenses/`);

  it("Upcoming counts as committed, not spent; Mark paid records ONE expense and Spent rises by exactly ₱20,000", async () => {
    const c = await scenarioBudget();
    const before = summary().spent;
    const id = await deposit(c);
    expect(summary()).toMatchObject({ spent: before, upcoming: 2000000, upcomingCount: 1 });
    const r = await api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "bank_transfer", paidDate: "2026-10-15", reference: "BT-1" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(expenseDocs()).toHaveLength(1);
    expect(docAt(`scheduledPayments/${id}`)).toMatchObject({ status: "paid", expenseId: r.body.expenseId, paidAmount: 2000000, paidDate: "2026-10-15" });
    expect(docAt(`expenses/${r.body.expenseId}`)).toMatchObject({ scheduleId: id, amount: 2000000, category: c.medical, date: "2026-10-15", reference: "BT-1", status: "active" });
    expect(summary()).toMatchObject({ spent: before + 2000000, upcoming: 0, upcomingCount: 0 });
  });

  it("a retry / second click returns the same expense and changes nothing", async () => {
    const c = await scenarioBudget();
    const id = await deposit(c);
    const first = await api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "cash" } });
    const snap = JSON.stringify(budget());
    const again = await api("schedule", u.paolo, { action: "markPaid", scheduleId: id, payment: { method: "gcash", amount: 1 } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyPaid: true, expenseId: first.body.expenseId });
    expect(expenseDocs()).toHaveLength(1);
    expect(JSON.stringify(budget())).toBe(snap);
  });

  it("two simultaneous Mark paid requests still make one expense", async () => {
    const c = await scenarioBudget();
    const id = await deposit(c);
    const [a, b] = await Promise.all([api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "cash" } }), api("schedule", u.paolo, { action: "markPaid", scheduleId: id, payment: { method: "cash" } })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.expenseId).toBe(b.body.expenseId);
    expect(expenseDocs()).toHaveLength(1);
    expect(summary()).toMatchObject({ spent: 2000000, upcoming: 0 });
  });

  it("removing the paid expense reopens the payment (Upcoming again); paying again records a NEW single expense", async () => {
    const c = await scenarioBudget();
    const id = await deposit(c);
    const { expenseId } = (await api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "cash" } })).body;
    await api("expenses", u.camille, { action: "remove", expenseId, reason: "Wrong date" });
    expect(docAt(`scheduledPayments/${id}`)).toMatchObject({ status: "upcoming", expenseId: null, attempt: 1 });
    expect(summary()).toMatchObject({ spent: 0, upcoming: 2000000, upcomingCount: 1 });
    const again = await api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "cash" } });
    expect(again.body.expenseId).toBe(`${id}r1`);
    expect(summary()).toMatchObject({ spent: 2000000, upcoming: 0 });
  });

  it("editing the paid expense's amount follows on the payment; cancelling a paid one is refused", async () => {
    const c = await scenarioBudget();
    const id = await deposit(c);
    const { expenseId } = (await api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "cash" } })).body;
    await api("expenses", u.camille, { action: "update", expenseId, changes: { amount: 1800000 } });
    expect(docAt(`scheduledPayments/${id}`).paidAmount).toBe(1800000);
    expect((await api("schedule", u.camille, { action: "cancel", scheduleId: id })).body.error).toBe("not-upcoming");
  });

  it("cancel leaves Upcoming without spending; a cancelled payment can't be paid", async () => {
    const c = await scenarioBudget();
    const id = await deposit(c);
    expect((await api("schedule", u.camille, { action: "cancel", scheduleId: id, reason: "Changed hospital" })).status).toBe(200);
    expect(summary()).toMatchObject({ spent: 0, upcoming: 0, upcomingCount: 0 });
    expect((await api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "cash" } })).body.error).toBe("not-upcoming");
    expect(expenseDocs()).toHaveLength(0);
  });

  it("editing an Upcoming payment moves the Upcoming totals with it", async () => {
    const c = await scenarioBudget();
    const id = await deposit(c);
    await api("schedule", u.camille, { action: "update", scheduleId: id, changes: { amount: 2500000, category: c.nursery } });
    expect(budget()).toMatchObject({ upcoming: 2500000, upcomingByCategory: { [c.medical]: 0, [c.nursery]: 2500000 } });
  });

  it("a payment scheduled before its category was deactivated can still be paid", async () => {
    const c = await scenarioBudget();
    const id = await deposit(c);
    await api("budget", u.camille, { action: "setCategoryStatus", categoryId: c.medical, status: "inactive" });
    expect((await api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "cash" } })).status).toBe(200);
  });

  it("Mark paid also needs expenses.create; a paid date can't be in the future", async () => {
    const c = await scenarioBudget();
    const id = await deposit(c);
    expect((await api("schedule", u.nopay, { action: "markPaid", scheduleId: id, payment: { method: "cash" } })).status).toBe(403);
    expect((await api("schedule", u.camille, { action: "markPaid", scheduleId: id, payment: { method: "cash", paidDate: "2026-10-17" } })).status).toBe(400);
    expect(docAt(`scheduledPayments/${id}`).status).toBe("upcoming");
  });
});

describe("budget threshold alerts (Notifications Core): once per level, never per expense", () => {
  const inbox = (uid, key) => docAt(`members/${uid}/inbox/${notificationId("budget.threshold", key)}`);
  it("75% / 90% / 100% notify once each; later expenses don't repeat; a new budget starts a new episode", async () => {
    const c = await category("Medical", 1000000);
    await expense({ category: c, amount: 700000 });
    expect(pathsUnder(`businesses/${B}/members/${u.camille}/inbox/`)).toHaveLength(0);
    await expense({ category: c, amount: 60000 }); // 76%
    expect(inbox(u.camille, "2-75")).toMatchObject({ title: "Baby budget 75% used" });
    await expense({ category: c, amount: 10000 }); // 77%: nothing new
    expect(pathsUnder(`businesses/${B}/members/${u.camille}/inbox/`)).toHaveLength(1);
    await expense({ category: c, amount: 300000 }); // 107%: straight to 100
    expect(inbox(u.camille, "2-100")).toMatchObject({ title: "Baby budget fully used" });
    expect(inbox(u.camille, "2-90")).toBeUndefined();
    expect(inbox(u.paolo, "2-100")).toBeTruthy();
    expect(inbox(u.yaya, "2-100")).toBeUndefined(); // no budget.view
    await setCategoryBudget(c, 2000000); // 53.5%: new episode, nothing yet
    await expense({ category: c, amount: 500000 }); // 78.5%
    expect(inbox(u.camille, "3-75")).toBeTruthy();
  });
});

describe("access: workspace, permissions, tenants", () => {
  it("Staff can't manage the Baby budget, providers or schedule (conservative default)", async () => {
    expect((await api("budget", u.yaya, { action: "setTotal", total: 100 })).status).toBe(403);
    expect((await api("providers", u.yaya, { action: "create", provider: { name: "X", type: "other" } })).status).toBe(403);
    expect((await api("schedule", u.yaya, { action: "create", payment: {} })).status).toBe(403);
    expect((await api("expenses", u.yaya, { action: "create", expense: {} })).status).toBe(403);
  });

  it("Distributor and Household can't reach any Baby endpoint, even as owner", async () => {
    for (const [uid, biz] of [[world.uids.ownera, "biz-a"], [u.home, "biz-home"]]) {
      expect((await api("budget", uid, { action: "setTotal", total: 100 }, biz)).status).toBe(403);
      expect((await api("providers", uid, { action: "create", provider: { name: "X", type: "other" } }, biz)).status).toBe(403);
      expect((await api("schedule", uid, { action: "create", payment: {} }, biz)).status).toBe(403);
    }
    // Household has no Expenses at all.
    expect((await api("expenses", u.home, { action: "create", expense: {} }, "biz-home")).status).toBe(403);
  });

  it("Baby A can't touch Baby B: a member of A selecting B is refused, and ids don't cross", async () => {
    const c = await scenarioBudget();
    expect((await api("budget", u.camille, { action: "setTotal", total: 100 }, B2)).status).toBe(403);
    expect((await api("expenses", u.other, { action: "create", expense: { date: "2026-10-10", method: "cash", category: c.medical, amount: 100 } }, B2)).body.error).toBe("invalid-category");
    expect(pathsUnder(`businesses/${B2}/expenses/`)).toEqual([]);
  });

  it("Distributor expenses are unchanged: fixed categories, operating expenses, no Baby documents", async () => {
    const r = await api("expenses", world.uids.ownera, { action: "create", expense: { date: "2026-10-10", method: "cash", category: "rent", amount: 500000 } }, "biz-a");
    expect(r.status).toBe(201);
    expect(world.db.docs.get("businesses/biz-a/financialMetrics/2026-10-10")).toMatchObject({ operatingExpenses: 500000 });
    for (const col of ["budgets", "spendingMetrics"]) expect(pathsUnder(`businesses/biz-a/${col}/`)).toEqual([]);
    expect((await api("expenses", world.uids.ownera, { action: "create", expense: { date: "2026-10-10", method: "cash", category: "rent", amount: 1, providerId: "abcdefgh12" } }, "biz-a")).status).toBe(400);
  });
});

describe("Excel downloads (Export Core)", () => {
  async function download(uid, dataset, filters = {}, businessId = B) {
    const res = await createExportsHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify({ dataset, filters }) });
    return res.statusCode === 200 ? { status: 200, bytes: new Uint8Array(Buffer.from(res.body, "base64")), headers: res.headers } : { status: res.statusCode, body: JSON.parse(res.body) };
  }
  // Phase 18.6: one worksheet per download; [header, ...rows] under its title block.
  const sheet = (bytes, name) => {
    expect(() => readXlsx(bytes, { sheet: "Export info" })).toThrow();
    return reportRows(readXlsx(bytes, { sheet: name }).rows);
  };
  const rawSheet = (bytes, name) => readXlsx(bytes, { sheet: name }).rows;

  it("Category = Medical: only matching Baby Expenses, every page, Baby columns only, formula-safe", async () => {
    const c = await scenarioBudget();
    for (let i = 0; i < 30; i++) await expense({ category: c.medical, amount: 1000 + i });
    await expense({ category: c.nursery, amount: 99999, payee: "=HYPERLINK(\"http://x\")", paidBy: [{ name: "Mom", amount: 60000 }, { name: "Dad", amount: 39999 }] });
    const r = await download(u.camille, "babyExpenses", { category: c.medical });
    expect(r.status).toBe(200);
    const rows = sheet(r.bytes, "Baby Expenses");
    expect(rows[0]).toEqual(["Date paid", "Category", "What it was for", "Amount", "Paid by", "Provider", "Paid to (payee)", "Payment method", "Reference", "Recurring", "From payment schedule"]);
    expect(rows.slice(1)).toHaveLength(30);
    expect(rows.slice(1).every((row) => row[1] === "Medical")).toBe(true);
    const all = sheet((await download(u.camille, "babyExpenses")).bytes, "Baby Expenses");
    const evil = all.find((row) => row[3] === "999.99");
    expect(typeof evil[6]).toBe("string");
    expect(evil[6]).not.toMatch(/^=/);
    expect(evil[4]).toBe("Mom ₱600.00 + Dad ₱399.99"); // one row; shares shown, counted once
    expect(JSON.stringify(all)).not.toMatch(/COGS|Gross|Profit|Sales/i);
  });

  it("Budget = the full Baby report (categories, paid expenses, still to pay) without double counting; Providers; Payment Schedule; dashboard", async () => {
    const c = await scenarioBudget();
    await expense({ category: c.medical, amount: 1000000, paidBy: [{ name: "Mom", amount: 1000000 }], notes: "Check-up" });
    await api("providers", u.camille, { action: "create", provider: { name: "Baby Company", type: "baby_store" } });
    await api("schedule", u.camille, { action: "create", payment: { description: "Hospital deposit", category: c.medical, amount: 2000000, dueDate: "2026-12-15" } });

    const b = await download(u.camille, "budget");
    const report = sheet(b.bytes, "Baby budget");
    const h = report[0];
    expect(h).toEqual(["Record", "Date", "Category", "Description / item", "Category budget", "Total spent", "Remaining budget", "Payment amount", "Still to pay", "Payment status", "Payment method", "Paid by", "Provider", "Payee", "Due date", "Date paid", "Reference", "Notes"]);
    const of = (type) => report.slice(1).filter((r) => r[0] === type);
    expect(of("Category").map((r) => [r[2], r[4], r[5], r[6]])).toEqual([["Medical", "60000", "10000", "50000"], ["Nursery", "40000", "0", "40000"], ["Clothing", "10000", "0", "10000"], ["Savings buffer", "40000", "0", "40000"]]);
    expect(of("Expense").map((r) => [r[2], r[3], r[7], r[9], r[11]])).toEqual([["Medical", "Check-up", "10000", "Paid", "Mom"]]);
    expect(of("Still to pay").map((r) => [r[3], r[8], r[9]])).toEqual([["Hospital deposit", "20000", "Upcoming"]]);
    // Totals: budget 150,000; spent (categories) = paid (expenses) = 10,000; still to pay 20,000.
    const total = rawSheet(b.bytes, "Baby budget").at(-1);
    expect([total[0], total[4], total[5], total[7], total[8]]).toEqual(["Total", "150000", "10000", "10000", "20000"]);
    expect(sheet((await download(u.camille, "providers", { type: "baby_store" })).bytes, "Providers").slice(1).map((row) => row[0])).toEqual(["Baby Company"]);
    const sched = sheet((await download(u.camille, "paymentSchedule", { status: "upcoming" })).bytes, "Payment Schedule");
    expect(sched.slice(1).map((row) => [row[1], row[6]])).toEqual([["Hospital deposit", "20000"]]);

    const d = await download(u.camille, "dashboard", { from: "2026-10-01", to: "2026-10-16" });
    expect(d.status).toBe(200);
    const rows = sheet(d.bytes, "Dashboard");
    const sec = (name) => rows.slice(1).filter((r) => r[0] === name);
    expect(sec("Who paid (now)").map((r) => [r[2], r[4]])).toEqual([["Mom", "10000"]]);
    expect(sec("Expenses in the period").map((r) => r[4])).toEqual(["10000"]);
    expect(sec("Still to pay (now)").map((r) => r[2])).toEqual(["Hospital deposit · Medical"]);
    expect(JSON.stringify(rows)).not.toMatch(/COGS|Gross|Profit|Sales|Current operations/i);
  });

  it("Baby datasets are closed to Distributor / Household, and Distributor's Expenses dataset is closed to Baby", async () => {
    for (const ds of ["budget", "babyExpenses", "providers", "paymentSchedule"]) {
      expect((await download(world.uids.ownera, ds, {}, "biz-a")).status, ds).toBe(403);
      expect((await download(u.home, ds, {}, "biz-home")).status, ds).toBe(403);
    }
    expect((await download(u.camille, "expenses")).status).toBe(403);
    expect((await download(u.yaya, "babyExpenses")).status).toBe(403);
  });
});

describe("Phase 18 usage metering (meter only, never enforced)", () => {
  const usage = () => docAt("usage/2026-10") || {};
  it("Mark paid counts ONE scheduled payment paid and ONE expense created (business month, timezone kept); a retry or second click counts nothing more", async () => {
    const c = await scenarioBudget();
    const r0 = await api("schedule", u.camille, { action: "create", payment: { description: "Hospital deposit", category: c.medical, amount: 2000000, dueDate: "2026-12-15" } });
    const before = { exp: usage().expensesCreated ?? 0, paid: usage().scheduledPaymentsPaid ?? 0 };
    const first = await api("schedule", u.camille, { action: "markPaid", scheduleId: r0.body.scheduleId, payment: { method: "cash" } });
    expect(first.status).toBe(200);
    await api("schedule", u.paolo, { action: "markPaid", scheduleId: r0.body.scheduleId, payment: { method: "cash" } });
    expect(usage()).toMatchObject({ period: "2026-10", timezone: "Asia/Manila", scheduledPaymentsPaid: before.paid + 1, expensesCreated: before.exp + 1 });
    expect(usage().timezones).toEqual(["Asia/Manila"]);
  });

  it("removing an expense doesn't decrement expensesCreated (it measures activity, not records kept)", async () => {
    const c = await scenarioBudget();
    const e = await expense({ category: c.medical, amount: 1000, payee: "Clinic" });
    const n = usage().expensesCreated;
    expect(n).toBeGreaterThanOrEqual(1);
    const r = await api("expenses", u.camille, { action: "remove", expenseId: e, reason: "entered twice" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(usage().expensesCreated).toBe(n);
  });
});

describe("Phase 18.6: who paid (split shares) and payments paid in parts", () => {
  const pay = (scheduleId, payment) => api("schedule", u.camille, { action: "markPaid", scheduleId, payment });
  async function scheduled(c, amount = 2000000) {
    const r = await api("schedule", u.camille, { action: "create", payment: { description: "Hospital deposit", category: c.medical, amount, dueDate: "2026-12-15" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.scheduleId;
  }

  it("a shared purchase counts ONCE in Spent and is split across the payers", async () => {
    const c = await scenarioBudget();
    await expense({ category: c.nursery, amount: 1000000, paidBy: [{ name: "Mom", amount: 600000 }, { name: "Dad", amount: 400000 }] });
    await expense({ category: c.clothing, amount: 200000, paidBy: [{ name: "mom", amount: 200000 }] });
    await expense({ category: c.clothing, amount: 50000 }); // nobody recorded
    expect(summary().spent).toBe(1250000);
    expect(budget().spentByPayer).toEqual({ mom: 800000, dad: 400000 });
    expect(payerTotals(budget())).toEqual([
      { key: "mom", name: "mom", amount: 800000 },
      { key: "dad", name: "Dad", amount: 400000 },
      { key: null, name: "Not set", amount: 50000 },
    ]);
  });

  it("shares must add up to the amount; editing the amount of a single-payer expense moves its share", async () => {
    const c = await scenarioBudget();
    const bad = await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: c.medical, amount: 1000, paidBy: [{ name: "Mom", amount: 600 }, { name: "Dad", amount: 300 }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("paid-by-mismatch");
    const dup = await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: c.medical, amount: 1000, paidBy: [{ name: "Mom", amount: 500 }, { name: "MOM", amount: 500 }] } });
    expect(dup.status).toBe(400);
    const one = await expense({ category: c.medical, amount: 1000, paidBy: [{ name: "Lola Rosa", amount: 1000 }] });
    expect((await api("expenses", u.camille, { action: "update", expenseId: one, changes: { amount: 1500 } })).status).toBe(200);
    expect(docAt(`expenses/${one}`).paidBy).toEqual([{ key: "lola_rosa", name: "Lola Rosa", amount: 1500 }]);
    expect(budget().spentByPayer).toEqual({ lola_rosa: 1500 });
    const two = await expense({ category: c.medical, amount: 1000, paidBy: [{ name: "Mom", amount: 500 }, { name: "Dad", amount: 500 }] });
    const r = await api("expenses", u.camille, { action: "update", expenseId: two, changes: { amount: 1200 } });
    expect(r.body.error).toBe("paid-by-mismatch"); // two people: say who paid the difference
    expect((await api("expenses", u.camille, { action: "update", expenseId: two, changes: { amount: 1200, paidBy: [{ name: "Mom", amount: 700 }, { name: "Dad", amount: 500 }] } })).status).toBe(200);
    expect((await api("expenses", u.camille, { action: "remove", expenseId: two, reason: "Entered twice" })).status).toBe(200);
    expect(budget().spentByPayer).toEqual({ lola_rosa: 1500, mom: 0, dad: 0 });
  });

  it("a part payment records one expense and leaves only the unpaid part in Upcoming; the last part finishes it", async () => {
    const c = await scenarioBudget();
    const id = await scheduled(c);
    expect(summary()).toMatchObject({ upcoming: 2000000, upcomingCount: 1, spent: 0 });
    const p1 = await pay(id, { method: "gcash", amount: 500000, final: false, key: "part0001", paidBy: [{ name: "Dad", amount: 500000 }] });
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    expect(p1.body).toMatchObject({ partPaid: true, remaining: 1500000 });
    expect(summary()).toMatchObject({ upcoming: 1500000, upcomingCount: 1, spent: 500000 });
    expect(docAt(`scheduledPayments/${id}`)).toMatchObject({ status: "upcoming", paidAmount: 500000 });
    // The same dialog retried: nothing new.
    expect((await pay(id, { method: "gcash", amount: 500000, final: false, key: "part0001" })).body.alreadyPaid).toBe(true);
    expect(summary()).toMatchObject({ upcoming: 1500000, spent: 500000, expenseCount: 1 });
    // The rest (default amount = what's unpaid) finishes it.
    const p2 = await pay(id, { method: "cash", key: "part0002" });
    expect(p2.body).toMatchObject({ paid: true });
    expect(summary()).toMatchObject({ upcoming: 0, upcomingCount: 0, spent: 2000000, expenseCount: 2 });
    expect(docAt(`scheduledPayments/${id}`)).toMatchObject({ status: "paid", paidAmount: 2000000 });
    expect(docAt(`scheduledPayments/${id}`).parts).toHaveLength(2);
    expect(budget().spentByPayer).toEqual({ dad: 500000 });
  });

  it("removing a part puts its money back in Upcoming; cancelling a part-paid payment keeps the paid part as spent", async () => {
    const c = await scenarioBudget();
    const id = await scheduled(c);
    const e1 = (await pay(id, { method: "cash", amount: 800000, final: false, key: "aaaa1111" })).body.expenseId;
    expect((await api("expenses", u.camille, { action: "remove", expenseId: e1, reason: "Wrong amount" })).status).toBe(200);
    expect(summary()).toMatchObject({ upcoming: 2000000, upcomingCount: 1, spent: 0 });
    expect(docAt(`scheduledPayments/${id}`)).toMatchObject({ status: "upcoming", paidAmount: null, parts: [] });
    await pay(id, { method: "cash", amount: 300000, final: false, key: "bbbb2222" });
    // Can't edit the amount below what's already paid.
    expect((await api("schedule", u.camille, { action: "update", scheduleId: id, changes: { amount: 200000 } })).body.error).toBe("invalid-amount");
    expect((await api("schedule", u.camille, { action: "update", scheduleId: id, changes: { amount: 2500000 } })).status).toBe(200);
    expect(summary().upcoming).toBe(2200000);
    expect((await api("schedule", u.camille, { action: "cancel", scheduleId: id, reason: "Covered by insurance" })).status).toBe(200);
    expect(summary()).toMatchObject({ upcoming: 0, upcomingCount: 0, spent: 300000 });
  });

  it("a final payment for less than the bill (discount) closes it without leaving money in Upcoming", async () => {
    const c = await scenarioBudget();
    const id = await scheduled(c);
    expect((await pay(id, { method: "cash", amount: 1800000 })).body).toMatchObject({ paid: true });
    expect(summary()).toMatchObject({ upcoming: 0, upcomingCount: 0, spent: 1800000 });
  });
});

describe("Phase 18.6 migration: adopt the category total", () => {
  it("dry run changes nothing; apply sets total = sum of category budgets, once, with a history line", async () => {
    const { adoptCategoryTotal } = await import("../../netlify/functions/_lib/baby.js");
    const { tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js");
    // A business from before 18.6: typed total ₱150,000, categories adding up to ₱110,000.
    await world.db.doc(`businesses/${B}/budgets/current`).set({ total: 15000000, spent: 0, alerts: { episode: 1, notified: 0 } }, { merge: true });
    for (const [id, budgetC] of [["catA0000001", 6000000], ["catB0000001", 5000000], ["catC0000001", null]]) await world.db.doc(`businesses/${B}/expenseCategories/${id}`).set({ name: id, nameLower: id.toLowerCase(), budget: budgetC, status: "active", useCount: 0, revision: 1, order: 10 });
    const args = { db: world.db, tenant: tenantDb(world.db, B), FieldValue: world.admin.firestore.FieldValue };
    expect(await adoptCategoryTotal({ ...args })).toMatchObject({ changed: true, from: 15000000, to: 11000000, dryRun: true });
    expect(budget().total).toBe(15000000);
    expect(await adoptCategoryTotal({ ...args, dryRun: false })).toMatchObject({ changed: true, to: 11000000 });
    expect(budget()).toMatchObject({ total: 11000000, totalFrom: "categories" });
    expect(budget().history.at(-1).label).toBe(`Total budget is now the sum of the category budgets: ${P}150,000 → ${P}110,000`);
    expect(await adoptCategoryTotal({ ...args, dryRun: false })).toMatchObject({ changed: false });
  });
});
