// Routes for the tenant app, generated from the module registry and the
// session: a module has a route only if the business is entitled to it AND
// the user holds its permission (shared canUseModule). Every navigation
// re-checks the same test before a module is loaded.
//
// UX only. The data behind every route is protected by Firestore rules and
// requireTenant() on the server, so a tampered session or URL reveals
// nothing; this just keeps the screen honest.

import { resolveNavigation, canUseModule, canUseNotifications, terminologyLabels, getWorkspaceTemplate, snapshotWorkspaceTemplateId } from "@shared/index.js";
import { EXPORT_DATASETS } from "@shared/export-datasets.js";
import { canExport } from "@shared/exports.js";
import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState } from "../components/ui.js";

const accessOf = (session) => ({ entitlements: session.entitlements, permissions: session.member.permissions });

// Phase 13: Notifications is a core capability, not a navigation module;
// its page is reached from the bell.
const NOTIFICATIONS_ROUTE = Object.freeze({ path: "/notifications", label: "Notifications", moduleId: "notifications" });
// Phase 18.6: the Owner's Luna subscription (billing.view), also outside the
// module registry: every workspace has it, whatever its template.
export const SUBSCRIPTION_ROUTE = Object.freeze({ path: "/subscription", label: "Subscription", moduleId: "subscription" });
export const canSeeSubscription = (session) => session?.member?.permissions?.["billing.view"] === true;
// Owner-pilot: ONE Export & Backup page (under More) in every workspace,
// instead of Download Excel on the everyday screens. Single lists = this
// workspace's export datasets this person may download (the usual
// per-dataset checks); the Dashboard and Reports workbooks need a period and
// stay on their pages. Master Backup = the Owner (billing.view) who may export.
export const EXPORT_ROUTE = Object.freeze({ path: "/export", label: "Export & Backup", moduleId: "downloads" });
const PAGE_ONLY = new Set(["dashboard", "reports"]);
export const exportListsFor = (session) => Object.keys(EXPORT_DATASETS).filter((id) => !PAGE_ONLY.has(id) && canExport({ entitlements: session.entitlements, permissions: session.member.permissions }, EXPORT_DATASETS[id]));
export const canBackup = (session) => session?.member?.permissions?.["billing.view"] === true && session?.member?.permissions?.["data.export"] === true;
export const showExportPage = (session) => canBackup(session) || exportListsFor(session).length > 0;
// Owner-pilot Bridal: Wedding Setup (the invitation + RSVP settings), under More.
export const SETUP_ROUTE = Object.freeze({ path: "/wedding-setup", label: "Wedding Setup", moduleId: "weddingsetup" });
// Owner-pilot Bridal: Music & Program (ceremony / reception sequence and songs), under More.
export const PROGRAM_ROUTE = Object.freeze({ path: "/wedding-program", label: "Music & Program", moduleId: "weddingprogram" });
export const canSeeWeddingProgram = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "bridal-expense" && session?.member?.permissions?.["tasks.view"] === true && canUseModule(accessOf(session), "tasks");
// Owner-pilot Bridal: Crew Meals (who eats, how many meals, where), under More.
export const CREW_ROUTE = Object.freeze({ path: "/wedding-crew-meals", label: "Crew Meals", moduleId: "weddingcrew" });
export const canSeeCrewMeals = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "bridal-expense" && session?.member?.permissions?.["vendors.view"] === true && canUseModule(accessOf(session), "vendors");
export const canSeeWeddingSetup = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "bridal-expense" && session?.member?.permissions?.["guests.view"] === true && canUseModule(accessOf(session), "guests");

export function buildRoutes(session) {
  // Tenant terminology (Phase 17) relabels a module (e.g. Customers -> Dealers); ids and paths never change.
  const labels = terminologyLabels(session.config);
  const routes = resolveNavigation(accessOf(session)).map((mod) => ({ path: mod.path, label: labels[mod.id] ?? mod.label, moduleId: mod.id }));
  if (canUseNotifications(accessOf(session))) routes.push({ ...NOTIFICATIONS_ROUTE });
  if (canSeeSubscription(session)) routes.push({ ...SUBSCRIPTION_ROUTE });
  if (showExportPage(session)) routes.push({ ...EXPORT_ROUTE });
  if (canSeeWeddingSetup(session)) routes.push({ ...SETUP_ROUTE });
  if (canSeeWeddingProgram(session)) routes.push({ ...PROGRAM_ROUTE });
  if (canSeeCrewMeals(session)) routes.push({ ...CREW_ROUTE });
  // Owner-pilot UX: a workspace whose home isn't the Dashboard (Household:
  // Payroll) sends "/" (sign-in, old links) there.
  const home = getWorkspaceTemplate(snapshotWorkspaceTemplateId(session.entitlements))?.home;
  const target = home && routes.find((r) => r.moduleId === home);
  if (target && !routes.some((r) => r.path === "/")) routes.push({ path: "/", redirect: target.path, label: target.label, moduleId: target.moduleId });
  return routes;
}

export function routeAllowed(session, route) {
  if (route && route.moduleId === NOTIFICATIONS_ROUTE.moduleId) return canUseNotifications(accessOf(session));
  if (route && route.moduleId === SUBSCRIPTION_ROUTE.moduleId) return canSeeSubscription(session);
  if (route && route.moduleId === EXPORT_ROUTE.moduleId) return showExportPage(session);
  if (route && route.moduleId === SETUP_ROUTE.moduleId) return canSeeWeddingSetup(session);
  if (route && route.moduleId === PROGRAM_ROUTE.moduleId) return canSeeWeddingProgram(session);
  if (route && route.moduleId === CREW_ROUTE.moduleId) return canSeeCrewMeals(session);
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
