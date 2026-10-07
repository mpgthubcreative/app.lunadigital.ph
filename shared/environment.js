// Deployment environment names. The value comes from configuration
// (LUNA_ENV on the server, VITE_LUNA_ENV in the browser) — never inferred
// from a hostname, region or project id, so the same code runs unchanged
// in any environment.

export const ENVIRONMENTS = Object.freeze(["development", "staging", "production"]);

export function normalizeEnvironment(value) {
  return ENVIRONMENTS.includes(value) ? value : "development";
}

export function isProduction(value) {
  return value === "production";
}

export const ENVIRONMENT_LABELS = Object.freeze({
  development: "Development",
  staging: "Staging — demo data only",
  production: "",
});
