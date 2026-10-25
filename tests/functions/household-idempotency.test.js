// Household duplicate-request protection (2026-10-25): Give advance, Record
// advance, Record repayment, Add bonus and Add deduction each carry one
// request key per dialog. A double tap, a repeated request, a network retry
// (the first answer lost) and concurrent copies all record ONCE and get the
// first result back; the same key with a different request is refused
// (409); a request without a key is refused (400). Payroll itself is unchanged.
import { describe, it, expect, beforeEach } from "vitest";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createAttendanceHandler } from "../../netlify/functions/attendance.js";
import { createPayrollHandler } from "../../netlify/functions/payroll.js";
import { createAdvancesHandler } from "../../netlify/functions/advances.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { advanceRemaining } from "../../shared/payroll.js";
import { buildWorld, request } from "../helpers/tenants.js";

const H = "biz-home";
let world;
let owner;
let clock;
const OCT = (d) => `2026-10-${String(d).padStart(2, "0")}`;

beforeEach(async () => {
  clock = new Date("2026-10-13T04:00:00Z");
  world = await buildWorld();
  await createBusiness({ ...world, name: "Prado Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  const x = await ensureAuthUser({ auth: world.auth, email: "carlo@home.test", name: "Carlo" });
  await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: "Carlo", roleTemplate: "owner", isAccountOwner: true });
  owner = x.uid;
});

const deps = () => ({ getAdmin: async () => world, now: () => clock });
const HANDLERS = { staff: createHouseholdStaffHandler, attendance: createAttendanceHandler, payroll: createPayrollHandler, advances: createAdvancesHandler };
async function api(kind, body) {
  const res = await HANDLERS[kind](deps())({ ...request({ uid: owner, businessId: H, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const under = (c) => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/${c}/`) && k.split("/").length === 4).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
let n = 0;
const key = () => `hh-test-key-${String(++n).padStart(6, "0")}`;

async function helper() {
  const staffId = (await api("staff", { action: "create", staff: { name: "Maria", dailyWage: 50000, payCycle: "semi_monthly", startDate: "2026-06-01", advanceLimit: 1000000 } })).body.staffId;
  await api("attendance", { action: "setMany", staffId, days: [1, 2, 3, 5, 6].map((d) => ({ date: OCT(d), status: "present" })) });
  return staffId;
}
const draft = async (staffId) => (await api("payroll", { action: "prepare", staffId, periodStart: OCT(1) })).body.payrollId;

// Each action: how to send it, and how to count what it recorded.
const CASES = {
  "Give advance": {
    setup: async () => ({ staffId: await helper() }),
    send: (s, k, amount = 50000) => api("advances", { action: "give", advance: { staffId: s.staffId, amount, date: OCT(10), method: "cash" }, idempotencyKey: k }),
    count: () => under("advances").length,
  },
  "Record advance": {
    setup: async () => ({ staffId: await helper() }),
    send: (s, k, amount = 50000) => api("advances", { action: "create", advance: { staffId: s.staffId, amount, date: OCT(10) }, idempotencyKey: k }),
    count: () => under("advances").length,
  },
  "Record advance repayment": {
    setup: async () => {
      const staffId = await helper();
      const advanceId = (await api("advances", { action: "give", advance: { staffId, amount: 100000, date: OCT(10), method: "cash" }, idempotencyKey: key() })).body.advanceId;
      return { staffId, advanceId };
    },
    send: (s, k, amount = 30000) => api("advances", { action: "repay", advanceId: s.advanceId, repayment: { amount, date: OCT(12), method: "cash" }, idempotencyKey: k }),
    count: (s) => (docAt(`advances/${s.advanceId}`).repayments || []).length,
    after: (s) => expect(advanceRemaining({ id: s.advanceId, ...docAt(`advances/${s.advanceId}`) })).toBe(70000),
  },
  "Add bonus": {
    setup: async () => {
      const staffId = await helper();
      return { staffId, payrollId: await draft(staffId) };
    },
    send: (s, k, amount = 20000) => api("payroll", { action: "addAddition", payrollId: s.payrollId, addition: { type: "bonus", amount }, idempotencyKey: k }),
    count: (s) => (docAt(`payrolls/${s.payrollId}`).additions || []).length,
  },
  "Add deduction": {
    setup: async () => {
      const staffId = await helper();
      return { staffId, payrollId: await draft(staffId) };
    },
    send: (s, k, amount = 15000) => api("payroll", { action: "addDeduction", payrollId: s.payrollId, deduction: { description: "Broken plate", amount }, idempotencyKey: k }),
    count: (s) => (docAt(`payrolls/${s.payrollId}`).deductions || []).filter((d) => d.type === "manual").length,
  },
};

describe.each(Object.entries(CASES))("%s", (name, c) => {
  it("double tap: two identical Saves record once; the second gets the first result back", async () => {
    const s = await c.setup();
    const before = c.count(s);
    const k = key();
    const [a, b] = [await c.send(s, k), await c.send(s, k)];
    expect(a.status, JSON.stringify(a.body)).toBeLessThan(300);
    expect(b.status, JSON.stringify(b.body)).toBe(a.status);
    expect(c.count(s)).toBe(before + 1);
    const { replayed, ...rest } = b.body;
    expect(replayed).toBe(true);
    expect(rest).toEqual(a.body);
    c.after?.(s);
  });

  it("repeated request / network retry (the first answer lost): still once", async () => {
    const s = await c.setup();
    const before = c.count(s);
    const k = key();
    await c.send(s, k); // the answer never reached the phone
    for (let i = 0; i < 3; i++) expect((await c.send(s, k)).body.replayed).toBe(true);
    expect(c.count(s)).toBe(before + 1);
    c.after?.(s);
  });

  it("concurrent submission: copies sent at once record once", async () => {
    const s = await c.setup();
    const before = c.count(s);
    const k = key();
    const out = await Promise.all(Array.from({ length: 5 }, () => c.send(s, k)));
    expect(out.every((r) => r.status < 300), JSON.stringify(out.map((r) => r.body))).toBe(true);
    expect(c.count(s)).toBe(before + 1);
    expect(out.filter((r) => r.body.replayed !== true)).toHaveLength(1);
  });

  it("the same key twice with a different request is refused; a new key records again", async () => {
    const s = await c.setup();
    const before = c.count(s);
    const k = key();
    await c.send(s, k);
    const other = await c.send(s, k, 10000);
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("idempotency-conflict");
    expect(c.count(s)).toBe(before + 1);
    expect((await c.send(s, key(), 10000)).status).toBeLessThan(300);
    expect(c.count(s)).toBe(before + 2);
  });

  it("no key (or a malformed one): refused before anything is recorded", async () => {
    const s = await c.setup();
    const before = c.count(s);
    for (const k of [undefined, "short", "bad key with spaces!!"]) {
      const r = await c.send(s, k);
      expect(r.status).toBe(400);
    }
    expect(c.count(s)).toBe(before);
  });
});

describe("a failed Save keeps nothing", () => {
  it("over the advance limit: refused, no key kept, so the corrected request (same dialog, same key) goes through", async () => {
    const staffId = await helper();
    const k = key();
    const over = await api("advances", { action: "give", advance: { staffId, amount: 2000000, date: OCT(10), method: "cash" }, idempotencyKey: k });
    expect(over.status).toBe(409);
    expect(under("advances")).toHaveLength(0);
    const ok = await api("advances", { action: "give", advance: { staffId, amount: 50000, date: OCT(10), method: "cash" }, idempotencyKey: k });
    expect(ok.status).toBe(201);
    expect(ok.body.replayed).toBeUndefined();
    expect(under("advances")).toHaveLength(1);
  });
});
