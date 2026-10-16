// @vitest-environment jsdom
// Owner-pilot UX (2026-10-17): Household without a Dashboard.
//   Navigation: Payroll · Attendance · Advances · Staff · Users (+ Settings),
//   phones: Payroll · Attendance · Advances · Staff · More. "/" opens Payroll.
//   The bell is the one place for what needs attention: sentences per helper
//   from the household summary, deep links, counted on the bell. The other
//   workspaces keep their Dashboard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRoutes, routeAllowed } from "../../src/app/routes.js";
import { createRouter } from "../../src/app/router.js";
import { renderShell } from "../../src/app/shell.js";
import { mountBell } from "../../src/app/notification-bell.js";
import { mount as mountNotifications } from "../../src/modules/notifications/index.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="slot"></div><main id="content"></main>';
  window.history.replaceState({}, "", "/");
});
const home = (role = "owner") => sessionFixture({ roleTemplate: role, workspaceTemplateId: "household-payroll" });

function visit(session, path) {
  const seen = { route: null, notFound: false };
  window.history.replaceState({}, "", path);
  const router = createRouter({
    routes: buildRoutes(session),
    onRoute(route) {
      if (routeAllowed(session, route)) seen.route = route;
      else seen.notFound = true;
    },
    notFound() {
      seen.notFound = true;
    },
  });
  router.start();
  router.stop();
  return { ...seen, url: window.location.pathname + window.location.search };
}

describe("Household navigation without a Dashboard", () => {
  it("the Owner lands on Payroll: / (sign-in, old links) redirects there, keeping the query", () => {
    const r = visit(home(), "/");
    expect(r.route.moduleId).toBe("payroll");
    expect(r.url).toBe("/payroll");
    expect(visit(home(), "/?staff=abc12345").url).toBe("/payroll?staff=abc12345");
    expect(buildRoutes(home()).filter((x) => !x.redirect).map((x) => x.path)).not.toContain("/");
  });

  it("deep links still open their tab", () => {
    for (const p of ["/payroll", "/attendance", "/advances", "/household-staff", "/users", "/notifications"]) expect(visit(home(), p).route?.path, p).toBe(p);
  });

  it("sidebar: Payroll first, no Dashboard; phone tabs Payroll · Attendance · Advances · Staff + More", () => {
    renderShell(document.getElementById("app"), home());
    expect([...document.querySelectorAll(".nav-link")].map((a) => a.textContent.trim())).toEqual(["Payroll", "Attendance", "Advances", "Household Staff", "Users", "Subscription", "Settings"]);
    expect([...document.querySelectorAll(".tabbar .tab-link")].map((a) => a.textContent.trim())).toEqual(["Payroll", "Attendance", "Advances", "Staff", "More"]);
    expect(document.querySelector('.nav-link[href="/"]')).toBeNull();
    expect(document.querySelector('.tab-link[href="/"]')).toBeNull();
  });

  it("the other workspaces keep their Dashboard at /", () => {
    for (const t of ["distributor", "baby-expense", "bridal-expense"]) {
      const s = sessionFixture({ workspaceTemplateId: t });
      expect(visit(s, "/").route.moduleId, t).toBe("dashboard");
      document.getElementById("app").innerHTML = "";
      renderShell(document.getElementById("app"), s);
      expect(document.querySelector(".tabbar .tab-link").getAttribute("href"), t).toBe("/");
      expect(document.querySelectorAll(".tabbar .tab-link")).toHaveLength(5); // Dashboard + 3 + More
    }
  });
});

describe("the bell is where things needing attention live (Household)", () => {
  const todos = [
    { staffId: "staffLoriza01", name: "Loriza Ibanez", kind: "unrecordedDays", text: "2 attendance days of Loriza's Oct 1–15 still need to be recorded (salary paid early).", href: "/attendance?staff=staffLoriza01&period=2026-10-01" },
    { staffId: "staffLoriza01", name: "Loriza Ibanez", kind: "salaryConfirmation", text: "Loriza hasn't confirmed the Oct 1–15 salary yet.", href: "/payroll?staff=staffLoriza01&period=2026-10-01_2026-10-15" },
    { staffId: "staffLoriza01", name: "Loriza Ibanez", kind: "advanceConfirmation", text: "Loriza hasn't confirmed receiving the ₱500.00 advance (Oct 16).", href: "/advances?advance=advLoriza0001" },
  ];
  const data = () => ({ fetchUnreadCount: vi.fn(async () => 1), fetchRecent: vi.fn(async () => []), markRead: vi.fn(), markAllRead: vi.fn(), listNotifications: vi.fn(async () => ({ rows: [], hasMore: false })) });

  it("count = items needing attention + unread; the drawer lists them by helper with deep links", async () => {
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary: { todos } } : {}));
    const slot = document.getElementById("slot");
    const bell = mountBell(slot, home(), { data: data(), api });
    await flush();
    expect(api).toHaveBeenCalledWith("household-summary");
    expect(slot.querySelector('[data-role="bell-count"]').textContent).toBe("4");
    expect(slot.querySelector('[data-act="bell"]').getAttribute("aria-label")).toBe("Notifications, 3 need attention, 1 unread");
    slot.querySelector('[data-act="bell"]').click();
    await flush();
    const group = slot.querySelector('.todo-group[data-staff="staffLoriza01"]');
    expect(group.querySelector(".todo-name").textContent).toBe("Loriza Ibanez");
    expect([...group.querySelectorAll(".todo-link")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual(todos.map((t) => [t.text, t.href]));
    const link = group.querySelector(".todo-link");
    link.addEventListener("click", (e) => e.preventDefault());
    link.click();
    await flush();
    expect(slot.querySelector('[data-role="bell-drawer"]')).toBeNull();
    bell.stop();
  });

  it("other workspaces (and people without payroll.view) don't ask for household items", async () => {
    const api = vi.fn(async () => ({}));
    const slot = document.getElementById("slot");
    mountBell(slot, sessionFixture(), { data: data(), api }).stop();
    await flush();
    expect(api).not.toHaveBeenCalled();
  });

  it("the Notifications page starts with Needs your attention", async () => {
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary: { todos } } : {}));
    mountNotifications(document.getElementById("content"), home(), { data: data(), api });
    await flush();
    const box = document.querySelector('[data-section="todos"]');
    expect(box.querySelector(".card-title").textContent).toBe("Needs your attention (3)");
    expect(box.querySelectorAll(".todo-link")).toHaveLength(3);
    const empty = vi.fn(async () => ({ summary: { todos: [] } }));
    document.getElementById("content").innerHTML = "";
    mountNotifications(document.getElementById("content"), home(), { data: data(), api: empty });
    await flush();
    expect(document.querySelector('[data-role="todos-empty"]').textContent).toMatch(/Nothing needs your attention/);
  });
});
