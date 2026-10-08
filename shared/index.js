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
