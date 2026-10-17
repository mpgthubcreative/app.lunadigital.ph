// Luna Household money (household-payroll v3): Expenses on the Household
// profile, Bills (the Payment Schedule) with repeats, a monthly budget, and
// the month summary. Payroll stays authoritative: released salaries are
// summarized under Household Staff, never copied into expenses; advances
// aren't spending. Household staff accounts never reach any of it.

import { describe, it, expect, beforeEach } from "vitest";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createScheduleHandler } from "../../netlify/functions/schedule.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createHouseholdMoneyHandler } from "../../netlify/functions/household-money.js";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { readXlsx } from "../../shared/xlsx.js";
import { nextDueDate } from "../../shared/baby.js";

const H = "biz-home";
const W = 41100;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]).toString("base64");
let world;
let u;
let clock;
const at = (day) => (clock = new Date(`${day}T04:00:00Z`));

beforeEach(async () => {
  at("2026-10-13");
  world = await buildWorld();
  await createBusiness({ ...world, name: "Prado Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  for (const [key, role] of [["carlo", "owner"], ["dad", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { budget: createBudgetHandler, schedule: createScheduleHandler, expenses: createExpensesHandler, staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler, advances: createAdvancesHandler };
async function api(kind, uid, body, businessId = H) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
async function month(m = null, uid = u.carlo, businessId = H) {
  const res = await createHouseholdMoneyHandler(deps())({ ...request({ uid, businessId, method: "GET" }), queryStringParameters: m ? { month: m } : {} });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const under = (c) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/${c}/`) && k.split("/").length === 4).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
const OCT = (d) => `2026-10-${String(d).padStart(2, "0")}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const category = async (name) => ok(await api("budget", u.carlo, { action: "createCategory", category: { name, budget: null } }), 201).categoryId;
const spend = async (cat, amount, date = OCT(5), extra = {}) => ok(await api("expenses", u.carlo, { action: "create", expense: { date, category: cat, amount, method: "cash", ...extra } }), 201).expenseId;

describe("Household Expenses (Household profile)", () => {
  it("an expense needs only Amount, Category, Date (+ method); payee / reference / notes optional; no providers or payers", async () => {
    const groceries = await category("Groceries");
    const id = await spend(groceries, 250000, OCT(5), { payee: "SM Supermarket", reference: "OR-1", notes: "Weekly" });
    expect(docAt(`expenses/${id}`)).toMatchObject({ amount: 250000, category: groceries, payee: "SM Supermarket", reference: "OR-1", status: "active" });
    expect(docAt(`expenses/${id}`)).not.toHaveProperty("providerId");
    expect(docAt(`expenses/${id}`)).not.toHaveProperty("paidBy");
    expect((await api("expenses", u.carlo, { action: "create", expense: { date: OCT(5), category: groceries, amount: 100, method: "cash", providerId: "x1234567" } })).status).toBe(400);
    expect((await api("expenses", u.carlo, { action: "create", expense: { date: OCT(5), category: groceries, amount: 100, method: "cash", paidBy: [{ name: "Mom", amount: 100 }] } })).status).toBe(400);
  });

  it("setupCategories gives the household list (editable), not the Baby one", async () => {
    ok(await api("budget", u.carlo, { action: "setupCategories" }));
    const names = under("expenseCategories").map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Groceries", "Utilities", "Household Supplies", "Dining / Food", "Transportation", "Medical", "Baby", "Pets", "Household Staff", "Maintenance / Repairs", "Rent / Mortgage / Condo", "Subscriptions", "Education", "Personal", "Miscellaneous"]));
    expect(names).toHaveLength(15);
    const util = under("expenseCategories").find((c) => c.name === "Utilities");
    ok(await api("budget", u.carlo, { action: "updateCategory", categoryId: util.id, changes: { name: "Utilities & Internet", budget: 500000 } }));
    expect(docAt(`expenseCategories/${util.id}`)).toMatchObject({ name: "Utilities & Internet", budget: 500000 });
  });

  it("the monthly budget is typed (not the sum of category budgets) and household spending sends no lifetime budget alerts", async () => {
    ok(await api("budget", u.carlo, { action: "setTotal", total: 3000000 }));
    const g = await category("Groceries");
    await spend(g, 2900000);
    expect(docAt("budgets/current").total).toBe(3000000);
    expect([...world.db.docs.values()].filter((d) => JSON.stringify(d ?? {}).includes("budget.threshold"))).toHaveLength(0);
  });

  it("proof on a household expense (stored privately, listed in the record)", async () => {
    const id = await spend(await category("Medical"), 80000);
    ok(await api("expenses", u.carlo, { action: "attachProof", expenseId: id, proof: { contentType: "image/png", dataBase64: PNG } }));
    expect(docAt(`expenses/${id}`).proof).toMatchObject({ contentType: "image/png" });
    expect(ok(await api("expenses", u.carlo, { action: "proof", expenseId: id })).proof.contentType).toBe("image/png");
  });
});

describe("Bills: recurring, paid -> one expense, next bill", () => {
  it("nextDueDate keeps a month-end bill on its day; weekly and yearly step", () => {
    expect(nextDueDate("2026-01-31", { every: "month", interval: 1 })).toBe("2026-02-28");
    expect(nextDueDate("2026-02-28", { every: "month", interval: 1 }, 31)).toBe("2026-03-31");
    expect(nextDueDate("2026-10-13", { every: "week", interval: 2 })).toBe("2026-10-27");
    expect(nextDueDate("2028-02-29", { every: "year", interval: 1 })).toBe("2029-02-28");
  });

  it("a monthly bill paid in full: one expense linked to it, the next bill created once, Upcoming stays one bill (no double count)", async () => {
    const util = await category("Utilities");
    const sid = ok(await api("schedule", u.carlo, { action: "create", payment: { description: "Meralco", category: util, amount: 450000, dueDate: OCT(20), repeat: { every: "month", interval: 1 }, payee: "Meralco" } }), 201).scheduleId;
    expect(docAt(`scheduledPayments/${sid}`)).toMatchObject({ repeat: { every: "month", interval: 1 }, repeatDay: 20, status: "upcoming" });
    expect(docAt("budgets/current")).toMatchObject({ upcoming: 450000, upcomingCount: 1 });
    const r = ok(await api("schedule", u.carlo, { action: "markPaid", scheduleId: sid, payment: { method: "gcash", amount: 431250, paidDate: OCT(13), key: "kmeralcooct1" } }));
    expect(r.nextScheduleId).toBeTruthy();
    const exp = under("expenses");
    expect(exp).toHaveLength(1);
    expect(exp[0]).toMatchObject({ amount: 431250, scheduleId: sid, category: util, payee: "Meralco" });
    expect(docAt(`scheduledPayments/${sid}`)).toMatchObject({ status: "paid", expenseId: exp[0].id, nextId: r.nextScheduleId });
    expect(docAt(`scheduledPayments/${r.nextScheduleId}`)).toMatchObject({ description: "Meralco", amount: 450000, dueDate: "2026-11-20", status: "upcoming", previousId: sid, repeat: { every: "month", interval: 1 } });
    expect(docAt("budgets/current")).toMatchObject({ spent: 431250, upcoming: 450000, upcomingCount: 1 });
    // A retry returns the same expense: nothing twice.
    const again = ok(await api("schedule", u.carlo, { action: "markPaid", scheduleId: sid, payment: { method: "gcash", amount: 431250, paidDate: OCT(13), key: "kmeralcooct1" } }));
    expect(again.expenseId ?? exp[0].id).toBe(exp[0].id);
    expect(under("expenses")).toHaveLength(1);
    expect(under("scheduledPayments")).toHaveLength(2);
  });

  it("removing the bill's expense reopens it; paying it again doesn't create a second next bill", async () => {
    const util = await category("Utilities");
    const sid = ok(await api("schedule", u.carlo, { action: "create", payment: { description: "Water", category: util, amount: 90000, dueDate: OCT(10), repeat: { every: "month", interval: 1 } } }), 201).scheduleId;
    const r = ok(await api("schedule", u.carlo, { action: "markPaid", scheduleId: sid, payment: { method: "cash", amount: 90000, paidDate: OCT(10) } }));
    ok(await api("expenses", u.carlo, { action: "remove", expenseId: r.expenseId, reason: "Wrong bill" }));
    expect(docAt(`scheduledPayments/${sid}`).status).toBe("upcoming");
    expect(docAt("budgets/current")).toMatchObject({ spent: 0, upcoming: 180000, upcomingCount: 2 });
    const r2 = ok(await api("schedule", u.carlo, { action: "markPaid", scheduleId: sid, payment: { method: "cash", amount: 90000, paidDate: OCT(11) } }));
    expect(r2.nextScheduleId).toBeUndefined();
    expect(under("scheduledPayments")).toHaveLength(2);
    expect(docAt("budgets/current")).toMatchObject({ spent: 90000, upcoming: 90000, upcomingCount: 1 });
  });

  it("a one-time bill paid: no next bill", async () => {
    const m = await category("Maintenance / Repairs");
    const sid = ok(await api("schedule", u.carlo, { action: "create", payment: { description: "Aircon cleaning", category: m, amount: 150000, dueDate: OCT(15) } }), 201).scheduleId;
    const r = ok(await api("schedule", u.carlo, { action: "markPaid", scheduleId: sid, payment: { method: "cash", amount: 150000, paidDate: OCT(13) } }));
    expect(r.nextScheduleId).toBeUndefined();
    expect(docAt("budgets/current")).toMatchObject({ upcoming: 0, upcomingCount: 0, spent: 150000 });
    // No payee on the bill: its expense is named after the bill.
    expect(docAt(`expenses/${r.expenseId}`)).toMatchObject({ payee: "Aircon cleaning", scheduleId: sid });
  });

  it("repeat can be set, changed and cleared on edit", async () => {
    const util = await category("Utilities");
    const sid = ok(await api("schedule", u.carlo, { action: "create", payment: { description: "Internet", category: util, amount: 169900, dueDate: OCT(25) } }), 201).scheduleId;
    ok(await api("schedule", u.carlo, { action: "update", scheduleId: sid, changes: { repeat: { every: "month", interval: 1 } } }));
    expect(docAt(`scheduledPayments/${sid}`)).toMatchObject({ repeat: { every: "month", interval: 1 }, repeatDay: 25 });
    ok(await api("schedule", u.carlo, { action: "update", scheduleId: sid, changes: { repeat: null } }));
    expect(docAt(`scheduledPayments/${sid}`).repeat).toBeNull();
    expect((await api("schedule", u.carlo, { action: "update", scheduleId: sid, changes: { repeat: { every: "day", interval: 1 } } })).status).toBe(400);
  });
});

describe("The month: payroll counted once, advances excluded", () => {
  async function paidHelper() {
    const lor = ok(await api("staff", u.carlo, { action: "create", staff: { name: "Loriza", dailyWage: W, payCycle: "semi_monthly", startDate: "2026-06-07", advanceLimit: 500000 } }), 201).staffId;
    ok(await api("attendance", u.carlo, { action: "setMany", staffId: lor, days: range(1, 13).map((d) => ({ date: OCT(d), status: "present" })) }));
    ok(await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 25000, date: OCT(3), method: "cash" } }), 201);
    const pid = ok(await api("payroll", u.carlo, { action: "prepare", staffId: lor, periodStart: OCT(1) }), 201).payrollId;
    ok(await api("payroll", u.carlo, { action: "release", payrollId: pid, payment: { method: "gcash" } }));
    return { lor, pid };
  }

  it("Spent = expenses + salaries released this month; salary shows under Household Staff; no expense record for it; the advance isn't spending", async () => {
    const { pid } = await paidHelper();
    const salary = docAt(`payrolls/${pid}`).salary.amount;
    expect(salary).toBeGreaterThan(0);
    const g = await category("Groceries");
    const staffCat = await category("Household Staff");
    await spend(g, 300000);
    await spend(staffCat, 50000); // e.g. the helper's uniform
    const util = await category("Utilities");
    ok(await api("schedule", u.carlo, { action: "create", payment: { description: "Meralco", category: util, amount: 450000, dueDate: OCT(20), repeat: { every: "month", interval: 1 } } }), 201);
    ok(await api("schedule", u.carlo, { action: "create", payment: { description: "Rent", category: util, amount: 2000000, dueDate: "2026-11-05" } }), 201);
    const m = ok(await month()).month;
    expect(under("expenses")).toHaveLength(2); // payroll never becomes an expense
    expect(m).toMatchObject({ month: "2026-10", current: true, expensesSpent: 350000, staffPaid: salary, spent: 350000 + salary, billsRemaining: 450000, billsDue: 1 });
    // No budget in Household any more (expense monitoring, not budgeting).
    for (const k of ["budget", "left", "payrollDue"]) expect(m).not.toHaveProperty(k);
    // The salary as ONE read-only payroll row for the Expenses list.
    expect(m.payroll).toEqual([{ id: pid, staffName: "Loriza", amount: salary, paidDate: docAt(`payrolls/${pid}`).salary.paidDate }]);
    expect(m.categories.find((c) => c.name === "Household Staff")).toEqual({ name: "Household Staff", amount: 50000 + salary, payroll: salary });
    expect(m.categories.find((c) => c.name === "Groceries").amount).toBe(300000);
    // The ₱250 advance appears nowhere in the money.
    expect(m.categories.reduce((t, c) => t + c.amount, 0)).toBe(m.spent);
    expect(m.byCategory).toEqual({ [g]: 300000, [staffCat]: 50000 });
    // Cash flow: the ₱250 advance released this month is cash out, not spending.
    expect(m).toMatchObject({ advancesReleased: 25000, advanceCount: 1, cashOut: m.spent + 25000 });
    // The salary was paid net of the advance deduction: no negative spending, nothing counted twice.
    expect(docAt(`payrolls/${pid}`).deductions.some((d) => d.type === "advance")).toBe(true);
    expect(m.staffPaid).toBe(docAt(`payrolls/${pid}`).salary.amount);
  });

  it("another month: only its own expenses and salaries", async () => {
    await paidHelper();
    const g = await category("Groceries");
    await spend(g, 120000, "2026-09-28");
    const sep = ok(await month("2026-09")).month;
    expect(sep).toMatchObject({ month: "2026-09", current: false, expensesSpent: 120000, staffPaid: 0, payroll: [], advancesReleased: 0, cashOut: 120000 });
    expect((await month("2026-13")).status).toBe(400);
  });
});

describe("Access", () => {
  it("household staff (kasambahay) accounts never reach expenses, bills, budget or the month", async () => {
    const lor = ok(await api("staff", u.carlo, { action: "create", staff: { name: "Loriza", dailyWage: W, payCycle: "semi_monthly", startDate: "2026-06-07" } }), 201).staffId;
    const r = ok(await api("staff", u.carlo, { action: "createLogin", staffId: lor }), 201);
    await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.activationToken, password: "kape-at-pandesal" }) });
    const helper = r.uid;
    expect((await month(null, helper)).status).toBe(403);
    expect((await api("expenses", helper, { action: "create", expense: { date: OCT(5), category: "x", amount: 100, method: "cash" } })).status).toBe(403);
    expect((await api("schedule", helper, { action: "create", payment: {} })).status).toBe(403);
    expect((await api("budget", helper, { action: "setTotal", total: 1 })).status).toBe(403);
    expect((await api("expenses", helper, { action: "proof", expenseId: "abcdefgh12" })).status).toBe(403);
  });

  it("the month endpoint is Household only", async () => {
    const x = await ensureAuthUser({ auth: world.auth, email: "dist@home.test", name: "dist" });
    await addMember({ ...world, businessId: "biz-a", uid: x.uid, email: x.email, name: "dist", roleTemplate: "owner", isAccountOwner: false });
    expect((await month(null, x.uid, "biz-a")).status).toBe(403);
  });

  it("an Admin (manager) can run household money", async () => {
    const g = await category("Groceries");
    expect((await api("expenses", u.dad, { action: "create", expense: { date: OCT(5), category: g, amount: 100, method: "cash" } })).status).toBe(201);
    expect((await month(null, u.dad)).status).toBe(200);
  });
});

describe("Master Backup (Household)", () => {
  it("has Expenses, Bills, Recurring Items and Categories; no Budget sheet and no budget column (old data stays stored)", async () => {
    const util = await category("Utilities");
    ok(await api("budget", u.carlo, { action: "updateCategory", categoryId: util, changes: { budget: 500000 } }));
    ok(await api("budget", u.carlo, { action: "setTotal", total: 4000000 }));
    await spend(util, 10000);
    ok(await api("schedule", u.carlo, { action: "create", payment: { description: "Meralco", category: util, amount: 450000, dueDate: OCT(20), repeat: { every: "month", interval: 1 } } }), 201);
    const res = await createBackupHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "POST" }), body: "{}" });
    expect(res.statusCode).toBe(200);
    const bytes = Buffer.from(res.body, "base64");
    const read = (name) => readXlsx(bytes, { sheet: name }).rows;
    expect(read("Expenses")).toHaveLength(2);
    expect(read("Bills")[1]).toEqual(expect.arrayContaining(["Meralco"]));
    expect(read("Recurring Items")[1]).toEqual(expect.arrayContaining(["Meralco", "Every month", OCT(20), "4500", "Utilities"]));
    expect(read("Categories")[1]).toEqual(expect.arrayContaining(["Utilities"]));
    expect(read("Categories")[0]).not.toContain("budget");
    const res2 = await createBackupHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "POST" }), body: "{}" });
    const sheets = JSON.parse(JSON.stringify(readXlsx(Buffer.from(res2.body, "base64"), { sheet: "Export Info" }).rows)).map((r) => r[0]);
    for (const gone of ["Budget", "Budget record", "Budget totals"]) expect(sheets).not.toContain(gone);
    for (const kept of ["Expenses", "Bills", "Recurring Items", "Categories", "Grocery List"]) expect(sheets).toContain(kept);
    // Old stored budget data is kept (backward compatibility), just not shown or exported.
    expect(docAt("budgets/current").total).toBe(4000000);
    expect(docAt(`expenseCategories/${util}`).budget).toBe(500000);
  });
});
