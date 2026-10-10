// Renders the tenant app shell (sidebar, top bar, banners) from the session.
// Navigation comes from resolveNavigation(): plan/override entitlements ×
// the user's permissions. No role names or plan ids are checked here.
//
// Phase 18.5:
//   Desktop/tablet  sidebar grouped by purpose: Overview (Dashboard),
//                   Work (operational modules), Analyze (Reports), Manage
//                   (Users, Settings, Imports). The workspace's accent marks
//                   the selected item ([data-workspace] on the shell).
//   Phone (<720px)  no drawer: a bottom tab bar with Dashboard + the
//                   template's three mobileTabs + More (a sheet with every
//                   other page and Sign out).
//   Sign out lives in the account menu (desktop) and the More sheet.

import { resolveNavigation, accessPolicy, ENVIRONMENT_LABELS, normalizeEnvironment, canUseNotifications, terminologyLabels, getWorkspaceTemplate, snapshotWorkspaceTemplateId } from "@shared/index.js";
import { html, render } from "../lib/html.js";
import { icon, lunaMark } from "../components/icons.js";
import { initials } from "../lib/format.js";
import { mountBell } from "./notification-bell.js";

// One bell per rendered shell (a business switch renders a new shell).
let bell = null;

const SUBSCRIPTION_MESSAGES = {
  past_due: "Your subscription payment is overdue. Please settle it to avoid interruption.",
  suspended: "This account is suspended. You can view your data, but changes are disabled.",
  cancelled: "This account is cancelled. Only the owner can sign in to export data.",
};

// The purpose of each page decides its group (and nothing else).
const MANAGE = new Set(["users", "settings", "imports"]);
export const navGroup = (id) => (id === "dashboard" ? "overview" : id === "reports" ? "analyze" : MANAGE.has(id) ? "manage" : "work");
const GROUP_LABELS = { overview: "Overview", work: "Work", analyze: "Analyze", manage: "Manage" };
// One-word labels for the phone tab bar (display only; ids never change).
const SHORT = { dashboard: "Dashboard", tasks: "Tasks", guests: "Guests", vendors: "Suppliers", vendorpayments: "Payments", expenses: "Expenses", budget: "Budget", schedule: "Schedule", providers: "Providers", household: "Staff", attendance: "Attendance", payroll: "Payroll", advances: "Advances", orders: "Orders", inventory: "Inventory", payments: "Payments", customers: "Customers" };
// Tenant terminology (Phase 17) always wins over the short label.
export const shortLabel = (m, terms = {}) => terms[m.id] ?? SHORT[m.id] ?? m.label;

// Dashboard + up to three phone tabs: the template's choice, filtered by
// what this member can open, topped up from the navigation order.
const NAV_HIDDEN = new Set(["vendorpayments"]);

export function mobileTabs(nav, templateId) {
  const usable = new Map(nav.map((m) => [m.id, m]));
  const wanted = getWorkspaceTemplate(templateId)?.mobileTabs || [];
  const picked = wanted.filter((id) => usable.has(id));
  for (const m of nav) if (picked.length < 3 && m.id !== "dashboard" && navGroup(m.id) === "work" && !picked.includes(m.id)) picked.push(m.id);
  return [...(usable.has("dashboard") ? ["dashboard"] : []), ...picked.slice(0, 3)].map((id) => usable.get(id));
}

function businessSwitcher(session, id = "businessSelect") {
  const memberships = session.memberships || [];
  if (memberships.length < 2) return "";
  return html`
    <label class="visually-hidden" for="${id}">Switch business</label>
    <select class="business-select" id="${id}">
      ${memberships.map(
        (m) => html`<option value="${m.businessId}" ${m.businessId === session.business.id ? "selected" : ""}>${m.businessName} · ${m.roleLabel}</option>`
      )}
    </select>
  `;
}

// handlers: { onSignOut(), onSwitchBusiness(businessId) }
export function renderShell(root, session, handlers = {}) {
  // Tenant terminology (Phase 17) may relabel a module; ids and paths never change.
  const labels = terminologyLabels(session.config);
  // Phase 18.6: Supplier Payments is run from the Wedding Suppliers rows; its
  // page stays reachable (payment history) but leaves the menu.
  const nav = resolveNavigation({ entitlements: session.entitlements, permissions: session.member.permissions })
    .filter((m) => !NAV_HIDDEN.has(m.id))
    .map((m) => (labels[m.id] ? { ...m, label: labels[m.id] } : m));
  const notifications = canUseNotifications({ entitlements: session.entitlements, permissions: session.member.permissions });
  if (bell) bell.stop();
  bell = null;
  const policy = accessPolicy(session.subscription.status);
  const envLabel = ENVIRONMENT_LABELS[normalizeEnvironment(session.environment)];
  const workspace = snapshotWorkspaceTemplateId(session.entitlements) || "";
  const tabs = mobileTabs(nav, workspace);
  const rest = nav.filter((m) => !tabs.includes(m));
  const groups = Object.keys(GROUP_LABELS)
    .map((g) => ({ id: g, label: GROUP_LABELS[g], items: nav.filter((m) => navGroup(m.id) === g) }))
    .filter((g) => g.items.length);
  const who = session.user.name || session.user.email;

  render(
    root,
    html`
      <div class="shell" id="shell" data-workspace="${workspace}">
        <aside class="sidebar" id="sidebar" aria-label="Main navigation">
          <div class="brand">${lunaMark()}<span class="brand-text">Luna</span></div>
          <div class="business-switch">
            <div class="business-name">${session.business.name}</div>
            ${session.plan ? html`<div class="business-plan">${session.plan.name} plan</div>` : ""}
            ${businessSwitcher(session)}
          </div>
          <nav class="nav">
            ${groups.map(
              (g) => html`
                <div class="nav-group" data-group="${g.id}">
                  ${g.id === "overview" ? "" : html`<div class="nav-group-label">${g.label}</div>`}
                  ${g.items.map(
                    (mod) => html`
                      <a class="nav-link" href="${mod.path}" data-link data-nav="${mod.path}" title="${mod.label}">
                        ${icon(mod.icon)}<span class="nav-label">${mod.label}</span>
                      </a>
                    `
                  )}
                </div>
              `
            )}
          </nav>
          <div class="sidebar-footer">Luna Business OS</div>
        </aside>

        <div class="main-col">
          <header class="topbar">
            <div class="topbar-title" id="topbarTitle"></div>
            <div class="topbar-spacer"></div>
            ${notifications ? html`<div class="bell-slot" id="bellSlot"></div>` : ""}
            <div class="account menu-wrap">
              <button type="button" class="account-btn" id="accountBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="accountMenu">
                <span class="account-text">
                  <span class="account-name">${who}</span>
                  <span class="account-role">${session.member.roleLabel}</span>
                </span>
                <span class="avatar" aria-hidden="true">${initials(who)}</span>
              </button>
              <div class="menu menu-down" id="accountMenu" role="menu" hidden>
                <div class="menu-head"><strong>${who}</strong><span>${session.member.roleLabel} · ${session.business.name}</span></div>
                <button type="button" class="menu-item" role="menuitem" id="logoutBtn">Sign out</button>
              </div>
            </div>
          </header>

          <div class="banners">
            ${envLabel ? html`<div class="banner banner-info" role="note">${envLabel}</div>` : ""}
            ${policy.banner && SUBSCRIPTION_MESSAGES[session.subscription.status]
              ? html`<div class="banner banner-${policy.banner}" role="alert">${SUBSCRIPTION_MESSAGES[session.subscription.status]}</div>`
              : ""}
          </div>

          <main class="content" id="content" tabindex="-1"></main>
        </div>

        <nav class="tabbar" aria-label="Quick navigation">
          ${tabs.map((mod) => html`<a class="tab-link" href="${mod.path}" data-link data-tab="${mod.path}">${icon(mod.icon)}<span>${shortLabel(mod, labels)}</span></a>`)}
          <button type="button" class="tab-link" id="moreBtn" aria-haspopup="dialog" aria-expanded="false" aria-controls="moreSheet">${icon("menu")}<span>More</span></button>
        </nav>
        <div class="sheet-backdrop" id="moreBackdrop" hidden></div>
        <div class="sheet" id="moreSheet" role="dialog" aria-modal="true" aria-label="More" hidden>
          <div class="sheet-handle" aria-hidden="true"></div>
          <div class="sheet-head"><strong>${session.business.name}</strong><span>${who} · ${session.member.roleLabel}</span></div>
          ${businessSwitcher(session, "businessSelectMobile")}
          <div class="sheet-links">
            ${rest.map((mod) => html`<a class="sheet-link" href="${mod.path}" data-link data-sheet="${mod.path}">${icon(mod.icon)}<span>${mod.label}</span></a>`)}
          </div>
          <button type="button" class="sheet-link sheet-signout" id="logoutBtnMobile">Sign out</button>
        </div>
      </div>
    `
  );

  const shell = root.querySelector("#shell");
  const signOut = () => handlers.onSignOut && handlers.onSignOut();

  // Account menu (desktop).
  const accountBtn = root.querySelector("#accountBtn");
  const accountMenu = root.querySelector("#accountMenu");
  const setAccount = (open) => {
    accountMenu.hidden = !open;
    accountBtn.setAttribute("aria-expanded", String(open));
  };
  accountBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setAccount(accountMenu.hidden);
  });
  const onDocClick = (e) => {
    if (!accountMenu.hidden && !accountMenu.contains(e.target)) setAccount(false);
  };
  document.addEventListener("click", onDocClick);

  // More sheet (phone).
  const moreBtn = root.querySelector("#moreBtn");
  const sheet = root.querySelector("#moreSheet");
  const backdrop = root.querySelector("#moreBackdrop");
  const setSheet = (open) => {
    sheet.hidden = !open;
    backdrop.hidden = !open;
    moreBtn.setAttribute("aria-expanded", String(open));
    shell.classList.toggle("sheet-open", open);
    if (open) sheet.querySelector("a, button")?.focus();
  };
  moreBtn.addEventListener("click", () => setSheet(sheet.hidden));
  backdrop.addEventListener("click", () => setSheet(false));
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    if (!sheet.hidden) setSheet(false);
    if (!accountMenu.hidden) setAccount(false);
  };
  document.addEventListener("keydown", onKey);

  root.querySelector("#logoutBtn").addEventListener("click", signOut);
  root.querySelector("#logoutBtnMobile").addEventListener("click", signOut);
  if (notifications) bell = mountBell(root.querySelector("#bellSlot"), session, handlers.bell || {});
  for (const switcher of root.querySelectorAll("#businessSelect, #businessSelectMobile")) {
    switcher.addEventListener("change", () => handlers.onSwitchBusiness && handlers.onSwitchBusiness(switcher.value));
  }

  return {
    nav,
    content: root.querySelector("#content"),
    setActive(route) {
      setSheet(false);
      setAccount(false);
      root.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("is-active", link.dataset.nav === route.path));
      root.querySelectorAll(".tab-link[data-tab]").forEach((link) => {
        link.classList.toggle("is-active", link.dataset.tab === route.path);
        if (link.dataset.tab === route.path) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      // A page reached from More lights up More.
      moreBtn.classList.toggle("is-active", Boolean(route.path) && rest.some((m) => m.path === route.path));
      root.querySelector("#topbarTitle").textContent = route.label;
      document.title = `${route.label} · Luna`;
      if (bell) {
        bell.close();
        bell.refresh();
      }
    },
    stopNotifications() {
      if (bell) bell.stop();
      bell = null;
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    },
  };
}
