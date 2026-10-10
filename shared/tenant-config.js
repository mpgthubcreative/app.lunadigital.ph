// Tenant configuration (Phase 17): small, controlled, per-business
// preferences, so customers can differ WITHOUT per-tenant code. Never
// `if (businessId === ...)` in application logic, no client branches, no
// per-customer deployments: differences come only from the workspace
// template, the plan, module overrides and this configuration.
//
// Stored at businesses/{bid}/settings/tenantConfig (server-written by the
// operator API; readable by members with settings.view). Versioned, and
// FAIL-SAFE: a missing, older or unknown document / field resolves to the
// defaults, because these are cosmetic preferences. (Security-relevant
// state - workspace, entitlements - stays strict and fails closed.)
//
// General settings (display name, timezone) live on the business document
// itself, where the whole app already reads them.

export const TENANT_CONFIG_VERSION = 1;
export const TENANT_CONFIG_DOC_ID = "tenantConfig";

// Controlled terminology: each term has a fixed list of options (no free
// text), applies only in the workspaces that have the concept, and changes
// display labels only - never ids, paths, permissions or data.
export const TERMINOLOGY = Object.freeze({
  customer: {
    label: "What do you call your customers?",
    workspaces: ["distributor"],
    module: "customers",
    default: "customer",
    options: Object.freeze({
      customer: { singular: "Customer", plural: "Customers" },
      dealer: { singular: "Dealer", plural: "Dealers" },
      reseller: { singular: "Reseller", plural: "Resellers" },
      retailer: { singular: "Retailer", plural: "Retailers" },
      client: { singular: "Client", plural: "Clients" },
    }),
  },
});

// The terms that apply to a workspace, with their options.
export function termsFor(workspaceTemplateId) {
  return Object.entries(TERMINOLOGY)
    .filter(([, t]) => t.workspaces.includes(workspaceTemplateId))
    .map(([id, t]) => ({ id, ...t }));
}

// Stored doc (or null) -> the effective configuration, defaults filled in.
export function resolveTenantConfig(doc, workspaceTemplateId) {
  const stored = doc && typeof doc === "object" && doc.terminology && typeof doc.terminology === "object" ? doc.terminology : {};
  const terminology = {};
  for (const t of termsFor(workspaceTemplateId)) {
    const choice = Object.hasOwn(t.options, stored[t.id]) ? stored[t.id] : t.default;
    terminology[t.id] = { choice, ...t.options[choice] };
  }
  return { version: TENANT_CONFIG_VERSION, terminology };
}

// An operator's terminology change: { term: optionId }. Unknown terms,
// terms for another workspace and unknown options are refused.
export function validateTerminologyChange(workspaceTemplateId, change) {
  if (!change || typeof change !== "object" || Array.isArray(change) || !Object.keys(change).length) throw Object.assign(new Error("Nothing to change"), { code: "invalid-input" });
  const allowed = Object.fromEntries(termsFor(workspaceTemplateId).map((t) => [t.id, t]));
  for (const [term, choice] of Object.entries(change)) {
    if (!allowed[term]) throw Object.assign(new Error(`"${term}" can't be set for this workspace`), { code: "invalid-input" });
    if (!Object.hasOwn(allowed[term].options, choice)) throw Object.assign(new Error(`Unknown option for ${term}`), { code: "invalid-input" });
  }
  return { ...change };
}

// The navigation label a term overrides (module id -> plural), if any.
export function terminologyLabels(config) {
  const out = {};
  for (const [id, t] of Object.entries(TERMINOLOGY)) if (config?.terminology?.[id]) out[t.module] = config.terminology[id].plural;
  return out;
}
