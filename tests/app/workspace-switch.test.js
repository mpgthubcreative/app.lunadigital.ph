// @vitest-environment jsdom
// Owner-pilot bug (2026-10-17): switching business kept the old workspace's
// route and showed "Page not available". Now the URL is checked against the
// NEW membership before anything renders: a page of another workspace (or,
// right after a switch, any page this membership can't open) is replaced by
// the workspace's home; unknown / forbidden pages still say not available.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRoutes, pathDisposition, homePath, workspacePaths, isKnownAppPath, switchLandingPath, defaultPath, routeAllowed } from "../../src/app/routes.js";
import { resetWorkspaceUi, isStaleFileError, reloadForFreshFiles } from "../../src/app/workspace-switch.js";
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

  it("Household Grocery List -> Distributor: Orders opens (its home since 2026-10-22)", () => {
    const r = open(S.distributor(), "/grocery-list", { justSwitched: true });
    expect(r.url()).toBe("/orders");
    expect(r.pages).toEqual(["/orders"]);
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

// Owner pilot (2026-10-19): the switch decides the landing page BEFORE the
// new workspace renders (main.js switchWorkspace -> switchLandingPath).
describe("switchLandingPath: always a valid, authorized page of the destination", () => {
  const PLANS = { distributor: "growth", "household-payroll": "household-plus", "bridal-expense": "bridal-plus", "baby-expense": "baby-plus" };
  const as = (template, roleTemplate) => sessionFixture({ roleTemplate, planId: PLANS[template], workspaceTemplateId: template });
  const DEFAULTS = { distributor: "/orders", "household-payroll": "/payroll", "bridal-expense": "/wedding-suppliers", "baby-expense": "/" };
  const SHARED = new Set(["/users", "/settings", "/notifications", "/subscription", "/export"]);

  it("default page per template: Business Orders, Household Payroll, Bridal Money, Baby Dashboard", () => {
    for (const [t, path] of Object.entries(DEFAULTS)) expect(defaultPath(buildRoutes(as(t, "owner"))), t).toBe(path);
  });

  it("every page of every workspace, switched to every other workspace, as Owner / Admin / Staff", () => {
    let cases = 0;
    for (const role of ["owner", "manager", "staff"]) {
      for (const from of Object.keys(PLANS)) {
        const fromPaths = [...new Set([...workspacePaths(as(from, "owner")), ...buildRoutes(as(from, "owner")).map((r) => r.path)])];
        for (const to of Object.keys(PLANS)) {
          if (from === to) continue;
          const dest = as(to, role);
          const routes = buildRoutes(dest);
          for (const path of fromPaths) {
            const landing = switchLandingPath(dest, routes, path);
            const route = routes.find((r) => r.path === landing);
            expect(route && !route.redirect && routeAllowed(dest, route), `${role} ${from} ${path} -> ${to}: ${landing}`).toBe(true);
            // Kept only when it's the same page in both; otherwise the destination's default.
            expect(landing, `${role} ${from} ${path} -> ${to}`).toBe(SHARED.has(path) && route && landing === path ? path : defaultPath(routes));
            if (!SHARED.has(path)) expect(landing).toBe(defaultPath(routes));
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(200);
  });

  it("Business Orders -> Bridal: Money; Bridal Music & Program -> Business: Orders; Business Costs (/expenses) -> Bridal: Money, not Wedding Expenses", () => {
    const bridal = as("bridal-expense", "owner");
    const biz = as("distributor", "owner");
    expect(switchLandingPath(bridal, buildRoutes(bridal), "/orders")).toBe("/wedding-suppliers");
    expect(switchLandingPath(biz, buildRoutes(biz), "/wedding-program")).toBe("/orders");
    expect(switchLandingPath(bridal, buildRoutes(bridal), "/expenses")).toBe("/wedding-suppliers");
    expect(switchLandingPath(bridal, buildRoutes(bridal), "/users/")).toBe("/users");
  });

  it("a shared page the destination membership may not open goes to the default", () => {
    const staff = as("distributor", "staff");
    const routes = buildRoutes(staff);
    const usersAllowed = routes.some((r) => r.path === "/users");
    expect(switchLandingPath(staff, routes, "/users")).toBe(usersAllowed ? "/users" : defaultPath(routes));
  });
});

describe("resetWorkspaceUi and stale page files", () => {
  it("removes dialogs / panels left on <body>, closes ⋯ menus, clears toasts", () => {
    document.body.innerHTML = '<div id="app"><details class="line-menu" open><summary>⋯</summary></details></div><div class="modal-backdrop"><div class="modal">Add item</div></div><div class="modal-backdrop is-panel"></div><div class="toast-region"><div class="toast">Saved</div></div>';
    resetWorkspaceUi(document);
    expect(document.querySelectorAll(".modal-backdrop")).toHaveLength(0);
    expect(document.querySelector("details").open).toBe(false);
    expect(document.querySelector(".toast-region").children).toHaveLength(0);
  });

  it("a file renamed by a deploy reloads ONCE per page per minute; other errors don't", () => {
    expect(isStaleFileError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/expenses-DXcDtmhk.js"))).toBe(true);
    expect(isStaleFileError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleFileError(new Error("x is undefined"))).toBe(false);
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const reload = vi.fn();
    expect(reloadForFreshFiles({ path: "/expenses", storage, reload, now: 1000 })).toBe(true);
    expect(reloadForFreshFiles({ path: "/expenses", storage, reload, now: 30000 })).toBe(false); // no loop
    expect(reloadForFreshFiles({ path: "/expenses", storage, reload, now: 70000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reloadForFreshFiles({ path: "/x", storage: { getItem: () => null, setItem: () => { throw new Error("blocked"); } }, reload })).toBe(false);
  });
});
