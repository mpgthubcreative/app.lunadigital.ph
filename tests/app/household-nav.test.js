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
  it("the Owner lands on Attendance & Pay: / (sign-in, old links) redirects there, keeping the query", () => {
    const r = visit(home(), "/");
    expect(r.route.moduleId).toBe("attendance");
    expect(r.url).toBe("/attendance");
    expect(visit(home(), "/?staff=abc12345").url).toBe("/attendance?staff=abc12345");
    expect(buildRoutes(home()).filter((x) => !x.redirect).map((x) => x.path)).not.toContain("/");
  });

  it("deep links still open their tab", () => {
    for (const p of ["/payroll", "/attendance", "/advances", "/household-staff", "/users", "/notifications"]) expect(visit(home(), p).route?.path, p).toBe(p);
  });

  it("Luna Household (2026-10-29): Attendance first, no Dashboard; Payroll and Advances lead More (with Household Staff, Bills, Download Excel, Users, Subscription, Settings)", () => {
    renderShell(document.getElementById("app"), home());
    expect([...document.querySelectorAll(".nav-link")].map((a) => a.textContent.trim())).toEqual(["Attendance", "Expenses", "Payroll", "Advances", "Household Staff", "Bills", "Download Excel", "Users", "Subscription", "Settings"]);
    // This plan has no Grocery List: Attendance · Expenses + More (never Payroll as a tab).
    expect([...document.querySelectorAll(".tabbar .tab-link")].map((a) => a.textContent.trim())).toEqual(["Attendance", "Expenses", "More"]);
    expect([...document.querySelectorAll("#moreSheet .sheet-link[data-sheet]")].map((a) => a.textContent.trim()).slice(0, 2)).toEqual(["Payroll", "Advances"]);
    expect(document.querySelector('.nav-link[href="/"]')).toBeNull();
    expect(document.querySelector('.tab-link[href="/"]')).toBeNull();
  });

  it("Baby keeps its Dashboard at / (Bridal: Money, see wedding.test.js; Distributor: Orders since 2026-10-22)", () => {
    const d = sessionFixture({ workspaceTemplateId: "distributor" });
    expect(visit(d, "/").route.moduleId).toBe("orders");
    for (const t of ["baby-expense"]) {
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

  // Owner-pilot (2026-10-17): the red number = unread only; read is not resolved.
  const withIds = (read = []) => todos.map((x, i) => ({ ...x, id: `${x.kind}:item${i}`, read: read.includes(i) }));
  const open = async (slot) => {
    slot.querySelector('[data-act="bell"]').click();
    await flush();
  };
  const texts = (slot) => [...slot.querySelectorAll(".todo-link")].map((a) => a.textContent.replace("● ", ""));

  it("the badge counts what hasn't been seen (unread notifications + new attention items); items list by helper with deep links", async () => {
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary: { todos: withIds([2]) } } : {}));
    const slot = document.getElementById("slot");
    const bell = mountBell(slot, home(), { data: data(), api });
    await flush();
    expect(api).toHaveBeenCalledWith("household-summary");
    expect(slot.querySelector('[data-role="bell-count"]').textContent).toBe("3"); // 1 unread notification + 2 new items (one already seen)
    expect(slot.querySelector('[data-act="bell"]').getAttribute("aria-label")).toBe("Notifications, 3 unread");
    await open(slot);
    // Structure: Mark all as read at the top, then Needs attention, then Recent.
    expect(slot.querySelector('.bell-head [data-act="bell-read-all"]').textContent).toBe("Mark all as read");
    expect([...slot.querySelectorAll(".bell-section")].map((x) => x.textContent.replace(/\s+/g, " ").trim())).toEqual(["Needs attention 3", "Recent"]);
    const group = slot.querySelector('.todo-group[data-staff="staffLoriza01"]');
    expect(group.querySelector(".todo-name").textContent).toBe("Loriza Ibanez");
    expect(texts(slot)).toEqual(todos.map((x) => x.text));
    expect([...group.querySelectorAll(".todo-link")].map((a) => a.getAttribute("href"))).toEqual(todos.map((x) => x.href));
    expect([...slot.querySelectorAll('[data-role="todo-state"]')].map((x) => x.textContent)).toEqual(["New · needs attention", "New · needs attention", "Read · still needs attention"]);
    bell.stop();
  });

  it("Mark as read / Mark as unread on an attention item: the badge follows, the item stays (read is not resolved)", async () => {
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary: { todos: withIds() } } : {}));
    const slot = document.getElementById("slot");
    const bell = mountBell(slot, home(), { data: data(), api });
    await flush();
    await open(slot);
    const first = slot.querySelector(".todo-item");
    expect([...first.querySelectorAll(".menu-item")].map((b) => b.textContent)).toEqual(["Open", "Mark as read"]);
    first.querySelector('[data-act="todo-read"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("notifications", { method: "POST", body: { action: "attention", ids: ["unrecordedDays:item0"], read: true } });
    expect(slot.querySelector('[data-role="bell-count"]').textContent).toBe("3"); // 4 -> 3
    expect(texts(slot)).toHaveLength(3); // still needs attention
    expect(slot.querySelector('[data-todo="unrecordedDays:item0"] [data-role="todo-state"]').textContent).toBe("Read · still needs attention");
    slot.querySelector('[data-todo="unrecordedDays:item0"] [data-act="todo-unread"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("notifications", { method: "POST", body: { action: "attention", ids: ["unrecordedDays:item0"], read: false } });
    expect(slot.querySelector('[data-role="bell-count"]').textContent).toBe("4");
    bell.stop();
  });

  it("opening an item marks it read and closes the panel; Mark all as read clears the badge but keeps what still needs action", async () => {
    let list = withIds();
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary: { todos: list } } : {}));
    const d = data();
    const slot = document.getElementById("slot");
    const bell = mountBell(slot, home(), { data: d, api });
    await flush();
    await open(slot);
    const link = slot.querySelector('.todo-link[data-id="salaryConfirmation:item1"]');
    link.addEventListener("click", (e) => e.preventDefault());
    link.click();
    await flush();
    expect(api).toHaveBeenCalledWith("notifications", { method: "POST", body: { action: "attention", ids: ["salaryConfirmation:item1"], read: true } });
    expect(slot.querySelector('[data-role="bell-drawer"]')).toBeNull();
    await open(slot);
    slot.querySelector('[data-act="bell-read-all"]').click();
    await flush();
    expect(d.markAllRead).toHaveBeenCalledWith(["unrecordedDays:item0", "salaryConfirmation:item1", "advanceConfirmation:item2"]);
    expect(slot.querySelector('[data-role="bell-count"]')).toBeNull();
    expect(texts(slot)).toHaveLength(3);
    // The helper confirms later: the summary stops listing it (that's the only way it goes away).
    list = withIds([0, 1, 2]).filter((x) => x.kind !== "advanceConfirmation");
    await bell.refresh();
    expect(texts(slot)).toHaveLength(2);
    bell.stop();
  });

  it("a notification row: Mark as read / Mark as unread under ⋯; the badge counts unread", async () => {
    const api = vi.fn(async (path) => (path === "household-summary" ? { summary: { todos: [] } } : {}));
    const d = { ...data(), fetchRecent: vi.fn(async () => [{ id: "n1", type: "salary.receipt_confirmed", category: "payroll", title: "Salary confirmed", message: "Loriza confirmed the Oct 1–15 salary.", read: false, createdAt: new Date() }]), markRead: vi.fn(async () => ({})), markUnread: vi.fn(async () => ({})) };
    const slot = document.getElementById("slot");
    const bell = mountBell(slot, home(), { data: d, api });
    await flush();
    expect(slot.querySelector('[data-role="bell-count"]').textContent).toBe("1");
    await open(slot);
    slot.querySelector('[data-notification="n1"] [data-act="bell-read"]').click();
    await flush();
    expect(d.markRead).toHaveBeenCalledWith("n1");
    expect(slot.querySelector('[data-role="bell-count"]')).toBeNull();
    slot.querySelector('[data-notification="n1"] [data-act="bell-unread"]').click();
    await flush();
    expect(d.markUnread).toHaveBeenCalledWith("n1");
    expect(slot.querySelector('[data-role="bell-count"]').textContent).toBe("1");
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
