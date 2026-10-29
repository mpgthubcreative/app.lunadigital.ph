// @vitest-environment jsdom
// Per-user navigation: the phone tab bar follows the member's own order
// (up to three main pages + More), Settings → Arrange navigation edits it.
// Household (2026-10-29): the main pages are Attendance, Expenses and
// Grocery List; Payroll, Advances, Household Staff and Bills live in More
// (the overviews), so they can't be main tabs and a saved order that names
// them falls back to the default.

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
  it("default: Attendance · Expenses · Grocery · More; Payroll and Advances first in More", () => {
    renderShell(document.getElementById("app"), home());
    expect(tabs()).toEqual(["Attendance", "Expenses", "Grocery", "More"]);
    expect(more().slice(0, 2)).toEqual(["Payroll", "Advances"]);
    expect(more()).toEqual(expect.arrayContaining(["Household Staff", "Bills", "Users", "Settings"]));
    expect(more()).not.toContain("Attendance");
  });

  it("desktop sidebar: Attendance · Expenses · Grocery List, then More (Payroll, Advances, …)", () => {
    renderShell(document.getElementById("app"), home());
    const group = (g) => [...document.querySelectorAll(`.nav-group[data-group="${g}"] .nav-link`)].map((a) => a.textContent.trim());
    expect(group("work")).toEqual(["Attendance", "Expenses", "Grocery List"]);
    expect(document.querySelector('.nav-group[data-group="manage"] .nav-group-label').textContent).toBe("More");
    expect(group("manage").slice(0, 4)).toEqual(["Payroll", "Advances", "Household Staff", "Bills"]);
  });

  it("the member's order: Grocery · Attendance · Expenses; nothing else changes", () => {
    renderShell(document.getElementById("app"), home({ primary: ["grocery", "attendance", "expenses"] }));
    expect(tabs()).toEqual(["Grocery", "Attendance", "Expenses", "More"]);
  });

  it("a saved order naming Payroll or Bills (before 2026-10-29): those stay in More, the default fills in; never a fourth tab", () => {
    renderShell(document.getElementById("app"), home({ primary: ["expenses", "grocery", "payroll"] }));
    expect(tabs()).toEqual(["Expenses", "Grocery", "Attendance", "More"]);
    expect(more()).toContain("Payroll");
    const s = home({ primary: ["schedule", "payroll"] });
    expect(mobileTabs(shellNavigation(s), "household-payroll", s.member.navigationPreference).map((m) => m.id)).toEqual(["attendance", "expenses", "grocery"]);
  });

  it("pages this member can't open are skipped and the default fills in", () => {
    const s = home({ primary: ["grocery", "providers", "orders"] });
    const t = mobileTabs(shellNavigation(s), "household-payroll", s.member.navigationPreference).map((m) => m.id);
    expect(t).toEqual(["grocery", "attendance", "expenses"]);
  });
});

describe("Settings → Arrange navigation", () => {
  const box = () => document.getElementById("box");
  const rows = (role) => [...box().querySelectorAll(`[data-role="${role}"] .wl-name`)].map((e) => e.textContent.trim());
  const click = (sel) => box().querySelector(sel).click();

  it("lists the main pages in order; household staff don't get it", () => {
    mountArrangeNav(box(), home(), { api: vi.fn(), toast: () => {}, onSaved: () => {} });
    expect(rows("primary")).toEqual(["1. Attendance", "2. Expenses", "3. Grocery List"]);
    expect(rows("others")).not.toContain("Payroll");
    expect(canArrange(home())).toBe(true);
    expect(canArrange(home(null, "household_staff"))).toBe(false);
  });

  it("move up / down (accessible buttons), then Save sends the order", async () => {
    const api = vi.fn(async () => ({ success: true }));
    const onSaved = vi.fn();
    const s = home();
    mountArrangeNav(box(), s, { api, toast: () => {}, onSaved });
    click('[aria-label="Move Expenses up"]');
    expect(rows("primary")).toEqual(["1. Expenses", "2. Attendance", "3. Grocery List"]);
    click('[aria-label="Move Attendance down"]');
    expect(rows("primary")).toEqual(["1. Expenses", "2. Grocery List", "3. Attendance"]);
    click('[data-act="save"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(api).toHaveBeenCalledWith("preferences", { method: "POST", body: { action: "setNavigation", navigation: { primary: ["expenses", "grocery", "attendance"] } } });
    expect(onSaved).toHaveBeenCalled();
    expect(s.member.navigationPreference).toEqual({ primary: ["expenses", "grocery", "attendance"] });
  });

  it("Remove moves a page to More (at least one stays); Reset to default sends null", async () => {
    const api = vi.fn(async () => ({ success: true }));
    mountArrangeNav(box(), home({ primary: ["grocery", "expenses"] }), { api, toast: () => {}, onSaved: () => {} });
    expect(rows("primary")).toEqual(["1. Grocery List", "2. Expenses", "3. Attendance"]);
    click('[aria-label="Move Grocery List to More"]');
    expect(rows("primary")).toEqual(["1. Expenses", "2. Attendance"]);
    expect(rows("others")).toContain("Grocery List");
    click('[data-act="reset"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(api).toHaveBeenCalledWith("preferences", { method: "POST", body: { action: "setNavigation", navigation: null } });
    expect(rows("primary")).toEqual(["1. Attendance", "2. Expenses", "3. Grocery List"]);
  });
});
