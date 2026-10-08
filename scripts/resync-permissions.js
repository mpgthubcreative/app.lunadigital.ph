// Re-resolves members' stored permission maps from their role template +
// overrides (e.g. after a release adds permission keys). Audited.
//   node --env-file=.env.local scripts/resync-permissions.js \
//     (--business <businessId> | --all) [--reason "why"] [--actor you@luna] --confirm <projectId>

import { parseArgs, connect, fail } from "./_cli.js";
import { resyncMemberPermissions, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
if (!args.business === !args.all) fail("Pass exactly one of --business <id> or --all.");
const { db, admin } = await connect(args);

const ids = args.all ? (await db.collection("businesses").get()).docs.map((d) => d.id) : [args.business];
let failed = 0;
for (const businessId of ids) {
  try {
    const result = await resyncMemberPermissions({ db, admin, businessId, actor: args.actor, reason: typeof args.reason === "string" ? args.reason : "resync member permissions" });
    console.log(`✔ ${businessId}: ${result.changes.length} member(s) updated`);
    for (const c of result.changes) console.log(`    ${c.uid} (${c.roleTemplate}) +[${c.added.join(", ")}] -[${c.removed.join(", ")}]`);
    for (const s of result.skipped) console.log(`  ⚠ skipped ${s.uid}: ${s.reason}`);
  } catch (err) {
    if (!(err instanceof ProvisioningError)) throw err;
    failed += 1;
    console.error(`✖ ${businessId}: ${err.message}`);
  }
}
if (failed) fail(`${failed} business(es) failed.`);
