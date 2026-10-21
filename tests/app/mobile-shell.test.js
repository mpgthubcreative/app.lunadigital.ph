// @vitest-environment jsdom
// The phone bottom tabs (2026-10-21, iPhone): fixed to the screen's bottom
// with the safe area, the shell at least the full screen (lvh) so a short
// page never leaves them above a blank gap, a new page starts at the top,
// and the tabs step aside while the keyboard is open.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderShell, isTyping } from "../../src/app/shell.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const layout = readFileSync(`${process.cwd()}/src/styles/layout.css`, "utf8");
const tokens = readFileSync(`${process.cwd()}/src/styles/tokens.css`, "utf8");
const main = readFileSync(`${process.cwd()}/src/app/main.js`, "utf8");
const phone = layout.slice(layout.indexOf("@media (max-width: 719px)"));

describe("phone layout CSS (every workspace: one shell)", () => {
  it("the tabs are fixed to the bottom, above the safe area", () => {
    expect(phone).toMatch(/\.tabbar \{\s*position: fixed;\s*inset: auto 0 0 0;/);
    expect(phone).toMatch(/\.tabbar \{[^}]*var\(--safe-bottom\)/);
    expect(tokens).toMatch(/--safe-bottom: env\(safe-area-inset-bottom, 0px\)/);
  });
  it("page content ends above the tabs + safe area (the last button stays reachable)", () => {
    expect(tokens).toMatch(/--bottom-nav-space: calc\(var\(--tabbar-height\) \+ var\(--safe-bottom\)/);
    expect(phone).toMatch(/\.content \{[^}]*var\(--bottom-nav-space\)/);
    expect(phone).toMatch(/scroll-padding-bottom: var\(--bottom-nav-space\)/);
  });
  it("the shell is at least the full screen with Safari's toolbar collapsed (lvh, not dvh)", () => {
    const shell = layout.slice(layout.indexOf(".shell {"), layout.indexOf("}", layout.indexOf(".shell {")));
    expect(shell).toContain("min-height: 100lvh");
    expect(shell).not.toContain("100dvh");
  });
  it("the tabs hide while the keyboard is open", () => {
    expect(phone).toMatch(/\.shell\.keyboard-open \.tabbar \{\s*display: none;/);
  });
  it("a new page starts at the top (not the old scroll position)", () => {
    expect(main).toMatch(/if \(route\.path !== shownPath\) window\.scrollTo\(0, 0\);/);
  });
});

describe("keyboard open / closed", () => {
  let vv;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", vv);
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    window.scrollTo = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());
  const shell = () => document.getElementById("shell");

  it("typing in a field with the keyboard up hides the tabs; closing it brings them back and re-anchors the page", () => {
    renderShell(document.getElementById("app"), sessionFixture());
    const input = Object.assign(document.createElement("input"), { type: "text" });
    document.getElementById("content").append(input);
    input.focus();
    vv.height = 500;
    vv.dispatchEvent(new Event("resize"));
    expect(shell().classList.contains("keyboard-open")).toBe(true);
    input.blur();
    vv.height = 844;
    vv.dispatchEvent(new Event("resize"));
    expect(shell().classList.contains("keyboard-open")).toBe(false);
    expect(window.scrollTo).toHaveBeenCalled();
  });
  it("a smaller viewport without a text field focused (toolbar, rotation) keeps the tabs", () => {
    renderShell(document.getElementById("app"), sessionFixture());
    vv.height = 500;
    vv.dispatchEvent(new Event("resize"));
    expect(shell().classList.contains("keyboard-open")).toBe(false);
  });
  it("what counts as typing", () => {
    const el = (tag, type) => Object.assign(document.createElement(tag), type ? { type } : {});
    expect([el("input", "text"), el("input", "number"), el("input", "date"), el("textarea"), el("select")].every(isTyping)).toBe(true);
    expect([el("input", "checkbox"), el("input", "radio"), el("input", "file"), el("button"), null].some(isTyping)).toBe(false);
  });
});
