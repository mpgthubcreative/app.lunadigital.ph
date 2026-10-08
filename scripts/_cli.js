// Shared plumbing for operator scripts.
//
// Safety: every script that writes to Firebase requires
//   --confirm <projectId>
// matching FIREBASE_PROJECT_ID from the loaded env file, and prints the
// target environment first. Running against the wrong project therefore
// needs the operator to type that project's id explicitly.
//
// Run with an env file, e.g.:
//   node --env-file=.env.local scripts/create-business.js --name "Acme" ... --confirm luna-business-os

import { getAdmin } from "../netlify/functions/_lib/firebase-admin.js";
import { normalizeEnvironment, isProduction } from "../shared/environment.js";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function requireArgs(args, names) {
  const missing = names.filter((n) => args[n] === undefined || args[n] === true);
  if (missing.length) fail(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(", ")}`);
}

export function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// Connects to Firebase after the environment safety checks pass.
// options.forbidProduction: refuse outright when LUNA_ENV=production
// (used by demo-data scripts).
export async function connect(args, { forbidProduction = false } = {}) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const environment = normalizeEnvironment(process.env.LUNA_ENV);
  const target = process.env.FIRESTORE_EMULATOR_HOST ? `EMULATOR ${process.env.FIRESTORE_EMULATOR_HOST}` : "CLOUD";

  if (!projectId) fail("FIREBASE_PROJECT_ID is not set. Run with --env-file=<your env file>.");
  if (!process.env.LUNA_ENV) fail("LUNA_ENV is not set in the env file (development | staging | production).");

  console.log(`Target: project=${projectId} environment=${environment} (${target})`);

  if (forbidProduction && isProduction(environment)) fail("This script creates demo data and refuses to run against production.");
  if (args.confirm !== projectId) fail(`Refusing to write. Re-run with --confirm ${projectId} to confirm the target project.`);

  return getAdmin();
}

// Read-only scripts: same target banner, no --confirm (they never write).
export async function connectReadOnly() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) fail("FIREBASE_PROJECT_ID is not set. Run with --env-file=<your env file>.");
  const target = process.env.FIRESTORE_EMULATOR_HOST ? `EMULATOR ${process.env.FIRESTORE_EMULATOR_HOST}` : "CLOUD";
  console.log(`Target: project=${projectId} environment=${normalizeEnvironment(process.env.LUNA_ENV)} (${target}) [read-only]`);
  return getAdmin();
}

// "a=1,b=2" -> [["a","1"],["b","2"]]
function pairs(value, flag) {
  if (value === undefined) return [];
  if (typeof value !== "string" || !value) fail(`--${flag} needs a value like key=value[,key=value]`);
  return value.split(",").map((part) => {
    const [key, raw, extra] = part.split("=");
    if (!key || raw === undefined || extra !== undefined) fail(`--${flag}: can't parse "${part}" (expected key=value)`);
    return [key.trim(), raw.trim()];
  });
}

function list(value, flag) {
  if (value === undefined) return [];
  if (typeof value !== "string" || !value) fail(`--${flag} needs a comma-separated list`);
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

// Override flags -> { set, clear } for updateOverrides(). Values are parsed
// strictly here and validated again server-side (validateOverrides).
//   --modules reports=false,imports=true   --clear-modules reports
//   --limits users=3,ordersPerMonth=1000    --clear-limits users
//   --features googleSheets=true,support=priority   --clear-features support
export function parseOverrideArgs(args) {
  const bool = (flag, key, raw) => {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return fail(`--${flag} ${key}: use true or false`);
  };
  const set = { modules: {}, limits: {}, features: {} };
  for (const [key, raw] of pairs(args.modules, "modules")) set.modules[key] = bool("modules", key, raw);
  for (const [key, raw] of pairs(args.limits, "limits")) {
    if (!/^\d+$/.test(raw)) fail(`--limits ${key}: must be a whole number`);
    set.limits[key] = Number(raw);
  }
  for (const [key, raw] of pairs(args.features, "features")) set.features[key] = raw === "true" ? true : raw === "false" ? false : raw;
  const clear = { modules: list(args["clear-modules"], "clear-modules"), limits: list(args["clear-limits"], "clear-limits"), features: list(args["clear-features"], "clear-features") };
  return { set, clear };
}

export function printEntitlements(entitlements, label = "Effective entitlements") {
  const on = Object.entries(entitlements.modules).filter(([, v]) => v === true).map(([k]) => k);
  const off = Object.entries(entitlements.modules).filter(([, v]) => v !== true).map(([k]) => k);
  console.log(`${label} (plan ${entitlements.planId}, workspace ${entitlements.workspaceTemplateId ?? "none"} v${entitlements.workspaceTemplateVersion ?? "-"}, schema v${entitlements.schemaVersion}):`);
  console.log(`  modules on : ${on.join(", ") || "—"}`);
  console.log(`  modules off: ${off.join(", ") || "—"}`);
  console.log(`  limits     : ${Object.entries(entitlements.limits).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`  features   : ${Object.entries(entitlements.features).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
