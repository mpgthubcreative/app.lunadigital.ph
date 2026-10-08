// Routes for the tenant app, generated from the module registry and the
// session: a module has a route only if the business is entitled to it AND
// the user holds its permission (shared canUseModule). Every navigation
// re-checks the same test before a module is loaded.
//
// UX only. The data behind every route is protected by Firestore rules and
// requireTenant() on the server, so a tampered session or URL reveals
// nothing; this just keeps the screen honest.

import { resolveNavigation, canUseModule } from "@shared/index.js";
import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState } from "../components/ui.js";

const accessOf = (session) => ({ entitlements: session.entitlements, permissions: session.member.permissions });

export function buildRoutes(session) {
  return resolveNavigation(accessOf(session)).map((mod) => ({ path: mod.path, label: mod.label, moduleId: mod.id }));
}

export function routeAllowed(session, route) {
  return Boolean(route && route.moduleId) && canUseModule(accessOf(session), route.moduleId);
}

// One message whatever the reason (no such page, no permission, not on the
// package), so the screen never says which.
export function renderPageNotAvailable(container) {
  render(
    container,
    html`
      ${pageHeader({ title: "Page not available" })}
      ${card({ body: emptyState({ title: "This page isn't available", body: "It doesn't exist, or it isn't enabled for your account." }) })}
    `
  );
}
