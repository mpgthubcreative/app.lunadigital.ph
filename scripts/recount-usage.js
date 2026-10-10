// Recounts ONE usage counter of ONE business (and ONE month for monthly
// counters) from its source records. Dry run by default: prints current vs
// expected and what applying would do. Nothing changes without --apply.
//
//   Dry run (read-only):
//   node --env-file=.env.local scripts/recount-usage.js --business <id> --counter <counter> [--period YYYY-MM]
//
//   Apply (audited; needs the dry run's current value):
//   node --env-file=.env.local scripts/recount-usage.js --business <id> --counter <counter> [--period YYYY-MM] \
//     --apply --expect-current <n> --reason "why" [--actor you@luna] --confirm <projectId>
//
// Counters: ordersCreated | excelImports | exportsGenerated | rowsExported (monthly, need --period)
//           storageBytes (current total; first measurement of existing files)
// Orders and imports are never lowered (quota already consumed); see
// netlify/functions/_lib/recount.js.

import { parseArgs, requireArgs, connect, connectReadOnly, fail } from "./_cli.js";
import { computeRecount, applyRecount, RECOUNTABLE } from "../netlify/functions/_lib/recount.js";
import { MeteringError } from "../shared/metering.js";

const args = parseArgs();
requireArgs(args, ["business", "counter"]);
if (!Object.hasOwn(RECOUNTABLE, args.counter)) fail(`--counter must be one of: ${Object.keys(RECOUNTABLE).join(", ")}`);
const period = typeof args.period === "string" ? args.period : null;

function show(r) {
  console.log(`\nBusiness ${r.businessId} · ${r.counter}${r.period ? ` · ${r.period}` : ""} (timezone ${r.timezone})`);
  console.log(`  source:   ${r.source}`);
  console.log(`  current:  ${r.current}${r.measured === false ? " (never measured)" : ""}`);
  console.log(`  expected: ${r.expected}  (difference ${r.difference >= 0 ? "+" : ""}${r.difference})`);
  console.log(`  details:  ${JSON.stringify(r.details)}`);
  if (r.plan) console.log(`  ledger:   record ${r.plan.record.length} object(s), mark ${r.plan.markDeleted.length} missing`);
  if (r.note) console.log(`  note:     ${r.note}`);
  console.log(`  action:   ${r.action === "none" ? "nothing to change" : r.action === "report-only" ? "report only (won't be applied)" : `set to ${r.expected}`}`);
}

try {
  if (!args.apply) {
    const { db, bucket } = await connectReadOnly();
    const r = await computeRecount({ db, bucket, businessId: args.business, counter: args.counter, period });
    show(r);
    if (r.action === "set") console.log(`\nDry run only. To apply: add --apply --expect-current ${r.current} --reason "..." --confirm ${process.env.FIREBASE_PROJECT_ID}`);
  } else {
    requireArgs(args, ["reason", "expect-current"]);
    const expectedCurrent = Number(args["expect-current"]);
    if (!Number.isSafeInteger(expectedCurrent) || expectedCurrent < 0) fail("--expect-current must be the dry run's current value");
    const { db, admin, bucket } = await connect(args);
    const r = await applyRecount({ db, admin, bucket, businessId: args.business, counter: args.counter, period, actor: typeof args.actor === "string" ? args.actor : "cli", reason: args.reason, expectedCurrent });
    show(r);
    console.log(r.applied ? `\n✔ Applied and audited (usage.recounted): ${r.current} → ${r.after ?? r.expected}` : "\nNothing to change.");
  }
} catch (err) {
  if (err instanceof MeteringError) fail(err.message);
  throw err;
}
process.exit(0);
