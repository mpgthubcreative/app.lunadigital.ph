// @vitest-environment jsdom
// ⋯ menus are placed from the real space around the ⋯ (components/menus.js,
// 2026-10-21): down when they fit below, else up, else on the roomier side
// with their own scroll; never under the phone's bottom tabs (or, without
// tabs, the iPhone home-indicator area), never past a screen edge, and
// `position: fixed` so no card, table or scroll column clips them.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMenuBehavior, placeMenu, usableArea } from "../../src/components/menus.js";
import { rowMenu, bindRowMenus } from "../../src/components/ui.js";
import { render } from "../../src/lib/html.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const rect = (el, r) => {
  el.getBoundingClientRect = () => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height, x: r.left, y: r.top });
};
const size = (el, w, h) => {
  Object.defineProperty(el, "offsetWidth", { configurable: true, get: () => w });
  Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => h });
};
let uninstall;
let unbind;
beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 }));
  document.body.innerHTML = `<div class="shell"><div class="main-col"><header class="topbar" id="top" style="position: sticky"></header><main id="page">
      <details class="line-menu" id="m"><summary>⋯</summary><div class="line-menu-list"><button class="menu-item">Edit</button><button class="menu-item">Details</button><button class="menu-item">Remove</button></div></details>
      <div id="rm"></div>
    </main></div><nav class="tabbar" id="tabs"></nav></div>`;
  render(document.getElementById("rm"), rowMenu("x1", [{ act: "edit", label: "Edit" }, { act: "remove", label: "Remove" }]));
  rect(document.getElementById("top"), { left: 0, top: 0, width: 390, height: 56 });
  rect(document.getElementById("tabs"), { left: 0, top: 782, width: 390, height: 62 }); // tabs incl. safe area
  size(document.querySelector("#m .line-menu-list"), 220, 140);
  size(document.querySelector("#rm .menu"), 200, 96);
  unbind = bindRowMenus(document.getElementById("page"));
  uninstall = installMenuBehavior(document);
});
afterEach(() => {
  uninstall();
  unbind();
  vi.unstubAllGlobals();
});
const $ = (s) => document.querySelector(s);
const px = (el, k) => parseFloat(el.style.getPropertyValue(k));

describe("the usable screen", () => {
  it("is below the top bar and above the bottom tabs (they already include the home-indicator space)", () => {
    expect(usableArea(document)).toEqual({ top: 64, bottom: 774, left: 8, right: 382 });
  });
  it("follows the visible viewport (keyboard open): the bottom is the top of the keyboard", () => {
    window.visualViewport.height = 500;
    expect(usableArea(document).bottom).toBe(492);
  });
});

describe("placement (the ⋯ near the top, middle, and last rows)", () => {
  const open = (top) => {
    rect($("#m > summary"), { left: 340, top, width: 44, height: 44 });
    $("#m").open = true;
    $("#m").dispatchEvent(new Event("toggle"));
    return $("#m .line-menu-list");
  };
  it("room below: opens downward, its end lined up with the ⋯, fixed (no container clips it), above the tabs in layering", () => {
    const list = open(100);
    expect($("#m").dataset.menuPlaced).toBe("down");
    expect(list.style.position).toBe("fixed");
    expect(px(list, "top")).toBe(148); // 100 + 44 + 4
    expect(px(list, "left")).toBe(162); // 384 − 220, moved inward to the 8 px edge (382 − 220)
    expect(list.style.zIndex).toBe("55");
  });
  it("the last row above the tabs (not enough room below): opens upward, fully above the tabs", () => {
    const list = open(720);
    expect($("#m").dataset.menuPlaced).toBe("up");
    expect(px(list, "top")).toBe(720 - 4 - 140);
    expect(px(list, "top") + 140).toBeLessThanOrEqual(782);
  });
  it("a middle row with room both ways: down", () => {
    open(400);
    expect($("#m").dataset.menuPlaced).toBe("down");
  });
  it("a long menu that fits on neither side but on the screen (Super Admin): shown whole, shifted over its ⋯, no scroll", () => {
    size($("#m .line-menu-list"), 220, 520);
    const list = open(400); // 336 above, 326 below; the screen has 710
    expect(px(list, "top")).toBeGreaterThanOrEqual(64);
    expect(px(list, "top") + 520).toBeLessThanOrEqual(774);
    expect(list.style.maxHeight).toBe("");
    expect(list.style.overflowY).toBe("");
  });
  it("a menu taller than the whole usable screen: fills it and scrolls inside", () => {
    size($("#m .line-menu-list"), 220, 900);
    const list = open(500);
    expect(px(list, "max-height")).toBe(774 - 64);
    expect(list.style.overflowY).toBe("auto");
    expect(px(list, "top")).toBe(64);
  });
  it("near the left edge: moves inward instead of off-screen", () => {
    rect($("#m > summary"), { left: 0, top: 100, width: 44, height: 44 });
    $("#m").open = true;
    $("#m").dispatchEvent(new Event("toggle"));
    expect(px($("#m .line-menu-list"), "left")).toBe(8);
  });
  it("closing resets it (the next opening measures again)", () => {
    open(720);
    $("#m").open = false;
    $("#m").dispatchEvent(new Event("toggle"));
    expect($("#m .line-menu-list").getAttribute("style")).toBeNull();
    expect($("#m").dataset.menuPlaced).toBeUndefined();
  });
});

describe("the other menu kind (rowMenu, the console and Baby / Customers rows)", () => {
  it("is placed when shown: up near the bottom, inside the usable screen", async () => {
    rect($('#rm [data-act="row-menu"]'), { left: 340, top: 740, width: 44, height: 44 });
    $('#rm [data-act="row-menu"]').click();
    await flush();
    const menu = $("#rm .menu");
    expect(menu.hidden).toBe(false);
    expect($('#rm [data-menu="x1"]').dataset.menuPlaced).toBe("up");
    expect(px(menu, "top") + 96).toBeLessThanOrEqual(774);
  });
});

describe("without bottom tabs (desktop, staff portal)", () => {
  it("keeps clear of the screen's bottom edge", () => {
    $("#tabs").remove();
    expect(usableArea(document).bottom).toBe(844 - 8);
  });
});

describe("inside a blurred bar (the top bar's notifications)", () => {
  it("is placed against that bar, as `position: fixed` is there", () => {
    const bar = $("#top");
    bar.style.backdropFilter = "blur(8px)";
    rect(bar, { left: 240, top: 0, width: 150, height: 56 });
    bar.append($("#m"));
    expect(placeMenu($("#m"), document)).toBeTruthy();
    rect($("#m > summary"), { left: 340, top: 6, width: 44, height: 44 });
    placeMenu($("#m"), document);
    expect(px($("#m .line-menu-list"), "left")).toBe(162 - 240);
  });
});
