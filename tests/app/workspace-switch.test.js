// @vitest-environment jsdom
// Owner-pilot bug (2026-10-17): switching business kept the old workspace's
// route and showed "Page not available". Now the URL is checked against the
// NEW membership before anything renders: a page of another workspace (or,
// right after a switch, any page this membership can't open) is replaced by
// the workspace's home; unknown / forbidden pages still say not available.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRoutes, pathDisposition, homePath, workspacePaths, isKnownAppPath } from "../../src/app/routes.js";
import { createWorkspaceRouter } from "../../src/app/workspace-router.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const S = {
  household: () => sessionFixture({ roleTemplate: "owner", planId: "household-plus", workspaceTemplateId: "household-payroll" }),
  bridal: () => sessionFixture({ roleTemplate: "owner", planId: "bridal-plus", workspaceTemplateId: "bridal-expense" }),
  distributor: () => sessionFixture({ roleTemplate: "owner", planId: "growth", workspaceTemplateId: "distributor" }),
  distributorStaff: () => sessionFixture({ roleTemplate: "staff", planId: "growth", workspaceTemplateId: "distributor" }),
  baby: () => sessionFixture({ roleTemplate: "owner", planId: "baby-plus", workspaceTemplateId: "baby-expense" }),
};
beforeEach(() => window.history.replaceState({}, "", "/"));

// Mount the app's router for a session at a URL, as main.js does.
function open(session, path, { justSwitched = false } = {}) {
  window.history.replaceState({}, "", path);
  const seen = { pages: [], notAvailable: 0 };
  const router = createWorkspaceRouter({ session, routes: buildRoutes(session), justSwitched, onRoute: (r) => seen.pages.push(r.path), onNotAvailable: () => seen.notAvailable++ });
  router.start();
  return { ...seen, router, url: () => window.location.pathname, history: window.history.length };
}

describe("switching business lands on a valid page at once", () => {
  it("Household Expenses -> Bridal: Money opens (no Page not available)", () => {
    const r = open(S.bridal(), "/expenses", { justSwitched: true });
    // /expenses exists in Bridal too only if the template has it; either way a valid page opens.
    expect(r.notAvailable).toBe(0);
    expect(r.pages).toHaveLength(1);
    r.router.stop();
  });

  it("Household Payroll -> Bridal: the wedding's home (Money) opens", () => {
    const r = open(S.bridal(), "/payroll", { justSwitched: true });
    expect(r.notAvailable).toBe(0);
    expect(r.url()).toBe("/wedding-suppliers");
    expect(r.pages).toEqual(["/wedding-suppliers"]);
    r.router.stop();
  });

  it("Bridal Guests -> Household: Payroll opens", () => {
    const r = open(S.household(), "/guests", { justSwitched: true });
    expect(r.url()).toBe("/payroll");
    expect(r.pages).toEqual(["/payroll"]);
    expect(r.notAvailable).toBe(0);
    r.router.stop();
  });

  it("Household Grocery List -> Distributor: the Dashboard opens", () => {
    const r = open(S.distributor(), "/grocery-list", { justSwitched: true });
    expect(r.url()).toBe("/");
    expect(r.pages).toEqual(["/"]);
    r.router.stop();
  });

  it("Bridal Wedding Setup -> Baby: the Baby Dashboard opens", () => {
    const r = open(S.baby(), "/wedding-setup", { justSwitched: true });
    expect(r.url()).toBe("/");
    expect(r.pages).toEqual(["/"]);
    r.router.stop();
  });

  it("a page both workspaces have stays (Users)", () => {
    const r = open(S.bridal(), "/users", { justSwitched: true });
    expect(r.url()).toBe("/users");
    expect(r.pages).toEqual(["/users"]);
    r.router.stop();
  });

  it("right after a switch, a page of the new workspace this membership can't open also goes home", () => {
    const r = open(S.distributorStaff(), "/reports", { justSwitched: true });
    expect(r.notAvailable).toBe(0);
    expect(r.pages).toHaveLength(1);
    expect(r.url()).not.toBe("/reports");
    r.router.stop();
  });

  it("the redirect replaces the URL (no extra history entry), so Back doesn't bounce", () => {
    const before = window.history.length;
    const r = open(S.household(), "/wedding-tasks", { justSwitched: true });
    expect(window.history.length).toBe(before);
    expect(r.url()).toBe("/payroll");
    r.router.stop();
  });
});

describe("refresh, back / forward, typed URLs", () => {
  it("refresh after a switch: the valid page opens again", () => {
    const r = open(S.household(), "/payroll");
    expect(r.pages).toEqual(["/payroll"]);
    r.router.stop();
  });

  it("back / forward to the previous workspace's page: home, not Page not available", () => {
    const r = open(S.household(), "/payroll");
    window.history.pushState({}, "", "/wedding-suppliers");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(r.url()).toBe("/payroll");
    expect(r.notAvailable).toBe(0);
    r.router.stop();
  });

  it("unknown pages still say Page not available", () => {
    const r = open(S.household(), "/no-such-page", { justSwitched: true });
    expect(r.notAvailable).toBe(1);
    expect(r.url()).toBe("/no-such-page");
    r.router.stop();
  });

  it("a page of THIS workspace the person may not open still says Page not available (not right after a switch)", () => {
    const r = open(S.distributorStaff(), "/reports");
    expect(r.notAvailable).toBe(1);
    r.router.stop();
  });
});

describe("helpers", () => {
  it("homePath: / for every workspace (Household / Bridal via their alias)", () => {
    for (const k of ["household", "bridal", "distributor", "baby"]) expect(homePath(buildRoutes(S[k]())), k).toBe("/");
  });
  it("workspacePaths come from the template; isKnownAppPath covers every workspace", () => {
    expect(workspacePaths(S.household()).has("/payroll")).toBe(true);
    expect(workspacePaths(S.household()).has("/guests")).toBe(false);
    expect(workspacePaths(S.bridal()).has("/wedding-setup")).toBe(true);
    for (const p of ["/payroll", "/guests", "/orders", "/grocery-list", "/wedding-crew-meals", "/export"]) expect(isKnownAppPath(p), p).toBe(true);
    expect(isKnownAppPath("/nope")).toBe(false);
  });
  it("pathDisposition", () => {
    const h = S.household();
    const routes = buildRoutes(h);
    expect(pathDisposition(h, routes, "/payroll")).toBe("ok");
    expect(pathDisposition(h, routes, "/guests")).toBe("home");
    expect(pathDisposition(h, routes, "/nope")).toBe("not-available");
  });
});
