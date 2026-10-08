// Adds, changes or clears per-business overrides, then recomputes the
// entitlement snapshot. Validated server-side; writes an audit record.
//   node --env-file=.env.local scripts/set-overrides.js --business <businessId> \
//     [--modules reports=false,imports=true] [--clear-modules reports] \
//     [--limits users=3,ordersPerMonth=1000] [--clear-limits users] \
//     [--features googleSheets=true] [--clear-features googleSheets] \
//     --reason "why" [--actor you@luna] --confirm <projectId>

import { parseArgs, requireArgs, connect, fail, parseOverrideArgs, printEntitlements } from "./_cli.js";
import { updateOverrides, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
requireArgs(args, ["business", "reason"]);
const { set, clear } = parseOverrideArgs(args);
const changes = [set.modules, set.limits, set.features].some((o) => Object.keys(o).length) || [clear.modules, clear.limits, clear.features].some((l) => l.length);
if (!changes) fail("Nothing to change. Pass --modules / --limits / --features or a --clear-* flag.");
const { db, admin } = await connect(args);

try {
  const result = await updateOverrides({ db, admin, businessId: args.business, set, clear, actor: args.actor, reason: args.reason });
  console.log(`✔ Overrides for ${result.businessId}: ${JSON.stringify(result.overrides)}`);
  printEntitlements(result.entitlements);
  for (const w of result.warnings) console.log(`⚠ ${w}`);
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
