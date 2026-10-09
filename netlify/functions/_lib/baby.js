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

import { BabyError, BABY_SCHEMA_VERSION, BUDGET_DOC_ID, MAX_CATEGORIES, SUGGESTED_CATEGORIES, CATEGORY_STATUSES, PROVIDER_STATUSES, PROVIDER_TYPES, isValidRecordId, validateCategoryInput, validateBudgetTotal, validateProviderInput, validateScheduleInput, thresholdLevel } from "../../../shared/baby.js";
import { EXPENSE_METHODS } from "../../../shared/expenses.js";
import { businessDate, isDayId } from "../../../shared/metrics.js";
import { prepareExpenseCreate } from "./expenses.js";
import { SUGGESTED_WEDDING_CATEGORIES } from "../../../shared/wedding.js";

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

// ---------- Budget ----------

// Edit -> Save of the total budget. Not spending: Spent never changes here.
// Starts a new alert episode (levels already reached don't alert again).
export async function setBudgetTotal({ db, tenant, FieldValue, total, expectedRevision = null, actor }) {
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

export async function createCategory({ db, tenant, FieldValue, input, actor }) {
  const data = validateCategoryInput(input);
  return db.runTransaction(async (tx) => {
    const b = await loadBudget(tx, tenant);
    if (int(b.categoryCount) >= MAX_CATEGORIES) throw new BabyError("too-many-categories", `A budget can have at most ${MAX_CATEGORIES} categories`);
    if (await nameTaken(tx, tenant, data.name)) throw new BabyError("duplicate-category", "A category with that name already exists");
    const r = categoriesRef(tenant).doc();
    const order = data.order ?? (int(b.categoryCount) + 1) * 10;
    tx.create(r, newCategory(FieldValue, actor, { name: data.name, budget: data.budget ?? null, order }));
    tx.set(
      budgetRef(tenant),
      {
        schemaVersion: BABY_SCHEMA_VERSION,
        categoryCount: FieldValue.increment(1),
        ...(data.budget !== null && data.budget !== undefined ? { history: appendBudget(b.history, entry(actor, `${data.name} budget set ${peso(data.budget)}`, { field: "category", categoryId: r.id, from: null, to: data.budget })) } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { categoryId: r.id };
  }, TX_OPTIONS);
}

// Edit -> Save: name, budget allocation, position.
export async function updateCategory({ db, tenant, FieldValue, categoryId, changes, expectedRevision = null, actor }) {
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
    const labels = [];
    if ("name" in diff) labels.push(`Renamed ${c.name} → ${diff.name}`);
    if ("budget" in diff) labels.push(`Budget changed ${peso(c.budget ?? null)} → ${peso(diff.budget)}`);
    if ("order" in diff) labels.push("Position changed");
    const stamp = FieldValue.serverTimestamp();
    tx.update(cRef, { ...diff, ...("name" in diff ? { nameLower: lower(diff.name) } : {}), history: append(c.history, entry(actor, labels.join(" · "))), revision: c.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    if ("budget" in diff) {
      const name = diff.name ?? c.name;
      tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, history: appendBudget(b.history, entry(actor, `${name} budget changed ${peso(c.budget ?? null)} → ${peso(diff.budget)}`, { field: "category", categoryId, from: c.budget ?? null, to: diff.budget })), updatedAt: stamp }, { merge: true });
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
export async function deleteCategory({ db, tenant, FieldValue, categoryId, actor }) {
  const cRef = ref(tenant, "expenseCategories", categoryId, "category");
  return db.runTransaction(async (tx) => {
    const b = await loadBudget(tx, tenant);
    const snap = await tx.get(cRef);
    if (!snap.exists) throw new BabyError("not-found", "Category not found");
    const c = snap.data();
    if (int(c.useCount) > 0) throw new BabyError("category-in-use", "This category is used by expenses or scheduled payments. Deactivate it instead");
    tx.delete(cRef);
    tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, categoryCount: FieldValue.increment(-1), history: appendBudget(b.history, entry(actor, `Removed unused category ${c.name}`)), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
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
    if ("amount" in diff || "category" in diff) tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, ...upcomingWrite(FieldValue, [[s.category, -s.amount, 0], [next.category, next.amount, 0]]), updatedAt: stamp }, { merge: true });
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
    tx.update(sRef, { status: "cancelled", cancelReason: why || null, history: append(s.history, entry(actor, why ? `Cancelled · Reason: ${why}` : "Cancelled")), revision: s.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    tx.set(budgetRef(tenant), { schemaVersion: BABY_SCHEMA_VERSION, ...upcomingWrite(FieldValue, [[s.category, -s.amount, -1]]), updatedAt: stamp }, { merge: true });
    return { scheduleId, status: "cancelled" };
  }, TX_OPTIONS);
}

// Mark Paid -> exactly one Baby Expense (see the header). payment:
// { paidDate? (default today; never in the future), method, reference?,
//   amount? (default the scheduled amount: the actual bill may differ) }
const PAY_FIELDS = ["paidDate", "method", "reference", "amount"];
export async function markScheduledPaymentPaid(args) {
  try {
    return await markPaidOnce(args);
  } catch (err) {
    // Belt and braces: the deterministic expense id already exists, so a
    // concurrent request paid it first. Answer with that payment's expense.
    if (err && (err.code === 6 || err.code === "already-exists")) {
      const s = (await scheduleRef(args.tenant, args.scheduleId).get()).data();
      if (s && s.status === "paid") return { scheduleId: args.scheduleId, expenseId: s.expenseId, alreadyPaid: true };
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
  const sRef = scheduleRef(tenant, scheduleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(sRef);
    if (!snap.exists) throw new BabyError("not-found", "Scheduled payment not found");
    const s = snap.data();
    // Idempotent: a retry / second click finds it Paid and gets the same expense.
    if (s.status === "paid") return { scheduleId, expenseId: s.expenseId, alreadyPaid: true };
    if (s.status !== "upcoming") throw new BabyError("not-upcoming", "A cancelled payment can't be marked paid");
    const amount = payment.amount ?? s.amount;
    const expenseId = expenseIdForPayment(scheduleId, int(s.attempt));
    const plan = await prepareExpenseCreate(tx, {
      tenant,
      business,
      workspace,
      actor,
      now,
      expenseId,
      link: { scheduleId, label: `Paid scheduled payment ${s.description} ${peso(amount)}` },
      // Leaves Upcoming in the same budgets/current write as the spending.
      upcomingDelta: { amount: -s.amount, count: -1, category: s.category },
      input: {
        date: paidDate,
        category: s.category,
        amount,
        method: payment.method,
        ...(s.providerId ? { providerId: s.providerId } : { providerId: null, ...(s.payee ? { payee: s.payee } : {}) }),
        ...(payment.reference ? { reference: payment.reference } : {}),
        notes: `Scheduled payment: ${s.description}`,
      },
    });
    plan.commit({ FieldValue });
    tx.update(sRef, {
      status: "paid",
      expenseId,
      paidDate,
      paidAmount: amount,
      method: payment.method,
      reference: plan.record.reference ?? null,
      history: append(s.history, entry(actor, `Marked paid ${peso(amount)} on ${paidDate} (${EXPENSE_METHODS[payment.method].label})`)),
      revision: s.revision + 1,
      updatedBy: who(actor),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { scheduleId, expenseId, paid: true };
  }, TX_OPTIONS);
}
