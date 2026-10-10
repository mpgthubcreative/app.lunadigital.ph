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

import { PLAN_SEED } from "../../../shared/plans.seed.js";
import { computeEntitlements, validatePlan, validateEntitlementsSnapshot, isValidPlanId, EntitlementError } from "../../../shared/entitlements.js";
import { resolvePermissions, ROLE_TEMPLATES } from "../../../shared/permissions.js";
import { SUBSCRIPTION_STATUSES } from "../../../shared/subscription.js";
import { MEMBER_STATUSES, isValidBusinessId } from "../../../shared/tenancy.js";
import { tenantDb } from "./tenant-db.js";
import { getWorkspaceTemplate, WORKSPACE_TEMPLATE_IDS } from "../../../shared/workspaces.js";
import { OPERATOR_ROLES, OPERATOR_STATUSES } from "../../../shared/operators.js";
import { TENANT_CONFIG_VERSION, TENANT_CONFIG_DOC_ID, validateTerminologyChange } from "../../../shared/tenant-config.js";

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
export function buildEntitlementsSnapshot(plan, overrides, workspaceTemplateId) {
  try {
    return computeEntitlements(plan, overrides, workspaceTemplateId);
  } catch (err) {
    if (err instanceof EntitlementError) throw new ProvisioningError("invalid-input", err.message);
    throw err;
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
      subscription: { planId: plan.id, status: subscriptionStatus, renewalAt: null, graceUntil: null },
      moduleOverrides: {},
      limitOverrides: {},
      featureOverrides: {},
      entitlements: { ...buildEntitlementsSnapshot(plan, {}, template.id), computedAt: now },
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

// The one write path for a business's plan / overrides / workspace
// template / snapshot. mutate({ planId, overrides, templateId }) returns
// the next state. A business without a workspace template (pre-8.5) can
// only be given one (assignWorkspaceTemplate); nothing else recomputes it.
async function changeEntitlements({ db, admin, businessId, actor, reason, action, mutate, expectedRevision = null }) {
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
    // Validates the plan, the overrides and the template ceiling; throws on
    // anything unknown or not allowed.
    const entitlements = buildEntitlementsSnapshot(plan, next.overrides, template.id);
    const overrides = { modules: { ...next.overrides.modules }, limits: { ...next.overrides.limits }, features: { ...next.overrides.features } };
    const activeMembers = (await tx.get(tenant.collection("members").where("status", "==", "active"))).size;

    const now = FieldValue.serverTimestamp();
    tx.update(tenant.ref, {
      "subscription.planId": plan.id,
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
      ...(templateMoved ? { summary: current.templateId === null ? `Workspace template assigned: ${template.id}` : `Workspace template changed: ${current.templateId} → ${template.id}` } : {}),
      businessId,
      actor: who,
      reason: why,
      before: { planId: current.planId, workspaceTemplateId: current.templateId, overrides: current.overrides, entitlements: summarize(business.entitlements) },
      after: { planId: plan.id, workspaceTemplateId: template.id, overrides, entitlements: summarize(entitlements) },
      at: now,
    };
    tx.set(tenant.collection("auditLog").doc(), audit);
    tx.set(db.collection("platformAudit").doc(), audit);

    const warnings = [];
    if (activeMembers > entitlements.limits.users) {
      warnings.push(`${activeMembers} active users exceed the new limit of ${entitlements.limits.users}. Nobody is removed; adding or re-enabling members is blocked until it's back under the limit.`);
    }
    return { businessId, planId: plan.id, workspaceTemplateId: template.id, previousWorkspaceTemplateId: current.templateId, overrides, entitlements, warnings, adminRevision: adminRevisionOf(business) + 1 };
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
    recomputed = buildEntitlementsSnapshot(await loadPlan(db, planId), overridesOf(business), requireTemplate(templateId).id);
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

  await db.runTransaction(async (tx) => {
    const [businessSnap, memberSnap, userSnap, activeSnap] = await Promise.all([
      tx.get(tenant.ref),
      tx.get(memberRef),
      tx.get(userRef),
      tx.get(tenant.collection("members").where("status", "==", "active")),
    ]);

    if (!businessSnap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);

    const wasActive = memberSnap.exists && memberSnap.data().status === "active";
    if (status === "active" && !wasActive) {
      const limit = userLimit(businessSnap, businessId);
      if (activeSnap.size >= limit) {
        throw new ProvisioningError("user-limit-reached", `Business ${businessId} already has ${activeSnap.size}/${limit} active users.`);
      }
    }

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
    });

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
  });

  return { businessId, uid, roleTemplate, status };
}

// Enables/disables a membership. The account owner can't be disabled
// here (owner protection is by flag, not by role name).
export async function setMemberStatus({ db, admin, businessId, uid, status, audit = null }) {
  if (!MEMBER_STATUSES.includes(status)) throw new ProvisioningError("invalid-input", `Unknown member status: ${status}`);
  const tenant = tenantDb(db, businessId);
  const memberRef = tenant.member(uid);

  await db.runTransaction(async (tx) => {
    const [businessSnap, memberSnap, activeSnap] = await Promise.all([
      tx.get(tenant.ref),
      tx.get(memberRef),
      tx.get(tenant.collection("members").where("status", "==", "active")),
    ]);
    if (!memberSnap.exists) throw new ProvisioningError("not-found", `No membership for ${uid} in ${businessId}.`);
    const member = memberSnap.data();
    if (status === "disabled" && member.isAccountOwner) {
      throw new ProvisioningError("owner-protected", "The business owner's membership can't be disabled.");
    }
    if (status === "active" && member.status !== "active") {
      const limit = userLimit(businessSnap, businessId);
      if (activeSnap.size >= limit) throw new ProvisioningError("user-limit-reached", `User limit reached (${activeSnap.size}/${limit}).`);
    }
    if (audit && member.status !== status) writeAudit(tx, db, tenant, { type: status === "active" ? "member.reactivated" : "member.deactivated", businessId, actor: audit.actor, reason: audit.reason ?? null, member: { uid, email: member.email ?? null }, before: { status: member.status }, after: { status }, at: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(memberRef, { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { businessId, uid, status };
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
    await createBusiness({ db, admin, name: req.name, planId: req.planId, workspaceTemplateId: req.workspaceTemplateId, timezone: req.timezone, businessId: req.businessId, isDemo, createdBy: actor });
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
  await db.runTransaction(async (tx) => {
    const [p, c] = await Promise.all([tx.get(pRef), tx.get(configRef)]);
    if (!c.exists) tx.create(configRef, { version: TENANT_CONFIG_VERSION, terminology: {}, createdAt: FieldValue.serverTimestamp() });
    if (p.data().status === "complete") return;
    const now = FieldValue.serverTimestamp();
    tx.update(pRef, { status: "complete", ownerUid: owner.uid, completedAt: now });
    writeAudit(tx, db, tenant, { type: "business.created", summary: `Business created: ${req.name} (${req.workspaceTemplateId}, ${req.planId})`, businessId: req.businessId, actor, reason: "Provisioned", before: null, after: { ...fingerprintOf(req), ownerUid: owner.uid }, at: now });
  });
  return { businessId: req.businessId, ownerUid: owner.uid, ownerCreated: owner.created, alreadyProvisioned: false };
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
    const now = FieldValue.serverTimestamp();
    tx.set(ref, { email: user.email, name: name || user.displayName || user.email, role, status, updatedAt: now, ...(snap.exists ? {} : { createdAt: now }) }, { merge: true });
    tx.set(db.collection("platformAudit").doc(), { type: "operator.updated", operator: { uid: user.uid, email: user.email }, actor, reason: why, before, after: { role, status }, at: now });
    return { uid: user.uid, email: user.email, role, status };
  });
}
