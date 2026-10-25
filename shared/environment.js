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
  staging: "Staging",
  production: "",
});

// Environment consistency (2026-10-25): the browser build and the server
// must describe the same deployment (environment, Firebase project, site).
// Compared from configuration only: the build's VITE_* values against the
// server's own variables (via /api/session). No project id or hostname is
// special-cased, so the same project can later be switched to production
// by configuration alone.
export function siteOrigin(url) {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

// What's wrong with the server's own configuration (an empty list = fine).
export function serverConfigProblems(env) {
  const out = [];
  if (!ENVIRONMENTS.includes(env.LUNA_ENV)) out.push("LUNA_ENV is missing or not development / staging / production");
  const project = env.FIREBASE_PROJECT_ID || "";
  if (!project) out.push("FIREBASE_PROJECT_ID is missing");
  const sa = /@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/.exec(env.FIREBASE_CLIENT_EMAIL || "");
  if (project && sa && sa[1] !== project) out.push("FIREBASE_CLIENT_EMAIL belongs to a different Firebase project");
  const bucket = /^([a-z0-9-]+)\.(appspot\.com|firebasestorage\.app)$/.exec(env.FIREBASE_STORAGE_BUCKET || "");
  if (project && bucket && bucket[1] !== project) out.push("FIREBASE_STORAGE_BUCKET belongs to a different Firebase project");
  if (env.SITE_URL && !siteOrigin(env.SITE_URL)) out.push("SITE_URL isn't a valid URL");
  if (env.LUNA_ENV === "production" && !/^https:\/\//.test(env.SITE_URL || "")) out.push("SITE_URL must be the https address in production");
  return out;
}

// What the server tells the browser about itself (no secrets).
export function serverDeployment(env) {
  return { environment: normalizeEnvironment(env.LUNA_ENV), projectId: env.FIREBASE_PROJECT_ID || null, siteOrigin: siteOrigin(env.SITE_URL), problems: serverConfigProblems(env) };
}

// Where the browser build and the server disagree ([] = they agree).
// client: { environment, projectId, origin }. The site check applies in
// production, where SITE_URL is the address every generated link uses.
export function deploymentMismatches(client, server) {
  if (!server) return [];
  const out = [];
  if (Array.isArray(server.problems) && server.problems.length) out.push("server");
  if (normalizeEnvironment(client.environment) !== normalizeEnvironment(server.environment)) out.push("environment");
  if (client.projectId && server.projectId && client.projectId !== server.projectId) out.push("project");
  if (isProduction(server.environment) && server.siteOrigin && client.origin && client.origin !== server.siteOrigin) out.push("site");
  return out;
}
