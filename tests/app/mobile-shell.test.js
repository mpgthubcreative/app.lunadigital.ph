// @vitest-environment jsdom
// The phone app frame (2026-10-21, second pass; every workspace): the app
// is a fixed frame the size of the visible screen, the main column is its
// one scroller and the tabs are its bottom row. The document never scrolls
// (so iPhone Safari can't leave it offset with the tabs above a blank gap);
// a new page starts at the top of the real scroller; the tabs step aside
// while the keyboard is open and the frame is re-anchored afterwards.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderShell, isTyping } from "../../src/app/shell.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const layout = readFileSync(`${process.cwd()}/src/styles/layout.css`, "utf8");
const tokens = readFileSync(`${process.cwd()}/src/styles/tokens.css`, "utf8");
const components = readFileSync(`${process.cwd()}/src/styles/components.css`, "utf8");
const main = readFileSync(`${process.cwd()}/src/app/main.js`, "utf8");
const phone = layout.slice(layout.indexOf("@media (max-width: 719px)"));
const rule = (css, sel) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
};

describe("phone app frame CSS (one shell for every workspace)", () => {
  it("the document never scrolls on a phone with the app open (not the console, not public pages)", () => {
    expect(phone).toMatch(/html:has\(\.shell:not\(\.console-shell\)\),\s*html:has\(\.shell:not\(\.console-shell\)\) body \{\s*height: 100%;\s*min-height: 0;\s*overflow: hidden;/);
  });
  it("the frame is the visible screen (inset 0, no vh / dvh height) and the main column is the one scroller", () => {
    const frame = rule(phone, ".shell:not(.console-shell)");
    expect(frame).toMatch(/position: fixed;\s*inset: 0;\s*display: flex;\s*flex-direction: column;/);
    expect(frame).not.toMatch(/vh/);
    const scroller = rule(phone, ".shell:not(.console-shell) > .main-col");
    expect(scroller).toMatch(/flex: 1 1 auto;\s*min-height: 0;/);
    expect(scroller).toMatch(/overflow-y: auto;/);
    expect(scroller).toMatch(/overscroll-behavior-y: contain;/);
  });
  it("the tabs are the frame's bottom row (not floating), above the safe area", () => {
    const tabs = rule(phone, ".tabbar");
    expect(tabs).toMatch(/position: relative;\s*flex: none;/);
    expect(tabs).not.toMatch(/position: fixed/);
    expect(tabs).toMatch(/var\(--safe-bottom\)/);
    expect(tokens).toMatch(/--safe-bottom: env\(safe-area-inset-bottom, 0px\)/);
  });
  it("page content needs only its own bottom space; sticky savers sit inside the scroller", () => {
    expect(rule(phone, ".content")).toMatch(/var\(--space-8\)/);
    expect(rule(phone, ".content")).not.toMatch(/bottom-nav-space/);
    expect(rule(components, ".att-save")).toMatch(/bottom: var\(--space-2\);/);
  });
  it("the tabs hide while the keyboard is open", () => {
    expect(phone).toMatch(/\.shell\.keyboard-open \.tabbar \{\s*display: none;/);
  });
  it("a new page starts at the top of the real scroller", () => {
    expect(main).toMatch(/if \(route\.path !== shownPath\) shell\.scrollToTop\(\);/);
  });
});

describe("the shell's scroll and keyboard handling", () => {
  let vv;
  let isPhone;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    isPhone = true;
    vi.stubGlobal("visualViewport", vv);
    vi.stubGlobal("matchMedia", (q) => ({ matches: q === "(max-width: 719px)" && isPhone }));
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    window.scrollTo = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());
  const shell = () => document.getElementById("shell");

  it("scrollToTop resets the main column (the phone's scroller) and the document", () => {
    const s = renderShell(document.getElementById("app"), sessionFixture());
    const col = document.querySelector(".main-col");
    col.scrollTop = 900;
    s.scrollToTop();
    expect(col.scrollTop).toBe(0);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });
  it("keyboard up while typing hides the tabs; closing it brings them back and re-anchors the document", () => {
    renderShell(document.getElementById("app"), sessionFixture());
    const input = Object.assign(document.createElement("input"), { type: "text" });
    document.getElementById("content").append(input);
    input.focus();
    vv.height = 500;
    vv.dispatchEvent(new Event("resize"));
    expect(shell().classList.contains("keyboard-open")).toBe(true);
    input.blur();
    vv.height = 844;
    Object.defineProperty(window, "scrollY", { value: 120, configurable: true });
    vv.dispatchEvent(new Event("resize"));
    expect(shell().classList.contains("keyboard-open")).toBe(false);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });
  it("Android (the layout shrinks with the keyboard) is detected too", () => {
    renderShell(document.getElementById("app"), sessionFixture());
    const input = Object.assign(document.createElement("textarea"));
    document.getElementById("content").append(input);
    input.focus();
    Object.defineProperty(window, "innerHeight", { value: 480, configurable: true });
    vv.height = 480;
    vv.dispatchEvent(new Event("resize"));
    expect(shell().classList.contains("keyboard-open")).toBe(true);
  });
  it("Safari leaving the document scrolled (nobody typing) is put back to 0 at once", () => {
    renderShell(document.getElementById("app"), sessionFixture());
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
    window.dispatchEvent(new Event("scroll"));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });
  it("while typing, Safari may pan the document to the field (left alone)", () => {
    renderShell(document.getElementById("app"), sessionFixture());
    const input = Object.assign(document.createElement("input"), { type: "email" });
    document.getElementById("content").append(input);
    input.focus();
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
    window.dispatchEvent(new Event("scroll"));
    expect(window.scrollTo).not.toHaveBeenCalled();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });
  it("desktop / tablet: the document scrolls normally (nothing re-anchored, tabs not involved)", () => {
    isPhone = false;
    renderShell(document.getElementById("app"), sessionFixture());
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
    window.dispatchEvent(new Event("scroll"));
    expect(window.scrollTo).not.toHaveBeenCalled();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });
  it("a smaller viewport without a text field focused keeps the tabs", () => {
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
