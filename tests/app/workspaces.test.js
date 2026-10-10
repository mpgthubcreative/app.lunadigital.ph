// @vitest-environment jsdom
// Phase 8.5 in the browser: navigation and dashboard come from the
// workspace template; a non-Distributor workspace never shows, routes to or
// fetches Distributor modules; Distributor looks exactly as before.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderShell } from "../../src/app/shell.js";
import { buildRoutes, routeAllowed, renderPageNotAvailable } from "../../src/app/routes.js";
import { createRouter } from "../../src/app/router.js";
import { mount as mountDashboard } from "../../src/modules/dashboard/index.js";
import { sessionFixture } from "../helpers/session-fixture.js";

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><main id="content"></main>';
  window.history.replaceState({}, "", "/");
});

const bridal = (role = "owner") => sessionFixture({ roleTemplate: role, planId: "pro", workspaceTemplateId: "bridal-expense" });
const navOf = () => [...document.querySelectorAll(".nav-link")].map((a) => `${a.getAttribute("href")} ${a.textContent.trim()}`);

// Same guard as main.js: a route is mounted only if routeAllowed.
function visit(session, path) {
  const content = document.getElementById("content");
  const loader = vi.fn();
  window.history.replaceState({}, "", path);
  const router = createRouter({
    routes: buildRoutes(session),
    onRoute(route) {
      if (!routeAllowed(session, route)) return renderPageNotAvailable(content);
      return loader(route.moduleId);
    },
    notFound: () => renderPageNotAvailable(content),
  });
  router.start();
  router.stop();
  return { loader, text: content.textContent.replace(/\s+/g, " ").trim() };
}

describe("navigation", () => {
  it("Distributor: unchanged", () => {
    renderShell(document.getElementById("app"), sessionFixture());
    // Customers is back (built in Phase 9); Reports / Imports return as each is built.
    expect(navOf()).toEqual(["/ Dashboard", "/orders Orders", "/payments Payments", "/inventory Inventory", "/customers Customers", "/expenses Operating Expenses", "/reports Reports", "/imports Imports", "/users Users", "/settings Settings"]);
  });

  it("Bridal: its own dashboard name, no Orders / Inventory / Payments", () => {
    renderShell(document.getElementById("app"), bridal());
    expect(navOf()).toEqual(["/ Wedding Dashboard", "/wedding-tasks Wedding Tasks", "/guests Guests & RSVP", "/wedding-suppliers Wedding Suppliers", "/budget Wedding Budget", "/expenses Wedding Expenses", "/users Users", "/settings Settings"]);
  });

  it("Bridal staff: roles still apply", () => {
    renderShell(document.getElementById("app"), bridal("staff"));
    expect(navOf()).toEqual(["/ Wedding Dashboard"]);
  });
});

describe("typing a Distributor URL in a bridal workspace", () => {
  for (const path of ["/orders", "/inventory", "/payments", "/customers", "/reports", "/imports"]) {
    it(`${path}: Page not available, and the module is never loaded`, () => {
      const r = visit(bridal(), path);
      expect(r.loader).not.toHaveBeenCalled();
      expect(r.text).toMatch(/Page not available/);
    });
  }

  it("a forged session flag can't open Orders either (the workspace is re-checked)", () => {
    const s = bridal();
    s.entitlements.modules.orders = true;
    const r = visit(s, "/orders");
    expect(r.loader).not.toHaveBeenCalled();
  });

  it("Distributor still opens /orders", () => {
    expect(visit(sessionFixture(), "/orders").loader).toHaveBeenCalledWith("orders");
  });
});

describe("dashboard", () => {
  const NOW = new Date("2026-10-08T04:00:00Z");

  it("Bridal (Phase 16): only Wedding sources are requested, never a Distributor metric", async () => {
    const fetchDocuments = vi.fn(async () => ({}));
    const fetchLists = vi.fn(async () => ({}));
    const container = document.getElementById("content");
    mountDashboard(container, bridal(), { fetchDocuments, fetchLists, now: NOW });
    await new Promise((r) => setTimeout(r, 0));
    const cols = new Set(fetchDocuments.mock.calls.flatMap((c) => c[1].map((d) => d.collection)));
    expect([...cols].sort()).toEqual(["budgets", "guestTotals", "spendingMetrics", "taskTotals", "weddingTasks"]);
    expect(container.querySelector("h1, .page-title")?.textContent).toMatch(/Wedding Dashboard/);
    expect(container.textContent).not.toMatch(/Today's sales|Orders today|Low stock|Unpaid/);
  });

  it("Distributor: still requests its metric documents and lists", async () => {
    const fetchDocuments = vi.fn(async () => ({}));
    const fetchLists = vi.fn(async () => ({}));
    mountDashboard(document.getElementById("content"), sessionFixture(), { fetchDocuments, fetchLists, now: NOW });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchDocuments.mock.calls[0][1].map((d) => d.collection)).toEqual(expect.arrayContaining(["metrics", "financialMetrics"]));
    expect(fetchLists.mock.calls[0][1].map((w) => w.id)).toEqual(["inventorySummary", "recentOrders", "lowStockItems"]);
  });
});
