// Lazy loaders, one per module id in shared/modules.js. Vite turns each
// dynamic import into its own chunk, so a staff member who only uses
// Orders never downloads Reports or Imports code.
//
// Every module exports: mount(container, session) → optional cleanup fn.

export const MODULE_LOADERS = {
  dashboard: () => import("./dashboard/index.js"),
  orders: () => import("./orders/index.js"),
  payments: () => import("./payments/index.js"),
  inventory: () => import("./inventory/index.js"),
  customers: () => import("./customers/index.js"),
  expenses: () => import("./expenses/index.js"),
  reports: () => import("./reports/index.js"),
  imports: () => import("./imports/index.js"),
  users: () => import("./users/index.js"),
  settings: () => import("./settings/index.js"),
};
