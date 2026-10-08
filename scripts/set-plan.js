// Assigns (or changes) a business's plan and recomputes its entitlements.
// Overrides are kept. Writes an audit record.
//   node --env-file=.env.local scripts/set-plan.js \
//     --business <businessId> --plan starter|growth|pro --reason "why" [--actor you@luna] --confirm <projectId>

import { parseArgs, requireArgs, connect, fail, printEntitlements } from "./_cli.js";
import { assignPlan, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
requireArgs(args, ["business", "plan", "reason"]);
const { db, admin } = await connect(args);

try {
  const result = await assignPlan({ db, admin, businessId: args.business, planId: args.plan, actor: args.actor, reason: args.reason });
  console.log(`✔ ${result.businessId} is on plan ${result.planId}`);
  printEntitlements(result.entitlements);
  for (const w of result.warnings) console.log(`⚠ ${w}`);
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
