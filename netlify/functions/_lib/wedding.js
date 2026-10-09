// Bridal / Wedding Command Center (Phase 16), server side: Wedding
// Suppliers, Supplier Payments, Wedding Tasks and Guests & RSVP. Wedding
// Expenses are the Expenses Core (./expenses.js) with the wedding sink
// (./wedding-spending.js); the Wedding Budget is the generic budget
// primitive (./baby.js setBudgetTotal / categories). Every write is ONE
// Firestore transaction, all reads first.
//
// Serialization: supplier and supplier-payment writes read and write
// budgets/current and the supplier (as every Wedding Expense does); task
// writes read taskTotals/current; guest writes read guestTotals/current.
// So totals never drift under concurrent edits.
//
// Supplier Payment -> Wedding Expense, exactly once: Mark paid reads the
// payment; if it's already Paid the call returns the existing expense. The
// expense gets a DETERMINISTIC id (the payment id, or "<id>r<n>" after a
// reopen) and is created with create(), so a retry or a concurrent second
// request can't make a second expense. The payment leaves Upcoming and the
// expense counts as spent (and as paid to the supplier) in the same
// transaction.
//
// Agreed amounts: paid + scheduled never exceed a supplier's agreed amount
// (scheduling beyond it, or lowering it below what's committed, is refused);
// the wedding sink applies the same cap to the expenses themselves.

import { BUDGET_DOC_ID, isValidRecordId } from "../../../shared/baby.js";
import { WeddingError, WEDDING_SCHEMA_VERSION, TOTALS_DOC_ID, SUPPLIER_SERVICES, SUPPLIER_STATUSES, TASK_STATUSES, TASK_PRIORITIES, RSVP_STATUSES, GUEST_SIDES, isOpenStatus, keyOf, validateSupplierInput, validateSupplierPaymentInput, validateTaskInput, validateGuestInput, validateRsvp, taskTotalsDelta, guestDelta, supplierBalance } from "../../../shared/wedding.js";
import { EXPENSE_METHODS } from "../../../shared/expenses.js";
import { businessDate, isDayId } from "../../../shared/metrics.js";
import { prepareExpenseCreate } from "./expenses.js";
import { prepareNotifications } from "./notifications.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_HISTORY = 200;
const lower = (s) => (s || "").toLocaleLowerCase("en");
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const peso = (c) => (c === null || c === undefined ? "—" : `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
const who = (actor) => (actor ? { uid: actor.uid, name: actor.name } : null);
const entry = (actor, label, extra = {}) => ({ at: new Date(), actor: who(actor), label, ...extra });
function append(list, e) {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new WeddingError("history-full", "Too many changes on this record");
  return [...l, e];
}
const checkRevision = (expected, current) => {
  if (expected !== null && expected !== undefined && expected !== current) throw new WeddingError("stale", "This was changed by someone else. Reload and try again");
};
const ref = (tenant, collection, id, what) => {
  if (!isValidRecordId(id)) throw new WeddingError(`invalid-${what}`, `Invalid ${what}`);
  return tenant.doc(collection, id);
};
const budgetRef = (tenant) => tenant.doc("budgets", BUDGET_DOC_ID);
const supplierRef = (tenant, id) => ref(tenant, "weddingSuppliers", id, "supplier");
const paymentRef = (tenant, id) => ref(tenant, "supplierPayments", id, "payment");
const label = (map, k) => map[k]?.label ?? k ?? "—";

async function loadBudget(tx, tenant) {
  const snap = await tx.get(budgetRef(tenant));
  return snap.exists ? snap.data() : {};
}
async function activeCategory(tx, tenant, id, { allowInactive = false } = {}) {
  const snap = await tx.get(ref(tenant, "expenseCategories", id, "category"));
  if (!snap.exists || (snap.data().status !== "active" && !allowInactive)) throw new WeddingError("invalid-category", "Choose an active budget category");
  return snap;
}

// ---------- Suppliers ----------

const SUPPLIER_NAMES = { name: "Name", service: "Service", contactPerson: "Contact person", phone: "Phone", email: "Email", location: "Address", agreedAmount: "Agreed amount", categoryId: "Budget category" };
function supplierLabels(before, diff) {
  return Object.keys(diff)
    .map((k) => {
      if (k === "notes") return "Notes updated";
      if (k === "categoryId") return "Budget category changed";
      const show = (v) => (k === "agreedAmount" ? (v === null || v === undefined ? "no agreement" : peso(v)) : k === "service" ? label(SUPPLIER_SERVICES, v) : v || "—");
      return `${SUPPLIER_NAMES[k]} changed ${show(before[k])} → ${show(diff[k])}`;
    })
    .join(" · ");
}

export async function createSupplier({ db, tenant, FieldValue, input, actor }) {
  const data = validateSupplierInput(input);
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    if (data.categoryId) await activeCategory(tx, tenant, data.categoryId);
    const r = tenant.collection("weddingSuppliers").doc();
    const stamp = FieldValue.serverTimestamp();
    tx.create(r, {
      schemaVersion: WEDDING_SCHEMA_VERSION,
      name: data.name,
      nameLower: lower(data.name),
      service: data.service,
      contactPerson: data.contactPerson ?? null,
      phone: data.phone ?? null,
      email: data.email ?? null,
      location: data.location ?? null,
      agreedAmount: data.agreedAmount ?? null,
      categoryId: data.categoryId ?? null,
      notes: data.notes ?? null,
      status: "active",
      paid: 0,
      upcoming: 0,
      upcomingCount: 0,
      nextDue: null,
      history: [entry(actor, data.agreedAmount === null || data.agreedAmount === undefined ? `Added ${data.name}` : `Added ${data.name} · agreed ${peso(data.agreedAmount)}`)],
      revision: 1,
      createdBy: who(actor),
      createdAt: stamp,
      updatedBy: who(actor),
      updatedAt: stamp,
    });
    if (Number.isSafeInteger(data.agreedAmount)) tx.set(budgetRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, contracted: FieldValue.increment(data.agreedAmount), updatedAt: stamp }, { merge: true });
    return { supplierId: r.id };
  }, TX_OPTIONS);
}

// Edit -> Save. The agreed amount can't go below what's already paid or
// scheduled; past expenses keep the name they were recorded with.
export async function updateSupplier({ db, tenant, FieldValue, supplierId, changes, expectedRevision = null, actor }) {
  const data = validateSupplierInput(changes, { partial: true });
  const sRef = supplierRef(tenant, supplierId);
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    const snap = await tx.get(sRef);
    if (!snap.exists) throw new WeddingError("not-found", "Supplier not found");
    const s = snap.data();
    checkRevision(expectedRevision, s.revision);
    const diff = Object.fromEntries(Object.entries(data).filter(([k, v]) => (s[k] ?? null) !== (v ?? null)));
    if (!Object.keys(diff).length) return { supplierId, unchanged: true, revision: s.revision };
    if (diff.categoryId) await activeCategory(tx, tenant, diff.categoryId);
    const stamp = FieldValue.serverTimestamp();
    if ("agreedAmount" in diff) {
      const committed = int(s.paid) + int(s.upcoming);
      if (diff.agreedAmount !== null && diff.agreedAmount < committed) throw new WeddingError("below-committed", `The agreed amount can't be less than what's already paid or scheduled (${peso(committed)})`);
      const had = Number.isSafeInteger(s.agreedAmount);
      const has = diff.agreedAmount !== null;
      tx.set(
        budgetRef(tenant),
        { schemaVersion: WEDDING_SCHEMA_VERSION, contracted: FieldValue.increment((has ? diff.agreedAmount : 0) - (had ? s.agreedAmount : 0)), contractedPaid: FieldValue.increment((has ? int(s.paid) : 0) - (had ? int(s.paid) : 0)), updatedAt: stamp },
        { merge: true }
      );
    }
    tx.update(sRef, { ...diff, ...("name" in diff ? { nameLower: lower(diff.name) } : {}), history: append(s.history, entry(actor, supplierLabels(s, diff))), revision: s.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    return { supplierId, revision: s.revision + 1 };
  }, TX_OPTIONS);
}

// Deactivate (kept with its payments and balance) / reactivate. A payment
// scheduled before deactivation can still be marked Paid.
export async function setSupplierStatus({ db, tenant, FieldValue, supplierId, status, actor }) {
  if (!Object.hasOwn(SUPPLIER_STATUSES, status)) throw new WeddingError("invalid-input", "Invalid status");
  const sRef = supplierRef(tenant, supplierId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(sRef);
    if (!snap.exists) throw new WeddingError("not-found", "Supplier not found");
    const s = snap.data();
    if (s.status === status) return { supplierId, unchanged: true };
    tx.update(sRef, { status, history: append(s.history, entry(actor, status === "active" ? "Reactivated" : "Deactivated")), revision: s.revision + 1, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { supplierId, status };
  }, TX_OPTIONS);
}

// ---------- Supplier payments ----------

// The supplier's earliest Upcoming due date after a change: drop `without`
// (a payment leaving Upcoming / changing date), add `add` (a due date).
// Reads at most 2 payments (the two soonest), inside the transaction.
async function nextDueAfter(tx, tenant, supplierId, { without = null, add = null } = {}) {
  const snap = await tx.get(tenant.collection("supplierPayments").where("supplierId", "==", supplierId).where("status", "==", "upcoming").orderBy("dueDate", "asc").limit(2));
  const rest = snap.docs.filter((d) => d.id !== without).map((d) => d.data().dueDate);
  const all = [...rest.slice(0, 1), ...(add ? [add] : [])].sort();
  return all[0] ?? null;
}

const capCheck = (s, extra) => {
  if (!Number.isSafeInteger(s.agreedAmount)) return;
  const committed = int(s.paid) + int(s.upcoming) + extra;
  if (committed > s.agreedAmount) throw new WeddingError("over-agreed", `Paid + scheduled for ${s.name} would be ${peso(committed)}, more than the agreed ${peso(s.agreedAmount)}. Update the agreed amount first`);
};

export async function createSupplierPayment({ db, tenant, FieldValue, input, actor }) {
  const data = validateSupplierPaymentInput(input);
  for (const k of ["supplierId", "description", "category", "amount", "dueDate"]) if (data[k] === undefined) throw new WeddingError("invalid-input", `${k} is required`);
  const sRef = supplierRef(tenant, data.supplierId);
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    const sSnap = await tx.get(sRef);
    if (!sSnap.exists || sSnap.data().status !== "active") throw new WeddingError("invalid-supplier", "Choose an active supplier");
    const s = sSnap.data();
    const cat = await activeCategory(tx, tenant, data.category);
    capCheck(s, data.amount);
    const r = tenant.collection("supplierPayments").doc();
    const stamp = FieldValue.serverTimestamp();
    tx.create(r, {
      schemaVersion: WEDDING_SCHEMA_VERSION,
      supplierId: data.supplierId,
      supplierName: s.name,
      description: data.description,
      category: data.category,
      categoryName: cat.data().name,
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
    tx.update(cat.ref, { useCount: FieldValue.increment(1) });
    tx.set(budgetRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, upcoming: FieldValue.increment(data.amount), upcomingCount: FieldValue.increment(1), upcomingByCategory: { [data.category]: FieldValue.increment(data.amount) }, updatedAt: stamp }, { merge: true });
    tx.update(sRef, { upcoming: FieldValue.increment(data.amount), upcomingCount: FieldValue.increment(1), nextDue: s.nextDue && s.nextDue < data.dueDate ? s.nextDue : data.dueDate, updatedAt: stamp });
    return { paymentId: r.id };
  }, TX_OPTIONS);
}

// Edit -> Save while Upcoming (description, category, amount, due date, notes).
export async function updateSupplierPayment({ db, tenant, FieldValue, paymentId, changes, expectedRevision = null, actor }) {
  const data = validateSupplierPaymentInput(changes, { partial: true });
  const pRef = paymentRef(tenant, paymentId);
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    const snap = await tx.get(pRef);
    if (!snap.exists) throw new WeddingError("not-found", "Supplier payment not found");
    const p = snap.data();
    if (p.status !== "upcoming") throw new WeddingError("not-upcoming", "Only an Upcoming payment can be edited");
    checkRevision(expectedRevision, p.revision);
    const diff = Object.fromEntries(Object.entries(data).filter(([k, v]) => (p[k] ?? null) !== (v ?? null)));
    if (!Object.keys(diff).length) return { paymentId, unchanged: true, revision: p.revision };
    const sRef = supplierRef(tenant, p.supplierId);
    const s = (await tx.get(sRef)).data();
    const cat = diff.category ? await activeCategory(tx, tenant, diff.category) : null;
    if ("amount" in diff) capCheck(s, diff.amount - p.amount);
    const nextDue = "dueDate" in diff ? await nextDueAfter(tx, tenant, p.supplierId, { without: paymentId, add: diff.dueDate }) : undefined;
    const update = { ...diff, ...(cat ? { categoryName: cat.data().name } : {}) };
    const names = { description: "Description", category: "Category", amount: "Amount", dueDate: "Due date" };
    const labels = Object.keys(diff).map((k) => (k === "notes" ? "Notes updated" : `${names[k]} changed ${k === "amount" ? peso(p.amount) : k === "category" ? p.categoryName : p[k]} → ${k === "amount" ? peso(diff.amount) : k === "category" ? update.categoryName : diff[k]}`));
    const stamp = FieldValue.serverTimestamp();
    tx.update(pRef, { ...update, history: append(p.history, entry(actor, labels.join(" · "))), revision: p.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    if (cat) tx.update(cat.ref, { useCount: FieldValue.increment(1) });
    const nextAmount = diff.amount ?? p.amount;
    const nextCat = diff.category ?? p.category;
    if ("amount" in diff || "category" in diff) {
      const by = {};
      by[p.category] = (by[p.category] || 0) - p.amount;
      by[nextCat] = (by[nextCat] || 0) + nextAmount;
      tx.set(budgetRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, upcoming: FieldValue.increment(nextAmount - p.amount), upcomingByCategory: Object.fromEntries(Object.entries(by).filter(([, v]) => v).map(([k, v]) => [k, FieldValue.increment(v)])), updatedAt: stamp }, { merge: true });
    }
    if ("amount" in diff || nextDue !== undefined) tx.update(sRef, { ...("amount" in diff ? { upcoming: FieldValue.increment(nextAmount - p.amount) } : {}), ...(nextDue !== undefined ? { nextDue } : {}), updatedAt: stamp });
    return { paymentId, revision: p.revision + 1 };
  }, TX_OPTIONS);
}

export async function cancelSupplierPayment({ db, tenant, FieldValue, paymentId, reason = null, actor }) {
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (why.length > 300) throw new WeddingError("invalid-input", "The reason is too long (max 300)");
  const pRef = paymentRef(tenant, paymentId);
  return db.runTransaction(async (tx) => {
    await loadBudget(tx, tenant);
    const snap = await tx.get(pRef);
    if (!snap.exists) throw new WeddingError("not-found", "Supplier payment not found");
    const p = snap.data();
    if (p.status === "cancelled") return { paymentId, unchanged: true };
    if (p.status !== "upcoming") throw new WeddingError("not-upcoming", "A paid payment can't be cancelled: remove its expense instead");
    const nextDue = await nextDueAfter(tx, tenant, p.supplierId, { without: paymentId });
    const stamp = FieldValue.serverTimestamp();
    tx.update(pRef, { status: "cancelled", cancelReason: why || null, history: append(p.history, entry(actor, why ? `Cancelled · Reason: ${why}` : "Cancelled")), revision: p.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    tx.set(budgetRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, upcoming: FieldValue.increment(-p.amount), upcomingCount: FieldValue.increment(-1), upcomingByCategory: { [p.category]: FieldValue.increment(-p.amount) }, updatedAt: stamp }, { merge: true });
    tx.update(supplierRef(tenant, p.supplierId), { upcoming: FieldValue.increment(-p.amount), upcomingCount: FieldValue.increment(-1), nextDue, updatedAt: stamp });
    return { paymentId, status: "cancelled" };
  }, TX_OPTIONS);
}

// The expense a payment's n-th "Mark paid" records (n = reopen count).
export const expenseIdForSupplierPayment = (paymentId, attempt = 0) => (attempt > 0 ? `${paymentId}r${attempt}` : paymentId);

// Mark Paid -> exactly one Wedding Expense (see the header). payment:
// { paidDate? (default today; never in the future), method, reference?,
//   amount? (default the scheduled amount: the final bill may differ) }
const PAY_FIELDS = ["paidDate", "method", "reference", "amount"];
export async function markSupplierPaymentPaid(args) {
  try {
    return await markPaidOnce(args);
  } catch (err) {
    // Belt and braces: the deterministic expense id already exists, so a
    // concurrent request paid it first. Answer with that payment's expense.
    if (err && (err.code === 6 || err.code === "already-exists")) {
      const p = (await paymentRef(args.tenant, args.paymentId).get()).data();
      if (p && p.status === "paid") return { paymentId: args.paymentId, expenseId: p.expenseId, alreadyPaid: true };
    }
    throw err;
  }
}

async function markPaidOnce({ db, tenant, FieldValue, business, workspace, paymentId, payment, actor, now = new Date() }) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new WeddingError("invalid-input", "Invalid payment");
  for (const k of Object.keys(payment)) if (!PAY_FIELDS.includes(k)) throw new WeddingError("invalid-input", `Field ${k} can't be set here`);
  const paidDate = payment.paidDate ?? businessDate(business.timezone, now);
  if (!isDayId(paidDate)) throw new WeddingError("invalid-input", "Choose a valid paid date");
  if (!Object.hasOwn(EXPENSE_METHODS, payment.method)) throw new WeddingError("invalid-input", "Choose a payment method");
  const pRef = paymentRef(tenant, paymentId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(pRef);
    if (!snap.exists) throw new WeddingError("not-found", "Supplier payment not found");
    const p = snap.data();
    // Idempotent: a retry / second click finds it Paid and gets the same expense.
    if (p.status === "paid") return { paymentId, expenseId: p.expenseId, alreadyPaid: true };
    if (p.status !== "upcoming") throw new WeddingError("not-upcoming", "A cancelled payment can't be marked paid");
    const amount = payment.amount ?? p.amount;
    const expenseId = expenseIdForSupplierPayment(paymentId, int(p.attempt));
    const nextDue = await nextDueAfter(tx, tenant, p.supplierId, { without: paymentId });
    const notes = await prepareNotifications(tx, {
      tenant,
      actor,
      events: [{ type: "supplierpayment.paid", key: expenseId, title: `${p.supplierName} paid`, message: `${p.description} · ${peso(amount)} paid on ${paidDate}.`, recordType: "supplierPayment", recordId: paymentId }],
    });
    const plan = await prepareExpenseCreate(tx, {
      tenant,
      business,
      workspace,
      actor,
      now,
      expenseId,
      link: { supplierPaymentId: paymentId, label: `Paid ${p.supplierName}: ${p.description} ${peso(amount)}` },
      // Leaves Upcoming in the same budgets/current and supplier writes as the spending.
      upcomingDelta: { amount: -p.amount, count: -1, category: p.category, supplierId: p.supplierId, nextDue },
      input: {
        date: paidDate,
        category: p.category,
        amount,
        method: payment.method,
        supplierId: p.supplierId,
        ...(payment.reference ? { reference: payment.reference } : {}),
        notes: `Supplier payment: ${p.description}`,
      },
    });
    plan.commit({ FieldValue });
    tx.update(pRef, {
      status: "paid",
      expenseId,
      paidDate,
      paidAmount: amount,
      method: payment.method,
      reference: plan.record.reference ?? null,
      history: append(p.history, entry(actor, `Marked paid ${peso(amount)} on ${paidDate} (${EXPENSE_METHODS[payment.method].label})`)),
      revision: p.revision + 1,
      updatedBy: who(actor),
      updatedAt: FieldValue.serverTimestamp(),
    });
    notes.commit({ FieldValue, actor });
    return { paymentId, expenseId, paid: true };
  }, TX_OPTIONS);
}

// ---------- Tasks ----------

const taskTotalsRef = (tenant) => tenant.doc("taskTotals", TOTALS_DOC_ID);
const taskRef = (tenant, id) => ref(tenant, "weddingTasks", id, "task");
const incTotals = (FieldValue, d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v).map(([k, v]) => [k, FieldValue.increment(v)]));

export async function createTask({ db, tenant, FieldValue, input, actor }) {
  const data = validateTaskInput(input);
  return db.runTransaction(async (tx) => {
    await tx.get(taskTotalsRef(tenant));
    const r = tenant.collection("weddingTasks").doc();
    const stamp = FieldValue.serverTimestamp();
    const task = { title: data.title, category: data.category ?? null, categoryKey: keyOf(data.category), assignee: data.assignee ?? null, assigneeKey: keyOf(data.assignee), dueDate: data.dueDate ?? null, priority: data.priority ?? "normal", status: "not_started", open: true };
    tx.create(r, { schemaVersion: WEDDING_SCHEMA_VERSION, ...task, notes: data.notes ?? null, completedAt: null, completedBy: null, completedDate: null, history: [entry(actor, `Added task${task.dueDate ? ` · due ${task.dueDate}` : ""}`)], revision: 1, createdBy: who(actor), createdAt: stamp, updatedBy: who(actor), updatedAt: stamp });
    tx.set(taskTotalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...incTotals(FieldValue, taskTotalsDelta(null, task)), updatedAt: stamp }, { merge: true });
    return { taskId: r.id };
  }, TX_OPTIONS);
}

export async function updateTask({ db, tenant, FieldValue, taskId, changes, expectedRevision = null, actor }) {
  const data = validateTaskInput(changes, { partial: true });
  const tRef = taskRef(tenant, taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tRef);
    if (!snap.exists) throw new WeddingError("not-found", "Task not found");
    const t = snap.data();
    checkRevision(expectedRevision, t.revision);
    const diff = Object.fromEntries(Object.entries(data).filter(([k, v]) => (t[k] ?? null) !== (v ?? null)));
    if (!Object.keys(diff).length) return { taskId, unchanged: true, revision: t.revision };
    const names = { title: "Task", category: "Category", assignee: "Assigned to", dueDate: "Due date", priority: "Priority" };
    const show = (k, v) => (k === "priority" ? label(TASK_PRIORITIES, v) : v || "—");
    const labels = Object.keys(diff).map((k) => (k === "notes" ? "Notes updated" : `${names[k]} changed ${show(k, t[k])} → ${show(k, diff[k])}`));
    tx.update(tRef, { ...diff, ...("category" in diff ? { categoryKey: keyOf(diff.category) } : {}), ...("assignee" in diff ? { assigneeKey: keyOf(diff.assignee) } : {}), history: append(t.history, entry(actor, labels.join(" · "))), revision: t.revision + 1, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { taskId, revision: t.revision + 1 };
  }, TX_OPTIONS);
}

// Status: Not Started / In Progress / Completed / Cancelled. Completing
// records who and when; reopening is logged. Overdue is derived, never set.
export async function setTaskStatus({ db, tenant, FieldValue, business, taskId, status, actor, now = new Date() }) {
  if (!Object.hasOwn(TASK_STATUSES, status)) throw new WeddingError("invalid-input", "Choose a status");
  const tRef = taskRef(tenant, taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tRef);
    await tx.get(taskTotalsRef(tenant));
    if (!snap.exists) throw new WeddingError("not-found", "Task not found");
    const t = snap.data();
    if (t.status === status) return { taskId, unchanged: true, status };
    const stamp = FieldValue.serverTimestamp();
    const completing = status === "completed";
    const reopening = t.status === "completed" && !completing;
    const text = `Status changed ${label(TASK_STATUSES, t.status)} → ${label(TASK_STATUSES, status)}${reopening ? " (reopened)" : ""}`;
    tx.update(tRef, {
      status,
      open: isOpenStatus(status),
      ...(completing ? { completedAt: stamp, completedBy: who(actor), completedDate: businessDate(business.timezone, now) } : t.status === "completed" ? { completedAt: null, completedBy: null, completedDate: null } : {}),
      history: append(t.history, entry(actor, text, { from: t.status, to: status })),
      revision: t.revision + 1,
      updatedBy: who(actor),
      updatedAt: stamp,
    });
    tx.set(taskTotalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...incTotals(FieldValue, taskTotalsDelta(t, { ...t, status })), updatedAt: stamp }, { merge: true });
    return { taskId, status };
  }, TX_OPTIONS);
}

// ---------- Guests / RSVP ----------

const guestTotalsRef = (tenant) => tenant.doc("guestTotals", TOTALS_DOC_ID);
const guestRef = (tenant, id) => ref(tenant, "guests", id, "guest");

export async function createGuest({ db, tenant, FieldValue, input, actor }) {
  const data = validateGuestInput(input);
  for (const k of ["name", "side", "partySize"]) if (data[k] === undefined) throw new WeddingError("invalid-input", `${k} is required`);
  return db.runTransaction(async (tx) => {
    await tx.get(guestTotalsRef(tenant));
    const r = tenant.collection("guests").doc();
    const stamp = FieldValue.serverTimestamp();
    const g = { name: data.name, nameLower: lower(data.name), group: data.group ?? null, side: data.side, contact: data.contact ?? null, partySize: data.partySize, invitationSent: data.invitationSent ?? null, invited: Boolean(data.invitationSent), rsvp: "awaiting", confirmed: 0, rsvpDate: null };
    tx.create(r, { schemaVersion: WEDDING_SCHEMA_VERSION, ...g, notes: data.notes ?? null, history: [entry(actor, `Added · party of ${g.partySize}`)], revision: 1, createdBy: who(actor), createdAt: stamp, updatedBy: who(actor), updatedAt: stamp });
    tx.set(guestTotalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...incTotals(FieldValue, guestDelta(null, g)), updatedAt: stamp }, { merge: true });
    return { guestId: r.id };
  }, TX_OPTIONS);
}

export async function updateGuest({ db, tenant, FieldValue, guestId, changes, expectedRevision = null, actor }) {
  const data = validateGuestInput(changes, { partial: true });
  const gRef = guestRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gRef);
    await tx.get(guestTotalsRef(tenant));
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    checkRevision(expectedRevision, g.revision);
    const diff = Object.fromEntries(Object.entries(data).filter(([k, v]) => (g[k] ?? null) !== (v ?? null)));
    if (!Object.keys(diff).length) return { guestId, unchanged: true, revision: g.revision };
    if ("partySize" in diff && diff.partySize < int(g.confirmed)) throw new WeddingError("invalid-input", `The party size can't be less than the ${g.confirmed} confirmed guests`);
    const next = { ...g, ...diff, invited: "invitationSent" in diff ? Boolean(diff.invitationSent) : Boolean(g.invitationSent) };
    const names = { name: "Name", group: "Group", side: "Side", contact: "Contact", partySize: "Party size", invitationSent: "Invitation sent" };
    const show = (k, v) => (k === "side" ? label(GUEST_SIDES, v) : v === null || v === undefined || v === "" ? "—" : String(v));
    const labels = Object.keys(diff).map((k) => (k === "notes" ? "Notes updated" : `${names[k]} changed ${show(k, g[k])} → ${show(k, diff[k])}`));
    const stamp = FieldValue.serverTimestamp();
    tx.update(gRef, { ...diff, ...("name" in diff ? { nameLower: lower(diff.name) } : {}), invited: next.invited, history: append(g.history, entry(actor, labels.join(" · "))), revision: g.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    tx.set(guestTotalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...incTotals(FieldValue, guestDelta(g, next)), updatedAt: stamp }, { merge: true });
    return { guestId, revision: g.revision + 1 };
  }, TX_OPTIONS);
}

// RSVP: Awaiting / Attending (1..party size confirmed) / Declined (0).
// "Oct 12 • Camille • RSVP changed Awaiting RSVP → Attending · 3 confirmed"
export async function setRsvp({ db, tenant, FieldValue, business, guestId, rsvp, actor, now = new Date() }) {
  const gRef = guestRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gRef);
    await tx.get(guestTotalsRef(tenant));
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    const v = validateRsvp(rsvp, g.partySize);
    if (v.status === g.rsvp && v.confirmed === int(g.confirmed)) return { guestId, unchanged: true };
    const text = v.status === g.rsvp ? `Confirmed guests ${int(g.confirmed)} → ${v.confirmed}` : `RSVP changed ${label(RSVP_STATUSES, g.rsvp)} → ${label(RSVP_STATUSES, v.status)}${v.status === "attending" ? ` · ${v.confirmed} confirmed` : ""}`;
    const next = { ...g, rsvp: v.status, confirmed: v.confirmed };
    const stamp = FieldValue.serverTimestamp();
    tx.update(gRef, { rsvp: v.status, confirmed: v.confirmed, rsvpDate: v.status === "awaiting" ? null : businessDate(business.timezone, now), history: append(g.history, entry(actor, text, { from: { rsvp: g.rsvp, confirmed: int(g.confirmed) }, to: v })), revision: g.revision + 1, updatedBy: who(actor), updatedAt: stamp });
    tx.set(guestTotalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...incTotals(FieldValue, guestDelta(g, next)), updatedAt: stamp }, { merge: true });
    return { guestId, rsvp: v.status, confirmed: v.confirmed };
  }, TX_OPTIONS);
}

// A guest added by mistake: removed (no money is attached to a guest), with
// an audit-log line; the totals drop its contribution.
export async function removeGuest({ db, tenant, FieldValue, guestId, actor }) {
  const gRef = guestRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gRef);
    await tx.get(guestTotalsRef(tenant));
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    const stamp = FieldValue.serverTimestamp();
    tx.delete(gRef);
    tx.set(guestTotalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...incTotals(FieldValue, guestDelta(g, null)), updatedAt: stamp }, { merge: true });
    tx.set(tenant.collection("auditLog").doc(), { type: "guest.removed", guestId, name: g.name, partySize: g.partySize, rsvp: g.rsvp, confirmed: int(g.confirmed), actor: who(actor), at: stamp });
    return { guestId, removed: true };
  }, TX_OPTIONS);
}

export { supplierBalance };
