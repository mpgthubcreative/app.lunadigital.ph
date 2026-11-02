// One-off repair (2026-11-02): rebuild budgets/current.spentByCategory from
// the active expenses (netlify/functions/_lib/category-totals.js). Household,
// Baby and Bridal. Dry run by default (read-only); --apply writes, one
// transaction per business. Expenses, Total spent and everything else are
// never changed.
//   node --env-file=.env.local scripts/recompute-category-totals.js (--business <id> | --all)
//   node --env-file=.env.local scripts/recompute-category-totals.js (--business <id> | --all) --apply --confirm <projectId>
import { parseArgs, connect, connectReadOnly, fail } from "./_cli.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { recomputeCategoryTotals } from "../netlify/functions/_lib/category-totals.js";

const WORKSPACES = ["household-payroll", "baby-expense", "bridal-expense"];
const args = parseArgs();
if (!args.business === !args.all) fail("Pass exactly one of --business <id> or --all (Household, Baby and Bridal workspaces).");
const apply = args.apply === true;
const { db, admin } = apply ? await connect(args) : await connectReadOnly();
const FieldValue = admin?.firestore?.FieldValue ?? null;
const ids = args.all ? (await db.collection("businesses").where("workspaceTemplateId", "in", WORKSPACES).get()).docs.map((d) => d.id) : [String(args.business)];
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
const split = (m) => Object.entries(m).filter(([, v]) => v).map(([k, v]) => `${k} ${peso(v)}`).join(", ") || "(empty)";
for (const businessId of ids) {
  const r = await recomputeCategoryTotals({ db, tenant: tenantDb(db, businessId), FieldValue, apply, actor: { uid: "script", name: "recompute-category-totals" } });
  if (!r.exists) {
    console.log(`${businessId}: no budget yet — skipped`);
    continue;
  }
  const state = !r.changed ? "unchanged" : r.applied ? "updated" : "would update";
  console.log(`${businessId}: ${state} (${r.expenses} active expenses; Total spent ${peso(r.spentStored)}${r.spentStored !== r.spentFromExpenses ? ` ≠ expenses ${peso(r.spentFromExpenses)} — NOT changed, check by hand` : ""})`);
  if (r.changed) console.log(`  before: ${split(r.before)}\n  after:  ${split(r.after)}`);
}
process.exit(0);
