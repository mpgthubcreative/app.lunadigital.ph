// Tenant provisioning: plans, businesses, memberships. Used today by the
// operator CLI scripts (scripts/), and later by Super Admin functions.
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
      timezone,
      currency,
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
async function changeEntitlements({ db, admin, businessId, actor, reason, action, mutate }) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw new ProvisioningError("invalid-input", "A reason is required for every plan or entitlement change.");
  const who = typeof actor === "string" && actor.trim() ? actor.trim() : "cli";

  const tenant = tenantDb(db, businessId);
  const FieldValue = admin.firestore.FieldValue;

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tenant.ref);
    if (!snap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
    const business = snap.data();
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
    return { businessId, planId: plan.id, workspaceTemplateId: template.id, previousWorkspaceTemplateId: current.templateId, overrides, entitlements, warnings };
  });
}

// Moves a business to another plan (or re-applies its current one).
// Overrides are kept.
export async function assignPlan({ db, admin, businessId, planId, actor, reason }) {
  return changeEntitlements({ db, admin, businessId, actor, reason, action: "plan-assigned", mutate: (state) => ({ ...state, planId }) });
}

// set:   { modules?: {id: bool}, limits?: {key: int}, features?: {key: value} }
// clear: { modules?: [id], limits?: [key], features?: [key] }  (back to the plan default)
export async function updateOverrides({ db, admin, businessId, set = {}, clear = {}, actor, reason }) {
  for (const section of [...Object.keys(set), ...Object.keys(clear)]) {
    if (!(section in OVERRIDE_SECTIONS)) throw new ProvisioningError("invalid-input", `Unknown override section: ${section}`);
  }
  return changeEntitlements({
    db,
    admin,
    businessId,
    actor,
    reason,
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
  const created = await auth.createUser({ email: cleanEmailValue, displayName: cleanName(name, "Name"), ...(password ? { password } : {}) });
  return { uid: created.uid, email: cleanEmailValue, created: true };
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
export async function setMemberStatus({ db, admin, businessId, uid, status }) {
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
