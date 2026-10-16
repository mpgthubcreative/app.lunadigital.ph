// Owner-pilot polish (2026-10-16):
//   Correct payroll: a PAID payroll's breakdown is corrected line by line
//   (bonus / manual deduction / advance deduction / prepaid salary); the
//   payment record never changes (only Correct payment does). The final
//   salary vs the amount paid then settles as usual: salary overpayment
//   carried to the next unpaid payroll, or additional salary due.
//   Dashboard money: salary paid, still to pay, prepaid (inside paid),
//   advances outstanding, confirmation; Everyone or one helper.
//   Attendance: Clear a recorded day; the usual rest day on the staff record.
//   Give an advance: next payroll / no payroll deduction; quick result.

import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createHouseholdSummaryHandler } from "../../netlify/functions/household-summary.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { reconcileOf, advanceRemaining, expectedStatus } from "../../shared/payroll.js";
import { buildWorld, request } from "../helpers/tenants.js";

const H = "biz-home";
const W = 41100;
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
const HANDLERS = { staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler, advances: createAdvancesHandler };
async function api(kind, uid, body) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid, businessId: H, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function summary(uid = u.carlo) {
  const res = await createHouseholdSummaryHandler(deps())({ ...request({ uid, businessId: H, method: "GET" }) });
  return JSON.parse(res.body).summary;
}
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const under = (c) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/${c}/`) && k.split("/").length === 4).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
const OCT = (d) => `2026-10-${String(d).padStart(2, "0")}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const staff = async (name, extra = {}) => (await api("staff", u.carlo, { action: "create", staff: { name, dailyWage: W, payCycle: "semi_monthly", startDate: "2026-06-07", ...extra } })).body.staffId;
const mark = (staffId, dates, status = "present") => api("attendance", u.carlo, { action: "setMany", staffId, days: dates.map((date) => ({ date, status })) });
const row = async (staffId, start, end) => (await api("payroll", u.carlo, { action: "period", period: { start, end }, staffId })).body.view.rows[0];
async function withLogin(staffId) {
  const r = await api("staff", u.carlo, { action: "createLogin", staffId });
  await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: r.body.activationToken, password: "kape-at-pandesal" }) });
  return r.body.uid;
}

// The pilot's own numbers: Oct 1-13 present (₱5,343), advance ₱250, a manual
// deduction ₱350, paid on Oct 13 with 2 prepaid days (₱822): ₱5,565 paid.
async function loriza() {
  const lor = await staff("Loriza Ibanez", { advanceLimit: 500000 });
  at(OCT(13));
  await mark(lor, range(1, 13).map(OCT));
  const adv = (await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 25000, date: OCT(3), method: "cash" } })).body.advanceId;
  const pid = (await api("payroll", u.carlo, { action: "prepare", staffId: lor, periodStart: OCT(1) })).body.payrollId;
  await api("payroll", u.carlo, { action: "addDeduction", payrollId: pid, deduction: { description: "Broken plate", amount: 35000 } });
  const paid = await api("payroll", u.carlo, { action: "release", payrollId: pid, payment: { method: "gcash", prepaidDays: 2 } });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  expect(docAt(`payrolls/${pid}`).salary).toMatchObject({ amount: 556500, earned: 474300, prepaid: { days: 2, amount: 82200 }, atPayment: { basePay: 534300, deductionsTotal: 60000 } });
  return { lor, adv, pid };
}
const manualId = (pid) => docAt(`payrolls/${pid}`).deductions.find((d) => d.type === "manual").id;
const fix = (pid, change, reason = "Typed the wrong amount", uid = u.carlo) => api("payroll", uid, { action: "correctPayroll", payrollId: pid, change, reason });

describe("Correct payroll vs Correct payment", () => {
  it("the pilot's case: paid ₱5,565; the deduction corrected ₱350 -> ₱600; entitlement ₱5,315; ₱250 salary overpayment carried to the next payroll; the payment untouched", async () => {
    const { lor, pid } = await loriza();
    at(OCT(16));
    await mark(lor, [OCT(14), OCT(15), OCT(16)]);
    const next = (await api("payroll", u.carlo, { action: "prepare", staffId: lor, periodStart: OCT(16) })).body.payrollId;
    expect(reconcileOf(docAt(`payrolls/${pid}`), OCT(16))).toMatchObject({ settled: true, paid: 556500, final: 556500 });
    const r = await fix(pid, { op: "line", lineId: manualId(pid), amount: 60000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = docAt(`payrolls/${pid}`);
    expect(p.salary.amount).toBe(556500); // actually paid: unchanged
    expect(p.netPay).toBe(531500); // corrected entitlement
    expect(reconcileOf(p, OCT(16))).toMatchObject({ paid: 556500, final: 531500, overpaid: 25000, outstanding: 25000 });
    expect(docAt(`payrolls/${next}`).deductions.find((d) => d.type === "overpayment")).toMatchObject({ sourcePayrollId: pid, amount: 25000 });
    expect(p.history.at(-1).label).toMatch(/Payroll corrected: Deduction corrected ₱350\.00 → ₱600\.00 \(Broken plate\) · Reason: Typed the wrong amount/);
    expect(p.corrections.at(-1)).toMatchObject({ op: "line", before: { amount: 35000 }, after: { amount: 60000 }, reason: "Typed the wrong amount" });
    // Removing the deduction instead: ₱5,915 earned > ₱5,565 paid: additional salary due ₱350; the carried line goes.
    await fix(pid, { op: "line", lineId: manualId(pid), remove: true });
    expect(reconcileOf(docAt(`payrolls/${pid}`), OCT(16))).toMatchObject({ final: 591500, additionalDue: 35000, outstanding: 0 });
    expect(docAt(`payrolls/${next}`).deductions.some((d) => d.type === "overpayment")).toBe(false);
    // Correct payment changes only the payment, never the breakdown.
    const before = docAt(`payrolls/${pid}`).netPay;
    expect((await api("payroll", u.carlo, { action: "correctPayment", payrollId: pid, correction: { amount: 591500 }, reason: "Gave the rest in cash" })).status).toBe(200);
    expect(docAt(`payrolls/${pid}`).netPay).toBe(before);
    expect(reconcileOf(docAt(`payrolls/${pid}`), OCT(16))).toMatchObject({ settled: true });
  });

  it("bonus: edit and remove; reason required; Basic pay can't be typed; staff refused", async () => {
    const { pid } = await loriza();
    const uid = await withLogin(docAt(`payrolls/${pid}`).staffId);
    // A bonus given with the payroll (added before paying, in a fresh case).
    expect((await fix(pid, { op: "line", lineId: manualId(pid), amount: 40000 }, "")).body.error).toBe("reason-required");
    expect((await fix(pid, { op: "basic", amount: 1 })).status).toBe(400);
    expect((await fix(pid, { op: "line", lineId: manualId(pid), amount: 40000 }, "please", uid)).status).toBe(403);
    expect((await fix(pid, { op: "line", lineId: manualId(pid), amount: 40000, description: "Broken glass" })).status).toBe(200);
    expect(docAt(`payrolls/${pid}`).deductions.find((d) => d.type === "manual")).toMatchObject({ amount: 40000, description: "Broken glass" });
    expect((await fix(pid, { op: "line", lineId: manualId(pid), amount: 40000, description: "Broken glass" })).body.unchanged).toBe(true);
  });

  it("bonus lines on a paid payroll can be edited or removed", async () => {
    const lor = await staff("Ana");
    at(OCT(13));
    await mark(lor, range(1, 13).map(OCT));
    const pid = (await api("payroll", u.carlo, { action: "prepare", staffId: lor, periodStart: OCT(1) })).body.payrollId;
    await api("payroll", u.carlo, { action: "addAddition", payrollId: pid, addition: { type: "bonus", amount: 50000, description: "Fiesta" } });
    await api("payroll", u.carlo, { action: "release", payrollId: pid, payment: { method: "cash" } });
    const bonus = docAt(`payrolls/${pid}`).additions[0].id;
    expect((await fix(pid, { op: "line", lineId: bonus, amount: 30000 })).status).toBe(200);
    expect(docAt(`payrolls/${pid}`)).toMatchObject({ additionsTotal: 30000, netPay: 534300 + 30000 });
    expect((await fix(pid, { op: "line", lineId: bonus, remove: true })).status).toBe(200);
    expect(docAt(`payrolls/${pid}`)).toMatchObject({ additions: [], additionsTotal: 0, netPay: 534300 });
    expect(docAt(`payrolls/${pid}`).salary.amount).toBe(584300); // what was paid stays
  });

  it("advance deduction: corrected ₱250 -> ₱100 (₱150 owed again, 'not taken' on that period), then removed (all owed); the advance itself stays", async () => {
    const { adv, pid } = await loriza();
    expect(docAt(`advances/${adv}`).deductedAmount).toBe(25000);
    expect((await fix(pid, { op: "advance", advanceId: adv, amount: 10000 })).status).toBe(200);
    let a = docAt(`advances/${adv}`);
    expect(a.deductedAmount).toBe(10000);
    expect(advanceRemaining(a)).toBe(15000);
    expect(a.schedule.filter((e) => e.payrollId === pid).map((e) => [e.state, e.amount]).sort()).toEqual([["applied", 10000], ["not_taken", 15000]]);
    expect(docAt(`payrolls/${pid}`).deductions.find((d) => d.type === "advance").amount).toBe(10000);
    expect((await row(docAt(`payrolls/${pid}`).staffId, OCT(1), OCT(15))).notTaken).toEqual([expect.objectContaining({ advanceId: adv, amount: 15000 })]);
    // More than what's owed is refused (₱100 deducted + ₱150 owed = ₱250 at most).
    expect((await fix(pid, { op: "advance", advanceId: adv, amount: 30000 })).body.error).toBe("invalid-amount");
    expect((await fix(pid, { op: "advance", advanceId: adv, amount: 0 }, "Wasn't deducted after all")).status).toBe(200);
    a = docAt(`advances/${adv}`);
    expect(a.deductedAmount).toBe(0);
    expect(advanceRemaining(a)).toBe(25000);
    expect(a.status).toBe("paid");
    expect(docAt(`payrolls/${pid}`).deductions.some((d) => d.type === "advance")).toBe(false);
    expect(a.history.at(-1).label).toMatch(/corrected ₱100\.00 → ₱0\.00 · ₱250\.00 left · Reason: Wasn't deducted after all/);
    // Once taken off, the line is gone (plan it again from the advance).
    expect((await fix(pid, { op: "advance", advanceId: adv, amount: 10000 })).body.error).toBe("not-found");
  });

  it("a higher advance deduction trims later plans so they never exceed what's owed", async () => {
    const { adv, pid } = await loriza();
    await api("advances", u.carlo, { action: "schedule", advanceId: adv, schedule: [] }); // nothing more planned yet
    // Correct down (₱150 owed again, not taken), plan it on Oct 16-31, then correct back up.
    await fix(pid, { op: "advance", advanceId: adv, amount: 10000 });
    const a1 = docAt(`advances/${adv}`);
    await api("advances", u.carlo, { action: "schedule", advanceId: adv, schedule: [{ periodStart: OCT(16), amount: 15000, state: "planned" }] });
    expect((await fix(pid, { op: "advance", advanceId: adv, amount: 25000 })).status).toBe(200);
    const a = docAt(`advances/${adv}`);
    expect(advanceRemaining(a)).toBe(0);
    expect(a.schedule.filter((e) => e.state === "planned" || e.state === "not_taken").reduce((t, e) => t + e.amount, 0)).toBe(0);
    expect(a1.deductedAmount).toBe(10000);
  });

  it("prepaid salary: 2 days -> 1 day; total paid unchanged; earned = paid - prepaid; the original kept", async () => {
    const { pid } = await loriza();
    expect((await fix(pid, { op: "prepaid", days: 1 }, "Only Oct 14 was meant")).status).toBe(200);
    const s = docAt(`payrolls/${pid}`).salary;
    expect(s).toMatchObject({ amount: 556500, earned: 556500 - 41100, prepaid: { days: 1, from: OCT(14), to: OCT(14), amount: 41100 } });
    expect(s.prepaidCorrections[0]).toMatchObject({ before: { days: 2, amount: 82200 }, after: { days: 1, amount: 41100 }, reason: "Only Oct 14 was meant" });
    expect((await fix(pid, { op: "prepaid", days: 3 })).body.error).toBe("invalid-input"); // only Oct 14-15 came after
  });
});

describe("Dashboard money for this cutoff", () => {
  it("paid / still to pay / prepaid (inside paid) / advances outstanding / confirmation, per helper; voided payrolls drop out", async () => {
    const { lor, pid } = await loriza();
    const ana = await staff("Ana");
    await mark(ana, range(1, 13).map(OCT));
    const s = await summary();
    const L = s.staff.find((x) => x.staffId === lor);
    const A = s.staff.find((x) => x.staffId === ana);
    expect(L.money).toMatchObject({ salaryPaid: 556500, prepaid: 82200, stillToPay: 0, advancesOutstanding: 0 });
    expect(L.confirmation).toEqual({ state: "waiting" });
    expect(A.money).toMatchObject({ salaryPaid: 0, prepaid: 0, stillToPay: 13 * W, advancesOutstanding: 0 });
    expect(A.confirmation).toBeNull();
    // A new advance counts as outstanding until it's really repaid.
    await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 50000, date: OCT(13), method: "cash" } });
    expect((await summary()).staff.find((x) => x.staffId === lor).money.advancesOutstanding).toBe(50000);
    // Voided: the paid salary leaves the figures (still to pay comes back).
    await api("payroll", u.carlo, { action: "void", payrollId: pid, reason: "Entered twice" });
    const v = (await summary()).staff.find((x) => x.staffId === lor);
    expect(v.money.salaryPaid).toBe(0);
    expect(v.money.stillToPay).toBeGreaterThan(0);
    expect(v.confirmation).toBeNull();
  });
});

describe("Dashboard: an ended period nobody paid (never saved) is flagged", () => {
  it("Oct 1-15 worked, not paid, no payroll saved: shown as unpaid from an ended period on Oct 16", async () => {
    const ana = await staff("Ana");
    await mark(ana, range(1, 13).map(OCT));
    at(OCT(16));
    const s = await summary();
    expect(s.staff[0].overdue).toEqual([{ payrollId: null, period: { start: OCT(1), end: OCT(15) }, netPay: 13 * W, automatic: true }]);
    expect(s.overdueTotal).toBe(13 * W);
    // Paid: no longer flagged.
    await api("payroll", u.carlo, { action: "release", staffId: ana, periodStart: OCT(1), payment: { method: "cash" } });
    expect((await summary()).overdueTotal).toBe(0);
  });
});

describe("Bell: what needs attention, one sentence per item, by helper, with deep links", () => {
  it("unrecorded prepaid days, salary / advance not confirmed, an ended period nobody paid; gone once handled", async () => {
    const lor = await staff("Loriza Ibanez");
    const ana = await staff("Ana");
    at(OCT(13));
    await mark(lor, range(1, 13).map(OCT));
    await mark(ana, range(1, 13).map(OCT));
    const adv = (await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 50000, date: OCT(13), method: "cash" } })).body.advanceId;
    await api("payroll", u.carlo, { action: "release", staffId: lor, periodStart: OCT(1), payment: { method: "cash", prepaidDays: 2 } });
    at(OCT(16));
    const todos = (await summary()).todos;
    const of = (kind) => todos.filter((x) => x.kind === kind).map((x) => [x.name, x.text, x.href]);
    expect(of("unrecordedDays")).toEqual([["Loriza Ibanez", "2 attendance days of Loriza's Oct 1–15 still need to be recorded (salary paid early).", `/attendance?staff=${lor}&period=${OCT(1)}`]]);
    expect(of("salaryConfirmation")).toEqual([["Loriza Ibanez", "Loriza hasn't confirmed the Oct 1–15 salary yet.", `/payroll?staff=${lor}&period=${OCT(1)}_${OCT(15)}`]]);
    expect(of("advanceConfirmation")).toEqual([["Loriza Ibanez", "Loriza hasn't confirmed receiving the ₱500.00 advance (Oct 13).", `/advances?advance=${adv}`]]);
    expect(of("unpaid")).toEqual([["Ana", "Ana's Oct 1–15 salary (₱5,343.00) hasn't been paid yet.", `/payroll?staff=${ana}&period=${OCT(1)}_${OCT(15)}`]]);
    expect(todos.map((x) => x.name)).toEqual([...todos.map((x) => x.name)].sort((a, b) => a.localeCompare(b)));
    // Handled -> gone.
    await mark(lor, [OCT(14), OCT(15)]);
    await api("payroll", u.carlo, { action: "release", staffId: ana, periodStart: OCT(1), payment: { method: "cash" } });
    const after = (await summary()).todos;
    expect(after.filter((x) => x.staffId === lor).map((x) => x.kind)).not.toContain("unrecordedDays");
    expect(after.map((x) => x.kind)).not.toContain("unpaid");
    // Ana was paid with Oct 14-15 still unmarked: those days are asked for now.
    expect(after.filter((x) => x.staffId === ana).map((x) => x.text)).toContain("2 attendance days of Ana's Oct 1–15 still need to be recorded (salary already paid).");
  });
});

describe("Attendance: Clear a day; usual rest day", () => {
  it("a recorded day goes back to Not marked (unpaid payroll moves, audit kept); upcoming days refused; the normal week proposes Rest Day on the usual day", async () => {
    const lor = await staff("Loriza Ibanez", { restDays: [6, 0] });
    expect(docAt(`householdStaff/${lor}`).restDays).toEqual([0, 6]);
    expect((await api("staff", u.carlo, { action: "update", staffId: lor, changes: { restDays: [7] } })).status).toBe(400);
    at(OCT(13));
    await mark(lor, range(1, 13).map(OCT));
    const pid = (await api("payroll", u.carlo, { action: "prepare", staffId: lor, periodStart: OCT(1) })).body.payrollId;
    const r = await mark(lor, [OCT(4)], "clear");
    expect(r.body.failed).toEqual([]);
    expect(docAt(`attendance/${lor}_${OCT(4)}`)).toBeUndefined();
    expect(docAt(`payrolls/${pid}`)).toMatchObject({ present: 12, notMarked: 3, basePay: 12 * W });
    expect(under("auditLog").some((a) => a.type === "attendance.cleared" && a.date === OCT(4) && a.before.status === "present")).toBe(true);
    expect((await mark(lor, [OCT(4)], "clear")).body.saved[0].unchanged).toBe(true);
    expect((await mark(lor, [OCT(14)], "clear")).body.failed[0].code).toBe("invalid-date");
    expect(expectedStatus(docAt(`householdStaff/${lor}`), OCT(10))).toBe("rest_day"); // a Saturday
    expect(expectedStatus(docAt(`householdStaff/${lor}`), OCT(12))).toBe("present");
    expect(expectedStatus({}, OCT(11))).toBe("rest_day"); // not set: Sunday
  });
});

describe("Give an advance: one step", () => {
  it("next payroll by default; No payroll deduction leaves no plan; the quick result; the limit still enforced by the server", async () => {
    const lor = await staff("Loriza Ibanez", { advanceLimit: 200000 });
    at(OCT(16));
    const a1 = await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 50000, date: OCT(16), method: "cash" } });
    expect(a1.body).toMatchObject({ status: "paid", outstanding: 50000, available: 150000, staffName: "Loriza Ibanez" });
    expect(a1.body.schedule).toEqual([expect.objectContaining({ periodStart: OCT(16), amount: 50000, state: "planned" })]);
    const a2 = await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 30000, date: OCT(16), method: "cash", plan: "none" } });
    expect(a2.body).toMatchObject({ schedule: [], outstanding: 80000, available: 120000 });
    expect(docAt(`advances/${a2.body.advanceId}`).history[0].label).toMatch(/no payroll deduction planned/);
    expect((await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 130000, date: OCT(16), method: "cash" } })).status).toBe(409);
    expect((await api("advances", u.carlo, { action: "give", advance: { staffId: lor, amount: 100, date: OCT(16), method: "cash", plan: "weekly" } })).status).toBe(400);
  });
});
