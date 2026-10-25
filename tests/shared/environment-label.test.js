// The environment indicator (2026-10-25): staging is a clean pre-production
// / testing environment (no longer "demo data only"); production shows no
// banner at all; an unknown value reads as development, never production.
import { describe, it, expect } from "vitest";
import { ENVIRONMENT_LABELS, normalizeEnvironment, isProduction } from "../../shared/environment.js";

describe("environment indicator", () => {
  it("Staging is labelled Staging; Development stays labelled; Production has no banner", () => {
    expect(ENVIRONMENT_LABELS).toEqual({ development: "Development", staging: "Staging", production: "" });
    expect(normalizeEnvironment("prod")).toBe("development");
    expect(normalizeEnvironment(undefined)).toBe("development");
    expect(isProduction(normalizeEnvironment("staging"))).toBe(false);
  });
});
