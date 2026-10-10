// Luna Super Admin (Phase 17), server side: who is an operator, and the
// cross-tenant read models the console shows. Mutations go through the
// shared provisioning library (./provisioning.js), never through here.
//
// Authorization: a verified ID token AND an active operators/{uid} record
// (server-only, never browser-readable). Business membership, roles, email
// domains, claims, query parameters and client flags count for nothing.

import { RequestError } from "./http.js";
import { authenticate } from "./auth.js";
import { tenantDb } from "./tenant-db.js";
import { monthKey } from "./usage.js";
import { isActiveOperator, moduleTable, overridableModules, creatableWorkspaces } from "../../../shared/operators.js";
import { SUBSCRIPTION_STATUSES } from "../../../shared/subscription.js";
import { WORKSPACE_TEMPLATE_IDS, getWorkspaceTemplate } from "../../../shared/workspaces.js";
import { validateEntitlementsSnapshot } from "../../../shared/entitlements.js";
import { isValidBusinessId } from "../../../shared/tenancy.js";
import { resolveTenantConfig, termsFor, TENANT_CONFIG_DOC_ID } from "../../../shared/tenant-config.js";
import { METERS, MONTHLY_METER_IDS, limitRows, meterApplies, isEnforced, RECORD_CREATION_METER_IDS } from "../../../shared/metering.js";
import { readCurrentUsage, readUsageHistory } from "./metering.js";

// One answer for "not an operator", "disabled operator" and "unknown role".
const NOT_OPERATOR = () => new RequestError("not-operator", "This area is for Luna staff only.", 403);

export async function requireOperator(event, { db, auth }) {
  const user = await authenticate(event, auth);
  const snap = await db.collection("operators").doc(user.uid).get();
  if (!snap.exists || !isActiveOperator(snap.data())) throw NOT_OPERATOR();
  const op = snap.data();
  return { uid: user.uid, email: op.email || user.email, name: op.name || user.name || user.email, role: op.role };
}

const PAGE = 25;
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const ts = (v) => (v && typeof v.toDate === "function" ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : null);

// ---------- Overview ----------

// Small operational counts (server-side count() queries; nothing is
// downloaded): total, per subscription status, per workspace, per plan.
export async function overview({ db, planIds }) {
  const col = db.collection("businesses");
  const count = async (q) => (await q.count().get()).data().count;
  const [total, statuses, workspaces, plans] = await Promise.all([
    count(col),
    Promise.all(SUBSCRIPTION_STATUSES.map(async (s) => [s, await count(col.where("subscription.status", "==", s))])),
    Promise.all(WORKSPACE_TEMPLATE_IDS.map(async (w) => [w, await count(col.where("workspaceTemplateId", "==", w))])),
    Promise.all(planIds.map(async (p) => [p, await count(col.where("subscription.planId", "==", p))])),
  ]);
  return { total, byStatus: Object.fromEntries(statuses), byWorkspace: Object.fromEntries(workspaces), byPlan: Object.fromEntries(plans) };
}

// ---------- Businesses (paginated, filtered, never a full scan) ----------

const FILTER_FIELDS = { workspaceTemplateId: "workspaceTemplateId", planId: "subscription.planId", status: "subscription.status" };

async function rowsWithOwners(db, docs, timezoneDefault = "Asia/Manila") {
  return Promise.all(
    docs.map(async (d) => {
      const b = d.data();
      const tenant = tenantDb(db, d.id);
      const [owner, usage] = await Promise.all([tenant.collection("members").where("isAccountOwner", "==", true).limit(1).get(), tenant.doc("usage", monthKey(b.timezone || timezoneDefault)).get()]);
      const u = usage.exists ? usage.data() : {};
      return {
        id: d.id,
        name: b.name,
        workspaceTemplateId: b.workspaceTemplateId ?? null,
        workspaceTemplateVersion: b.entitlements?.workspaceTemplateVersion ?? null,
        planId: b.subscription?.planId ?? null,
        status: b.subscription?.status ?? null,
        owner: owner.empty ? null : { email: owner.docs[0].data().email, status: owner.docs[0].data().status },
        createdAt: ts(b.createdAt),
        usage: { orders: int(u.ordersCreated), imports: int(u.excelImports), exports: int(u.exportsGenerated) },
      };
    })
  );
}

// filters: { workspaceTemplateId?, planId?, status?, search? }, after: a business id.
// Ordered by business id. A search matches the id prefix or the name
// prefix (businesses created before Phase 17 match by id until renamed),
// shows its first matches and honours the other filters.
export async function listBusinesses({ db, FieldPath, filters = {}, after = null }) {
  for (const k of Object.keys(filters)) if (!["workspaceTemplateId", "planId", "status", "search"].includes(k)) throw new RequestError("invalid-request", `Unknown filter ${k}.`, 400);
  if (filters.workspaceTemplateId && !WORKSPACE_TEMPLATE_IDS.includes(filters.workspaceTemplateId)) throw new RequestError("invalid-request", "Unknown workspace.", 400);
  if (filters.status && !SUBSCRIPTION_STATUSES.includes(filters.status)) throw new RequestError("invalid-request", "Unknown status.", 400);
  if (filters.planId && (typeof filters.planId !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(filters.planId))) throw new RequestError("invalid-request", "Unknown plan.", 400);
  const col = db.collection("businesses");
  const keep = (b) => Object.entries(FILTER_FIELDS).every(([k, path]) => !filters[k] || path.split(".").reduce((o, p) => o?.[p], b) === filters[k]);
  const term = typeof filters.search === "string" ? filters.search.trim().toLocaleLowerCase("en").slice(0, 60) : "";
  if (term) {
    const end = `${term}`;
    const [byId, byName] = await Promise.all([col.where(FieldPath.documentId(), ">=", term).where(FieldPath.documentId(), "<=", end).limit(PAGE).get(), col.where("nameLower", ">=", term).where("nameLower", "<=", end).orderBy("nameLower").limit(PAGE).get()]);
    const seen = new Map();
    for (const d of [...byId.docs, ...byName.docs]) if (!seen.has(d.id) && keep(d.data())) seen.set(d.id, d);
    const docs = [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, PAGE);
    return { rows: await rowsWithOwners(db, docs), next: null };
  }
  let q = col;
  for (const [k, path] of Object.entries(FILTER_FIELDS)) if (filters[k]) q = q.where(path, "==", filters[k]);
  q = q.orderBy(FieldPath.documentId());
  if (after !== null) {
    if (!isValidBusinessId(after)) throw new RequestError("invalid-request", "Invalid cursor.", 400);
    q = q.startAfter(after);
  }
  const snap = await q.limit(PAGE + 1).get();
  const docs = snap.docs.slice(0, PAGE);
  return { rows: await rowsWithOwners(db, docs), next: snap.docs.length > PAGE ? docs.at(-1).id : null };
}

// ---------- One business ----------

export async function businessDetail({ db, businessId }) {
  if (!isValidBusinessId(businessId)) throw new RequestError("not-found", "Business not found.", 404);
  const tenant = tenantDb(db, businessId);
  const snap = await tenant.ref.get();
  if (!snap.exists) throw new RequestError("not-found", "Business not found.", 404);
  const b = snap.data();
  const planId = b.subscription?.planId ?? null;
  const [planSnap, members, usageSnap, audit, config, prov] = await Promise.all([
    planId ? db.collection("plans").doc(planId).get() : null,
    tenant.collection("members").limit(100).get(),
    tenant.doc("usage", monthKey(b.timezone || "Asia/Manila")).get(),
    db.collection("platformAudit").where("businessId", "==", businessId).orderBy("at", "desc").limit(25).get(),
    tenant.doc("settings", TENANT_CONFIG_DOC_ID).get(),
    db.collection("provisioning").doc(businessId).get(),
  ]);
  // Phase 18: every meter's current value, limits (plan / override /
  // effective / current) and the last 12 months.
  const [current, history] = await Promise.all([readCurrentUsage(tenant, b.timezone || "Asia/Manila"), readUsageHistory(tenant, b.timezone || "Asia/Manila")]);
  const plan = planSnap && planSnap.exists ? planSnap.data() : null;
  const check = validateEntitlementsSnapshot(b.entitlements, planId, b.workspaceTemplateId);
  const template = getWorkspaceTemplate(b.workspaceTemplateId);
  const u = usageSnap.exists ? usageSnap.data() : {};
  const activeMembers = members.docs.filter((d) => d.data().status === "active").length;
  return {
    business: {
      id: businessId,
      name: b.name,
      timezone: b.timezone,
      currency: b.currency,
      workspaceTemplateId: b.workspaceTemplateId ?? null,
      workspaceName: template?.name ?? null,
      workspaceTemplateVersion: b.entitlements?.workspaceTemplateVersion ?? null,
      currentTemplateVersion: template?.version ?? null,
      planId,
      planName: plan?.name ?? null,
      status: b.subscription?.status ?? null,
      createdAt: ts(b.createdAt),
      createdBy: b.createdBy ?? null,
      adminRevision: Number.isSafeInteger(b.adminRevision) ? b.adminRevision : 0,
      entitlementsValid: check.ok,
      entitlementProblems: check.problems,
      provisioning: prov.exists ? prov.data().status : null,
    },
    modules: moduleTable({ templateId: b.workspaceTemplateId, plan, overrides: b.moduleOverrides || {}, snapshot: b.entitlements }),
    overridable: overridableModules(b.workspaceTemplateId),
    limits: b.entitlements?.limits ?? null,
    members: members.docs.map((d) => ({ uid: d.id, email: d.data().email, name: d.data().name, roleTemplate: d.data().roleTemplate, status: d.data().status, isAccountOwner: d.data().isAccountOwner === true })),
    usage: { period: monthKey(b.timezone || "Asia/Manila"), activeUsers: activeMembers, userLimit: b.entitlements?.limits?.users ?? null, ordersThisMonth: int(u.ordersCreated), importsThisMonth: int(u.excelImports), exportsGenerated: int(u.exportsGenerated), rowsExported: int(u.rowsExported) },
    limitRows: limitRows({ plan, overrides: b.limitOverrides || {}, entitlements: b.entitlements, usage: current.values }),
    meters: meterRows(current.values, b.entitlements),
    storage: current.storage,
    history,
    historyMeters: MONTHLY_METER_IDS.filter((id) => meterApplies(id, b.entitlements)),
    config: resolveTenantConfig(config.exists ? config.data() : null, b.workspaceTemplateId),
    terms: termsFor(b.workspaceTemplateId).map((t) => ({ id: t.id, label: t.label, options: Object.entries(t.options).map(([id, o]) => ({ id, label: o.singular })) })),
    audit: audit.docs.map((d) => auditRow(d)),
  };
}

// Informational (meter-only) counters that apply to this business, this month.
export function meterRows(values, entitlements) {
  return MONTHLY_METER_IDS.filter((id) => !isEnforced(id) && meterApplies(id, entitlements)).map((id) => ({ id, label: METERS[id].label, definition: METERS[id].definition, value: values[id] ?? 0 }));
}

// ---------- Usage across businesses (Phase 18) ----------

// One page (25 businesses, by id) with each one's current usage against
// its effective limits. Per-business reads only: no global counter that
// every tenant operation would have to update, no full scan.
export async function usageOverview({ db, FieldPath, after = null }) {
  let q = db.collection("businesses").orderBy(FieldPath.documentId());
  if (after !== null) {
    if (!isValidBusinessId(after)) throw new RequestError("invalid-request", "Invalid cursor.", 400);
    q = q.startAfter(after);
  }
  const snap = await q.limit(PAGE + 1).get();
  const docs = snap.docs.slice(0, PAGE);
  const rows = await Promise.all(
    docs.map(async (d) => {
      const b = d.data();
      const current = await readCurrentUsage(tenantDb(db, d.id), b.timezone || "Asia/Manila");
      const recordsCreated = RECORD_CREATION_METER_IDS.reduce((sum, id) => sum + (meterApplies(id, b.entitlements) ? current.values[id] : 0), 0);
      return {
        id: d.id,
        name: b.name,
        workspaceTemplateId: b.workspaceTemplateId ?? null,
        planId: b.subscription?.planId ?? null,
        status: b.subscription?.status ?? null,
        period: current.period,
        limits: limitRows({ overrides: b.limitOverrides || {}, entitlements: b.entitlements, usage: current.values }).map((r) => ({ limitKey: r.limitKey, label: r.label, unit: r.unit, current: r.current, effective: r.effective, percent: r.percent, override: r.override, atOrOver: r.atOrOver })),
        exports: current.values.exportsGenerated,
        recordsCreated,
      };
    })
  );
  return { rows, next: snap.docs.length > PAGE ? docs.at(-1).id : null };
}

const auditRow = (d) => {
  const a = d.data();
  return { id: d.id, type: a.type, summary: a.summary ?? null, businessId: a.businessId ?? null, actor: a.actor ?? null, reason: a.reason ?? null, before: a.before ?? null, after: a.after ?? null, member: a.member ?? null, operator: a.operator ?? null, at: ts(a.at) };
};

// The platform audit log, newest first (after: an audit id cursor).
export async function listAudit({ db, after = null }) {
  let q = db.collection("platformAudit").orderBy("at", "desc");
  if (after !== null) {
    if (typeof after !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(after)) throw new RequestError("invalid-request", "Invalid cursor.", 400);
    const cur = await db.collection("platformAudit").doc(after).get();
    if (cur.exists) q = q.startAfter(cur);
  }
  const snap = await q.limit(PAGE + 1).get();
  const docs = snap.docs.slice(0, PAGE);
  return { rows: docs.map(auditRow), next: snap.docs.length > PAGE ? docs.at(-1).id : null };
}

// Stored plans (the authority), sorted.
export async function listPlans({ db }) {
  const snap = await db.collection("plans").get();
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

export { creatableWorkspaces };
