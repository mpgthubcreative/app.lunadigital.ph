// Master Backup: ONE Excel workbook with everything the business has in
// Luna, as Luna's technical recovery copy. Luna Super Admin only since
// 2026-10-18 (../backup.js: requireOperator); customers download the clean
// workbook instead (./workbook/). Not a report: every record of
// every collection the workspace's modules own (removed / voided / inactive
// ones included), read in full pages (never truncated: too much data is an
// error, not a shorter file), one sheet each, with every field as a column
// (nested values as JSON, timestamps as ISO text). Plus Export Info, Users /
// Memberships and the Audit log; a wedding also gets Wedding Setup, Guest
// Categories, RSVP History, Tables, Seating Assignments and Music & Program
// as readable sheets; Luna Household gets Expenses, Bills, Recurring Items,
// Categories and Grocery List under those names (no Budget).
//
// Never exported: credentials. Fields whose name says token / secret / hash
// / password are dropped, and the invitation links live in a server-only
// collection that is never read here. Aggregates Luna recomputes (metrics,
// totals) and notification inboxes are left out.

import { getWorkspaceTemplate } from "../../../shared/workspaces.js";
import { getModule, isModuleEnabled } from "../../../shared/modules.js";
import { writeXlsx } from "../../../shared/xlsx.js";
import { rsvpByCategory, SEATING_DOC_ID, TOTALS_DOC_ID } from "../../../shared/wedding.js";
import { seatingPlan } from "../../../shared/wedding-seating.js";
import { programSection, formatDuration, PROGRAM_SECTIONS } from "../../../shared/wedding-program.js";
import { rolesPlan, membersOf, roleLabel } from "../../../shared/wedding-roles.js";
import { crewTotals } from "../../../shared/wedding-crew.js";
import { invitationStatus } from "../../../shared/invitation-design.js";

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const BACKUP_MAX_ROWS = 60000;
const PAGE = 500;
const SKIP = new Set(["metrics", "financialMetrics", "spendingMetrics", "inbox", "inboxState", "reports", "taskTotals", "guestTotals", "members"]);
const SECRET = /token|secret|hash|password/i;
const NAMES = {
  orders: "Orders", orderCosts: "Order costs", payments: "Payments", products: "Products", inventoryTransactions: "Stock movements", productCosts: "Product costs", inventoryTransactionCosts: "Stock movement costs",
  customers: "Customers", expenses: "Expenses", imports: "Imports", householdStaff: "Staff", attendance: "Attendance", attendanceRequests: "Attendance requests", payrolls: "Payroll", advances: "Advances",
  budgets: "Budget totals", expenseCategories: "Budget", scheduledPayments: "Payment schedule", providers: "Providers", weddingSuppliers: "Suppliers", supplierPayments: "Supplier Payments", weddingTasks: "Tasks", guests: "Guests", settings: "Settings",
};
// Bridal sheet order (what the couple expects to find first).
// Luna Household names for the shared money collections, and sheet order.
// No Budget sheets: Household has no budget (owner pilot, 2026-10-17); the
// stored budgets/current (Luna's own running totals) isn't exported.
const HOUSEHOLD_NAMES = { scheduledPayments: "Bills", expenseCategories: "Categories", groceryItems: "Grocery List record", groceryLists: "Grocery List settings" };
const HOUSEHOLD_SKIP = new Set(["budgets"]);
const HOUSEHOLD_ORDER = ["Export Info", "Staff", "Attendance", "Attendance requests", "Payroll", "Advances", "Expenses", "Bills", "Recurring Items", "Categories", "Grocery List", "Grocery List record", "Grocery List settings", "Users & Memberships", "Audit log"];
const WEDDING_ORDER = ["Export Info", "Wedding Setup", "Budget", "Budget totals", "Suppliers", "Supplier Payments", "Expenses", "Tasks", "Guest Categories", "Guests", "RSVP History", "Tables", "Seating Assignments", "Party Members", "Wedding Roles", "Music & Program", "Crew Meals", "Invitation Design", "Users & Memberships", "Audit log"];

const iso = (v) => (v && typeof v.toDate === "function" ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : null);
// A stored proof file (expense / payment / payroll): safe facts only (type,
// size, when, who). Never the file itself, its storage path or ledger id.
const isStoredFile = (v) => v && typeof v === "object" && typeof v.path === "string" && typeof v.contentType === "string";
export const proofSummary = (p) => ({ file: p.contentType === "application/pdf" ? "PDF" : "Image", contentType: p.contentType, bytes: Number.isSafeInteger(p.size) ? p.size : null, uploadedAt: iso(p.uploadedAt), uploadedBy: p.uploadedBy?.name ?? null });
// One cell: text / number / ISO time / JSON for nested values.
export function cellOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v.slice(0, 32000);
  const t = iso(v);
  if (t) return t;
  try {
    if (isStoredFile(v)) v = proofSummary(v);
    return JSON.stringify(v, (k, x) => (k && SECRET.test(k) ? undefined : isStoredFile(x) ? proofSummary(x) : iso(x) ?? x)).slice(0, 32000);
  } catch {
    return String(v).slice(0, 32000);
  }
}
// Records -> [header, ...rows]: id first, then every field seen (secrets dropped).
export function tableOf(records) {
  const keys = [];
  const seen = new Set();
  for (const r of records) for (const k of Object.keys(r.data)) if (!seen.has(k) && !SECRET.test(k)) seen.add(k) && keys.push(k);
  return [["id", ...keys], ...records.map((r) => [r.id, ...keys.map((k) => cellOf(r.data[k]))])];
}

// Every document of a collection, page by page (ordered by id).
async function readAll(col, FieldPath, budget) {
  const out = [];
  let last = null;
  for (;;) {
    let q = col.orderBy(FieldPath.documentId()).limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const d of snap.docs) out.push({ id: d.id, data: d.data() });
    budget.rows += snap.docs.length;
    if (budget.rows > BACKUP_MAX_ROWS) throw new BackupError("too-many-rows", `This business has more than ${BACKUP_MAX_ROWS.toLocaleString("en-US")} records; the backup can't be made in one file yet. Contact Luna support.`);
    if (snap.docs.length < PAGE) return out;
    last = snap.docs.at(-1).id;
  }
}

const sheet = (name, rows) => ({ name, rows: rows.length ? rows : [["(none)"]], header: true, filter: rows.length > 1 });

export async function buildBackup({ db, tenant, business, entitlements, FieldPath, actor, now = new Date() }) {
  const template = getWorkspaceTemplate(entitlements?.workspaceTemplateId);
  const wedding = template?.id === "bridal-expense";
  const home = template?.id === "household-payroll";
  const budget = { rows: 0 };
  const collections = [];
  for (const id of template?.modules || []) {
    if (!isModuleEnabled(entitlements, id)) continue;
    for (const c of Object.keys(getModule(id)?.collections || {})) if (!SKIP.has(c) && !(home && HOUSEHOLD_SKIP.has(c)) && !collections.includes(c)) collections.push(c);
  }
  const sheets = [];
  const counts = [];
  const add = (name, rows) => {
    sheets.push(sheet(name, rows));
    counts.push([name, Math.max(0, rows.length - 1)]);
  };
  const data = {};
  for (const c of collections) {
    data[c] = await readAll(tenant.collection(c), FieldPath, budget);
    // Household categories: the old per-category budget figure isn't exported.
    const rows = home && c === "expenseCategories" ? data[c].map((r) => ({ id: r.id, data: Object.fromEntries(Object.entries(r.data).filter(([k]) => k !== "budget")) })) : data[c];
    add((home && HOUSEHOLD_NAMES[c]) || NAMES[c] || c, tableOf(rows));
  }
  const members = await readAll(tenant.collection("members"), FieldPath, budget);
  add("Users & Memberships", tableOf(members));
  const audit = await readAll(tenant.collection("auditLog"), FieldPath, budget);
  add("Audit log", tableOf(audit));

  if (wedding) {
    const setup = await tenant.doc("weddingSetup", "current").get();
    const s = setup.exists ? setup.data() : {};
    add("Wedding Setup", [["Setting", "Value"], ...Object.keys(s).filter((k) => !SECRET.test(k) && k !== "hero").sort().map((k) => [k, cellOf(s[k])])]);
    const totals = await tenant.doc("guestTotals", TOTALS_DOC_ID).get();
    add("Guest Categories", [["Category", "Invitations", "Invited seats", "Attending seats", "Waiting seats", "Declined seats"], ...rsvpByCategory(totals.exists ? totals.data() : {}).map((r) => [r.label, r.invitations, r.invitedSeats, r.attendingSeats, r.awaitingSeats, r.declinedSeats])]);
    const guests = data.guests || [];
    const rsvp = [["Guest id", "Guest", "When", "Source", "By", "From status", "From seats", "To status", "To seats", "Entry"]];
    for (const g of guests) {
      for (const h of g.data.history || []) {
        if (!h || (!h.to && !/RSVP|Confirmed guests|responded/i.test(h.label || ""))) continue;
        rsvp.push([g.id, g.data.name, iso(h.at) ?? cellOf(h.at), h.source || (h.to ? "owner" : ""), h.actor?.name || "", h.from?.rsvp ?? "", h.from?.confirmed ?? null, h.to?.status ?? "", h.to?.confirmed ?? null, h.label || ""]);
      }
    }
    add("RSVP History", rsvp);
    const seatingDoc = await tenant.doc("guestTotals", SEATING_DOC_ID).get();
    const plan = seatingPlan(guests.map((g) => ({ id: g.id, ...g.data })), seatingDoc.exists ? seatingDoc.data() : {});
    add("Tables", [["Table id", "Table", "Seats", "Seats taken", "Parties"], ...plan.tables.map((t) => [t.id, t.name, t.capacity, t.used, new Set(t.people.map((p) => p.guestId)).size])]);
    const parties = guests.map((g) => ({ id: g.id, ...g.data }));
    // One row per named person (primary first); unnamed seats are a count.
    add("Party Members", [["Party (guest)", "Guest id", "Person", "Person key", "Primary", "Marked attending", "Roles", "Party seats", "Party attending", "Unnamed seats"], ...parties.flatMap((g) => {
      const members = membersOf(g);
      const people = [{ key: g.id, name: g.name, primary: true, attending: g.attending, roles: g.roles }, ...members.map((m) => ({ key: `${g.id}:${m.id}`, name: m.name, primary: false, attending: m.attending, roles: m.roles }))];
      const unnamed = Math.max(0, (g.partySize ?? 1) - people.length);
      return people.map((p) => [g.name, g.id, p.name, p.key, p.primary ? "yes" : "no", p.attending === true ? "yes" : "", (Array.isArray(p.roles) ? p.roles : []).map((r) => roleLabel(r)).join(", "), g.partySize ?? null, g.rsvp === "attending" ? g.confirmed ?? 0 : 0, p.primary ? unnamed : ""]);
    })]);
    add("Wedding Roles", [["Role", "Role key", "Person", "Person key", "Party (guest)", "Guest id", "RSVP"], ...rolesPlan(parties).flatMap((gr) => gr.people.map((p) => [gr.label, gr.key, p.name, p.key, p.party, p.guestId, p.rsvp ?? ""]))]);
    const program = (await readAll(tenant.collection("weddingProgram"), FieldPath, budget)).map((r) => ({ id: r.id, ...r.data }));
    add("Music & Program", [["Part", "#", "Moment", "Song", "Duration", "Person / group", "Notes", "Item id"], ...["ceremony", "reception"].flatMap((sec) => programSection(program, sec).map((i, n) => [PROGRAM_SECTIONS[sec].label, n + 1, i.moment, i.song ?? "", Number.isSafeInteger(i.durationSec) ? formatDuration(i.durationSec) : "", i.person ?? "", i.notes ?? "", i.id]))]);
    const crew = (await readAll(tenant.collection("weddingCrewMeals"), FieldPath, budget)).map((r) => ({ id: r.id, ...r.data })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const crewSettings = await tenant.doc("crewMealSettings", "current").get();
    const prices = crewSettings.exists ? crewSettings.data().prices || {} : {};
    const ct = crewTotals(crew, prices);
    add("Crew Meals", [["Crew / person", "Linked supplier", "Breakfast", "Lunch", "Dinner", "Location", "Remarks", "Created", "Updated", "Entry id"], ...crew.map((c) => [c.name, c.supplierName ?? "", c.breakfast ?? 0, c.lunch ?? 0, c.dinner ?? 0, c.location ?? "", c.remarks ?? "", cellOf(c.createdAt), cellOf(c.updatedAt), c.id]), ...(crew.length ? [["Total", "", ct.breakfast, ct.lunch, ct.dinner, "", ct.cost === null ? "" : `Est. cost ₱${(ct.cost / 100).toLocaleString("en-PH")}`, "", "", ""]] : [])]);
    const designDoc = await tenant.doc("invitationDesign", "current").get();
    const dd = designDoc.exists ? designDoc.data() : null;
    const ist = invitationStatus({ planId: business?.subscription?.planId ?? entitlements?.planId, design: dd });
    add("Invitation Design", [["Setting", "Value"], ["Invitation level", ist.level], ["Guests see", ist.live], ["Published version", dd?.published?.version ?? ""], ["Published template", dd?.published?.config?.templateId ?? ""], ["Published config", dd?.published?.config ? JSON.stringify(dd.published.config) : ""], ["Draft state", dd?.draft?.state ?? ""], ["Draft config", dd?.draft?.config ? JSON.stringify(dd.draft.config) : ""], ["Saved versions", (dd?.history ?? []).map((h) => h.version).join(", ")]]);
    add("Seating Assignments", [["Guest id", "Guest", "Attending seats", "Table id", "Table"], ...plan.tables.flatMap((t) => t.guests.map((g) => [g.id, g.name, g.confirmed ?? 0, t.id, t.name])), ...plan.unassigned.map((g) => [g.id, g.name, g.confirmed ?? 0, "", "Unassigned"])]);
  }

  if (home && data.groceryItems) {
    // Readable: item, quantity, category, bought, created / bought dates and who.
    add("Grocery List", [["Item", "Qty", "Category", "Bought", "Created", "Created by", "Bought on", "Bought by", "Updated by"], ...data.groceryItems.map((g) => [g.data.name, g.data.qty ?? "", g.data.category ?? "", g.data.bought ? "Yes" : "No", iso(g.data.createdAt) ?? "", g.data.createdBy?.name ?? "", iso(g.data.boughtAt) ?? "", g.data.boughtBy?.name ?? "", g.data.updatedBy?.name ?? ""])]);
  }
  if (home && data.scheduledPayments) {
    const names = Object.fromEntries((data.expenseCategories || []).map((c) => [c.id, c.data.name]));
    const peso = (c) => (Number.isSafeInteger(c) ? c / 100 : null);
    const every = (r) => (!r ? "" : r.interval > 1 ? `Every ${r.interval} ${r.every}s` : `Every ${r.every}`);
    // The repeating bills still to pay: what comes back each period.
    add("Recurring Items", [["Bill id", "Bill", "Repeats", "Next due", "Amount (PHP)", "Category", "Paid to", "Notes"], ...data.scheduledPayments.filter((s) => s.data.repeat && s.data.status === "upcoming").map((s) => [s.id, s.data.description, every(s.data.repeat), s.data.dueDate, peso(s.data.amount), names[s.data.category] ?? s.data.categoryName ?? "", s.data.payee ?? "", s.data.notes ?? ""])]);
  }

  const info = [
    ["Luna Master Backup", ""],
    ["Business", business.name || ""],
    ["Business id", tenant.businessId || ""],
    ["Workspace", template?.name || ""],
    ["Created", now.toISOString()],
    ["Created by", actor?.name || actor?.email || actor?.uid || ""],
    ["Contents", "Every record Luna keeps for this business, including removed, voided and inactive ones. One sheet per kind of record; every field is a column (nested values as JSON, times in UTC)."],
    ["Not included", "Passwords, sign-in and invitation links (secrets), and totals Luna recalculates."],
    ["Proof files", "Receipts / screenshots aren't inside this file: each record lists its proof (Image or PDF, size, when and who uploaded it). Open them in Luna."],
    ["", ""],
    ["Sheet", "Rows"],
    ...counts,
  ];
  const all = [{ name: "Export Info", rows: info, header: false }, ...sheets];
  if (home) all.sort((a, b) => (HOUSEHOLD_ORDER.indexOf(a.name) + 1 || 99) - (HOUSEHOLD_ORDER.indexOf(b.name) + 1 || 99));
  if (wedding) all.sort((a, b) => (WEDDING_ORDER.indexOf(a.name) + 1 || 99) - (WEDDING_ORDER.indexOf(b.name) + 1 || 99));
  const bytes = writeXlsx(all, { title: `Luna Master Backup — ${business.name || ""}`, created: now });
  const day = now.toISOString().slice(0, 10);
  const safe = (business.name || "Luna").replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "Luna";
  return { bytes, fileName: `${safe}-Master-Backup-${day}.xlsx`, rows: budget.rows, sheets: all.map((s) => s.name) };
}
