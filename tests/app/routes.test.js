// @vitest-environment jsdom
// Frontend side of the module gate: routes exist only for modules the
// business is entitled to AND the user may view; typing a hidden URL shows
// the generic "Page not available"; Settings shows package details only to
// billing.view holders. UX only: the server and rules enforce the same.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRoutes, routeAllowed, renderPageNotAvailable } from "../../src/app/routes.js";
import { createRouter } from "../../src/app/router.js";
import { mount as mountSettings } from "../../src/modules/settings/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><main id="content"></main>';
  window.history.replaceState({}, "", "/");
});

const paths = (session) => buildRoutes(session).map((r) => r.path);
const reportStaff = (overrides = {}) =>
  sessionFixture({ roleTemplate: "staff", permissions: resolvePermissions("staff", { grant: ["reports.view"] }), overrides });

// Drives the real router the way main.js does and returns what rendered.
function visit(session, path) {
  const routes = buildRoutes(session);
  const content = document.getElementById("content");
  const seen = { route: null, notFound: false };
  window.history.replaceState({}, "", path);
  const router = createRouter({
    routes,
    onRoute(route) {
      if (!routeAllowed(session, route)) {
        seen.notFound = true;
        renderPageNotAvailable(content);
        return;
      }
      seen.route = route;
    },
    notFound() {
      seen.notFound = true;
      renderPageNotAvailable(content);
    },
  });
  router.start();
  router.stop();
  return { ...seen, text: content.textContent.replace(/\s+/g, " ").trim() };
}

describe("THE scenario in the browser", () => {
  it("staff with reports.view gets a Reports route while the module is on", () => {
    expect(paths(reportStaff())).toContain("/reports");
    expect(visit(reportStaff(), "/reports").route.moduleId).toBe("reports");
  });

  it("with Reports disabled: no nav item, and typing /reports shows Page not available", () => {
    const session = reportStaff({ modules: { reports: false } });
    expect(session.member.permissions["reports.view"]).toBe(true);
    expect(paths(session)).not.toContain("/reports");
    const result = visit(session, "/reports");
    expect(result.route).toBeNull();
    expect(result.notFound).toBe(true);
    expect(result.text).toMatch(/Page not available/);
  });

  it("the message is identical for a disabled module, a missing permission and a non-existent page", () => {
    const disabled = visit(reportStaff({ modules: { reports: false } }), "/reports").text;
    const noPermission = visit(sessionFixture({ roleTemplate: "staff" }), "/reports").text;
    const nowhere = visit(sessionFixture(), "/no-such-page").text;
    expect(disabled).toBe(noPermission);
    expect(disabled).toBe(nowhere);
    expect(disabled).not.toMatch(/plan|package|permission|upgrade/i);
  });
});

describe("routes = entitlements x permissions, nothing else", () => {
  it("module off hides it even for the owner", () => {
    expect(paths(sessionFixture({ overrides: { modules: { inventory: false } } }))).not.toContain("/inventory");
  });

  it("a hand-built route for a disabled module is refused at navigation time", () => {
    const session = reportStaff({ modules: { reports: false } });
    expect(routeAllowed(session, { path: "/reports", moduleId: "reports" })).toBe(false);
    expect(routeAllowed(session, { path: "/orders", moduleId: "orders" })).toBe(true);
    expect(routeAllowed(session, { path: "/x", moduleId: "teleport" })).toBe(false);
    expect(routeAllowed(session, null)).toBe(false);
  });

  it("changing the role label / template in the session changes nothing", () => {
    const session = sessionFixture({ roleTemplate: "staff" });
    session.member.roleTemplate = "owner";
    session.member.roleLabel = "Owner";
    expect(paths(session)).toEqual(paths(sessionFixture({ roleTemplate: "staff" })));
    expect(visit(session, "/reports").notFound).toBe(true);
  });

  it("a truthy-but-not-true module flag does not create a route", () => {
    const session = sessionFixture();
    session.entitlements.modules.reports = "true";
    expect(paths(session)).not.toContain("/reports");
  });

  it("unbuilt modules never get routes, even if entitled", () => {
    const session = sessionFixture({ overrides: { modules: { suppliers: true } } });
    expect(paths(session)).not.toContain("/suppliers");
    expect(visit(session, "/suppliers").notFound).toBe(true);
  });

  it("localStorage is not an input to routing", () => {
    window.localStorage.setItem("luna.selectedBusinessId", "demo-distributor-b");
    window.localStorage.setItem("luna.modules", JSON.stringify({ reports: true }));
    expect(paths(reportStaff({ modules: { reports: false } }))).not.toContain("/reports");
    window.localStorage.clear();
  });
});

describe("Settings package visibility", () => {
  const settingsText = (session) => {
    const el = document.getElementById("content");
    mountSettings(el, session);
    return el;
  };

  it("owner sees plan, modules (incl. what's not on the package), limits and features", () => {
    const el = settingsText(sessionFixture({ overrides: { modules: { reports: false } } }));
    expect(el.querySelector("#packagePlan").textContent).toBe("Growth");
    const modules = el.querySelector("#packageModules").textContent;
    expect(modules).toMatch(/Reports\s*Not on your package/);
    expect(modules).toMatch(/Orders\s*Included/);
    expect(el.textContent).toMatch(/Active users/);
    expect(el.querySelector("#packageFeatures")).not.toBeNull();
  });

  it("a manager (settings.view, no billing.view) sees status but no commercial details", () => {
    const el = settingsText(sessionFixture({ roleTemplate: "manager" }));
    expect(el.textContent).toMatch(/Status/);
    expect(el.querySelector("#packagePlan")).toBeNull();
    expect(el.querySelector("#packageModules")).toBeNull();
    expect(el.textContent).not.toMatch(/Growth|Active users|Orders per month/);
  });

  it("staff has no Settings route at all", () => {
    expect(paths(sessionFixture({ roleTemplate: "staff" }))).not.toContain("/settings");
  });
});

describe("selected business in localStorage is only a selector", () => {
  it("a stale/foreign selection the server rejects falls back to the user's own business", async () => {
    vi.resetModules();
    const calls = [];
    vi.doMock("../../src/lib/api.js", () => {
      let selector = () => null;
      return {
        setBusinessSelector: (fn) => (selector = fn),
        api: async () => {
          const selected = selector();
          calls.push(selected);
          if (selected === "demo-distributor-b") throw Object.assign(new Error("denied"), { status: 403, code: "business-access-denied" });
          const s = sessionFixture();
          return { ...s, permissions: s.member.permissions };
        },
      };
    });
    window.localStorage.setItem("luna.selectedBusinessId", "demo-distributor-b");
    const { loadSession } = await import("../../src/app/session.js");
    const session = await loadSession();
    expect(calls).toEqual(["demo-distributor-b", null]);
    expect(session.business.id).toBe("demo-distributor-a");
    expect(window.localStorage.getItem("luna.selectedBusinessId")).toBe("demo-distributor-a");
    vi.doUnmock("../../src/lib/api.js");
    window.localStorage.clear();
  });
});
