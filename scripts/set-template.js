// Assigns a business its workspace template, or changes it, and recomputes
// its entitlements. Writes an audit record ("Workspace template changed:
// a -> b") with actor, reason, before and after.
//
//   node --env-file=.env.local scripts/set-template.js \
//     --business <businessId> --template distributor|household-payroll|baby-expense|bridal-expense \
//     --reason "why" [--actor you@luna] [--change-template] --confirm <projectId>
//
// Giving a pre-8.5 business its first template needs only the reason.
// Changing an existing template also needs --change-template: modules the
// new template doesn't allow switch off (data is kept, never deleted), and
// overrides it doesn't allow are refused until cleared with set-overrides.
//
// --dry-run prints what would change and writes nothing.

import { parseArgs, requireArgs, connect, fail, printEntitlements } from "./_cli.js";
import { assignWorkspaceTemplate, describeEntitlements, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";
import { getWorkspaceTemplate, WORKSPACE_TEMPLATE_IDS } from "../shared/workspaces.js";

const args = parseArgs();
requireArgs(args, ["business", "template", "reason"]);
if (!getWorkspaceTemplate(args.template)) fail(`Unknown template "${args.template}". Use one of: ${WORKSPACE_TEMPLATE_IDS.join(", ")}.`);
const { db, admin } = await connect(args);

try {
  const before = await describeEntitlements({ db, businessId: args.business }).catch((err) => {
    // A pre-8.5 business can't be described with a recompute yet; that's
    // exactly what this script is for.
    if (err instanceof ProvisioningError && err.code === "not-found") throw err;
    return null;
  });
  const current = before ? before.workspaceTemplateId : "(unreadable)";
  console.log(`Business ${args.business}: workspace ${current ?? "none"} -> ${args.template}`);
  if (args["dry-run"]) process.exit(0);

  const result = await assignWorkspaceTemplate({ db, admin, businessId: args.business, templateId: args.template, allowChange: args["change-template"] === true, actor: args.actor, reason: args.reason });
  console.log(`✔ ${result.businessId} is a ${result.workspaceTemplateId} workspace${result.previousWorkspaceTemplateId && result.previousWorkspaceTemplateId !== result.workspaceTemplateId ? ` (was ${result.previousWorkspaceTemplateId})` : ""}`);
  printEntitlements(result.entitlements);
  for (const w of result.warnings) console.log(`⚠ ${w}`);
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
