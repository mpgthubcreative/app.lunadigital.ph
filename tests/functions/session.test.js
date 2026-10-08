import { describe, it, expect, beforeEach } from "vitest";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { PERMISSION_KEYS } from "../../shared/permissions.js";

let world;
let handler;

async function call(req) {
  const res = await handler(req);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

beforeEach(async () => {
  world = await buildWorld();
  handler = createSessionHandler({ getAdmin: async () => world });
});

describe("GET /api/session — authentication", () => {
  it("rejects requests without a token", async () => {
    const res = await call(request({}));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
  });

  it("rejects an invalid token", async () => {
    expect((await call(request({ token: "forged" }))).status).toBe(401);
  });

  it("reports an expired token distinctly", async () => {
    const res = await call(request({ token: "expired" }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("session-expired");
  });

  it("rejects a disabled Firebase account", async () => {
    world.auth.disabledUids.add(world.uids.ownera);
    const res = await call(request({ uid: world.uids.ownera }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("account-disabled");
  });

  it("rejects non-GET methods", async () => {
    expect((await call(request({ uid: world.uids.ownera, method: "POST" }))).status).toBe(405);
  });
});

describe("GET /api/session — tenant resolution", () => {
  it("resolves an owner to their business with every permission", async () => {
    const res = await call(request({ uid: world.uids.ownera }));
    expect(res.status).toBe(200);
    expect(res.body.business).toMatchObject({ id: "biz-a", name: "Biz A" });
    expect(res.body.member).toMatchObject({ roleTemplate: "owner", isAccountOwner: true });
    expect(Object.keys(res.body.permissions).sort()).toEqual([...PERMISSION_KEYS].sort());
    expect(res.body.plan).toEqual({ id: "growth", name: "Growth" });
    expect(res.body.entitlements.limits.users).toBe(5);
    expect(res.body.subscription.access).toEqual({ canRead: true, canWrite: true, exportOnly: false });
  });

  it("gives staff only staff permissions", async () => {
    const res = await call(request({ uid: world.uids.staffa }));
    expect(res.status).toBe(200);
    expect(res.body.permissions["orders.create"]).toBe(true);
    expect(res.body.permissions["users.manage"]).toBeUndefined();
    expect(res.body.permissions["billing.view"]).toBeUndefined();
  });

  it("refuses a user with no memberships", async () => {
    const res = await call(request({ uid: world.uids.nobody }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("no-active-membership");
  });

  it("refuses a disabled membership", async () => {
    const res = await call(request({ uid: world.uids.disableda }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("membership-disabled");
  });

  it("reports usage with the active member count (disabled excluded)", async () => {
    const res = await call(request({ uid: world.uids.ownera }));
    // ownera, managera, staffa, multi — disableda not counted
    expect(res.body.usage.users).toBe(4);
    expect(res.body.usage.ordersThisMonth).toBe(0);
    expect(res.body.usage.period).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("GET /api/session — businessId is only a selector", () => {
  it("lets a multi-business user select either of their businesses", async () => {
    const a = await call(request({ uid: world.uids.multi, businessId: "biz-a" }));
    const b = await call(request({ uid: world.uids.multi, businessId: "biz-b" }));
    expect(a.body.business.id).toBe("biz-a");
    expect(a.body.member.roleTemplate).toBe("staff");
    expect(b.body.business.id).toBe("biz-b");
    expect(b.body.member.roleTemplate).toBe("manager");
    expect(a.body.memberships.map((m) => m.businessId).sort()).toEqual(["biz-a", "biz-b"]);
  });

  it("defaults to the user's default business when none is selected", async () => {
    const res = await call(request({ uid: world.uids.multi }));
    expect(res.body.business.id).toBe("biz-a");
  });

  it("refuses another tenant's businessId — owner of A selecting B", async () => {
    const res = await call(request({ uid: world.uids.ownera, businessId: "biz-b" }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("business-access-denied");
    expect(JSON.stringify(res.body)).not.toContain("Biz B");
  });

  it("gives the same answer for a non-existent business (no enumeration)", async () => {
    const other = await call(request({ uid: world.uids.ownera, businessId: "biz-b" }));
    const missing = await call(request({ uid: world.uids.ownera, businessId: "does-not-exist" }));
    expect(missing.status).toBe(other.status);
    expect(missing.body).toEqual(other.body);
  });

  it("never falls back to another business when the selected one is refused", async () => {
    const res = await call(request({ uid: world.uids.disableda, businessId: "biz-a" }));
    expect(res.status).toBe(403);
    expect(res.body.business).toBeUndefined();
  });

  it("rejects a malformed businessId", async () => {
    for (const bad of ["../biz-a", "biz-a/members", "a", "x".repeat(65), "biz a"]) {
      const res = await call(request({ uid: world.uids.ownera, businessId: bad }));
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toBe("invalid-business");
    }
  });

  it("ignores a forged users/{uid}.businessIds entry without a membership doc", async () => {
    const path = `users/${world.uids.ownera}`;
    const profile = world.db.docs.get(path);
    world.db.seed(path, { ...profile, businessIds: [...profile.businessIds, "biz-b"] });
    const res = await call(request({ uid: world.uids.ownera, businessId: "biz-b" }));
    expect(res.status).toBe(403);
    const own = await call(request({ uid: world.uids.ownera }));
    expect(own.body.memberships.map((m) => m.businessId)).toEqual(["biz-a"]);
  });
});

describe("GET /api/session — stored permissions are sanitized", () => {
  it("drops unknown keys and non-true values from a tampered member doc", async () => {
    const path = `businesses/biz-a/members/${world.uids.staffa}`;
    const member = world.db.docs.get(path);
    world.db.seed(path, { ...member, permissions: { ...member.permissions, "billing.view": "true", "root.everything": true, "users.manage": 1 } });
    const res = await call(request({ uid: world.uids.staffa }));
    expect(res.body.permissions["billing.view"]).toBeUndefined();
    expect(res.body.permissions["root.everything"]).toBeUndefined();
    expect(res.body.permissions["users.manage"]).toBeUndefined();
  });

  it("does not grant access based on the role name", async () => {
    const path = `businesses/biz-a/members/${world.uids.staffa}`;
    world.db.seed(path, { ...world.db.docs.get(path), roleTemplate: "owner" });
    const res = await call(request({ uid: world.uids.staffa }));
    expect(res.body.permissions["billing.view"]).toBeUndefined();
    expect(res.body.member.isAccountOwner).toBe(false);
  });
});

describe("GET /api/session — subscription policy", () => {
  it("suspended business is readable but read-only", async () => {
    const res = await call(request({ uid: world.uids.owners }));
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ status: "suspended", access: { canRead: true, canWrite: false } });
  });

  it("cancelled business: owner gets export-only permissions", async () => {
    const res = await call(request({ uid: world.uids.ownerx }));
    expect(res.status).toBe(200);
    expect(res.body.subscription.access.exportOnly).toBe(true);
    expect(res.body.permissions["reports.export"]).toBe(true);
    expect(res.body.permissions["orders.create"]).toBeUndefined();
  });

  it("cancelled business: non-owner is refused", async () => {
    const res = await call(request({ uid: world.uids.staffx }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account-cancelled");
  });

  it("unknown subscription status fails closed", async () => {
    world.db.docs.get("businesses/biz-a").subscription.status = "free_forever";
    const res = await call(request({ uid: world.uids.ownera }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("subscription-inactive");
  });

  it("missing or stale entitlements fail closed", async () => {
    world.db.docs.get("businesses/biz-a").entitlements.planId = "pro";
    const res = await call(request({ uid: world.uids.ownera }));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("business-misconfigured");
  });
});

describe("GET /api/session — package visibility (Phase 4)", () => {
  it("owner (billing.view) gets plan, limits and usage", async () => {
    const res = await call(request({ uid: world.uids.ownera }));
    expect(res.body.plan).toEqual({ id: "growth", name: "Growth" });
    expect(res.body.entitlements.limits.users).toBe(5);
    expect(res.body.usage).not.toBeNull();
  });

  it("staff and manager get module switches and features, but no plan, limits or usage", async () => {
    for (const uid of [world.uids.staffa, world.uids.managera]) {
      const res = await call(request({ uid }));
      expect(res.status).toBe(200);
      expect(res.body.plan).toBeNull();
      expect(res.body.entitlements.limits).toBeNull();
      expect(res.body.usage).toBeNull();
      expect(res.body.entitlements.modules.orders).toBe(true);
      expect(typeof res.body.entitlements.features.googleSheets).toBe("boolean");
    }
  });
});
