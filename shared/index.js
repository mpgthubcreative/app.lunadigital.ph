// Shared, environment-agnostic Luna configuration and pure logic. Imported
// by both the browser app (via Vite) and Netlify Functions (via esbuild),
// so there is exactly one definition of permissions, modules, plans and
// subscription policy. Nothing in shared/ may touch the DOM, Firebase, or
// process.env.

export * from "./permissions.js";
export * from "./workspaces.js";
export * from "./modules.js";
export * from "./plans.seed.js";
export * from "./subscription.js";
export * from "./entitlements.js";
export * from "./tenancy.js";
export * from "./environment.js";
export * from "./metrics.js";
export * from "./finance.js";
export * from "./dashboard.js";
export * from "./expenses.js";
export * from "./quantity.js";
export * from "./inventory.js";
export * from "./orders.js";
export * from "./payments.js";
export * from "./customers.js";
export * from "./reports.js";
// Phase 12 import definitions. (shared/xlsx.js and shared/csv.js are NOT
// re-exported here: they pull in fflate, so only the screens that read or
// write spreadsheets import them directly, in their own lazy chunk.)
export * from "./imports.js";
export * from "./notifications.js";
export * from "./payroll.js";
