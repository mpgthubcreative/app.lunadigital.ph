// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderShell } from "../../src/app/shell.js";
import { MODULE_LOADERS } from "../../src/modules/loaders.js";
import { computeEntitlements, PLAN_SEED } from "../../shared/index.js";
import { sessionFixture } from "../helpers/session-fixture.js";

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
});

const navLabels = () => [...document.querySelectorAll(".nav-link")].map((a) => a.textContent.trim());

describe("app shell", () => {
  it("renders the owner's navigation and the staging banner", () => {
    const root = document.getElementById("app");
    const shell = renderShell(root, sessionFixture());
    expect([...root.querySelectorAll(".nav-link")].map((a) => a.getAttribute("href"))).toEqual([
      "/", "/orders", "/payments", "/inventory", "/customers", "/users", "/settings",
    ]);
    expect(root.querySelector(".banner-info").textContent).toMatch(/Staging/);

    shell.setActive({ path: "/orders", label: "Orders" });
    expect(root.querySelector(".nav-link.is-active").getAttribute("href")).toBe("/orders");
    expect(document.title).toBe("Orders · Luna");
  });

  it("shows no environment banner in production", () => {
    renderShell(document.getElementById("app"), sessionFixture({ environment: "production" }));
    expect(document.querySelector(".banner-info")).toBeNull();
  });

  it("builds staff and manager navigation from permissions, not role names", () => {
    renderShell(document.getElementById("app"), sessionFixture({ roleTemplate: "staff" }));
    expect(navLabels()).toEqual(["Dashboard", "Orders", "Payments", "Inventory", "Customers"]);
    renderShell(document.getElementById("app"), sessionFixture({ roleTemplate: "manager" }));
    expect(navLabels()).toEqual(["Dashboard", "Orders", "Payments", "Inventory", "Customers", "Users", "Settings"]);
  });

  it("shows a read-only banner for suspended businesses", () => {
    renderShell(document.getElementById("app"), sessionFixture({ status: "suspended" }));
    expect(document.querySelector(".banner-danger").textContent).toMatch(/changes are disabled/);
  });

  it("escapes tenant-supplied names", () => {
    const session = sessionFixture();
    session.business.name = '<img src=x onerror="window.pwned=1">';
    renderShell(document.getElementById("app"), session);
    expect(document.querySelector(".business-name img")).toBeNull();
    expect(document.querySelector(".business-name").textContent).toBe(session.business.name);
  });

  it("wires sign out", () => {
    const onSignOut = vi.fn();
    renderShell(document.getElementById("app"), sessionFixture(), { onSignOut });
    document.querySelector("#logoutBtn").click();
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("shows a business switcher only for multi-business users", () => {
    renderShell(document.getElementById("app"), sessionFixture());
    expect(document.querySelector("#businessSelect")).toBeNull();

    const onSwitchBusiness = vi.fn();
    renderShell(
      document.getElementById("app"),
      sessionFixture({
        memberships: [
          { businessId: "demo-distributor-a", businessName: "Demo Distributor A", roleLabel: "Staff" },
          { businessId: "demo-distributor-b", businessName: "Demo Distributor B", roleLabel: "Manager / Admin" },
        ],
      }),
      { onSwitchBusiness }
    );
    const select = document.querySelector("#businessSelect");
    expect(select.value).toBe("demo-distributor-a");
    select.value = "demo-distributor-b";
    select.dispatchEvent(new Event("change"));
    expect(onSwitchBusiness).toHaveBeenCalledWith("demo-distributor-b");
  });

  it("every module loader mounts without throwing", async () => {
    const session = sessionFixture();
    session.entitlements = computeEntitlements(PLAN_SEED.pro, {}, "distributor");
    for (const [id, load] of Object.entries(MODULE_LOADERS)) {
      const el = document.createElement("div");
      const mod = await load();
      mod.mount(el, session);
      expect(el.querySelector(".page-title"), id).not.toBeNull();
    }
  });
});
