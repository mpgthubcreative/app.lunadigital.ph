// Effective entitlements = plan defaults + per-business overrides.
//
// Computed SERVER-SIDE whenever a business's plan or overrides change and
// stored as a snapshot on businesses/{bid}.entitlements, so the browser and
// Firestore rules read one document instead of re-deriving it.
//
// Overrides let Luna Super Admin grant or withhold a module, raise a limit
// for one client, or flip a feature, without inventing a new plan.

import { LIMIT_KEYS } from "./plans.seed.js";
import { MODULE_IDS } from "./modules.js";

export function computeEntitlements(plan, overrides = {}) {
  if (!plan || !plan.id) throw new Error("computeEntitlements: plan is required");

  const moduleOverrides = overrides.modules || {};
  const limitOverrides = overrides.limits || {};
  const featureOverrides = overrides.features || {};

  for (const id of Object.keys(moduleOverrides)) {
    if (!MODULE_IDS.includes(id)) throw new Error(`Unknown module override: ${id}`);
  }
  for (const key of Object.keys(limitOverrides)) {
    if (!LIMIT_KEYS.includes(key)) throw new Error(`Unknown limit override: ${key}`);
    const value = limitOverrides[key];
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid limit override for ${key}`);
  }

  const modules = {};
  for (const id of MODULE_IDS) {
    const fromPlan = Boolean(plan.modules && plan.modules[id]);
    modules[id] = id in moduleOverrides ? Boolean(moduleOverrides[id]) : fromPlan;
  }

  return {
    planId: plan.id,
    modules,
    limits: { ...plan.limits, ...limitOverrides },
    features: { ...plan.features, ...featureOverrides },
  };
}
