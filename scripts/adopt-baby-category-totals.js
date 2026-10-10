// Phase 18.6: Baby and Wedding budgets switch to "Total budget = sum of the
// category budgets". Dry run by default (prints what would change); --apply
// writes. Only businesses on the baby-expense or bridal-expense workspace are
// touched; spending, categories and expenses are never changed.
//
//   node --env-file=.env.local scripts/adopt-baby-category-totals.js [--business <id>] [--apply] --confirm <projectId>

import { parseArgs, connect } from "./_cli.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { adoptCategoryTotal, AUTO_TOTAL_WORKSPACES } from "../netlify/functions/_lib/baby.js";

const args = parseArgs();
const { db, admin } = await connect(args);
const apply = args.apply === true;
const businesses = args.business ? [await db.collection("businesses").doc(args.business).get()] : (await db.collection("businesses").where("workspaceTemplateId", "in", [...AUTO_TOTAL_WORKSPACES]).get()).docs;
console.log(apply ? "APPLY: writing changes" : "DRY RUN: nothing is written (add --apply)");
for (const snap of businesses) {
  if (!snap.exists || !AUTO_TOTAL_WORKSPACES.includes(snap.data().workspaceTemplateId)) {
    console.log(`- ${snap.id}: not a Baby or Wedding workspace, skipped`);
    continue;
  }
  const r = await adoptCategoryTotal({ db, tenant: tenantDb(db, snap.id), FieldValue: admin.firestore.FieldValue, dryRun: !apply });
  console.log(r.changed ? `- ${snap.id}: total ${r.from} -> ${r.to} (${r.categories} categories)${apply ? " ✔" : ""}` : `- ${snap.id}: already on the category total (${r.total})`);
}
