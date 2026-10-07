// Luna Super Admin console — a separate entry point and bundle from the
// tenant app. Access will require the `platformAdmin` custom claim
// (set only by a CLI script) and every privileged action goes through
// server functions that re-check it. Tenant operational data is NOT
// readable from here by default (see architecture: audited support access).
//
// Phase 1: shell + plan catalog rendered from shared/plans.seed.js.

import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../styles/components.css";

import { PLAN_SEED, formatMoney, MODULES } from "@shared/index.js";
import { html, render } from "../lib/html.js";
import { icon, lunaMark } from "../components/icons.js";
import { pageHeader, card, emptyState, badge } from "../components/ui.js";
import { formatBytes, formatNumber } from "../lib/format.js";
import { createRouter } from "../app/router.js";

const BASE = "/console";

const SECTIONS = [
  { path: "/", label: "Businesses", icon: "businesses", view: businessesView },
  { path: "/plans", label: "Plans", icon: "plans", view: plansView },
];

function businessesView() {
  return html`
    ${pageHeader({ title: "Businesses", subtitle: "Tenants, plans, subscription status, renewal and usage." })}
    ${card({
      body: html`
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Business</th><th>Plan</th><th class="num">Users</th><th>Status</th><th>Renewal</th><th>Usage</th></tr></thead>
          </table>
        </div>
        ${emptyState({ iconName: "businesses", title: "No businesses yet", body: "Businesses are created with the onboarding script in Phase 2 and managed here in Phase 13." })}
      `,
    })}
  `;
}

function plansView() {
  const plans = Object.values(PLAN_SEED).sort((a, b) => a.sortOrder - b.sortOrder);
  const moduleLabel = (id) => MODULES.find((m) => m.id === id)?.label || id;
  return html`
    ${pageHeader({ title: "Plans", subtitle: "Initial configuration (seed). Editable plans arrive in Phase 13 — prices and limits are not final." })}
    ${card({
      body: html`
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Plan</th><th class="num">Setup</th><th class="num">Monthly</th><th class="num">Users</th>
                <th class="num">Orders / mo</th><th class="num">Storage</th><th class="num">Imports / mo</th><th>Modules</th>
              </tr>
            </thead>
            <tbody>
              ${plans.map(
                (p) => html`
                  <tr>
                    <td>${p.name} ${p.recommended ? badge("Recommended", "primary") : ""}</td>
                    <td class="num">${formatMoney(p.pricing.setupFee, { minimum: p.pricing.setupFeeIsMinimum })}</td>
                    <td class="num">${formatMoney(p.pricing.monthly, { minimum: p.pricing.monthlyIsMinimum })}</td>
                    <td class="num">${formatNumber(p.limits.users)}</td>
                    <td class="num">${formatNumber(p.limits.ordersPerMonth)}</td>
                    <td class="num">${formatBytes(p.limits.storageBytes)}</td>
                    <td class="num">${formatNumber(p.limits.importsPerMonth)}</td>
                    <td>${Object.entries(p.modules).filter(([, on]) => on).map(([id]) => moduleLabel(id)).join(", ")}</td>
                  </tr>
                `
              )}
            </tbody>
          </table>
        </div>
      `,
    })}
  `;
}

function boot() {
  const root = document.getElementById("app");
  render(
    root,
    html`
      <div class="shell" id="shell">
        <aside class="sidebar" id="sidebar" aria-label="Console navigation">
          <div class="brand">${lunaMark()}<span class="brand-text">Luna <span class="brand-sub">Console</span></span></div>
          <nav class="nav">
            ${SECTIONS.map(
              (s) => html`
                <a class="nav-link" href="${BASE}${s.path}" data-link data-nav="${s.path}" title="${s.label}">
                  ${icon(s.icon)}<span class="nav-label">${s.label}</span>
                </a>
              `
            )}
          </nav>
          <div class="sidebar-footer">Internal — Luna staff only</div>
        </aside>
        <div class="scrim" id="scrim"></div>
        <div class="main-col">
          <header class="topbar">
            <button type="button" class="menu-btn" id="menuBtn" aria-label="Open navigation" aria-expanded="false">${icon("menu")}</button>
            <div class="topbar-title" id="topbarTitle"></div>
          </header>
          <div class="banners">
            <div class="banner banner-info" role="note">Foundation preview — Super Admin sign-in arrives in Phase 2; management features in Phase 13.</div>
          </div>
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

  const router = createRouter({
    base: BASE,
    routes: SECTIONS,
    onRoute(section) {
      setNavOpen(false);
      root.querySelectorAll(".nav-link").forEach((l) => l.classList.toggle("is-active", l.dataset.nav === section.path));
      root.querySelector("#topbarTitle").textContent = section.label;
      document.title = `${section.label} · Luna Console`;
      render(content, section.view());
    },
    notFound() {
      render(content, card({ body: emptyState({ title: "Page not found" }) }));
    },
  });
  router.start();
}

boot();
