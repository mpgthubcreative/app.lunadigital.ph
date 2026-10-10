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

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireOperator, overview, listBusinesses, businessDetail, listAudit, listPlans, creatableWorkspaces, usageOverview } from "./_lib/operator.js";
import { provisionBusiness, assignPlan, updateOverrides, setLimitOverride, setSubscriptionStatus, addMember, setMemberStatus, updateBusinessGeneral, setTenantTerminology, ensureAuthUser, passwordSetupLink, ProvisioningError } from "./_lib/provisioning.js";
import { tenantDb } from "./_lib/tenant-db.js";
import { OperatorError, validateCreateBusinessInput, validateSubscriptionStatus, validateReason, overrideChange } from "../../shared/operators.js";
import { ROLE_TEMPLATES } from "../../shared/permissions.js";
import { isValidBusinessId } from "../../shared/tenancy.js";

const STATUS = {
  "invalid-input": 400,
  "reason-required": 400,
  "not-overridable": 400,
  "unknown-plan": 400,
  "unknown-template": 400,
  "not-found": 404,
  "business-exists": 409,
  stale: 409,
  "owner-protected": 409,
  "user-limit-reached": 409,
  "business-misconfigured": 409,
};

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
  overview: { fields: [], run: async ({ db }) => ({ overview: await overview({ db, planIds: (await listPlans({ db })).map((p) => p.id) }) }) },
  plans: { fields: [], run: async ({ db }) => ({ plans: await listPlans({ db }) }) },
  listBusinesses: { fields: ["filters", "after"], run: async ({ db, admin }, b) => listBusinesses({ db, FieldPath: admin.firestore.FieldPath, filters: b.filters && typeof b.filters === "object" && !Array.isArray(b.filters) ? b.filters : {}, after: b.after ?? null }) },
  business: { fields: ["businessId"], run: async ({ db }, b) => businessDetail({ db, businessId: b.businessId }) },
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
  changePlan: {
    fields: ["businessId", "planId", "reason", "expectedRevision"],
    run: async ({ db, admin, op }, b) => {
      const r = await assignPlan({ db, admin, businessId: bid(b.businessId), planId: b.planId, actor: actorOf(op), reason: validateReason(b.reason), expectedRevision: rev(b.expectedRevision) });
      return { planId: r.planId, warnings: r.warnings, adminRevision: r.adminRevision };
    },
  },
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
    const { db, auth, admin } = await loadAdmin();
    // Operator first: a non-operator learns nothing from validation.
    const op = await requireOperator(event, { db, auth });
    if (bodyError) throw bodyError;
    const action = body && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    for (const k of Object.keys(body)) if (k !== "action" && !action.fields.includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
    try {
      return respond(200, { success: true, ...(await action.run({ db, auth, admin, op }, body)) });
    } catch (err) {
      if (err instanceof ProvisioningError || err instanceof OperatorError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createOperatorHandler({ getAdmin });
