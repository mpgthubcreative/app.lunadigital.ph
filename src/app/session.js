// The session describes WHO is using Luna and WHAT their business is
// allowed to do: user, business, role template, resolved permissions,
// plan, subscription status, entitlements and usage.
//
// The shell configures navigation and screens entirely from this object —
// nothing in the UI checks a role name or a plan id directly.
//
// IMPORTANT: the session only shapes the UI. Security is enforced by
// Firestore rules and Netlify Functions, which re-derive tenant, permissions
// and subscription status server-side on every request.
//
// Phase 1: there is no authentication yet, so loadSession() returns a
// clearly-labelled PREVIEW session built from the shared plan/role config
// (no real business, no data). Phase 2 replaces this with GET /api/session.

import { PLAN_SEED, computeEntitlements, resolvePermissions, ROLE_TEMPLATES } from "@shared/index.js";

function buildPreviewSession() {
  const plan = PLAN_SEED.growth;
  const roleTemplate = "owner";
  return {
    preview: true,
    user: { uid: "preview", name: "Preview User", email: "" },
    business: { id: "preview", name: "Preview Business", timezone: "Asia/Manila" },
    member: {
      roleTemplate,
      roleLabel: ROLE_TEMPLATES[roleTemplate].label,
      permissions: resolvePermissions(roleTemplate),
    },
    plan: { id: plan.id, name: plan.name },
    subscription: { status: "active" },
    entitlements: computeEntitlements(plan),
    usage: { users: 1, ordersThisMonth: 0, storageBytes: 0, importsThisMonth: 0 },
  };
}

export async function loadSession() {
  return buildPreviewSession();
}
