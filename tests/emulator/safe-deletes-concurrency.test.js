// Phase 18.5 safe deletes on the REAL Firestore emulator (Admin SDK): a
// delete racing the first use of the same record never leaves an orphan.
// Either the use wins (the delete is refused: ...-in-use, or contended)
// or the delete wins (the use fails: not-found / invalid). Totals stay
// equal to a recount.

import { beforeAll, describe, it, expect, vi } from "vitest";
import { taskTotalsDelta } from "../../shared/wedding.js";

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-luna";
vi.setConfig({ testTimeout: 180000 });

const NOW = new Date("2026-10-16T04:00:00Z");
let db, admin, FieldValue, wed, babyLib, exp, pay, prov, tenantDb;
let run = 0;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run through `npm run test:rules` (needs the emulators).");
  const fa = await import("../../netlify/functions/_lib/firebase-admin.js");
  ({ db, admin } = await fa.getAdmin());
  FieldValue = admin.firestore.FieldValue;
  wed = await import("../../netlify/functions/_lib/wedding.js");
  babyLib = await import("../../netlify/functions/_lib/baby.js");
  exp = await import("../../netlify/functions/_lib/expenses.js");
  pay = await import("../../netlify/functions/_lib/payroll.js");
  prov = await import("../../netlify/functions/_lib/provisioning.js");
  ({ tenantDb } = await import("../../netlify/functions/_lib/tenant-db.js"));
  await prov.seedPlans({ db, admin, overwrite: true });
});

async function world(workspace) {
  run += 1;
  const id = `del-${Date.now().toString(36)}-${run}`;
  await prov.createBusiness({ db, admin, name: `Delete ${run}`, planId: "growth", workspaceTemplateId: workspace, businessId: id });
  const tenant = tenantDb(db, id);
  const business = { id, timezone: "Asia/Manila" };
  const c = { db, tenant, FieldValue, business, workspace, actor: { uid: `owner-${id}`, name: "Owner", email: "" }, now: NOW };
  return { c, tenant };
}
const all = async (tenant, col) => (await tenant.collection(col).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const exists = async (tenant, col, id) => (await tenant.doc(col, id).get()).exists;

describe("wedding supplier: delete vs scheduling its first payment", () => {
  it("never a payment for a deleted supplier; contracted = the remaining agreements", async () => {
    for (let i = 0; i < 4; i++) {
      const w = await world("bridal-expense");
      await babyLib.setBudgetTotal({ ...w.c, total: 50000000 });
      const cat = (await babyLib.createCategory({ ...w.c, input: { name: "Photo / Video" } })).categoryId;
      const supplierId = (await wed.createSupplier({ ...w.c, input: { name: "ABC Photo", service: "photo_video", agreedAmount: 8000000 } })).supplierId;
      await Promise.allSettled([
        wed.deleteSupplier({ ...w.c, supplierId }),
        wed.createSupplierPayment({ ...w.c, input: { supplierId, description: "Deposit", category: cat, amount: 1000000, dueDate: "2026-12-01" } }),
      ]);
      const payments = await all(w.tenant, "supplierPayments");
      const alive = await exists(w.tenant, "weddingSuppliers", supplierId);
      if (!alive) expect(payments.filter((p) => p.supplierId === supplierId)).toHaveLength(0);
      const suppliers = await all(w.tenant, "weddingSuppliers");
      const contracted = suppliers.reduce((s, x) => s + (Number.isSafeInteger(x.agreedAmount) ? x.agreedAmount : 0), 0);
      expect((await w.tenant.doc("budgets", "current").get()).data().contracted ?? 0).toBe(contracted);
    }
  });
});

describe("wedding task: delete vs status change", () => {
  it("task totals always equal a recount of the remaining tasks", async () => {
    const w = await world("bridal-expense");
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await wed.createTask({ ...w.c, input: { title: `Task ${i}` } })).taskId);
    await Promise.allSettled(ids.flatMap((taskId, i) => [wed.deleteTask({ ...w.c, taskId }), wed.setTaskStatus({ ...w.c, taskId, status: i % 2 ? "completed" : "in_progress" })]));
    const tasks = await all(w.tenant, "weddingTasks");
    const want = { total: 0, open: 0, completed: 0, cancelled: 0 };
    for (const t of tasks) for (const [k, v] of Object.entries(taskTotalsDelta(null, t))) want[k] += v;
    const got = (await w.tenant.doc("taskTotals", "current").get()).data();
    for (const k of Object.keys(want)) expect(got[k] ?? 0, k).toBe(want[k]);
  });
});

describe("baby provider: delete vs its first expense", () => {
  it("never an expense pointing at a deleted provider", async () => {
    for (let i = 0; i < 4; i++) {
      const w = await world("baby-expense");
      const cat = (await babyLib.createCategory({ ...w.c, input: { name: "Medical" } })).categoryId;
      const providerId = (await babyLib.createProvider({ ...w.c, input: { name: "ABC Clinic", type: "medical" } })).providerId;
      await Promise.allSettled([
        babyLib.deleteProvider({ ...w.c, providerId }),
        exp.createExpense({ ...w.c, input: { date: "2026-10-10", method: "cash", category: cat, amount: 100000, providerId } }),
      ]);
      const alive = await exists(w.tenant, "providers", providerId);
      const linked = (await all(w.tenant, "expenses")).filter((e) => e.providerId === providerId);
      if (!alive) expect(linked).toHaveLength(0);
      else expect(linked).toHaveLength(1);
    }
  });
});

describe("household staff: delete vs the first attendance mark", () => {
  it("never attendance for a deleted person", async () => {
    for (let i = 0; i < 4; i++) {
      const w = await world("household-payroll");
      const { staffId } = await pay.createStaff({ ...w.c, input: { name: "Rosa", dailyWage: 50000, payCycle: "semi_monthly" } });
      await Promise.allSettled([pay.deleteStaff({ ...w.c, staffId }), pay.setAttendance({ ...w.c, input: { staffId, date: "2026-10-15", status: "present" } })]);
      const alive = await exists(w.tenant, "householdStaff", staffId);
      const lines = (await all(w.tenant, "attendance")).filter((a) => a.staffId === staffId);
      if (!alive) expect(lines).toHaveLength(0);
      else expect(lines).toHaveLength(1);
    }
  });
});
