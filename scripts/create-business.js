// Onboards a new business with its owner.
//
//   node --env-file=.env.local scripts/create-business.js \
//     --id business-id --name "Business Name" --plan growth --template distributor \
//     --owner-email owner@example.com --owner-name "Owner Name" \
//     [--timezone Asia/Manila] --confirm <projectId>
//
// --template is required (distributor | household-payroll | baby-expense |
// bridal-expense, shared/workspaces.js): there is no default workspace.
//
// Runs provisionBusiness() - the SAME retry-safe workflow as the Super
// Admin console's "Create business" (Phase 17): business, owner account
// (created without a password if new), owner membership, default
// configuration and audit. Re-running the same command resumes / is a
// no-op; reusing an id for a different business is refused. Prints a
// password-setup link for a newly created owner.

import { parseArgs, requireArgs, connect, fail } from "./_cli.js";
import { provisionBusiness, passwordSetupLink, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
requireArgs(args, ["id", "name", "plan", "template", "owner-email", "owner-name"]);
const { db, admin, auth } = await connect(args);

try {
  const r = await provisionBusiness({
    db,
    admin,
    auth,
    actor: typeof args.actor === "string" ? args.actor : "cli",
    request: { businessId: args.id, name: args.name, planId: args.plan, workspaceTemplateId: args.template, timezone: args.timezone || "Asia/Manila", ownerEmail: args["owner-email"], ownerName: args["owner-name"] },
  });
  console.log(`✔ Business ${r.alreadyProvisioned ? "already provisioned" : "created"}: ${r.businessId} (${args.template} workspace)`);
  console.log(`✔ Owner account ${r.ownerCreated ? "created" : "found"} (${r.ownerUid}); owner membership in place`);
  if (r.ownerCreated) {
    const continueUrl = process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/` : null;
    const link = await passwordSetupLink({ auth, email: args["owner-email"], continueUrl });
    console.log(`\nSend this password-setup link to the owner (valid for a limited time):\n${link}\n`);
  }
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
