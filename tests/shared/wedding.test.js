// Phase 16: the Wedding workspace's shared rules: validation, supplier
// balance, task timing and counters, RSVP rules and totals (people vs
// invitations), list specs and the export gates.

import { describe, it, expect } from "vitest";
import { validateSupplierInput, validateSupplierPaymentInput, validateTaskInput, validateGuestInput, validateRsvp, supplierBalance, taskTiming, taskTotalsDelta, guestContribution, guestDelta, rsvpSummary, weddingSummary, keyOf } from "../../shared/wedding.js";
import { weddingSuppliersQuery, supplierPaymentsQuery, weddingTasksQuery, guestsQuery, expensesQuery } from "../../shared/list-queries.js";
import { EXPORT_DATASETS } from "../../shared/export-datasets.js";
import { canExport } from "../../shared/exports.js";
import { computeEntitlements } from "../../shared/entitlements.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { dashboardCounts, resolveDashboard, widgetValue, DASHBOARD_WIDGETS } from "../../shared/dashboard.js";

const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

describe("suppliers", () => {
  it("balance = agreed − paid; no agreement -> no balance (null, never 0)", () => {
    expect(supplierBalance({ agreedAmount: 8000000, paid: 2000000 })).toBe(6000000);
    expect(supplierBalance({ agreedAmount: null, paid: 2000000 })).toBeNull();
    expect(supplierBalance({ agreedAmount: 8000000 })).toBe(8000000);
  });
  it("validation: a known service, an optional agreed amount in centavos; paid / balance can't be sent", () => {
    expect(validateSupplierInput({ name: " ABC Photo Studio ", service: "photo_video", agreedAmount: 8000000 })).toMatchObject({ name: "ABC Photo Studio", agreedAmount: 8000000 });
    for (const bad of [{ name: "X", service: "customer" }, { name: "X", service: "venue", agreedAmount: -1 }, { name: "X", service: "venue", agreedAmount: 1.5 }, { name: "X", service: "venue", paid: 1 }, { name: "X", service: "venue", balance: 1 }, { name: "X", service: "venue", email: "nope" }]) expect(code(() => validateSupplierInput(bad)), JSON.stringify(bad)).toMatch(/invalid/);
  });
  it("supplier payments: supplier required on create, never changed on edit; status / expenseId can't be sent", () => {
    const ok = { supplierId: "abcdefgh12", description: "Downpayment", category: "abcdefgh34", amount: 2000000, dueDate: "2026-12-01" };
    expect(validateSupplierPaymentInput(ok)).toMatchObject(ok);
    expect(code(() => validateSupplierPaymentInput({ supplierId: "abcdefgh99" }, { partial: true }))).toBe("invalid-input");
    for (const extra of [{ amount: 0 }, { dueDate: "2026-13-01" }, { status: "paid" }, { expenseId: "x" }, { supplierId: "a/b" }]) expect(code(() => validateSupplierPaymentInput({ ...ok, ...extra })), JSON.stringify(extra)).toMatch(/invalid/);
  });
});

describe("tasks", () => {
  it("overdue / due soon are derived from the due date, status and today (never stored)", () => {
    const t = (o) => ({ status: "not_started", dueDate: "2026-10-20", ...o });
    expect(taskTiming(t({ dueDate: "2026-10-15" }), "2026-10-16")).toBe("overdue");
    expect(taskTiming(t({ dueDate: "2026-10-20" }), "2026-10-16")).toBe("due_soon");
    expect(taskTiming(t({ dueDate: "2026-10-16" }), "2026-10-16")).toBe("due_soon"); // due today is not overdue yet
    expect(taskTiming(t({ dueDate: "2026-11-30" }), "2026-10-16")).toBeNull();
    expect(taskTiming(t({ status: "completed", dueDate: "2026-10-01" }), "2026-10-16")).toBeNull();
    expect(taskTiming(t({ status: "cancelled", dueDate: "2026-10-01" }), "2026-10-16")).toBeNull();
    expect(taskTiming(t({ dueDate: null }), "2026-10-16")).toBeNull();
  });
  it("counters: open / completed / cancelled move with the status", () => {
    expect(taskTotalsDelta(null, { status: "not_started" })).toEqual({ total: 1, open: 1, completed: 0, cancelled: 0 });
    expect(taskTotalsDelta({ status: "in_progress" }, { status: "completed" })).toEqual({ total: 0, open: -1, completed: 1, cancelled: 0 });
    expect(taskTotalsDelta({ status: "completed" }, { status: "in_progress" })).toEqual({ total: 0, open: 1, completed: -1, cancelled: 0 });
    expect(taskTotalsDelta({ status: "in_progress" }, { status: "in_progress" })).toEqual({ total: 0, open: 0, completed: 0, cancelled: 0 });
  });
  it("validation: free-text category / assignee (no hard-coded names); priority from the list, Normal by default", () => {
    expect(validateTaskInput({ title: "Submit church requirements", category: "Ceremony / Church", assignee: "Tita Lorna" })).toMatchObject({ category: "Ceremony / Church", assignee: "Tita Lorna" });
    expect(validateTaskInput({ title: "x" }).priority).toBeUndefined();
    for (const bad of [{ title: "" }, { title: "x", priority: "urgent" }, { title: "x", dueDate: "tomorrow" }, { title: "x", status: "completed" }, { title: "x", open: true }]) expect(code(() => validateTaskInput(bad)), JSON.stringify(bad)).toMatch(/invalid/);
    expect(keyOf("  Ceremony   /  Church ")).toBe("ceremony / church");
  });
});

describe("guests / RSVP", () => {
  it("RSVP rules: attending 1..party size; declined / awaiting = 0", () => {
    expect(validateRsvp({ status: "attending", confirmed: 3 }, 4)).toEqual({ status: "attending", confirmed: 3 });
    expect(validateRsvp({ status: "declined" }, 4)).toEqual({ status: "declined", confirmed: 0 });
    expect(validateRsvp({ status: "awaiting", confirmed: 0 }, 4)).toEqual({ status: "awaiting", confirmed: 0 });
    for (const [r, size] of [[{ status: "attending", confirmed: 5 }, 4], [{ status: "attending", confirmed: 0 }, 4], [{ status: "attending" }, 4], [{ status: "declined", confirmed: 2 }, 4], [{ status: "maybe" }, 4]]) expect(code(() => validateRsvp(r, size)), JSON.stringify(r)).toBe("invalid-input");
  });
  it("totals count people and invitations separately (Prado Family: invited 4, attending 3)", () => {
    const g = { partySize: 4, rsvp: "attending", confirmed: 3, invitationSent: "2026-10-01" };
    expect(guestContribution(g)).toMatchObject({ invitations: 1, invitedSeats: 4, attending: 1, attendingSeats: 3, awaiting: 0, invitationsSent: 1 });
    expect(guestDelta({ ...g, confirmed: 3 }, { ...g, confirmed: 4 })).toMatchObject({ attendingSeats: 1, attending: 0, invitations: 0 });
    expect(guestDelta(g, { ...g, rsvp: "declined", confirmed: 0 })).toMatchObject({ attending: -1, attendingSeats: -3, declined: 1, declinedSeats: 4 });
    expect(guestContribution({ partySize: 4, rsvp: "awaiting", confirmed: 0 })).toMatchObject({ awaiting: 1, awaitingSeats: 4, attendingSeats: 0 });
    expect(rsvpSummary(null).attendingSeats).toBe(0);
  });
  it("validation: party size 1..50; side from the list; rsvp / confirmed can't be set through guest edits", () => {
    expect(validateGuestInput({ name: "Prado Family", side: "groom", partySize: 4 })).toMatchObject({ partySize: 4 });
    for (const bad of [{ name: "x", side: "groom", partySize: 0 }, { name: "x", side: "groom", partySize: 51 }, { name: "x", side: "left", partySize: 1 }, { name: "x", side: "both", partySize: 1, rsvp: "attending" }, { name: "x", side: "both", partySize: 1, confirmed: 1 }]) expect(code(() => validateGuestInput(bad)), JSON.stringify(bad)).toBe("invalid-input");
  });
});

describe("wedding dashboard figures", () => {
  it("supplier balance on the dashboard = contracted − paid on those contracts; remaining = budget − spent", () => {
    expect(weddingSummary({ total: 50000000, spent: 5000000, contracted: 11000000, contractedPaid: 5000000 })).toMatchObject({ remaining: 45000000, supplierBalance: 6000000 });
  });
  it("overdue tasks are a live count against the business's today; the widget is current, not a period figure", () => {
    const w = DASHBOARD_WIDGETS.find((x) => x.id === "weddingOverdueTasks");
    expect(w.section).toBe("current");
    expect(dashboardCounts([w], "2026-10-16")).toEqual([{ key: "count:weddingOverdueTasks", collection: "weddingTasks", where: [["open", "==", true], ["dueDate", "<", "2026-10-16"]] }]);
    expect(widgetValue(w, { count: 3 })).toBe(3);
  });
  it("Confirmed guests reads people (attendingSeats), Awaiting reads invitations", () => {
    expect(DASHBOARD_WIDGETS.find((x) => x.id === "weddingConfirmedGuests")).toMatchObject({ value: "attendingSeats", label: "Confirmed guests (people)" });
    expect(DASHBOARD_WIDGETS.find((x) => x.id === "weddingAwaitingRsvp")).toMatchObject({ value: "awaiting", label: "Awaiting RSVP (invitations)" });
  });
  it("Staff in Bridal see no wedding money, tasks or guests", () => {
    const staff = resolveDashboard({ entitlements: computeEntitlements(PLAN_SEED.pro, {}, "bridal-expense"), permissions: resolvePermissions("staff") });
    expect(staff).toEqual([]);
  });
});

describe("list specs (screens and Excel share them)", () => {
  it("suppliers: active by default, service + name prefix", () => {
    expect(weddingSuppliersQuery({}).parts[0].where).toEqual([["status", "==", "active"]]);
    expect(weddingSuppliersQuery({ service: "venue" }).parts[0].where).toEqual([["status", "==", "active"], ["service", "==", "venue"]]);
  });
  it("supplier payments: Upcoming soonest first; status + supplier + due range", () => {
    expect(supplierPaymentsQuery({ supplierId: "s1", from: "2026-11-01", to: "2026-12-31" }).parts[0]).toMatchObject({ where: [["status", "==", "upcoming"], ["supplierId", "==", "s1"], ["dueDate", ">=", "2026-11-01"], ["dueDate", "<=", "2026-12-31"]], orderBy: [["dueDate", "asc"], ["__id__", "asc"]] });
  });
  it("tasks: open by default; overdue = open + due before today; a status filter shows every task with it", () => {
    expect(weddingTasksQuery({}).parts[0].where).toEqual([["open", "==", true]]);
    expect(weddingTasksQuery({ state: "overdue" }, { today: "2026-10-16" }).parts[0].where).toEqual([["open", "==", true], ["dueDate", "<", "2026-10-16"]]);
    expect(weddingTasksQuery({ status: "completed" }).parts[0].where).toEqual([["status", "==", "completed"]]);
    expect(weddingTasksQuery({ categoryKey: "venue", assigneeKey: "camille", priority: "high" }).parts[0].where).toEqual([["open", "==", true], ["categoryKey", "==", "venue"], ["assigneeKey", "==", "camille"], ["priority", "==", "high"]]);
    expect(() => weddingTasksQuery({ state: "overdue" })).toThrow();
  });
  it("guests: RSVP / side / invitation sent; Wedding Expenses by supplier", () => {
    expect(guestsQuery({ rsvp: "attending", side: "groom", invited: "not_sent" }).parts[0].where).toEqual([["rsvp", "==", "attending"], ["side", "==", "groom"], ["invited", "==", false]]);
    expect(expensesQuery({ supplierId: "s1" }).parts[0].where).toEqual([["status", "==", "active"], ["supplierId", "==", "s1"]]);
  });
});

describe("export gates: Wedding datasets only in Bridal", () => {
  const access = (t, role = "owner") => ({ entitlements: computeEntitlements(PLAN_SEED.pro, {}, t), permissions: resolvePermissions(role) });
  const WEDDING = ["weddingBudget", "weddingExpenses", "weddingSuppliers", "supplierPayments", "weddingTasks", "guests"];
  it("Bridal owner: every Wedding dataset; Distributor / Household / Baby: none; Bridal staff: none", () => {
    for (const ds of WEDDING) {
      expect(canExport(access("bridal-expense"), EXPORT_DATASETS[ds]), ds).toBe(true);
      expect(canExport(access("bridal-expense", "staff"), EXPORT_DATASETS[ds]), ds).toBe(false);
      for (const t of ["distributor", "household-payroll", "baby-expense"]) expect(canExport(access(t), EXPORT_DATASETS[ds]), `${t}/${ds}`).toBe(false);
    }
    for (const ds of ["budget", "babyExpenses", "providers", "paymentSchedule", "expenses"]) expect(canExport(access("bridal-expense"), EXPORT_DATASETS[ds]), ds).toBe(false);
  });
});
