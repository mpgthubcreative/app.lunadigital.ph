// The tenant app's router for ONE session (one business / workspace).
// Owner-pilot fix (2026-10-17): switching business must open a valid page
// at once. Before anything renders, the URL is checked against THIS
// membership (routes.js pathDisposition):
//   a page of another workspace (left by a switch, back / forward, an old
//   bookmark), or right after a switch any page this membership can't open
//     -> replaced by this workspace's home (Household Payroll, Bridal Money,
//        Distributor / Baby Dashboard), no history entry added
//   an unknown page, or a page of this workspace this person may not open
//     -> "Page not available" (unchanged)

import { createRouter } from "./router.js";
import { routeAllowed, pathDisposition, homePath } from "./routes.js";

const cleanPath = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

// onRoute(route) for an allowed page; onNotAvailable() otherwise.
export function createWorkspaceRouter({ session, routes, onRoute, onNotAvailable, justSwitched = false }) {
  let switching = justSwitched;
  const home = homePath(routes);
  let router = null;
  const staleGoHome = (path) => {
    const verdict = pathDisposition(session, routes, path, { justSwitched: switching });
    switching = false;
    if (verdict !== "home" || path === home) return false;
    router.replace(home);
    return true;
  };
  router = createRouter({
    routes,
    onRoute(route) {
      if (!routeAllowed(session, route)) {
        if (!staleGoHome(route.path)) onNotAvailable();
        return;
      }
      switching = false;
      onRoute(route);
    },
    notFound(path) {
      if (!staleGoHome(cleanPath(path ?? window.location.pathname))) onNotAvailable();
    },
  });
  return router;
}
