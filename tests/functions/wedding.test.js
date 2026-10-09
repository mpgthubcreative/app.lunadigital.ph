// Phase 16: Bridal / Wedding Command Center on the server: Wedding Budget
// (the shared budget primitive), Wedding Expenses (Expenses Core + wedding
// sink), Suppliers (agreed / paid / balance), Supplier Payments (Upcoming ->
// exactly one expense), Tasks, Guests & RSVP, exports, notifications and
// workspace / tenant isolation.

import { describe, it, expect, beforeEach } from "vitest";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createWeddingSuppliersHandler } from "../../netlify/functions/wedding-suppliers.js";
import { createSupplierPaymentsHandler } from "../../netlify/functions/supplier-payments.js";
import { createWeddingTasksHandler } from "../../netlify/functions/wedding-tasks.js";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createExportsHandler } from "../../netlify/functions/exports.js";
import { createProvidersHandler } from "../../netlify/functions/providers.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { notificationId } from "../../shared/notifications.js";
import { weddingSummary, rsvpSummary, supplierBalance, SUGGESTED_WEDDING_CATEGORIES } from "../../shared/wedding.js";
import { readXlsx } from "../../shared/xlsx.js";

const NOW = new Date("2026-10-16T04:00:00Z"); // Oct 16, 12:00 Manila
const W = "biz-wed";
const W2 = "biz-wed-2";
const P = "₱";
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "growth", workspaceTemplateId: "bridal-expense", businessId: W });
  await createBusiness({ ...world, name: "Cruz Wedding", planId: "starter", workspaceTemplateId: "bridal-expense", businessId: W2 });
  await createBusiness({ ...world, name: "Baby", planId: "growth", workspaceTemplateId: "baby-expense", businessId: "biz-baby" });
  await createBusiness({ ...world, name: "Home", planId: "growth", workspaceTemplateId: "household-payroll", businessId: "biz-home" });
  u = {};
  const add = async (key, businessId, role, extra = {}) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@wed.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner", ...extra });
    u[key] = x.uid;
  };
  await add("camille", W, "owner");
  await add("mon", W, "manager");
  await add("helper", W, "staff");
  await add("nopay", W, "manager", { permissionOverrides: { revoke: ["expenses.create"] } });
  await add("other", W2, "owner");
  await add("babyowner", "biz-baby", "owner");
  await add("home", "biz-home", "owner");
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const H = { budget: createBudgetHandler, expenses: createExpensesHandler, suppliers: createWeddingSuppliersHandler, payments: createSupplierPaymentsHandler, tasks: createWeddingTasksHandler, guests: createGuestsHandler, providers: createProvidersHandler };
async function api(kind, uid, body, businessId = W) {
  const res = await H[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const docAt = (p, businessId = W) => world.db.docs.get(`businesses/${businessId}/${p}`);
const budget = () => docAt("budgets/current");
const summary = () => weddingSummary(budget());
const paths = (prefix) => [...world.db.docs.keys()].filter((k) => k.startsWith(prefix));
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

async function setup() {
  ok(await api("budget", u.camille, { action: "setTotal", total: 50000000 }));
  const cats = ok(await api("budget", u.camille, { action: "setupCategories" }));
  const byName = Object.fromEntries(cats.categoryIds.map((id) => [docAt(`expenseCategories/${id}`).name, id]));
  return byName;
}
async function photographer(cats, agreed = 8000000) {
  return ok(await api("suppliers", u.camille, { action: "create", supplier: { name: "ABC Photo Studio", service: "photo_video", contactPerson: "Ana", agreedAmount: agreed, categoryId: cats["Photo / Video"] } }), 201).supplierId;
}
const schedule = async (supplierId, category, amount, dueDate, description = "Downpayment") => ok(await api("payments", u.camille, { action: "create", payment: { supplierId, category, amount, dueDate, description } }), 201).paymentId;
const markPaid = (paymentId, uid = u.camille, payment = { method: "bank_transfer" }) => api("payments", uid, { action: "markPaid", paymentId, payment });
const expensesFor = (paymentId) => paths(`businesses/${W}/expenses/`).map((k) => world.db.docs.get(k)).filter((e) => e.supplierPaymentId === paymentId);

describe("Wedding Budget: the shared budget primitive with wedding categories", () => {
  it("suggested wedding categories (16), once; Spent / Remaining computed", async () => {
    const cats = await setup();
    expect(Object.keys(cats)).toEqual([...SUGGESTED_WEDDING_CATEGORIES]);
    expect(ok(await api("budget", u.camille, { action: "setupCategories" })).created).toBe(0);
    ok(await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats.Venue, amount: 1500000 } }), 201);
    expect(summary()).toMatchObject({ total: 50000000, spent: 1500000, remaining: 48500000 });
  });
});

describe("THE live wedding scenario: ₱500,000 budget, ABC Photo Studio agreed ₱80,000", () => {
  it("₱20,000 paid + ₱30,000 upcoming -> paid ₱20,000, balance ₱60,000, upcoming ₱30,000; pay #2 -> ₱50,000 / ₱30,000; retries make one expense", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const p1 = await schedule(s, cats["Photo / Video"], 2000000, "2026-10-15", "Reservation fee");
    const p2 = await schedule(s, cats["Photo / Video"], 3000000, "2026-12-01", "Second payment");
    expect(docAt(`weddingSuppliers/${s}`)).toMatchObject({ paid: 0, upcoming: 5000000, upcomingCount: 2, nextDue: "2026-10-15" });
    expect(summary()).toMatchObject({ spent: 0, upcoming: 5000000, supplierBalance: 8000000 });

    ok(await markPaid(p1));
    let sup = docAt(`weddingSuppliers/${s}`);
    expect(sup).toMatchObject({ paid: 2000000, upcoming: 3000000, upcomingCount: 1, nextDue: "2026-12-01" });
    expect(supplierBalance(sup)).toBe(6000000);
    expect(summary()).toMatchObject({ spent: 2000000, remaining: 48000000, upcoming: 3000000, supplierBalance: 6000000 });

    const spentBefore = summary().spent;
    const r = ok(await markPaid(p2));
    sup = docAt(`weddingSuppliers/${s}`);
    expect(sup).toMatchObject({ paid: 5000000, upcoming: 0, upcomingCount: 0, nextDue: null });
    expect(supplierBalance(sup)).toBe(3000000);
    expect(summary().spent).toBe(spentBefore + 3000000);
    expect(expensesFor(p2)).toHaveLength(1);
    expect(docAt(`expenses/${r.expenseId}`)).toMatchObject({ supplierId: s, supplierPaymentId: p2, payee: "ABC Photo Studio", amount: 3000000, category: cats["Photo / Video"], status: "active" });
    expect(docAt(`supplierPayments/${p2}`)).toMatchObject({ status: "paid", expenseId: r.expenseId, paidAmount: 3000000 });

    const again = ok(await markPaid(p2, u.mon));
    expect(again).toMatchObject({ alreadyPaid: true, expenseId: r.expenseId });
    const [a, b] = await Promise.all([markPaid(p2), markPaid(p2, u.mon)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(expensesFor(p2)).toHaveLength(1);
    expect(summary().spent).toBe(spentBefore + 3000000);
  });

  it("two users marking the same Upcoming payment at once: one expense", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const p = await schedule(s, cats["Photo / Video"], 2000000, "2026-11-01");
    const [a, b] = await Promise.all([markPaid(p), markPaid(p, u.mon)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.expenseId).toBe(b.body.expenseId);
    expect(expensesFor(p)).toHaveLength(1);
    expect(docAt(`weddingSuppliers/${s}`).paid).toBe(2000000);
  });

  it("removing the generated expense returns the payment to Upcoming (no false Paid); paying again makes one new expense", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const p = await schedule(s, cats["Photo / Video"], 2000000, "2026-11-01");
    const { expenseId } = ok(await markPaid(p));
    ok(await api("expenses", u.camille, { action: "remove", expenseId, reason: "Paid from the wrong account" }));
    expect(docAt(`supplierPayments/${p}`)).toMatchObject({ status: "upcoming", expenseId: null, attempt: 1 });
    expect(docAt(`weddingSuppliers/${s}`)).toMatchObject({ paid: 0, upcoming: 2000000, upcomingCount: 1, nextDue: "2026-11-01" });
    expect(summary()).toMatchObject({ spent: 0, upcoming: 2000000, supplierBalance: 8000000 });
    const again = ok(await markPaid(p));
    expect(again.expenseId).toBe(`${p}r1`);
    expect(expensesFor(p).filter((e) => e.status === "active")).toHaveLength(1);
  });

  it("editing the paid expense's amount follows on the payment and the supplier; its supplier can't change", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const s2 = ok(await api("suppliers", u.camille, { action: "create", supplier: { name: "Bloom Florist", service: "styling" } }), 201).supplierId;
    const p = await schedule(s, cats["Photo / Video"], 2000000, "2026-11-01");
    const { expenseId } = ok(await markPaid(p));
    ok(await api("expenses", u.camille, { action: "update", expenseId, changes: { amount: 2500000 } }));
    expect(docAt(`supplierPayments/${p}`).paidAmount).toBe(2500000);
    expect(docAt(`weddingSuppliers/${s}`).paid).toBe(2500000);
    expect((await api("expenses", u.camille, { action: "update", expenseId, changes: { supplierId: s2 } })).status).toBe(400);
  });
});

describe("agreed-amount policy: never paid or scheduled beyond the agreement", () => {
  it("scheduling beyond the agreed amount is refused; paying more than agreed is refused; raising the agreement allows it (audited)", async () => {
    const cats = await setup();
    const s = await photographer(cats, 8000000);
    await schedule(s, cats["Photo / Video"], 5000000, "2026-11-01");
    const r = await api("payments", u.camille, { action: "create", payment: { supplierId: s, category: cats["Photo / Video"], amount: 3000001, dueDate: "2026-12-01", description: "Balance" } });
    expect(r).toMatchObject({ status: 409, body: { error: "over-agreed" } });
    const direct = await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats["Photo / Video"], amount: 8000001, supplierId: s } });
    expect(direct).toMatchObject({ status: 409, body: { error: "over-agreed" } });
    expect((await api("suppliers", u.camille, { action: "update", supplierId: s, changes: { agreedAmount: 4000000 } })).body.error).toBe("below-committed");
    ok(await api("suppliers", u.mon, { action: "update", supplierId: s, changes: { agreedAmount: 9000000 } }));
    expect(docAt(`weddingSuppliers/${s}`).history.at(-1)).toMatchObject({ label: `Agreed amount changed ${P}80,000 → ${P}90,000`, actor: { uid: u.mon } });
    expect(summary().supplierBalance).toBe(9000000);
    ok(await api("payments", u.camille, { action: "create", payment: { supplierId: s, category: cats["Photo / Video"], amount: 3000000, dueDate: "2026-12-01", description: "Balance" } }), 201);
  });

  it("a direct Wedding Expense linked to a supplier counts as paid to it (one source of truth: the expenses)", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    ok(await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "gcash", category: cats["Photo / Video"], amount: 1000000, supplierId: s, payee: "ignored" } }), 201);
    expect(docAt(`weddingSuppliers/${s}`).paid).toBe(1000000);
    expect(summary()).toMatchObject({ contracted: 8000000, contractedPaid: 1000000, supplierBalance: 7000000 });
    expect(docAt("spendingMetrics/2026-10-10")).toMatchObject({ spent: 1000000, supplierPaid: 1000000 });
  });

  it("a supplier without an agreement: contact tracking only, no balance, no cap", async () => {
    const cats = await setup();
    const s = ok(await api("suppliers", u.camille, { action: "create", supplier: { name: "Tita Baby's Kakanin", service: "cake" } }), 201).supplierId;
    ok(await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats["Cake / Desserts"], amount: 99999900, supplierId: s } }), 201);
    expect(supplierBalance(docAt(`weddingSuppliers/${s}`))).toBeNull();
    expect(summary().supplierBalance).toBe(0);
  });

  it("renaming / deactivating a supplier keeps history; an inactive supplier can't get new payments but a scheduled one can still be paid", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const p = await schedule(s, cats["Photo / Video"], 2000000, "2026-11-01");
    const e1 = ok(await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats["Photo / Video"], amount: 100000, supplierId: s } }), 201).expenseId;
    ok(await api("suppliers", u.camille, { action: "update", supplierId: s, changes: { name: "ABC Photo & Films" } }));
    ok(await api("suppliers", u.camille, { action: "setStatus", supplierId: s, status: "inactive" }));
    expect(docAt(`expenses/${e1}`).payee).toBe("ABC Photo Studio");
    expect(docAt(`supplierPayments/${p}`).supplierName).toBe("ABC Photo Studio");
    expect((await api("payments", u.camille, { action: "create", payment: { supplierId: s, category: cats["Photo / Video"], amount: 1, dueDate: "2026-12-01", description: "x" } })).body.error).toBe("invalid-supplier");
    expect((await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats["Photo / Video"], amount: 1, supplierId: s } })).body.error).toBe("invalid-supplier");
    ok(await markPaid(p));
  });
});

describe("Supplier Payments: cancel, edit, due dates, permissions", () => {
  it("cancel leaves Upcoming without spending; next due moves to the next payment", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const p1 = await schedule(s, cats["Photo / Video"], 1000000, "2026-11-01");
    await schedule(s, cats["Photo / Video"], 1000000, "2026-12-01");
    ok(await api("payments", u.camille, { action: "cancel", paymentId: p1, reason: "Merged into one payment" }));
    expect(docAt(`weddingSuppliers/${s}`)).toMatchObject({ upcoming: 1000000, upcomingCount: 1, nextDue: "2026-12-01" });
    expect(summary()).toMatchObject({ spent: 0, upcoming: 1000000 });
    expect((await markPaid(p1)).body.error).toBe("not-upcoming");
  });

  it("editing the amount / due date moves Upcoming and next due", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const p = await schedule(s, cats["Photo / Video"], 1000000, "2026-12-01");
    ok(await api("payments", u.camille, { action: "update", paymentId: p, changes: { amount: 1500000, dueDate: "2026-11-05" } }));
    expect(docAt(`weddingSuppliers/${s}`)).toMatchObject({ upcoming: 1500000, nextDue: "2026-11-05" });
    expect(budget().upcomingByCategory[cats["Photo / Video"]]).toBe(1500000);
    expect((await api("payments", u.camille, { action: "update", paymentId: p, changes: { supplierId: s } })).status).toBe(400);
  });

  it("Mark paid needs expenses.create; future paid date refused; Staff can't", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const p = await schedule(s, cats["Photo / Video"], 1000000, "2026-11-01");
    expect((await markPaid(p, u.nopay)).status).toBe(403);
    expect((await markPaid(p, u.helper)).status).toBe(403);
    expect((await markPaid(p, u.camille, { method: "cash", paidDate: "2026-10-17" })).status).toBe(400);
    expect(docAt(`supplierPayments/${p}`).status).toBe("upcoming");
  });

  it("Mark paid notifies the OTHER members who follow supplier payments", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    const p = await schedule(s, cats["Photo / Video"], 1000000, "2026-11-01");
    const { expenseId } = ok(await markPaid(p));
    const id = notificationId("supplierpayment.paid", expenseId);
    expect(docAt(`members/${u.mon}/inbox/${id}`)).toMatchObject({ title: "ABC Photo Studio paid" });
    expect(docAt(`members/${u.camille}/inbox/${id}`)).toBeUndefined();
    expect(docAt(`members/${u.helper}/inbox/${id}`)).toBeUndefined();
  });
});

describe("Wedding Tasks", () => {
  it("THE task: Not Started -> In Progress -> Completed: completed date, history, Open Tasks", async () => {
    const t = ok(await api("tasks", u.camille, { action: "create", task: { title: "Submit church requirements", category: "Ceremony / Church", assignee: "Camille", dueDate: "2026-11-20", priority: "high" } }), 201).taskId;
    expect(docAt("taskTotals/current")).toMatchObject({ total: 1, open: 1 });
    ok(await api("tasks", u.mon, { action: "setStatus", taskId: t, status: "in_progress" }));
    ok(await api("tasks", u.camille, { action: "setStatus", taskId: t, status: "completed" }));
    expect(docAt(`weddingTasks/${t}`)).toMatchObject({ status: "completed", open: false, completedDate: "2026-10-16", completedBy: { uid: u.camille } });
    expect(docAt(`weddingTasks/${t}`).history.map((h) => h.label)).toEqual(["Added task · due 2026-11-20", "Status changed Not Started → In Progress", "Status changed In Progress → Completed"]);
    expect(docAt("taskTotals/current")).toMatchObject({ total: 1, open: 0, completed: 1 });
    ok(await api("tasks", u.camille, { action: "setStatus", taskId: t, status: "in_progress" }));
    expect(docAt(`weddingTasks/${t}`)).toMatchObject({ completedDate: null, open: true });
    expect(docAt(`weddingTasks/${t}`).history.at(-1).label).toBe("Status changed Completed → In Progress (reopened)");
    expect(docAt("taskTotals/current")).toMatchObject({ open: 1, completed: 0 });
  });

  // (The true race is on the real emulator: tests/emulator/wedding-concurrency.test.js.)
  it("a second member completing an already-completed task changes nothing: counted once", async () => {
    const t = ok(await api("tasks", u.camille, { action: "create", task: { title: "Book the venue" } }), 201).taskId;
    ok(await api("tasks", u.camille, { action: "setStatus", taskId: t, status: "completed" }));
    expect(ok(await api("tasks", u.mon, { action: "setStatus", taskId: t, status: "completed" }))).toMatchObject({ unchanged: true });
    expect(docAt("taskTotals/current")).toMatchObject({ total: 1, open: 0, completed: 1 });
  });

  it("overdue is never stored; Staff can't manage tasks; a bad priority is refused", async () => {
    const t = ok(await api("tasks", u.camille, { action: "create", task: { title: "Order invitations", dueDate: "2026-10-01" } }), 201).taskId;
    expect(Object.keys(docAt(`weddingTasks/${t}`))).not.toContain("overdue");
    expect((await api("tasks", u.helper, { action: "create", task: { title: "x" } })).status).toBe(403);
    expect((await api("tasks", u.camille, { action: "create", task: { title: "x", priority: "urgent!" } })).status).toBe(400);
  });
});

describe("Guests & RSVP", () => {
  it("THE RSVP: Prado Family party of 4 -> Attending 3 -> 4 -> Declined: totals count people, not records", async () => {
    const g = ok(await api("guests", u.camille, { action: "create", guest: { name: "Prado Family", group: "Groom's relatives", side: "groom", partySize: 4, invitationSent: "2026-10-01" } }), 201).guestId;
    expect(rsvpSummary(docAt("guestTotals/current"))).toMatchObject({ invitations: 1, invitedSeats: 4, awaiting: 1, awaitingSeats: 4, attendingSeats: 0, invitationsSent: 1 });
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 3 } }));
    expect(rsvpSummary(docAt("guestTotals/current"))).toMatchObject({ attending: 1, attendingSeats: 3, awaiting: 0 });
    expect(docAt(`guests/${g}`).history.at(-1).label).toBe("RSVP changed Awaiting RSVP → Attending · 3 confirmed");
    ok(await api("guests", u.mon, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 4 } }));
    expect(rsvpSummary(docAt("guestTotals/current")).attendingSeats).toBe(4);
    expect(docAt(`guests/${g}`).history.at(-1).label).toBe("Confirmed guests 3 → 4");
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "declined" } }));
    expect(docAt(`guests/${g}`)).toMatchObject({ rsvp: "declined", confirmed: 0, rsvpDate: "2026-10-16" });
    expect(rsvpSummary(docAt("guestTotals/current"))).toMatchObject({ attending: 0, attendingSeats: 0, declined: 1, declinedSeats: 4 });
  });

  it("validation: confirmed ≤ party size; attending needs ≥1; declined with confirmed > 0 refused; party size can't drop below confirmed", async () => {
    const g = ok(await api("guests", u.camille, { action: "create", guest: { name: "Santos", side: "bride", partySize: 2 } }), 201).guestId;
    for (const rsvp of [{ status: "attending", confirmed: 3 }, { status: "attending", confirmed: 0 }, { status: "declined", confirmed: 1 }, { status: "maybe" }]) expect((await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp })).status, JSON.stringify(rsvp)).toBe(400);
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 2 } }));
    expect((await api("guests", u.camille, { action: "update", guestId: g, changes: { partySize: 1 } })).status).toBe(400);
  });

  // (True concurrency is proven on the real emulator: tests/emulator/wedding-concurrency.test.js.)
  it("interleaved RSVP edits by two members keep the totals equal to the guests; removing a guest takes its contribution out", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(ok(await api("guests", u.camille, { action: "create", guest: { name: `Guest ${i}`, side: "both", partySize: 3 } }), 201).guestId);
    for (const [i, g] of ids.entries()) {
      ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 1 + (i % 3) } }));
      ok(await api("guests", u.mon, { action: "setRsvp", guestId: g, rsvp: i % 2 ? { status: "declined" } : { status: "attending", confirmed: 2 } }));
    }
    const guests = ids.map((g) => docAt(`guests/${g}`));
    const t = rsvpSummary(docAt("guestTotals/current"));
    expect(t.attendingSeats).toBe(guests.filter((g) => g.rsvp === "attending").reduce((s, g) => s + g.confirmed, 0));
    expect(t.attending + t.declined + t.awaiting).toBe(5);
    ok(await api("guests", u.camille, { action: "remove", guestId: ids[0] }));
    expect(rsvpSummary(docAt("guestTotals/current")).invitations).toBe(4);
    expect(paths(`businesses/${W}/auditLog/`).map((k) => world.db.docs.get(k)).some((a) => a.type === "guest.removed" && a.name === "Guest 0")).toBe(true);
  });
});

describe("Wedding Expenses never touch other domains", () => {
  it("no Distributor sinks, no Baby documents in other businesses; Distributor categories refused", async () => {
    const cats = await setup();
    ok(await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats.Venue, amount: 500000 } }), 201);
    for (const col of ["financialMetrics", "metrics", "reportRollups"]) expect(paths(`businesses/${W}/${col}/`), col).toEqual([]);
    expect(paths("businesses/biz-baby/budgets/")).toEqual([]);
    expect((await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: "rent", amount: 1 } })).status).toBe(400);
    expect((await api("expenses", u.camille, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats.Venue, amount: 1, providerId: "abcdefgh12" } })).status).toBe(400);
  });
});

describe("access: workspace, permissions, tenants", () => {
  it("Distributor, Household and Baby can't reach any Wedding endpoint, even as owner; Bridal can't use Baby providers", async () => {
    for (const [uid, biz] of [[world.uids.ownera, "biz-a"], [u.home, "biz-home"], [u.babyowner, "biz-baby"]]) {
      expect((await api("suppliers", uid, { action: "create", supplier: { name: "X", service: "other" } }, biz)).status, biz).toBe(403);
      expect((await api("payments", uid, { action: "create", payment: {} }, biz)).status, biz).toBe(403);
      expect((await api("tasks", uid, { action: "create", task: { title: "x" } }, biz)).status, biz).toBe(403);
      expect((await api("guests", uid, { action: "create", guest: { name: "x", side: "both", partySize: 1 } }, biz)).status, biz).toBe(403);
    }
    expect((await api("providers", u.camille, { action: "create", provider: { name: "X", type: "other" } })).status).toBe(403);
  });

  it("Bridal A can't touch Bridal B; ids don't cross", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    expect((await api("tasks", u.camille, { action: "create", task: { title: "x" } }, W2)).status).toBe(403);
    expect((await api("expenses", u.other, { action: "create", expense: { date: "2026-10-10", method: "cash", category: cats.Venue, amount: 1, supplierId: s } }, W2)).body.error).toBe("invalid-category");
    expect(paths(`businesses/${W2}/expenses/`)).toEqual([]);
  });

  it("Staff (no Wedding permissions) can't manage suppliers, guests or the budget", async () => {
    expect((await api("suppliers", u.helper, { action: "create", supplier: { name: "X", service: "other" } })).status).toBe(403);
    expect((await api("guests", u.helper, { action: "create", guest: { name: "x", side: "both", partySize: 1 } })).status).toBe(403);
    expect((await api("budget", u.helper, { action: "setTotal", total: 1 })).status).toBe(403);
  });
});

describe("Excel downloads (Export Core)", () => {
  async function download(uid, dataset, filters = {}, businessId = W) {
    const res = await createExportsHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify({ dataset, filters }) });
    return res.statusCode === 200 ? { status: 200, bytes: new Uint8Array(Buffer.from(res.body, "base64")) } : { status: res.statusCode, body: JSON.parse(res.body) };
  }
  const rows = (bytes, name) => {
    const r = readXlsx(bytes, { sheet: name, maxRows: 20000 }).rows;
    return r.slice(1).map((x) => Object.fromEntries(r[0].map((h, i) => [h, x[i]])));
  };

  it("suppliers (service filter), supplier payments (status + due range), tasks (overdue), guests (Attending) = full filtered queries", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    ok(await api("suppliers", u.camille, { action: "create", supplier: { name: "Bloom Florist", service: "styling", agreedAmount: 3000000 } }), 201);
    const p1 = await schedule(s, cats["Photo / Video"], 2000000, "2026-10-15");
    await schedule(s, cats["Photo / Video"], 3000000, "2026-12-01");
    ok(await markPaid(p1));
    for (let i = 0; i < 30; i++) ok(await api("tasks", u.camille, { action: "create", task: { title: `Overdue ${i}`, dueDate: "2026-10-0" + ((i % 9) + 1) } }), 201);
    ok(await api("tasks", u.camille, { action: "create", task: { title: "Future", dueDate: "2026-12-01" } }), 201);
    const g = ok(await api("guests", u.camille, { action: "create", guest: { name: "=HYPERLINK(\"x\")", side: "bride", partySize: 4 } }), 201).guestId;
    ok(await api("guests", u.camille, { action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 3 } }));
    ok(await api("guests", u.camille, { action: "create", guest: { name: "Awaiting Family", side: "groom", partySize: 2 } }), 201);

    const sx = rows((await download(u.camille, "weddingSuppliers", { service: "photo_video" })).bytes, "Wedding Suppliers");
    expect(sx.map((r) => [r.Supplier, r.Agreed, r.Paid, r.Balance])).toEqual([["ABC Photo Studio", "80000", "20000", "60000"]]);
    const px = rows((await download(u.camille, "supplierPayments", { status: "upcoming", from: "2026-11-01", to: "2026-12-31" })).bytes, "Supplier Payments");
    expect(px.map((r) => [r.Description, r.Amount])).toEqual([["Downpayment", "30000"]]);
    const tx = rows((await download(u.camille, "weddingTasks", { state: "overdue" })).bytes, "Wedding Tasks");
    expect(tx).toHaveLength(30);
    expect(tx.every((r) => r.Timing === "Overdue")).toBe(true);
    const gx = rows((await download(u.camille, "guests", { rsvp: "attending" })).bytes, "Guests & RSVP");
    expect(gx).toHaveLength(1);
    expect(gx[0]).toMatchObject({ "Party size": "4", "Confirmed guests": "3", RSVP: "Attending" });
    expect(gx[0].Guest.startsWith("'=")).toBe(true);
    const ex = rows((await download(u.camille, "weddingExpenses", { supplierId: s })).bytes, "Wedding Expenses");
    expect(ex.map((r) => r["Supplier / payee"])).toEqual(["ABC Photo Studio"]);
    const bx = rows((await download(u.camille, "weddingBudget")).bytes, "Category Budget");
    expect(bx.find((r) => r.Category === "Photo / Video")).toMatchObject({ Spent: "20000" });
  });

  it("the Wedding Dashboard workbook: Summary, current plan, Budget, Expenses, Supplier Balances, Upcoming Payments, Tasks, Guests / RSVP", async () => {
    const cats = await setup();
    const s = await photographer(cats);
    ok(await markPaid(await schedule(s, cats["Photo / Video"], 2000000, "2026-10-15")));
    ok(await api("tasks", u.camille, { action: "create", task: { title: "Late", dueDate: "2026-10-01" } }), 201);
    ok(await api("tasks", u.camille, { action: "create", task: { title: "Later", dueDate: "2026-12-01" } }), 201);
    const d = await download(u.camille, "dashboard", { from: "2026-10-01", to: "2026-10-16" });
    expect(d.status).toBe(200);
    for (const name of ["Summary", "Period activity", "Wedding plan", "Category Budget", "Expenses", "Supplier Balances", "Upcoming Payments", "Tasks", "Guests & RSVP", "Export info"]) expect(readXlsx(d.bytes, { sheet: name }).sheetName, name).toBe(name);
    const plan = Object.fromEntries(readXlsx(d.bytes, { sheet: "Wedding plan" }).rows.map((r) => [r[0], r[1]]));
    expect(plan).toMatchObject({ "Total spent": "20000", "Supplier balance": "60000", "Open tasks": "2", "Overdue tasks": "1" });
    expect(JSON.stringify(readXlsx(d.bytes, { sheet: "Summary" }).rows)).not.toMatch(/COGS|Gross|Profit|Sales/i);
  });

  it("Wedding datasets are closed to Distributor / Household / Baby; Baby datasets closed to Bridal", async () => {
    for (const ds of ["weddingBudget", "weddingExpenses", "weddingSuppliers", "supplierPayments", "weddingTasks", "guests"]) {
      expect((await download(world.uids.ownera, ds, {}, "biz-a")).status, ds).toBe(403);
      expect((await download(u.babyowner, ds, {}, "biz-baby")).status, ds).toBe(403);
      expect((await download(u.helper, ds)).status, ds).toBe(403);
    }
    for (const ds of ["budget", "babyExpenses", "providers", "paymentSchedule", "expenses"]) expect((await download(u.camille, ds)).status, ds).toBe(403);
  });
});
