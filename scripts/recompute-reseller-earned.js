// Reseller commission (2026-11-01): earned is now the part of each order's
// final commission covered by VERIFIED customer payments. Earned totals saved
// before that counted the full commission at order time; this recomputes them
// from the orders. Dry run by default (read-only); --apply writes, never
// below what a reseller has already been paid (those are listed as BLOCKED:
// reverse a payout first).
//   node --env-file=.env.local scripts/recompute-reseller-earned.js (--business <id> | --all)
//   node --env-file=.env.local scripts/recompute-reseller-earned.js (--business <id> | --all) --apply --confirm <projectId>
import { parseArgs, connect, connectReadOnly, fail } from "./_cli.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { recomputeEarned } from "../netlify/functions/_lib/resellers.js";

const args = parseArgs();
if (!args.business === !args.all) fail("Pass exactly one of --business <id> or --all (every Reseller workspace).");
const apply = args.apply === true;
const { db, admin } = apply ? await connect(args) : await connectReadOnly();
const FieldValue = admin?.firestore?.FieldValue ?? null;
const ids = args.all ? (await db.collection("businesses").where("workspaceTemplateId", "==", "reseller").get()).docs.map((d) => d.id) : [String(args.business)];
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
let blocked = 0;
for (const businessId of ids) {
  const tenant = tenantDb(db, businessId);
  const resellers = (await tenant.collection("resellers").get()).docs.map((d) => d.id);
  console.log(`${businessId}: ${resellers.length} reseller(s)${apply ? "" : " (dry run)"}`);
  for (const resellerId of resellers) {
    const r = await recomputeEarned({ db, tenant, FieldValue, resellerId, apply, actor: { uid: "script", name: "recompute-reseller-earned" } });
    const state = r.blocked ? "BLOCKED (paid more than earned: reverse a payout first)" : !r.changed ? "unchanged" : r.applied ? "updated" : "would update";
    if (r.blocked) blocked += 1;
    console.log(`  ${r.name}: earned ${peso(r.before)} → ${peso(r.after)} · paid ${peso(r.paid)} · potential ${peso(r.potential)} · ${r.orders} order(s) — ${state}`);
  }
}
if (blocked) console.log(`\n${blocked} reseller(s) blocked: nothing was changed for them.`);
process.exit(0);
