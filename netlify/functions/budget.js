// POST /api/budget   (Phase 15: Baby Budget & Categories; budget.manage)
//   { action: "setTotal", total, expectedRevision? }                                  total: centavos >= 0, or null
//   { action: "setupCategories" }                                                     the suggested list, once
//   { action: "createCategory", category: { name, budget?, order? } }
//   { action: "updateCategory", categoryId, expectedRevision?, changes: { name?, budget?, order? } }
//   { action: "setCategoryStatus", categoryId, status: "active" | "inactive" }
//   { action: "deleteCategory", categoryId }                                          only if never used
// Spent and Remaining are computed by Luna from the recorded expenses; the
// browser can't send them. Reads go straight to Firestore (budget.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { babyActionHandler } from "./_lib/baby-http.js";
import { setBudgetTotal, setupSuggestedCategories, createCategory, updateCategory, setCategoryStatus, deleteCategory } from "./_lib/baby.js";

const M = "budget.manage";
export const createBudgetHandler = (deps) =>
  babyActionHandler("budget", {
    ...deps,
    actions: {
      setTotal: { permission: M, fields: ["action", "total", "expectedRevision"], run: (c, b) => setBudgetTotal({ ...c, total: b.total, expectedRevision: b.expectedRevision ?? null }) },
      setupCategories: { permission: M, fields: ["action"], run: (c) => setupSuggestedCategories(c) },
      createCategory: { permission: M, created: true, fields: ["action", "category"], run: (c, b) => createCategory({ ...c, input: b.category }) },
      updateCategory: { permission: M, fields: ["action", "categoryId", "expectedRevision", "changes"], run: (c, b) => updateCategory({ ...c, categoryId: b.categoryId, changes: b.changes, expectedRevision: b.expectedRevision ?? null }) },
      setCategoryStatus: { permission: M, fields: ["action", "categoryId", "status"], run: (c, b) => setCategoryStatus({ ...c, categoryId: b.categoryId, status: b.status }) },
      deleteCategory: { permission: M, fields: ["action", "categoryId"], run: (c, b) => deleteCategory({ ...c, categoryId: b.categoryId }) },
    },
  });

export const handler = createBudgetHandler({ getAdmin });
