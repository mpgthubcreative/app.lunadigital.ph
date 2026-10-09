// @vitest-environment jsdom
// Phase 13 screens: the shell's bell (count from one document, compact
// drawer of the latest few, mark read / all), the Notifications page
// (compact rows, filters, pagination, no-access rows, preferences) and the
// route.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mountBell } from "../../src/app/notification-bell.js";
import { mount as mountPage } from "../../src/modules/notifications/index.js";
import { notificationRow, ago, myCategories, badgeText } from "../../src/modules/notifications/view.js";
import { buildRoutes, routeAllowed } from "../../src/app/routes.js";
import { renderShell } from "../../src/app/shell.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const NOW = new Date("2026-10-08T06:00:00Z");
const session = (role = "owner", overrides, extra = {}) => sessionFixture({ roleTemplate: role, permissions: overrides ? resolvePermissions(role, overrides) : undefined, ...extra });

const n = (id, extra = {}) => ({ id, type: "payment.awaiting_verification", category: "payments", title: "Payment awaiting verification", message: "₱2,000.00 GCash received for ORD-1045.", read: false, resolved: false, createdAt: new Date(NOW.getTime() - 5 * 60000), ...extra });
const low = (id, extra = {}) => n(id, { type: "inventory.low_stock", category: "inventory", title: "Low stock", message: "Chicken Wings is down to 4 pcs available (reorder level 5).", ...extra });

function fakeData(rows = [n("n1"), low("n2", { read: true })], count = 1) {
  return {
    count,
    fetchUnreadCount: vi.fn(async function () {
      return this.count;
    }),
    fetchRecent: vi.fn(async () => rows),
    listNotifications: vi.fn(async () => ({ rows, hasMore: true })),
    markRead: vi.fn(async () => ({ unread: 0 })),
    markAllRead: vi.fn(async () => ({ marked: 1, unread: 0 })),
    savePreferences: vi.fn(async (p) => ({ preferences: p })),
  };
}

let slot;
beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div><main id="content"></main>';
  slot = document.getElementById("slot");
});

describe("view helpers", () => {
  it("relative times, the 99+ cap, rows with/without access", () => {
    expect(ago(new Date(NOW - 20000), NOW)).toBe("just now");
    expect(ago(new Date(NOW - 5 * 60000), NOW)).toBe("5 min ago");
    expect(ago(new Date(NOW - 3 * 3600000), NOW)).toBe("3 h ago");
    expect(ago(new Date(NOW - 30 * 3600000), NOW)).toBe("yesterday");
    expect(ago({ seconds: Math.floor(new Date("2026-09-01T00:00:00Z") / 1000) }, NOW)).toBe("Sep 1");
    expect(badgeText(150)).toBe("99+");
    expect(notificationRow(n("x"), session(), NOW)).toMatchObject({ unread: true, status: "Unread", time: "5 min ago", action: { label: "Review payment", route: "/payments" } });
    // permission lost later: no link
    expect(notificationRow(n("x"), session("manager", { revoke: ["payments.verify"] }), NOW).action).toBeNull();
    expect(notificationRow(n("x", { resolved: true, read: true }), session(), NOW).status).toBe("Resolved");
    // unknown / forged type: never a link
    expect(notificationRow(n("x", { type: "evil", action: { route: "https://evil.test" } }), session(), NOW).action).toBeNull();
  });

  it("categories follow what the user can receive", () => {
    expect(myCategories(session("owner")).sort()).toEqual(["inventory", "orders", "payments"]);
    expect(myCategories(session("staff")).sort()).toEqual(["orders"]);
    expect(myCategories(session("owner", null, { workspaceTemplateId: "bridal-expense", planId: "pro" }))).toEqual([]);
  });
});

describe("bell", () => {
  it("shows the unread count from one read; opens a compact drawer with the latest; read rows de-emphasised", async () => {
    const data = fakeData();
    const bell = mountBell(slot, session(), { data, now: () => NOW });
    await flush();
    expect(data.fetchUnreadCount).toHaveBeenCalledWith("demo-distributor-a", "u1");
    expect(slot.querySelector('[data-role="bell-count"]').textContent).toBe("1");
    expect(data.fetchRecent).not.toHaveBeenCalled(); // only when opened
    slot.querySelector('[data-act="bell"]').click();
    await flush();
    const items = slot.querySelectorAll(".bell-item");
    expect(items).toHaveLength(2);
    expect(items[0].classList.contains("is-unread")).toBe(true);
    expect(items[0].textContent).toContain("Payment awaiting verification");
    expect(items[0].textContent).toContain("5 min ago");
    expect(items[0].querySelector('a[data-link]').getAttribute("href")).toBe("/payments");
    expect(items[1].classList.contains("is-read")).toBe(true);
    bell.stop();
  });

  it("mark all as read clears the count; following a link marks that one read", async () => {
    const data = fakeData();
    const bell = mountBell(slot, session(), { data, now: () => NOW });
    await flush();
    slot.querySelector('[data-act="bell"]').click();
    await flush();
    slot.querySelector('[data-act="bell-read-all"]').click();
    await flush();
    expect(data.markAllRead).toHaveBeenCalled();
    expect(slot.querySelector('[data-role="bell-count"]')).toBeNull();
    slot.querySelector('[data-act="bell"]').click();
    slot.querySelector('[data-act="bell"]').click();
    await flush();
    slot.querySelector('[data-act="bell-open"]').click();
    await flush();
    expect(data.markRead).toHaveBeenCalledWith("n1");
    bell.stop();
  });

  it("no count shown at zero; a failed count read never breaks the shell", async () => {
    const data = fakeData([], 0);
    mountBell(slot, session(), { data }).stop();
    await flush();
    expect(slot.querySelector('[data-role="bell-count"]')).toBeNull();
    const broken = { fetchUnreadCount: vi.fn(async () => { throw new Error("offline"); }) };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bell = mountBell(slot, session(), { data: broken });
    await flush();
    expect(slot.querySelector(".bell-btn")).not.toBeNull();
    bell.stop();
  });

  it("the shell shows the bell only with notifications.view and in-app notifications", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const shell = renderShell(root, session("owner"), { bell: { data: fakeData([], 0) } });
    expect(root.querySelector("#bellSlot")).not.toBeNull();
    shell.stopNotifications();
    const shell2 = renderShell(root, session("manager", { revoke: ["notifications.view"] }));
    expect(root.querySelector("#bellSlot")).toBeNull();
    shell2.stopNotifications();
  });
});

describe("Notifications page", () => {
  it("compact rows, statuses, links only with access; next page uses the last row as cursor", async () => {
    const data = fakeData([n("n1"), low("n2", { read: true }), n("n3", { read: true, resolved: true })]);
    const container = document.getElementById("content");
    const unmount = mountPage(container, session(), { data, now: () => NOW, onChange: () => {} });
    await flush();
    expect(data.listNotifications).toHaveBeenCalledWith("demo-distributor-a", "u1", { unread: false, category: "" }, { cursor: null });
    const rows = container.querySelectorAll("tr[data-notification]");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Unread");
    expect(rows[0].querySelector('[data-act="read"]')).not.toBeNull();
    expect(rows[1].classList.contains("is-read")).toBe(true);
    expect(rows[2].textContent).toContain("Resolved");
    container.querySelector('[data-act="next"]').click();
    await flush();
    expect(data.listNotifications.mock.calls.at(-1)[3].cursor.id).toBe("n3");
    unmount();
  });

  it("filters: unread + category; mark read; mark all read", async () => {
    const data = fakeData();
    const container = document.getElementById("content");
    const changed = vi.fn();
    mountPage(container, session(), { data, now: () => NOW, onChange: changed, toast: () => {} });
    await flush();
    const form = container.querySelector('[data-role="filters"]');
    form.elements.show.value = "unread";
    form.elements.category.value = "inventory";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(data.listNotifications.mock.calls.at(-1)[2]).toEqual({ unread: true, category: "inventory" });
    container.querySelector('[data-act="read"]').click();
    await flush();
    expect(data.markRead).toHaveBeenCalledWith("n1");
    container.querySelector('[data-act="read-all"]').click();
    await flush();
    expect(data.markAllRead).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
  });

  it("a row the user can no longer open says so instead of linking", async () => {
    const data = fakeData([n("n1")]);
    const container = document.getElementById("content");
    mountPage(container, session("manager", { revoke: ["payments.verify"] }), { data, now: () => NOW, onChange: () => {} });
    await flush();
    const row = container.querySelector("tr[data-notification]");
    expect(row.querySelector("a")).toBeNull();
    expect(row.textContent).toContain("No access");
  });

  it("preferences: optional categories can be switched off; payments are always on", async () => {
    const data = fakeData([]);
    const container = document.getElementById("content");
    mountPage(container, session(), { data, now: () => NOW, onChange: () => {}, toast: () => {} });
    await flush();
    const form = container.querySelector('[data-role="preferences"]');
    expect(form.elements.payments.disabled).toBe(true);
    expect(form.elements.payments.checked).toBe(true);
    form.elements.inventory.checked = false;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(data.savePreferences).toHaveBeenCalledWith({ inventory: { inApp: false }, orders: { inApp: true } });
  });

  it("staff see only the categories they can receive", async () => {
    const container = document.getElementById("content");
    mountPage(container, session("staff"), { data: fakeData([]), now: () => NOW, onChange: () => {} });
    await flush();
    const form = container.querySelector('[data-role="preferences"]');
    expect([...form.querySelectorAll("input")].map((i) => i.name)).toEqual(["orders"]);
  });
});

describe("route", () => {
  it("exists for users with notifications; not without the permission or the package feature", () => {
    const has = (s) => buildRoutes(s).some((r) => r.path === "/notifications");
    expect(has(session("owner"))).toBe(true);
    expect(has(session("staff"))).toBe(true);
    expect(has(session("manager", { revoke: ["notifications.view"] }))).toBe(false);
    const noFeature = session("owner");
    noFeature.entitlements.features.inAppNotifications = false;
    expect(has(noFeature)).toBe(false);
    expect(routeAllowed(noFeature, { path: "/notifications", moduleId: "notifications" })).toBe(false);
  });
});
