// Luna ops: list or restore a wedding's retained photos (2026-10-28,
// netlify/functions/_lib/photo-retention.js). A replaced or removed cover /
// design / gallery photo is kept 30 days; this puts one back. The photo it
// replaces is itself retained, so a restore can be undone the same way.
//   node --env-file=.env.local scripts/restore-wedding-photo.js --business <id>                 list (read-only)
//   node --env-file=.env.local scripts/restore-wedding-photo.js --business <id> --id <historyId> --confirm <project>
import { parseArgs, requireArgs, connect, connectReadOnly, fail } from "./_cli.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { listRetained, restoreRetained } from "../netlify/functions/_lib/photo-retention.js";

const args = parseArgs();
requireArgs(args, ["business"]);
const businessId = String(args.business);
if (!args.id) {
  const { db } = await connectReadOnly();
  const rows = await listRetained({ tenant: tenantDb(db, businessId) });
  if (!rows.length) console.log(`No retained photos for ${businessId}.`);
  for (const r of rows) console.log(`${r.id}  ${r.kind}${r.slot ? `:${r.slot}` : ""}${r.photoId ? `:${r.photoId}` : ""}  ${r.reason}  kept ${r.retainedAt} → ${r.expiresAt}${r.restoredAt ? `  (restored ${r.restoredAt})` : ""}  ${Math.round(r.bytes / 1024)} KB`);
  process.exit(0);
}
const { db } = await connect(args);
const exists = (await db.collection("businesses").doc(businessId).get()).exists;
if (!exists) fail(`No business ${businessId}.`);
const r = await restoreRetained({ db, tenant: tenantDb(db, businessId), historyId: String(args.id), actor: { uid: "ops-restore", name: "Luna ops restore" } });
console.log(`Restored ${r.kind}${r.slot ? `:${r.slot}` : ""} → ${r.target}`);
process.exit(0);
