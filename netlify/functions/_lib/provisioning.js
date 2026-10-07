// Tenant provisioning: plans, businesses, memberships. Used today by the
// operator CLI scripts (scripts/), and later by Super Admin functions.
// Server-only: these writes bypass Firestore rules via the Admin SDK, so
// every invariant (valid plan, user limit, owner protection) is enforced
// right here.

import { PLAN_SEED } from "../../../shared/plans.seed.js";
import { computeEntitlements } from "../../../shared/entitlements.js";
import { resolvePermissions, ROLE_TEMPLATES } from "../../../shared/permissions.js";
import { SUBSCRIPTION_STATUSES } from "../../../shared/subscription.js";
import { MEMBER_STATUSES, isValidBusinessId } from "../../../shared/tenancy.js";
import { tenantDb } from "./tenant-db.js";

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

export async function loadPlan(db, planId) {
  const snap = await db.collection("plans").doc(String(planId)).get();
  if (!snap.exists) throw new ProvisioningError("unknown-plan", `Plan "${planId}" does not exist. Run the plan seed first.`);
  return snap.data();
}

export function buildEntitlementsSnapshot(plan, overrides = {}) {
  return { ...computeEntitlements(plan, overrides), planName: plan.name };
}

// ---------- Businesses ----------

export async function createBusiness({
  db,
  admin,
  name,
  planId,
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
      subscription: { planId: plan.id, status: subscriptionStatus, renewalAt: null, graceUntil: null },
      moduleOverrides: {},
      limitOverrides: {},
      featureOverrides: {},
      entitlements: { ...buildEntitlementsSnapshot(plan), computedAt: now },
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

// Recomputes the stored entitlements snapshot from the current plan +
// the business's overrides. Call after any plan or override change.
export async function refreshEntitlements({ db, admin, businessId }) {
  const ref = tenantDb(db, businessId).ref;
  const snap = await ref.get();
  if (!snap.exists) throw new ProvisioningError("not-found", `Business ${businessId} not found.`);
  const business = snap.data();
  const plan = await loadPlan(db, business.subscription.planId);
  const entitlements = buildEntitlementsSnapshot(plan, {
    modules: business.moduleOverrides || {},
    limits: business.limitOverrides || {},
    features: business.featureOverrides || {},
  });
  await ref.update({ entitlements: { ...entitlements, computedAt: admin.firestore.FieldValue.serverTimestamp() }, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return entitlements;
}

// ---------- Users & memberships ----------

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
      const limit = businessSnap.data().entitlements?.limits?.users;
      if (!Number.isInteger(limit)) throw new ProvisioningError("business-misconfigured", `Business ${businessId} has no user limit.`);
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
      const limit = businessSnap.data().entitlements?.limits?.users;
      if (activeSnap.size >= limit) throw new ProvisioningError("user-limit-reached", `User limit reached (${activeSnap.size}/${limit}).`);
    }
    tx.update(memberRef, { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { businessId, uid, status };
}
