// Settings → Arrange navigation (per user, this business). The phone's main
// tabs, in order (up to three; More is always last):
//   Main navigation   1. Payroll      ↑ ↓ Remove
//                     2. Attendance   ↑ ↓ Remove
//                     3. Expenses     ↑ ↓ Remove
//   Other pages       Grocery List    + Add to main  (when full: "Replace …?")
//   [Save]  [Reset to default]
// Move up / down buttons (no drag needed). Saved to the member's own
// record (/api/preferences); modules and permissions don't change.

import { html, render } from "../../lib/html.js";
import { api as defaultApi } from "../../lib/api.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { PRIMARY_TABS, snapshotWorkspaceTemplateId } from "@shared/index.js";
import { shellNavigation, mobileTabs, arrangeable, shortLabel } from "../../app/shell.js";

export function canArrange(session) {
  return session.member.roleTemplate !== "household_staff" && arrangeable(shellNavigation(session)).length > 1;
}

export function mountArrangeNav(box, session, { api = defaultApi, toast = defaultToast, onSaved = () => window.dispatchEvent(new CustomEvent("luna:session-changed")) } = {}) {
  const nav = shellNavigation(session);
  const pages = new Map(arrangeable(nav).map((m) => [m.id, m]));
  const workspace = snapshotWorkspaceTemplateId(session.entitlements) || "";
  const current = () => mobileTabs(nav, workspace, session.member.navigationPreference).filter((m) => pages.has(m.id)).map((m) => m.id);
  const defaults = mobileTabs(nav, workspace, null).filter((m) => pages.has(m.id)).map((m) => m.id);
  const room = Math.min(PRIMARY_TABS, defaults.length || PRIMARY_TABS);
  const state = { primary: current(), pending: null, busy: false };
  const label = (id) => pages.get(id)?.label ?? id;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  function draw() {
    const others = [...pages.keys()].filter((id) => !state.primary.includes(id));
    const changed = !same(state.primary, current());
    render(
      box,
      html`<section class="card" data-role="arrange-nav">
        <div class="card-header"><h2 class="card-title">Arrange navigation</h2></div>
        <div class="card-body">
          <p class="stat-hint">Choose the pages on your phone's bottom bar. Only for you; More stays last.</p>
          <h3 class="section-title">Main navigation</h3>
          <ol class="wl-list nav-arrange" data-role="primary">${state.primary.map(
            (id, i) => html`<li class="wl-row" data-page="${id}">
              <span class="wl-main"><span class="wl-name">${i + 1}. ${label(id)}</span></span>
              <span class="wl-end">
                <button type="button" class="btn btn-compact btn-ghost" data-act="up" data-id="${id}" aria-label="Move ${label(id)} up" ${i === 0 ? "disabled" : ""}>↑</button>
                <button type="button" class="btn btn-compact btn-ghost" data-act="down" data-id="${id}" aria-label="Move ${label(id)} down" ${i === state.primary.length - 1 ? "disabled" : ""}>↓</button>
                ${state.primary.length > 1 ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="drop" data-id="${id}" aria-label="Move ${label(id)} to More">Remove</button>` : ""}
              </span>
            </li>`
          )}</ol>
          ${others.length
            ? html`<h3 class="section-title">Other pages <small class="stat-hint">(in More)</small></h3>
              <ul class="wl-list nav-arrange" data-role="others">${others.map(
                (id) => html`<li class="wl-row" data-page="${id}">
                  <span class="wl-main"><span class="wl-name">${label(id)}</span>${state.pending === id ? html`<span class="wl-sub">Replace which one?</span>` : ""}</span>
                  <span class="wl-end">${state.pending === id
                    ? html`${state.primary.map((p) => html`<button type="button" class="btn btn-compact" data-act="replace" data-id="${id}" data-with="${p}" aria-label="Replace ${label(p)} with ${label(id)}">${shortLabel(pages.get(p))}</button>`)}<button type="button" class="btn btn-compact btn-ghost" data-act="cancel-add" aria-label="Cancel">✕</button>`
                    : html`<button type="button" class="btn btn-compact" data-act="add" data-id="${id}" aria-label="Add ${label(id)} to the main navigation">+ Add to main</button>`}</span>
                </li>`
              )}</ul>`
            : ""}
          <div class="page-actions nav-arrange-actions">
            <button type="button" class="btn btn-primary" data-act="save" ${changed && !state.busy ? "" : "disabled"}>Save</button>
            <button type="button" class="btn" data-act="reset" ${state.busy || (!session.member.navigationPreference && same(state.primary, defaults)) ? "disabled" : ""}>Reset to default</button>
          </div>
        </div>
      </section>`
    );
  }

  async function save(navigation, message) {
    state.busy = true;
    draw();
    try {
      await api("preferences", { method: "POST", body: { action: "setNavigation", navigation } });
      session.member.navigationPreference = navigation;
      toast(message, "success");
      onSaved();
    } catch (err) {
      toast(err.message || "Couldn't save", "danger");
    }
    state.busy = false;
    draw();
  }

  box.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !box.contains(el)) return;
    const id = el.dataset.id;
    const i = state.primary.indexOf(id);
    switch (el.dataset.act) {
      case "up":
      case "down": {
        const j = el.dataset.act === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= state.primary.length) return;
        [state.primary[i], state.primary[j]] = [state.primary[j], state.primary[i]];
        break;
      }
      case "drop":
        if (state.primary.length > 1) state.primary = state.primary.filter((x) => x !== id);
        break;
      case "add":
        if (state.primary.length < room) state.primary = [...state.primary, id];
        else state.pending = id; // full: replace one, never a fourth tab
        break;
      case "replace":
        state.primary = state.primary.map((x) => (x === el.dataset.with ? id : x));
        state.pending = null;
        break;
      case "cancel-add":
        state.pending = null;
        break;
      case "save":
        return save({ primary: [...state.primary] }, "Navigation saved.");
      case "reset":
        state.primary = [...defaults];
        return save(null, "Navigation reset to the default.");
      default:
        return;
    }
    draw();
  });
  draw();
}
