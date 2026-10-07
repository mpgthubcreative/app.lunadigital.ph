import { describe, it, expect } from "vitest";
import { PERMISSION_KEYS, ROLE_TEMPLATES, resolvePermissions, hasPermission, isPermissionKey } from "../../shared/permissions.js";

describe("role templates", () => {
  it("contain only known permission keys", () => {
    for (const [id, template] of Object.entries(ROLE_TEMPLATES)) {
      for (const key of template.permissions) {
        expect(isPermissionKey(key), `${id} → ${key}`).toBe(true);
      }
    }
  });

  it("owner holds every permission", () => {
    expect(Object.keys(resolvePermissions("owner")).sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("staff cannot reach subscription, team management, settings or sensitive reports", () => {
    const staff = resolvePermissions("staff");
    for (const key of ["billing.view", "users.manage", "settings.manage", "reports.advanced", "reports.view", "inventory.adjust"]) {
      expect(hasPermission(staff, key), key).toBe(false);
    }
    expect(hasPermission(staff, "orders.create")).toBe(true);
  });

  it("manager cannot reach billing or team management", () => {
    const manager = resolvePermissions("manager");
    expect(hasPermission(manager, "billing.view")).toBe(false);
    expect(hasPermission(manager, "users.manage")).toBe(false);
    expect(hasPermission(manager, "reports.advanced")).toBe(true);
  });
});

describe("resolvePermissions", () => {
  it("applies grant and revoke overrides", () => {
    const perms = resolvePermissions("staff", { grant: ["inventory.adjust"], revoke: ["orders.create"] });
    expect(perms["inventory.adjust"]).toBe(true);
    expect(perms["orders.create"]).toBeUndefined();
  });

  it("rejects unknown templates and permission keys (fail closed on typos)", () => {
    expect(() => resolvePermissions("superuser")).toThrow();
    expect(() => resolvePermissions("staff", { grant: ["orders.delete_everything"] })).toThrow();
  });

  it("hasPermission requires an explicit true", () => {
    expect(hasPermission(null, "orders.view")).toBe(false);
    expect(hasPermission({ "orders.view": "true" }, "orders.view")).toBe(false);
  });
});
