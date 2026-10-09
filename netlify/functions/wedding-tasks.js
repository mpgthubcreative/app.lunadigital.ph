// POST /api/wedding-tasks   (Phase 16: Wedding Tasks; tasks.manage)
//   { action: "create", task: { title, category?, assignee?, dueDate?, priority?, notes? } }
//   { action: "update", taskId, expectedRevision?, changes: { ...any of the above } }
//   { action: "setStatus", taskId, status: "not_started" | "in_progress" | "completed" | "cancelled" }
// Overdue / due soon are derived from the due date and the business's
// today, never stored. Reads go straight to Firestore (tasks.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { createTask, updateTask, setTaskStatus } from "./_lib/wedding.js";

const M = "tasks.manage";
export const createWeddingTasksHandler = (deps) =>
  weddingActionHandler("wedding-tasks", {
    ...deps,
    actions: {
      create: { permission: M, created: true, fields: ["action", "task"], run: (c, b) => createTask({ ...c, input: b.task }) },
      update: { permission: M, fields: ["action", "taskId", "expectedRevision", "changes"], run: (c, b) => updateTask({ ...c, taskId: b.taskId, changes: b.changes, expectedRevision: b.expectedRevision ?? null }) },
      setStatus: { permission: M, fields: ["action", "taskId", "status"], run: (c, b) => setTaskStatus({ ...c, taskId: b.taskId, status: b.status }) },
    },
  });

export const handler = createWeddingTasksHandler({ getAdmin });
