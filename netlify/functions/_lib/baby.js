// Baby Expense Tracker (Phase 15), server side: Budget & Categories,
// Providers / Vendors and the Payment Schedule. Baby Expenses themselves
// are the Expenses Core (./expenses.js) with the Baby sink
// (./baby-spending.js). Every write is ONE Firestore transaction, all
// reads first.
//
// Serialization: every category and budget change reads and writes
// budgets/current (as every Baby expense does), so category names stay
// unique, the category count stays right and a budget change can't miss a
// concurrent expense's threshold. A category being deleted and an expense
// starting to use it both touch the category document (useCount), so a
// used category is never deleted.
//
// Payment Schedule -> Expense, exactly once: marking a payment Paid reads
// it; if it's already Paid the call returns the existing expense. The
// expense gets a DETERMINISTIC id (the payment id, or "<id>r<n>" after a
// reopen) and is created with create(), so even a retry or a concurrent
// second request can't make a second expense. The payment leaves Upcoming
// and the expense counts as spent in the same transaction.

import { BabyError, BABY_SCHEMA_VERSION, BUDGET_DOC_ID, MAX_CATEGORIES, SUGGESTED_CATEGORIES, CATEGORY_STATUSES, PROVIDER_STATUSES, PROVIDER_TYPES, isValidRecordId, validateCategoryInput, validateBudgetTotal, validateProviderInput, validateScheduleInput, validatePaidBy, thresholdLevel, totalFromCategories, upcomingPart } from "../../../shared/baby.js";
import { partsOf } from "./baby-spending.js";
import { EXPENSE_METHODS } from "../../../shared/expenses.js";
import { businessDate, isDayId } from "../../../shared/metrics.js";
import { prepareExpenseCreate } from "./expenses.js";
import { SUGGESTED_WEDDING_CATEGORIES } from "../../../shared/wedding.js";
import { meterActivity } from "./metering.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_HISTORY = 200;
const BUDGET_HISTORY_KEEP = 200;
const lower = (s) => (s || "").toLocaleLowerCase("en");
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const peso = (c) => (c === null || c === undefined ? "—" : `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
const who = (actor) => (actor ? { uid: actor.uid, name: actor.name } : null);
const entry = (actor, label, extra = {}) => ({ at: new Date(), actor: who(actor), label, ...extra });

function append(list, e) {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new BabyError("history-full", "Too many changes on this record");
  return [...l, e];
}
// The budget's own history never blocks a change: oldest entries roll off.
const appendBudget = (list, e) => [...(Array.isArray(list) ? list : []), e].slice(-BUDGET_HISTORY_KEEP);

const budgetRef = (tenant) => tenant.doc("budgets", BUDGET_DOC_ID);
const ref = (tenant, collection, id, what) => {
  if (!isValidRecordId(id)) throw new BabyError(`invalid-${what}`, `Invalid ${what}`);
  return tenant.doc(collection, id);
};
const checkRevision = (expected, current) => {
  if (expected !== null && expected !== undefined && expected !== current) throw new BabyError("stale", "This was changed by someone else. Reload and try again");
};

async function loadBudget(tx, tenant) {
  const snap = await tx.get(budgetRef(tenant));
  return snap.exists ? snap.data() : {};
}

// Phase 18.6: in the Baby and Wedding workspaces the Total budget is the sum
// of the category budgets (shared/baby.js totalFromCategories), kept by the
// server whenever a category's budget changes or a category is added or
// deleted. Nobody types the total.
export const AUTO_TOTAL_WORKSPACES = Object.freeze(["baby-expense", "bridal-expense"]);
const autoTotal = (workspace) => AUTO_TOTAL_WORKSPACES.includes(workspace);

// Inside a category transaction (after its reads): budgets/current fields
// for the new total. A changed total starts a new alert episode, as a typed
// change does. `categories` = every category after the change.
function autoTotalFields(b, categories) {
  const previous = Number.isSafeInteger(b.total) ? b.total : null;
  const total = totalFromCategories(categories);
  if (previous === total && b.totalFrom === "categories") return {};
  const episode = (int(b.alerts?.episode) || 1) + 1;
  return { total, alerts: { episode, notified: thresholdLevel(int(b.spent), total) }, totalFrom: "categories" };
}
const categoriesOf = async (tx, tenant) => (await tx.get(tenant.collection("expenseCategories"))).docs.map((d) => ({ id: d.id, ...d.data() }));

// ---------- Budget ----------

// Edit -> Save of the total budget. Not spending: Spent never changes here.
// Starts a new alert episode (levels already reached don't alert again).
export async function setBudgetTotal({ db, tenant, FieldValue, total, expectedRevision = null, actor, workspace = null }) {
  if (autoTotal(workspace)) throw new BabyError("budget-total-automatic", "The total budget is the sum of your category budgets. Change a category's budget instead");
  const value = validateBudgetTotal(total);
  return db.runTransaction(async (tx) => {
    const b = await loadBudget(tx, tenant);
    checkRevision(expectedRevision, int(b.revision));
    const previous = Number.isSafeInteger(b.total) ? b.total : null;
    if (previous === value) return { unchanged: true, revision: int(b.revision) };
    const episode = (int(b.alerts?.episode) || 1) + 1;
    const label = previous === null ? `Budget set ${peso(value)}` : value === null ? `Budget cleared (was ${peso(previous)})` : `Budget changed ${peso(previous)} → ${peso(value)}`;
    tx.set(
      budgetRef(tenant),
      {
        schemaVersion: BABY_SCHEMA_VERSION,
        total: value,
        alerts: { episode, notified: thresholdLevel(int(b.spent), value) },
        history: appendBudget(b.history, entry(actor, label, { field: "total", from: previous, to: value })),
        revision: int(b.revision) + 1,
        updatedBy: who(actor),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { total: value, revision: int(b.revision) + 1 };
  }, TX_OPTIONS);
}

// ---------- Categories (the budget lines) ----------

const categoriesRef = (tenant) => tenant.collection("expenseCategories");

async function nameTaken(tx, tenant, name, exceptId = null) {
  const snap = await tx.get(categoriesRef(tenant).where("nameLower", "==", lower(name)).limit(2));
  return snap.docs.some((d) => d.id !== exceptId);
}

function newCategory(FieldValue, actor, { name, budget = null, order }) {
  const stamp = FieldValue.serverTimestamp();
  return {
    schemaVersion: BABY_SCHEMA_VERSION,
    name,
    nameLower: lower(name),
    status: "active",
    budget,
    order,
    useCount: 0,
    history: [entry(actor, budget === null ? `Added category ${name}` : `Added category ${name} (budget ${peso(budget)})`)],
    revision: 1,
    createdBy: who(actor),
    createdAt: stamp,
    updatedBy: who(actor),
    updatedAt: stamp,
  };
}

// "Add suggested categories" on an empty budget: once. The list follows the
// workspace (the budget primitive is shared by Baby and, Phase 16, Wedding).
export async function setupSuggestedCategories({ db, tenant, FieldValue, actor, workspace = "baby-expense" }) {
  const suggested = workspace === "bridal-expense" ? SUGGESTED_WEDDING_CATEGORIES : SUGGESTED_CATEGORIES;
  return db.runTransaction(async (tx) => {
    const b = await loadBudget(tx, tenant);
    const existing = await tx.get(categoriesRef(tenant).limit(1));
    if (b.categoriesSeeded === true || !existing.empty) return { created: 0 };
    const ids = suggested.map((name, i) => {
      const r = categoriesRef(tenant).doc();
      tx.create(r, newCategory(FieldValue, actor, { name, order: (i + 1) * 10 }));
      return r.id;
    });
    tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, categoryCount: FieldValue.increment(ids.length), categoriesSeeded: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { created: ids.length, categoryIds: ids };
  }, TX_OPTIONS);
}

export async function createCategory({ db, tenant, FieldValue, input, actor, workspace = null }) {
  const data = validateCategoryInput(input);
  return db.runTransaction(async (tx) => {
    const b = await loadBudget(tx, tenant);
    if (int(b.categoryCount) >= MAX_CATEGORIES) throw new BabyError("too-many-categories", `A budget can have at most ${MAX_CATEGORIES} categories`);
    if (await nameTaken(tx, tenant, data.name)) throw new BabyError("duplicate-category", "A category with that name already exists");
    const existing = autoTotal(workspace) ? await categoriesOf(tx, tenant) : null;
    const r = categoriesRef(tenant).doc();
    const order = data.order ?? (int(b.categoryCount) + 1) * 10;
    tx.create(r, newCategory(FieldValue, actor, { name: data.name, budget: data.budget ?? null, order }));
    tx.set(
      budgetRef(tenant),
      {
        schemaVersion: BABY_SCHEMA_VERSION,
        categoryCount: FieldValue.increment(1),
        ...(existing ? autoTotalFields(b, [...existing, { id: r.id, budget: data.budget ?? null }]) : {}),
        ...(data.budget !== null && data.budget !== undefined ? { history: appendBudget(b.history, entry(actor, `${data.name} budget set ${peso(data.budget)}`, { field: "category", categoryId: r.id, from: null, to: data.budget })) } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { categoryId: r.id };
  }, TX_OPTIONS);
}

// Edit -> Save: name, budget allocation, position.
export async function updateCategory({ db, tenant, FieldValue, categoryId, changes, expectedRevision = null, actor, workspace = null }) {
  const data = validateCategoryInput(changes, { partial: true });
  const cRef = ref(tenant, "expenseCategories", categoryId, "category");
  return db.runTransaction(async (tx) => {
    const b = await loadBudget(tx, tenant);
    const snap = await tx.get(cRef);
    if (!snap.exists) throw new BabyError("not-found", "Category not found");
    const c = snap.data();
    checkRevision(expectedRevision, c.revision);
    const diff = Object.fromEntries(Object.entries(data).filter(([k, v]) => (c[k] ?? null) !== (v ?? null)));
    if (!Object.keys(diff).length) return { categoryId, unchanged: true, revision: c.revision };
    if ("name" in diff && (await nameTaken(tx, tenant, diff.name, categoryId))) throw new BabyError("duplicate-category", "A category with that name already exists");
    const all = "budget" in diff && autoTotal(workspace) ? await categoriesOf(tx, tenant) : null;
    const labels = [];
    if ("name" in diff) labels.push(`Renamed ${c.name} → ${diff.name}`);
    if ("budget" in diff) labels.push(`Budget changed ${peso(c.budget ?? null)} → ${peso(diff.budget)}`);
    if ("order" in diff) labels.push("Position changed");
    const stamp = FieldValue.serverTimestamp();
    tx.update(cRef, { ...diff, ...("name" in diff ? { nameLower: lower(diff.name) } : {}), history: append(c.history, entry(actor, labels.join(" · "))), revision: c.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    if ("budget" in diff) {
      const name = diff.name ?? c.name;
      const totals = all ? autoTotalFields(b, all.map((x) => (x.id === categoryId ? { ...x, budget: diff.budget } : x))) : {};
      const totalNote = "total" in totals ? ` · total budget now ${peso(totals.total)}` : "";
      tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, ...totals, history: appendBudget(b.history, entry(actor, `${name} budget changed ${peso(c.budget ?? null)} → ${peso(diff.budget)}${totalNote}`, { field: "category", categoryId, from: c.budget ?? null, to: diff.budget })), updatedAt: stamp }, { merge: true });
    }
    return { categoryId, revision: c.revision + 1 };
  }, TX_OPTIONS);
}

// Deactivate (kept for its expenses' history; no new expenses or
// scheduled payments can use it) / reactivate.
export async function setCategoryStatus({ db, tenant, FieldValue, categoryId, status, actor }) {
  if (!Object.hasOwn(CATEGORY_STATUSES, status)) throw new BabyError("invalid-input", "Invalid status");
  const cRef = ref(tenant, "expenseCategories", categoryId, "category");
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    const snap = await tx.get(cRef);
    if (!snap.exists) throw new BabyError("not-found", "Category not found");
    const c = snap.data();
    if (c.status === status) return { categoryId, unchanged: true };
    const stamp = FieldValue.serverTimestamp();
    tx.update(cRef, { status, history: append(c.history, entry(actor, status === "active" ? "Reactivated" : "Deactivated")), revision: c.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, updatedAt: stamp }, { merge: true });
    return { categoryId, status };
  }, TX_OPTIONS);
}

// Only a category nothing ever used (created by mistake); otherwise
// deactivate it, so no expense or payment is orphaned.
export async function deleteCategory({ db, tenant, FieldValue, categoryId, actor, workspace = null }) {
  const cRef = ref(tenant, "expenseCategories", categoryId, "category");
  return db.runTransaction(async (tx) => {
    const b = await loadBudget(tx, tenant);
    const snap = await tx.get(cRef);
    if (!snap.exists) throw new BabyError("not-found", "Category not found");
    const c = snap.data();
    if (int(c.useCount) > 0) throw new BabyError("category-in-use", "This category has expenses or payments, so it can't be deleted. Hide it instead");
    const rest = autoTotal(workspace) ? (await categoriesOf(tx, tenant)).filter((x) => x.id !== categoryId) : null;
    tx.delete(cRef);
    tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, categoryCount: FieldValue.increment(-1), ...(rest ? autoTotalFields(b, rest) : {}), history: appendBudget(b.history, entry(actor, `Removed unused category ${c.name}`)), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { categoryId, deleted: true };
  }, TX_OPTIONS);
}

// ---------- Providers / vendors ----------

const providerLabels = (before, after) =>
  Object.keys(after)
    .map((k) => (k === "notes" ? "Notes updated" : k === "type" ? `Type changed ${PROVIDER_TYPES[before.type]?.label ?? "—"} → ${PROVIDER_TYPES[after.type]?.label ?? "—"}` : `${{ name: "Name", phone: "Phone", email: "Email", location: "Address" }[k]} changed ${before[k] || "—"} → ${after[k] || "—"}`))
    .join(" · ");

export async function createProvider({ db, tenant, FieldValue, input, actor }) {
  const data = validateProviderInput(input);
  const r = tenant.collection("providers").doc();
  const stamp = FieldValue.serverTimestamp();
  await r.create({
    schemaVersion: BABY_SCHEMA_VERSION,
    name: data.name,
    nameLower: lower(data.name),
    type: data.type,
    phone: data.phone ?? null,
    email: data.email ?? null,
    location: data.location ?? null,
    notes: data.notes ?? null,
    status: "active",
    history: [entry(actor, `Added ${data.name}`)],
    revision: 1,
    createdBy: who(actor),
    createdAt: stamp,
    updatedBy: who(actor),
    updatedAt: stamp,
  });
  return { providerId: r.id };
}

// Past expenses and payments keep the name they were recorded with.
export async function updateProvider({ db, tenant, FieldValue, providerId, changes, expectedRevision = null, actor }) {
  const data = validateProviderInput(changes, { partial: true });
  const pRef = ref(tenant, "providers", providerId, "provider");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(pRef);
    if (!snap.exists) throw new BabyError("not-found", "Provider not found");
    const p = snap.data();
    checkRevision(expectedRevision, p.revision);
    const diff = Object.fromEntries(Object.entries(data).filter(([k, v]) => (p[k] ?? null) !== (v ?? null)));
    if (!Object.keys(diff).length) return { providerId, unchanged: true, revision: p.revision };
    tx.update(pRef, { ...diff, ...("name" in diff ? { nameLower: lower(diff.name) } : {}), history: append(p.history, entry(actor, providerLabels(p, diff))), revision: p.revision + 1, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { providerId, revision: p.revision + 1 };
  }, TX_OPTIONS);
}

export async function setProviderStatus({ db, tenant, FieldValue, providerId, status, actor }) {
  if (!Object.hasOwn(PROVIDER_STATUSES, status)) throw new BabyError("invalid-input", "Invalid status");
  const pRef = ref(tenant, "providers", providerId, "provider");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(pRef);
    if (!snap.exists) throw new BabyError("not-found", "Provider not found");
    const p = snap.data();
    if (p.status === status) return { providerId, unchanged: true };
    tx.update(pRef, { status, history: append(p.history, entry(actor, status === "active" ? "Reactivated" : "Deactivated")), revision: p.revision + 1, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { providerId, status };
  }, TX_OPTIONS);
}

// Phase 18.5 · ⋯ More -> Delete provider: only a provider no expense or
// scheduled payment ever used (added by mistake); anyone with history is
// deactivated instead. A snapshot goes to the audit log.
export async function deleteProvider({ db, tenant, FieldValue, providerId, actor }) {
  const pRef = ref(tenant, "providers", providerId, "provider");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(pRef);
    if (!snap.exists) throw new BabyError("not-found", "Provider not found");
    const [exps, sched] = await Promise.all([
      tx.get(tenant.collection("expenses").where("providerId", "==", providerId).limit(1)),
      tx.get(tenant.collection("scheduledPayments").where("providerId", "==", providerId).limit(1)),
    ]);
    if (!exps.empty || !sched.empty) throw new BabyError("provider-in-use", "This provider has expenses or scheduled payments. Deactivate it instead");
    const p = snap.data();
    const stamp = FieldValue.serverTimestamp();
    tx.delete(pRef);
    tx.set(tenant.collection("auditLog").doc(), { type: "provider.deleted", providerId, snapshot: { name: p.name, type: p.type ?? null, phone: p.phone ?? null, email: p.email ?? null, notes: p.notes ?? null, status: p.status, history: p.history ?? [] }, actor: who(actor), at: stamp });
    return { providerId, deleted: true };
  }, TX_OPTIONS);
}

// ---------- Payment schedule ----------

const scheduleRef = (tenant, id) => ref(tenant, "scheduledPayments", id, "payment");
// The expense a payment's n-th "Mark paid" records (n = reopen count).
export const expenseIdForPayment = (scheduleId, attempt = 0) => (attempt > 0 ? `${scheduleId}r${attempt}` : scheduleId);

// Reads the category a payment moves into (must be active) and the provider
// it's newly linked to (must be active).
async function resolveLinks(tx, tenant, { category, providerId }, current = null) {
  const into = category && (!current || category !== current.category) ? tenant.doc("expenseCategories", category) : null;
  const prov = providerId && (!current || providerId !== current.providerId) ? tenant.doc("providers", providerId) : null;
  const [c, p] = await Promise.all([into && tx.get(into), prov && tx.get(prov)]);
  if (into && (!c.exists || c.data().status !== "active")) throw new BabyError("invalid-category", "Choose an active category");
  if (prov && (!p.exists || p.data().status !== "active")) throw new BabyError("invalid-provider", "Choose an active provider");
  return { catRef: into, categoryName: c ? c.data().name : undefined, providerName: p ? p.data().name : undefined };
}

const upcomingWrite = (FieldValue, parts) => {
  const by = {};
  let amount = 0;
  let count = 0;
  for (const [cat, amt, n] of parts) {
    amount += amt;
    count += n;
    if (cat && amt) by[cat] = (by[cat] || 0) + amt;
  }
  return { upcoming: FieldValue.increment(amount), upcomingCount: FieldValue.increment(count), upcomingByCategory: Object.fromEntries(Object.entries(by).filter(([, v]) => v).map(([k, v]) => [k, FieldValue.increment(v)])) };
};

export async function createScheduledPayment({ db, tenant, FieldValue, input, actor }) {
  const data = validateScheduleInput(input);
  for (const k of ["description", "category", "amount", "dueDate"]) if (data[k] === undefined) throw new BabyError("invalid-input", `${k} is required`);
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    const links = await resolveLinks(tx, tenant, data);
    const r = tenant.collection("scheduledPayments").doc();
    const payee = data.providerId ? links.providerName : data.payee ?? null;
    const stamp = FieldValue.serverTimestamp();
    tx.create(r, {
      schemaVersion: BABY_SCHEMA_VERSION,
      description: data.description,
      category: data.category,
      categoryName: links.categoryName,
      providerId: data.providerId ?? null,
      payee,
      amount: data.amount,
      dueDate: data.dueDate,
      status: "upcoming",
      notes: data.notes ?? null,
      expenseId: null,
      paidDate: null,
      paidAmount: null,
      method: null,
      reference: null,
      attempt: 0,
      history: [entry(actor, `Scheduled ${data.description} ${peso(data.amount)} due ${data.dueDate}`)],
      revision: 1,
      createdBy: who(actor),
      createdAt: stamp,
      updatedBy: who(actor),
      updatedAt: stamp,
    });
    tx.update(links.catRef, { useCount: FieldValue.increment(1) });
    tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, ...upcomingWrite(FieldValue, [[data.category, data.amount, 1]]), updatedAt: stamp }, { merge: true });
    return { scheduleId: r.id };
  }, TX_OPTIONS);
}

// Edit -> Save while Upcoming. Upcoming totals follow amount / category.
export async function updateScheduledPayment({ db, tenant, FieldValue, scheduleId, changes, expectedRevision = null, actor }) {
  const data = validateScheduleInput(changes, { partial: true });
  const sRef = scheduleRef(tenant, scheduleId);
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    const snap = await tx.get(sRef);
    if (!snap.exists) throw new BabyError("not-found", "Scheduled payment not found");
    const s = snap.data();
    if (s.status !== "upcoming") throw new BabyError("not-upcoming", "Only an Upcoming payment can be edited");
    checkRevision(expectedRevision, s.revision);
    const diff = Object.fromEntries(Object.entries(data).filter(([k, v]) => (s[k] ?? null) !== (v ?? null)));
    if (!Object.keys(diff).length) return { scheduleId, unchanged: true, revision: s.revision };
    const next = { ...s, ...diff };
    if ("amount" in diff && diff.amount < int(s.paidAmount)) throw new BabyError("invalid-amount", `${peso(int(s.paidAmount))} is already paid: the amount can't be less than that`);
    if ("payee" in diff && next.providerId && !("providerId" in diff)) throw new BabyError("invalid-input", "This payment is linked to a saved provider: change the provider instead of the payee");
    const links = await resolveLinks(tx, tenant, next, s);
    const update = { ...diff };
    if (links.categoryName !== undefined) update.categoryName = links.categoryName;
    if ("providerId" in diff && next.providerId) update.payee = links.providerName;
    const labels = Object.keys(update)
      .filter((k) => k !== "categoryName" && k !== "providerId")
      .map((k) => (k === "notes" ? "Notes updated" : `${{ description: "Description", category: "Category", payee: "Payee", amount: "Amount", dueDate: "Due date" }[k]} changed ${k === "amount" ? peso(s.amount) : k === "category" ? s.categoryName : s[k] || "—"} → ${k === "amount" ? peso(update.amount) : k === "category" ? update.categoryName : update[k] || "—"}`));
    const stamp = FieldValue.serverTimestamp();
    tx.update(sRef, { ...update, history: append(s.history, entry(actor, labels.join(" · ") || "Updated")), revision: s.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    if (links.catRef) tx.update(links.catRef, { useCount: FieldValue.increment(1) });
    // Upcoming follows the UNPAID part (Phase 18.6: payments can be part-paid).
    if ("amount" in diff || "category" in diff) tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, ...upcomingWrite(FieldValue, [[s.category, -upcomingPart(s), 0], [next.category, upcomingPart(next), 0]]), updatedAt: stamp }, { merge: true });
    return { scheduleId, revision: s.revision + 1 };
  }, TX_OPTIONS);
}

export async function cancelScheduledPayment({ db, tenant, FieldValue, scheduleId, reason = null, actor }) {
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (why.length > 300) throw new BabyError("invalid-input", "The reason is too long (max 300)");
  const sRef = scheduleRef(tenant, scheduleId);
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    const snap = await tx.get(sRef);
    if (!snap.exists) throw new BabyError("not-found", "Scheduled payment not found");
    const s = snap.data();
    if (s.status === "cancelled") return { scheduleId, unchanged: true };
    if (s.status !== "upcoming") throw new BabyError("not-upcoming", "A paid payment can't be cancelled: remove its expense instead");
    const stamp = FieldValue.serverTimestamp();
    // Parts already paid stay as expenses; only the unpaid part leaves Upcoming.
    const paid = int(s.paidAmount);
    const what = paid ? `Cancelled the unpaid ${peso(upcomingPart(s))} (${peso(paid)} already paid stays as spent)` : "Cancelled";
    tx.update(sRef, { status: "cancelled", cancelReason: why || null, history: append(s.history, entry(actor, why ? `${what} · Reason: ${why}` : what)), revision: s.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, ...upcomingWrite(FieldValue, [[s.category, -upcomingPart(s), -1]]), updatedAt: stamp }, { merge: true });
    return { scheduleId, status: "cancelled" };
  }, TX_OPTIONS);
}

// Mark Paid -> Baby Expense(s), exactly once each (see the header).
// payment: { paidDate? (default today; never in the future), method,
//   reference?, amount? (default: what's still unpaid), paidBy? (who paid,
//   shares adding up to the amount), final? (default true: this finishes
//   the payment even if the bill came out different; false = a part
//   payment, the rest stays Upcoming), key? (8-16 letters/digits from the
//   browser, one per "Pay" dialog: a retry of the same part is recognised) }
// Phase 18.6: a payment can be paid in parts. Each part is ONE expense
// listed in the payment's `parts`; Upcoming keeps only the unpaid part.
const PAY_FIELDS = ["paidDate", "method", "reference", "amount", "paidBy", "final", "key"];
const PART_KEY = /^[A-Za-z0-9]{8,16}$/;
// The expense id of a part: deterministic, so a retry can't record twice.
//   no key, first payment  -> the payment id (or "<id>r<n>" after a reopen),
//                             exactly as before Phase 18.6
//   with a key             -> "<id>k<key>"
export const partExpenseId = (scheduleId, attempt, key = null) => (key ? `${scheduleId}k${key}` : expenseIdForPayment(scheduleId, attempt));

export async function markScheduledPaymentPaid(args) {
  try {
    return await markPaidOnce(args);
  } catch (err) {
    // Belt and braces: the deterministic expense id already exists, so a
    // concurrent request (or a retry) recorded it first. Answer with it.
    if (err && (err.code === 6 || err.code === "already-exists")) {
      const s = (await scheduleRef(args.tenant, args.scheduleId).get()).data();
      const key = args.payment?.key;
      const id = s ? partExpenseId(args.scheduleId, int(s.attempt), PART_KEY.test(key ?? "") ? key : null) : null;
      if (s && (s.status === "paid" || partsOf(s).some((p) => p.expenseId === id))) return { scheduleId: args.scheduleId, expenseId: id ?? s.expenseId, alreadyPaid: true };
    }
    throw err;
  }
}

async function markPaidOnce({ db, tenant, FieldValue, business, workspace, scheduleId, payment, actor, now = new Date() }) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new BabyError("invalid-input", "Invalid payment");
  for (const k of Object.keys(payment)) if (!PAY_FIELDS.includes(k)) throw new BabyError("invalid-input", `Field ${k} can't be set here`);
  const paidDate = payment.paidDate ?? businessDate(business.timezone, now);
  if (!isDayId(paidDate)) throw new BabyError("invalid-input", "Choose a valid paid date");
  if (!Object.hasOwn(EXPENSE_METHODS, payment.method)) throw new BabyError("invalid-input", "Choose a payment method");
  if (payment.final !== undefined && typeof payment.final !== "boolean") throw new BabyError("invalid-input", "Invalid payment");
  if (payment.key !== undefined && !PART_KEY.test(payment.key)) throw new BabyError("invalid-input", "Invalid payment");
  const paidByInput = validatePaidBy(payment.paidBy, null);
  const sRef = scheduleRef(tenant, scheduleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(sRef);
    if (!snap.exists) throw new BabyError("not-found", "Scheduled payment not found");
    const s = snap.data();
    const parts = partsOf(s);
    const expenseId = partExpenseId(scheduleId, int(s.attempt), payment.key ?? null);
    // Idempotent: a retry / second click of the SAME payment gets the same
    // expense. A payment already Paid in full stays Paid.
    if (parts.some((p) => p.expenseId === expenseId)) return { scheduleId, expenseId, alreadyPaid: true };
    if (s.status === "paid") return { scheduleId, expenseId: s.expenseId, alreadyPaid: true };
    if (s.status !== "upcoming") throw new BabyError("not-upcoming", "A cancelled payment can't be marked paid");
    // Without a key only one payment can be recorded this way (the original
    // single "Mark paid"); part payments need a key per part.
    if (!payment.key && parts.length) throw new BabyError("invalid-input", "Reload and try again");
    const unpaid = upcomingPart(s);
    const amount = payment.amount ?? unpaid;
    // Paying all of what's left finishes it; less is a part payment unless
    // the browser says it's final (the bill came out lower).
    const final = payment.final === false ? amount >= unpaid : true;
    if (!final && !payment.key) throw new BabyError("invalid-input", "Invalid payment");
    const paidBy = paidByInput ?? null;
    const plan = await prepareExpenseCreate(tx, {
      tenant,
      business,
      workspace,
      actor,
      now,
      expenseId,
      link: { scheduleId, label: final ? `Paid scheduled payment ${s.description} ${peso(amount)}` : `Part payment for ${s.description} ${peso(amount)}` },
      // Leaves Upcoming in the same budgets/current write as the spending:
      // all of the unpaid part when final, otherwise the part just paid.
      upcomingDelta: final ? { amount: -unpaid, count: -1, category: s.category } : { amount: -Math.min(amount, unpaid), count: 0, category: s.category },
      input: {
        date: paidDate,
        category: s.category,
        amount,
        method: payment.method,
        ...(s.providerId ? { providerId: s.providerId, ...(s.payee ? { payee: s.payee } : {}) } : { providerId: null, ...(s.payee ? { payee: s.payee } : {}) }),
        ...(payment.reference ? { reference: payment.reference } : {}),
        ...(paidBy ? { paidBy: paidBy.map(({ name, amount: a }) => ({ name, amount: a })) } : {}),
        notes: `Scheduled payment: ${s.description}`,
      },
    });
    plan.commit({ FieldValue });
    if (final) meterActivity(tx, { tenant, FieldValue, timezone: business.timezone, now, counts: { scheduledPaymentsPaid: 1 } });
    const nextParts = [...parts, { expenseId, amount, date: paidDate, method: payment.method }];
    const paidAmount = nextParts.reduce((t, p) => t + int(p.amount), 0);
    tx.update(sRef, {
      parts: nextParts,
      paidAmount,
      ...(final ? { status: "paid", expenseId, paidDate, method: payment.method, reference: plan.record.reference ?? null } : {}),
      history: append(
        s.history,
        entry(actor, final ? `Marked paid ${peso(amount)} on ${paidDate} (${EXPENSE_METHODS[payment.method].label})${parts.length ? ` · ${peso(paidAmount)} paid in ${nextParts.length} parts` : ""}` : `Part payment ${peso(amount)} on ${paidDate} (${EXPENSE_METHODS[payment.method].label}) · ${peso(Math.max(0, s.amount - paidAmount))} still to pay`)
      ),
      revision: s.revision + 1,
      updatedBy: who(actor),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { scheduleId, expenseId, paid: final, partPaid: !final, paidAmount, remaining: final ? 0 : Math.max(0, s.amount - paidAmount) };
  }, TX_OPTIONS);
}

// ---------- Phase 18.6 migration: Total budget = sum of category budgets ----------

// One Baby business: sets budgets/current.total to the sum of its category
// budgets (the rule from Phase 18.6 on) and records the change on the
// budget history. Spending is untouched. Idempotent: a business already on
// the category total is left alone. dryRun reports without writing.
export async function adoptCategoryTotal({ db, tenant, FieldValue, actor = { uid: "migration", name: "Luna (Phase 18.6 update)" }, dryRun = true }) {
  return db.runTransaction(async (tx) => {
    const b = await loadBudget(tx, tenant);
    const categories = await categoriesOf(tx, tenant);
    const fields = autoTotalFields(b, categories);
    const previous = Number.isSafeInteger(b.total) ? b.total : null;
    if (!Object.keys(fields).length) return { changed: false, total: previous };
    if (!dryRun) {
      const label = previous === fields.total ? `Total budget now follows the category budgets (${peso(fields.total)})` : `Total budget is now the sum of the category budgets: ${peso(previous)} → ${peso(fields.total)}`;
      tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, ...fields, history: appendBudget(b.history, entry(actor, label, { field: "total", from: previous, to: fields.total })), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return { changed: true, from: previous, to: fields.total, categories: categories.length, dryRun };
  }, TX_OPTIONS);
}
