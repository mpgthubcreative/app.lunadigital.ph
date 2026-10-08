// Rebuilds the server-only report rollups (businesses/{bid}/reportRollups)
// from the source records: fulfilled orders + their cost snapshots, live
// payments and active expenses. Used once when Reports is activated (to
// cover history recorded before Phase 11) and to repair a business.
//
//   node --env-file=.env.local scripts/rebuild-report-rollups.js \
//     (--business <businessId> | --all) [--dry-run] --confirm <projectId>
//
// Run while the business is quiet: an order / payment / expense committed
// between this script's reads and its writes could be overwritten.
// --dry-run prints what would be written and changes nothing.

import { parseArgs, connect, fail } from "./_cli.js";
import { rebuildRollups, computeRollupsFromSource } from "../netlify/functions/_lib/reports.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";

const args = parseArgs();
if (!args.business && !args.all) fail("Pass --business <id> or --all.");
const { db, admin } = await connect(args);
const ids = args.all ? (await db.collection("businesses").get()).docs.map((d) => d.id) : [args.business];

for (const id of ids) {
  const tenant = tenantDb(db, id);
  if (args["dry-run"]) {
    const fresh = await computeRollupsFromSource({ tenant });
    console.log(`${id}: would write ${fresh.size} rollup documents`);
    continue;
  }
  const r = await rebuildRollups({ db, tenant, FieldValue: admin.firestore.FieldValue });
  console.log(`✔ ${id}: ${r.documents} rollup documents written, ${r.removed} stale removed`);
}
