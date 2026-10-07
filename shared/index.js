// Shared, environment-agnostic Luna configuration and pure logic. Imported
// by both the browser app (via Vite) and Netlify Functions (via esbuild),
// so there is exactly one definition of permissions, modules, plans and
// subscription policy. Nothing in shared/ may touch the DOM, Firebase, or
// process.env.

export * from "./permissions.js";
export * from "./modules.js";
export * from "./plans.seed.js";
export * from "./subscription.js";
export * from "./entitlements.js";
