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
  // Opening a details menu (tap on ⋯, keyboard) closes any other one.
  const onToggle = (e) => {
    const d = e.target;
    if (d && d.matches && d.matches(LINE) && d.open) closeAllMenus(doc, d);
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
  // A dialog or sheet appearing closes menus behind it.
  const observer = new win.MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches(".modal-backdrop, .sheet-backdrop") || n.querySelector?.(".modal-backdrop"))) return closeAllMenus(doc, menuOf(n.parentElement));
      if (r.type === "attributes" && r.target.matches?.(".sheet, .sheet-backdrop") && !r.target.hidden) return closeAllMenus(doc);
    }
    return undefined;
  });
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("toggle", onToggle, true);
  doc.addEventListener("scroll", onScroll, true);
  doc.addEventListener("keydown", onKey);
  win.addEventListener("popstate", onNav);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  installed = () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("toggle", onToggle, true);
    doc.removeEventListener("scroll", onScroll, true);
    doc.removeEventListener("keydown", onKey);
    win.removeEventListener("popstate", onNav);
    observer.disconnect();
    installed = null;
  };
  return installed;
}
