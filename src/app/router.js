// Minimal History-API router. Routes are generated from the module
// registry (shared/modules.js) filtered by the session, so a module the
// business or user can't access has no route at all — visiting its URL
// shows "not available", never the module.
//
// The router is UX only. Hiding a route is not security; the data behind
// it is protected by rules and server checks.

export function createRouter({ routes, onRoute, notFound, base = "" }) {
  const table = new Map(routes.map((route) => [route.path, route]));

  function stripBase(pathname) {
    const path = base && pathname.startsWith(base) ? pathname.slice(base.length) || "/" : pathname;
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  }

  function resolve() {
    const path = stripBase(window.location.pathname);
    const route = table.get(path);
    if (route) onRoute(route);
    else notFound(path);
  }

  function navigate(path) {
    const target = base + path;
    if (target !== window.location.pathname) {
      window.history.pushState({}, "", target);
    }
    resolve();
  }

  // Same-origin links marked data-link navigate without a full reload.
  const onClick = (event) => {
    const link = event.target.closest("a[data-link]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(link.getAttribute("href").slice(base.length) || "/");
  };

  document.addEventListener("click", onClick);
  window.addEventListener("popstate", resolve);

  // Removes listeners — call before creating a new router (e.g. after
  // switching business) so handlers never stack up.
  function stop() {
    document.removeEventListener("click", onClick);
    window.removeEventListener("popstate", resolve);
  }

  return { start: resolve, navigate, stop };
}
