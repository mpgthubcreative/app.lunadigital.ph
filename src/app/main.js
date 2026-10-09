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
import { watchUser, signIn, signOutUser, currentIdToken, friendlyAuthError } from "./auth.js";
import { loadSession, setPreferredBusinessId } from "./session.js";
import { renderShell } from "./shell.js";
import { createRouter } from "./router.js";
import { buildRoutes, routeAllowed, renderPageNotAvailable } from "./routes.js";
import { renderLogin, renderAccessProblem, renderBoot } from "./screens.js";
import { MODULE_LOADERS } from "../modules/loaders.js";
import { render } from "../lib/html.js";
import { card, emptyState } from "../components/ui.js";

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

function stopRouter() {
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
  const shell = renderShell(root, session, {
    onSignOut: () => handleSignOut(),
    onSwitchBusiness: (businessId) => {
      setPreferredBusinessId(businessId);
      startApp();
    },
  });
  currentShell = shell;

  let cleanup = null;
  let navToken = 0;
  const routes = buildRoutes(session);
  const showNotAvailable = () => {
    shell.setActive({ path: null, label: "Not available" });
    renderPageNotAvailable(shell.content);
  };

  router = createRouter({
    routes,
    async onRoute(route) {
      const token = ++navToken;
      if (typeof cleanup === "function") cleanup();
      cleanup = null;
      if (!routeAllowed(session, route)) {
        showNotAvailable();
        return;
      }
      shell.setActive(route);
      try {
        const mod = await MODULE_LOADERS[route.moduleId](session);
        if (token !== navToken) return;
        cleanup = mod.mount(shell.content, session) || null;
      } catch (err) {
        console.error(`Failed to load module ${route.moduleId}:`, err);
        render(shell.content, card({ body: emptyState({ title: "This page couldn't load", body: "Check your connection and refresh the page." }) }));
      }
      shell.content.focus({ preventScroll: true });
    },
    notFound: showNotAvailable,
  });
  router.start();

  stopRevalidation();
  revalidateTimer = setInterval(revalidate, REVALIDATE_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

async function startApp() {
  renderBoot(root, "Loading your business…");
  try {
    mountApp(await loadSession());
  } catch (err) {
    showSessionError(err);
  }
}

function boot() {
  // Phase 14: the employee's salary receipt page needs no login (the token
  // in the URL fragment is the only credential, checked by the server).
  if (window.location.pathname === "/receipt") {
    import("./receipt.js").then((m) => m.renderReceiptPage(root));
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
