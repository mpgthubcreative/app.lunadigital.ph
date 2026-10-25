// Luna setup service (2026-10-25, Distributor): bring a new customer's
// Excel file into their business at a clean cutover date. Run by Luna,
// never exposed to customers (netlify/functions/_lib/setup-import.js).
//
// The workbook has up to three sheets (any order; column names are matched
// like the Imports screen, e.g. "Item code" = SKU, "SRP" = selling price):
//   Products        SKU · Name · Unit · Selling price · Cost per unit · Opening stock
//   Customers       Name · Phone · Address · Opening balance
//   Special prices  Customer · SKU · Special price
//
// 1. Preview (read-only; prints the reconciliation, every invalid row, warnings):
//   node --env-file=.env.local scripts/setup-import.js --business <id> --file <xlsx> --cutover 2026-11-01
// 2. Commit (only when the preview has no invalid rows; safe to run again):
//   node --env-file=.env.local scripts/setup-import.js --business <id> --file <xlsx> --cutover 2026-11-01 --commit --confirm <projectId>
// Transactions before the cutover stay in the old spreadsheet; Luna is the
// source of truth from the cutover on (no historical orders are imported).

import { readFileSync } from "node:fs";
import { parseArgs, requireArgs, connect, connectReadOnly, fail } from "./_cli.js";
import { readXlsx } from "../shared/xlsx.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { mapSheet, planSetupImport, commitSetupImport } from "../netlify/functions/_lib/setup-import.js";

const args = parseArgs();
requireArgs(args, ["business", "file", "cutover"]);
const commit = args.commit === true;
const { db, admin } = commit ? await connect(args) : await connectReadOnly();

const bytes = readFileSync(args.file);
const sheet = (names) => {
  for (const name of names) {
    try {
      return readXlsx(bytes, { sheet: name }).rows;
    } catch {
      /* not this name */
    }
  }
  return [];
};
const mapped = {
  products: mapSheet(sheet(["Products", "Product", "Items", "Inventory"]), "products"),
  customers: mapSheet(sheet(["Customers", "Customer", "Buyers", "Dealers"]), "customers"),
  prices: mapSheet(sheet(["Special prices", "Special Prices", "Customer prices", "Prices"]), "prices"),
};
const input = { cutoverDay: String(args.cutover), products: mapped.products.rows, customers: mapped.customers.rows, prices: mapped.prices.rows };

const biz = await db.collection("businesses").doc(String(args.business)).get();
if (!biz.exists) fail(`Business ${args.business} not found.`);
if (biz.data().workspaceTemplateId !== "distributor") fail(`${args.business} isn't a Distributor business.`);
const tenant = tenantDb(db, biz.id);
const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const show = (s) => [
  `  Products: ${s.products} (${s.productsNew} new)`,
  `  Customers: ${s.customers} (${s.customersNew} new)`,
  `  Opening-stock records: ${s.openingStockRecords} (value ${peso(s.openingStockValue)})`,
  `  Customers with special pricing: ${s.customersWithSpecialPrices} (${s.specialPrices} prices)`,
  `  Customers with opening balances: ${s.customersWithOpeningBalances}`,
  `  Opening receivables: ${peso(s.openingReceivables)}`,
  `  Rows with errors: ${s.rowsWithErrors}`,
].join("\n");

console.log(`\nBusiness: ${biz.data().name} (${biz.id}) · cutover ${input.cutoverDay}`);
for (const [k, m] of Object.entries(mapped)) if (m.unknownColumns.length) console.log(`  Note: ${k} sheet columns not used: ${m.unknownColumns.join(", ")}`);
if (!commit) {
  const plan = await planSetupImport({ tenant, input });
  console.log(`\nPREVIEW (nothing written)\n${show(plan.summary)}`);
  for (const e of plan.errors) console.log(`  ✗ ${e.message}`);
  for (const w of plan.warnings) console.log(`  ! ${w.message}`);
  console.log(plan.errors.length ? "\nFix the rows above, then preview again." : "\nReady: re-run with --commit --confirm <projectId>.");
  process.exit(0);
}
const out = await commitSetupImport({ db, tenant, FieldValue: admin.firestore.FieldValue, businessId: biz.id, input, actor: { uid: "setup-import", name: typeof args.actor === "string" ? args.actor : "Luna setup", email: "" } });
if (!out.committed) {
  console.log(`\nNOT COMMITTED: ${out.plan.errors.length} invalid rows`);
  for (const e of out.plan.errors) console.log(`  ✗ ${e.message}`);
  process.exit(1);
}
console.log(`\nCOMMITTED\n${JSON.stringify(out.result, null, 1)}\n\nReconciliation (expected → actual): ${out.reconciliation.matches ? "MATCHES" : "MISMATCH"}`);
for (const [k, v] of Object.entries(out.reconciliation.expected)) console.log(`  ${k}: ${v} → ${out.reconciliation.actual[k]}`);
process.exit(out.reconciliation.matches ? 0 : 2);
