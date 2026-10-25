// Build-time environment consistency (2026-10-25). On a Netlify build the
// browser bundle (VITE_*) and the functions (server variables) come from the
// same site settings; if they describe different deployments the build
// fails, so the mismatched version is never published. Configuration only:
// no project id or hostname is special-cased.
//   node scripts/check-deployment-env.js          (prebuild; checks on Netlify, skips elsewhere)
//   node scripts/check-deployment-env.js --force  (check here, e.g. with --env-file=.env.local)
import { serverConfigProblems, normalizeEnvironment } from "../shared/environment.js";

const env = process.env;
if (env.NETLIFY !== "true" && !process.argv.includes("--force")) {
  console.log("Deployment check: not a Netlify build, skipped.");
  process.exit(0);
}
const problems = [...serverConfigProblems(env)];
if (normalizeEnvironment(env.VITE_LUNA_ENV) !== normalizeEnvironment(env.LUNA_ENV) || env.VITE_LUNA_ENV !== env.LUNA_ENV) problems.push(`VITE_LUNA_ENV (${env.VITE_LUNA_ENV || "missing"}) and LUNA_ENV (${env.LUNA_ENV || "missing"}) differ`);
if (env.VITE_FIREBASE_PROJECT_ID !== env.FIREBASE_PROJECT_ID) problems.push(`VITE_FIREBASE_PROJECT_ID (${env.VITE_FIREBASE_PROJECT_ID || "missing"}) and FIREBASE_PROJECT_ID (${env.FIREBASE_PROJECT_ID || "missing"}) differ`);
if (env.VITE_FIREBASE_STORAGE_BUCKET && env.FIREBASE_STORAGE_BUCKET && env.VITE_FIREBASE_STORAGE_BUCKET !== env.FIREBASE_STORAGE_BUCKET) problems.push("VITE_FIREBASE_STORAGE_BUCKET and FIREBASE_STORAGE_BUCKET differ");
if (problems.length) {
  console.error(`Deployment check FAILED (nothing will be published):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Deployment check: ${env.LUNA_ENV} · ${env.FIREBASE_PROJECT_ID}${env.SITE_URL ? ` · ${env.SITE_URL}` : ""} — consistent.`);
