import { describe, it, expect } from "vitest";
import { isValidBusinessId, sanitizePermissions, effectivePermissions } from "../../shared/tenancy.js";
import { accessPolicy } from "../../shared/subscription.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { normalizeEnvironment, isProduction } from "../../shared/environment.js";

describe("isValidBusinessId", () => {
  it("accepts opaque ids and rejects path-like or odd input", () => {
    for (const ok of ["demo-distributor-a", "AbC123xyz", "a1_b2-c3"]) expect(isValidBusinessId(ok), ok).toBe(true);
    for (const bad of ["", "ab", "../x", "a/b", "-abc", "has space", "x".repeat(65), null, 42, {}]) expect(isValidBusinessId(bad), String(bad)).toBe(false);
  });
});

describe("sanitizePermissions", () => {
  it("keeps only known keys set to exactly true", () => {
    expect(sanitizePermissions({ "orders.view": true, "orders.create": "true", "made.up": true, "users.manage": 1 })).toEqual({ "orders.view": true });
    expect(sanitizePermissions(null)).toEqual({});
  });
});

describe("effectivePermissions", () => {
  const owner = resolvePermissions("owner");
  it("is unchanged for active, past_due and suspended (writes are blocked separately)", () => {
    expect(effectivePermissions(owner, accessPolicy("active"))).toEqual(owner);
    expect(effectivePermissions(owner, accessPolicy("suspended"))).toEqual(owner);
  });
  it("narrows to export-only for cancelled", () => {
    const perms = effectivePermissions(owner, accessPolicy("cancelled"));
    expect(Object.keys(perms).sort()).toEqual(["billing.view", "dashboard.view", "reports.export", "reports.view", "settings.view"]);
  });
  it("is empty when the policy denies reads", () => {
    expect(effectivePermissions(owner, accessPolicy("bogus"))).toEqual({});
  });
});

describe("environment", () => {
  it("normalizes unknown values to development and identifies production only explicitly", () => {
    expect(normalizeEnvironment("staging")).toBe("staging");
    expect(normalizeEnvironment("prod")).toBe("development");
    expect(normalizeEnvironment(undefined)).toBe("development");
    expect(isProduction("production")).toBe(true);
    expect(isProduction("staging")).toBe(false);
  });
});
