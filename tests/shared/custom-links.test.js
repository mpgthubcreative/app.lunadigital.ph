// Custom workspace links (2026-10-26): naming rules, the paid entitlement
// (and Bridal's Premium wedding link add-on), host parsing, public URLs.
import { describe, it, expect } from "vitest";
import { normalizeLinkInput, linkLabelProblem, isLinkLabel, RESERVED_LINK_NAMES, customLinkAllowed, customLinkEntitled, customLinkState, linkLabelFromHost, publicUrl, publicOrigin, CUSTOM_LINK_MIN, CUSTOM_LINK_MAX } from "../../shared/custom-links.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";

const D = "lunadigitalsystem.com";

describe("names", () => {
  it("normalizes what the owner types: lowercase, trimmed, spaces/underscores as hyphens, a pasted address reduced to the name", () => {
    expect(normalizeLinkInput("  Carlo Yanie Wedding ", D)).toBe("carlo-yanie-wedding");
    expect(normalizeLinkInput("https://PradoHousehold.lunadigitalsystem.com/", D)).toBe("pradohousehold");
    expect(normalizeLinkInput("abc_frozen_foods", D)).toBe("abc-frozen-foods");
  });
  it("letters, numbers and single hyphens; not at the start or end; a sensible length", () => {
    for (const ok of ["carloyaniewedding", "prado-household", "abc123", "a1b"]) expect(isLinkLabel(ok)).toBe(true);
    expect(linkLabelProblem("ab")).toMatch(/at least 3/);
    expect(linkLabelProblem("a".repeat(CUSTOM_LINK_MAX + 1))).toMatch(/at most 40/);
    expect(CUSTOM_LINK_MIN).toBe(3);
    for (const bad of ["-prado", "prado-", "pra do", "Prado", "prado!", "prado.home", "pradó", ""]) expect(isLinkLabel(bad)).toBe(false);
    expect(linkLabelProblem("xn--prado")).toMatch(/single hyphens/);
  });
  it("platform and infrastructure names are reserved (your list plus what's in Luna's DNS)", () => {
    for (const r of ["app", "www", "admin", "api", "console", "auth", "login", "signup", "billing", "mail", "email", "support", "help", "status", "static", "assets", "cdn", "docs", "dev", "staging", "production", "firebase", "netlify", "send", "resend", "luna"]) {
      expect(RESERVED_LINK_NAMES.has(r)).toBe(true);
      expect(linkLabelProblem(r)).toMatch(/reserved/);
    }
  });
});

describe("paid entitlement", () => {
  const trial = { status: "active", trialStatus: "trial_active" };
  const ended = { status: "active", trialStatus: "trial_ended" };
  it("paid access only: active or past_due, never in a free trial (open or ended unpaid); suspended / cancelled can't change it", () => {
    expect(customLinkAllowed({ status: "active" })).toBe(true);
    expect(customLinkAllowed({ status: "active", trialStatus: "converted" })).toBe(true);
    expect(customLinkAllowed({ status: "past_due" })).toBe(true);
    expect(customLinkAllowed(trial)).toBe(false);
    expect(customLinkAllowed(ended)).toBe(false);
    for (const status of ["suspended", "cancelled", "deleted", undefined]) expect(customLinkAllowed({ status })).toBe(false);
  });
  it("Bridal: the Premium wedding link add-on must be PAID; Household / Distributor: included with any paid plan", () => {
    const bridal = PLAN_SEED["bridal-basic"];
    expect(customLinkEntitled({ status: "active" }, bridal)).toBe(false);
    expect(customLinkEntitled({ status: "active", addOns: [{ id: "premium-link", flat: true }] }, bridal)).toBe(false);
    expect(customLinkEntitled({ status: "active", addOnsPaid: ["premium-link"] }, bridal)).toBe(true);
    expect(customLinkEntitled({ ...trial, addOnsPaid: ["premium-link"] }, bridal)).toBe(false);
    expect(customLinkEntitled({ status: "active" }, PLAN_SEED["household-basic"])).toBe(true);
    expect(customLinkEntitled({ status: "active" }, PLAN_SEED["distributor-basic"])).toBe(true);
  });
  it("how an address behaves: live (active / past_due), unavailable (suspended, held), retired (cancelled / deleted, held)", () => {
    expect(customLinkState({ status: "active" })).toBe("live");
    expect(customLinkState({ status: "past_due" })).toBe("live");
    expect(customLinkState({ status: "suspended" })).toBe("unavailable");
    expect(customLinkState({ status: "cancelled" })).toBe("retired");
    expect(customLinkState({ status: "deleted" })).toBe("retired");
  });
});

describe("hosts and public links", () => {
  it("only a valid, unreserved name under the configured domain is a custom link; app / www / other domains are not", () => {
    expect(linkLabelFromHost("carloyaniewedding.lunadigitalsystem.com", D)).toBe("carloyaniewedding");
    expect(linkLabelFromHost("CarloYanieWedding.LunaDigitalSystem.com.", D)).toBe("carloyaniewedding");
    for (const h of ["app.lunadigitalsystem.com", "www.lunadigitalsystem.com", "lunadigitalsystem.com", "luna-business-os.netlify.app", "x.y.lunadigitalsystem.com", "carlo.example.com", "localhost"]) expect(linkLabelFromHost(h, D)).toBe("");
    expect(linkLabelFromHost("carlo.lunadigitalsystem.com", undefined)).toBe("");
  });
  it("public links use the workspace's own address only when it's ready; otherwise exactly as before", () => {
    const ready = { publicLink: { label: "carloyaniewedding", host: `carloyaniewedding.${D}`, setup: "active" } };
    const pending = { publicLink: { ...ready.publicLink, setup: "pending" } };
    const app = "https://app.lunadigitalsystem.com";
    const t = "A".repeat(32);
    expect(publicUrl(ready, `/w/carlo-yanie/invite/${t}`, app)).toBe(`https://carloyaniewedding.${D}/invite/${t}`);
    expect(publicUrl(ready, `/invite/${t}`, app)).toBe(`https://carloyaniewedding.${D}/invite/${t}`);
    expect(publicUrl(ready, `/w/carlo-yanie/rsvp/${t}`, app)).toBe(`https://carloyaniewedding.${D}/rsvp/${t}`);
    expect(publicUrl(ready, "/store/abc-frozen", app)).toBe(`https://carloyaniewedding.${D}`);
    expect(publicUrl(ready, `/pay/${t}`, app)).toBe(`https://carloyaniewedding.${D}/pay/${t}`);
    expect(publicUrl(pending, `/w/carlo-yanie/invite/${t}`, app)).toBe(`${app}/w/carlo-yanie/invite/${t}`);
    expect(publicUrl({}, `/pay/${t}`, app)).toBe(`${app}/pay/${t}`);
    expect(publicOrigin(pending, app)).toBe(app);
    expect(publicOrigin(ready, app)).toBe(`https://carloyaniewedding.${D}`);
  });
});
