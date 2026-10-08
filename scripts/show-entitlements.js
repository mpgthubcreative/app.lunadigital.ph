// Read-only: shows a business's plan, overrides, stored entitlement
// snapshot, whether it passes validation, and what a recompute would give.
//   node --env-file=.env.local scripts/show-entitlements.js --business <businessId>

import { parseArgs, requireArgs, connectReadOnly, fail, printEntitlements } from "./_cli.js";
import { describeEntitlements, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

// Key-order-independent comparison of the parts a recompute produces.
const FIELDS = ["schemaVersion", "planId", "planName", "modules", "limits", "features"];
const canonical = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
    : value;
const comparable = (snapshot) => JSON.stringify(canonical(Object.fromEntries(FIELDS.map((k) => [k, snapshot?.[k] ?? null]))));

const args = parseArgs();
requireArgs(args, ["business"]);
const { db } = await connectReadOnly();

try {
  const d = await describeEntitlements({ db, businessId: args.business });
  console.log(`Business ${d.businessId}: plan=${d.planId} status=${d.subscriptionStatus}`);
  console.log(`Overrides: ${JSON.stringify(d.overrides)}`);
  if (d.stored && d.valid) printEntitlements(d.stored, "Stored snapshot (valid)");
  else console.log(`Stored snapshot INVALID — access to this business fails closed:\n  - ${d.problems.join("\n  - ")}`);
  if (d.recomputed) {
    const same = comparable(d.stored) === comparable(d.recomputed);
    console.log(same ? "Recompute would change nothing." : "Recompute WOULD change the snapshot:");
    if (!same) printEntitlements(d.recomputed, "  recomputed");
  } else {
    console.log(`Recompute would fail: ${d.recomputeError}`);
  }
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
