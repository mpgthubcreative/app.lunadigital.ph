import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createBusiness, addMember, setMemberStatus, ensureAuthUser, refreshEntitlements, seedPlans, ProvisioningError } from "../../netlify/functions/_lib/provisioning.js";
import { requireTenant } from "../../netlify/functions/_lib/tenant.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";

let world;
beforeEach(async () => {
  world = await buildWorld();
});

describe("createBusiness", () => {
  it("stores the business with an entitlements snapshot from the stored plan", () => {
    const biz = world.db.docs.get("businesses/biz-b");
    expect(biz.subscription).toMatchObject({ planId: "starter", status: "active" });
    expect(biz.entitlements).toMatchObject({ planId: "starter", planName: "Starter", limits: { users: 2, ordersPerMonth: 500 } });
  });

  it("never overwrites an existing business", async () => {
    await expect(createBusiness({ ...world, name: "Imposter", planId: "pro", workspaceTemplateId: "distributor", businessId: "biz-a" })).rejects.toMatchObject({ code: "business-exists" });
    expect(world.db.docs.get("businesses/biz-a").name).toBe("Biz A");
  });

  it("rejects unknown plans, statuses and timezones", async () => {
    await expect(createBusiness({ ...world, name: "X", planId: "platinum", workspaceTemplateId: "distributor" })).rejects.toBeInstanceOf(ProvisioningError);
    await expect(createBusiness({ ...world, name: "X", planId: "growth", workspaceTemplateId: "distributor", subscriptionStatus: "vip" })).rejects.toBeInstanceOf(ProvisioningError);
    await expect(createBusiness({ ...world, name: "X", planId: "growth", workspaceTemplateId: "distributor", timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(ProvisioningError);
  });

  it("generates an id when none is given", async () => {
    const { businessId } = await createBusiness({ ...world, name: "Auto", planId: "starter", workspaceTemplateId: "distributor" });
    expect(world.db.docs.has(`businesses/${businessId}`)).toBe(true);
  });
});

describe("seedPlans", () => {
  it("does not clobber an edited plan unless asked", async () => {
    world.db.docs.get("plans/starter").limits.users = 3;
    await seedPlans({ ...world });
    expect(world.db.docs.get("plans/starter").limits.users).toBe(3);
    await seedPlans({ ...world, overwrite: true });
    expect(world.db.docs.get("plans/starter").limits.users).toBe(2);
  });
});

describe("addMember", () => {
  it("stores the resolved permission map and indexes the business on the user", () => {
    const member = world.db.docs.get(`businesses/biz-a/members/${world.uids.staffa}`);
    expect(member.roleTemplate).toBe("staff");
    expect(member.permissions["orders.create"]).toBe(true);
    expect(member.permissions["billing.view"]).toBeUndefined();
    const multi = world.db.docs.get(`users/${world.uids.multi}`);
    expect(multi.businessIds).toEqual(["biz-a", "biz-b"]);
    expect(multi.defaultBusinessId).toBe("biz-a");
  });

  it("enforces the plan user limit server-side (active members only)", async () => {
    // biz-b is Starter (2 users) and already has ownerb + multi.
    const extra = await ensureAuthUser({ auth: world.auth, email: "extra@t.test", name: "Extra" });
    await expect(addMember({ ...world, businessId: "biz-b", uid: extra.uid, email: extra.email, name: "Extra", roleTemplate: "staff" })).rejects.toMatchObject({ code: "user-limit-reached" });
    // A disabled member doesn't consume a seat.
    await addMember({ ...world, businessId: "biz-b", uid: extra.uid, email: extra.email, name: "Extra", roleTemplate: "staff", status: "disabled" });
    expect(world.db.docs.get(`businesses/biz-b/members/${extra.uid}`).status).toBe("disabled");
  });

  it("respects a per-business limit override after refreshing entitlements", async () => {
    world.db.docs.get("businesses/biz-b").limitOverrides = { users: 3 };
    await refreshEntitlements({ ...world, businessId: "biz-b" });
    const extra = await ensureAuthUser({ auth: world.auth, email: "extra2@t.test", name: "Extra" });
    await addMember({ ...world, businessId: "biz-b", uid: extra.uid, email: extra.email, name: "Extra", roleTemplate: "staff" });
    expect(world.db.docs.get(`businesses/biz-b/members/${extra.uid}`).status).toBe("active");
  });

  it("rejects unknown templates and permission overrides", async () => {
    await expect(addMember({ ...world, businessId: "biz-a", uid: "u1", email: "u1@t.test", name: "U", roleTemplate: "superuser" })).rejects.toBeInstanceOf(ProvisioningError);
    await expect(addMember({ ...world, businessId: "biz-a", uid: "u1", email: "u1@t.test", name: "U", roleTemplate: "staff", permissionOverrides: { grant: ["everything"] } })).rejects.toThrow();
  });
});

describe("setMemberStatus", () => {
  it("protects the account owner from being disabled", async () => {
    await expect(setMemberStatus({ ...world, businessId: "biz-a", uid: world.uids.ownera, status: "disabled" })).rejects.toMatchObject({ code: "owner-protected" });
  });

  it("disables and re-enables a member", async () => {
    await setMemberStatus({ ...world, businessId: "biz-a", uid: world.uids.staffa, status: "disabled" });
    expect(world.db.docs.get(`businesses/biz-a/members/${world.uids.staffa}`).status).toBe("disabled");
    await setMemberStatus({ ...world, businessId: "biz-a", uid: world.uids.staffa, status: "active" });
    expect(world.db.docs.get(`businesses/biz-a/members/${world.uids.staffa}`).status).toBe("active");
  });
});

describe("requireTenant guard", () => {
  const guard = (uid, businessId, opts) => requireTenant(request({ uid, businessId }), { db: world.db, auth: world.auth, ...opts });

  it("enforces permissions by key", async () => {
    await expect(guard(world.uids.staffa, "biz-a", { permission: "users.manage" })).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    await expect(guard(world.uids.ownera, "biz-a", { permission: "users.manage" })).resolves.toMatchObject({ businessId: "biz-a" });
  });

  it("blocks writes on a suspended business", async () => {
    await expect(guard(world.uids.owners, "biz-s", { permission: "orders.create", write: true })).rejects.toMatchObject({ code: "read-only" });
    await expect(guard(world.uids.owners, "biz-s", { permission: "orders.view" })).resolves.toBeTruthy();
  });

  it("blocks modules the business is not entitled to", async () => {
    world.db.docs.get("businesses/biz-a").entitlements.modules.inventory = false;
    await expect(guard(world.uids.ownera, "biz-a", { module: "inventory" })).rejects.toMatchObject({ code: "forbidden", reason: "module-disabled:inventory" });
  });

  it("hands back tenant-scoped references only", async () => {
    const ctx = await guard(world.uids.ownera, "biz-a", {});
    expect(ctx.tenant.collection("orders").path).toBe("businesses/biz-a/orders");
  });
});

describe("tenantDb", () => {
  it("rejects path traversal and invalid ids", () => {
    expect(() => tenantDb(world.db, "../users")).toThrow();
    expect(() => tenantDb(world.db, "biz-a").collection("orders/x/y")).toThrow();
    expect(() => tenantDb(world.db, "biz-a").doc("orders", "../../biz-b")).toThrow();
  });
});
