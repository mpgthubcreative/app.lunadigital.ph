// One popover behavior for every ⋯ / ▾ action menu in Luna (owner pilot,
// 2026-10-18). Both menu kinds:
//   details.line-menu          <details><summary>⋯</summary><div class="line-menu-list">…
//   .menu-wrap[data-menu]      rowMenu(): a button + a [hidden] .menu (ui.js)
// behave like standard popovers:
//   tap ⋯ opens it; tap the same ⋯ again closes it (native / bindRowMenus)
//   tap anywhere outside closes it; tapping another row's ⋯ closes the first
//   tap a menu action: the action runs, then the menu closes
//   only one menu is open at a time
//   scrolling, navigating (links, back / forward), a dialog / sheet opening
//   and Escape close it
// Installed once for the whole document (the app and the household staff
// portal); listeners run in the capture phase, so a page that stops a
// click's propagation can't keep a stale menu open.

const LINE = "details.line-menu";
const WRAP = ".menu-wrap[data-menu]";
const ITEM = ".menu-item, .line-menu-list button, .line-menu-list a";
const GAP = 4; // between the ⋯ and its menu
const EDGE = 8; // kept clear at the screen's edges

// ---------- Placement (2026-10-21) ----------
// Every open menu is placed from the real space around its ⋯: it opens
// downward when it fits below, else upward, else (a long menu) whole on
// the screen, shifted over its ⋯; only a menu taller than the usable screen
// scrolls. It is `position: fixed`, so no card, table or scroll
// column can clip it, and it stays inside the USABLE screen: below the top
// bar, above the phone's bottom tabs (which already include the iPhone
// home-indicator space) or, without tabs, above the safe area, and inside
// the browser's visible viewport. Horizontally it lines up with the ⋯'s
// end (or start, for `.line-menu-up` bars) and moves inward at an edge.

// The element a `position: fixed` child is placed against: the screen, or
// the nearest ancestor with a transform / filter (the top bar's blur).
function fixedFrame(el, win) {
  for (let a = el.parentElement; a && a !== el.ownerDocument.body; a = a.parentElement) {
    const cs = win.getComputedStyle(a);
    if ((cs.transform && cs.transform !== "none") || (cs.filter && cs.filter !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none") || /paint|layout|strict|content/.test(cs.contain || "")) {
      const r = a.getBoundingClientRect();
      return { left: r.left, top: r.top };
    }
  }
  return { left: 0, top: 0 };
}
// The iPhone home-indicator inset, measured (CSS env() isn't readable from
// script directly).
function safeBottomPx(doc, win) {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom, 0px)";
  doc.body.appendChild(probe);
  const v = parseFloat(win.getComputedStyle(probe).paddingBottom);
  probe.remove();
  return Number.isFinite(v) ? v : 0;
}
// The part of the screen a menu may use (viewport coordinates).
export function usableArea(doc = document) {
  const win = doc.defaultView;
  const vv = win.visualViewport;
  let top = vv ? vv.offsetTop : 0;
  let bottom = vv ? vv.offsetTop + vv.height : win.innerHeight;
  const tabs = doc.querySelector(".tabbar");
  const tr = tabs && win.getComputedStyle(tabs).display !== "none" ? tabs.getBoundingClientRect() : null;
  if (tr && tr.height) bottom = Math.min(bottom, tr.top);
  else bottom -= safeBottomPx(doc, win);
  const bar = doc.querySelector(".topbar");
  const br = bar && win.getComputedStyle(bar).position !== "static" ? bar.getBoundingClientRect() : null;
  if (br && br.height && br.bottom > top && br.top <= top + 1) top = br.bottom;
  return { top: top + EDGE, bottom: bottom - EDGE, left: (vv ? vv.offsetLeft : 0) + EDGE, right: (vv ? vv.offsetLeft + vv.width : win.innerWidth) - EDGE };
}
const listOf = (m) => (m.matches(LINE) ? m.querySelector(":scope > .line-menu-list") : m.querySelector(":scope > .menu"));
const triggerOf = (m) => (m.matches(LINE) ? m.querySelector(":scope > summary") : m.querySelector('[data-act="row-menu"]'));

export function placeMenu(m, doc = document) {
  const list = listOf(m);
  const trigger = triggerOf(m);
  if (!list || !trigger) return null;
  const win = doc.defaultView;
  // Measure at its natural size first.
  list.style.cssText = "position:fixed;left:0;top:0;right:auto;bottom:auto;max-height:none;visibility:hidden";
  const area = usableArea(doc);
  const t = trigger.getBoundingClientRect();
  const w = Math.min(list.offsetWidth, area.right - area.left);
  const h = list.offsetHeight;
  const below = area.bottom - (t.bottom + GAP);
  const above = t.top - GAP - area.top;
  const preferUp = m.classList.contains("line-menu-up");
  let dir;
  if (preferUp) dir = h <= above || above >= below ? "up" : "down";
  else dir = h <= below || below >= above ? "down" : "up";
  // Fits on neither side but on the screen: shown whole, shifted over its ⋯.
  // Only a menu taller than the whole usable screen scrolls.
  const height = Math.min(h, area.bottom - area.top);
  let top = dir === "down" ? t.bottom + GAP : t.top - GAP - height;
  top = Math.max(area.top, Math.min(top, area.bottom - height));
  const startAligned = preferUp || m.classList.contains("line-menu-start");
  let left = startAligned ? t.left : t.right - w;
  left = Math.max(area.left, Math.min(left, area.right - w));
  const f = fixedFrame(list, win);
  list.style.cssText = `position:fixed;left:${Math.round(left - f.left)}px;top:${Math.round(top - f.top)}px;right:auto;bottom:auto;width:${Math.round(w)}px;max-width:${Math.round(area.right - area.left)}px;${height < h ? `max-height:${Math.floor(height)}px;overflow-y:auto;` : ""}z-index:55`;
  m.dataset.menuPlaced = dir;
  return { dir, top, left, height, width: w };
}
function unplace(m) {
  const list = listOf(m);
  if (list) list.removeAttribute("style");
  delete m.dataset.menuPlaced;
}

function openMenus(doc) {
  return [...doc.querySelectorAll(`${LINE}[open]`), ...[...doc.querySelectorAll(WRAP)].filter((w) => w.querySelector(":scope > .menu:not([hidden])"))];
}
function closeMenu(m) {
  if (m.matches(LINE)) m.removeAttribute("open");
  else {
    const menu = m.querySelector(":scope > .menu");
    if (menu) menu.hidden = true;
    m.querySelector('[data-act="row-menu"]')?.setAttribute("aria-expanded", "false");
  }
  unplace(m);
}
// The menu a node belongs to (the details / wrap), if any.
const menuOf = (node) => (node && node.closest ? node.closest(`${LINE}, ${WRAP}`) : null);

export function closeAllMenus(doc = document, except = null) {
  for (const m of openMenus(doc)) if (m !== except) closeMenu(m);
}

let installed = null;
export function installMenuBehavior(doc = document) {
  if (installed) return installed;
  const win = doc.defaultView;
  const onClick = (e) => {
    const mine = menuOf(e.target);
    // Outside every menu (or in another one): close the others.
    closeAllMenus(doc, mine);
    // A menu action: let the page run it first, then close its menu.
    if (mine && e.target.closest(ITEM)) win.setTimeout(() => closeMenu(mine), 0);
    // A link (navigation): close everything.
    if (e.target.closest("a[href]") && !mine) closeAllMenus(doc);
  };
  // Opening a details menu (tap on ⋯, keyboard) closes any other one and
  // places it in the space it fits.
  const onToggle = (e) => {
    const d = e.target;
    if (!d || !d.matches || !d.matches(LINE)) return;
    if (d.open) {
      closeAllMenus(doc, d);
      placeMenu(d, doc);
    } else unplace(d);
  };
  // The screen changing size (rotation, the keyboard): open menus are placed again.
  const onResize = () => {
    for (const m of openMenus(doc)) placeMenu(m, doc);
  };
  // Scrolling the page (or any list) closes menus; scrolling inside the
  // open menu's own list doesn't.
  const onScroll = (e) => {
    const t = e.target;
    if (t && t.nodeType === 1 && menuOf(t)) return;
    if (openMenus(doc).length) closeAllMenus(doc);
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeAllMenus(doc);
  };
  const onNav = () => closeAllMenus(doc);
  // A dialog or sheet appearing closes menus behind it; a row menu (rowMenu)
  // shown is placed, and hidden is reset.
  const observer = new win.MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches(".modal-backdrop, .sheet-backdrop") || n.querySelector?.(".modal-backdrop"))) return closeAllMenus(doc, menuOf(n.parentElement));
      if (r.type === "attributes" && r.target.matches?.(".sheet, .sheet-backdrop") && !r.target.hidden) return closeAllMenus(doc);
      if (r.type === "attributes" && r.target.matches?.(`${WRAP} > .menu`)) {
        const wrap = r.target.parentElement;
        if (r.target.hidden) unplace(wrap);
        else placeMenu(wrap, doc);
      }
    }
    return undefined;
  });
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("toggle", onToggle, true);
  doc.addEventListener("scroll", onScroll, true);
  doc.addEventListener("keydown", onKey);
  win.addEventListener("popstate", onNav);
  win.addEventListener("resize", onResize);
  win.visualViewport?.addEventListener("resize", onResize);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  installed = () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("toggle", onToggle, true);
    doc.removeEventListener("scroll", onScroll, true);
    doc.removeEventListener("keydown", onKey);
    win.removeEventListener("popstate", onNav);
    win.removeEventListener("resize", onResize);
    win.visualViewport?.removeEventListener("resize", onResize);
    observer.disconnect();
    installed = null;
  };
  return installed;
}
