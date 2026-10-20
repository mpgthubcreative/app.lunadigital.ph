// Luna Super Admin (Phase 17): the operator vocabulary and the pure rules
// the console and the operator API share. Operators are Luna staff, not
// business members: an operator record (operators/{uid}, server-only) is the
// ONLY thing that grants console access. A business role never does.
//
// Four separate concepts, never mixed:
//   Workspace template   the business model (hard ceiling; immutable here)
//   Plan                 commercial defaults and limits
//   Module overrides     operator-approved add-ons / removals INSIDE the ceiling
//   Tenant configuration small customer preferences (shared/tenant-config.js)

import { MODULES, CORE_MODULE_IDS, getModule } from "./modules.js";
import { getWorkspaceTemplate, WORKSPACE_TEMPLATES } from "./workspaces.js";
import { isValidBusinessId } from "./tenancy.js";
import { isValidPlanId } from "./entitlements.js";
import { SUBSCRIPTION_STATUSES } from "./subscription.js";

export class OperatorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// One role for the MVP; the record still names it so more can be added
// without changing how access is checked.
export const OPERATOR_ROLES = Object.freeze({ superadmin: { label: "Super Admin" } });
export const OPERATOR_STATUSES = Object.freeze(["active", "disabled"]);
export const isActiveOperator = (rec) => Boolean(rec) && rec.status === "active" && Object.hasOwn(OPERATOR_ROLES, rec.role);

// The workspaces an operator can create: live templates only, always at
// their current version (never typed, never an obsolete version).
export function creatableWorkspaces() {
  return Object.values(WORKSPACE_TEMPLATES)
    .filter((t) => t.status === "live")
    .map((t) => ({ id: t.id, name: t.name, version: t.version }));
}

export const SUBSCRIPTION_LABELS = Object.freeze({ active: "Active", past_due: "Past due", suspended: "Suspended", cancelled: "Cancelled", deleted: "Deleted" });
// Status changes that need a confirmation + reason in the console. None
// deletes data:
//   past_due   still fully usable (grace period)
//   suspended  temporarily read-only
//   cancelled  subscription / access ended; data kept (owner can export)
//   active     full access restored
export const SUBSCRIPTION_ACTIONS = Object.freeze({ past_due: "Mark as past due", suspended: "Suspend access", cancelled: "Cancel subscription", active: "Reactivate subscription" });
export const SUBSCRIPTION_ACTION_HELP = Object.freeze({
  past_due: "They keep full access during the grace period.",
  suspended: "Access becomes read-only until it's reactivated. Nothing is deleted.",
  cancelled: "The subscription ends. All data is kept; the owner can still sign in to export.",
  active: "Full access is restored.",
});

// A business ID from its name: "Carlo & Yanie's Wedding" -> "carlo-yanies-wedding".
export function businessIdFromName(name) {
  const base = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : base ? `${base}-biz` : "";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const NEW_BUSINESS_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
function text(v, field, max, required = true) {
  const t = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!t && required) throw new OperatorError("invalid-input", `${field} is required`);
  if (t.length > max) throw new OperatorError("invalid-input", `${field} is too long (max ${max})`);
  return t || null;
}
export function validTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// "Create business" input. businessId is the slug; the workspace must be
// a live template; the owner's email resolves or creates their account.
const CREATE_FIELDS = ["name", "businessId", "workspaceTemplateId", "planId", "ownerEmail", "ownerName", "timezone", "termMonths", "priceOverride", "addOns", "setupFee", "waiveSetupFee", "trial"];
export function validateCreateBusinessInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OperatorError("invalid-input", "Invalid business");
  for (const k of Object.keys(input)) if (!CREATE_FIELDS.includes(k)) throw new OperatorError("invalid-input", `Field ${k} can't be set here`);
  const out = {
    name: text(input.name, "Business name", 120),
    businessId: input.businessId,
    workspaceTemplateId: input.workspaceTemplateId,
    planId: input.planId,
    ownerEmail: typeof input.ownerEmail === "string" ? input.ownerEmail.trim().toLowerCase() : "",
    ownerName: text(input.ownerName, "Owner name", 120),
    timezone: input.timezone || "Asia/Manila",
    // The access term (checked against the product on the server) and an agreed price.
    termMonths: input.termMonths ?? null,
    priceOverride: input.priceOverride ?? null,
    // Advanced: add-ons from the start, this business's setup fee, waive it.
    addOns: input.addOns ?? {},
    setupFee: input.setupFee ?? null,
    waiveSetupFee: input.waiveSetupFee === true,
    // Start with the 30-day free trial (products that have one).
    trial: input.trial === true,
  };
  if (input.trial !== undefined && typeof input.trial !== "boolean") throw new OperatorError("invalid-input", "Free trial: yes or no");
  if (!out.addOns || typeof out.addOns !== "object" || Array.isArray(out.addOns)) throw new OperatorError("invalid-input", "Add-ons: invalid");
  if (out.setupFee !== null && (!Number.isSafeInteger(out.setupFee) || out.setupFee < 0)) throw new OperatorError("invalid-input", "Setup fee: ₱0 or more");
  if (input.waiveSetupFee !== undefined && typeof input.waiveSetupFee !== "boolean") throw new OperatorError("invalid-input", "Waive setup fee: yes or no");
  if (out.termMonths !== null && (!Number.isSafeInteger(out.termMonths) || out.termMonths < 1 || out.termMonths > 36)) throw new OperatorError("invalid-input", "Term: 1 to 36 months");
  if (out.priceOverride !== null && (!Number.isSafeInteger(out.priceOverride) || out.priceOverride <= 0)) throw new OperatorError("invalid-input", "Price: an amount more than ₱0");
  // New ids are clean slugs (stricter than isValidBusinessId, which also
  // accepts older auto-generated ids).
  if (!isValidBusinessId(out.businessId) || !NEW_BUSINESS_ID.test(out.businessId)) throw new OperatorError("invalid-input", "Business ID: 3-40 lowercase letters, digits or dashes");
  if (!creatableWorkspaces().some((w) => w.id === out.workspaceTemplateId)) throw new OperatorError("invalid-input", "Choose a workspace");
  if (!isValidPlanId(out.planId)) throw new OperatorError("invalid-input", "Choose a plan");
  if (!EMAIL.test(out.ownerEmail)) throw new OperatorError("invalid-input", "Enter the owner's email");
  if (!validTimezone(out.timezone)) throw new OperatorError("invalid-input", "Unknown timezone");
  return out;
}

export function validateSubscriptionStatus(status) {
  if (!SUBSCRIPTION_STATUSES.includes(status)) throw new OperatorError("invalid-input", "Unknown subscription status");
  return status;
}
export function validateReason(reason) {
  const r = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (r.length < 3 || r.length > 300) throw new OperatorError("reason-required", "Give a reason (3-300 characters)");
  return r;
}

// The modules an operator may override for a workspace: allowed by its
// template, built (available) and not core. Everything else (another
// workspace's modules, planned or unbuilt modules) is never offered.
export function overridableModules(templateId) {
  const t = getWorkspaceTemplate(templateId);
  if (!t) return [];
  return t.modules.filter((id) => !CORE_MODULE_IDS.includes(id) && getModule(id)?.available === true);
}

// Module | Template | Plan | Override | Effective, for one business.
//   effective = templateAllows && (override === true || (planAllows && override !== false)) && built
// (the stored snapshot is the authority; this table explains it).
export function moduleTable({ templateId, plan, overrides = {}, snapshot = null }) {
  const t = getWorkspaceTemplate(templateId);
  const editable = new Set(overridableModules(templateId));
  return MODULES.filter((m) => !m.core && (m.available || t?.modules.includes(m.id))).map((m) => {
    const template = Boolean(t && t.modules.includes(m.id));
    const planOn = plan?.modules?.[m.id] === true;
    const override = Object.hasOwn(overrides, m.id) ? overrides[m.id] === true : null;
    const computed = template && m.available && (override === true || (planOn && override !== false));
    return { id: m.id, label: t?.labels?.modules?.[m.id] ?? m.label, template, plan: planOn, override, effective: snapshot ? snapshot.modules?.[m.id] === true : computed, computed, editable: editable.has(m.id) };
  });
}

// Override choice in the console -> the provisioning call.
export const OVERRIDE_CHOICES = Object.freeze({ default: "Default (plan)", enabled: "Enabled", disabled: "Disabled" });
export function overrideChange(templateId, moduleId, choice) {
  if (!Object.hasOwn(OVERRIDE_CHOICES, choice)) throw new OperatorError("invalid-input", "Choose Default, Enabled or Disabled");
  if (!overridableModules(templateId).includes(moduleId)) throw new OperatorError("not-overridable", `${moduleId} can't be changed in a ${templateId} workspace (outside its template, unbuilt or core)`);
  if (choice === "default") return { set: {}, clear: { modules: [moduleId] } };
  return { set: { modules: { [moduleId]: choice === "enabled" } }, clear: {} };
}
