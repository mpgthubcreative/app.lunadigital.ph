// Tenant provisioning: plans, businesses, memberships, operators. The ONE
// implementation behind both the operator CLI scripts (scripts/) and the
// Super Admin console's operator API (Phase 17): neither has its own copy
// of these rules.
// Server-only: these writes bypass Firestore rules via the Admin SDK, so
// every invariant (valid plan, user limit, owner protection) is enforced
// right here.
//
// Plans, overrides, workspace templates and entitlement snapshots change
// ONLY through changeEntitlements() (assignPlan / updateOverrides /
// assignWorkspaceTemplate / refreshEntitlements): one transaction that
// validates, recomputes the snapshot and writes an audit record to
// businesses/{bid}/auditLog and platformAudit.

import { newSubscriptionTerms, recurringAmount, addOnSnapshot, addOnCapacity, planBilling, isDayString, shiftDay, monthsText, isUnlimited, usesSeat, BILLING_TYPE_IDS } from "../../../shared/plan-billing.js";
import { trialState, trialOpen, newTrial, TRIAL_DAYS } from "../../../shared/trial.js";
import { businessDate as seatDay } from "../../../shared/metrics.js";
import { planWorkspace, PLAN_SEED } from "../../../shared/plans.seed.js";
import { computeEntitlements, validatePlan, validateEntitlementsSnapshot, isValidPlanId, EntitlementError } from "../../../shared/entitlements.js";
import { resolvePermissions, ROLE_TEMPLATES } from "../../../shared/permissions.js";
import { SUBSCRIPTION_STATUSES } from "../../../shared/subscription.js";
import { MEMBER_STATUSES, isValidBusinessId } from "../../../shared/tenancy.js";
import { tenantDb } from "./tenant-db.js";
import { getWorkspaceTemplate, WORKSPACE_TEMPLATE_IDS } from "../../../shared/workspaces.js";
import { OPERATOR_ROLES, OPERATOR_STATUSES } from "../../../shared/operators.js";
import { TENANT_CONFIG_VERSION, TENANT_CONFIG_DOC_ID, validateTerminologyChange } from "../../../shared/tenant-config.js";
import { LIMIT_METER, METERS, MeteringError, effectiveLimit, overrideImpact, meterApplies, validateLimitOverride, thresholdUnits, WARNING_THRESHOLDS, monthlyAlertKey } from "../../../shared/metering.js";
import { LIMIT_DEFINITIONS } from "../../../shared/plans.seed.js";
import { usageMonthRef, usageCurrentRef, nonNegative, prepareRunningAlerts, usageEvent, noteLimitReached } from "./metering.js";
import { prepareNotifications } from "./notifications.js";
import { monthKey } from "./usage.js";

export class ProvisioningError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanName(value, field) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 120) throw new ProvisioningError("invalid-input", `${field} is required (max 120 characters).`);
  return name;
}

function cleanEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(email)) throw new ProvisioningError("invalid-input", `Invalid email: ${value}`);
  return email;
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ProvisioningError("invalid-input", `Unknown timezone: ${timezone}`);
  }
}

// ---------- Plans ----------

// Writes the seed plans to plans/{planId}. Existing plans are left alone
// unless overwrite is true, because once Super Admin can edit plans the
// stored copy — not the seed file — is the source of truth.
export async function seedPlans({ db, admin, overwrite = false }) {
  const results = [];
  for (const plan of Object.values(PLAN_SEED)) {
    validatePlan(plan);
    const ref = db.collection("plans").doc(plan.id);
    const snap = await ref.get();
    if (snap.exists && !overwrite) {
      results.push({ id: plan.id, action: "kept" });
      continue;
    }
    await ref.set({ ...plan, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    results.push({ id: plan.id, action: snap.exists ? "overwritten" : "created" });
  }
  return results;
}

function planFromSnap(snap, planId) {
  if (!snap.exists) throw new ProvisioningError("unknown-plan", `Plan "${planId}" does not exist. Run the plan seed first.`);
  return snap.data();
}

export async function loadPlan(db, planId) {
  if (!isValidPlanId(planId)) throw new ProvisioningError("unknown-plan", `Invalid plan id: ${planId}`);
  return planFromSnap(await db.collection("plans").doc(planId).get(), planId);
}

// computeEntitlements, with validation errors mapped to ProvisioningError.
// `addOns` (the subscription's add-on snapshot): their extra users and
// storage go on top of the plan's (or the override's) limit.
export function buildEntitlementsSnapshot(plan, overrides, workspaceTemplateId, addOns = []) {
  let e;
  try {
    e = computeEntitlements(plan, overrides, workspaceTemplateId);
  } catch (err) {
    if (err instanceof EntitlementError) throw new ProvisioningError("invalid-input", err.message);
    throw err;
  }
  const extra = addOnCapacity(addOns);
  if (extra.users && !isUnlimited(e.limits.users)) e.limits.users += extra.users;
  if (extra.storageBytes) e.limits.storageBytes += extra.storageBytes;
  return e;
}

// plan-billing errors (a term or add-on the product doesn't sell) as input errors.
function billingTerms(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProvisioningError) throw err;
    throw new ProvisioningError("invalid-input", err.message);
  }
}

// Phase 18.6: a plan belongs to one workspace. A Distributor plan can never
// be given to a Household / Baby / Bridal business (or the reverse).
export function requirePlanFits(plan, templateId) {
  if (planWorkspace(plan) !== templateId) {
    throw new ProvisioningError("plan-wrong-workspace", `${plan.name} is a ${getWorkspaceTemplate(planWorkspace(plan))?.name ?? planWorkspace(plan)} plan. Choose a plan for this workspace.`);
  }
}

// A registered workspace template, or a clear error. There is no default.
function requireTemplate(id) {
  const template = getWorkspaceTemplate(id);
  if (!template) throw new ProvisioningError("unknown-template", `Unknown workspace template ${JSON.stringify(id)}. Use one of: ${WORKSPACE_TEMPLATE_IDS.join(", ")}.`);
  return template;
}

// ---------- Businesses ----------

export async function createBusiness({
  db,
  admin,
  name,
  planId,
  workspaceTemplateId,
  timezone = "Asia/Manila",
  currency = "PHP",
  subscriptionStatus = "active",
  businessId = null,
  isDemo = false,
  createdBy = "cli",
  // The access term (one of the product's terms; default: its main offer)
  // and Super Admin's agreed price for it (null: the product's price).
  termMonths = null,
  priceOverride = null,
  addOns = {},
  setupFee = null,
  waiveSetupFee = false,
  // Start with the product's 30-day free trial (no bill until a plan is chosen).
  trial = false,
  clock = new Date(),
}) {
  const businessName = cleanName(name, "Business name");
  assertTimezone(timezone);
  if (!SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) {
    throw new ProvisioningError("invalid-input", `Unknown subscription status: ${subscriptionStatus}`);
  }
  if (businessId !== null && !isValidBusinessId(businessId)) {
    throw new ProvisioningError("invalid-input", `Invalid business id: ${businessId}`);
  }

  const template = requireTemplate(workspaceTemplateId);
  const plan = await loadPlan(db, planId);
  requirePlanFits(plan, template.id);
  const terms = billingTerms(() => newSubscriptionTerms(plan, seatDay(timezone, clock), { termMonths, priceOverride, addOns, setupFee, waiveSetupFee, trial }));
  const ref = businessId ? db.collection("businesses").doc(businessId) : db.collection("businesses").doc();
  const now = admin.firestore.FieldValue.serverTimestamp();

  try {
    // create() fails if the document already exists — never silently
    // overwrite an existing tenant.
    await ref.create({
      name: businessName,
      nameLower: businessName.toLocaleLowerCase("en"),
      timezone,
      currency,
      // Bumped by every operator change (plan, overrides, status, general
      // settings): the console sends it back so two operators can't
      // silently overwrite each other (stale -> 409).
      adminRevision: 0,
      isDemo: Boolean(isDemo),
      workspaceTemplateId: template.id,
      // The product's price, term and add-ons when assigned
      // (shared/plan-billing.js): invoices never re-read today's price for an
      // older subscription, and monthlyAmount is recurring income only (0 for
      // prepaid / 12-month access).
      subscription: { planId: plan.id, status: subscriptionStatus, renewalAt: null, graceUntil: null, paidThrough: null, nextRenewal: null, ...terms },
      moduleOverrides: {},
      limitOverrides: {},
      featureOverrides: {},
      entitlements: { ...buildEntitlementsSnapshot(plan, {}, template.id, terms.addOns ?? []), computedAt: now },
      createdAt: now,
      updatedAt: now,
      createdBy,
    });
  } catch (err) {
    if (err && (err.code === 6 || /already exists/i.test(err.message || ""))) {
      throw new ProvisioningError("business-exists", `Business ${ref.id} already exists.`);
    }
    throw err;
  }
  return { businessId: ref.id };
}

// ---------- Plans, overrides, entitlements (Luna operators only) ----------

const OVERRIDE_SECTIONS = Object.freeze({ modules: "moduleOverrides", limits: "limitOverrides", features: "featureOverrides" });

function overridesOf(business) {
  const out = {};
  for (const [section, field] of Object.entries(OVERRIDE_SECTIONS)) {
    const value = business[field];
    out[section] = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  }
  return out;
}

function summarize(entitlements) {
  if (!entitlements || typeof entitlements !== "object") return null;
  return { planId: entitlements.planId ?? null, workspaceTemplateId: entitlements.workspaceTemplateId ?? null, workspaceTemplateVersion: entitlements.workspaceTemplateVersion ?? null, modules: entitlements.modules ?? null, limits: entitlements.limits ?? null, features: entitlements.features ?? null };
}

// Current usage of every limited meter, read inside the transaction.
async function readUsageForLimits(tx, tenant, timezone, activeMembers) {
  const period = monthKey(timezone || "UTC");
  const [month, storage, users] = await Promise.all([tx.get(usageMonthRef(tenant, period)), tx.get(usageCurrentRef(tenant, "storage")), tx.get(usageCurrentRef(tenant, "users"))]);
  const m = month.exists ? month.data() : {};
  const values = { activeUsers: activeMembers, storageBytes: storage.exists ? nonNegative(storage.data().bytes) : 0 };
  for (const meterId of Object.values(LIMIT_METER)) if (METERS[meterId].kind === "monthly") values[meterId] = nonNegative(m[meterId]);
  return { period, values, states: { activeUsers: users.exists ? users.data().alerts : null, storageBytes: storage.exists ? storage.data().alerts : null } };
}

// A limit change can put usage over 80% / 100% without any new activity
// (a lower limit). Monthly: warn for thresholds the new limit crosses that
// the old one didn't (same month keys, so never twice). Running: the
// episode state is re-evaluated (a raised limit re-arms it).
async function prepareLimitChangeAlerts(tx, { tenant, usage, before, after }) {
  const events = [];
  const stateWrites = [];
  const running = [];
  for (const [limitKey, meterId] of Object.entries(LIMIT_METER)) {
    const limit = after?.[limitKey];
    const used = usage.values[meterId];
    if (METERS[meterId].kind === "monthly") {
      const old = before?.[limitKey];
      for (const t of WARNING_THRESHOLDS) {
        const now = Number.isSafeInteger(limit) && limit > 0 && used >= thresholdUnits(limit, t);
        const was = Number.isSafeInteger(old) && old > 0 && used >= thresholdUnits(old, t);
        if (now && !was) events.push(usageEvent({ meterId, key: monthlyAlertKey(meterId, usage.period, t), threshold: t, used, limit, period: usage.period }));
      }
    } else running.push({ meterId, limit, used });
  }
  const runningPlans = [];
  for (const r of running) runningPlans.push({ ...r, plan: await prepareRunningAlerts(tx, { tenant, meterId: r.meterId, state: usage.states[r.meterId], used: r.used, limit: r.limit }) });
  const monthly = await prepareNotifications(tx, { tenant, events });
  for (const r of runningPlans) if (r.plan.changed) stateWrites.push({ ref: usageCurrentRef(tenant, r.meterId === "activeUsers" ? "users" : "storage"), alerts: r.plan.next });
  return {
    commit({ FieldValue }) {
      monthly.commit({ FieldValue });
      for (const r of runningPlans) r.plan.notes.commit({ FieldValue });
      for (const w of stateWrites) tx.set(w.ref, { alerts: w.alerts, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },
  };
}

// The one write path for a business's plan / overrides / workspace
// template / snapshot. mutate({ planId, overrides, templateId }) returns
// the next state. A business without a workspace template (pre-8.5) can
// only be given one (assignWorkspaceTemplate); nothing else recomputes it.
// subscriptionPatch(business, plan) (optional) returns the subscription.*
// fields to write with it (Change access); otherwise a product change
// writes the new product's terms (planTermsUpdate).
async function changeEntitlements({ db, admin, businessId, actor, reason, action, mutate, expectedRevision = null, summary = null, subscriptionPatch = null }) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw new ProvisioningError("invalid-input", "A reason is required for every plan or entitlement change.");
  const who = typeof actor === "string" && actor.trim() ? actor.trim() : "cli";

  const tenant = tenantDb(db, businessId);
  const FieldValue = admin.firestore.FieldValue;

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tenant.ref);
    if (!snap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
    const business = snap.data();
    checkAdminRevision(business, expectedRevision);
    const current = { planId: business.subscription?.planId ?? null, overrides: overridesOf(business), templateId: business.workspaceTemplateId ?? null };
    const next = mutate(structuredClone(current));

    if (!isValidPlanId(next.planId)) throw new ProvisioningError("unknown-plan", `Invalid plan id: ${next.planId}`);
    if (next.templateId === null) throw new ProvisioningError("no-template", `Business ${businessId} has no workspace template yet. Assign one first (set-template).`);
    const template = requireTemplate(next.templateId);
    const plan = planFromSnap(await tx.get(db.collection("plans").doc(next.planId)), next.planId);
    const planChanged = next.planId !== current.planId;
    if (planChanged) requirePlanFits(plan, template.id);
    const subPatch = subscriptionPatch ? subscriptionPatch(business, plan) : planChanged || business.subscription?.monthlyAmount === undefined ? planTermsUpdate(business, plan) : {};
    const addOns = Object.hasOwn(subPatch, "subscription.addOns") ? subPatch["subscription.addOns"] : business.subscription?.addOns ?? [];
    // Validates the plan, the overrides and the template ceiling; throws on
    // anything unknown or not allowed. Add-on capacity goes on top.
    const entitlements = buildEntitlementsSnapshot(plan, next.overrides, template.id, addOns);
    const overrides = { modules: { ...next.overrides.modules }, limits: { ...next.overrides.limits }, features: { ...next.overrides.features } };
    // Paid seats: active members except a kasambahay's own login.
    const activeMembers = (await tx.get(tenant.collection("members").where("status", "==", "active"))).docs.filter((d) => usesSeat(d.data())).length;
    // Phase 18: current usage against the NEW effective limits. Nothing is
    // ever deleted or rewritten; the operator is told, and the owner gets the
    // 80% / 100% warnings the new limit implies (deduplicated as usual).
    const usage = await readUsageForLimits(tx, tenant, business.timezone, activeMembers);
    const limitAlerts = await prepareLimitChangeAlerts(tx, { tenant, usage, before: business.entitlements?.limits, after: entitlements.limits });

    const now = FieldValue.serverTimestamp();
    tx.update(tenant.ref, {
      "subscription.planId": plan.id,
      ...subPatch,
      workspaceTemplateId: template.id,
      moduleOverrides: overrides.modules,
      limitOverrides: overrides.limits,
      featureOverrides: overrides.features,
      entitlements: { ...entitlements, computedAt: now },
      adminRevision: adminRevisionOf(business) + 1,
      updatedAt: now,
    });

    // Template moves get their own audit type and a plain-language summary.
    const templateMoved = current.templateId !== template.id;
    const audit = {
      type: !templateMoved ? `entitlements.${action}` : current.templateId === null ? "workspace.template-assigned" : "workspace.template-changed",
      ...(templateMoved ? { summary: current.templateId === null ? `Workspace template assigned: ${template.id}` : `Workspace template changed: ${current.templateId} → ${template.id}` } : summary ? { summary: typeof summary === "function" ? summary() : summary } : {}),
      businessId,
      actor: who,
      reason: why,
      before: { planId: current.planId, workspaceTemplateId: current.templateId, overrides: current.overrides, entitlements: summarize(business.entitlements) },
      after: { planId: plan.id, workspaceTemplateId: template.id, overrides, entitlements: summarize(entitlements) },
      at: now,
    };
    tx.set(tenant.collection("auditLog").doc(), audit);
    tx.set(db.collection("platformAudit").doc(), audit);

    limitAlerts.commit({ FieldValue });
    const warnings = [];
    if (activeMembers > entitlements.limits.users) {
      warnings.push(`${activeMembers} active users exceed the new limit of ${entitlements.limits.users}. Nobody is removed; adding or re-enabling members is blocked until it's back under the limit.`);
    }
    for (const [limitKey, meterId] of Object.entries(LIMIT_METER)) {
      if (limitKey === "users") continue;
      // A meter whose module this workspace doesn't have (e.g. orders in Baby) means nothing.
      if (!meterApplies(meterId, entitlements)) continue;
      const changed = business.entitlements?.limits?.[limitKey] !== entitlements.limits[limitKey];
      const w = changed ? overrideImpact({ limitKey, value: entitlements.limits[limitKey], current: usage.values[meterId] }) : null;
      if (w) warnings.push(w);
    }
    return { businessId, planId: plan.id, workspaceTemplateId: template.id, previousWorkspaceTemplateId: current.templateId, overrides, entitlements, warnings, adminRevision: adminRevisionOf(business) + 1 };
  });
}

// A new product's terms (shared/plan-billing.js). While the billing type
// stays the same (Luna Bridal ↔ Luna Bridal Custom, a legacy "+" plan →
// its product), the start date, the term, what's paid and the access end
// carry over, and add-ons the new product also sells are kept; a different
// billing type starts its terms today. A price override never carries
// over to another product.
function planTermsUpdate(business, plan) {
  const sub = business.subscription || {};
  const today = seatDay(business.timezone || "Asia/Manila", new Date());
  if (!BILLING_TYPE_IDS.includes(plan?.pricing?.billingType)) return { "subscription.monthlyAmount": newSubscriptionTerms(plan, today).monthlyAmount };
  const b = planBilling(plan);
  const sameType = (sub.billingType ?? "monthly") === b.type && typeof sub.startDate === "string";
  const kept = Object.fromEntries((Array.isArray(sub.addOns) ? sub.addOns : []).filter((a) => b.addOns.some((x) => x.id === a.id)).map((a) => [a.id, a.qty]));
  const termMonths = sameType && b.type !== "monthly" && b.terms.some((t) => t.months === sub.termMonths) ? sub.termMonths : null;
  const fresh = newSubscriptionTerms(plan, sameType ? sub.startDate : today, { termMonths, addOns: kept });
  // The one-time setup fee is never billed twice: a product change keeps what
  // was billed / waived, and a business from before billing types was already
  // set up (it never gets one).
  const setup = sameType ? { setupFee: sub.setupFee ?? fresh.setupFee, setupFeeBilled: sub.setupFeeBilled === true, setupFeeWaived: sub.setupFeeWaived === true } : !sub.billingType ? { setupFeeBilled: true } : {};
  const next = sameType ? { ...fresh, ...setup, accessUntil: sub.accessUntil ?? fresh.accessUntil, prepaidTerm: b.type === "monthly" ? sub.prepaidTerm ?? null : null } : { ...fresh, ...setup, paidThrough: null, dueDate: null, nextRenewal: null, accessPaid: 0, upgradeDue: null };
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [`subscription.${k}`, v]));
}

// Super Admin → Change access (Household, Distributor; Bridal add-on
// capacity and price): the product stays, its term / paid-through date /
// add-ons / price override change. changes: { termMonths?, paidThrough?,
// addOns?: { [addOnId]: qty }, priceOverride?: centavos | null }.
const ACCESS_FIELDS = ["termMonths", "paidThrough", "addOns", "priceOverride"];
export async function setAccess({ db, admin, businessId, changes, actor, reason, expectedRevision = null }) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length) throw new ProvisioningError("invalid-input", "Nothing to change");
  for (const k of Object.keys(changes)) if (!ACCESS_FIELDS.includes(k)) throw new ProvisioningError("invalid-input", `${k} can't be changed here`);
  const said = [];
  return changeEntitlements({
    db,
    admin,
    businessId,
    actor,
    reason,
    expectedRevision,
    action: "access-changed",
    summary: () => `Access changed: ${said.join("; ")}`,
    mutate: (state) => state,
    subscriptionPatch: (business, plan) => {
      said.length = 0; // a retried transaction describes the change once
      const sub = business.subscription || {};
      const b = planBilling(plan);
      if (!BILLING_TYPE_IDS.includes(plan.pricing?.billingType) || !BILLING_TYPE_IDS.includes(sub.billingType)) throw new ProvisioningError("legacy-plan", `${plan.name} is an older plan: change the product first.`);
      const next = { ...sub };
      if ("termMonths" in changes) {
        const t = b.terms.find((x) => x.months === changes.termMonths);
        if (!t) throw new ProvisioningError("invalid-input", `${plan.name} is sold for ${b.terms.map((x) => monthsText(x.months)).join(", ")}`);
        if (b.type === "monthly") next.prepaidTerm = t.months > 1 ? { months: t.months, price: t.price } : null;
        else {
          next.termMonths = t.months;
          next.amount = t.price;
        }
        said.push(`term ${monthsText(t.months)}`);
      }
      if ("paidThrough" in changes) {
        if (b.type === "term") throw new ProvisioningError("invalid-input", "12-month access: change the access end instead");
        if (changes.paidThrough !== null && !isDayString(changes.paidThrough)) throw new ProvisioningError("invalid-input", "Paid through: choose a date");
        next.paidThrough = changes.paidThrough;
        next.nextRenewal = changes.paidThrough ? shiftDay(changes.paidThrough, 1) : null;
        next.dueDate = null;
        said.push(`paid through ${changes.paidThrough ?? "—"}`);
      }
      if ("addOns" in changes) {
        next.addOns = billingTerms(() => addOnSnapshot(plan, changes.addOns));
        said.push(`add-ons ${next.addOns.map((a) => `${a.qty} × ${a.label}`).join(", ") || "none"}`);
      }
      if ("priceOverride" in changes) {
        const v = changes.priceOverride;
        if (v !== null && (!Number.isSafeInteger(v) || v <= 0 || v > 100_000_000)) throw new ProvisioningError("invalid-input", "Price: an amount more than ₱0, or empty for the product's price");
        next.priceOverride = v;
        said.push(`price ${v === null ? "product price" : `₱${(v / 100).toLocaleString("en-PH")}`}`);
      }
      next.monthlyAmount = recurringAmount(next);
      const out = {};
      for (const k of ["termMonths", "amount", "prepaidTerm", "paidThrough", "nextRenewal", "dueDate", "addOns", "priceOverride", "monthlyAmount"]) if (next[k] !== undefined && JSON.stringify(next[k]) !== JSON.stringify(sub[k])) out[`subscription.${k}`] = next[k];
      return out;
    },
  });
}

// "Continue with Luna" (2026-10-21): an unconverted free trial chooses its
// product (same workspace: Luna Bridal or Luna Bridal Custom) and term.
// The paid terms start the day after the trial ends (or today once it has
// ended); the first bill (with the one-time setup fee) is then made for
// paying. The trial converts when that bill is paid. Same business, same
// data. A customer can choose again (a different term) until they pay.
export async function chooseConversion({ db, admin, businessId, planId = null, termMonths, actor, reason = "Chose a plan to continue with Luna", now = new Date() }) {
  return changeEntitlements({
    db,
    admin,
    businessId,
    actor,
    reason,
    action: "conversion-chosen",
    summary: () => `Continue with Luna: ${planId ?? "same product"}, ${monthsText(termMonths)}`,
    mutate: (state) => (planId ? { ...state, planId } : state),
    subscriptionPatch: (business, plan) => {
      const sub = business.subscription || {};
      if (!trialOpen(sub)) throw new ProvisioningError("not-in-trial", "This workspace isn't on a free trial");
      const b = planBilling(plan);
      if (!BILLING_TYPE_IDS.includes(plan.pricing?.billingType) || plan.legacy) throw new ProvisioningError("invalid-input", "Choose one of Luna's products");
      if (!b.terms.some((t) => t.months === termMonths)) throw new ProvisioningError("invalid-input", `${plan.name} is sold for ${b.terms.map((t) => monthsText(t.months)).join(", ")}`);
      const today = seatDay(business.timezone || "Asia/Manila", now);
      const t = trialState(sub, today);
      const start = t && !t.ended ? shiftDay(t.endsAt, 1) : today;
      const samePlan = plan.id === sub.planId;
      const kept = Object.fromEntries((Array.isArray(sub.addOns) ? sub.addOns : []).filter((a) => b.addOns.some((x) => x.id === a.id)).map((a) => [a.id, a.qty]));
      const fresh = billingTerms(() => newSubscriptionTerms(plan, start, { termMonths, addOns: kept, setupFee: samePlan ? sub.setupFee ?? null : null, waiveSetupFee: samePlan && sub.setupFeeWaived === true }));
      const next = { ...fresh, setupFeeBilled: sub.setupFeeBilled === true, paidThrough: null, dueDate: null, nextRenewal: null, conversion: { chosenAt: today, planId: plan.id, termMonths, startDate: start } };
      return Object.fromEntries(Object.entries(next).map(([k, v]) => [`subscription.${k}`, v]));
    },
  });
}

// Super Admin: restart a free trial (status "reset", fresh dates). The data
// stays; nothing is billed until a plan is chosen.
export async function restartTrial({ db, admin, businessId, days = TRIAL_DAYS, actor, reason, now = new Date() }) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new ProvisioningError("invalid-input", "Trial length: 1 to 90 days");
  return changeEntitlements({
    db,
    admin,
    businessId,
    actor,
    reason,
    action: "trial-restarted",
    summary: () => `Free trial restarted for ${days} days`,
    mutate: (state) => state,
    subscriptionPatch: (business) => {
      const sub = business.subscription || {};
      if (sub.trialStatus === "converted" || (sub.paidThrough && !trialOpen(sub))) throw new ProvisioningError("invalid-input", "This workspace is already paid");
      const fresh = newTrial(seatDay(business.timezone || "Asia/Manila", now), days, "reset");
      return { "subscription.trialStatus": fresh.trialStatus, "subscription.trialStartedAt": fresh.trialStartedAt, "subscription.trialEndsAt": fresh.trialEndsAt, "subscription.conversion": null };
    },
  });
}

const adminRevisionOf = (business) => (Number.isSafeInteger(business.adminRevision) ? business.adminRevision : 0);
function checkAdminRevision(business, expected) {
  if (expected !== null && expected !== undefined && expected !== adminRevisionOf(business)) {
    throw new ProvisioningError("stale", "This business was changed by someone else. Reload and try again.");
  }
}

// Moves a business to another plan (or re-applies its current one).
// Overrides are kept.
export async function assignPlan({ db, admin, businessId, planId, actor, reason, expectedRevision = null }) {
  return changeEntitlements({ db, admin, businessId, actor, reason, expectedRevision, action: "plan-assigned", mutate: (state) => ({ ...state, planId }) });
}

// set:   { modules?: {id: bool}, limits?: {key: int}, features?: {key: value} }
// clear: { modules?: [id], limits?: [key], features?: [key] }  (back to the plan default)
export async function updateOverrides({ db, admin, businessId, set = {}, clear = {}, actor, reason, expectedRevision = null }) {
  for (const section of [...Object.keys(set), ...Object.keys(clear)]) {
    if (!(section in OVERRIDE_SECTIONS)) throw new ProvisioningError("invalid-input", `Unknown override section: ${section}`);
  }
  return changeEntitlements({
    db,
    admin,
    businessId,
    actor,
    reason,
    expectedRevision,
    action: "overrides-updated",
    mutate: (state) => {
      for (const section of Object.keys(OVERRIDE_SECTIONS)) {
        for (const key of clear[section] || []) delete state.overrides[section][key];
        Object.assign(state.overrides[section], set[section] || {});
      }
      return state;
    },
  });
}

// Phase 18: one per-business LIMIT override (separate from module
// overrides). Plan limit -> optional business override -> effective limit.
// value null = back to the plan's limit. Recognised limit keys only.
export async function setLimitOverride({ db, admin, businessId, limitKey, value, actor, reason, expectedRevision = null }) {
  let v;
  try {
    v = validateLimitOverride(limitKey, value);
  } catch (err) {
    if (err instanceof MeteringError) throw new ProvisioningError("invalid-input", err.message);
    throw err;
  }
  let previous = null;
  const label = LIMIT_DEFINITIONS[limitKey].label;
  const show = (x) => (x === null || x === undefined ? "plan default" : Number(x).toLocaleString("en-PH"));
  return changeEntitlements({
    db,
    admin,
    businessId,
    actor,
    reason,
    expectedRevision,
    action: "limit-override-updated",
    summary: () => `${label} override: ${show(previous)} → ${show(v)}`,
    mutate: (state) => {
      previous = Object.hasOwn(state.overrides.limits, limitKey) ? state.overrides.limits[limitKey] : null;
      if (v === null) delete state.overrides.limits[limitKey];
      else state.overrides.limits[limitKey] = v;
      return state;
    },
  });
}

// Gives a business its workspace template (the Phase 8.5 migration of an
// existing tenant), or CHANGES it, which needs allowChange: true on top of
// the reason. Same transaction, recompute and audit as every other change;
// the audit says "Workspace template changed: a -> b". Overrides the new
// template doesn't allow are refused, never silently dropped.
export async function assignWorkspaceTemplate({ db, admin, businessId, templateId, allowChange = false, actor, reason }) {
  const template = requireTemplate(templateId);
  return changeEntitlements({
    db,
    admin,
    businessId,
    actor,
    reason,
    action: "workspace-assigned",
    mutate: (state) => {
      if (state.templateId !== null && state.templateId !== template.id && allowChange !== true) {
        throw new ProvisioningError("template-change-unconfirmed", `Business ${businessId} is a ${state.templateId} workspace. Changing it to ${template.id} needs explicit confirmation.`);
      }
      return { ...state, templateId: template.id };
    },
  });
}

// Recomputes the snapshot from the stored plan + overrides (after a plan
// definition was edited, or to repair a stale snapshot).
export async function refreshEntitlements({ db, admin, businessId, actor = "cli", reason = "recompute entitlements" }) {
  return changeEntitlements({ db, admin, businessId, actor, reason, action: "recomputed", mutate: (state) => state });
}

// Read-only: what is stored, whether it passes validation, and what a
// recompute would produce. Never writes.
export async function describeEntitlements({ db, businessId }) {
  const snap = await tenantDb(db, businessId).ref.get();
  if (!snap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
  const business = snap.data();
  const planId = business.subscription?.planId ?? null;
  const stored = business.entitlements ?? null;
  const templateId = business.workspaceTemplateId ?? null;
  const check = validateEntitlementsSnapshot(stored, planId, templateId);
  let recomputed = null;
  let recomputeError = null;
  try {
    recomputed = buildEntitlementsSnapshot(await loadPlan(db, planId), overridesOf(business), requireTemplate(templateId).id, business.subscription?.addOns ?? []);
  } catch (err) {
    recomputeError = err.message;
  }
  return { businessId, planId, workspaceTemplateId: templateId, subscriptionStatus: business.subscription?.status ?? null, overrides: overridesOf(business), stored, valid: check.ok, problems: check.problems, recomputed, recomputeError };
}

// ---------- Users & memberships ----------

// The active-user limit from a VALID entitlement snapshot. A missing or
// malformed snapshot refuses the change instead of skipping the limit.
function userLimit(businessSnap, businessId) {
  const business = businessSnap.data();
  const check = validateEntitlementsSnapshot(business.entitlements, business.subscription?.planId, business.workspaceTemplateId);
  if (!check.ok) {
    throw new ProvisioningError("business-misconfigured", `Business ${businessId} entitlements are invalid (${check.problems.join("; ")}). Run recompute-entitlements.`);
  }
  return business.entitlements.limits.users;
}

// Phase 18: active-user warnings (80% / 100% of the effective limit, per
// usage episode, owners only) and a one-time note when an add / reactivate
// is refused at the limit.
function userLimitError(message, used, limit) {
  return Object.assign(new ProvisioningError("user-limit-reached", message), { details: { meterId: "activeUsers", used, limit } });
}
// "3 of 1 planning users are active. Existing members keep access; add
// capacity to invite more." Nobody is removed when a business is over its
// included users (an older business moved to the new products): only a NEW
// member waits for more capacity.
const SEAT_WORDS = { "bridal-expense": "planning users", "household-payroll": "family / admin users" };
function seatLimitMessage(businessSnap, used, limit) {
  const words = SEAT_WORDS[businessSnap.data()?.workspaceTemplateId] ?? "users";
  return `${used} of ${limit} ${words} are active. Existing members keep access; add capacity to invite more.`;
}
async function withUserLimitNote({ db, tenant, FieldValue }, run) {
  try {
    return await run();
  } catch (err) {
    if (err && err.code === "user-limit-reached" && err.details) await noteLimitReached({ db, tenant, FieldValue, ...err.details });
    throw err;
  }
}
async function prepareUserAlerts(tx, { tenant, businessSnap, usersUsage, activeAfter }) {
  const limit = effectiveLimit(businessSnap.exists ? businessSnap.data().entitlements : null, "users");
  const r = await prepareRunningAlerts(tx, { tenant, meterId: "activeUsers", state: usersUsage.exists ? usersUsage.data().alerts : null, used: activeAfter, limit });
  return {
    commit({ FieldValue }) {
      if (r.changed) tx.set(usageCurrentRef(tenant, "users"), { alerts: r.next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      r.notes.commit({ FieldValue });
    },
  };
}

// Finds the Firebase Auth user for an email, creating it if needed.
// A created user has NO password unless one is supplied (real onboarding
// sends a password-setup link instead — see passwordSetupLink()).
export async function ensureAuthUser({ auth, email, name, password = undefined }) {
  const cleanEmailValue = cleanEmail(email);
  try {
    const existing = await auth.getUserByEmail(cleanEmailValue);
    return { uid: existing.uid, email: cleanEmailValue, created: false };
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }
  try {
    const created = await auth.createUser({ email: cleanEmailValue, displayName: cleanName(name, "Name"), ...(password ? { password } : {}) });
    return { uid: created.uid, email: cleanEmailValue, created: true };
  } catch (err) {
    // Another request created it a moment ago (two provisioning retries).
    if (err.code !== "auth/email-already-exists") throw err;
    return { uid: (await auth.getUserByEmail(cleanEmailValue)).uid, email: cleanEmailValue, created: false };
  }
}

export async function passwordSetupLink({ auth, email, continueUrl = null }) {
  return auth.generatePasswordResetLink(cleanEmail(email), continueUrl ? { url: continueUrl } : undefined);
}

// Adds (or updates) a member of a business. Enforces the plan's user
// limit server-side, inside a transaction, counting ACTIVE members only.
export async function addMember({
  db,
  admin,
  businessId,
  uid,
  email,
  name,
  roleTemplate,
  permissionOverrides = {},
  isAccountOwner = false,
  status = "active",
  createdBy = "cli",
  audit = null,
  // Phase 18.6: server-set membership fields (the household staff link,
  // the activation state), written in the same transaction. Kept from the
  // existing membership when not given, so a role change keeps the link.
  extra = {},
  // Phase 18.6: optional (tx) => commit-function, run after this
  // transaction's reads: extra reads, then writes that must land with the
  // membership (e.g. linking the householdStaff record).
  within = null,
}) {
  if (!ROLE_TEMPLATES[roleTemplate]) throw new ProvisioningError("invalid-input", `Unknown role template: ${roleTemplate}`);
  if (!MEMBER_STATUSES.includes(status)) throw new ProvisioningError("invalid-input", `Unknown member status: ${status}`);
  const memberEmail = cleanEmail(email);
  const memberName = cleanName(name, "Name");
  const overrides = { grant: permissionOverrides.grant || [], revoke: permissionOverrides.revoke || [] };
  const permissions = resolvePermissions(roleTemplate, overrides);

  const tenant = tenantDb(db, businessId);
  const memberRef = tenant.member(uid);
  const userRef = db.collection("users").doc(uid);
  const FieldValue = admin.firestore.FieldValue;

  await withUserLimitNote({ db, tenant, FieldValue }, () => db.runTransaction(async (tx) => {
    const [businessSnap, memberSnap, userSnap, activeSnap, usersUsage] = await Promise.all([
      tx.get(tenant.ref),
      tx.get(memberRef),
      tx.get(userRef),
      tx.get(tenant.collection("members").where("status", "==", "active")),
      tx.get(usageCurrentRef(tenant, "users")),
    ]);

    if (!businessSnap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);

    // The user limit counts PAID SEATS: active members except a kasambahay's
    // own login (shared/plan-billing.js usesSeat), which never takes one.
    const seats = activeSnap.docs.filter((d) => d.id !== uid && usesSeat(d.data())).length;
    const seat = usesSeat({ roleTemplate });
    const wasSeat = memberSnap.exists && memberSnap.data().status === "active" && usesSeat(memberSnap.data());
    if (status === "active" && seat && !wasSeat) {
      const limit = userLimit(businessSnap, businessId);
      if (seats >= limit) {
        throw userLimitError(seatLimitMessage(businessSnap, seats, limit), seats, limit);
      }
    }
    const activeAfter = seats + (status === "active" && seat ? 1 : 0);
    const userAlerts = await prepareUserAlerts(tx, { tenant, businessSnap, usersUsage, activeAfter });
    const withinCommit = within ? await within(tx, { memberSnap, businessSnap }) : null;
    const kept = memberSnap.exists ? Object.fromEntries(["staffId", "activation", "invitedBy"].filter((k) => memberSnap.data()[k] !== undefined).map((k) => [k, memberSnap.data()[k]])) : {};

    if (audit) {
      const before = memberSnap.exists ? { roleTemplate: memberSnap.data().roleTemplate, status: memberSnap.data().status } : null;
      if (before && memberSnap.data().isAccountOwner && !isAccountOwner) throw new ProvisioningError("owner-protected", "The account owner's role can't be changed here.");
      writeAudit(tx, db, tenant, { type: before ? "member.updated" : "member.added", businessId, actor: audit.actor, reason: audit.reason ?? null, member: { uid, email: memberEmail }, before, after: { roleTemplate, status }, at: FieldValue.serverTimestamp() });
    }
    tx.set(memberRef, {
      uid,
      email: memberEmail,
      name: memberName,
      roleTemplate,
      permissionOverrides: overrides,
      permissions,
      isAccountOwner: Boolean(isAccountOwner),
      status,
      updatedAt: FieldValue.serverTimestamp(),
      // Re-adding an existing member keeps their own notification choices (Phase 13).
      ...(memberSnap.exists && memberSnap.data().notificationPreferences ? { notificationPreferences: memberSnap.data().notificationPreferences } : {}),
      ...(memberSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp(), createdBy }),
      ...kept,
      ...extra,
    });
    if (withinCommit) withinCommit();

    const profile = userSnap.exists ? userSnap.data() : {};
    tx.set(
      userRef,
      {
        email: memberEmail,
        name: memberName,
        businessIds: FieldValue.arrayUnion(businessId),
        ...(profile.defaultBusinessId ? {} : { defaultBusinessId: businessId }),
        updatedAt: FieldValue.serverTimestamp(),
        ...(userSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true }
    );
    userAlerts.commit({ FieldValue });
  }));

  return { businessId, uid, roleTemplate, status };
}

// Enables/disables a membership. The account owner can't be disabled
// here (owner protection is by flag, not by role name).
export async function setMemberStatus({ db, admin, businessId, uid, status, audit = null }) {
  if (!MEMBER_STATUSES.includes(status)) throw new ProvisioningError("invalid-input", `Unknown member status: ${status}`);
  const tenant = tenantDb(db, businessId);
  const memberRef = tenant.member(uid);

  const FieldValue = admin.firestore.FieldValue;
  await withUserLimitNote({ db, tenant, FieldValue }, () => db.runTransaction(async (tx) => {
    const [businessSnap, memberSnap, activeSnap, usersUsage] = await Promise.all([
      tx.get(tenant.ref),
      tx.get(memberRef),
      tx.get(tenant.collection("members").where("status", "==", "active")),
      tx.get(usageCurrentRef(tenant, "users")),
    ]);
    if (!memberSnap.exists) throw new ProvisioningError("not-found", `No membership for ${uid} in ${businessId}.`);
    const member = memberSnap.data();
    if (status === "disabled" && member.isAccountOwner) {
      throw new ProvisioningError("owner-protected", "The business owner's membership can't be disabled.");
    }
    const seats = activeSnap.docs.filter((d) => d.id !== uid && usesSeat(d.data())).length;
    if (status === "active" && member.status !== "active" && usesSeat(member)) {
      const limit = userLimit(businessSnap, businessId);
      if (seats >= limit) throw userLimitError(seatLimitMessage(businessSnap, seats, limit), seats, limit);
    }
    const activeAfter = seats + (status === "active" && usesSeat(member) ? 1 : 0);
    const userAlerts = await prepareUserAlerts(tx, { tenant, businessSnap, usersUsage, activeAfter });
    if (audit && member.status !== status) writeAudit(tx, db, tenant, { type: status === "active" ? "member.reactivated" : "member.deactivated", businessId, actor: audit.actor, reason: audit.reason ?? null, member: { uid, email: member.email ?? null }, before: { status: member.status }, after: { status }, at: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(memberRef, { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    userAlerts.commit({ FieldValue });
  }));
  return { businessId, uid, status };
}

// Owner-pilot cleanup (2026-10-13): removes a membership from ONE business
// for good (Remove user), as opposed to disabling it. In one transaction:
// the member document goes, this business leaves the person's
// users/{uid}.businessIds index (their default moves to another business
// they still belong to), a pending activation link is deleted, and the
// audit log keeps a snapshot. `within(tx, { member })` runs after the reads
// for linked records (the household staff link). The Firebase Auth account
// is NOT touched: it may belong to other businesses, and the membership
// document alone decides access (./tenant.js). The account owner and the
// last active owner can't be removed.
export async function removeMember({ db, admin, businessId, uid, audit = null, within = null }) {
  const tenant = tenantDb(db, businessId);
  const memberRef = tenant.member(uid);
  const userRef = db.collection("users").doc(uid);
  const FieldValue = admin.firestore.FieldValue;
  return db.runTransaction(async (tx) => {
    const [businessSnap, memberSnap, userSnap, ownersSnap, activeSnap, usersUsage] = await Promise.all([
      tx.get(tenant.ref),
      tx.get(memberRef),
      tx.get(userRef),
      tx.get(tenant.collection("members").where("roleTemplate", "==", "owner")),
      tx.get(tenant.collection("members").where("status", "==", "active")),
      tx.get(usageCurrentRef(tenant, "users")),
    ]);
    if (!businessSnap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
    if (!memberSnap.exists) return { businessId, uid, removed: false, alreadyRemoved: true };
    const member = memberSnap.data();
    if (member.isAccountOwner === true) throw new ProvisioningError("owner-protected", "The business owner can't be removed.");
    if (member.roleTemplate === "owner" && ownersSnap.docs.filter((d) => d.id !== uid && d.data().status === "active").length === 0) throw new ProvisioningError("owner-protected", "The last owner can't be removed.");
    const wasActive = member.status === "active";
    const seats = activeSnap.docs.filter((d) => usesSeat(d.data())).length;
    const userAlerts = await prepareUserAlerts(tx, { tenant, businessSnap, usersUsage, activeAfter: seats - (wasActive && usesSeat(member) ? 1 : 0) });
    const withinCommit = within ? await within(tx, { member }) : null;
    if (audit) writeAudit(tx, db, tenant, { type: "member.removed", businessId, actor: audit.actor, reason: audit.reason ?? null, member: { uid, email: member.email ?? null }, before: { roleTemplate: member.roleTemplate, status: member.status, name: member.name ?? null, staffId: member.staffId ?? null }, after: null, at: FieldValue.serverTimestamp() });
    tx.delete(memberRef);
    if (member.activation?.linkHash) tx.delete(db.collection("activationLinks").doc(member.activation.linkHash));
    if (userSnap.exists) {
      const profile = userSnap.data();
      const others = (Array.isArray(profile.businessIds) ? profile.businessIds : []).filter((id) => id !== businessId);
      tx.update(userRef, { businessIds: others, ...(profile.defaultBusinessId === businessId ? { defaultBusinessId: others[0] ?? null } : {}), updatedAt: FieldValue.serverTimestamp() });
    }
    if (withinCommit) withinCommit();
    userAlerts.commit({ FieldValue });
    return { businessId, uid, removed: true };
  });
}

// ---------- Permission resync (after permission keys or templates change) ----------

// Re-resolves every member's stored permission map from its role template +
// its own grant/revoke overrides, e.g. after a release adds permission keys
// to a template. Members whose template no longer exists are left untouched
// and reported. Writes one audit record per business with what changed.
export async function resyncMemberPermissions({ db, admin, businessId, actor = "cli", reason = "resync member permissions" }) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw new ProvisioningError("invalid-input", "A reason is required.");
  const tenant = tenantDb(db, businessId);
  const FieldValue = admin.firestore.FieldValue;

  return db.runTransaction(async (tx) => {
    const businessSnap = await tx.get(tenant.ref);
    if (!businessSnap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
    const members = await tx.get(tenant.collection("members"));

    const changes = [];
    const skipped = [];
    const updates = [];
    for (const doc of members.docs) {
      const member = doc.data();
      if (!ROLE_TEMPLATES[member.roleTemplate]) {
        skipped.push({ uid: doc.id, reason: `unknown role template ${JSON.stringify(member.roleTemplate)}` });
        continue;
      }
      let next;
      try {
        next = resolvePermissions(member.roleTemplate, member.permissionOverrides || {});
      } catch (err) {
        skipped.push({ uid: doc.id, reason: err.message });
        continue;
      }
      const current = member.permissions && typeof member.permissions === "object" ? member.permissions : {};
      const added = Object.keys(next).filter((k) => current[k] !== true).sort();
      const removed = Object.keys(current).filter((k) => !next[k]).sort();
      if (!added.length && !removed.length) continue;
      changes.push({ uid: doc.id, roleTemplate: member.roleTemplate, added, removed });
      updates.push([doc.ref, next]);
    }

    const now = FieldValue.serverTimestamp();
    for (const [ref, permissions] of updates) tx.update(ref, { permissions, updatedAt: now });
    if (changes.length) {
      const audit = { type: "permissions.resynced", businessId, actor: actor || "cli", reason: why, changes, skipped, at: now };
      tx.set(tenant.collection("auditLog").doc(), audit);
      tx.set(db.collection("platformAudit").doc(), audit);
    }
    return { businessId, changes, skipped };
  });
}

// ---------- Audit (tenant log + platform log, same record) ----------

function writeAudit(tx, db, tenant, record) {
  tx.set(tenant.collection("auditLog").doc(), record);
  tx.set(db.collection("platformAudit").doc(), record);
}

// ---------- Subscription status (Phase 17) ----------

// active / past_due / suspended / cancelled (shared/subscription.js decides
// what each allows). Manual for now (no payment gateway). Never deletes
// data; cancelled keeps everything for export and recovery.
export async function setSubscriptionStatus({ db, admin, businessId, status, actor, reason, expectedRevision = null }) {
  if (!SUBSCRIPTION_STATUSES.includes(status)) throw new ProvisioningError("invalid-input", `Unknown subscription status: ${status}`);
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw new ProvisioningError("invalid-input", "A reason is required for every subscription change.");
  const tenant = tenantDb(db, businessId);
  const FieldValue = admin.firestore.FieldValue;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tenant.ref);
    if (!snap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
    const business = snap.data();
    checkAdminRevision(business, expectedRevision);
    const previous = business.subscription?.status ?? null;
    if (previous === status) return { businessId, status, unchanged: true, adminRevision: adminRevisionOf(business) };
    const now = FieldValue.serverTimestamp();
    tx.update(tenant.ref, { "subscription.status": status, adminRevision: adminRevisionOf(business) + 1, updatedAt: now });
    writeAudit(tx, db, tenant, { type: "subscription.status-changed", summary: `Subscription ${previous} → ${status}`, businessId, actor: actor || "cli", reason: why, before: { status: previous }, after: { status }, at: now });
    return { businessId, status, previous, adminRevision: adminRevisionOf(business) + 1 };
  });
}

// ---------- General settings + tenant configuration (Phase 17) ----------

// Display name / timezone, on the business document (where the app reads
// them). A timezone change doesn't move records already dated.
export async function updateBusinessGeneral({ db, admin, businessId, changes, actor, reason, expectedRevision = null }) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new ProvisioningError("invalid-input", "Nothing to change.");
  for (const k of Object.keys(changes)) if (!["name", "timezone"].includes(k)) throw new ProvisioningError("invalid-input", `${k} can't be changed here.`);
  const next = {};
  if ("name" in changes) next.name = cleanName(changes.name, "Business name");
  if ("timezone" in changes) {
    assertTimezone(changes.timezone);
    next.timezone = changes.timezone;
  }
  const why = typeof reason === "string" && reason.trim().length >= 3 ? reason.trim() : "General settings updated";
  const tenant = tenantDb(db, businessId);
  const FieldValue = admin.firestore.FieldValue;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tenant.ref);
    if (!snap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
    const business = snap.data();
    checkAdminRevision(business, expectedRevision);
    const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => business[k] !== v));
    if (!Object.keys(diff).length) return { businessId, unchanged: true, adminRevision: adminRevisionOf(business) };
    const now = FieldValue.serverTimestamp();
    tx.update(tenant.ref, { ...diff, ...("name" in diff ? { nameLower: diff.name.toLocaleLowerCase("en") } : {}), adminRevision: adminRevisionOf(business) + 1, updatedAt: now });
    writeAudit(tx, db, tenant, { type: "business.general-updated", businessId, actor: actor || "cli", reason: why, before: Object.fromEntries(Object.keys(diff).map((k) => [k, business[k] ?? null])), after: diff, at: now });
    return { businessId, ...diff, adminRevision: adminRevisionOf(business) + 1 };
  });
}

// Controlled terminology (shared/tenant-config.js): only the workspace's
// own terms, only listed options.
export async function setTenantTerminology({ db, admin, businessId, terminology, actor, reason }) {
  const tenant = tenantDb(db, businessId);
  const FieldValue = admin.firestore.FieldValue;
  const ref = tenant.doc("settings", TENANT_CONFIG_DOC_ID);
  return db.runTransaction(async (tx) => {
    const [bSnap, cSnap] = await Promise.all([tx.get(tenant.ref), tx.get(ref)]);
    if (!bSnap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
    let change;
    try {
      change = validateTerminologyChange(bSnap.data().workspaceTemplateId, terminology);
    } catch (err) {
      throw new ProvisioningError("invalid-input", err.message);
    }
    const before = cSnap.exists && cSnap.data().terminology ? cSnap.data().terminology : {};
    const after = { ...before, ...change };
    const now = FieldValue.serverTimestamp();
    tx.set(ref, { version: TENANT_CONFIG_VERSION, terminology: after, updatedAt: now }, { merge: true });
    writeAudit(tx, db, tenant, { type: "tenant-config.updated", businessId, actor: actor || "cli", reason: typeof reason === "string" && reason.trim().length >= 3 ? reason.trim() : "Terminology updated", before: { terminology: before }, after: { terminology: after }, at: now });
    return { businessId, terminology: after };
  });
}

// ---------- One-step, retry-safe tenant provisioning (Phase 17) ----------

// Business + owner account + owner membership + default configuration +
// audit, as ONE idempotent workflow (the console's "Create business" and
// scripts/create-business.js both call it). Auth user creation can't join
// a Firestore transaction, so progress is tracked in
// provisioning/{businessId} (server-only):
//   started -> complete
// Every step is idempotent, so a retry (double click, network retry, a
// concurrent request for the same id) resumes and converges on ONE
// business, ONE owner membership, ONE "business.created" audit. The same
// id with a DIFFERENT request is refused (business-exists), and so is an id
// already used by a business created any other way.
const fingerprintOf = (r) => ({ name: r.name, workspaceTemplateId: r.workspaceTemplateId, planId: r.planId, ownerEmail: r.ownerEmail, timezone: r.timezone });
const sameRequest = (a, b) => JSON.stringify(fingerprintOf(a)) === JSON.stringify(fingerprintOf(b));

export async function provisionBusiness({ db, admin, auth, request, actor = "cli", isDemo = false }) {
  const req = { ...request, ownerEmail: cleanEmail(request.ownerEmail), name: cleanName(request.name, "Business name"), timezone: request.timezone || "Asia/Manila" };
  if (!isValidBusinessId(req.businessId)) throw new ProvisioningError("invalid-input", `Invalid business id: ${req.businessId}`);
  assertTimezone(req.timezone);
  requireTemplate(req.workspaceTemplateId);
  await loadPlan(db, req.planId);
  const pRef = db.collection("provisioning").doc(req.businessId);
  const bRef = db.collection("businesses").doc(req.businessId);
  const FieldValue = admin.firestore.FieldValue;

  // 1. Claim the id (or resume our own earlier attempt).
  const claim = await db.runTransaction(async (tx) => {
    const [p, b] = await Promise.all([tx.get(pRef), tx.get(bRef)]);
    if (p.exists) {
      if (!sameRequest(p.data().request, req)) throw new ProvisioningError("business-exists", `Business ID ${req.businessId} is already taken.`);
      return p.data();
    }
    if (b.exists) throw new ProvisioningError("business-exists", `Business ID ${req.businessId} is already taken.`);
    const rec = { request: fingerprintOf(req), status: "started", actor, startedAt: FieldValue.serverTimestamp() };
    tx.create(pRef, rec);
    return rec;
  });
  if (claim.status === "complete") return { businessId: req.businessId, ownerUid: claim.ownerUid, ownerCreated: false, alreadyProvisioned: true };

  // 2. The business (create() never overwrites; "exists" here = our own retry).
  try {
    await createBusiness({ db, admin, name: req.name, planId: req.planId, workspaceTemplateId: req.workspaceTemplateId, timezone: req.timezone, businessId: req.businessId, isDemo, createdBy: actor, termMonths: req.termMonths ?? null, priceOverride: req.priceOverride ?? null, addOns: req.addOns ?? {}, setupFee: req.setupFee ?? null, waiveSetupFee: req.waiveSetupFee === true, trial: req.trial === true });
  } catch (err) {
    if (!(err instanceof ProvisioningError && err.code === "business-exists")) throw err;
    const existing = (await bRef.get()).data();
    if (existing.workspaceTemplateId !== req.workspaceTemplateId) throw new ProvisioningError("business-exists", `Business ID ${req.businessId} is already taken.`);
  }

  // 3. The owner's account (found or created, without a password).
  const owner = await ensureAuthUser({ auth, email: req.ownerEmail, name: req.ownerName || req.ownerEmail });

  // 4. The owner membership (an idempotent set: never a second one).
  await addMember({ db, admin, businessId: req.businessId, uid: owner.uid, email: owner.email, name: req.ownerName || req.ownerEmail, roleTemplate: "owner", isAccountOwner: true, createdBy: actor });

  // 5. Default configuration + 6. complete, audited exactly once.
  const tenant = tenantDb(db, req.businessId);
  const configRef = tenant.doc("settings", TENANT_CONFIG_DOC_ID);
  // Only the request that completes provisioning reports it as created
  // (concurrent duplicates that resumed the same claim report "already").
  const completedHere = await db.runTransaction(async (tx) => {
    const [p, c] = await Promise.all([tx.get(pRef), tx.get(configRef)]);
    if (!c.exists) tx.create(configRef, { version: TENANT_CONFIG_VERSION, terminology: {}, createdAt: FieldValue.serverTimestamp() });
    if (p.data().status === "complete") return false;
    const now = FieldValue.serverTimestamp();
    tx.update(pRef, { status: "complete", ownerUid: owner.uid, completedAt: now });
    writeAudit(tx, db, tenant, { type: "business.created", summary: `Business created: ${req.name} (${req.workspaceTemplateId}, ${req.planId})`, businessId: req.businessId, actor, reason: "Provisioned", before: null, after: { ...fingerprintOf(req), ownerUid: owner.uid }, at: now });
    return true;
  });
  return { businessId: req.businessId, ownerUid: owner.uid, ownerCreated: owner.created, alreadyProvisioned: !completedHere };
}

// ---------- Luna operators (Phase 17) ----------

// operators/{uid}: { email, name, role, status } - server-only, never
// readable from the browser. Granted / disabled by the CLI
// (scripts/set-operator.js); the console can't create operators.
export async function setOperator({ db, admin, auth, email, name = null, role = "superadmin", status = "active", actor = "cli", reason }) {
  if (!Object.hasOwn(OPERATOR_ROLES, role)) throw new ProvisioningError("invalid-input", `Unknown operator role: ${role}`);
  if (!OPERATOR_STATUSES.includes(status)) throw new ProvisioningError("invalid-input", `Unknown operator status: ${status}`);
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw new ProvisioningError("invalid-input", "A reason is required.");
  const user = await auth.getUserByEmail(cleanEmail(email)).catch(() => null);
  if (!user) throw new ProvisioningError("not-found", `No Luna account for ${email}. Create the account first.`);
  const ref = db.collection("operators").doc(user.uid);
  const FieldValue = admin.firestore.FieldValue;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const before = snap.exists ? { role: snap.data().role, status: snap.data().status } : null;
    // A re-run that changes nothing (e.g. only to resend the password
    // email) writes nothing and isn't audited again.
    if (before && before.role === role && before.status === status && (!name || name === snap.data().name)) return { uid: user.uid, email: user.email, role, status, changed: false };
    const now = FieldValue.serverTimestamp();
    tx.set(ref, { email: user.email, name: name || user.displayName || user.email, role, status, updatedAt: now, ...(snap.exists ? {} : { createdAt: now }) }, { merge: true });
    tx.set(db.collection("platformAudit").doc(), { type: "operator.updated", operator: { uid: user.uid, email: user.email }, actor, reason: why, before, after: { role, status }, at: now });
    return { uid: user.uid, email: user.email, role, status, changed: true };
  });
}

// Firebase Auth's own password-reset email (Identity Toolkit sendOobCode
// with the public web API key): how an operator sets or resets a password.
// Nothing secret is returned; Firebase delivers the link.
export async function sendPasswordSetupEmail({ email, apiKey, siteUrl = null, fetchImpl = fetch }) {
  if (!apiKey) throw new ProvisioningError("invalid-input", "VITE_FIREBASE_API_KEY is not set in the env file.");
  const continueUrl = siteUrl ? `${siteUrl.replace(/\/$/, "")}/console/` : undefined;
  const r = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestType: "PASSWORD_RESET", email: cleanEmail(email), ...(continueUrl ? { continueUrl } : {}) }) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new ProvisioningError("email-failed", `Firebase didn't send the password email (${r.status} ${j.error?.message ?? ""}).`);
  }
}

// scripts/set-operator.js: optionally create the Luna account (no password,
// no business), grant / change operator access, optionally have Firebase
// email a password-setup link.
export async function bootstrapOperator({ db, admin, auth, email, name = null, status = "active", actor = "cli", reason, createAccount = false, sendPasswordEmail = false, apiKey = null, siteUrl = null, fetchImpl = fetch }) {
  const account = createAccount ? await ensureAuthUser({ auth, email, name: name || cleanEmail(email) }) : null;
  const operator = await setOperator({ db, admin, auth, email, name, status, actor, reason });
  if (sendPasswordEmail) await sendPasswordSetupEmail({ email: operator.email, apiKey, siteUrl, fetchImpl });
  return { account, operator, passwordEmailSent: Boolean(sendPasswordEmail) };
}
