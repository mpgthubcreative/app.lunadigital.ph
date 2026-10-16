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
// period (from GET /api/household-summary; they go away once handled).
// Owner-pilot (2026-10-17): READ is not RESOLVED. The red number = what this
// person hasn't seen yet (unread notifications + needs-attention items not
// seen yet). Each item can be opened (which marks it read), marked read or
// unread (⋯); a read item that still needs action stays under Needs
// attention, labelled "Read · still needs attention", until the task is
// actually done in its tab. Mark all as read sits at the top.
// Owner-pilot Bridal UX: a wedding (no Dashboard either) gets the same
// "Needs attention" from GET /api/wedding-attention: supplier payments
// overdue or due soon, overdue tasks (grouped Money / Tasks).

import { html, render } from "../lib/html.js";
import { icon } from "../components/icons.js";
import { notificationRow, badgeText } from "../modules/notifications/view.js";
import { api as defaultApi } from "../lib/api.js";

// Household owners / managers who see payroll get the attention items.
export const hasHouseholdTodos = (session) => session?.entitlements?.workspaceTemplateId === "household-payroll" && session?.member?.permissions?.["payroll.view"] === true;
const hasWeddingTodos = (session) => session?.entitlements?.workspaceTemplateId === "bridal-expense" && (session?.member?.permissions?.["vendorpayments.view"] === true || session?.member?.permissions?.["tasks.view"] === true);
// The endpoint that lists this person's "needs attention" items, or null.
export const attentionSource = (session) => (hasHouseholdTodos(session) ? "household-summary" : hasWeddingTodos(session) ? "wedding-attention" : null);
export const emptyBellText = (session) =>
  hasHouseholdTodos(session) ? "Nothing new. Confirmations and reports from your helpers appear here." : hasWeddingTodos(session) ? "Nothing new. Payments recorded by others appear here." : "Nothing yet. Payments to verify, low stock and ready orders will appear here.";
export const groupTodos = (todos) => {
  const by = new Map();
  for (const t of todos || []) {
    if (!by.has(t.staffId)) by.set(t.staffId, { staffId: t.staffId, name: t.name, items: [] });
    by.get(t.staffId).items.push(t);
  }
  return [...by.values()];
};
// One item: tap the sentence to open it; ⋯ Open / Mark as read / unread.
const itemMenu = (label, items) => html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="${label}">⋯</summary><div class="line-menu-list" role="menu">${items.map((i) => (i.href ? html`<a class="menu-item" role="menuitem" href="${i.href}" data-link data-act="${i.act}" data-id="${i.id}">${i.label}</a>` : html`<button type="button" class="menu-item" role="menuitem" data-act="${i.act}" data-id="${i.id}">${i.label}</button>`))}</div></details>`;
export const todoList = (todos, { onClickAct = "bell-todo" } = {}) =>
  html`<div class="todo-groups" data-role="todos">${groupTodos(todos).map(
    (g) => html`<div class="todo-group" data-staff="${g.staffId}"><div class="todo-name">${g.name}</div><ul class="todo-list">${g.items.map(
      (t) => html`<li class="todo-item ${t.read ? "is-read" : "is-unread"}" data-todo="${t.id}">
        <a class="todo-link" href="${t.href}" data-link data-act="${onClickAct}" data-id="${t.id}" data-kind="${t.kind}">${t.read ? "" : html`<span class="bell-dot" aria-label="New">●</span> `}${t.text}</a>
        <div class="todo-meta"><span class="stat-hint" data-role="todo-state">${t.read ? "Read · still needs attention" : "New · needs attention"}</span>${itemMenu("Actions", [{ act: onClickAct, id: t.id, label: "Open", href: t.href }, t.read ? { act: "todo-unread", id: t.id, label: "Mark as unread" } : { act: "todo-read", id: t.id, label: "Mark as read" }])}</div>
      </li>`
    )}</ul></div>`
  )}</div>`;
// The seen / not-seen mark for needs-attention items (never resolves them).
export const markAttention = (api, ids, read) => api("notifications", { method: "POST", body: { action: "attention", ids, read } });

const REFRESH_MS = 60 * 1000;
const loadData = () => import("../modules/notifications/data.js");

// slot: the element the bell renders into. options.data / now are injectable.
export function mountBell(slot, session, { data = null, now = () => new Date(), api = defaultApi } = {}) {
  const businessId = session.business.id;
  const uid = session.user.uid;
  const source = attentionSource(session);
  const withTodos = source !== null;
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
        <button type="button" class="bell-btn" data-act="bell" aria-haspopup="true" aria-expanded="${state.open ? "true" : "false"}" aria-label="${total() ? `Notifications, ${total()} unread` : "Notifications"}">
          ${icon("bell")}${total() ? html`<span class="bell-count" data-role="bell-count">${badgeText(total())}</span>` : ""}
        </button>
        ${state.open
          ? html`<div class="bell-drawer" role="dialog" aria-label="Notifications" data-role="bell-drawer">
              <div class="bell-head"><strong>Notifications</strong><span class="bell-head-actions">${total() ? html`<button type="button" class="btn btn-compact" data-act="bell-read-all">Mark all as read</button>` : ""}<button type="button" class="btn btn-compact btn-ghost bell-close" data-act="bell-close" aria-label="Close notifications">✕</button></span></div>
              ${state.todos.length ? html`<div class="bell-todos"><div class="bell-section">Needs attention <span class="bell-count-inline">${state.todos.length}</span></div>${todoList(state.todos)}</div>` : ""}
              ${withTodos ? html`<div class="bell-section">Recent</div>` : ""}
              ${state.error
                ? html`<p class="stat-hint bell-empty">Couldn't load notifications.</p>`
                : state.rows === null
                  ? html`<p class="stat-hint bell-empty">Loading…</p>`
                  : !rows.length
                    ? html`<p class="stat-hint bell-empty">${emptyBellText(session)}</p>`
                    : html`<ul class="bell-list">${rows.map(
                        (r) => html`<li class="bell-item ${r.unread ? "is-unread" : "is-read"}" data-notification="${r.id}">
                          <div class="bell-title">${r.unread ? html`<span class="bell-dot" aria-label="Unread">●</span> ` : ""}${r.title}${r.resolved ? html` <span class="stat-hint">· Resolved</span>` : ""}</div>
                          <div class="stat-hint">${r.message}</div>
                          <div class="bell-meta"><span class="stat-hint">${r.time}</span><span class="bell-meta-actions">${r.action ? html`<a class="bell-action" href="${r.action.route}" data-link data-act="bell-open" data-id="${r.id}">${r.action.label}</a>` : html`<span class="stat-hint">No access</span>`}${itemMenu("More actions", r.unread ? [{ act: "bell-read", id: r.id, label: "Mark as read" }] : [{ act: "bell-unread", id: r.id, label: "Mark as unread" }])}</span></div>
                        </li>`
                      )}</ul>`}
              <div class="bell-foot"><a href="/notifications" data-link data-act="bell-all">View all notifications</a></div>
            </div>`
          : ""}
      </div>`
    );
  }

  const total = () => state.count + state.todos.filter((x) => !x.read).length;
  async function refresh() {
    if (!alive) return;
    try {
      const [count, todos] = await Promise.all([
        (await getData()).fetchUnreadCount(businessId, uid),
        withTodos ? api(source).then((r) => r.summary?.todos || [], () => state.todos) : Promise.resolve([]),
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
        await (await getData()).markAllRead(state.todos.map((x) => x.id));
        state.count = 0;
        state.todos = state.todos.map((x) => ({ ...x, read: true }));
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
      // Opening marks it read; the task itself is done in its tab.
      const item = state.todos.find((x) => x.id === el.dataset.id);
      if (item && !item.read) {
        item.read = true;
        markAttention(api, [item.id], true).then(refresh, () => {});
      }
      close();
    } else if (a === "todo-read" || a === "todo-unread") {
      el.closest("details")?.removeAttribute("open");
      const item = state.todos.find((x) => x.id === el.dataset.id);
      if (item) {
        item.read = a === "todo-read";
        draw();
        markAttention(api, [item.id], item.read).catch(() => {});
      }
    } else if (a === "bell-read" || a === "bell-unread") {
      el.closest("details")?.removeAttribute("open");
      const row = (state.rows || []).find((n) => n.id === el.dataset.id);
      if (row) {
        try {
          const d = await getData();
          await (a === "bell-read" ? d.markRead(row.id) : d.markUnread(row.id));
          row.read = a === "bell-read";
          state.count = Math.max(0, state.count + (a === "bell-read" ? -1 : 1));
          draw();
        } catch {
          /* the count refreshes on the next tick */
        }
      }
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
