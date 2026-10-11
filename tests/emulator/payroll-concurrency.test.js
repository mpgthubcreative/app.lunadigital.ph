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
  it("marking advances paid while the payroll is being prepared: each lands in exactly one payroll", async () => {
    const w = await world();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await pay.createAdvance({ ...w.c, input: { staffId: w.staffId, date: "2026-10-02", amount: 10000 + i } })).advanceId);
    const r = await Promise.allSettled([...ids.map((advanceId) => pay.markAdvancePaid({ ...w.c, advanceId, release: {} })), pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01" })]);
    expectExplicit(r, ["advance-paid"]);
    const p = await consistent(w, `${w.staffId}_2026-10-01`);
    const inDraft = p.deductions.map((d) => d.advanceId);
    expect(new Set(inDraft).size).toBe(inDraft.length);
    // any advance not in this draft is waiting for the next payroll, linked nowhere
    // Whichever committed first, every advance paid during the race lands in
    // THIS draft (the per-person lock makes the later transaction see it).
    expect([...inDraft].sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await w.tenant.doc("advances", id).get()).data().deductionPayrollId, id).toBe(`${w.staffId}_2026-10-01`);
    // the next payroll picks up the rest, and nothing twice
    const next = await pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-16", now: new Date("2026-11-01T04:00:00Z") });
    const p2 = (await w.tenant.doc("payrolls", next.payrollId).get()).data();
    const all = [...inDraft, ...p2.deductions.map((d) => d.advanceId)];
    expect(new Set(all).size).toBe(all.length);
    const paid = [];
    for (const id of ids) if ((await w.tenant.doc("advances", id).get()).data().status === "paid") paid.push(id);
    expect(all.sort()).toEqual(paid.sort());
  });

  it("two DIFFERENT periods prepared at once never both deduct the same paid advance", async () => {
    for (let round = 0; round < 3; round++) {
      const w = await world();
      const { advanceId } = await pay.createAdvance({ ...w.c, input: { staffId: w.staffId, date: "2026-09-02", amount: 30000 } });
      await pay.markAdvancePaid({ ...w.c, advanceId, release: {} });
      const later = new Date("2026-11-01T04:00:00Z");
      const r = await Promise.allSettled([
        pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-01", now: later }),
        pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-10-16", now: later }),
        pay.preparePayroll({ ...w.c, staffId: w.staffId, periodStart: "2026-09-16", now: later }),
      ]);
      expectExplicit(r);
      const drafts = (await w.tenant.collection("payrolls").get()).docs.map((d) => d.data());
      const count = drafts.flatMap((p) => p.deductions).filter((d) => d.advanceId === advanceId).length;
      expect(count, `round ${round}`).toBe(1);
      const linked = drafts.find((p) => p.deductions.some((d) => d.advanceId === advanceId));
      expect((await w.tenant.doc("advances", advanceId).get()).data().deductionPayrollId).toBe(`${w.staffId}_${linked.periodStart}`);
    }
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
