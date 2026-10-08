// Shape-accurate client session, as produced by src/app/session.js from
// a GET /api/session response. Like the server, it includes plan, limits
// and usage only when the member holds billing.view.
import { PLAN_SEED, computeEntitlements, resolvePermissions, WORKSPACE_TEMPLATES } from "../../shared/index.js";

export function sessionFixture({
  roleTemplate = "owner",
  planId = "growth",
  status = "active",
  memberships = null,
  environment = "staging",
  overrides = {},
  permissions = null,
  workspaceTemplateId = "distributor",
} = {}) {
  const plan = PLAN_SEED[planId];
  const entitlements = computeEntitlements(plan, overrides, workspaceTemplateId);
  const template = WORKSPACE_TEMPLATES[workspaceTemplateId];
  const perms = permissions ?? resolvePermissions(roleTemplate);
  const seesPackage = perms["billing.view"] === true;
  return {
    environment,
    user: { uid: "u1", email: "owner.a@luna.test", name: "Owner A (Demo)" },
    business: { id: "demo-distributor-a", name: "Demo Distributor A", timezone: "Asia/Manila", currency: "PHP" },
    workspace: { templateId: template.id, templateVersion: template.version, name: template.name },
    member: { roleTemplate, roleLabel: roleTemplate, isAccountOwner: roleTemplate === "owner", status: "active", permissions: perms },
    plan: seesPackage ? { id: plan.id, name: plan.name } : null,
    subscription: { status, access: { canRead: true, canWrite: status !== "suspended", exportOnly: false } },
    entitlements: { workspaceTemplateId: entitlements.workspaceTemplateId, workspaceTemplateVersion: entitlements.workspaceTemplateVersion, modules: entitlements.modules, features: entitlements.features, limits: seesPackage ? entitlements.limits : null },
    usage: seesPackage ? { period: "2026-10", users: 3, ordersThisMonth: 0, storageBytes: 0, importsThisMonth: 0 } : null,
    memberships: memberships || [{ businessId: "demo-distributor-a", businessName: "Demo Distributor A", roleLabel: "Owner" }],
  };
}
