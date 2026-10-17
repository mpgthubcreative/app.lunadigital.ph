// @vitest-environment jsdom
// Per-user navigation: the phone tab bar follows the member's own order
// (up to three main pages + More), Settings → Arrange navigation edits it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderShell, mobileTabs, shellNavigation } from "../../src/app/shell.js";
import { mountArrangeNav, canArrange } from "../../src/modules/settings/arrange-nav.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const home = (pref = null, role = "owner") => {
  const s = sessionFixture({ roleTemplate: role, planId: "household-plus", workspaceTemplateId: "household-payroll" });
  s.member.navigationPreference = pref;
  return s;
};
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="box"></div>';
});
const tabs = () => [...document.querySelectorAll(".tabbar .tab-link")].map((a) => a.textContent.trim());
const more = () => [...document.querySelectorAll("#moreSheet .sheet-link[data-sheet]")].map((a) => a.textContent.trim());

describe("phone tab bar", () => {
  it("default: Payroll · Attendance · Expenses · More; Grocery List in More", () => {
    renderShell(document.getElementById("app"), home());
    expect(tabs()).toEqual(["Payroll", "Attendance", "Expenses", "More"]);
    expect(more()).toContain("Grocery List");
  });

  it("the member's order: Expenses · Grocery · Payroll · More; Attendance moves to More; nothing else changes", () => {
    renderShell(document.getElementById("app"), home({ primary: ["expenses", "grocery", "payroll"] }));
    expect(tabs()).toEqual(["Expenses", "Grocery", "Payroll", "More"]);
    expect(more()).toContain("Attendance");
    expect(more()).not.toContain("Grocery List");
    expect([...document.querySelectorAll(".nav-link")].map((a) => a.textContent.trim())).toContain("Grocery List"); // desktop sidebar unchanged
  });

  it("pages this member can't open are skipped and the default fills in; never a fourth tab", () => {
    const s = home({ primary: ["grocery", "providers", "orders"] });
    const t = mobileTabs(shellNavigation(s), "household-payroll", s.member.navigationPreference).map((m) => m.id);
    expect(t).toEqual(["grocery", "payroll", "attendance"]);
  });

  it("Bills keeps its Household name on a tab", () => {
    renderShell(document.getElementById("app"), home({ primary: ["schedule", "payroll"] }));
    expect(tabs()).toEqual(["Bills", "Payroll", "Attendance", "More"]);
  });
});

describe("Settings → Arrange navigation", () => {
  const box = () => document.getElementById("box");
  const rows = (role) => [...box().querySelectorAll(`[data-role="${role}"] .wl-name`)].map((e) => e.textContent.trim());
  const click = (sel) => box().querySelector(sel).click();

  it("lists the main pages in order and the other pages; household staff don't get it", () => {
    mountArrangeNav(box(), home(), { api: vi.fn(), toast: () => {}, onSaved: () => {} });
    expect(rows("primary")).toEqual(["1. Payroll", "2. Attendance", "3. Expenses"]);
    expect(rows("others")).toEqual(expect.arrayContaining(["Advances", "Household Staff", "Bills", "Grocery List"]));
    expect(canArrange(home())).toBe(true);
    expect(canArrange(home(null, "household_staff"))).toBe(false);
  });

  it("move up / down (accessible buttons), then Save sends the order", async () => {
    const api = vi.fn(async () => ({ success: true }));
    const onSaved = vi.fn();
    const s = home();
    mountArrangeNav(box(), s, { api, toast: () => {}, onSaved });
    click('[aria-label="Move Expenses up"]');
    expect(rows("primary")).toEqual(["1. Payroll", "2. Expenses", "3. Attendance"]);
    click('[aria-label="Move Payroll down"]');
    expect(rows("primary")).toEqual(["1. Expenses", "2. Payroll", "3. Attendance"]);
    click('[data-act="save"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(api).toHaveBeenCalledWith("preferences", { method: "POST", body: { action: "setNavigation", navigation: { primary: ["expenses", "payroll", "attendance"] } } });
    expect(onSaved).toHaveBeenCalled();
    expect(s.member.navigationPreference).toEqual({ primary: ["expenses", "payroll", "attendance"] });
  });

  it("adding a fourth page asks which one to replace (never a fourth tab)", () => {
    mountArrangeNav(box(), home(), { api: vi.fn(), toast: () => {}, onSaved: () => {} });
    click('[aria-label="Add Grocery List to the main navigation"]');
    expect(box().querySelector('[data-page="grocery"]').textContent).toMatch(/Replace which one\?/);
    click('[aria-label="Replace Attendance with Grocery List"]');
    expect(rows("primary")).toEqual(["1. Payroll", "2. Grocery List", "3. Expenses"]);
    expect(rows("others")).toContain("Attendance");
  });

  it("Remove moves a page to More (at least one stays); Reset to default sends null", async () => {
    const api = vi.fn(async () => ({ success: true }));
    mountArrangeNav(box(), home({ primary: ["grocery", "expenses"] }), { api, toast: () => {}, onSaved: () => {} });
    expect(rows("primary")).toEqual(["1. Grocery List", "2. Expenses", "3. Payroll"]);
    click('[aria-label="Move Grocery List to More"]');
    expect(rows("primary")).toEqual(["1. Expenses", "2. Payroll"]);
    click('[data-act="reset"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(api).toHaveBeenCalledWith("preferences", { method: "POST", body: { action: "setNavigation", navigation: null } });
    expect(rows("primary")).toEqual(["1. Payroll", "2. Attendance", "3. Expenses"]);
  });
});
