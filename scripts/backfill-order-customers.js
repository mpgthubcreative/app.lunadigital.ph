// One-off backfill (2026-11-03): Customers records for past orders typed
// with a customer's name before customers were saved automatically
// (netlify/functions/_lib/customer-backfill.js: the live New Order rules,
// same name is a warning, never a match). Businesses with the Customers
// module only. Dry run by default (read-only); --apply writes, one
// transaction per business.
//   node --env-file=.env.local scripts/backfill-order-customers.js (--business <id> | --all)
//   node --env-file=.env.local scripts/backfill-order-customers.js (--business <id> | --all) --apply --confirm <projectId>
import { parseArgs, connect, connectReadOnly, fail } from "./_cli.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { backfillOrderCustomers } from "../netlify/functions/_lib/customer-backfill.js";
import { isModuleEnabled } from "../shared/modules.js";

const args = parseArgs();
if (!args.business === !args.all) fail("Pass exactly one of --business <id> or --all (businesses with the Customers module).");
const apply = args.apply === true;
const { db, admin } = apply ? await connect(args) : await connectReadOnly();
const FieldValue = admin?.firestore?.FieldValue ?? null;
const docs = args.all ? (await db.collection("businesses").get()).docs : [await db.collection("businesses").doc(String(args.business)).get()];
const REASONS = { "walk-in": "Walk-in", "same-name": "same name as an existing customer, no matching phone or address: link by hand", inactive: "matches an inactive customer: link by hand", invalid: "name not usable" };
for (const b of docs) {
  if (!b.exists) {
    console.log(`${b.id}: no such business — skipped`);
    continue;
  }
  if (!isModuleEnabled(b.data().entitlements, "customers")) {
    if (!args.all) console.log(`${b.id}: Customers module off — skipped`);
    continue;
  }
  const r = await backfillOrderCustomers({ db, tenant: tenantDb(db, b.id), FieldValue, apply, actor: { uid: "script", name: "Luna (past orders)" } });
  if (!r.linked.length && !r.skipped.length) {
    if (!args.all) console.log(`${b.id}: nothing to backfill (${r.orders} orders)`);
    continue;
  }
  console.log(`\n${b.id}${b.data().testWorkspace ? " [test]" : ""}: ${r.applied ? "DONE" : "would"} create ${r.created.length}, link to existing ${r.matched.length} (${r.linked.length} orders)`);
  for (const c of r.created) console.log(`  + ${c.name}${c.phone ? ` (${c.phone})` : ""} ← ${c.orders.join(", ")}`);
  for (const c of r.matched) console.log(`  = ${c.name} ← ${c.orders.join(", ")}${c.phoneAdded ? ` · phone added ${c.phoneAdded}` : ""}`);
  for (const s of r.skipped) console.log(`  · ${s.orderNumber} "${s.name}": ${REASONS[s.reason] ?? s.reason}`);
}
process.exit(0);
