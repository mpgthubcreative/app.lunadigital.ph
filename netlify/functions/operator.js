// POST /api/operator   (Phase 17: Luna Super Admin; Luna operators only)
// Every action first requires a verified ID token AND an active operator
// record (operators/{uid}); a business Owner / Manager / Staff gets 403
// whatever they send. The browser sends INTENT ("move X to Growth"), never
// entitlement objects, permission maps or collection paths. Mutations run
// through the shared provisioning library (the same code as the CLI), each
// in a transaction with an audit record.
//
// Reads:   session, overview, plans, listBusinesses, business, audit, usageOverview
// Writes:  createBusiness, changePlan, setModuleOverride, setLimitOverride,
//          setStatus, addMember, setMemberStatus, updateGeneral,
//          setTerminology, setupLink
// Super Admin consolidation (2026-10-19):
//   overview (the short Overview + Action Center), recordPayment,
//   setBillingDate, sendReminder, removeMember, deleteBusiness (typed name,
//   recoverable), restoreBusiness, savePlan
// Final pricing model (2026-10-20): setAccess (term, paid through, add-ons,
//   price override; the product stays), addAdjustment / removeAdjustment
//   (discounts / credits on a bill), changePlan agreedPrice (+ upgrade bill)
// Phase 18.6 (Luna's own money; operators only):
//   money (Overview story), subscriptions, payments, payment, paymentProof,
//   confirmPayment, rejectPayment, billingSettings, saveBillingSettings,
//   expenses, addExpense, editExpense, removeExpense, copyRecurring,
//   costRates, addCostRate, usageCost, economics

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireOperator, overview, listBusinesses, businessDetail, listAudit, listPlans, planSubscribers, creatableWorkspaces, usageOverview } from "./_lib/operator.js";
import { provisionBusiness, assignPlan, setAccess, chooseConversion, restartTrial, updateOverrides, setLimitOverride, setSubscriptionStatus, addMember, setMemberStatus, updateBusinessGeneral, setTenantTerminology, ensureAuthUser, passwordSetupLink, ProvisioningError } from "./_lib/provisioning.js";
import { tenantDb } from "./_lib/tenant-db.js";
import { OperatorError, validateCreateBusinessInput, validateSubscriptionStatus, validateReason, overrideChange } from "../../shared/operators.js";
import { ROLE_TEMPLATES } from "../../shared/permissions.js";
import { isValidBusinessId } from "../../shared/tenancy.js";
import { BillingError } from "../../shared/billing.js";
import { confirmPayment, rejectPayment, readPaymentProof, getBillingSettings, setBillingSettings, recordOperatorPayment, setBillingDate, sendBillingReminder, addBillAdjustment, removeBillAdjustment, repriceOpenBill, createUpgradeBill, businessBills, conversionBill, assertNoPendingPayment } from "./_lib/billing.js";
import { removeMember } from "./_lib/provisioning.js";
import { unlinkStaffLogin } from "./_lib/members.js";
import { deleteBusiness, restoreBusiness } from "./_lib/lifecycle.js";
import { savePlan } from "./_lib/plans-admin.js";
import { startSupport, supportRead, endSupport, openSupportSession, supportAreas, SupportError } from "./_lib/support.js";
import { invitationSummary } from "./_lib/invitation-design.js";
import { listFeedback, setFeedbackStatus } from "./_lib/feedback.js";
import { FeedbackError } from "../../shared/feedback.js";
import { lunaOverview, platformOverview, listSubscriptionPayments, paymentDetail, listSubscriptions, listPlatformExpenses, createPlatformExpense, updatePlatformExpense, removePlatformExpense, copyRecurringExpenses, listCostRates, addCostRate, usageCost, economics } from "./_lib/platform.js";

const STATUS = {
  "invalid-input": 400,
  "reason-required": 400,
  "not-overridable": 400,
  "unknown-plan": 400,
  "plan-wrong-workspace": 400,
  "unknown-template": 400,
  "not-found": 404,
  "business-exists": 409,
  stale: 409,
  "owner-protected": 409,
  "user-limit-reached": 409,
  "business-misconfigured": 409,
  "invalid-proof": 400,
  "no-invoice": 404,
  "already-paid": 409,
  "confirm-mismatch": 400,
  "legacy-plan": 409,
  "bill-locked": 409,
  "no-session": 403,
  "not-in-trial": 409,
  "payment-pending": 409,
  "no-permission": 409,
  "already-submitted": 409,
  "session-ended": 403,
};
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

const rev = (v) => {
  if (v === undefined || v === null) return null;
  if (!Number.isSafeInteger(v)) throw new RequestError("invalid-request", "Invalid revision.", 400);
  return v;
};
const bid = (v) => {
  if (!isValidBusinessId(v)) throw new RequestError("invalid-request", "Invalid business.", 400);
  return v;
};
const role = (v) => {
  if (!Object.hasOwn(ROLE_TEMPLATES, v)) throw new OperatorError("invalid-input", "Choose Owner, Manager or Staff");
  return v;
};
const actorOf = (op) => op.email || op.uid;

async function memberDoc(db, businessId, uid) {
  if (typeof uid !== "string" || !/^[^/\s]{1,128}$/.test(uid)) throw new OperatorError("invalid-input", "Invalid member");
  const snap = await tenantDb(db, businessId).member(uid).get();
  if (!snap.exists) throw new ProvisioningError("not-found", "Member not found.");
  return snap.data();
}

// name -> { fields, run(ctx, body) }
const ACTIONS = {
  session: { fields: [], run: async ({ op }) => ({ operator: { email: op.email, name: op.name, role: op.role }, workspaces: creatableWorkspaces() }) },
  // The short Overview: active access, recurring and annual income, Needs Attention, Income by Workspace.
  overview: { fields: [], run: async ({ db, admin }) => ({ overview: await lunaOverview({ db, FieldValue: admin.firestore.FieldValue }) }) },
  counts: { fields: [], run: async ({ db }) => ({ overview: await overview({ db, planIds: (await listPlans({ db })).map((p) => p.id) }) }) },
  plans: {
    fields: [],
    run: async ({ db }) => {
      const plans = await listPlans({ db });
      return { plans, subscribers: await planSubscribers({ db, planIds: plans.map((p) => p.id) }) };
    },
  },
  listBusinesses: { fields: ["filters", "after"], run: async ({ db, admin }, b) => listBusinesses({ db, FieldPath: admin.firestore.FieldPath, filters: b.filters && typeof b.filters === "object" && !Array.isArray(b.filters) ? b.filters : {}, after: b.after ?? null }) },
  // The business page, with its bills (breakdown, discounts / credits).
  // + a Bridal wedding's Invitation summary (invitation work only: no
  // guests, RSVPs, money or tasks), and the operator's open support session.
  business: {
    fields: ["businessId"],
    run: async ({ db, op }, b) => {
      const businessId = bid(b.businessId);
      const d = await businessDetail({ db, businessId });
      const tenant = tenantDb(db, businessId);
      const raw = (await tenant.ref.get()).data();
      const invitation = raw?.workspaceTemplateId === "bridal-expense" ? await invitationSummary({ tenant, business: raw }) : null;
      return { ...d, bills: await businessBills({ db, businessId }), invitation, support: await openSupportSession({ db, businessId, operator: { uid: op.uid } }) };
    },
  },
  audit: { fields: ["after"], run: async ({ db }, b) => listAudit({ db, after: b.after ?? null }) },
  usageOverview: { fields: ["after"], run: async ({ db, admin }, b) => usageOverview({ db, FieldPath: admin.firestore.FieldPath, after: b.after ?? null }) },

  // Create business: one retry-safe workflow (provisionBusiness). The
  // workspace is a live template at its current version (never typed).
  createBusiness: {
    fields: ["business"],
    run: async ({ db, admin, auth, op }, b) => {
      const req = validateCreateBusinessInput(b.business);
      const r = await provisionBusiness({ db, admin, auth, actor: actorOf(op), request: req });
      return { ...r, created: !r.alreadyProvisioned };
    },
  },
  // A one-time password-setup link for an owner/member who has no password
  // yet (no email infrastructure: the operator shares it).
  setupLink: {
    fields: ["businessId", "uid"],
    run: async ({ db, auth }, b) => {
      const m = await memberDoc(db, bid(b.businessId), b.uid);
      const continueUrl = process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/` : null;
      return { email: m.email, link: await passwordSetupLink({ auth, email: m.email, continueUrl }) };
    },
  },
  // Change product. agreedPrice (optional, e.g. a Custom wedding's quote)
  // becomes the new product's agreed price. Paid 12-month access moving to
  // a pricier product (Luna Bridal → Custom) gets a bill for only the
  // difference; otherwise an unpaid next bill is re-priced.
  changePlan: {
    fields: ["businessId", "planId", "reason", "expectedRevision", "agreedPrice"],
    run: async ({ db, admin, op }, b) => {
      const businessId = bid(b.businessId);
      const reason = validateReason(b.reason);
      const FieldValue = admin.firestore.FieldValue;
      const before = (await db.collection("businesses").doc(businessId).get()).data()?.subscription ?? null;
      const r = await assignPlan({ db, admin, businessId, planId: b.planId, actor: actorOf(op), reason, expectedRevision: rev(b.expectedRevision) });
      if (b.agreedPrice !== undefined && b.agreedPrice !== null) await setAccess({ db, admin, businessId, changes: { priceOverride: b.agreedPrice }, actor: actorOf(op), reason });
      const upgrade = before?.planId !== r.planId ? await createUpgradeBill({ db, FieldValue, businessId, before, operator: actorOf(op) }) : null;
      if (!upgrade?.invoiceId) await repriceOpenBill({ db, FieldValue, businessId, operator: actorOf(op) });
      return { planId: r.planId, warnings: r.warnings, adminRevision: r.adminRevision, upgradeDue: upgrade?.upgradeDue ?? null };
    },
  },
  // Change access (2026-10-20): the product stays; term, paid-through date,
  // add-ons and price override change (shared/plan-billing.js).
  setAccess: {
    fields: ["businessId", "changes", "reason", "expectedRevision"],
    run: async ({ db, admin, op }, b) => {
      const r = await setAccess({ db, admin, businessId: bid(b.businessId), changes: obj(b.changes), actor: actorOf(op), reason: validateReason(b.reason), expectedRevision: rev(b.expectedRevision) });
      await repriceOpenBill({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), operator: actorOf(op) });
      return { warnings: r.warnings, limits: r.entitlements.limits, adminRevision: r.adminRevision };
    },
  },
  // + Add discount / deduction on a bill (default: the next one), and remove
  // one, before any payment is recorded on it. The plan price never changes.
  addAdjustment: { fields: ["businessId", "invoiceId", "adjustment"], run: async ({ db, admin, op }, b) => addBillAdjustment({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), invoiceId: b.invoiceId ?? null, adjustment: obj(b.adjustment), operator: actorOf(op) }) },
  removeAdjustment: { fields: ["businessId", "invoiceId", "adjustmentId"], run: async ({ db, admin, op }, b) => removeBillAdjustment({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), invoiceId: b.invoiceId, adjustmentId: b.adjustmentId, operator: actorOf(op) }) },
  // Default / Enabled / Disabled for ONE module the workspace allows.
  setModuleOverride: {
    fields: ["businessId", "moduleId", "choice", "reason", "expectedRevision"],
    run: async ({ db, admin, op }, b) => {
      const snap = await tenantDb(db, bid(b.businessId)).ref.get();
      if (!snap.exists) throw new ProvisioningError("not-found", "Business not found.");
      const { set, clear } = overrideChange(snap.data().workspaceTemplateId, b.moduleId, b.choice);
      const r = await updateOverrides({ db, admin, businessId: b.businessId, set, clear, actor: actorOf(op), reason: validateReason(b.reason), expectedRevision: rev(b.expectedRevision) });
      return { modules: r.entitlements.modules, adminRevision: r.adminRevision };
    },
  },
  // Phase 18: one per-business LIMIT override (separate from module
  // overrides). Intent only: { limitKey, value } where value is a whole
  // number or null (back to the plan's limit). Never deletes data; the
  // response warns when usage is already at / over the new limit.
  setLimitOverride: {
    fields: ["businessId", "limitKey", "value", "reason", "expectedRevision"],
    run: async ({ db, admin, op }, b) => {
      const r = await setLimitOverride({ db, admin, businessId: bid(b.businessId), limitKey: b.limitKey, value: b.value === undefined ? undefined : b.value, actor: actorOf(op), reason: validateReason(b.reason), expectedRevision: rev(b.expectedRevision) });
      return { limits: r.entitlements.limits, overrides: r.overrides.limits, warnings: r.warnings, adminRevision: r.adminRevision };
    },
  },
  // Suspend / reactivate / cancel / past due: reason required; data kept.
  setStatus: {
    fields: ["businessId", "status", "reason", "expectedRevision"],
    run: async ({ db, admin, op }, b) => setSubscriptionStatus({ db, admin, businessId: bid(b.businessId), status: validateSubscriptionStatus(b.status), actor: actorOf(op), reason: validateReason(b.reason), expectedRevision: rev(b.expectedRevision) }),
  },
  // Members: role templates only (never a typed permission list).
  addMember: {
    fields: ["businessId", "email", "name", "roleTemplate", "reason"],
    run: async ({ db, admin, auth, op }, b) => {
      const user = await ensureAuthUser({ auth, email: b.email, name: b.name });
      const businessId = bid(b.businessId);
      const existing = await tenantDb(db, businessId).member(user.uid).get();
      const isOwner = existing.exists && existing.data().isAccountOwner === true;
      if (isOwner && b.roleTemplate !== "owner") throw new OperatorError("owner-protected", "The account owner stays an Owner.");
      await addMember({ db, admin, businessId, uid: user.uid, email: user.email, name: b.name, roleTemplate: role(b.roleTemplate), isAccountOwner: isOwner, status: existing.exists ? existing.data().status : "active", createdBy: actorOf(op), audit: { actor: actorOf(op), reason: typeof b.reason === "string" ? b.reason : null } });
      return { uid: user.uid, accountCreated: user.created };
    },
  },
  setMemberStatus: {
    fields: ["businessId", "uid", "status", "reason"],
    run: async ({ db, admin, op }, b) => {
      const businessId = bid(b.businessId);
      await memberDoc(db, businessId, b.uid);
      return setMemberStatus({ db, admin, businessId, uid: b.uid, status: b.status, audit: { actor: actorOf(op), reason: validateReason(b.reason) } });
    },
  },
  updateGeneral: {
    fields: ["businessId", "changes", "reason", "expectedRevision"],
    run: async ({ db, admin, op }, b) => updateBusinessGeneral({ db, admin, businessId: bid(b.businessId), changes: b.changes, actor: actorOf(op), reason: b.reason, expectedRevision: rev(b.expectedRevision) }),
  },
  setTerminology: {
    fields: ["businessId", "terminology", "reason"],
    run: async ({ db, admin, op }, b) => setTenantTerminology({ db, admin, businessId: bid(b.businessId), terminology: b.terminology, actor: actorOf(op), reason: b.reason }),
  },

  // ---- Super Admin consolidation (2026-10-19) ----
  recordPayment: { fields: ["businessId", "payment"], run: async ({ db, admin, op }, b) => recordOperatorPayment({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), input: obj(b.payment), operator: actorOf(op) }) },
  setBillingDate: { fields: ["businessId", "date", "reason"], run: async ({ db, admin, op }, b) => setBillingDate({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), date: b.date, reason: b.reason, operator: actorOf(op) }) },
  sendReminder: { fields: ["businessId", "message"], run: async ({ db, admin, op }, b) => sendBillingReminder({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), message: b.message ?? null, operator: actorOf(op) }) },
  // Removes a membership for good (confirmation in the console). The account
  // owner and the last owner can't be removed; a kasambahay login leaves its
  // staff record. The person's sessions are revoked.
  removeMember: {
    fields: ["businessId", "uid", "reason"],
    run: async ({ db, admin, auth, op }, b) => {
      const businessId = bid(b.businessId);
      await memberDoc(db, businessId, b.uid);
      const r = await removeMember({ db, admin, businessId, uid: b.uid, audit: { actor: actorOf(op), reason: typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 300) : "Removed by Luna Super Admin" }, within: unlinkStaffLogin(tenantDb(db, businessId), b.uid, actorOf(op)) });
      await auth.revokeRefreshTokens(b.uid).catch(() => {});
      return r;
    },
  },
  deleteBusiness: { fields: ["businessId", "confirmName", "reason"], run: async ({ db, admin, op }, b) => deleteBusiness({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), confirmName: b.confirmName, reason: b.reason ?? null, operator: actorOf(op) }) },
  // Free trials (2026-10-21): choose the plan for a customer (Continue with
  // Luna on their behalf), or restart a trial (status "reset", new dates).
  convertTrial: {
    fields: ["businessId", "planId", "termMonths", "reason"],
    run: async ({ db, admin, op }, b) => {
      const businessId = bid(b.businessId);
      const reason = validateReason(b.reason);
      await assertNoPendingPayment({ db, businessId });
      const r = await chooseConversion({ db, admin, businessId, planId: b.planId ?? null, termMonths: b.termMonths, actor: actorOf(op), reason });
      const invoice = await conversionBill({ db, FieldValue: admin.firestore.FieldValue, businessId, operator: actorOf(op) });
      return { planId: r.planId, startDate: (await db.collection("businesses").doc(businessId).get()).data().subscription.conversion.startDate, invoice };
    },
  },
  restartTrial: { fields: ["businessId", "days", "reason"], run: async ({ db, admin, op }, b) => restartTrial({ db, admin, businessId: bid(b.businessId), days: b.days ?? 30, actor: actorOf(op), reason: validateReason(b.reason) }).then(() => ({ restarted: true })) },
  // Reviews & Feedback (2026-10-21): private trial feedback; a status is
  // Super Admin's review only (Featured needs the marketing permission).
  feedbackList: { fields: ["filters"], run: async ({ db }, b) => listFeedback({ db, filters: obj(b.filters) }) },
  setFeedbackStatus: { fields: ["feedbackId", "status"], run: async ({ db, admin, op }, b) => setFeedbackStatus({ db, FieldValue: admin.firestore.FieldValue, feedbackId: b.feedbackId, status: b.status, operator: actorOf(op) }) },
  // Support access (2026-10-20): the customer's records only through an
  // explicit, reasoned, read-only, 30-minute, audited session.
  supportStart: { fields: ["businessId", "reason"], run: async ({ db, admin, op }, b) => startSupport({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), reason: b.reason, operator: { uid: op.uid, email: op.email || null } }) },
  supportRead: { fields: ["sessionId", "businessId", "area"], run: async ({ db, admin, op }, b) => supportRead({ db, FieldValue: admin.firestore.FieldValue, sessionId: b.sessionId, businessId: bid(b.businessId), area: b.area, operator: { uid: op.uid, email: op.email || null } }) },
  supportEnd: { fields: ["sessionId"], run: async ({ db, admin, op }, b) => endSupport({ db, FieldValue: admin.firestore.FieldValue, sessionId: b.sessionId, operator: { uid: op.uid, email: op.email || null } }) },
  supportAreas: {
    fields: ["businessId"],
    run: async ({ db }, b) => {
      const snap = await db.collection("businesses").doc(bid(b.businessId)).get();
      if (!snap.exists) throw new OperatorError("not-found", "Business not found");
      return { areas: supportAreas(snap.data()) };
    },
  },
  restoreBusiness: { fields: ["businessId"], run: async ({ db, admin, op }, b) => restoreBusiness({ db, FieldValue: admin.firestore.FieldValue, businessId: bid(b.businessId), operator: actorOf(op) }) },
  savePlan: { fields: ["planId", "changes"], run: async ({ db, admin, op }, b) => savePlan({ db, FieldValue: admin.firestore.FieldValue, planId: b.planId, changes: obj(b.changes), operator: actorOf(op) }) },

  // ---- Phase 18.6: Luna subscriptions, revenue and platform costs ----
  money: { fields: [], run: async ({ db, admin }) => ({ money: await platformOverview({ db, FieldValue: admin.firestore.FieldValue, AggregateField: admin.firestore.AggregateField }) }) },
  subscriptions: { fields: ["filters", "after"], run: async ({ db }, b) => listSubscriptions({ db, filters: obj(b.filters), after: b.after ?? null }) },
  payments: { fields: ["filters", "after"], run: async ({ db }, b) => listSubscriptionPayments({ db, filters: obj(b.filters), after: b.after ?? null }) },
  payment: { fields: ["paymentId"], run: async ({ db }, b) => paymentDetail({ db, paymentId: b.paymentId }) },
  paymentProof: { fields: ["paymentId"], run: async ({ db, bucket }, b) => ({ proof: await readPaymentProof({ db, bucket, paymentId: String(b.paymentId || "-") }) }) },
  // Confirm needs the explicit confirmation step in the console; the server
  // is idempotent (a second confirm credits nothing).
  confirmPayment: { fields: ["paymentId"], run: async ({ db, admin, op }, b) => confirmPayment({ db, FieldValue: admin.firestore.FieldValue, paymentId: String(b.paymentId || "-"), operator: actorOf(op) }) },
  rejectPayment: { fields: ["paymentId", "reason"], run: async ({ db, admin, op }, b) => rejectPayment({ db, FieldValue: admin.firestore.FieldValue, paymentId: String(b.paymentId || "-"), reason: b.reason, operator: actorOf(op) }) },
  billingSettings: { fields: [], run: async ({ db }) => ({ settings: await getBillingSettings({ db }) }) },
  saveBillingSettings: { fields: ["settings"], run: async ({ db, admin, op }, b) => setBillingSettings({ db, FieldValue: admin.firestore.FieldValue, input: b.settings, actor: actorOf(op) }) },
  expenses: { fields: ["month"], run: async ({ db }, b) => listPlatformExpenses({ db, month: b.month }) },
  addExpense: { fields: ["expense"], run: async ({ db, admin, op }, b) => createPlatformExpense({ db, FieldValue: admin.firestore.FieldValue, input: b.expense, actor: actorOf(op) }) },
  editExpense: { fields: ["expenseId", "changes"], run: async ({ db, admin, op }, b) => updatePlatformExpense({ db, FieldValue: admin.firestore.FieldValue, expenseId: b.expenseId, changes: b.changes, actor: actorOf(op) }) },
  removeExpense: { fields: ["expenseId", "reason"], run: async ({ db, admin, op }, b) => removePlatformExpense({ db, FieldValue: admin.firestore.FieldValue, expenseId: b.expenseId, reason: b.reason, actor: actorOf(op) }) },
  copyRecurring: { fields: ["month"], run: async ({ db, admin, op }, b) => copyRecurringExpenses({ db, FieldValue: admin.firestore.FieldValue, month: b.month, actor: actorOf(op) }) },
  costRates: { fields: [], run: async ({ db }) => ({ rates: await listCostRates({ db }) }) },
  addCostRate: { fields: ["rate"], run: async ({ db, admin, op }, b) => addCostRate({ db, FieldValue: admin.firestore.FieldValue, input: b.rate, actor: actorOf(op) }) },
  usageCost: { fields: ["period", "after"], run: async ({ db }, b) => usageCost({ db, period: b.period, after: b.after ?? null }) },
  economics: { fields: ["period"], run: async ({ db }, b) => economics({ db, period: b.period }) },
};

export function createOperatorHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("operator", async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 8000);
    } catch (err) {
      bodyError = err;
    }
    const { db, auth, admin, bucket } = await loadAdmin();
    // Operator first: a non-operator learns nothing from validation.
    const op = await requireOperator(event, { db, auth });
    if (bodyError) throw bodyError;
    const action = body && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    for (const k of Object.keys(body)) if (k !== "action" && !action.fields.includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
    try {
      return respond(200, { success: true, ...(await action.run({ db, auth, admin, bucket, op }, body)) });
    } catch (err) {
      if (err instanceof ProvisioningError || err instanceof OperatorError || err instanceof BillingError || err instanceof SupportError || err instanceof FeedbackError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createOperatorHandler({ getAdmin });
