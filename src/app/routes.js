// Routes for the tenant app, generated from the module registry and the
// session: a module has a route only if the business is entitled to it AND
// the user holds its permission (shared canUseModule). Every navigation
// re-checks the same test before a module is loaded.
//
// UX only. The data behind every route is protected by Firestore rules and
// requireTenant() on the server, so a tampered session or URL reveals
// nothing; this just keeps the screen honest.

import { resolveNavigation, canUseModule, canUseNotifications, terminologyLabels } from "@shared/index.js";
import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState } from "../components/ui.js";

const accessOf = (session) => ({ entitlements: session.entitlements, permissions: session.member.permissions });

// Phase 13: Notifications is a core capability, not a navigation module;
// its page is reached from the bell.
const NOTIFICATIONS_ROUTE = Object.freeze({ path: "/notifications", label: "Notifications", moduleId: "notifications" });

export function buildRoutes(session) {
  // Tenant terminology (Phase 17) relabels a module (e.g. Customers -> Dealers); ids and paths never change.
  const labels = terminologyLabels(session.config);
  const routes = resolveNavigation(accessOf(session)).map((mod) => ({ path: mod.path, label: labels[mod.id] ?? mod.label, moduleId: mod.id }));
  if (canUseNotifications(accessOf(session))) routes.push({ ...NOTIFICATIONS_ROUTE });
  return routes;
}

export function routeAllowed(session, route) {
  if (route && route.moduleId === NOTIFICATIONS_ROUTE.moduleId) return canUseNotifications(accessOf(session));
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
