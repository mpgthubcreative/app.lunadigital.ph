// Renders the tenant app shell (sidebar, top bar, banners) from the session.
// Navigation comes from resolveNavigation(): plan/override entitlements ×
// the user's permissions. No role names or plan ids are checked here.

import { resolveNavigation, accessPolicy } from "@shared/index.js";
import { html, render } from "../lib/html.js";
import { icon, lunaMark } from "../components/icons.js";
import { initials } from "../lib/format.js";

const SUBSCRIPTION_MESSAGES = {
  past_due: "Your subscription payment is overdue. Please settle it to avoid interruption.",
  suspended: "This account is suspended. You can view your data, but changes are disabled.",
  cancelled: "This account is cancelled. Only the owner can sign in to export data.",
};

export function renderShell(root, session) {
  const nav = resolveNavigation({ entitlements: session.entitlements, permissions: session.member.permissions });
  const policy = accessPolicy(session.subscription.status);

  render(
    root,
    html`
      <div class="shell" id="shell">
        <aside class="sidebar" id="sidebar" aria-label="Main navigation">
          <div class="brand">${lunaMark()}<span class="brand-text">Luna</span></div>
          <div class="business-switch">
            <div class="business-name">${session.business.name}</div>
            <div class="business-plan">${session.plan.name} plan</div>
          </div>
          <nav class="nav">
            ${nav.map(
              (mod) => html`
                <a class="nav-link" href="${mod.path}" data-link data-nav="${mod.path}" title="${mod.label}">
                  ${icon(mod.icon)}<span class="nav-label">${mod.label}</span>
                </a>
              `
            )}
          </nav>
          <div class="sidebar-footer">Luna Business OS</div>
        </aside>
        <div class="scrim" id="scrim"></div>

        <div class="main-col">
          <header class="topbar">
            <button type="button" class="menu-btn" id="menuBtn" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">
              ${icon("menu")}
            </button>
            <div class="topbar-title" id="topbarTitle"></div>
            <div class="topbar-spacer"></div>
            <div class="account">
              <div class="account-text">
                <div class="account-name">${session.user.name}</div>
                <div class="account-role">${session.member.roleLabel}</div>
              </div>
              <div class="avatar" aria-hidden="true">${initials(session.user.name)}</div>
            </div>
          </header>

          <div class="banners">
            ${session.preview
              ? html`<div class="banner banner-info" role="note">Foundation preview — no sign-in and no business data yet. Authentication arrives in Phase 2.</div>`
              : ""}
            ${policy.banner && SUBSCRIPTION_MESSAGES[session.subscription.status]
              ? html`<div class="banner banner-${policy.banner}" role="alert">${SUBSCRIPTION_MESSAGES[session.subscription.status]}</div>`
              : ""}
          </div>

          <main class="content" id="content" tabindex="-1"></main>
        </div>
      </div>
    `
  );

  const shell = root.querySelector("#shell");
  const menuBtn = root.querySelector("#menuBtn");
  const setNavOpen = (open) => {
    shell.classList.toggle("nav-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  menuBtn.addEventListener("click", () => setNavOpen(!shell.classList.contains("nav-open")));
  root.querySelector("#scrim").addEventListener("click", () => setNavOpen(false));

  return {
    nav,
    content: root.querySelector("#content"),
    setActive(route) {
      setNavOpen(false);
      root.querySelectorAll(".nav-link").forEach((link) => {
        link.classList.toggle("is-active", link.dataset.nav === route.path);
      });
      root.querySelector("#topbarTitle").textContent = route.label;
      document.title = `${route.label} · Luna`;
    },
  };
}
