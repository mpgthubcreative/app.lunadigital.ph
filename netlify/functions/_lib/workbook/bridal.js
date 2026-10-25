// Luna Bridal: the Download Excel sheets (shared/workbook.js). The whole
// wedding, as it is now; readable text only (no ids, no JSON). Never an
// invitation link or token (those live server-only and are never read here).
//   Expenses         the Expenses screen's rows (shared/wedding-money.js)
//   Payments         every payment recorded (active Wedding Expenses)
//   Tasks            Bride / Groom marks for "Bride & Groom" tasks
//   Guests           one row per party
//   Party Members    one row per named person, roles as readable text
//   Seating          attending parties by table ("Not seated yet")
//   Roles            one row per person and role (several people per role,
//                    several roles per person)
//   Crew Meals       meals per crew / person, with totals
//   Music & Program  ceremony then reception, in program order
//   Wedding Setup    couple, date, venues, times, RSVP deadline
// Each sheet only with the permission of the screen it comes from.

import { categoriesQuery, weddingSuppliersQuery, supplierPaymentsQuery, expensesQuery, weddingTasksQuery, guestsQuery } from "../../../../shared/list-queries.js";
import { sortCategories } from "../../../../shared/baby.js";
import { EXPENSE_METHODS } from "../../../../shared/expenses.js";
import { TASK_STATUSES, RSVP_STATUSES, GUEST_CATEGORIES, SEATING_DOC_ID, coupleDisplayName } from "../../../../shared/wedding.js";
import { seatingPlan } from "../../../../shared/wedding-seating.js";
import { moneyRows, moneyLabel, MONEY_STATUS } from "../../../../shared/wedding-money.js";
import { peopleOf, rolesPlan, roleLabel } from "../../../../shared/wedding-roles.js";
import { programSection, formatDuration, PROGRAM_SECTIONS } from "../../../../shared/wedding-program.js";
import { byText } from "./common.js";

const label = (map, key) => map[key]?.label ?? key ?? "";
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
// "15:30" -> "3:30 PM"
const clock = (t) => {
  const m = /^(\d{2}):(\d{2})$/.exec(t || "");
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
};

const MONEY_COLUMNS = [
  { header: "Category", format: "text", width: 20, value: (r) => r.category || "Other" },
  { header: "Supplier / Description", format: "text", width: 32, value: (r) => moneyLabel(r) },
  { header: "Total", format: "money", width: 14, total: true, value: (r) => r.total },
  { header: "Paid", format: "money", width: 14, total: true, value: (r) => (r.kind === "supplier" ? r.record.paid ?? 0 : r.kind === "expense" ? r.total : null) },
  { header: "Remaining", format: "money", width: 14, total: true, value: (r) => r.remaining },
  { header: "Status", format: "text", width: 10, value: (r) => MONEY_STATUS[r.status] ?? "" },
  { header: "Next Due", format: "date", width: 14, value: (r) => r.nextDue ?? null },
];
const PAYMENT_COLUMNS = [
  { header: "Supplier / Description", format: "text", width: 32, value: (e) => e.label },
  { header: "Date", format: "date", width: 14, value: (e) => e.date },
  { header: "Amount", format: "money", width: 14, total: true, value: (e) => e.amount },
  { header: "Method", format: "text", width: 14, value: (e) => (e.method ? label(EXPENSE_METHODS, e.method) : "") },
  { header: "Reference", format: "text", width: 18, value: (e) => e.reference },
];
const done = (on) => (on ? "Done" : "Not done");
const partFor = (t, who) => {
  if (t.forWhom === "both") return done(t.parts?.[who] === true || t.status === "completed");
  if (t.forWhom === who) return done(t.status === "completed");
  return "";
};
const TASK_COLUMNS = [
  { header: "Task", format: "text", width: 36, value: (t) => t.title },
  { header: "Assigned To", format: "text", width: 20, value: (t) => t.assignee },
  { header: "Due Date", format: "date", width: 14, value: (t) => t.dueDate },
  { header: "Bride Status", format: "text", width: 12, value: (t) => partFor(t, "bride") },
  { header: "Groom Status", format: "text", width: 12, value: (t) => partFor(t, "groom") },
  { header: "Overall Status", format: "text", width: 14, value: (t) => label(TASK_STATUSES, t.status) },
];
const GUEST_COLUMNS = [
  { header: "Guest / Party", format: "text", width: 30, value: (g) => g.name },
  { header: "Invited Seats", format: "integer", width: 13, total: true, value: (g) => int(g.partySize) },
  { header: "Attending", format: "integer", width: 11, total: true, value: (g) => (g.rsvp === "attending" ? int(g.confirmed) : 0) },
  { header: "RSVP Status", format: "text", width: 16, value: (g) => label(RSVP_STATUSES, g.rsvp) },
  { header: "Category", format: "text", width: 18, value: (g) => GUEST_CATEGORIES[g.category]?.label ?? "" },
];
const attendingText = (p) => (p.rsvp === "declined" ? "No" : p.attending === true ? "Yes" : p.attending === false ? "No" : "");
const PARTY_COLUMNS = [
  { header: "Party", format: "text", width: 28, value: (p) => p.party },
  { header: "Person", format: "text", width: 26, value: (p) => p.name },
  { header: "Attending", format: "text", width: 11, value: attendingText },
  { header: "Role", format: "text", width: 34, value: (p) => p.roles.map((r) => roleLabel(r)).join(", ") },
];
// One row per confirmed person (2026-10-21: seating is per person).
const SEATING_COLUMNS = [
  { header: "Person", format: "text", width: 26, value: (s) => s.person.name },
  { header: "Party", format: "text", width: 28, value: (s) => s.person.party },
  { header: "Table", format: "text", width: 20, value: (s) => s.table },
  { header: "RSVP Status", format: "text", width: 16, value: (s) => label(RSVP_STATUSES, s.person.guest.rsvp) },
];
const ROLE_COLUMNS = [
  { header: "Person", format: "text", width: 26, value: (r) => r.person },
  { header: "Role", format: "text", width: 24, value: (r) => r.role },
  { header: "Party", format: "text", width: 28, value: (r) => r.party },
];
const CREW_COLUMNS = [
  { header: "Person / Group", format: "text", width: 26, value: (c) => c.name },
  { header: "Supplier", format: "text", width: 22, value: (c) => c.supplierName },
  { header: "Breakfast", format: "integer", width: 10, total: true, value: (c) => int(c.breakfast) },
  { header: "Lunch", format: "integer", width: 10, total: true, value: (c) => int(c.lunch) },
  { header: "Dinner", format: "integer", width: 10, total: true, value: (c) => int(c.dinner) },
  { header: "Location", format: "text", width: 14, value: (c) => c.location },
  { header: "Notes", format: "text", width: 30, value: (c) => c.remarks },
];
const PROGRAM_COLUMNS = [
  { header: "Part", format: "text", width: 12, value: (i) => PROGRAM_SECTIONS[i.section]?.label ?? "" },
  { header: "Order", format: "integer", width: 8, value: (i) => i.n },
  { header: "Program Item", format: "text", width: 30, value: (i) => i.moment },
  { header: "Song / Music", format: "text", width: 30, value: (i) => i.song },
  { header: "Duration", format: "text", width: 10, value: (i) => (Number.isSafeInteger(i.durationSec) ? formatDuration(i.durationSec) : "") },
  { header: "Assigned Person", format: "text", width: 22, value: (i) => i.person },
  { header: "Notes", format: "text", width: 30, value: (i) => i.notes },
];
const SETUP_COLUMNS = [
  { header: "Couple", format: "text", width: 26, value: (s) => coupleDisplayName(s) || null },
  { header: "Wedding Date", format: "date", width: 14, value: (s) => s.weddingDate },
  { header: "Ceremony Venue", format: "text", width: 28, value: (s) => s.ceremonyVenue },
  { header: "Ceremony Time", format: "text", width: 13, value: (s) => clock(s.ceremonyTime) },
  { header: "Reception Venue", format: "text", width: 28, value: (s) => s.receptionVenue },
  { header: "Reception Time", format: "text", width: 13, value: (s) => clock(s.receptionTime) },
  { header: "RSVP Deadline", format: "date", width: 14, value: (s) => s.rsvpDeadline },
];

export async function bridalSheets(x) {
  const sheets = [];
  const seesExpenses = x.can("expenses", "expenses.view");
  const [cats, expenses] = await Promise.all([x.readRows("expenseCategories", categoriesQuery()).then(sortCategories), seesExpenses ? x.readRows("expenses", expensesQuery({ status: "active" })) : []]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));

  if (x.can("vendors", "vendors.view")) {
    // Bridal has no Budget (2026-10-21): no budget figures in the file.
    const [suppliers, upcoming] = await Promise.all([
      x.readRows("weddingSuppliers", weddingSuppliersQuery({ status: "active" })),
      x.can("vendorpayments", "vendorpayments.view") ? x.readRows("supplierPayments", supplierPaymentsQuery({ status: "upcoming" })) : [],
    ]);
    const rows = moneyRows({ suppliers, categories: cats, expenses, upcoming });
    for (const r of rows) {
      if (r.kind !== "supplier") continue;
      const dues = upcoming.filter((p) => p.supplierId === r.id).map((p) => p.dueDate).sort();
      r.nextDue = r.record.nextDue ?? dues[0] ?? null;
    }
    sheets.push({ name: "Expenses", columns: MONEY_COLUMNS, rows });
  }

  if (seesExpenses) {
    const rows = expenses.map((e) => ({ ...e, label: e.payee || e.notes || catName.get(e.category) || e.categoryName || "Payment" }));
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byText(a.label, b.label)));
    sheets.push({ name: "Payments", columns: PAYMENT_COLUMNS, rows });
  }

  if (x.can("tasks", "tasks.view")) {
    // Dated tasks by due date, then the undated ones.
    const rows = await x.readRows("weddingTasks", weddingTasksQuery({ state: "all" }));
    rows.sort((a, b) => (a.dueDate && b.dueDate ? (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) : a.dueDate ? -1 : b.dueDate ? 1 : 0) || byText(a.title, b.title));
    sheets.push({ name: "Tasks", columns: TASK_COLUMNS, rows });
  }

  if (x.can("guests", "guests.view")) {
    const [guests, seating] = await Promise.all([x.readRows("guests", guestsQuery({})), x.readByIds("guestTotals", [SEATING_DOC_ID])]);
    sheets.push({ name: "Guests", columns: GUEST_COLUMNS, rows: guests });
    sheets.push({ name: "Party Members", columns: PARTY_COLUMNS, rows: peopleOf(guests) });
    const plan = seatingPlan(guests, seating.get(SEATING_DOC_ID) ?? {});
    sheets.push({ name: "Seating", columns: SEATING_COLUMNS, rows: [...plan.tables.flatMap((t) => t.people.map((person) => ({ person, table: t.name }))), ...plan.unassigned.flatMap((u) => u.people.map((person) => ({ person, table: "Not seated yet" })))] });
    sheets.push({ name: "Roles", columns: ROLE_COLUMNS, rows: rolesPlan(guests).flatMap((gr) => gr.people.map((p) => ({ person: p.name, role: roleLabel(gr.role), party: p.party }))) });
  }

  if (x.can("vendors", "vendors.view")) {
    const crew = (await x.readAll("weddingCrewMeals")).sort((a, b) => byText(a.name, b.name));
    sheets.push({ name: "Crew Meals", columns: CREW_COLUMNS, rows: crew });
  }

  if (x.can("tasks", "tasks.view")) {
    const items = await x.readAll("weddingProgram");
    sheets.push({ name: "Music & Program", columns: PROGRAM_COLUMNS, rows: Object.keys(PROGRAM_SECTIONS).flatMap((sec) => programSection(items, sec).map((i, n) => ({ ...i, n: n + 1 }))) });
  }

  if (x.can("guests", "guests.view")) {
    const setup = (await x.readByIds("weddingSetup", ["current"])).get("current");
    if (setup) sheets.push({ name: "Wedding Setup", columns: SETUP_COLUMNS, rows: [setup] });
  }
  return sheets;
}
