// The shell's notification bell (Phase 13): 🔔 + unread count, and a
// compact drawer with the latest few notifications.
//
// The count is ONE document read (inboxState/summary, kept by the server),
// refreshed on navigation, when the tab becomes visible, after a read, and
// every minute while visible: never a count over the inbox. The drawer
// reads the latest 8 only when opened. Firestore code lives in the lazy
// notifications data chunk. The bell belongs to one business: switching
// business re-renders the shell and mounts a new bell for the new one.
// Owner-pilot batch: on a phone the drawer is a full-width sheet under the
// top bar (inside the viewport, wrapped text, a Close button); desktop and
// tablet keep the compact popover.
// Owner-pilot UX (2026-10-17): in a Household (no Dashboard) the bell is the
// one place for what needs the Owner: "Needs your attention" items, one
// sentence each, grouped by helper, each linking to the exact tab / helper /
// period (from GET /api/household-summary; they go away once handled). The
// count = those items + unread notifications.

import { html, render } from "../lib/html.js";
import { icon } from "../components/icons.js";
import { notificationRow, badgeText } from "../modules/notifications/view.js";
import { api as defaultApi } from "../lib/api.js";

// Household owners / managers who see payroll get the attention items.
export const hasHouseholdTodos = (session) => session?.entitlements?.workspaceTemplateId === "household-payroll" && session?.member?.permissions?.["payroll.view"] === true;
export const groupTodos = (todos) => {
  const by = new Map();
  for (const t of todos || []) {
    if (!by.has(t.staffId)) by.set(t.staffId, { staffId: t.staffId, name: t.name, items: [] });
    by.get(t.staffId).items.push(t);
  }
  return [...by.values()];
};
export const todoList = (todos, { onClickAct = "bell-todo" } = {}) =>
  html`<div class="todo-groups" data-role="todos">${groupTodos(todos).map(
    (g) => html`<div class="todo-group" data-staff="${g.staffId}"><div class="todo-name">${g.name}</div><ul class="todo-list">${g.items.map((t) => html`<li><a class="todo-link" href="${t.href}" data-link data-act="${onClickAct}" data-kind="${t.kind}">${t.text}</a></li>`)}</ul></div>`
  )}</div>`;

const REFRESH_MS = 60 * 1000;
const loadData = () => import("../modules/notifications/data.js");

// slot: the element the bell renders into. options.data / now are injectable.
export function mountBell(slot, session, { data = null, now = () => new Date(), api = defaultApi } = {}) {
  const businessId = session.business.id;
  const uid = session.user.uid;
  const withTodos = hasHouseholdTodos(session);
  const state = { count: 0, open: false, rows: null, error: false, todos: [] };
  let alive = true;
  let timer = null;
  const getData = () => (data ? Promise.resolve(data) : loadData());

  function draw() {
    if (!alive) return;
    const rows = (state.rows || []).map((n) => notificationRow(n, session, now()));
    render(
      slot,
      html`<div class="bell-wrap">
        <button type="button" class="bell-btn" data-act="bell" aria-haspopup="true" aria-expanded="${state.open ? "true" : "false"}" aria-label="${total() ? `Notifications, ${state.todos.length ? `${state.todos.length} need${state.todos.length === 1 ? "s" : ""} attention, ` : ""}${state.count} unread` : "Notifications"}">
          ${icon("bell")}${total() ? html`<span class="bell-count" data-role="bell-count">${badgeText(total())}</span>` : ""}
        </button>
        ${state.open
          ? html`<div class="bell-drawer" role="dialog" aria-label="Notifications" data-role="bell-drawer">
              ${state.todos.length ? html`<div class="bell-todos"><div class="bell-head"><strong>Needs your attention</strong><span class="bell-count-inline">${state.todos.length}</span></div>${todoList(state.todos)}</div>` : ""}
              <div class="bell-head"><strong>Notifications</strong><span class="bell-head-actions">${state.count ? html`<button type="button" class="btn btn-compact" data-act="bell-read-all">Mark all read</button>` : ""}<button type="button" class="btn btn-compact btn-ghost bell-close" data-act="bell-close" aria-label="Close notifications">✕</button></span></div>
              ${state.error
                ? html`<p class="stat-hint bell-empty">Couldn't load notifications.</p>`
                : state.rows === null
                  ? html`<p class="stat-hint bell-empty">Loading…</p>`
                  : !rows.length
                    ? html`<p class="stat-hint bell-empty">${withTodos ? "Nothing new. Confirmations and reports from your helpers appear here." : "Nothing yet. Payments to verify, low stock and ready orders will appear here."}</p>`
                    : html`<ul class="bell-list">${rows.map(
                        (r) => html`<li class="bell-item ${r.unread ? "is-unread" : "is-read"}" data-notification="${r.id}">
                          <div class="bell-title">${r.unread ? html`<span class="bell-dot" aria-label="Unread">●</span> ` : ""}${r.title}${r.resolved ? html` <span class="stat-hint">· Resolved</span>` : ""}</div>
                          <div class="stat-hint">${r.message}</div>
                          <div class="bell-meta"><span class="stat-hint">${r.time}</span>${r.action ? html`<a class="bell-action" href="${r.action.route}" data-link data-act="bell-open" data-id="${r.id}">${r.action.label}</a>` : html`<span class="stat-hint">No access</span>`}</div>
                        </li>`
                      )}</ul>`}
              <div class="bell-foot"><a href="/notifications" data-link data-act="bell-all">View all notifications</a></div>
            </div>`
          : ""}
      </div>`
    );
  }

  const total = () => state.count + state.todos.length;
  async function refresh() {
    if (!alive) return;
    try {
      const [count, todos] = await Promise.all([
        (await getData()).fetchUnreadCount(businessId, uid),
        withTodos ? api("household-summary").then((r) => r.summary?.todos || [], () => state.todos) : Promise.resolve([]),
      ]);
      if (!alive) return;
      state.count = count;
      state.todos = todos;
      draw();
    } catch (err) {
      console.error("notifications: count failed:", err && (err.code || err.message));
    }
  }

  async function loadRecent() {
    state.rows = null;
    state.error = false;
    draw();
    try {
      state.rows = await (await getData()).fetchRecent(businessId, uid);
    } catch (err) {
      console.error("notifications: recent failed:", err && (err.code || err.message));
      state.error = true;
    }
    draw();
  }

  const close = () => {
    if (!state.open) return;
    state.open = false;
    draw();
  };

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !slot.contains(el)) {
      if (state.open && !slot.contains(event.target)) close();
      return;
    }
    const a = el.dataset.act;
    if (a === "bell") {
      state.open = !state.open;
      if (state.open) loadRecent();
      else draw();
    } else if (a === "bell-read-all") {
      try {
        await (await getData()).markAllRead();
        state.count = 0;
        await loadRecent();
      } catch {
        /* the count refreshes on the next tick */
      }
    } else if (a === "bell-open") {
      // The link itself navigates (router); marking read is a side effect.
      const row = (state.rows || []).find((n) => n.id === el.dataset.id);
      if (row && row.read !== true) getData().then((d) => d.markRead(row.id)).then(refresh, () => {});
      close();
    } else if (a === "bell-todo") {
      close();
    } else if (a === "bell-all" || a === "bell-close") {
      close();
    }
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") refresh();
  };
  const onChanged = () => refresh();

  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("luna:notifications", onChanged);
  timer = setInterval(() => {
    if (!document.body.contains(slot)) stop(); // the shell was replaced
    else if (document.visibilityState === "visible") refresh();
  }, REFRESH_MS);
  draw();
  refresh();

  function stop() {
    alive = false;
    clearInterval(timer);
    document.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("luna:notifications", onChanged);
  }

  return { refresh, stop, close };
}
