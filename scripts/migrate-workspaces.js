// Phase 8.5 migration: gives every business that predates workspace
// templates an explicit one, recomputes its snapshot (schemaVersion 2) and
// verifies it. Every pre-8.5 business ran the Distributor product, so the
// template is passed explicitly:
//
//   node --env-file=.env.local scripts/migrate-workspaces.js \
//     --template distributor --reason "Phase 8.5 migration" [--dry-run] --confirm <projectId>
//
// Businesses that already have a template are left alone (listed, not
// changed). Each assignment goes through assignWorkspaceTemplate: one
// transaction, recompute, audit ("Workspace template assigned"). The run
// ends by re-reading every business and checking its snapshot; it exits
// non-zero if any business is not valid afterwards.

import { parseArgs, requireArgs, connect, fail } from "./_cli.js";
import { assignWorkspaceTemplate, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";
import { validateEntitlementsSnapshot } from "../shared/entitlements.js";
import { getWorkspaceTemplate } from "../shared/workspaces.js";

const args = parseArgs();
requireArgs(args, ["template", "reason"]);
if (!getWorkspaceTemplate(args.template)) fail(`Unknown template "${args.template}".`);
const { db, admin } = await connect(args);

const snaps = (await db.collection("businesses").get()).docs;
const pending = snaps.filter((s) => s.data().workspaceTemplateId === undefined);
console.log(`${snaps.length} businesses; ${pending.length} without a workspace template:`);
for (const s of snaps) console.log(`  ${s.id.padEnd(28)} ${s.data().workspaceTemplateId ?? "(none)"}  snapshot v${s.data().entitlements?.schemaVersion ?? "?"}`);

if (args["dry-run"]) process.exit(0);

let failed = 0;
for (const s of pending) {
  try {
    const r = await assignWorkspaceTemplate({ db, admin, businessId: s.id, templateId: args.template, actor: args.actor || "migrate-workspaces", reason: args.reason });
    console.log(`✔ ${s.id} -> ${r.workspaceTemplateId}`);
  } catch (err) {
    failed += 1;
    console.log(`✖ ${s.id}: ${err instanceof ProvisioningError ? err.message : err.code || err.message}`);
  }
}

console.log("\nVerification:");
for (const s of (await db.collection("businesses").get()).docs) {
  const b = s.data();
  const check = validateEntitlementsSnapshot(b.entitlements, b.subscription?.planId, b.workspaceTemplateId);
  if (!check.ok) failed += 1;
  console.log(`  ${check.ok ? "OK  " : "FAIL"} ${s.id.padEnd(28)} ${b.workspaceTemplateId ?? "(none)"} v${b.entitlements?.workspaceTemplateVersion ?? "-"} schema v${b.entitlements?.schemaVersion}${check.ok ? "" : ` (${check.problems.join("; ")})`}`);
}
if (failed) fail(`${failed} problem(s).`);
console.log("\nAll businesses have a valid workspace snapshot.");
