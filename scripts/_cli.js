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
