// Download Excel (Owner pilot, 2026-10-18): ONE clean workbook per
// workspace (/api/workbook). Readable sheets (no ids, JSON or field names),
// ₱ amounts as numbers, real dates, bold frozen header with filters;
// totals match Luna; payroll once in Household Expenses; Bridal roles /
// party members readable; Business items readable; tenant isolation; the
// Master Backup is Luna Super Admin only.

import { describe, it, expect, beforeEach } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { createWorkbookHandler } from "../../netlify/functions/workbook.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createScheduleHandler } from "../../netlify/functions/schedule.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createHouseholdMoneyHandler } from "../../netlify/functions/household-money.js";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createGroceryHandler } from "../../netlify/functions/grocery.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingTasksHandler } from "../../netlify/functions/wedding-tasks.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createWeddingSuppliersHandler } from "../../netlify/functions/wedding-suppliers.js";
import { createWeddingCrewMealsHandler } from "../../netlify/functions/wedding-crew-meals.js";
import { createWeddingProgramHandler } from "../../netlify/functions/wedding-program.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { createOrder } from "../../netlify/functions/_lib/orders.js";
import { recordPayment } from "../../netlify/functions/_lib/payments.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request, asOperator } from "../helpers/tenants.js";
import { readXlsx } from "../../shared/xlsx.js";
import { QTY_SCALE } from "../../shared/quantity.js";
import { excelSerial } from "../../shared/exports.js";
import { resolveWorkbookRange, workbookFileName } from "../../shared/workbook.js";

const H = "biz-home";
const W = "biz-wed";
const W2 = "biz-wed-2";
let world;
let u;
let clock;
const at = (day) => (clock = new Date(`${day}T04:00:00Z`));

beforeEach(async () => {
  at("2026-10-13");
  world = await buildWorld();
  u = {};
});
const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = {
  budget: createBudgetHandler,
  schedule: createScheduleHandler,
  expenses: createExpensesHandler,
  staff: createHouseholdStaffHandler,
  attendance: createAttendanceHandler,
  payroll: createPayrollHandler,
  advances: createAdvancesHandler,
  grocery: createGroceryHandler,
  guests: createGuestsHandler,
  tasks: createWeddingTasksHandler,
  setup: createWeddingSetupHandler,
  suppliers: createWeddingSuppliersHandler,
  crew: createWeddingCrewMealsHandler,
  program: createWeddingProgramHandler,
};
async function api(kind, uid, businessId, body) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect([200, 201]).toContain(r.status);
  if (status !== 200 && r.status !== status) expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
async function workbook(uid, businessId, body = {}) {
  const res = await createWorkbookHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  if (res.statusCode !== 200) return { status: res.statusCode, body: JSON.parse(res.body) };
  const bytes = Buffer.from(res.body, "base64");
  return { status: 200, bytes, fileName: /filename="([^"]+)"/.exec(res.headers["Content-Disposition"])[1] };
}
async function member(key, businessId, role, domain) {
  const x = await ensureAuthUser({ auth: world.auth, email: `${key}@${domain}.test`, name: key[0].toUpperCase() + key.slice(1) });
  await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key[0].toUpperCase() + key.slice(1), roleTemplate: role, isAccountOwner: role === "owner" });
  u[key] = x.uid;
}

// ---- reading a workbook back ----
const files = (bytes) => unzipSync(new Uint8Array(bytes));
function sheetNames(bytes) {
  return [...strFromU8(files(bytes)["xl/workbook.xml"]).matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
function sheetXml(bytes, name) {
  const i = sheetNames(bytes).indexOf(name);
  return strFromU8(files(bytes)[`xl/worksheets/sheet${i + 1}.xml`]);
}
const rowsOf = (bytes, name) => readXlsx(bytes, { sheet: name, maxRows: 20000 }).rows;
const dataOf = (bytes, name) => rowsOf(bytes, name).slice(1).filter((r) => r[0] !== "Total");
const allText = (bytes) => Object.values(files(bytes)).map((f) => strFromU8(f)).join("\n");
const serial = (day) => String(excelSerial({ y: +day.slice(0, 4), m: +day.slice(5, 7), d: +day.slice(8, 10) }));

// The clean style on one sheet: bold header row 1 (style 1), frozen below
// it, AutoFilter over the table, set widths; money cells use the ₱ style
// (2) and dates the date style (5), both as numbers.
function expectCleanSheet(bytes, name, { money = [], dates = [] } = {}) {
  const xml = sheetXml(bytes, name);
  expect(xml, name).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
  expect(xml, name).toMatch(/<autoFilter ref="A1:[A-Z]+\d+"\/>/);
  expect(xml, name).toMatch(/<cols>(<col [^>]*customWidth="1"\/>)+<\/cols>/);
  const header = /<row r="1">(.*?)<\/row>/.exec(xml)[1];
  for (const c of header.match(/<c [^>]*>/g)) expect(c, `${name} header`).toContain('s="1"');
  const colOf = (letter) => [...xml.matchAll(new RegExp(`<c r="${letter}(\\d+)"([^>]*)>(.*?)</c>`, "g"))].filter((m) => m[1] !== "1");
  for (const letter of money) for (const m of colOf(letter)) if (!/t="inlineStr"/.test(m[2])) expect(m[2], `${name} ${letter}${m[1]}`).toMatch(/s="(2|8)"/);
  for (const letter of dates) for (const m of colOf(letter).filter((c) => !/t="inlineStr"/.test(c[2]) || !/>Total</.test(c[3]))) {
    expect(m[2], `${name} ${letter}${m[1]}`).toContain('s="5"');
    expect(m[3]).toMatch(/^<v>\d+<\/v>$/);
  }
  expect(strFromU8(files(bytes)["xl/styles.xml"])).toContain('formatCode="&quot;₱&quot;#,##0.00;-&quot;₱&quot;#,##0.00"');
  expect(strFromU8(files(bytes)["xl/styles.xml"])).toContain('formatCode="mmm d, yyyy"');
  expect(strFromU8(files(bytes)["xl/styles.xml"])).toContain('<cellStyle name="Normal" xfId="0" builtinId="0"/>');
}
// No JSON, arrays or field names in any cell.
function expectReadable(bytes, forbidden = []) {
  for (const name of sheetNames(bytes)) {
    for (const row of rowsOf(bytes, name)) for (const cell of row) expect(String(cell), `${name}: ${cell}`).not.toMatch(/^[[{]|":|\[object|undefined|NaN/);
  }
  const text = allText(bytes);
  for (const f of forbidden) expect(text.includes(f), `contains ${f}`).toBe(false);
}

describe("shared rules", () => {
  it("ranges: this month (default), a custom range (at most a year), all records; file names", () => {
    expect(resolveWorkbookRange({}, { today: "2026-10-18" })).toMatchObject({ range: "month", from: "2026-10-01", to: "2026-10-31", fileLabel: "Oct-2026" });
    expect(resolveWorkbookRange({ range: "custom", from: "2026-10-01", to: "2026-10-15" }, { today: "2026-10-18" })).toMatchObject({ from: "2026-10-01", to: "2026-10-15", fileLabel: "2026-10-01-to-2026-10-15" });
    expect(resolveWorkbookRange({ range: "custom", from: "2026-09-01", to: "2026-09-30" }, { today: "2026-10-18" }).fileLabel).toBe("Sep-2026");
    expect(resolveWorkbookRange({ range: "all" }, { today: "2026-10-18" })).toMatchObject({ from: null, to: null, fileLabel: "All-records" });
    for (const bad of [{ range: "week" }, { range: "custom", from: "2026-10-15", to: "2026-10-01" }, { range: "custom", from: "2024-01-01", to: "2026-10-01" }, { range: "custom", from: "x" }]) expect(() => resolveWorkbookRange(bad, { today: "2026-10-18" })).toThrow();
    expect(workbookFileName("household", { range: { fileLabel: "Oct-2026" } })).toBe("Luna-Household-Oct-2026.xlsx");
    expect(workbookFileName("business", { range: { fileLabel: "Oct-2026" }, businessName: "Hayst Kopi" })).toBe("Luna-Business-Hayst-Kopi-Oct-2026.xlsx");
    expect(workbookFileName("bridal", { coupleNames: "Carlo & Yanie" })).toBe("Luna-Bridal-Carlo-Yanie.xlsx");
  });
});

describe("Luna Household workbook", () => {
  async function household() {
    await createBusiness({ ...world, name: "Prado Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
    await member("carlo", H, "owner", "home");
    await member("dad", H, "manager", "home");
    const cat = async (name) => ok(await api("budget", u.carlo, H, { action: "createCategory", category: { name, budget: null } }), 201).categoryId;
    const util = await cat("Utilities");
    const pets = await cat("Pets");
    const spend = (category, amount, date, extra = {}) => api("expenses", u.carlo, H, { action: "create", expense: { date, category, amount, method: "cash", ...extra } });
    ok(await spend(util, 923800, "2026-10-12", { payee: "Meralco" }), 201);
    ok(await spend(pets, 545000, "2026-10-11", { notes: "Scotty Food" }), 201);
    ok(await spend(pets, 10000, "2026-09-20", { payee: "Vet" }), 201); // last month
    // A bill paid: the expense has no payee of its own -> the bill's name.
    const sid = ok(await api("schedule", u.carlo, H, { action: "create", payment: { description: "PLDT", category: util, amount: 200000, dueDate: "2026-10-12" } }), 201).scheduleId;
    ok(await api("schedule", u.carlo, H, { action: "markPaid", scheduleId: sid, payment: { method: "gcash", amount: 200000, paidDate: "2026-10-12" } }));
    // Payroll: 3 days × ₱411 = ₱1,233, ₱500 advance deducted -> ₱733 paid on Oct 13.
    const lor = ok(await api("staff", u.carlo, H, { action: "create", staff: { name: "Loriza Ibanez", dailyWage: 41100, payCycle: "semi_monthly", startDate: "2026-06-07", advanceLimit: 500000 } }), 201).staffId;
    ok(await api("attendance", u.carlo, H, { action: "setMany", staffId: lor, days: ["2026-10-01", "2026-10-02", "2026-10-03"].map((date) => ({ date, status: "present" })) }));
    ok(await api("advances", u.carlo, H, { action: "give", advance: { staffId: lor, amount: 50000, date: "2026-10-02", method: "cash" } }), 201);
    const pid = ok(await api("payroll", u.carlo, H, { action: "prepare", staffId: lor, periodStart: "2026-10-01" }), 201).payrollId;
    ok(await api("payroll", u.carlo, H, { action: "release", payrollId: pid, payment: { method: "gcash" } }));
    const eggs = ok(await api("grocery", u.carlo, H, { action: "add", item: { name: "Eggs", qty: "2 trays", category: "Dairy & Eggs" } }), 201).items[0].itemId;
    ok(await api("grocery", u.carlo, H, { action: "add", item: { name: "Rice", qty: "5 kg", category: "Pantry" } }), 201);
    ok(await api("grocery", u.carlo, H, { action: "check", itemId: eggs, bought: true }));
    return { lor, pid, util, pets };
  }

  it("one workbook: Expenses (payroll once under Household Staff, no advance), Payroll, Payroll Breakdown, Attendance, Advances, Grocery List; totals match Luna", async () => {
    const ids = await household();
    const wb = await workbook(u.carlo, H, { range: "month" });
    expect(wb.status).toBe(200);
    expect(wb.fileName).toBe("Luna-Household-Oct-2026.xlsx");
    expect(sheetNames(wb.bytes)).toEqual(["Expenses", "Payroll", "Payroll Breakdown", "Attendance", "Advances", "Grocery List"]);

    expect(rowsOf(wb.bytes, "Expenses")[0]).toEqual(["Date", "Category", "Expense", "Amount"]);
    expect(dataOf(wb.bytes, "Expenses")).toEqual([
      [serial("2026-10-11"), "Pets", "Scotty Food", "5450"],
      [serial("2026-10-12"), "Utilities", "Meralco", "9238"],
      [serial("2026-10-12"), "Utilities", "PLDT", "2000"],
      [serial("2026-10-13"), "Household Staff", "Payroll · Loriza Ibanez", "733"],
    ]);
    const total = rowsOf(wb.bytes, "Expenses").at(-1);
    expect(total).toEqual(["Total", "", "", "17421"]);
    // Luna's own month figure (Expenses screen) is the same money.
    const month = JSON.parse((await createHouseholdMoneyHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "GET" }), queryStringParameters: {} })).body).month;
    expect(Number(total[3]) * 100).toBe(month.spent);
    expect(dataOf(wb.bytes, "Expenses").filter((r) => /Payroll/.test(r[2]))).toHaveLength(1);
    expect(allText(wb.bytes)).not.toMatch(/Advance of|Cash advance/);

    expect(rowsOf(wb.bytes, "Payroll")[0]).toEqual(["Period", "Employee", "Basic Pay", "Additions", "Deductions", "Net Pay", "Status", "Date Paid"]);
    expect(dataOf(wb.bytes, "Payroll")).toEqual([["Oct 1–15, 2026", "Loriza Ibanez", "1233", "0", "500", "733", "Paid", serial("2026-10-13")]]);
    expect(dataOf(wb.bytes, "Payroll Breakdown")).toEqual([["Oct 1–15, 2026", "Loriza Ibanez", "Deduction", "Advance deduction", "500"]]);
    expect(dataOf(wb.bytes, "Attendance")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => [serial(d), "Loriza Ibanez", "Present"]));
    expect(rowsOf(wb.bytes, "Advances")[0]).toEqual(["Date", "Employee", "Advance", "Deducted", "Balance", "Status"]);
    expect(dataOf(wb.bytes, "Advances")[0].slice(0, 5)).toEqual([serial("2026-10-02"), "Loriza Ibanez", "500", "500", "0"]);
    expect(rowsOf(wb.bytes, "Grocery List")[0]).toEqual(["Item", "Quantity", "Category", "Bought", "Bought Date"]);
    const groc = dataOf(wb.bytes, "Grocery List");
    expect(groc.map((r) => r.slice(0, 4))).toEqual([["Rice", "5 kg", "Pantry", "No"], ["Eggs", "2 trays", "Dairy & Eggs", "Yes"]]);
    expect([groc[0][4], /^\d+$/.test(groc[1][4])]).toEqual(["", true]); // a real date (server time)

    expectCleanSheet(wb.bytes, "Expenses", { money: ["D"], dates: ["A"] });
    expectCleanSheet(wb.bytes, "Payroll", { money: ["C", "D", "E", "F"], dates: ["H"] });
    expectCleanSheet(wb.bytes, "Advances", { money: ["C", "D", "E"], dates: ["A"] });
    expectReadable(wb.bytes, [H, ids.lor, ids.pid, ids.util, ids.pets, "staffId", "businessId", "periodStart", "salary"]);
  });

  it("ranges: a custom range and all records; an Admin may download; refused ranges and fields; household staff can't", async () => {
    await household();
    const sep = await workbook(u.carlo, H, { range: "custom", from: "2026-09-01", to: "2026-09-30" });
    expect(sep.fileName).toBe("Luna-Household-Sep-2026.xlsx");
    expect(dataOf(sep.bytes, "Expenses")).toEqual([[serial("2026-09-20"), "Pets", "Vet", "100"]]);
    expect(dataOf(sep.bytes, "Payroll")).toEqual([]);
    expect(rowsOf(sep.bytes, "Payroll")[0][0]).toBe("Period"); // header still there
    const all = await workbook(u.carlo, H, { range: "all" });
    expect(all.fileName).toBe("Luna-Household-All-records.xlsx");
    expect(dataOf(all.bytes, "Expenses")).toHaveLength(5);
    expect((await workbook(u.dad, H, {})).status).toBe(200);
    expect((await workbook(u.carlo, H, { range: "custom", from: "2026-10-15", to: "2026-10-01" })).status).toBe(400);
    expect((await workbook(u.carlo, H, { range: "month", businessId: "biz-a" })).status).toBe(400);
    expect((await workbook(u.carlo, H, { range: "everything" })).status).toBe(400);
    // The helper's own login (Household Staff) has no data.export.
    const helper = ok(await api("staff", u.carlo, H, { action: "create", staff: { name: "Maria", dailyWage: 50000, payCycle: "semi_monthly", startDate: "2026-06-07" } }), 201).staffId;
    const login = ok(await api("staff", u.carlo, H, { action: "createLogin", staffId: helper }));
    expect((await workbook(login.uid, H, {})).status).toBe(403);
    // Not a member there.
    expect((await workbook(u.carlo, "biz-a", {})).status).toBe(403);
    expect((await workbook(undefined, H, {})).status).toBe(401);
  });
});

describe("Luna Bridal workbook", () => {
  async function wedding() {
    await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W });
    await createBusiness({ ...world, name: "Cruz Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W2 });
    await member("camille", W, "owner", "wed");
    await member("helper", W, "staff", "wed");
    await member("other", W2, "owner", "wed");
    ok(await api("setup", u.camille, W, { action: "save", setup: { coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", ceremonyVenue: "San Agustin Church", ceremonyTime: "15:00", receptionVenue: "Admiral Hotel", receptionTime: "18:30", rsvpDeadline: "2027-01-15", rsvpEnabled: true } }));
    const catering = ok(await api("budget", u.camille, W, { action: "createCategory", category: { name: "Catering", budget: null } }), 201).categoryId;
    const sup = ok(await api("suppliers", u.camille, W, { action: "create", supplier: { name: "Admiral Hotel Reception", service: "other", agreedAmount: 80000000, categoryId: catering } }), 201).supplierId;
    ok(await api("expenses", u.camille, W, { action: "create", expense: { date: "2026-10-05", category: catering, amount: 47000000, method: "bank_transfer", reference: "BT-1", supplierId: sup } }), 201);
    const g = ok(await api("guests", u.camille, W, { action: "create", guest: { name: "Santos Family", category: "family", side: "bride", partySize: 3 } }), 201).guestId;
    const anna = ok(await api("guests", u.camille, W, { action: "addMember", guestId: g, name: "Anna Santos" }), 201).memberId;
    ok(await api("guests", u.camille, W, { action: "assignRole", guestId: g, role: { id: "principal_sponsor" } }));
    ok(await api("guests", u.camille, W, { action: "assignRole", guestId: g, memberId: anna, role: { id: "maid_of_honor" } }));
    ok(await api("guests", u.camille, W, { action: "assignRole", guestId: g, memberId: anna, role: { id: "bridesmaid" } }));
    ok(await api("guests", u.camille, W, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 3 } }));
    ok(await api("guests", u.camille, W, { action: "setAttending", guestId: g, memberId: anna, attending: true }));
    const table = ok(await api("guests", u.camille, W, { action: "createTable", table: { name: "Table 5", capacity: 8 } }), 201).tableId;
    ok(await api("guests", u.camille, W, { action: "seat", guestId: g, tableId: table }));
    ok(await api("guests", u.camille, W, { action: "create", guest: { name: "Lim Family", category: "friends", side: "groom", partySize: 2 } }), 201);
    const task = ok(await api("tasks", u.camille, W, { action: "create", task: { title: "Get CENOMAR", assignee: "Yanie", dueDate: "2026-11-01", forWhom: "both" } }), 201).taskId;
    ok(await api("tasks", u.camille, W, { action: "setPart", taskId: task, person: "bride", done: true }));
    ok(await api("crew", u.camille, W, { action: "create", item: { name: "Photo team", breakfast: 2, lunch: 3, dinner: 0, location: "Hotel" } }), 201);
    ok(await api("program", u.camille, W, { action: "create", item: { section: "ceremony", moment: "Processional", song: "Canon in D", person: "String quartet" } }), 201);
    // Another wedding's guest must never appear.
    ok(await api("guests", u.other, W2, { action: "create", guest: { name: "Cruz Secret Guest", category: "family", side: "bride", partySize: 1 } }), 201);
    return { g, anna, sup, catering, table };
  }

  it("Money, Payments, Tasks, Guests, Party Members, Seating, Roles, Crew Meals, Music & Program, Wedding Setup; readable; no tokens or ids", async () => {
    at("2026-10-16");
    const ids = await wedding();
    const link = ok(await api("guests", u.camille, W, { action: "inviteLink", guestId: ids.g }));
    const wb = await workbook(u.camille, W, { range: "month" }); // a wedding ignores the range
    expect(wb.status).toBe(200);
    expect(wb.fileName).toBe("Luna-Bridal-Carlo-Yanie.xlsx");
    expect(sheetNames(wb.bytes)).toEqual(["Money", "Payments", "Tasks", "Guests", "Party Members", "Seating", "Roles", "Crew Meals", "Music & Program", "Wedding Setup"]);
    expect(rowsOf(wb.bytes, "Money")[0]).toEqual(["Category", "Supplier / Description", "Total", "Paid", "Remaining", "Status", "Next Due"]);
    expect(dataOf(wb.bytes, "Money")).toEqual([["Catering", "Admiral Hotel Reception", "800000", "470000", "330000", "Partial", ""]]);
    expect(dataOf(wb.bytes, "Payments")).toEqual([["Admiral Hotel Reception", serial("2026-10-05"), "470000", "Bank Transfer", "BT-1"]]);
    expect(rowsOf(wb.bytes, "Tasks")[0]).toEqual(["Task", "Assigned To", "Due Date", "Bride Status", "Groom Status", "Overall Status"]);
    expect(dataOf(wb.bytes, "Tasks")).toEqual([["Get CENOMAR", "Yanie", serial("2026-11-01"), "Done", "Not done", "In Progress"]]);
    expect(dataOf(wb.bytes, "Guests")).toEqual([["Lim Family", "2", "0", "Awaiting RSVP", "Friends"], ["Santos Family", "3", "3", "Attending", "Family"]]);
    expect(dataOf(wb.bytes, "Party Members")).toEqual(expect.arrayContaining([["Santos Family", "Anna Santos", "Yes", "Maid / Matron of Honor, Bridesmaid"], ["Santos Family", "Santos Family", "", "Principal Sponsor"]]));
    expect(dataOf(wb.bytes, "Seating")).toEqual([["Santos Family", "3", "Table 5", "Attending"]]);
    // Several roles per person, several people per role: one row each.
    expect(dataOf(wb.bytes, "Roles")).toEqual(expect.arrayContaining([["Anna Santos", "Maid / Matron of Honor", "Santos Family"], ["Anna Santos", "Bridesmaid", "Santos Family"], ["Santos Family", "Principal Sponsor", "Santos Family"]]));
    expect(dataOf(wb.bytes, "Roles").filter((r) => r[0] === "Anna Santos")).toHaveLength(2);
    expect(dataOf(wb.bytes, "Crew Meals")).toEqual([["Photo team", "", "2", "3", "0", "Hotel", ""]]);
    expect(dataOf(wb.bytes, "Music & Program")).toEqual([["Ceremony", "1", "Processional", "Canon in D", "", "String quartet", ""]]);
    expect(dataOf(wb.bytes, "Wedding Setup")).toEqual([["Carlo & Yanie", serial("2027-02-14"), "San Agustin Church", "3:00 PM", "Admiral Hotel", "6:30 PM", serial("2027-01-15")]]);
    expectCleanSheet(wb.bytes, "Money", { money: ["C", "D", "E"] });
    expectCleanSheet(wb.bytes, "Payments", { money: ["C"], dates: ["B"] });
    const token = link.url ? link.url.split("/").pop() : link.token;
    expectReadable(wb.bytes, [W, ids.g, ids.anna, ids.sup, ids.catering, ids.table, "Cruz Secret Guest", "weddingSlug", "maid_of_honor", ...(token ? [token] : [])]);
  });

  it("a member gets only the sheets of the screens they can open; another wedding gets its own", async () => {
    await wedding();
    expect((await workbook(u.helper, W, {})).status).toBe(403); // staff: no data.export
    const theirs = await workbook(u.other, W2, {});
    expect(theirs.fileName).toBe("Luna-Bridal-Cruz-Wedding.xlsx");
    expect(dataOf(theirs.bytes, "Guests").map((r) => r[0])).toEqual(["Cruz Secret Guest"]);
    expect(allText(theirs.bytes)).not.toContain("Santos");
  });
});

describe("Luna Business workbook", () => {
  const Q = (n) => n * QTY_SCALE;
  const actor = { uid: "u-setup", name: "Carlo Reyes", email: "" };
  async function shop() {
    at("2026-10-18");
    const A = tenantDb(world.db, "biz-a");
    const common = { db: world.db, tenant: A, FieldValue, actor };
    const product = async (sku, name, price) => {
      const { productId } = await createProduct({ ...common, input: { sku, name, unit: "pcs", sellingPrice: price, reorderLevel: 0, category: "Coffee" } });
      await recordMovement({ ...common, productId, movement: { type: "opening", quantity: Q(20), unitCost: 5000, note: "count" } });
      return productId;
    };
    const kopi = await product("HAYST-KOPI", "Hayst Kopi", 7500);
    const choco = await product("HAYST-CHOCO", "Hayst Choco", 8000);
    const business = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA" };
    const entitlements = world.db.docs.get("businesses/biz-a").entitlements;
    const o = await createOrder({ ...common, business, entitlements, input: { customer: { name: "Marian Santos" }, source: "viber", items: [{ productId: kopi, quantity: Q(2) }, { productId: choco, quantity: Q(1) }] }, idempotencyKey: "wb-order-key-000001", canDiscount: false, canLinkCustomers: false, now: clock });
    await recordPayment({ ...common, bucket: world.bucket, business, orderId: o.orderId, input: { amount: 10000, method: "gcash", reference: "GC-77" }, canVerify: true, now: clock });
    return { kopi, choco, orderId: o.orderId, orderNumber: o.orderNumber };
  }

  it("Orders (items as text), Payments, Users (no UID), Inventory, Customers; no costs; this business only", async () => {
    const ids = await shop();
    const wb = await workbook(world.uids.ownera, "biz-a", { range: "month" });
    expect(wb.status).toBe(200);
    expect(wb.fileName).toMatch(/^Luna-Business-[A-Za-z0-9-]+-Oct-2026\.xlsx$/);
    expect(sheetNames(wb.bytes)).toEqual(["Orders", "Payments", "Users", "Inventory", "Customers"]);
    expect(rowsOf(wb.bytes, "Orders")[0]).toEqual(["Order No.", "Date", "Customer", "Source", "Items", "Total", "Paid", "Balance", "Status", "Created By"]);
    const [order] = dataOf(wb.bytes, "Orders");
    expect(order).toEqual([ids.orderNumber, serial("2026-10-18"), "Marian Santos", "Viber", "Hayst Kopi × 2; Hayst Choco × 1", "230", "100", "130", "Pending · Partially paid", "Carlo Reyes"]);
    expect(dataOf(wb.bytes, "Payments")).toEqual([[serial("2026-10-18"), ids.orderNumber, "Marian Santos", "100", "GCash", "GC77"]]);
    expect(rowsOf(wb.bytes, "Users")[0]).toEqual(["Name", "Email", "Role", "Status"]);
    expect(dataOf(wb.bytes, "Users").map((r) => r[2])).toContain("Owner");
    expect(dataOf(wb.bytes, "Inventory")).toEqual([["Hayst Choco", "Coffee", "pcs", "19", "80"], ["Hayst Kopi", "Coffee", "pcs", "18", "75"]]);
    expect(rowsOf(wb.bytes, "Customers")[0]).toEqual(["Customer", "Contact", "Total Orders", "Total Sales", "Outstanding Balance"]);
    expectCleanSheet(wb.bytes, "Orders", { money: ["F", "G", "H"], dates: ["B"] });
    expectCleanSheet(wb.bytes, "Inventory", { money: ["E"] });
    expect(dataOf(wb.bytes, "Customers")).toEqual([]);
    expectCleanSheet(wb.bytes, "Customers"); // an empty sheet still has its frozen header and filter
    const uids = Object.values(world.uids);
    expectReadable(wb.bytes, ["biz-a", ids.kopi, ids.choco, ids.orderId, "HAYST-KOPI", "Cost", "COGS", "Profit", ...uids]);
    // Another business sees none of it; staff can't download.
    const b = await workbook(world.uids.ownerb, "biz-b", { range: "all" });
    expect(allText(b.bytes)).not.toContain("Marian Santos");
    expect((await workbook(world.uids.staffa, "biz-a", {})).status).toBe(403);
  });

  it("the Master Backup is not for customers: Owner and Admin get 403 for their own business", async () => {
    for (const uid of [world.uids.ownera, world.uids.managera]) {
      const res = await createBackupHandler(deps())({ ...request({ uid, businessId: "biz-a", method: "POST" }), body: JSON.stringify({ businessId: "biz-a" }) });
      expect(res.statusCode).toBe(403);
    }
    expect((await createBackupHandler(deps())(asOperator(world, "biz-a"))).statusCode).toBe(200);
  });
});
