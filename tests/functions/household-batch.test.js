// Owner-pilot improvement batch (2026-10-11), Household / Kasambahay:
//   - pay periods from the staff record: 1–15 / 16–end, monthly, custom
//     semi-monthly cutoffs (14 / 29), short months;
//   - automatic payroll: everyone eligible appears per period, nothing is
//     stored by looking, history can be opened;
//   - early salary payment: allowed (not in the future), labelled, the days
//     after it stay open, the receipt stays the employee's own step;
//   - a per-helper cash advance limit: request / approve / release respect
//     it, payroll deductions free it again, lowering it keeps the debt;
//   - notification copy and the dashboard's pending requests per helper.
// Concurrency on the limit runs on the real emulator
// (tests/emulator/payroll-concurrency.test.js).

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createMeHandler } from "../../netlify/functions/me.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { householdSummary } from "../../netlify/functions/_lib/household-summary.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { periodFor, staffPeriod, staffPeriods, validateCutoffs, advanceCapacity, paidPayrollLocks } from "../../shared/payroll.js";
import { buildWorld, request } from "../helpers/tenants.js";

const H = "biz-home";
let world;
let u;
let clock;

beforeEach(async () => {
  clock = new Date("2026-10-11T04:00:00Z"); // Oct 11, 12:00 Manila
  world = await buildWorld();
  await createBusiness({ ...world, name: "Santos Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  for (const [key, role] of [["mom", "owner"], ["dad", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler, advances: createAdvancesHandler };
async function api(kind, uid, body) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId: H, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function me(uid, body = null, period = null) {
  const res = await createMeHandler(deps())({ ...request({ uid, businessId: H, method: body ? "POST" : "GET" }), ...(body ? { body: JSON.stringify(body) } : {}), ...(period ? { queryStringParameters: { period } } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const docsUnder = (c) => [...world.db.docs.keys()].filter((k) => k.startsWith(`businesses/${H}/${c}/`) && k.split("/").length === 4);
const OCT = (n) => `2026-10-${String(n).padStart(2, "0")}`;

async function staff(name, extra = {}) {
  const r = await api("staff", u.mom, { action: "create", staff: { name, position: "Kasambahay", dailyWage: 41100, payCycle: "semi_monthly", startDate: "2026-06-07", ...extra } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.staffId;
}
async function withLogin(staffId) {
  const r = await api("staff", u.mom, { action: "createLogin", staffId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const res = await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" }) });
  expect(res.statusCode).toBe(200);
  return r.body.uid;
}
const mark = (staffId, date, status) => api("attendance", u.mom, { action: "set", staffId, date, status });
const view = async (period = null) => {
  const r = await api("payroll", u.mom, { action: "period", ...(period ? { period } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.view;
};

describe("pay periods from the staff record", () => {
  it("semi-monthly 1–15 / 16–end, monthly, and custom 14 / 29 (February and 31-day months)", () => {
    expect(periodFor("semi_monthly", "2026-10-11")).toEqual({ start: OCT(1), end: OCT(15) });
    expect(periodFor("semi_monthly", "2026-10-31")).toEqual({ start: OCT(16), end: OCT(31) });
    expect(periodFor("semi_monthly", "2026-02-20")).toEqual({ start: "2026-02-16", end: "2026-02-28" });
    expect(periodFor("monthly", "2026-02-10")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodFor("monthly", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    const c = [14, 29];
    expect(periodFor("semi_monthly", OCT(11), c)).toEqual({ start: "2026-09-30", end: OCT(14) });
    expect(periodFor("semi_monthly", OCT(15), c)).toEqual({ start: OCT(15), end: OCT(29) });
    expect(periodFor("semi_monthly", OCT(30), c)).toEqual({ start: OCT(30), end: "2026-11-14" });
    // February: the 29th cutoff stops at Feb 28; March starts on the 1st.
    expect(periodFor("semi_monthly", "2026-02-20", c)).toEqual({ start: "2026-02-15", end: "2026-02-28" });
    expect(periodFor("semi_monthly", "2026-03-01", c)).toEqual({ start: "2026-03-01", end: "2026-03-14" });
    expect(periodFor("semi_monthly", "2026-01-31", c)).toEqual({ start: "2026-01-30", end: "2026-02-14" });
    // Leap year: Feb 29 is the cutoff itself.
    expect(periodFor("semi_monthly", "2028-02-29", c)).toEqual({ start: "2028-02-15", end: "2028-02-29" });
    // Consecutive periods never overlap or skip a day, all year round.
    let p = periodFor("semi_monthly", "2026-01-01", c);
    for (let i = 0; i < 30; i++) {
      const next = periodFor("semi_monthly", new Date(Date.parse(`${p.end}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), c);
      expect(Date.parse(`${next.start}T00:00:00Z`) - Date.parse(`${p.end}T00:00:00Z`)).toBe(86400000);
      p = next;
    }
  });

  it("cutoffs are validated: two days about half a month apart; 15 / 31 is the usual cycle", () => {
    expect(validateCutoffs([14, 29])).toEqual([14, 29]);
    expect(validateCutoffs([15, 31])).toBeNull();
    expect(validateCutoffs(null)).toBeNull();
    for (const bad of [[29, 14], [10, 12], [0, 15], [5, 30], [14], "14/29", [14.5, 29]]) expect(() => validateCutoffs(bad)).toThrow();
  });

  it("the Owner sets custom cutoffs on Household Staff; only for semi-monthly pay; history says so", async () => {
    const id = await staff("Yanie", { cutoffs: [14, 29] });
    expect(docAt(`householdStaff/${id}`).cutoffs).toEqual([14, 29]);
    expect(staffPeriod(docAt(`householdStaff/${id}`), OCT(11))).toEqual({ start: "2026-09-30", end: OCT(14) });
    expect((await api("staff", u.mom, { action: "create", staff: { name: "X", dailyWage: 1000, payCycle: "monthly", cutoffs: [14, 29] } })).status).toBe(400);
    // Switching to monthly clears them.
    expect((await api("staff", u.mom, { action: "update", staffId: id, changes: { payCycle: "monthly" } })).status).toBe(200);
    expect(docAt(`householdStaff/${id}`).cutoffs).toBeNull();
    expect(docAt(`householdStaff/${id}`).history.at(-1).label).toMatch(/Pay cycle: Monthly/);
  });
});

describe("automatic payroll: periods appear by themselves", () => {
  it("opens on the current period with everyone eligible (start / end dates, status); nothing is stored by looking", async () => {
    const y = await staff("Yanie");
    await staff("Riza", { startDate: OCT(20) }); // not yet employed in Oct 1–15
    const left = await staff("Lito", { startDate: "2026-09-01", endDate: "2026-09-20" });
    await mark(y, OCT(1), "present");
    await mark(y, OCT(2), "present");
    const v = await view();
    expect(v.period).toMatchObject({ start: OCT(1), end: OCT(15), state: "in_progress" });
    expect(v.rows.map((r) => r.staffName)).toEqual(["Yanie"]);
    expect(v.rows[0]).toMatchObject({ automatic: true, status: "draft", present: 2, basePay: 82200, netPay: 82200, id: `${y}_${OCT(1)}` });
    // Opening the page many times never creates a payroll.
    for (let i = 0; i < 5; i++) await view();
    expect(docsUnder("payrolls")).toEqual([]);
    // History: older periods can be opened; Lito is on Sep 16–30 (his last period) only.
    expect(v.periods.slice(0, 4).map((p) => `${p.start}_${p.end}`)).toEqual([`${OCT(1)}_${OCT(15)}`, "2026-09-16_2026-09-30", "2026-09-01_2026-09-15", "2026-08-16_2026-08-31"]);
    const sep = await view({ start: "2026-09-16", end: "2026-09-30" });
    expect(sep.period.state).toBe("ended");
    expect(sep.rows.map((r) => r.staffName).sort()).toEqual(["Lito", "Yanie"]);
    expect((await view({ start: OCT(16), end: OCT(31) })).period.start).toBe(OCT(1)); // not started: back to the current one
    expect(left).toBeTruthy();
    // The periods never reach before the earliest start date.
    expect(v.periods.at(-1).start >= "2026-06-01").toBe(true);
  });

  it("custom cutoffs show as their own periods; approved attendance and released advances are reflected automatically", async () => {
    const y = await staff("Yanie", { cutoffs: [14, 29] });
    await mark(y, OCT(1), "present");
    await mark(y, OCT(5), "official_leave");
    await mark(y, "2026-09-30", "present");
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: y, date: OCT(3), amount: 50000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: a });
    const v = await view();
    expect(v.period).toMatchObject({ start: "2026-09-30", end: OCT(14) });
    expect(v.rows[0]).toMatchObject({ present: 2, officialLeave: 1, basePay: 3 * 41100, deductionsTotal: 50000, netPay: 3 * 41100 - 50000, automatic: true });
  });

  it("different cutoffs (1–15 and 14 / 29): by default everyone shows in their OWN current period; each period opens on its own", async () => {
    const y = await staff("Yanie");
    const r = await staff("Riza", { cutoffs: [14, 29] });
    await mark(y, OCT(1), "present");
    await mark(r, "2026-09-30", "present");
    const v = await view();
    expect(v.period).toMatchObject({ mixed: true, state: "in_progress", start: "2026-09-30", end: OCT(15) });
    expect(v.rows.map((x) => [x.staffName, x.periodStart, x.periodEnd, x.present])).toEqual([["Riza", "2026-09-30", OCT(14), 1], ["Yanie", OCT(1), OCT(15), 1]]);
    expect((await view({ current: true })).period.mixed).toBe(true);
    const one = await view({ start: OCT(1), end: OCT(15) });
    expect(one.period.mixed).toBeUndefined();
    expect(one.rows.map((x) => x.staffName)).toEqual(["Yanie"]);
    expect(docsUnder("payrolls")).toEqual([]);
  });

  it("paying an automatic period stores it once (no duplicates); retrying is refused; the stored row replaces the worked-out one", async () => {
    const y = await staff("Yanie");
    clock = new Date("2026-10-16T04:00:00Z");
    for (const d of [1, 2, 3]) await mark(y, OCT(d), "present");
    const before = (await view({ start: OCT(1), end: OCT(15) })).rows[0];
    const pay = (b) => api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" }, expectedNetPay: before.netPay, ...b });
    const r = await pay();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ payrollId: `${y}_${OCT(1)}`, paymentTiming: "on_time", netPay: 3 * 41100 });
    expect((await pay()).body.error).toBe("payroll-released");
    expect(docsUnder("payrolls")).toEqual([`businesses/${H}/payrolls/${y}_${OCT(1)}`]);
    const after = (await view({ start: OCT(1), end: OCT(15) })).rows[0];
    expect(after).toMatchObject({ automatic: false, status: "released", ownerPayment: "paid", receiptStatus: "awaiting" });
  });

  it("the take-home changed since the Owner looked: refused, nothing paid", async () => {
    const y = await staff("Yanie");
    await mark(y, OCT(1), "present");
    const seen = (await view()).rows[0].netPay;
    await mark(y, OCT(2), "present");
    const r = await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" }, expectedNetPay: seen });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("amount-changed");
    expect(docAt(`payrolls/${y}_${OCT(1)}`).status).toBe("draft");
  });
});

describe("early salary payment", () => {
  it("paid on Oct 11 for Oct 1–15: allowed and labelled; a future date is refused; the days after it stay open; receipt not confirmed", async () => {
    const y = await staff("Yanie");
    const uid = await withLogin(y);
    for (const d of [1, 2, 3, 6, 7]) await mark(y, OCT(d), "present");
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash", paidDate: OCT(15) } })).body.error).toBe("invalid-date"); // Oct 15 hasn't happened yet
    expect(docsUnder("payrolls")).toEqual([]); // a refused payment stores nothing
    const r = await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "gcash", paidDate: OCT(11) } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.paymentTiming).toBe("early");
    const id = `${y}_${OCT(1)}`;
    expect(docAt(`payrolls/${id}`)).toMatchObject({ status: "released", paymentTiming: "early", salary: { amount: 5 * 41100, paidDate: OCT(11), timing: "early" }, receiptStatus: "awaiting", periodStart: OCT(1), periodEnd: OCT(15) });
    expect(docAt(`payrolls/${id}`).history.at(-1).label).toMatch(/Early salary payment .* on 2026-10-11 .*period ends 2026-10-15/);
    // Future days are NOT marked absent or locked.
    expect(docAt(`attendance/${y}_${OCT(12)}`)).toBeUndefined();
    // Days up to the payment date are locked; after it they stay open.
    expect((await mark(y, OCT(10), "present")).body.error).toBe("payroll-released");
    clock = new Date("2026-10-13T04:00:00Z");
    expect((await mark(y, OCT(12), "present")).status).toBe(200);
    // The staff sheet agrees: Oct 12–15 open, Oct 11 and before closed.
    const sheet = (await me(uid)).body.me.sheet;
    expect(sheet.days.find((d) => d.date === OCT(13)).lock).toBeNull();
    expect(sheet.days.find((d) => d.date === OCT(11)).lock).toBe("In a paid salary");
    expect((await me(uid, { action: "attendanceDays", days: [{ date: OCT(13), status: "present" }] })).body.sent).toBe(1);
    expect((await api("attendance", u.mom, { action: "decide", requestId: `${y}_${OCT(13)}`, decision: { decision: "approve" } })).status).toBe(200);
    // The original payment is kept; the final take-home moves with the days.
    const p = docAt(`payrolls/${id}`);
    expect(p.salary.amount).toBe(5 * 41100);
    expect(p).toMatchObject({ present: 7, basePay: 7 * 41100, netPay: 7 * 41100 });
    // The employee's confirmation stays their own step.
    expect(p.receiptStatus).toBe("awaiting");
    expect(paidPayrollLocks(p, OCT(11))).toBe(true);
    expect(paidPayrollLocks(p, OCT(12))).toBe(false);
  });

  it("a payment on or after the period end is on time and locks every day", async () => {
    const y = await staff("Yanie");
    clock = new Date("2026-10-16T04:00:00Z");
    await mark(y, OCT(15), "present");
    const r = await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } });
    expect(r.body.paymentTiming).toBe("on_time");
    expect((await mark(y, OCT(15), "absent")).body.error).toBe("payroll-released");
  });
});

describe("cash advance limit per helper", () => {
  const ask = (uid, amount) => me(uid, { action: "advance", amount });
  const limitOf = async (uid) => (await me(uid)).body.me.advanceLimit;

  it("₱5,000 limit with no balance: the full amount can be asked; above is refused (server side too)", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    expect(await limitOf(uid)).toMatchObject({ limit: 500000, outstanding: 0, available: 500000 });
    const over = await ask(uid, 500100);
    expect(over.status).toBe(409);
    expect(over.body.message).toBe("You can request up to ₱5,000.00 right now.");
    expect((await ask(uid, 500000)).status).toBe(200);
  });

  it("partial balance: Limit 5,000 · Outstanding 3,000 · Available 2,000; a deduction restores capacity automatically", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: y, date: OCT(2), amount: 300000, installment: 100000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: a });
    expect(await limitOf(uid)).toMatchObject({ limit: 500000, outstanding: 300000, available: 200000 });
    expect((await ask(uid, 250000)).body.message).toBe("You can request up to ₱2,000.00 right now.");
    // Payroll deducts ₱1,000: outstanding 2,000, available 3,000.
    clock = new Date("2026-10-16T04:00:00Z");
    for (const d of [1, 2, 3, 6]) await mark(y, OCT(d), "present");
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } })).status).toBe(200);
    expect(await limitOf(uid)).toMatchObject({ outstanding: 200000, available: 300000 });
  });

  it("full balance blocks a new request with a clear message", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: y, date: OCT(2), amount: 500000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: a });
    const r = await ask(uid, 10000);
    expect(r.status).toBe(409);
    expect(r.body.message).toBe("You still have ₱5,000.00 to repay before you can request another advance.");
    expect(await limitOf(uid)).toMatchObject({ outstanding: 500000, available: 0 });
  });

  it("lowering the limit below the debt keeps the debt (nothing forgiven) and blocks new requests", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    const a = (await api("advances", u.mom, { action: "create", advance: { staffId: y, date: OCT(2), amount: 400000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: a });
    expect((await api("staff", u.mom, { action: "update", staffId: y, changes: { advanceLimit: 300000 } })).status).toBe(200);
    expect(docAt(`householdStaff/${y}`).history.at(-1).label).toBe("Advance limit ₱5,000.00 → ₱3,000.00");
    expect(docAt(`advances/${a}`)).toMatchObject({ amount: 400000, deductedAmount: 0, status: "paid" });
    expect(await limitOf(uid)).toMatchObject({ limit: 300000, outstanding: 400000, available: 0 });
    expect((await ask(uid, 10000)).status).toBe(409);
    expect((await api("staff", u.mom, { action: "update", staffId: y, changes: { advanceLimit: -1 } })).status).toBe(400);
  });

  it("approval and release check the limit again (a request doesn't hold room); 0 = no advances; no limit = as before", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    const req = (await ask(uid, 300000)).body.advanceId;
    // Meanwhile the Owner records and releases ₱3,000.
    const other = (await api("advances", u.mom, { action: "create", advance: { staffId: y, date: OCT(2), amount: 300000 } })).body.advanceId;
    await api("advances", u.mom, { action: "markPaid", advanceId: other });
    const ap = await api("advances", u.mom, { action: "decide", advanceId: req, decision: { decision: "approve" } });
    expect(ap.status).toBe(409);
    expect(ap.body.error).toBe("over-advance-limit");
    expect(ap.body.message).toMatch(/Yanie's advance limit is ₱5,000\.00: ₱3,000\.00 still to repay\. At most ₱2,000\.00 more/);
    // A smaller approved amount fits.
    expect((await api("advances", u.mom, { action: "decide", advanceId: req, decision: { decision: "approve" }, approval: { amount: 200000 } })).status).toBe(200);
    // Release re-checks: the limit was lowered in between.
    await api("staff", u.mom, { action: "update", staffId: y, changes: { advanceLimit: 400000 } });
    expect((await api("advances", u.mom, { action: "markPaid", advanceId: req })).body.error).toBe("over-advance-limit");
    const z = await staff("Riza", { advanceLimit: 0 });
    expect((await ask(await withLogin(z), 100)).body.message).toMatch(/aren't available/);
    const free = await staff("Lito");
    expect(docAt(`householdStaff/${free}`).advanceLimit).toBeNull();
    expect((await api("advances", u.mom, { action: "create", advance: { staffId: free, date: OCT(2), amount: 9000000 } })).status).toBe(201);
  });

  it("staff can't edit their limit, approve or release their own advance", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const uid = await withLogin(y);
    const req = (await ask(uid, 100000)).body.advanceId;
    expect((await api("staff", uid, { action: "update", staffId: y, changes: { advanceLimit: 9900000 } })).status).toBe(403);
    expect((await api("advances", uid, { action: "decide", advanceId: req, decision: { decision: "approve" } })).status).toBe(403);
    expect((await api("advances", uid, { action: "markPaid", advanceId: req })).status).toBe(403);
    expect((await me(uid, { action: "advance", amount: 100, advanceLimit: 1 })).status).toBe(400);
    expect(docAt(`householdStaff/${y}`).advanceLimit).toBe(500000);
  });

  it("advanceCapacity: outstanding = released, not repaid; approved counts against the limit", () => {
    const cap = advanceCapacity({ advanceLimit: 500000 }, [
      { id: "a", status: "paid", amount: 300000, deductedAmount: 100000 },
      { id: "b", status: "not_yet_paid", amount: 100000 },
      { id: "c", status: "requested", amount: 50000, requestedAmount: 50000 },
      { id: "d", status: "rejected", amount: 999999 },
    ]);
    expect(cap).toEqual({ limit: 500000, outstanding: 200000, approved: 100000, requested: 50000, available: 200000 });
    expect(advanceCapacity({}, []).available).toBeNull();
  });
});

describe("notifications and the dashboard", () => {
  it("a multi-day submission reads in plain words; leave-only says Leave request", async () => {
    const y = await staff("Yanie");
    const uid = await withLogin(y);
    const list = [[1, "present"], [2, "present"], [3, "absent"], [4, "present"], [5, "official_leave"], [6, "present"]];
    await me(uid, { action: "attendanceDays", days: list.map(([d, status]) => ({ date: OCT(d), status })) });
    const notes = [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/members/${u.mom}/inbox/`)).map(([, v]) => v);
    expect(notes.at(-1)).toMatchObject({ title: "Attendance request", message: "Yanie submitted 6 days for Oct 1–6. 4 Present, 1 Absent, 1 Paid Leave.", recordId: `${y}_${OCT(1)}` });
    await me(uid, { action: "attendanceDays", days: [{ date: OCT(20), status: "official_leave" }, { date: "2026-11-02", status: "unpaid_leave" }] });
    const last = [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/members/${u.mom}/inbox/`)).map(([, v]) => v).at(-1);
    expect(last).toMatchObject({ title: "Leave request", message: "Yanie submitted 2 days for Oct 20 – Nov 2. 1 Paid Leave, 1 Unpaid Leave." });
  });

  it("pending requests are grouped per helper with their types; helpers with nothing pending aren't listed; the cutoff rows follow employment dates", async () => {
    const y = await staff("Yanie", { advanceLimit: 500000 });
    const r = await staff("Riza");
    await staff("Lito", { startDate: "2026-11-01" }); // not employed yet: not on this cutoff
    const yu = await withLogin(y);
    const ru = await withLogin(r);
    await me(yu, { action: "attendanceDays", days: [{ date: OCT(9), status: "present" }] });
    await me(yu, { action: "advance", amount: 100000 });
    await me(ru, { action: "attendanceDays", days: [{ date: OCT(20), status: "official_leave" }] });
    const s = await householdSummary({ db: world.db, tenant: tenantDb(world.db, H), business: { timezone: "Asia/Manila" }, now: clock });
    expect(s.pending.byStaff).toEqual([
      { staffId: y, name: "Yanie", attendance: 1, leave: 0, advances: 1, total: 2 },
      { staffId: r, name: "Riza", attendance: 0, leave: 1, advances: 0, total: 1 },
    ]);
    expect(s.staff.map((x) => x.name)).toEqual(["Riza", "Yanie"]);
  });
});

describe("a pay cycle change never pays a day twice", () => {
  it("Oct 1–15 paid, then cutoffs 14 / 29: Oct 15 (already paid) isn't counted again", async () => {
    const y = await staff("Yanie");
    clock = new Date("2026-10-16T04:00:00Z");
    await mark(y, OCT(15), "present");
    await mark(y, OCT(16), "present");
    expect((await api("payroll", u.mom, { action: "release", staffId: y, periodStart: OCT(1), payment: { method: "cash" } })).status).toBe(200);
    expect((await api("staff", u.mom, { action: "update", staffId: y, changes: { cutoffs: [14, 29] } })).status).toBe(200);
    const v = await view({ start: OCT(15), end: OCT(29) });
    expect(v.rows[0]).toMatchObject({ present: 1, basePay: 41100 });
    expect((await mark(y, OCT(15), "absent")).body.error).toBe("payroll-released");
    expect(staffPeriods({ payCycle: "semi_monthly", cutoffs: [14, 29] }, "2026-09-01", OCT(16)).map((p) => p.start)).toEqual([OCT(15), "2026-09-30", "2026-09-15", "2026-08-30"]);
  });
});
