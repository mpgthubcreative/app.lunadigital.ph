// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderShell } from "../../src/app/shell.js";
import { loadSession } from "../../src/app/session.js";
import { MODULE_LOADERS } from "../../src/modules/loaders.js";
import { computeEntitlements, resolvePermissions, PLAN_SEED } from "../../shared/index.js";

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
});

describe("app shell", () => {
  it("renders navigation from the preview session and marks it as a preview", async () => {
    const session = await loadSession();
    const root = document.getElementById("app");
    const shell = renderShell(root, session);

    const links = [...root.querySelectorAll(".nav-link")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/", "/orders", "/payments", "/inventory", "/customers", "/reports", "/imports", "/users", "/settings"]);
    expect(root.querySelector(".banner-info").textContent).toMatch(/Foundation preview/);

    shell.setActive({ path: "/orders", label: "Orders" });
    expect(root.querySelector(".nav-link.is-active").getAttribute("href")).toBe("/orders");
    expect(document.title).toBe("Orders · Luna");
  });

  it("builds staff navigation from permissions, not role names", async () => {
    const session = await loadSession();
    session.member = { roleLabel: "Staff", permissions: resolvePermissions("staff") };
    renderShell(document.getElementById("app"), session);
    const links = [...document.querySelectorAll(".nav-link")].map((a) => a.textContent.trim());
    expect(links).toEqual(["Dashboard", "Orders", "Payments", "Inventory", "Customers"]);
  });

  it("shows a read-only banner for suspended businesses", async () => {
    const session = await loadSession();
    session.preview = false;
    session.subscription = { status: "suspended" };
    renderShell(document.getElementById("app"), session);
    expect(document.querySelector(".banner-danger").textContent).toMatch(/read|suspended/i);
  });

  it("escapes tenant-supplied names", async () => {
    const session = await loadSession();
    session.business.name = '<img src=x onerror="window.pwned=1">';
    renderShell(document.getElementById("app"), session);
    expect(document.querySelector(".business-name img")).toBeNull();
    expect(document.querySelector(".business-name").textContent).toBe(session.business.name);
  });

  it("every module loader mounts without throwing", async () => {
    const session = await loadSession();
    session.entitlements = computeEntitlements(PLAN_SEED.pro);
    for (const [id, load] of Object.entries(MODULE_LOADERS)) {
      const el = document.createElement("div");
      const mod = await load();
      mod.mount(el, session);
      expect(el.querySelector(".page-title"), id).not.toBeNull();
    }
  });
});
