// Workspace switching helpers (owner pilot, 2026-10-19), used by main.js.
//
// 1. resetWorkspaceUi(): nothing of the previous workspace survives a
//    switch. Dialogs, side panels and previews are appended to <body> (not
//    to the app root that the new shell replaces), so they're removed here;
//    open ⋯ menus close and pending toasts go.
// 2. Stale page files: every deploy renames the page files (hashed chunk
//    names). A tab opened before a deploy can't fetch a page it hasn't
//    loaded yet, and used to show "This page couldn't load". Instead Luna
//    reloads once (same URL), which fetches the current files. A second
//    failure within a minute for the same page shows the error as before,
//    so a real outage never loops.

const RELOAD_KEY = "luna.staleReload";
const RELOAD_WINDOW_MS = 60 * 1000;

export function resetWorkspaceUi(doc = document) {
  for (const el of doc.querySelectorAll(".modal-backdrop")) el.remove();
  for (const el of doc.querySelectorAll("details[open]")) el.open = false;
  const toasts = doc.querySelector(".toast-region");
  if (toasts) toasts.replaceChildren();
}

// A browser's way of saying a module file couldn't be fetched / evaluated.
export function isStaleFileError(err) {
  const msg = String(err?.message || err || "");
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(msg);
}

// Reloads once per page per minute; returns true when it did.
export function reloadForFreshFiles({ path = window.location.pathname, storage = safeSession(), reload = () => window.location.reload(), now = Date.now() } = {}) {
  let last = null;
  try {
    last = JSON.parse(storage?.getItem(RELOAD_KEY) || "null");
  } catch {
    last = null;
  }
  if (last && last.path === path && now - last.at < RELOAD_WINDOW_MS) return false;
  try {
    storage?.setItem(RELOAD_KEY, JSON.stringify({ path, at: now }));
  } catch {
    return false; // can't remember it: don't risk a reload loop
  }
  reload();
  return true;
}

function safeSession() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
