// Shared world for the emulator security suite (tests/rules/).
//
// Runs against the REAL Firestore + Storage emulators with the REAL
// firestore.rules / storage.rules (see `npm run test:rules`). Seeding uses
// withSecurityRulesDisabled, which stands in for the Admin SDK writes the
// server performs; every assertion then runs as a browser client.
//
// Member documents are built with shared/permissions.js resolvePermissions,
// the same function provisioning uses, so the stored permission maps are
// exactly what production would hold.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { resolvePermissions, ROLE_TEMPLATES } from "../../shared/permissions.js";

export const PROJECT_ID = "demo-luna";
export const A = "demo-distributor-a";
export const B = "demo-distributor-b";
export const DOC = "seed-1";

const root = resolve(import.meta.dirname, "../..");

// Tenant collection -> permission that unlocks browser reads.
// null = server-only (never readable from the browser).
export const TENANT_COLLECTIONS = Object.freeze({
  products: "inventory.view",
  inventoryTransactions: "inventory.view",
  customers: "customers.view",
  orders: "orders.view",
  payments: "payments.view",
  metrics: "dashboard.view",
  reports: "reports.view",
  settings: "settings.view",
  imports: "imports.run",
  paymentRefs: null,
  counters: null,
  usage: null,
  auditLog: null,
  integrations: null,
});

export const COLLECTION_NAMES = Object.freeze([...Object.keys(TENANT_COLLECTIONS), "members", "rows", "inbox"]);

// Storage area -> permission.
export const STORAGE_AREAS = Object.freeze({
  products: "inventory.view",
  payments: "payments.view",
  imports: "imports.run",
  exports: "reports.export",
});

// Must match EXPORT_ONLY_PERMISSIONS in shared/tenancy.js.
export const EXPORT_ONLY = Object.freeze(["dashboard.view", "reports.view", "reports.export", "billing.view", "settings.view"]);

function memberDoc(uid, { role, isAccountOwner = false, status = "active", overrides = {}, permissions } = {}) {
  return {
    uid,
    email: `${uid.toLowerCase()}@rules.test`,
    name: uid,
    roleTemplate: role,
    permissionOverrides: { grant: overrides.grant || [], revoke: overrides.revoke || [] },
    permissions: permissions ?? resolvePermissions(role, overrides),
    isAccountOwner,
    status,
  };
}

// Every membership in the world. Keyed by uid.
export const MEMBERS = Object.freeze({
  // Business A
  ownerA: { bid: A, role: "owner", isAccountOwner: true },
  managerA: { bid: A, role: "manager" },
  staffA: { bid: A, role: "staff" },
  disabledA: { bid: A, role: "manager", status: "disabled" },
  revokedStaffA: { bid: A, role: "staff", overrides: { revoke: ["orders.view"] } },
  grantedStaffA: { bid: A, role: "staff", overrides: { grant: ["reports.view"] } },
  // roleTemplate string says "owner" but the stored permissions are Staff's:
  // simulates someone editing only the label.
  labelOwnerA: { bid: A, role: "owner", permissions: resolvePermissions("staff") },
  // Truthy-but-not-true values must grant nothing.
  truthyA: { bid: A, role: "manager", permissions: { "reports.view": "true", "orders.view": 1, "customers.view": {}, "users.view": [true] } },
  // Business B
  ownerB: { bid: B, role: "owner", isAccountOwner: true },
  managerB: { bid: B, role: "manager" },
  staffB: { bid: B, role: "staff" },
});

// A user who is staff in A and manager in B: B access must come from the
// B membership only, never from A's.
export const MULTI = Object.freeze({ uid: "multiAB", memberships: [{ bid: A, role: "staff" }, { bid: B, role: "manager" }] });

// Signed in, member of nothing, but users/{uid}.businessIds lists A and B.
export const OUTSIDER = "outsider";

// Subscription-state tenants. status undefined = missing subscription.status.
export const STATUS_TENANTS = Object.freeze({
  active: { bid: "sub-active", status: "active" },
  past_due: { bid: "sub-past-due", status: "past_due" },
  suspended: { bid: "sub-suspended", status: "suspended" },
  cancelled: { bid: "sub-cancelled", status: "cancelled" },
  unknown: { bid: "sub-unknown", status: "frozen" },
  wrongCase: { bid: "sub-wrong-case", status: "ACTIVE" },
  missing: { bid: "sub-missing", status: undefined },
  nonString: { bid: "sub-non-string", status: true },
});

// Members of every status tenant. uid = `${kind}@${bid}`.
export const STATUS_ROLES = Object.freeze({
  owner: { role: "owner", isAccountOwner: true },
  manager: { role: "manager" },
  staff: { role: "staff" },
  // Owner protection is the flag, not the label:
  labelOwner: { role: "owner", isAccountOwner: false },
  staffAccountOwner: { role: "staff", isAccountOwner: true },
});

export const statusUid = (kind, bid) => `${kind}@${bid}`;

function businessDoc(name, status) {
  const subscription = { planId: "growth", renewalAt: null, graceUntil: null };
  if (status !== undefined) subscription.status = status;
  return {
    name,
    timezone: "Asia/Manila",
    currency: "PHP",
    isDemo: true,
    subscription,
    entitlements: { planId: "growth", modules: { orders: true }, limits: { users: 50 } },
  };
}

async function seedTenant(db, bid, name, status) {
  await db.doc(`businesses/${bid}`).set(businessDoc(name, status));
  for (const collection of Object.keys(TENANT_COLLECTIONS)) {
    await db.doc(`businesses/${bid}/${collection}/${DOC}`).set({ tenant: bid, secret: `${bid}-${collection}`, businessId: bid });
  }
  await db.doc(`businesses/${bid}/imports/${DOC}/rows/1`).set({ tenant: bid, row: 1 });
}

async function seedMember(db, bid, uid, spec) {
  await db.doc(`businesses/${bid}/members/${uid}`).set(memberDoc(uid, spec));
  await db.doc(`businesses/${bid}/members/${uid}/inbox/${DOC}`).set({ title: "hello", readAt: null });
}

export async function seedWorld(env) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await seedTenant(db, A, "Demo Distributor A", "active");
    await seedTenant(db, B, "Demo Distributor B", "active");
    for (const [uid, spec] of Object.entries(MEMBERS)) await seedMember(db, spec.bid, uid, spec);
    for (const m of MULTI.memberships) await seedMember(db, m.bid, MULTI.uid, m);

    for (const { bid, status } of Object.values(STATUS_TENANTS)) {
      await seedTenant(db, bid, `Status ${bid}`, status);
      for (const [kind, spec] of Object.entries(STATUS_ROLES)) await seedMember(db, bid, statusUid(kind, bid), spec);
    }

    // users/{uid} index docs, as provisioning writes them. The outsider's
    // index has been tampered with to list both businesses.
    for (const [uid, spec] of Object.entries(MEMBERS)) {
      await db.doc(`users/${uid}`).set({ businessIds: [spec.bid], defaultBusinessId: spec.bid });
    }
    await db.doc(`users/${OUTSIDER}`).set({ businessIds: [A, B], defaultBusinessId: B });
    await db.doc(`users/${MULTI.uid}`).set({ businessIds: [A, B], defaultBusinessId: A });

    await db.doc("plans/growth").set({ id: "growth", name: "Growth" });
    await db.doc(`platformAudit/${DOC}`).set({ action: "seed" });
  });
}

export async function seedStorage(env) {
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const storage = ctx.storage();
    const bids = [A, B, ...Object.values(STATUS_TENANTS).map((t) => t.bid)];
    for (const bid of bids) {
      for (const area of Object.keys(STORAGE_AREAS)) {
        await storage.ref(`tenants/${bid}/${area}/seed.txt`).putString(`${bid}-${area}`);
      }
      await storage.ref(`tenants/${bid}/private/seed.txt`).putString(`${bid}-private`);
    }
    await storage.ref("public/seed.txt").putString("public");
  });
}

export async function createEnv({ storage = false } = {}) {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(resolve(root, "firestore.rules"), "utf8") },
    ...(storage ? { storage: { rules: readFileSync(resolve(root, "storage.rules"), "utf8") } } : {}),
  });
  await seedWorld(env);
  if (storage) await seedStorage(env);
  return env;
}

// Firestore client for a signed-in uid (optionally with forged token claims).
export const dbAs = (env, uid, claims) => env.authenticatedContext(uid, claims).firestore();
export const dbAnon = (env) => env.unauthenticatedContext().firestore();

export function permissionsOf(uid) {
  const spec = MEMBERS[uid];
  return spec.permissions ?? resolvePermissions(spec.role, spec.overrides || {});
}

export const ROLE_KEYS = Object.freeze(Object.keys(ROLE_TEMPLATES));
