// Phase 18.6: every business moves to a plan of its OWN workspace.
// Household / Baby / Bridal businesses still on a Distributor plan move to
// that workspace's plan: starter -> Basic, growth / pro -> Plus. Distributor
// businesses keep their plan. Dry run by default; --apply writes through
// assignPlan (entitlements recomputed, audited with the reason).
// Run `seed-plans --overwrite` first so the workspace plans exist.
//
//   node --env-file=.env.local scripts/adopt-workspace-plans.js [--business <id>] [--apply] --confirm <projectId>

import { parseArgs, connect } from "./_cli.js";
import { assignPlan } from "../netlify/functions/_lib/provisioning.js";
import { PLAN_SEED, planWorkspace } from "../shared/plans.seed.js";

const PREFIX = { "household-payroll": "household", "baby-expense": "baby", "bridal-expense": "bridal" };
export function targetPlan(workspaceTemplateId, currentPlanId) {
  const prefix = PREFIX[workspaceTemplateId];
  if (!prefix) return null;
  return `${prefix}-${currentPlanId === "starter" ? "basic" : "plus"}`;
}

const args = parseArgs();
const { db, admin } = await connect(args);
const apply = args.apply === true;
const docs = args.business ? [await db.collection("businesses").doc(args.business).get()] : (await db.collection("businesses").get()).docs;
console.log(apply ? "APPLY: writing changes" : "DRY RUN: nothing is written (add --apply)");
for (const snap of docs) {
  if (!snap.exists) continue;
  const b = snap.data();
  const planId = b.subscription?.planId;
  const plan = (await db.collection("plans").doc(planId).get()).data();
  const fits = plan && planWorkspace(plan) === b.workspaceTemplateId;
  if (fits) {
    // Backfill the price snapshot MRR and invoices use (no entitlement change).
    const missing = !Number.isSafeInteger(b.subscription?.monthlyAmount);
    if (missing && apply) await snap.ref.update({ "subscription.monthlyAmount": plan.pricing.monthly });
    console.log(`- ${snap.id} (${b.workspaceTemplateId}): ${planId} already fits${missing ? ` · monthly amount ₱${plan.pricing.monthly / 100}${apply ? " recorded ✔" : " to record"}` : ""}`);
    continue;
  }
  const to = targetPlan(b.workspaceTemplateId, planId);
  if (!to || !PLAN_SEED[to]) {
    console.log(`- ${snap.id} (${b.workspaceTemplateId}): ${planId} doesn't fit and has no mapping, SKIPPED`);
    continue;
  }
  if (!apply) {
    console.log(`- ${snap.id} (${b.workspaceTemplateId}): ${planId} -> ${to} (₱${PLAN_SEED[to].pricing.monthly / 100}/mo)`);
    continue;
  }
  const r = await assignPlan({ db, admin, businessId: snap.id, planId: to, actor: "release-18.6", reason: "Phase 18.6: plans are per workspace" });
  console.log(`- ${snap.id} (${b.workspaceTemplateId}): ${planId} -> ${r.planId} ✔${r.warnings?.length ? ` warnings: ${r.warnings.join("; ")}` : ""}`);
}
process.exit(0);
