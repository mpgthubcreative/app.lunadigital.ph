// @vitest-environment jsdom
// One popover behavior for every ⋯ menu (both kinds): one open at a time;
// outside tap, an action, scroll, navigation, a dialog and Escape close it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installMenuBehavior } from "../../src/components/menus.js";
import { rowMenu, bindRowMenus } from "../../src/components/ui.js";
import { render } from "../../src/lib/html.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
let uninstall;
let unbind;
beforeEach(() => {
  document.body.innerHTML = `<main id="page">
    <ul>
      <li id="r1"><details class="line-menu" id="m1"><summary>⋯</summary><div class="line-menu-list"><button class="menu-item" id="a1" data-act="edit">Edit</button></div></details></li>
      <li id="r2"><details class="line-menu" id="m2"><summary>⋯</summary><div class="line-menu-list"><button class="menu-item" id="a2">Remove</button></div></details></li>
      <li id="r3"></li>
    </ul>
    <p id="outside">text</p>
    <a href="/elsewhere" id="link">Elsewhere</a>
  </main>`;
  render(document.getElementById("r3"), rowMenu("x1", [{ act: "edit", label: "Edit" }]));
  unbind = bindRowMenus(document.getElementById("page"));
  uninstall = installMenuBehavior(document);
});
afterEach(() => {
  uninstall();
  unbind();
});
const $ = (id) => document.getElementById(id);
const openDetails = (id) => {
  $(id).open = true;
  $(id).dispatchEvent(new Event("toggle"));
};
const wrapOpen = () => !document.querySelector('[data-menu="x1"] .menu').hidden;

describe("⋯ menus behave like popovers", () => {
  it("opening one closes the other (details and button menus alike)", () => {
    openDetails("m1");
    openDetails("m2");
    expect($("m1").open).toBe(false);
    expect($("m2").open).toBe(true);
    document.querySelector('[data-act="row-menu"]').click();
    expect(wrapOpen()).toBe(true);
    expect($("m2").open).toBe(false);
    openDetails("m1");
    expect(wrapOpen()).toBe(false);
  });

  it("a tap outside closes it; a tap inside (not an action) keeps it", () => {
    openDetails("m1");
    $("m1").querySelector(".line-menu-list").click();
    expect($("m1").open).toBe(true);
    $("outside").click();
    expect($("m1").open).toBe(false);
  });

  it("an action runs, then the menu closes", async () => {
    let ran = 0;
    $("page").addEventListener("click", (e) => e.target.closest('[data-act="edit"]') && ran++);
    openDetails("m1");
    $("a1").click();
    expect(ran).toBe(1);
    await flush();
    expect($("m1").open).toBe(false);
  });

  it("scrolling, Escape, back / forward and a link close it", () => {
    for (const close of [() => document.dispatchEvent(new Event("scroll")), () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), () => window.dispatchEvent(new PopStateEvent("popstate")), () => $("link").click()]) {
      openDetails("m1");
      close();
      expect($("m1").open).toBe(false);
    }
  });

  it("scrolling inside the open menu's own list doesn't close it", () => {
    openDetails("m1");
    $("m1").querySelector(".line-menu-list").dispatchEvent(new Event("scroll"));
    expect($("m1").open).toBe(true);
  });

  it("a dialog opening closes it", async () => {
    openDetails("m2");
    const b = document.createElement("div");
    b.className = "modal-backdrop";
    document.body.appendChild(b);
    await flush();
    expect($("m2").open).toBe(false);
  });

  it("a page that stops the click still can't keep a stale menu open", () => {
    openDetails("m1");
    $("outside").addEventListener("click", (e) => e.stopPropagation());
    $("outside").click();
    expect($("m1").open).toBe(false);
  });
});
