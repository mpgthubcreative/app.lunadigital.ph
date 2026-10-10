// Luna Super Admin console (Phase 17) - a separate entry point and bundle
// from the tenant app (/console vs /). Sign-in is the normal Luna account;
// ACCESS is decided by the server on every request: an active operator
// record (operators/{uid}). A business Owner who opens /console gets the
// "Luna staff only" screen and no data: the console never reads Firestore
// directly, and every view goes through POST /api/operator.

import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../styles/components.css";

import { MODULES, WORKSPACE_TEMPLATES } from "@shared/index.js";
import { html, render } from "../lib/html.js";
import { icon, lunaMark } from "../components/icons.js";
import { card, emptyState } from "../components/ui.js";
import { toast } from "../components/feedback.js";
import { createRouter } from "../app/router.js";
import { api, setTokenProvider } from "../lib/api.js";
import { watchUser, signIn, signOutUser, currentIdToken, friendlyAuthError } from "../app/auth.js";
import { renderLogin, renderBoot } from "../app/screens.js";
import { overviewView, businessesView, plansView, auditView, usageView } from "./views.js";

const BASE = "/console";
const SECTIONS = [
  { path: "/", label: "Overview", icon: "dashboard", view: overviewView },
  { path: "/businesses", label: "Businesses", icon: "businesses", view: businessesView },
  { path: "/usage", label: "Usage", icon: "budget", view: usageView },
  { path: "/plans", label: "Plans", icon: "plans", view: plansView },
  { path: "/audit", label: "Audit", icon: "reports", view: auditView },
];

// One operator API call; errors carry the server's message.
export const call = (action, body = {}) => api("operator", { method: "POST", body: { action, ...body } });

function renderNotOperator(root, email) {
  render(
    root,
    html`<div class="auth-wrap"><div class="auth-card">
      <div class="brand">${lunaMark()}<span class="brand-text">Luna <span class="brand-sub">Console</span></span></div>
      ${emptyState({ title: "Luna staff only", body: `${email || "This account"} isn't a Luna operator. Business owners manage their business in the Luna app.` })}
      <div class="page-actions"><a class="btn" href="/">Go to the Luna app</a><button type="button" class="btn" id="signOut">Sign out</button></div>
    </div></div>`
  );
  root.querySelector("#signOut").addEventListener("click", () => signOutUser());
}

function mountConsole(root, session, plans) {
  render(
    root,
    html`
      <div class="shell console-shell" id="shell">
        <aside class="sidebar" id="sidebar" aria-label="Console navigation">
          <div class="brand">${lunaMark()}<span class="brand-text">Luna <span class="brand-sub">Console</span></span></div>
          <nav class="nav">
            ${SECTIONS.map((s) => html`<a class="nav-link" href="${BASE}${s.path}" data-link data-nav="${s.path}" title="${s.label}">${icon(s.icon)}<span class="nav-label">${s.label}</span></a>`)}
          </nav>
          <div class="sidebar-footer">${session.operator.email} · Luna staff<br /><button type="button" class="btn btn-compact" id="signOut">Sign out</button></div>
        </aside>
        <div class="scrim" id="scrim"></div>
        <div class="main-col">
          <header class="topbar">
            <button type="button" class="menu-btn" id="menuBtn" aria-label="Open navigation" aria-expanded="false">${icon("menu")}</button>
            <div class="topbar-title" id="topbarTitle"></div>
          </header>
          <main class="content" id="content" tabindex="-1"></main>
        </div>
      </div>
    `
  );
  const shell = root.querySelector("#shell");
  const content = root.querySelector("#content");
  const menuBtn = root.querySelector("#menuBtn");
  const setNavOpen = (open) => {
    shell.classList.toggle("nav-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  menuBtn.addEventListener("click", () => setNavOpen(!shell.classList.contains("nav-open")));
  root.querySelector("#scrim").addEventListener("click", () => setNavOpen(false));
  root.querySelector("#signOut").addEventListener("click", () => signOutUser());

  let router;
  const ctx = {
    base: BASE,
    call,
    toast,
    workspaces: session.workspaces,
    plans,
    workspaceName: (id) => WORKSPACE_TEMPLATES[id]?.name ?? id ?? "—",
    planName: (id) => plans.find((p) => p.id === id)?.name ?? id ?? "—",
    moduleLabel: (id) => MODULES.find((m) => m.id === id)?.label ?? id,
    navigate: (path) => router.navigate(path),
  };
  router = createRouter({
    base: BASE,
    routes: SECTIONS,
    onRoute(section) {
      setNavOpen(false);
      root.querySelectorAll(".nav-link").forEach((l) => l.classList.toggle("is-active", l.dataset.nav === section.path));
      root.querySelector("#topbarTitle").textContent = section.label;
      document.title = `${section.label} · Luna Console`;
      content.onclick = content.onchange = content.onsubmit = null;
      section.view(content, { ...ctx, search: window.location.search });
    },
    notFound() {
      render(content, card({ body: emptyState({ title: "Page not found" }) }));
    },
  });
  router.start();
}

async function boot() {
  const root = document.getElementById("app");
  setTokenProvider(currentIdToken);
  renderBoot(root, "Loading Luna Console…");
  await watchUser(async (user) => {
    if (!user) {
      renderLogin(root, {
        notice: "Luna Console · Luna staff only",
        onSubmit: async (email, password) => {
          try {
            await signIn(email, password);
          } catch (err) {
            throw new Error(friendlyAuthError(err));
          }
        },
      });
      return;
    }
    try {
      const session = await call("session");
      const { plans } = await call("plans");
      mountConsole(root, session, plans);
    } catch (err) {
      if (err.status === 403) renderNotOperator(root, user.email);
      else render(root, card({ body: emptyState({ title: "Couldn't load the console", body: err.message }) }));
    }
  });
}

if (typeof document !== "undefined" && document.getElementById("app") && !globalThis.__LUNA_TEST__) boot();
