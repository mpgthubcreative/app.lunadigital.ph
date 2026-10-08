// Shape-accurate client session, as produced by src/app/session.js from
// a GET /api/session response. Like the server, it includes plan, limits
// and usage only when the member holds billing.view.
import { PLAN_SEED, computeEntitlements, resolvePermissions } from "../../shared/index.js";

export function sessionFixture({
  roleTemplate = "owner",
  planId = "growth",
  status = "active",
  memberships = null,
  environment = "staging",
  overrides = {},
  permissions = null,
} = {}) {
  const plan = PLAN_SEED[planId];
  const entitlements = computeEntitlements(plan, overrides);
  const perms = permissions ?? resolvePermissions(roleTemplate);
  const seesPackage = perms["billing.view"] === true;
  return {
    environment,
    user: { uid: "u1", email: "owner.a@luna.test", name: "Owner A (Demo)" },
    business: { id: "demo-distributor-a", name: "Demo Distributor A", timezone: "Asia/Manila", currency: "PHP" },
    member: { roleTemplate, roleLabel: roleTemplate, isAccountOwner: roleTemplate === "owner", status: "active", permissions: perms },
    plan: seesPackage ? { id: plan.id, name: plan.name } : null,
    subscription: { status, access: { canRead: true, canWrite: status !== "suspended", exportOnly: false } },
    entitlements: { modules: entitlements.modules, features: entitlements.features, limits: seesPackage ? entitlements.limits : null },
    usage: seesPackage ? { period: "2026-10", users: 3, ordersThisMonth: 0, storageBytes: 0, importsThisMonth: 0 } : null,
    memberships: memberships || [{ businessId: "demo-distributor-a", businessName: "Demo Distributor A", roleLabel: "Owner" }],
  };
}
