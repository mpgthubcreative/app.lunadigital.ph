// Recomputes entitlement snapshots from the stored plan + overrides, e.g.
// after a plan definition changed or to repair a stale/invalid snapshot.
// Writes an audit record per business.
//   node --env-file=.env.local scripts/recompute-entitlements.js \
//     (--business <businessId> | --all) [--reason "why"] [--actor you@luna] --confirm <projectId>

import { parseArgs, connect, fail, printEntitlements } from "./_cli.js";
import { refreshEntitlements, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
if (!args.business === !args.all) fail("Pass exactly one of --business <id> or --all.");
const { db, admin } = await connect(args);

const ids = args.all ? (await db.collection("businesses").get()).docs.map((d) => d.id) : [args.business];
let failed = 0;
for (const businessId of ids) {
  try {
    const result = await refreshEntitlements({ db, admin, businessId, actor: args.actor, reason: typeof args.reason === "string" ? args.reason : "recompute entitlements" });
    console.log(`✔ ${businessId}`);
    printEntitlements(result.entitlements, "  now");
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  } catch (err) {
    if (!(err instanceof ProvisioningError)) throw err;
    failed += 1;
    console.error(`✖ ${businessId}: ${err.message}`);
  }
}
if (failed) fail(`${failed} business(es) could not be recomputed.`);
