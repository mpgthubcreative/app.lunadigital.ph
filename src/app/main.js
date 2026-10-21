// Tenant app entry point:
//   signed out  → login screen
//   signed in   → GET /api/session → shell configured from the session
//                 → lazily-loaded modules via the router
//   access problem (no/disabled membership, inactive subscription)
//               → explanatory screen with sign-out
//
// The session is re-validated every few minutes and when the tab regains
// focus, so a disabled membership or suspended subscription takes effect
// without a manual reload.

import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../styles/components.css";

import { isFirebaseConfigured } from "../lib/firebase.js";
import { setTokenProvider, setBusinessSelector } from "../lib/api.js";
import { watchUser, signIn, signOutUser, currentIdToken, friendlyAuthError, sendPasswordReset } from "./auth.js";
import { loadSession, setPreferredBusinessId } from "./session.js";
import { renderShell } from "./shell.js";
import { createWorkspaceRouter } from "./workspace-router.js";
import { buildRoutes, renderPageNotAvailable, switchLandingPath } from "./routes.js";
import { resetWorkspaceUi, isStaleFileError, reloadForFreshFiles } from "./workspace-switch.js";
import { renderLogin, renderAccessProblem, renderBoot } from "./screens.js";
import { MODULE_LOADERS } from "../modules/loaders.js";
import { render } from "../lib/html.js";
import { card, emptyState } from "../components/ui.js";
import { isStaffPortalSession } from "../staff/is-staff.js";
import { installMenuBehavior } from "../components/menus.js";
import { scheduleFeedbackPrompt } from "./feedback.js";

// Pages a member can still open once a free trial has ended.
const TRIAL_ENDED_PATHS = new Set(["/subscription", "/settings", "/export"]);
let stopFeedback = () => {};

const root = document.getElementById("app");
const REVALIDATE_MS = 5 * 60 * 1000;

const ACCESS_PROBLEM_TITLES = {
  "no-active-membership": "No business access",
  "membership-disabled": "Access disabled",
  "subscription-inactive": "Account not active",
  "account-cancelled": "Account cancelled",
  "business-misconfigured": "Business not ready",
  "account-disabled": "Account disabled",
};

let router = null;
let revalidateTimer = null;
let currentEmail = "";
let pendingLoginNotice = "";

setTokenProvider(currentIdToken);

let currentShell = null;
// The mounted page's cleanup, and a generation number: a page still loading
// for a previous workspace (or an earlier mount) never mounts once it moved on.
let currentCleanup = null;
let mountGeneration = 0;

function stopRouter() {
  mountGeneration += 1;
  stopFeedback();
  stopFeedback = () => {};
  if (typeof currentCleanup === "function") {
    try {
      currentCleanup();
    } catch (err) {
      console.error("Page cleanup failed:", err);
    }
  }
  currentCleanup = null;
  if (router) router.stop();
  router = null;
  if (currentShell) currentShell.stopNotifications();
  currentShell = null;
}

// The auth listener renders the login screen once sign-out completes;
// a notice set here is shown on it.
async function handleSignOut(notice = "") {
  stopRevalidation();
  stopRouter();
  setBusinessSelector(() => null);
  pendingLoginNotice = notice;
  await signOutUser();
}

function stopRevalidation() {
  if (revalidateTimer) clearInterval(revalidateTimer);
  revalidateTimer = null;
  document.removeEventListener("visibilitychange", onVisibility);
}

function onVisibility() {
  if (document.visibilityState === "visible") revalidate();
}

async function revalidate() {
  try {
    await loadSession();
  } catch (err) {
    if (err.status === 401 || err.status === 403) showSessionError(err);
  }
}

function showLogin(notice = "") {
  renderLogin(root, {
    notice,
    onForgot: (email) => sendPasswordReset(email),
    onSubmit: async (email, password) => {
      try {
        await signIn(email, password);
      } catch (err) {
        throw new Error(friendlyAuthError(err));
      }
    },
  });
}

function showSessionError(err) {
  stopRevalidation();
  stopRouter();
  if (err.status === 401) {
    handleSignOut("Your session ended. Please sign in again.");
    return;
  }
  renderAccessProblem(root, {
    title: ACCESS_PROBLEM_TITLES[err.code] || "Something went wrong",
    message: err.message,
    email: currentEmail,
    onSignOut: () => handleSignOut(),
    onRetry: err.status >= 500 || err.status === 0 ? () => startApp() : null,
  });
}

function mountApp(session) {
  stopRouter();
  // Phase 18.6: a household staff account gets its own simple screen
  // (lazy-loaded), not the Owner's app.
  if (isStaffPortalSession(session)) {
    // The portal has no pages of its own: drop another workspace's URL.
    if (window.location.pathname !== "/") window.history.replaceState({}, "", "/");
    import("../staff/portal.js").then((m) => m.mountStaffPortal(root, session, { onSignOut: () => handleSignOut() }));
    stopRevalidation();
    revalidateTimer = setInterval(revalidate, REVALIDATE_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return;
  }
  // A free trial that has ended (2026-10-21): the owner lands on Continue
  // with Luna; Settings (→ Data) and Download Excel stay open. Everyday
  // edits are refused by the server until a plan is paid.
  if (session.subscription?.access?.trialEnded && session.member.permissions?.["billing.view"] === true && !TRIAL_ENDED_PATHS.has(window.location.pathname)) {
    window.history.replaceState({}, "", "/subscription");
  }
  const shell = renderShell(root, session, {
    onSignOut: () => handleSignOut(),
    onSwitchBusiness: (businessId) => switchWorkspace(businessId),
  });
  currentShell = shell;

  let navToken = 0;
  let shownPath = null;
  const generation = mountGeneration;
  const current = (token) => token === navToken && generation === mountGeneration;
  const routes = buildRoutes(session);
  const showNotAvailable = () => {
    shell.setActive({ path: null, label: "Not available" });
    renderPageNotAvailable(shell.content);
  };

  // Switching business opens a valid page at once (./workspace-router.js).
  router = createWorkspaceRouter({
    session,
    routes,
    async onRoute(route) {
      const token = ++navToken;
      if (typeof currentCleanup === "function") currentCleanup();
      currentCleanup = null;
      shell.setActive(route);
      // A new page starts at the top of the real scroller (the phone frame's
      // main column, or the document): never the old page's scroll position.
      if (route.path !== shownPath) shell.scrollToTop();
      shownPath = route.path;
      try {
        const mod = await MODULE_LOADERS[route.moduleId](session);
        if (!current(token)) return;
        // No module: its file was renamed by a deploy and the
        // vite:preloadError handler (boot) is already reloading the page.
        if (!mod) {
          renderBoot(root, "Updating Luna…");
          return;
        }
        currentCleanup = mod.mount(shell.content, session) || null;
      } catch (err) {
        if (!current(token)) return;
        console.error(`Failed to load module ${route.moduleId}:`, err);
        // A tab opened before a deploy: its page files were renamed. Reload
        // once to get the current ones instead of a broken page.
        if (isStaleFileError(err) && reloadForFreshFiles()) {
          renderBoot(root, "Updating Luna…");
          return;
        }
        render(shell.content, card({ body: emptyState({ title: "This page couldn't load", body: "Check your connection and refresh the page." }) }));
      }
      shell.content.focus({ preventScroll: true });
    },
    onNotAvailable: () => {
      ++navToken;
      if (typeof currentCleanup === "function") currentCleanup();
      currentCleanup = null;
      showNotAvailable();
    },
  });
  router.start();
  stopFeedback = scheduleFeedbackPrompt(session);

  stopRevalidation();
  revalidateTimer = setInterval(revalidate, REVALIDATE_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

// Owner pilot (2026-10-19): switching workspace is one step. The old
// workspace is torn down first (page cleanup, dialogs, menus, its URL's
// filters), the new session and its routes are resolved, the landing page
// is decided (a genuinely shared page it may open, else its default) and
// only then does the new shell render, already on that page.
async function switchWorkspace(businessId) {
  stopRevalidation();
  stopRouter();
  resetWorkspaceUi();
  setPreferredBusinessId(businessId);
  renderBoot(root, "Switching workspace…");
  try {
    const session = await loadSession();
    if (!isStaffPortalSession(session)) window.history.replaceState({}, "", switchLandingPath(session, buildRoutes(session), window.location.pathname));
    mountApp(session);
  } catch (err) {
    showSessionError(err);
  }
}

async function startApp() {
  renderBoot(root, "Loading your business…");
  try {
    mountApp(await loadSession());
  } catch (err) {
    showSessionError(err);
  }
}

// Settings → Arrange navigation saved: reload the session so the tab bar
// follows it (the page stays where it is).
window.addEventListener("luna:session-changed", () => {
  if (router) startApp();
});

function boot() {
  // Every ⋯ / ▾ menu behaves like a popover (one open; outside tap, scroll,
  // navigation, a dialog and Escape close it): ../components/menus.js.
  installMenuBehavior(document);
  // A page's CSS / helper file renamed by a deploy (Vite's preload error):
  // reload once for the current files rather than a broken page.
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForFreshFiles()) event.preventDefault();
  });
  // The helper's salary receipt link (Owner pilot 2026-10-19): its own page,
  // which asks the helper to sign in and comes back to the same receipt.
  if (window.location.pathname === "/receipt") {
    import("./receipt.js").then((m) => m.renderReceiptPage(root));
    return;
  }
  // Owner-pilot Bridal: a guest's wedding invitation needs no login (the
  // token in the link is the only credential, checked by the server).
  // Also /w/{weddingSlug}/invite/{token}: the slug is only the friendly part.
  // /w/{weddingSlug} alone shows a "personal links only" note (nothing about the wedding).
  if (window.location.pathname.startsWith("/invite/") || /^\/w\/[^/]+(\/invite\/|\/?$)/.test(window.location.pathname)) {
    import("./invite.js").then((m) => m.renderInvitePage(root));
    return;
  }
  // Owner pilot: a business's public menu / order link needs no login
  // (/api/store resolves the slug to one business and shows only the menu).
  if (window.location.pathname.startsWith("/store/")) {
    import("./store.js").then((m) => m.renderStorePage(root));
    return;
  }
  // Phase 18.6: the account activation page needs no login either.
  if (window.location.pathname === "/activate") {
    import("./activate.js").then((m) => m.renderActivatePage(root));
    return;
  }
  if (!isFirebaseConfigured()) {
    renderAccessProblem(root, {
      title: "Luna isn't configured",
      message: "This deployment is missing its Firebase configuration. Please contact Luna support.",
      onSignOut: () => window.location.reload(),
    });
    return;
  }

  watchUser((user) => {
    if (!user) {
      stopRevalidation();
      stopRouter();
      currentEmail = "";
      showLogin(pendingLoginNotice);
      pendingLoginNotice = "";
      return;
    }
    currentEmail = user.email || "";
    startApp();
  });
}

boot();
