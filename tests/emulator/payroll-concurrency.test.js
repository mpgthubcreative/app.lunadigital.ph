// Phase 14 payroll concurrency on the REAL Firestore emulator (Admin SDK).
// After every race:
//   - a draft payroll's counts / base / net equal a fresh calculation from
//     its attendance lines and deductions;
//   - a paid advance is deducted by exactly one payroll (never twice, never lost);
//   - a release and an attendance edit never both win on a paid period;
//   - a receipt link confirms once.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { summarizeAttendance, deductionsTotal, daysIn } from "../../shared/index.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const NOW = new Date("2026-10-16T04:00:00Z");
let db, admin, FieldValue, pay, prov, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  FieldValue = admin.firestore.FieldValue;
  pay = await import("../../netlify/functions/_lib/payroll.js");
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  await prov.seedPlans({ db, admin, overwrite: true });
});

const CONTENDED = 10;
const ok = (r) => r.filter((x) => x.status === "fulfilled");
function expectExplicit(results, codes = []) {
  for (const r of results) if (r.status === "rejected") expect([CONTENDED, ...codes], String(r.reason && r.reason.message)).toContain(r.reason && r.reason.code);
}

async function world() {
  run += 1;
  const id = `payr-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `Home ${run}`, planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: id });
  await prov.addMember({ db, admin, businessId: id, uid: `owner-${id}`, email: `o${run}@pay.test`, name: "Owner", roleTemplate: "owner", isAccountOwner: true });
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila" };
  const actor = { uid: `owner-${id}`, name: "Owner", email: "" };
  const c = { db, tenant, FieldValue, business, actor, now: NOW };
  const { staffId } = await pay.createStaff({ ...c, input: { name: "Maria", dailyWage: 60000, payCycle: "semi_monthly" } });
  return { c, tenant, staffId };
}

// The draft payroll must equal a fresh calculation from its lines + deductions.
async function consistent(w, payrollId) {
  const p = (await w.tenant.doc("payrolls", payrollId).get()).data();
  const days = daysIn({ start: p.periodStart, end: p.periodEnd });
  const snaps = await db.getAll(...days.map((d) => w.tenant.doc("attendance", `${w.staffId}_${d}`)));
  const sum = summarizeAttendance(snaps.filter((s) => s.exists).map((s) => s.data()), { start: p.periodStart, end: p.periodEnd });
  for (const k of ["present", "absent", "officialLeave", "notMarked", "payableDays", "basePay"]) expect(p[k], k).toBe(sum[k]);
  expect(p.deductionsTotal).toBe(deductionsTotal(p.deductions));
  expect(p.netPay).toBe(p.basePay - p.deductionsTotal);
  return p;
}

describe("attendance edits racing each other and the payroll", () => {
  it("15 days marked in parallel, then 15 flips in parallel: the draft always matches its lines", async () => {
    const w = await world();
    const { payrollId } = await pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01" });
    const days = daysIn({ start: "2026-10-01", end: "2026-10-15" });
    let r = await Promise.allSettled(days.map((d, i) => pay.setAttendance({ ...w.c, input: { staffId: w.staffId, date: d, status: i % 5 === 0 ? "absent" : "present" } })));
    expectExplicit(r);
    await consistent(w, payrollId);
    r = await Promise.allSettled([...days, ...days].map((d, i) => pay.setAttendance({ ...w.c, input: { staffId: w.staffId, date: d, status: ["present", "absent", "official_leave"][i % 3] } })));
    expectExplicit(r);
    await consistent(w, payrollId);
  });

  it("a release racing attendance edits: edits before it count, edits after it are refused", async () => {
    const w = await world();
    const days = daysIn({ start: "2026-10-01", end: "2026-10-15" });
    for (const d of days) await pay.setAttendance({ ...w.c, input: { staffId: w.staffId, date: d, status: "present" } });
    const { payrollId } = await pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01" });
    const r = await Promise.allSettled([
      ...days.slice(0, 6).map((d) => pay.setAttendance({ ...w.c, input: { staffId: w.staffId, date: d, status: "absent" } })),
      pay.releaseSalary({ ...w.c, payrollId, release: { method: "cash" } }),
    ]);
    expectExplicit(r, ["payroll-released"]);
    const p = (await w.tenant.doc("payrolls", payrollId).get()).data();
    expect(p.status).toBe("released");
    // the paid amount equals the period's lines at the moment of release
    const lines = await db.getAll(...days.map((d) => w.tenant.doc("attendance", `${w.staffId}_${d}`)));
    const sum = summarizeAttendance(lines.map((s) => s.data()), { start: "2026-10-01", end: "2026-10-15" });
    expect(p.salary.amount).toBe(sum.basePay);
    expect(p.basePay).toBe(sum.basePay);
  });
});

describe("advances: deducted exactly once", () => {
  // Owner-pilot simplification batch: an advance is deducted by the payroll
  // its repayment plan names; released while that payroll is being stored,
  // it still lands in it exactly once.
  it("marking advances paid while the payroll is being prepared: each lands in exactly one payroll", async () => {
    const w = await world();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await pay.createAdvance({ ...w.c, input: { staffId: w.staffId, date: "2026-10-02", amount: 10000 + i } })).advanceId);
    const r = await Promise.allSettled([...ids.map((advanceId) => pay.markAdvancePaid({ ...w.c, advanceId, release: { paidDate: "2026-10-02" } })), pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01" })]);
    expectExplicit(r, ["advance-paid"]);
    const p = await consistent(w, `${w.staffId}_2026-10-01`);
    expect(p.deductions.map((d) => d.advanceId).sort()).toEqual([...ids].sort());
    // The next payroll doesn't deduct them again.
    const next = await pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-16", now: new Date("2026-11-01T04:00:00Z") });
    expect((await w.tenant.doc("payrolls", next.payrollId).get()).data().deductions).toEqual([]);
  });

  it("two DIFFERENT periods prepared at once never both deduct the same advance (its plan names one)", async () => {
    for (let round = 0; round < 3; round++) {
      const w = await world();
      const { advanceId } = await pay.createAdvance({ ...w.c, input: { staffId: w.staffId, date: "2026-09-02", amount: 30000 } });
      await pay.markAdvancePaid({ ...w.c, advanceId, release: { paidDate: "2026-10-02" } });
      const later = new Date("2026-11-01T04:00:00Z");
      const r = await Promise.allSettled(["2026-10-01", "2026-10-16", "2026-09-16"].map((periodStart) => pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart, now: later })));
      expectExplicit(r);
      const drafts = (await w.tenant.collection("payrolls").get()).docs.map((d) => d.data());
      expect(drafts.flatMap((p) => p.deductions).filter((d) => d.advanceId === advanceId).length, `round ${round}`).toBe(1);
    }
  });

  it("plan changes racing the payment: the payroll's lines always match the plans, and nothing is deducted twice", async () => {
    const w = await world();
    for (const d of daysIn({ start: "2026-10-01", end: "2026-10-10" })) await pay.setAttendance({ ...w.c, input: { staffId: w.staffId, date: d, status: "present" } });
    const { advanceId } = await pay.createAdvance({ ...w.c, input: { staffId: w.staffId, date: "2026-10-02", amount: 110000 } });
    await pay.markAdvancePaid({ ...w.c, advanceId, release: { paidDate: "2026-10-02" } });
    const { payrollId } = await pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01" });
    const r = await Promise.allSettled([
      pay.setAdvanceSchedule({ ...w.c, advanceId, schedule: [{ periodStart: "2026-10-01", amount: 60000 }, { periodStart: "2026-10-16", amount: 50000 }] }),
      pay.setAdvanceSchedule({ ...w.c, advanceId, schedule: [{ periodStart: "2026-10-01", amount: 30000 }, { periodStart: "2026-10-16", amount: 80000 }] }),
      pay.releaseSalary({ ...w.c, payrollId, release: { method: "cash" } }),
      pay.recordAdvanceRepayment({ ...w.c, advanceId, repayment: { amount: 10000, method: "cash" } }),
    ]);
    expectExplicit(r, ["payroll-released", "over-owed"]);
    const p = (await w.tenant.doc("payrolls", payrollId).get()).data();
    const a = (await w.tenant.doc("advances", advanceId).get()).data();
    const line = (p.deductions || []).find((d) => d.advanceId === advanceId)?.amount ?? 0;
    expect(p.status).toBe("released");
    expect(p.salary.amount).toBe(p.basePay - p.deductionsTotal);
    // What the paid payroll took is exactly what the advance records as deducted.
    expect(a.deductedAmount).toBe(line);
    expect(a.amount - a.deductedAmount - (a.repaidAmount || 0)).toBeGreaterThanOrEqual(0);
    const applied = (a.schedule || []).filter((e) => e.state === "applied").reduce((t, e) => t + e.amount, 0);
    expect(applied).toBe(line);
    const open = (a.schedule || []).filter((e) => e.state === "planned" || e.state === "not_taken").reduce((t, e) => t + e.amount, 0);
    expect(open).toBeLessThanOrEqual(a.amount - a.deductedAmount - (a.repaidAmount || 0));
  });

  it("repayments racing each other never go below zero owed", async () => {
    const w = await world();
    const { advanceId } = await pay.createAdvance({ ...w.c, input: { staffId: w.staffId, date: "2026-10-02", amount: 50000 } });
    await pay.markAdvancePaid({ ...w.c, advanceId, release: { paidDate: "2026-10-02" } });
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => pay.recordAdvanceRepayment({ ...w.c, advanceId, repayment: { amount: 20000, method: "cash" } })));
    expectExplicit(r, ["over-owed"]);
    const a = (await w.tenant.doc("advances", advanceId).get()).data();
    expect(ok(r).length).toBe(2);
    expect(a.repaidAmount).toBe(40000);
    expect(a.repayments).toHaveLength(2);
  });

  it("the same period prepared 6 times at once: one payroll", async () => {
    const w = await world();
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01" })));
    expectExplicit(r);
    expect(new Set(ok(r).map((x) => x.value.payrollId)).size).toBe(1);
    expect((await w.tenant.collection("payrolls").get()).size).toBe(1);
  });
});

describe("receipt confirmation", () => {
  it("the same link confirmed 6 times at once: confirmed once, one notification", async () => {
    const w = await world();
    for (const d of daysIn({ start: "2026-10-01", end: "2026-10-15" })) await pay.setAttendance({ ...w.c, input: { staffId: w.staffId, date: d, status: "present" } });
    const { payrollId } = await pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01" });
    const { receiptToken } = await pay.releaseSalary({ ...w.c, payrollId, release: { method: "cash" } });
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => pay.confirmReceipt({ db, FieldValue, token: receiptToken, now: NOW })));
    expectExplicit(r);
    expect(ok(r).filter((x) => x.value.confirmed).length).toBe(1);
    expect((await w.tenant.doc("payrolls", payrollId).get()).data().receiptStatus).toBe("confirmed");
    const inbox = await w.tenant.member(w.c.actor.uid).collection("inbox").get();
    expect(inbox.docs.filter((d) => d.data().type === "payroll.receipt_confirmed")).toHaveLength(1);
  });
});

// Owner-pilot batch: the per-helper cash advance limit under contention.
// Every path writes the staff document, so parallel requests, approvals and
// releases are serialized and can never push a helper over the limit.
const helperUid = (w) => `helper-${w.c.business.id}`;
const outstandingOf = async (w) => (await w.tenant.collection("advances").where("staffId", "==", w.staffId).get()).docs.map((d) => d.data()).reduce((t, a) => t + (a.status === "paid" ? a.amount - (a.deductedAmount || 0) : 0), 0);

describe("cash advance limit: never exceeded by parallel actions", () => {
  it("6 staff requests of ₱2,000 at once with a ₱5,000 limit: at most ₱4,000 waiting", async () => {
    const w = await world();
    await pay.updateStaff({ ...w.c, staffId: w.staffId, changes: { advanceLimit: 500000 } });
    const actor = { uid: helperUid(w), name: "Maria" };
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => pay.requestAdvance({ ...w.c, staffId: w.staffId, input: { amount: 200000 }, actor })));
    expectExplicit(r, ["over-advance-limit", "too-many-requests"]);
    const requested = (await w.tenant.collection("advances").where("status", "==", "requested").get()).docs.reduce((t, d) => t + d.data().amount, 0);
    expect(ok(r).length).toBe(2);
    expect(requested).toBe(400000);
  });

  it("approvals racing: the approved total stays within the limit", async () => {
    const w = await world();
    const actor = { uid: helperUid(w), name: "Maria" };
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await pay.requestAdvance({ ...w.c, staffId: w.staffId, input: { amount: 200000 }, actor })).advanceId);
    await pay.updateStaff({ ...w.c, staffId: w.staffId, changes: { advanceLimit: 500000 } });
    const r = await Promise.allSettled(ids.map((advanceId) => pay.decideAdvanceRequest({ ...w.c, advanceId, decision: { decision: "approve" } })));
    expectExplicit(r, ["over-advance-limit"]);
    expect(ok(r).length).toBe(2);
    const approved = (await w.tenant.collection("advances").where("status", "==", "not_yet_paid").get()).docs.reduce((t, d) => t + d.data().amount, 0);
    expect(approved).toBeLessThanOrEqual(500000);
  });

  it("releases racing after the limit was lowered: what's outstanding never passes it", async () => {
    const w = await world();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await pay.createAdvance({ ...w.c, input: { staffId: w.staffId, date: "2026-10-02", amount: 200000 } })).advanceId);
    await pay.updateStaff({ ...w.c, staffId: w.staffId, changes: { advanceLimit: 500000 } });
    const r = await Promise.allSettled(ids.map((advanceId) => pay.markAdvancePaid({ ...w.c, advanceId, release: {} })));
    expectExplicit(r, ["over-advance-limit"]);
    expect(ok(r).length).toBe(2);
    expect(await outstandingOf(w)).toBe(400000);
  });
});

describe("early salary payment racing attendance", () => {
  it("paid on Oct 11 while days after it are approved: the days up to it are locked, later ones count, totals stay consistent", async () => {
    const w = await world();
    const early = { ...w.c, now: new Date("2026-10-11T04:00:00Z") };
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-06"]) await pay.setAttendance({ ...early, input: { staffId: w.staffId, date: d, status: "present" } });
    const { payrollId } = await pay.preparePayroll({ ...early, staffId: w.staffId, periodStart: "2026-10-01" });
    const later = { ...w.c, now: new Date("2026-10-15T04:00:00Z") };
    const r = await Promise.allSettled([
      pay.releaseSalary({ ...early, payrollId, release: { method: "cash" } }),
      ...["2026-10-12", "2026-10-13", "2026-10-14"].map((d) => pay.setAttendance({ ...later, input: { staffId: w.staffId, date: d, status: "present" } })),
      pay.setAttendance({ ...later, input: { staffId: w.staffId, date: "2026-10-03", status: "present" } }),
    ]);
    expectExplicit(r, ["payroll-released"]);
    const p = await consistent(w, payrollId);
    expect(p.status).toBe("released");
    expect(p.paymentTiming).toBe("early");
    // Oct 12-14 always count (after the payment date); the payment itself is kept as paid.
    for (const d of ["2026-10-12", "2026-10-13", "2026-10-14"]) expect((await w.tenant.doc("attendance", `${w.staffId}_${d}`).get()).data().status).toBe("present");
    expect(p.salary.amount).toBeLessThanOrEqual(p.netPay);
    await expect(pay.setAttendance({ ...later, input: { staffId: w.staffId, date: "2026-10-05", status: "present" } })).rejects.toMatchObject({ code: "payroll-released" });
  });
});

// Owner-pilot change: voids racing other money actions.
describe("void racing repayments and plans", () => {
  it("a paid payroll voided while its advance is repaid and replanned: the books stay whole", async () => {
    const w = await world();
    for (const d of daysIn({ start: "2026-10-01", end: "2026-10-05" })) await pay.setAttendance({ ...w.c, input: { staffId: w.staffId, date: d, status: "present" } });
    const { advanceId } = await pay.createAdvance({ ...w.c, input: { staffId: w.staffId, date: "2026-10-02", amount: 100000 } });
    await pay.markAdvancePaid({ ...w.c, advanceId, release: { paidDate: "2026-10-02" } });
    await pay.setAdvanceSchedule({ ...w.c, advanceId, schedule: [{ periodStart: "2026-10-01", amount: 40000 }, { periodStart: "2026-10-16", amount: 60000 }] });
    const { payrollId } = await pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01" });
    await pay.releaseSalary({ ...w.c, payrollId, release: { method: "cash" } });
    const r = await Promise.allSettled([
      pay.voidPayroll({ ...w.c, payrollId, reason: "Wrong helper" }),
      pay.voidPayroll({ ...w.c, payrollId, reason: "Wrong helper" }),
      pay.recordAdvanceRepayment({ ...w.c, advanceId, repayment: { amount: 30000, method: "cash" } }),
      pay.setAdvanceSchedule({ ...w.c, advanceId, schedule: [{ periodStart: "2026-10-16", amount: 30000 }] }),
    ]);
    expectExplicit(r, ["over-owed", "payroll-released"]);
    const a = (await w.tenant.doc("advances", advanceId).get()).data();
    expect((await w.tenant.doc("payrolls", payrollId).get()).exists).toBe(false);
    expect((await w.tenant.collection("voidedPayrolls").where("originalId", "==", payrollId).get()).size).toBe(1);
    // The 400 the voided salary took is owed again: nothing is deducted any more.
    expect(a.deductedAmount).toBe(0);
    const owed = a.amount - a.deductedAmount - (a.repaidAmount || 0);
    expect(owed).toBeGreaterThanOrEqual(0);
    const open = (a.schedule || []).filter((e) => e.state === "planned" || e.state === "not_taken").reduce((t, e) => t + e.amount, 0);
    expect(open).toBeLessThanOrEqual(owed);
    expect((a.schedule || []).some((e) => e.state === "applied")).toBe(false);
  });
});

// Owner-pilot refinement: a salary overpayment is taken once, whatever races.
describe("salary overpayment racing the next payment", () => {
  it("paying the next payroll while the overpayment is waived / moved / repaid: never taken twice, never below zero", async () => {
    const w = await world();
    const early = { ...w.c, now: new Date("2026-10-12T04:00:00Z") };
    for (const d of daysIn({ start: "2026-10-01", end: "2026-10-12" })) await pay.setAttendance({ ...early, input: { staffId: w.staffId, date: d, status: "present" } });
    const { payrollId } = await pay.preparePayroll({ ...early, staffId: w.staffId, periodStart: "2026-10-01" });
    await pay.releaseSalary({ ...early, payrollId, release: { method: "cash", prepaidDays: 3 } });
    const later = { ...w.c, now: new Date("2026-11-01T04:00:00Z") };
    for (const [d, s] of [["2026-10-13", "present"], ["2026-10-14", "present"], ["2026-10-15", "absent"]]) await pay.setAttendance({ ...later, input: { staffId: w.staffId, date: d, status: s } });
    for (const d of daysIn({ start: "2026-10-16", end: "2026-10-25" })) await pay.setAttendance({ ...later, input: { staffId: w.staffId, date: d, status: "present" } });
    const next = await pay.preparePayroll({ ...later, staffId: w.staffId, periodStart: "2026-10-16" });
    const r = await Promise.allSettled([
      pay.releaseSalary({ ...later, payrollId: next.payrollId, release: { method: "cash" } }),
      pay.changeOverpayment({ ...later, payrollId, change: { op: "waive", reason: "goodwill" } }),
      pay.changeOverpayment({ ...later, payrollId, change: { op: "repay", amount: 10000, method: "cash" } }),
      pay.changeOverpayment({ ...later, payrollId, change: { op: "move", periodStart: "2026-11-01" } }),
    ]);
    expectExplicit(r, ["nothing-owed", "over-owed", "payroll-released"]);
    const src = (await w.tenant.doc("payrolls", payrollId).get()).data();
    const sum = (l) => (l || []).reduce((t, x) => t + x.amount, 0);
    const settledBy = sum(src.overpayment?.applied) + sum(src.overpayment?.repayments) + sum(src.overpayment?.waivers);
    expect(settledBy).toBeLessThanOrEqual(60000); // ₱600 a day: one day not earned
    const taken = (await w.tenant.doc("payrolls", next.payrollId).get()).data().deductions.filter((d) => d.type === "overpayment").reduce((t, d) => t + d.amount, 0);
    expect(sum(src.overpayment?.applied)).toBe(taken);
    expect(src.salary.amount).toBe(15 * 60000); // the early payment is never rewritten
  });
});
