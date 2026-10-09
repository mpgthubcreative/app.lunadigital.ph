// Lazy loaders, one per module id in shared/modules.js. Vite turns each
// dynamic import into its own chunk, so a staff member who only uses
// Orders never downloads Reports or Imports code.
//
// Every module exports: mount(container, session) → optional cleanup fn.
// A loader gets the session: one module id can have a different screen per
// workspace (Phase 15: Expenses is "Baby Expenses" in the Baby workspace,
// with the family's own categories and providers).

import { snapshotWorkspaceTemplateId } from "@shared/workspaces.js";

const isBaby = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "baby-expense";

export const MODULE_LOADERS = {
  dashboard: () => import("./dashboard/index.js"),
  orders: () => import("./orders/index.js"),
  payments: () => import("./payments/index.js"),
  inventory: () => import("./inventory/index.js"),
  customers: () => import("./customers/index.js"),
  expenses: (session) => (isBaby(session) ? import("./baby/expenses.js") : import("./expenses/index.js")),
  reports: () => import("./reports/index.js"),
  imports: () => import("./imports/index.js"),
  users: () => import("./users/index.js"),
  settings: () => import("./settings/index.js"),
  // Phase 14: Household / Kasambahay Payroll.
  household: () => import("./household/index.js"),
  attendance: () => import("./attendance/index.js"),
  payroll: () => import("./payroll/index.js"),
  advances: () => import("./advances/index.js"),
  // Phase 15: Baby Expense Tracker.
  budget: () => import("./baby/budget.js"),
  schedule: () => import("./baby/schedule.js"),
  providers: () => import("./baby/providers.js"),
  // Not a module in shared/modules.js: the core Notifications page (Phase 13).
  notifications: () => import("./notifications/index.js"),
};
