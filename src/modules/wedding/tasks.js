// Wedding Tasks (Phase 16): one compact row per task.
//   Task | Category | Assigned To | Due Date | Priority | Status ▾ | View details
// Status changes inline (a controlled value, logged previous → new with who
// and when); completing records the completed date, reopening is logged.
// Overdue / Due soon are derived from the due date and the business's today,
// never stored. Not a project-management board: a focused list.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, rowMenu, bindRowMenus, filterBar } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { TASK_STATUSES, TASK_PRIORITIES, SUGGESTED_TASK_CATEGORIES, taskTiming, keyOf, businessDate } from "@shared/index.js";
import { activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";

const PRIORITY_OPTIONS = Object.entries(TASK_PRIORITIES).map(([value, p]) => ({ value, label: p.label }));
const TIMING = { overdue: ["Overdue", "danger"], due_soon: ["Due soon", "warning"] };
const STATE_OPTIONS = [["open", "Open"], ["overdue", "Overdue"], ["all", "All"]];

const taskFields = (t = {}) => [
  { name: "title", label: "Task", value: t.title ?? "", required: true, hint: "e.g. Submit church requirements" },
  { name: "category", label: "Category", value: t.category ?? "", hint: `e.g. ${SUGGESTED_TASK_CATEGORIES.slice(0, 4).join(", ")}` },
  { name: "assignee", label: "Assigned to", value: t.assignee ?? "", hint: "Anyone: the couple, family, the coordinator (no Luna account needed)" },
  { name: "dueDate", label: "Due date", type: "date", value: t.dueDate ?? "" },
  { name: "priority", label: "Priority", type: "select", options: PRIORITY_OPTIONS, value: t.priority ?? "normal" },
  { name: "notes", label: "Notes", type: "textarea", value: t.notes ?? "" },
];

export function toTaskInput(v) {
  return { title: v.title.trim(), category: v.category.trim() || null, assignee: v.assignee.trim() || null, dueDate: v.dueDate || null, priority: v.priority, notes: (v.notes || "").trim() || null };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {}, confirm = confirmDialog } = {}) {
  const canManage = session.member.permissions["tasks.manage"] === true;
  const businessId = session.business.id;
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { state: "open" }, cursors: [], rows: [], hasMore: false, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      const page = await data.listTasks(businessId, state.filters, { today: today(), cursor: state.cursors.at(-1) || null });
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("wedding tasks: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load tasks.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;
  const statusCell = (t) =>
    canManage
      ? html`<select class="select select-compact" data-act="status" data-id="${t.id}" aria-label="Status">${Object.entries(TASK_STATUSES).map(([k, s]) => opt(k, s.label, t.status))}</select>`
      : badge(TASK_STATUSES[t.status]?.label ?? t.status, t.status === "completed" ? "success" : "neutral");
  const dueCell = (t) => {
    if (!t.dueDate) return "—";
    const timing = TIMING[taskTiming(t, today())];
    return html`${formatDayId(t.dueDate)}${timing ? html` ${badge(timing[0], timing[1])}` : ""}`;
  };

  function draw() {
    if (!alive) return;
    const f = state.filters;
    render(
      container,
      html`
        ${pageHeader({ title: "Wedding Tasks", subtitle: "Everything still to do before the big day, who's on it and when it's due.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">Add task</button>` : "" })}
        ${filterBar({
          fields: [
            { name: "state", label: "Show", type: "select", primary: true, options: STATE_OPTIONS, value: f.status ? "all" : f.state || "open", def: "open" },
            { name: "assignee", label: "Assigned to", type: "search", primary: true, value: f.assignee },
            { name: "status", label: "Status", type: "select", primary: false, options: Object.entries(TASK_STATUSES).map(([k, s]) => [k, s.label]), value: f.status, all: "Any status" },
            { name: "priority", label: "Priority", type: "select", primary: false, options: PRIORITY_OPTIONS.map((p) => [p.value, p.label]), value: f.priority, all: "Any priority" },
            { name: "category", label: "Category", type: "search", primary: false, value: f.category },
            { name: "from", label: "Due from", type: "date", value: f.from },
            { name: "to", label: "Due to", type: "date", value: f.to },
          ],
          end: mayExport(session, "weddingTasks") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("weddingTasks")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "tasks", title: f.state === "overdue" ? "Nothing overdue" : "No tasks here", body: "Add the wedding to-dos: requirements, fittings, tastings, deadlines." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="tasks">
                    <thead><tr><th class="m-only"></th><th>Task</th><th class="col-secondary">Category</th><th>Assigned to</th><th>Due date</th><th class="col-secondary">Priority</th><th>Status</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (t) => html`<tr data-task="${t.id}" data-open>${mobileCell({ title: t.title, sub: [t.assignee || "Unassigned", t.category].filter(Boolean).join(" · "), end: dueCell(t) })}
                        <td>${t.title}</td><td class="col-secondary">${t.category || "—"}</td><td>${t.assignee || "—"}</td>
                        <td>${dueCell(t)}</td><td class="col-secondary">${TASK_PRIORITIES[t.priority]?.label ?? t.priority}</td>
                        <td data-m="ctl">${statusCell(t)}</td>
                        <td class="row-actions" data-m="more">${openButton(t.id, "View details", { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>`}
        </section>`
    );
  }

  function openView(t) {
    detailsDialog({
      title: t.title,
      badgeHtml: badge(TASK_STATUSES[t.status]?.label ?? t.status, t.status === "completed" ? "success" : "neutral"),
      rows: [["Category", t.category], ["Assigned to", t.assignee], ["Due date", t.dueDate ? formatDayId(t.dueDate) : null], ["Priority", TASK_PRIORITIES[t.priority]?.label], ["Completed", t.completedDate ? `${formatDayId(t.completedDate)}${t.completedBy?.name ? ` · ${t.completedBy.name}` : ""}` : null], ["Notes", t.notes]],
      activity: activityLines(t.history, timezone),
      actions: canManage ? [{ act: "delete", label: "Delete", danger: true }, { act: "edit", label: "Edit" }] : [],
      onAction: async (act) => {
        if (act === "delete") {
          if (!(await confirm({ title: `Delete "${t.title}"?`, body: "The task is removed from the list and the task counts. A record of it is kept in the activity log.", confirmLabel: "Delete task", danger: true }))) return false;
          try {
            await data.tasksApi({ action: "delete", taskId: t.id });
            toast("Task deleted.", "success");
            load();
            return true;
          } catch (err) {
            toast(err.message || "Something went wrong", "danger");
            return false;
          }
        }
        if (act !== "edit") return false;
        try {
          const r = await formDialog({
            title: "Edit task",
            fields: taskFields(t),
            onSubmit: (v) => {
              const next = toTaskInput(v);
              const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (t[k] ?? null) !== (val ?? null)));
              return Object.keys(changes).length ? data.tasksApi({ action: "update", taskId: t.id, expectedRevision: t.revision, changes }) : { unchanged: true };
            },
          });
          if (r && !r.unchanged) toast("Saved.", "success");
          if (r) load();
          return Boolean(r);
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
          return false;
        }
      },
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || ["export", "status"].includes(el.dataset.act)) return;
    try {
      switch (el.dataset.act) {
        case "new": {
          const r = await formDialog({ title: "Add task", fields: taskFields(), onSubmit: (v) => data.tasksApi({ action: "create", task: toTaskInput(v) }) });
          if (r) {
            toast("Task added.", "success");
            load();
          }
          return;
        }
        case "view": {
          const t = state.rows.find((r) => r.id === el.dataset.id);
          if (t) openView(t);
          return;
        }
        case "next":
          state.cursors.push(state.rows.at(-1));
          load();
          return;
        case "prev":
          state.cursors.pop();
          load();
          return;
        default:
          return;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  // Inline status (a controlled value): one call, then refresh.
  const onChange = async (event) => {
    const el = event.target;
    if (el.dataset?.act !== "status") return;
    el.disabled = true;
    try {
      const r = await data.tasksApi({ action: "setStatus", taskId: el.dataset.id, status: el.value });
      if (!r.unchanged) toast(el.value === "completed" ? "Task completed." : "Status updated.", "success");
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
    load();
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const el = event.target.elements;
    if (el.from.value && el.to.value && el.from.value > el.to.value) {
      toast("Choose a valid date range (the start can't be after the end).", "danger");
      return;
    }
    const category = el.category.value.trim();
    const assignee = el.assignee.value.trim();
    // A status filter shows every task with that status (open or not).
    state.filters = Object.fromEntries([["state", el.status.value ? "all" : el.state.value], ["status", el.status.value], ["category", category], ["categoryKey", keyOf(category)], ["assignee", assignee], ["assigneeKey", keyOf(assignee)], ["priority", el.priority.value], ["from", el.from.value], ["to", el.to.value]].filter(([, v]) => v));
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindMenus = bindRowMenus(container);
  // The export takes the query filters only (keys, not the typed text).
  const unbindExport = bindExport(container, () => Object.fromEntries(Object.entries(state.filters).filter(([k]) => !["category", "assignee"].includes(k))), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    unbindFilters();
    unbindRows();
    unbindMenus();
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
  };
}
