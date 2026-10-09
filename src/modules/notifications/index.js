// Notifications (Phase 13): the user's own history, one compact row each.
//   Time | Notification | Category | Status | Action
// Filters: All / Unread and category; 20 per page (never the whole
// history). Mark read / Mark all read. Preferences: the optional
// categories can be switched off; mandatory ones are always on. No export
// in Phase 13 (a transient inbox; the Export Core can add it later).

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, card } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { NOTIFICATION_CATEGORIES } from "@shared/notifications.js";
import * as defaultData from "./data.js";
import { notificationRow, myCategories } from "./view.js";

const STATUS_TONE = { Unread: "info", Read: "neutral", Resolved: "success" };

// options.data / toast / now / onChange are injectable for tests;
// onChange() lets the shell refresh the bell after a read.
export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), onChange = () => window.dispatchEvent(new CustomEvent("luna:notifications")) } = {}) {
  const businessId = session.business.id;
  const uid = session.user.uid;
  const categories = myCategories(session);
  const prefs = { ...(session.member.notificationPreferences || {}) };
  const state = { unread: false, category: "", cursors: [], rows: [], hasMore: false, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      const page = await data.listNotifications(businessId, uid, { unread: state.unread, category: state.category }, { cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("notifications: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load notifications.";
    }
    state.loading = false;
    if (alive) draw();
  }

  function draw() {
    if (!alive) return;
    const rows = state.rows.map((n) => notificationRow(n, session, now()));
    const opt = (v, label, current) => html`<option value="${v}" ${current === v ? "selected" : ""}>${label}</option>`;
    render(
      container,
      html`
        ${pageHeader({ title: "Notifications", subtitle: "What happened, and what needs your attention.", actions: html`<button type="button" class="btn" data-act="read-all">Mark all as read</button>` })}
        <form class="section card filters filters-inline" data-role="filters">
          <select class="select" name="show" aria-label="Show">${opt("all", "All", state.unread ? "unread" : "all")}${opt("unread", "Unread", state.unread ? "unread" : "all")}</select>
          <select class="select" name="category" aria-label="Category">${opt("", "All categories", state.category)}${categories.map((c) => opt(c, NOTIFICATION_CATEGORIES[c].label, state.category))}</select>
          <button type="submit" class="btn">Apply</button>
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !rows.length
                ? emptyState({ iconName: "inbox", title: state.unread ? "You're all caught up" : "No notifications yet", body: "Payments to verify, low stock and ready orders will appear here." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="notifications">
                    <thead><tr><th>Time</th><th>Notification</th><th class="col-secondary">Category</th><th>Status</th><th></th></tr></thead>
                    <tbody>${rows.map(
                      (r) => html`<tr data-notification="${r.id}" class="${r.unread ? "is-unread" : "is-read"}">
                        <td class="nowrap">${r.time}</td>
                        <td><strong>${r.title}</strong><div class="stat-hint">${r.message}</div></td>
                        <td class="col-secondary">${r.category}</td>
                        <td>${badge(r.status, STATUS_TONE[r.status])}</td>
                        <td class="row-actions">
                          ${r.action ? html`<a class="btn btn-compact" href="${r.action.route}" data-link data-act="open" data-id="${r.id}">${r.action.label}</a>` : html`<span class="stat-hint">No access</span>`}
                          ${r.unread ? html`<button type="button" class="btn btn-compact" data-act="read" data-id="${r.id}">Mark read</button>` : ""}
                        </td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>
        ${categories.length
          ? card({
              title: "Notification preferences",
              body: html`<form data-role="preferences" class="stack">
                ${categories.map((c) => {
                  const def = NOTIFICATION_CATEGORIES[c];
                  const on = def.mandatory || prefs[c]?.inApp !== false;
                  return html`<label class="check"><input type="checkbox" name="${c}" ${on ? "checked" : ""} ${def.mandatory ? "disabled" : ""} /> ${def.label}${def.mandatory ? html` <span class="stat-hint">(always on: it needs someone's action)</span>` : ""}</label>`;
                })}
                <p class="stat-hint">In-app only for now. Email and browser push aren't available yet.</p>
                <div><button type="submit" class="btn">Save preferences</button></div>
              </form>`,
            })
          : ""}
      `
    );
  }

  async function act(fn, message) {
    try {
      const result = await fn();
      if (message) toast(message, "success");
      onChange();
      return result;
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      return null;
    }
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const a = el.dataset.act;
    if (a === "open") {
      // The link navigates (router); marking read is a side effect.
      const row = state.rows.find((n) => n.id === el.dataset.id);
      if (row && row.read !== true) data.markRead(row.id).then(onChange, () => {});
      return;
    }
    if (a === "read") {
      if (await act(() => data.markRead(el.dataset.id))) load();
    } else if (a === "read-all") {
      if (await act(() => data.markAllRead(), "All notifications marked as read.")) load();
    } else if (a === "next" && state.rows.length) {
      state.cursors.push(state.rows.at(-1));
      load();
    } else if (a === "prev") {
      state.cursors.pop();
      load();
    }
  };
  const onSubmit = async (event) => {
    const form = event.target;
    if (form.dataset.role === "filters") {
      event.preventDefault();
      state.unread = form.elements.show.value === "unread";
      state.category = form.elements.category.value;
      state.cursors = [];
      load();
    } else if (form.dataset.role === "preferences") {
      event.preventDefault();
      const changes = {};
      for (const c of categories) if (!NOTIFICATION_CATEGORIES[c].mandatory) changes[c] = { inApp: form.elements[c].checked };
      const result = await act(() => data.savePreferences(changes), "Preferences saved.");
      if (result) Object.assign(prefs, result.preferences);
    }
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  load();

  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
