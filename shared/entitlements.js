// Effective entitlements = plan defaults + per-business overrides.
//
// Computed SERVER-SIDE whenever a business's plan or overrides change and
// stored as a snapshot on businesses/{bid}.entitlements, so the browser,
// the server and the Firestore/Storage rules all read one document instead
// of re-deriving it.
//
// Everything here fails closed. A plan, override or snapshot that is
// malformed in any way is rejected outright (validatePlan / validateOverrides
// throw; validateEntitlementsSnapshot returns ok:false), never "repaired"
// into something broader.
//
// Snapshot shape (schemaVersion 1):
//   { schemaVersion, planId, planName, modules{every MODULE_ID: boolean},
//     limits{every LIMIT_KEY: int >= 0}, features{every FEATURE_KEY: valid},
//     computedAt (server timestamp, added by the writer) }
// firestore.rules / storage.rules check schemaVersion, planId and the
// modules / limits structure; tests/shared/rules-registry.test.js keeps
// their copies of the key lists in sync with this file.

import { LIMIT_KEYS, FEATURE_KEYS, isValidFeatureValue } from "./plans.seed.js";
import { MODULE_IDS, CORE_MODULE_IDS, SELLABLE_MODULE_IDS } from "./modules.js";

export const ENTITLEMENTS_SCHEMA_VERSION = 1;

export const PLAN_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function isValidPlanId(value) {
  return typeof value === "string" && PLAN_ID_PATTERN.test(value);
}

export class EntitlementError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}: ${problems.join("; ")}` : message);
    this.code = "invalid-entitlements";
    this.problems = problems;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isLimitValue = (value) => Number.isSafeInteger(value) && value >= 0;

// ---------- Plans ----------

// Throws EntitlementError listing every problem. Returns the plan.
export function validatePlan(plan) {
  const problems = [];
  if (!isPlainObject(plan)) throw new EntitlementError("Plan must be an object");

  if (!isValidPlanId(plan.id)) problems.push(`invalid plan id ${JSON.stringify(plan.id)}`);
  if (typeof plan.name !== "string" || !plan.name.trim()) problems.push("name is required");

  const pricing = plan.pricing;
  if (!isPlainObject(pricing)) problems.push("pricing must be an object");
  else {
    if (typeof pricing.currency !== "string" || !pricing.currency) problems.push("pricing.currency is required");
    for (const key of ["setupFee", "monthly"]) {
      if (!isLimitValue(pricing[key])) problems.push(`pricing.${key} must be a non-negative integer (centavos)`);
    }
    for (const key of ["setupFeeIsMinimum", "monthlyIsMinimum"]) {
      if (typeof pricing[key] !== "boolean") problems.push(`pricing.${key} must be a boolean`);
    }
  }

  if (!isPlainObject(plan.modules)) problems.push("modules must be an object");
  else {
    for (const [id, value] of Object.entries(plan.modules)) {
      if (!SELLABLE_MODULE_IDS.includes(id)) problems.push(`modules.${id} is not a sellable module`);
      else if (typeof value !== "boolean") problems.push(`modules.${id} must be a boolean`);
    }
  }

  if (!isPlainObject(plan.limits)) problems.push("limits must be an object");
  else {
    for (const key of LIMIT_KEYS) if (!isLimitValue(plan.limits[key])) problems.push(`limits.${key} must be a non-negative integer`);
    for (const key of Object.keys(plan.limits)) if (!LIMIT_KEYS.includes(key)) problems.push(`limits.${key} is unknown`);
  }

  if (!isPlainObject(plan.features)) problems.push("features must be an object");
  else {
    for (const key of FEATURE_KEYS) if (!isValidFeatureValue(key, plan.features[key])) problems.push(`features.${key} is invalid`);
    for (const key of Object.keys(plan.features)) if (!FEATURE_KEYS.includes(key)) problems.push(`features.${key} is unknown`);
  }

  if (problems.length) throw new EntitlementError(`Invalid plan ${JSON.stringify(plan.id)}`, problems);
  return plan;
}

// ---------- Overrides ----------

// Normalizes { modules, limits, features } overrides, throwing on anything
// unknown or mistyped. Core modules can't be overridden.
export function validateOverrides(overrides = {}) {
  const problems = [];
  if (!isPlainObject(overrides)) throw new EntitlementError("Overrides must be an object");
  const result = { modules: {}, limits: {}, features: {} };

  for (const section of Object.keys(overrides)) {
    if (!["modules", "limits", "features"].includes(section)) problems.push(`unknown override section ${section}`);
  }
  for (const section of ["modules", "limits", "features"]) {
    if (overrides[section] !== undefined && overrides[section] !== null && !isPlainObject(overrides[section])) {
      problems.push(`${section} overrides must be an object`);
    }
  }

  for (const [id, value] of Object.entries(isPlainObject(overrides.modules) ? overrides.modules : {})) {
    if (CORE_MODULE_IDS.includes(id)) problems.push(`module ${id} is core and can't be overridden`);
    else if (!SELLABLE_MODULE_IDS.includes(id)) problems.push(`unknown module override ${id}`);
    else if (typeof value !== "boolean") problems.push(`module override ${id} must be true or false`);
    else result.modules[id] = value;
  }
  for (const [key, value] of Object.entries(isPlainObject(overrides.limits) ? overrides.limits : {})) {
    if (!LIMIT_KEYS.includes(key)) problems.push(`unknown limit override ${key}`);
    else if (!isLimitValue(value)) problems.push(`limit override ${key} must be a non-negative integer`);
    else result.limits[key] = value;
  }
  for (const [key, value] of Object.entries(isPlainObject(overrides.features) ? overrides.features : {})) {
    if (!FEATURE_KEYS.includes(key)) problems.push(`unknown feature override ${key}`);
    else if (!isValidFeatureValue(key, value)) problems.push(`feature override ${key} has an invalid value`);
    else result.features[key] = value;
  }

  if (problems.length) throw new EntitlementError("Invalid overrides", problems);
  return result;
}

// ---------- Effective entitlements ----------

export function computeEntitlements(plan, overrides = {}) {
  validatePlan(plan);
  const clean = validateOverrides(overrides);

  const modules = {};
  for (const id of MODULE_IDS) {
    if (CORE_MODULE_IDS.includes(id)) modules[id] = true;
    else if (id in clean.modules) modules[id] = clean.modules[id];
    else modules[id] = plan.modules[id] === true;
  }

  const limits = {};
  for (const key of LIMIT_KEYS) limits[key] = key in clean.limits ? clean.limits[key] : plan.limits[key];

  const features = {};
  for (const key of FEATURE_KEYS) features[key] = key in clean.features ? clean.features[key] : plan.features[key];

  return { schemaVersion: ENTITLEMENTS_SCHEMA_VERSION, planId: plan.id, planName: plan.name, modules, limits, features };
}

// ---------- Stored snapshots ----------

// Checks a stored businesses/{bid}.entitlements snapshot before it's used
// for any decision. expectedPlanId is the business's subscription.planId;
// a snapshot computed for another plan is stale and must be recomputed.
// Returns { ok, problems }.
export function validateEntitlementsSnapshot(snapshot, expectedPlanId) {
  const problems = [];
  if (!isPlainObject(snapshot)) return { ok: false, problems: ["missing entitlements snapshot"] };

  if (snapshot.schemaVersion !== ENTITLEMENTS_SCHEMA_VERSION) problems.push(`unsupported schemaVersion ${JSON.stringify(snapshot.schemaVersion)}`);
  if (!isValidPlanId(snapshot.planId)) problems.push("invalid planId");
  if (!isValidPlanId(expectedPlanId)) problems.push("business has no valid subscription.planId");
  else if (snapshot.planId !== expectedPlanId) problems.push(`snapshot is for plan ${JSON.stringify(snapshot.planId)}, business is on ${JSON.stringify(expectedPlanId)}`);

  if (!isPlainObject(snapshot.modules)) problems.push("modules must be an object");
  else {
    for (const id of MODULE_IDS) if (typeof snapshot.modules[id] !== "boolean") problems.push(`modules.${id} must be a boolean`);
    for (const id of Object.keys(snapshot.modules)) if (!MODULE_IDS.includes(id)) problems.push(`unknown module ${id}`);
    for (const id of CORE_MODULE_IDS) if (snapshot.modules[id] !== true) problems.push(`core module ${id} must be enabled`);
  }

  if (!isPlainObject(snapshot.limits)) problems.push("limits must be an object");
  else {
    for (const key of LIMIT_KEYS) if (!isLimitValue(snapshot.limits[key])) problems.push(`limits.${key} must be a non-negative integer`);
    for (const key of Object.keys(snapshot.limits)) if (!LIMIT_KEYS.includes(key)) problems.push(`unknown limit ${key}`);
  }

  if (!isPlainObject(snapshot.features)) problems.push("features must be an object");
  else {
    for (const key of FEATURE_KEYS) if (!isValidFeatureValue(key, snapshot.features[key])) problems.push(`features.${key} is invalid`);
    for (const key of Object.keys(snapshot.features)) if (!FEATURE_KEYS.includes(key)) problems.push(`unknown feature ${key}`);
  }

  return { ok: problems.length === 0, problems };
}
