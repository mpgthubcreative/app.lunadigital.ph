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
//                   other page and Sign out). Without a Dashboard
//                   (Household): four mobileTabs + More.
//   Sign out lives in the account menu (desktop) and the More sheet.

import { TRIAL_ENDED_MESSAGE } from "@shared/trial.js";
import { resolveNavigation, accessPolicy, ENVIRONMENT_LABELS, normalizeEnvironment, canUseNotifications, terminologyLabels, getWorkspaceTemplate, snapshotWorkspaceTemplateId } from "@shared/index.js";
import { html, render } from "../lib/html.js";
import { icon, lunaMark } from "../components/icons.js";
import { initials } from "../lib/format.js";
import { mountBell } from "./notification-bell.js";
import { isTyping } from "../lib/viewport.js";
import { showExportPage, canSeeWeddingSetup, canSeeWeddingProgram, canSeeCrewMeals } from "./routes.js";
import { openFeedback, isOwner } from "./feedback.js";

// One bell per rendered shell (a business switch renders a new shell).
let bell = null;

// The free trial (2026-10-21): the days left (those who see billing), then
// the trial-ended message for everyone. Day 27+: a quiet feedback reminder.
function trialBanner(session) {
  const t = session.subscription?.trial;
  if (!t || !t.open) return "";
  const billing = session.member.permissions?.["billing.view"] === true;
  if (t.ended || session.subscription?.access?.trialEnded) {
    return html`<div class="banner banner-danger" role="alert" data-role="trial-ended">${TRIAL_ENDED_MESSAGE}${billing ? html` <a href="/subscription" data-link class="banner-link">Choose a plan</a>` : ""}</div>`;
  }
  if (!billing || t.conversion) return "";
  const left = t.daysLeft + 1;
  return html`<div class="banner banner-info" role="note" data-role="trial">Free trial · ${left === 1 ? "last day" : `${left} days left`} <a href="/subscription" data-link class="banner-link">Continue with Luna</a></div>`;
}
function feedbackReminder(session) {
  const fb = session.subscription?.feedback;
  if (!fb || fb.prompt !== "reminder" || fb.submitted || !isOwner(session)) return "";
  return html`<div class="banner banner-info" role="note" data-role="feedback-reminder">How is Luna working for you? <button type="button" class="banner-link btn-link" id="feedbackBtn">Share feedback</button></div>`;
}

const SUBSCRIPTION_MESSAGES = {
  past_due: "Your subscription payment is overdue. Please settle it to avoid interruption.",
  suspended: "This account is suspended. You can view your data, but changes are disabled.",
  cancelled: "This account is cancelled. Only the owner can sign in to export data.",
};

// The purpose of each page decides its group (and nothing else).
const MANAGE = new Set(["users", "settings", "imports", "subscription", "downloads", "weddingsetup", "weddingprogram", "weddingcrew"]);
export const navGroup = (id) => (id === "dashboard" ? "overview" : id === "reports" ? "analyze" : MANAGE.has(id) ? "manage" : "work");
const GROUP_LABELS = { overview: "Overview", work: "Work", analyze: "Analyze", manage: "Manage" };
// One-word labels for the phone tab bar (display only; ids never change).
const SHORT = { dashboard: "Dashboard", tasks: "Tasks", guests: "Guests", vendors: "Expenses", vendorpayments: "Payments", expenses: "Expenses", budget: "Budget", schedule: "Schedule", providers: "Providers", grocery: "Grocery", household: "Staff", attendance: "Attendance", payroll: "Payroll", advances: "Advances", orders: "Orders", inventory: "Inventory", payments: "Payments", customers: "Customers" };
// Tenant terminology (Phase 17) always wins over the short label.
// A template that renames a page (Household: the schedule is "Bills") keeps its own short name.
export const shortLabel = (m, terms = {}) => terms[m.id] ?? (m.id === "schedule" && m.label !== "Payment Schedule" ? m.label : SHORT[m.id]) ?? m.label;

// Dashboard + up to three phone tabs: the template's choice, filtered by
// what this member can open, topped up from the navigation order.
const NAV_HIDDEN = new Set(["vendorpayments"]);

// Pages a member may put on the phone's main tabs: the work pages (never
// the Dashboard, Users, Settings…).
export const arrangeable = (nav) => nav.filter((m) => m.id !== "dashboard" && navGroup(m.id) === "work");

// preference (shared/navigation-prefs.js): the member's own order for the
// main tabs; pages they can't open are skipped and the template's default
// fills the rest. More always comes last (rendered by the shell).
export function mobileTabs(nav, templateId, preference = null) {
  const usable = new Map(nav.map((m) => [m.id, m]));
  const eligible = new Set(arrangeable(nav).map((m) => m.id));
  const wanted = getWorkspaceTemplate(templateId)?.mobileTabs || [];
  const mine = Array.isArray(preference?.primary) ? preference.primary.filter((id) => eligible.has(id)) : [];
  const picked = [...new Set([...mine, ...(mine.length ? [] : wanted.filter((id) => usable.has(id)))])];
  // Owner-pilot UX: a workspace without a Dashboard (Household) gets four
  // work tabs instead (+ More), never five or six squeezed in; Bridal asks
  // for three (Money, Tasks, Guests) and gets three.
  const room = usable.has("dashboard") ? 3 : Math.min(4, wanted.length || 4);
  // Top up: the template's default first, then the navigation order.
  for (const id of wanted) if (picked.length < room && usable.has(id) && !picked.includes(id)) picked.push(id);
  for (const m of nav) if (picked.length < room && m.id !== "dashboard" && navGroup(m.id) === "work" && !picked.includes(m.id)) picked.push(m.id);
  return [...(usable.has("dashboard") ? ["dashboard"] : []), ...picked.slice(0, room)].map((id) => usable.get(id));
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

// Every page this member can open, in the template's order (the sidebar,
// the phone tabs and More, and Settings → Arrange navigation use it).
export function shellNavigation(session) {
  const labels = terminologyLabels(session.config);
  // Phase 18.6: Supplier Payments is run from the Wedding Suppliers rows; its
  // page stays reachable (payment history) but leaves the menu.
  // Owner-pilot Bridal UX: the template's menuHidden pages keep their route only.
  const menuHidden = new Set(getWorkspaceTemplate(snapshotWorkspaceTemplateId(session.entitlements))?.menuHidden || []);
  const nav = resolveNavigation({ entitlements: session.entitlements, permissions: session.member.permissions })
    .filter((m) => !NAV_HIDDEN.has(m.id) && !menuHidden.has(m.id))
    .map((m) => (labels[m.id] ? { ...m, label: labels[m.id] } : m));
  // Phase 18.6: the Owner's Luna subscription, under Manage (before Settings).
  if (session.member.permissions?.["billing.view"] === true) {
    const at = nav.findIndex((m) => m.id === "settings");
    nav.splice(at < 0 ? nav.length : at, 0, { id: "subscription", path: "/subscription", label: "Subscription", icon: "payments" });
  }
  // Owner-pilot Bridal: Wedding Setup first under Manage (More on a phone).
  if (canSeeWeddingSetup(session)) {
    const at = nav.findIndex((m) => navGroup(m.id) === "manage");
    nav.splice(at < 0 ? nav.length : at, 0, { id: "weddingsetup", path: "/wedding-setup", label: "Wedding Setup", icon: "heart" });
  }
  // Owner-pilot Bridal: Music & Program right after Wedding Setup.
  if (canSeeWeddingProgram(session)) {
    const setupAt = nav.findIndex((m) => m.id === "weddingsetup");
    const at = setupAt >= 0 ? setupAt + 1 : nav.findIndex((m) => navGroup(m.id) === "manage");
    nav.splice(at < 0 ? nav.length : at, 0, { id: "weddingprogram", path: "/wedding-program", label: "Music & Program", icon: "music" });
  }
  // Owner-pilot Bridal: Crew Meals right after Music & Program.
  if (canSeeCrewMeals(session)) {
    const prev = ["weddingprogram", "weddingsetup"].map((id) => nav.findIndex((m) => m.id === id)).find((i) => i >= 0) ?? -1;
    const at = prev >= 0 ? prev + 1 : nav.findIndex((m) => navGroup(m.id) === "manage");
    nav.splice(at < 0 ? nav.length : at, 0, { id: "weddingcrew", path: "/wedding-crew-meals", label: "Crew Meals", icon: "gift" });
  }
  // Owner-pilot: Download Excel, one page under More / Manage (every workspace).
  if (showExportPage(session)) {
    const at = nav.findIndex((m) => m.id === "users");
    nav.splice(at < 0 ? nav.length : at, 0, { id: "downloads", path: "/export", label: "Download Excel", icon: "download" });
  }
  return nav;
}

// handlers: { onSignOut(), onSwitchBusiness(businessId) }
// The on-screen keyboard: the visual viewport shrinks by more than this
// while a text field has focus.
const KEYBOARD_MIN = 150;
// The phone layout (layout.css: the app frame and bottom tabs).
const PHONE = "(max-width: 719px)";
// What counts as typing (the keyboard is up for it): ../lib/viewport.js.
export { isTyping };

export function renderShell(root, session, handlers = {}) {
  // Tenant terminology (Phase 17) may relabel a module; ids and paths never change.
  const labels = terminologyLabels(session.config);
  const nav = shellNavigation(session);
  const notifications = canUseNotifications({ entitlements: session.entitlements, permissions: session.member.permissions });
  if (bell) bell.stop();
  bell = null;
  const policy = accessPolicy(session.subscription.status);
  const envLabel = ENVIRONMENT_LABELS[normalizeEnvironment(session.environment)];
  const workspace = snapshotWorkspaceTemplateId(session.entitlements) || "";
  const tabs = mobileTabs(nav, workspace, session.member.navigationPreference);
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
            ${trialBanner(session)}
            ${feedbackReminder(session)}
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

  // The phone frame (layout.css): the main column is the page's scroller
  // and the document never scrolls. iPhone Safari still moves the document
  // on its own (the keyboard panning to a field, then not moving back), and
  // that offset is the blank gap under the tabs, so it is put back to 0
  // whenever nobody is typing.
  const mainCol = root.querySelector(".main-col");
  const phone = () => window.matchMedia?.(PHONE).matches === true;
  const anchor = () => {
    if (phone() && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
  };
  // The keyboard: while it is open the tabs step aside (they'd sit on top
  // of it); when it closes the frame is re-anchored. Measured against the
  // tallest screen seen (iPhone keeps the layout height, Android shrinks it).
  const vv = window.visualViewport;
  let fullHeight = window.innerHeight;
  let fullWidth = window.innerWidth;
  const onViewport = () => {
    if (window.innerWidth !== fullWidth) {
      // Rotated: measure again.
      fullWidth = window.innerWidth;
      fullHeight = window.innerHeight;
    }
    fullHeight = Math.max(fullHeight, window.innerHeight);
    const open = phone() && fullHeight - vv.height > KEYBOARD_MIN && isTyping(document.activeElement);
    const was = shell.classList.contains("keyboard-open");
    shell.classList.toggle("keyboard-open", open);
    if (was && !open) anchor();
  };
  const onWindowScroll = () => {
    if (!isTyping(document.activeElement)) anchor();
  };
  const onFocusOut = () => setTimeout(() => !isTyping(document.activeElement) && anchor(), 120);
  vv?.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onWindowScroll, { passive: true });
  document.addEventListener("focusout", onFocusOut);

  root.querySelector("#feedbackBtn")?.addEventListener("click", async () => {
    if (await openFeedback()) root.querySelector('[data-role="feedback-reminder"]')?.remove();
  });
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
      vv?.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onWindowScroll);
      document.removeEventListener("focusout", onFocusOut);
    },
    // A new page starts at the top of the scroller that actually scrolls:
    // the main column on a phone, the document elsewhere (both are reset).
    scrollToTop() {
      if (mainCol) mainCol.scrollTop = 0;
      window.scrollTo(0, 0);
    },
  };
}
