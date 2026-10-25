// Wedding Tasks (Phase 16; Owner-pilot Bridal UX): a compact checklist,
// not project-management software. One task = one line:
//   Task | Status ▾ (To do / In progress / Done) | Due | ⋯
// Owner-pilot second pass: ONE active list, by due date (earliest first,
// so late ones come first; no due date last), no Overdue / Due soon
// sections: the bell reminds about late tasks. A late due date is shown
// quietly (the date in red, "Overdue" for screen readers). Done (and cancelled) tasks fold into
// "Completed (n)". Downloads live under More.
// Status changes inline (a controlled value, logged previous → new with who
// and when); completing records the completed date, reopening is logged.
// The stored statuses stay (not_started / in_progress / completed /
// cancelled); only the words are simpler. Overdue is derived from the due
// date and the business's today, never stored. Edit, Change due date and
// Delete sit under ⋯.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, segmented } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { SAMPLE_CHECKLIST, sampleKey } from "@shared/wedding-samples.js";
import { sampleList, sampleItem } from "./samples.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatDayId } from "../../lib/format.js";
import { TASK_STATUSES, TASK_PRIORITIES, SUGGESTED_TASK_CATEGORIES, taskTiming, businessDate, isOpenStatus } from "@shared/index.js";
import { activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";

const PRIORITY_OPTIONS = Object.entries(TASK_PRIORITIES).map(([value, p]) => ({ value, label: p.label }));
// Simple words for the stored statuses (Cancelled only shows on a cancelled task).
export const STATUS_WORDS = { not_started: "To do", in_progress: "In progress", completed: "Done", cancelled: "Cancelled" };
const STATUS_TONE = { not_started: "", in_progress: "info", completed: "success", cancelled: "" };
const MAX_TASKS = 500;

// Task + Due date up front; the rest under More options.
const taskFields = (t = {}) => [
  { name: "title", label: "Task", value: t.title ?? "", required: true, placeholder: "e.g. Confirm final guest count" },
  { name: "dueDate", label: "Due date", type: "date", value: t.dueDate ?? "" },
  { name: "category", label: "Category", value: t.category ?? "", suggestions: SUGGESTED_TASK_CATEGORIES, more: true },
  { name: "assignee", label: "Assigned to", value: t.assignee ?? "", hint: "Anyone (no Luna account needed)", more: true },
  { name: "priority", label: "Priority", type: "select", options: PRIORITY_OPTIONS, value: t.priority ?? "normal", more: true, default: true },
  // Requirements (optional on any task): for whom, and where to get it.
  { name: "forWhom", label: "For", type: "select", options: FOR_OPTIONS, value: t.forWhom ?? "", more: true, default: true },
  { name: "source", label: "Where to get it", value: t.source ?? "", placeholder: "e.g. San Jose Parish, PSA online", more: true },
  { name: "notes", label: "Notes", type: "textarea", value: t.notes ?? "", more: true },
];
const FOR_OPTIONS = [{ value: "", label: "—" }, { value: "bride", label: "Bride" }, { value: "groom", label: "Groom" }, { value: "both", label: "Bride & Groom (each one's own)" }];
// "Bride ✓ · Groom —" for a Bride & Groom requirement; "Bride" / "Groom" otherwise.
export function forLine(t) {
  if (t.forWhom === "both") return `Bride ${t.parts?.bride ? "✓" : "—"} · Groom ${t.parts?.groom ? "✓" : "—"}`;
  return t.forWhom === "bride" ? "Bride" : t.forWhom === "groom" ? "Groom" : "";
}

export function toTaskInput(v) {
  return { title: v.title.trim(), category: (v.category || "").trim() || null, assignee: (v.assignee || "").trim() || null, dueDate: v.dueDate || null, priority: v.priority || "normal", notes: (v.notes || "").trim() || null, ...(v.forWhom !== undefined ? { forWhom: v.forWhom || null } : {}), ...(v.source !== undefined ? { source: (v.source || "").trim() || null } : {}) };
}

// Unfinished by due date (no due date last, then by title); done last, newest first.
export function sortTasks(tasks) {
  const active = tasks.filter((t) => isOpenStatus(t.status));
  const done = tasks.filter((t) => !isOpenStatus(t.status));
  active.sort((a, b) => (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) || (a.dueDate || "").localeCompare(b.dueDate || "") || a.title.localeCompare(b.title));
  done.sort((a, b) => (b.completedDate || b.dueDate || "").localeCompare(a.completedDate || a.dueDate || ""));
  return { active, done };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), confirm = confirmDialog, location: loc = globalThis.location } = {}) {
  const canManage = session.member.permissions["tasks.manage"] === true;
  const businessId = session.business.id;
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  // view: "mine" (My Tasks) | "sample" (the read-only Sample Checklist).
  const state = { rows: [], loading: true, error: null, showDone: false, view: "mine" };
  let alive = true;
  let focus = new URLSearchParams(loc?.search || "").get("task");

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      state.rows = (await data.listTasks(businessId, { state: "all" }, { today: today(), pageSize: MAX_TASKS })).rows;
      state.error = null;
    } catch (err) {
      console.error("wedding tasks: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load tasks.";
    }
    state.loading = false;
    draw();
    if (focus) {
      const t = state.rows.find((r) => r.id === focus);
      focus = null;
      // From the bell: the task itself opens.
      if (t) {
        container.querySelector(`[data-task="${t.id}"]`)?.scrollIntoView?.({ block: "center" });
        openView(t);
      }
    }
  }

  const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");
  const statusControl = (t) => {
    const words = canManage ? Object.keys(TASK_STATUSES).filter((k) => k !== "cancelled" || t.status === "cancelled") : [];
    return canManage
      ? html`<select class="select select-chip wl-status" data-act="status" data-id="${t.id}" data-tone="${STATUS_TONE[t.status] || ""}" aria-label="Status of ${t.title}">${words.map((k) => html`<option value="${k}" ${k === t.status ? "selected" : ""}>${STATUS_WORDS[k]}</option>`)}</select>`
      : html`<span class="wl-chip" data-tone="${STATUS_TONE[t.status] || ""}">${STATUS_WORDS[t.status] ?? t.status}</span>`;
  };
  const row = (t) => html`<li class="wl-row wl-task${isOpenStatus(t.status) ? "" : " is-done"}" data-task="${t.id}">
    <button type="button" class="wl-main" data-act="view" data-id="${t.id}"><span class="wl-name">${t.title}</span>${t.forWhom ? html`<span class="wl-sub" data-role="for">${forLine(t)}</span>` : ""}</button>
    ${statusControl(t)}
    ${taskTiming(t, today()) === "overdue" ? html`<span class="wl-due is-over" data-role="due" title="Overdue"><span class="visually-hidden">Overdue, due </span>${short(t.dueDate)}</span>` : html`<span class="wl-due" data-role="due">${t.dueDate ? short(t.dueDate) : ""}</span>`}
    <details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${t.title}">⋯</summary><div class="line-menu-list" role="menu">
      ${canManage && t.forWhom === "both" ? ["bride", "groom"].map((w) => html`<button type="button" class="menu-item" role="menuitem" data-act="part" data-who="${w}" data-id="${t.id}">${w === "bride" ? "Bride" : "Groom"}: ${t.parts?.[w] ? "mark not done" : "mark done"}</button>`) : ""}
      ${canManage ? html`<button type="button" class="menu-item" role="menuitem" data-act="edit" data-id="${t.id}">Edit</button><button type="button" class="menu-item" role="menuitem" data-act="due" data-id="${t.id}">Change due date</button>` : ""}
      <button type="button" class="menu-item" role="menuitem" data-act="view" data-id="${t.id}">Details &amp; history</button>
      ${canManage ? html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item menu-danger" role="menuitem" data-act="delete" data-id="${t.id}">Delete</button>` : ""}
    </div></details>
  </li>`;

  function draw() {
    if (!alive) return;
    const g = sortTasks(state.rows);
    const open = g.active.length;
    render(
      container,
      html`
        ${pageHeader({ title: "Tasks", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add task</button>` : "" })}
        <div class="wl-tools">${segmented("view", [["mine", "My Tasks"], ["sample", "Sample Checklist"]], state.view, { label: "Tasks view" })}</div>
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : state.loading
            ? skeleton(5)
            : state.view === "sample"
              ? sampleList({ groups: SAMPLE_CHECKLIST, added: new Set(state.rows.map((t) => sampleKey(t.title))), canAdd: canManage, role: "sample-tasks", intro: "A starter checklist of what weddings usually need. Tap + Add for what applies to yours; it joins My Tasks." })
            : !state.rows.length
              ? examplesState({
                  title: "No tasks yet",
                  body: "Your to-dos, each with its due date:",
                  items: [
                    { name: "Book final food tasting", end: "Due Nov 5" },
                    { name: "Send final guest count to caterer", end: "Due Nov 20" },
                    { name: "Confirm bridal car", end: "Due Dec 1" },
                    { name: "Pick up wedding rings", end: "Due Dec 10" },
                  ],
                  add: canManage ? { act: "new", label: "+ Add Task" } : null,
                  helper: "Or pick from the Sample Checklist above.",
                  role: "task-examples",
                })
              : html`
                ${open ? html`<ul class="wl-list wl-section" data-role="tasks">${g.active.map(row)}</ul>` : html`<p class="stat-hint wl-none">Everything is done.</p>`}
                ${g.done.length
                  ? html`<details class="wl-fold" data-role="done" ${state.showDone ? "open" : ""}><summary>Completed (${g.done.length})</summary><ul class="wl-list">${g.done.map(row)}</ul></details>`
                  : ""}`}`
    );
  }

  const editDialog = (t) =>
    formDialog({
      title: "Edit task",
      fields: taskFields(t),
      moreLabel: "More options",
      onSubmit: (v) => {
        const next = toTaskInput(v);
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (t[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? data.tasksApi({ action: "update", taskId: t.id, expectedRevision: t.revision, changes }) : { unchanged: true };
      },
    });
  const dueDialog = (t) =>
    formDialog({
      title: `Due date: ${t.title}`,
      fields: [{ name: "dueDate", label: "Due date", type: "date", value: t.dueDate ?? "", hint: "Leave empty for no due date." }],
      onSubmit: (v) => ((v.dueDate || null) === (t.dueDate ?? null) ? { unchanged: true } : data.tasksApi({ action: "update", taskId: t.id, expectedRevision: t.revision, changes: { dueDate: v.dueDate || null } })),
    });
  async function remove(t) {
    if (!(await confirm({ title: `Delete "${t.title}"?`, body: "The task is removed from the list. A record of it is kept in the activity log.", confirmLabel: "Delete task", danger: true }))) return false;
    await data.tasksApi({ action: "delete", taskId: t.id });
    toast("Task deleted.", "success");
    load();
    return true;
  }
  const saved = (r) => {
    if (r && !r.unchanged) toast("Saved.", "success");
    if (r) load();
    return Boolean(r);
  };

  function openView(t) {
    detailsDialog({
      title: t.title,
      badgeHtml: html`<span class="wl-chip" data-tone="${STATUS_TONE[t.status] || ""}">${STATUS_WORDS[t.status] ?? t.status}</span>`,
      rows: [["Due date", t.dueDate ? formatDayId(t.dueDate) : null], ["Category", t.category], ["For", forLine(t) || null], ["Where to get it", t.source], ["Assigned to", t.assignee], ["Priority", t.priority && t.priority !== "normal" ? TASK_PRIORITIES[t.priority]?.label : null], ["Completed", t.completedDate ? `${formatDayId(t.completedDate)}${t.completedBy?.name ? ` · ${t.completedBy.name}` : ""}` : null], ["Notes", t.notes]],
      activity: activityLines(t.history, timezone),
      actions: canManage ? [{ act: "delete", label: "Delete", danger: true }, { act: "edit", label: "Edit" }] : [],
      onAction: async (act) => {
        try {
          if (act === "delete") return await remove(t);
          if (act === "edit") return saved(await editDialog(t));
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || ["export", "status"].includes(el.dataset.act)) return;
    el.closest("details.line-menu")?.removeAttribute("open");
    const t = state.rows.find((r) => r.id === el.dataset.id);
    try {
      switch (el.dataset.act) {
        case "new": {
          const r = await formDialog({ title: "Add task", fields: taskFields(), moreLabel: "More options", submitLabel: "Add task", onSubmit: (v) => data.tasksApi({ action: "create", task: toTaskInput(v) }) });
          if (r) {
            toast("Task added.", "success");
            load();
          }
          return;
        }
        case "view":
          if (t) openView(t);
          return;
        case "seg":
          state.view = el.dataset.value === "sample" ? "sample" : "mine";
          draw();
          return;
        case "sample-add": {
          const pick = sampleItem(SAMPLE_CHECKLIST, el);
          if (!pick) return;
          el.disabled = true;
          // A normal task: the sample's title, its group as the category.
          await data.tasksApi({ action: "create", task: { ...toTaskInput({ title: pick.item.title, category: pick.group.label, priority: "normal" }), ...(pick.item.both ? { forWhom: "both" } : {}) } });
          toast(`Added to My Tasks: ${pick.item.title}`, "success");
          load();
          return;
        }
        case "edit":
          if (t) saved(await editDialog(t));
          return;
        case "due":
          if (t) saved(await dueDialog(t));
          return;
        case "part":
          if (t) {
            await data.tasksApi({ action: "setPart", taskId: t.id, person: el.dataset.who, done: !t.parts?.[el.dataset.who] });
            load();
          }
          return;
        case "delete":
          if (t) await remove(t);
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
      if (!r.unchanged) toast(el.value === "completed" ? "Done." : "Status updated.", "success");
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
    load();
  };
  const onToggle = (event) => {
    if (event.target.dataset?.role === "done") state.showDone = event.target.open;
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("toggle", onToggle, true);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("toggle", onToggle, true);
  };
}
