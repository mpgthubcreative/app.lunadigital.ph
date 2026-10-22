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
const isBridal = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "bridal-expense";
// Luna Household (household-payroll v3): its own Expenses, Bills and Budget.
const isHome = (session) => snapshotWorkspaceTemplateId(session?.entitlements) === "household-payroll";

export const MODULE_LOADERS = {
  dashboard: () => import("./dashboard/index.js"),
  orders: () => import("./orders/index.js"),
  payments: () => import("./payments/index.js"),
  inventory: () => import("./inventory/index.js"),
  customers: () => import("./customers/index.js"),
  expenses: (session) => (isHome(session) ? import("./household/expenses.js") : isBaby(session) ? import("./baby/expenses.js") : isBridal(session) ? import("./wedding/expenses.js") : import("./expenses/index.js")),
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
  budget: (session) => (isHome(session) ? import("./household/budget.js") : isBridal(session) ? import("./wedding/budget.js") : import("./baby/budget.js")),
  grocery: () => import("./household/grocery.js"),
  schedule: (session) => (isHome(session) ? import("./household/bills.js") : import("./baby/schedule.js")),
  providers: () => import("./baby/providers.js"),
  // Phase 16: Bridal / Wedding.
  vendors: () => import("./wedding/suppliers.js"),
  vendorpayments: () => import("./wedding/payments.js"),
  tasks: () => import("./wedding/tasks.js"),
  guests: () => import("./wedding/guests.js"),
  // Not a module in shared/modules.js: the core Notifications page (Phase 13).
  notifications: () => import("./notifications/index.js"),
  subscription: () => import("./subscription/index.js"),
  // Owner-pilot Bridal UX: the workspace's Excel downloads (under More).
  downloads: () => import("./downloads/index.js"),
  weddingsetup: () => import("./wedding/setup.js"),
  sharemenu: () => import("./orders/share-page.js"),
  weddingprogram: () => import("./wedding/program.js"),
  weddingcrew: () => import("./wedding/crew.js"),
};
