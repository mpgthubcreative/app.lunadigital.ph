// Routes for the tenant app, generated from the module registry and the
// session: a module has a route only if the business is entitled to it AND
// the user holds its permission (shared canUseModule). Every navigation
// re-checks the same test before a module is loaded.
//
// UX only. The data behind every route is protected by Firestore rules and
// requireTenant() on the server, so a tampered session or URL reveals
// nothing; this just keeps the screen honest.

import { resolveNavigation, canUseModule, canUseNotifications, terminologyLabels, getWorkspaceTemplate, snapshotWorkspaceTemplateId, MODULES, getModule } from "@shared/index.js";
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
// Owner-pilot: ONE Download Excel page (under More) in every workspace: one
// clean workbook for whoever may export (data.export; each sheet also needs
// its screen's permission on the server). The Master Backup is Luna Super
// Admin only (the Luna console), never on this page.
export const EXPORT_ROUTE = Object.freeze({ path: "/export", label: "Download Excel", moduleId: "downloads" });
const PAGE_ONLY = new Set(["dashboard", "reports"]);
export const exportListsFor = (session) => Object.keys(EXPORT_DATASETS).filter((id) => !PAGE_ONLY.has(id) && canExport({ entitlements: session.entitlements, permissions: session.member.permissions }, EXPORT_DATASETS[id]));
export const showExportPage = (session) => session?.member?.permissions?.["data.export"] === true;
// Owner-pilot Bridal: Wedding Setup (the invitation + RSVP settings), under More.
export const SETUP_ROUTE = Object.freeze({ path: "/wedding-setup", label: "Wedding Setup", moduleId: "weddingsetup" });
// Owner-pilot Bridal: Music & Program (ceremony / reception sequence and songs), under More.
export const PROGRAM_ROUTE = Object.freeze({ path: "/wedding-program", label: "Music & Program", moduleId: "weddingprogram" });
export const canSeeWeddingProgram = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "bridal-expense" && session?.member?.permissions?.["tasks.view"] === true && canUseModule(accessOf(session), "tasks");
// Owner-pilot Bridal: Crew Meals (who eats, how many meals, where), under More.
export const CREW_ROUTE = Object.freeze({ path: "/wedding-crew-meals", label: "Crew Meals", moduleId: "weddingcrew" });
export const canSeeCrewMeals = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "bridal-expense" && session?.member?.permissions?.["vendors.view"] === true && canUseModule(accessOf(session), "vendors");
// Distributor (2026-10-22): Share menu (the store link + Store settings) as
// a page under More (also a button on Orders).
export const SHARE_ROUTE = Object.freeze({ path: "/share-menu", label: "Share menu", moduleId: "sharemenu" });
export const canSeeShareMenu = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "distributor" && session?.member?.permissions?.["orders.view"] === true && canUseModule(accessOf(session), "orders");
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
  if (canSeeShareMenu(session)) routes.push({ ...SHARE_ROUTE });
  // Owner-pilot UX: a workspace whose home isn't the Dashboard (Household:
  // Payroll) sends "/" (sign-in, old links) there.
  const template = getWorkspaceTemplate(snapshotWorkspaceTemplateId(session.entitlements));
  // A page the template retired (Bridal: Budget) sends old links to its replacement.
  for (const [from, to] of Object.entries(template?.redirects || {})) {
    const i = routes.findIndex((r) => r.moduleId === from && !r.redirect);
    const dest = routes.find((r) => r.moduleId === to && !r.redirect);
    if (i >= 0 && dest) routes[i] = { path: routes[i].path, redirect: dest.path, label: dest.label, moduleId: dest.moduleId };
  }
  const home = template?.home;
  const target = home && routes.find((r) => r.moduleId === home && !r.redirect);
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
  if (route && route.moduleId === SHARE_ROUTE.moduleId) return canSeeShareMenu(session);
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

// ---------- Workspace switching (owner pilot, 2026-10-17) ----------
// Switching business must land on a valid page at once, never on "Page not
// available" for the previous workspace's route.

// Every page the tenant app knows, whatever the workspace.
const EXTRA_ROUTES = [NOTIFICATIONS_ROUTE, SUBSCRIPTION_ROUTE, EXPORT_ROUTE, SETUP_ROUTE, PROGRAM_ROUTE, CREW_ROUTE, SHARE_ROUTE];
const KNOWN_PATHS = new Set(["/", ...MODULES.filter((m) => m.available).map((m) => m.path), ...EXTRA_ROUTES.map((r) => r.path)]);
export const isKnownAppPath = (path) => KNOWN_PATHS.has(path);

// The pages THIS workspace's template has (whatever this user may open).
export function workspacePaths(session) {
  const template = getWorkspaceTemplate(snapshotWorkspaceTemplateId(session.entitlements));
  const paths = new Set(["/", NOTIFICATIONS_ROUTE.path, SUBSCRIPTION_ROUTE.path, EXPORT_ROUTE.path]);
  for (const id of template?.modules || []) {
    const m = getModule(id);
    if (m?.available) paths.add(m.path);
  }
  if (template?.id === "bridal-expense") for (const r of [SETUP_ROUTE, PROGRAM_ROUTE, CREW_ROUTE]) paths.add(r.path);
  if (template?.id === "distributor") paths.add(SHARE_ROUTE.path);
  return paths;
}

// The workspace's landing page: "/" (the Dashboard, or the template's home
// via its alias: Household -> Payroll, Bridal -> Money), else the first page.
export const homePath = (routes) => (routes.some((r) => r.path === "/") ? "/" : routes.find((r) => !r.redirect)?.path ?? "/");

// What to do with a path in this session:
//   "home"            a page of ANOTHER workspace (left in the URL by a switch,
//                     back / forward or an old bookmark), or any page this
//                     membership can't open right after a switch
//   "not-available"   an unknown path, or a page of this workspace this person
//                     may not open (unchanged)
//   "ok"              open it
export function pathDisposition(session, routes, path, { justSwitched = false } = {}) {
  const route = routes.find((r) => r.path === path);
  if (route && (route.redirect || routeAllowed(session, route))) return "ok";
  if (!isKnownAppPath(path)) return "not-available";
  if (justSwitched || !workspacePaths(session).has(path)) return "home";
  return "not-available";
}

// ---------- Where a workspace switch lands (owner pilot, 2026-10-19) ----------
// Pages that are the SAME page in every workspace. A path several templates
// use for different screens (/expenses is Costs in Business, Expenses in
// Household, Wedding Expenses in Bridal; "/" is each one's own home) is not
// shared: switching from it opens the destination's default page.
const SHARED_PAGE_IDS = new Set(["users", "settings", NOTIFICATIONS_ROUTE.moduleId, SUBSCRIPTION_ROUTE.moduleId, EXPORT_ROUTE.moduleId]);

// The workspace's default page as a real path (the "/" alias resolved):
// Business / Baby -> "/" (Dashboard), Household -> /payroll, Bridal -> /wedding-suppliers (Money).
export function defaultPath(routes) {
  const root = routes.find((r) => r.path === "/");
  if (root) return root.redirect || "/";
  return routes.find((r) => !r.redirect)?.path ?? "/";
}

// Decided BEFORE the new workspace renders: keep the current page only when
// it's a genuinely shared page this membership may open (template has it,
// module on, permission held); otherwise the destination's default.
export function switchLandingPath(session, routes, path) {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const route = routes.find((r) => r.path === clean && !r.redirect);
  return route && SHARED_PAGE_IDS.has(route.moduleId) && routeAllowed(session, route) ? clean : defaultPath(routes);
}
