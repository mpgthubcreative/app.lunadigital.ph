// Setup-service migration (2026-10-25, Distributor): "Send us your Excel
// file, we set Luna up for you." Run by Luna (scripts/setup-import.js),
// never by customers. One business at a time, at a clean cutover date:
//
//   Products       SKU · Name · Unit · Selling price · Cost per unit · Opening stock
//   Customers      Name · Phone · Address · Opening balance
//   Special prices Customer · SKU · Special price
//
// Upload → Map (header synonyms, shared/imports.js) → Validate (the SAME
// validators as the screens) → Preview (planSetupImport: what would be
// created, skipped, refused; the reconciliation totals) → Commit
// (commitSetupImport) → Reconcile (read back from the database).
//
// Safety: existing records are never overwritten (a SKU / customer already
// in Luna is skipped and only linked); every write is keyed on the
// business + the row's natural key (SKU, customer name), so a retried or
// repeated commit changes nothing: no duplicate products, customers,
// special prices, opening stock or opening balances. Opening stock is an
// "opening" movement (not a receipt, not a purchase) carrying the cost
// basis; an opening balance is an opening-balance record (./opening-balances.js),
// never an order or a sale. Historical orders are not imported.

import { createHash } from "node:crypto";
import { validateProductInput, InventoryError } from "../../../shared/inventory.js";
import { validateCustomerInput, CustomerError } from "../../../shared/customers.js";
import { parseQuantity, parseCentavos, isUnit, UNITS } from "../../../shared/quantity.js";
import { isDayId } from "../../../shared/metrics.js";
import { IMPORT_TYPES } from "../../../shared/imports.js";
import { createProduct, recordMovement } from "./inventory.js";
import { createCustomer, setCustomerPrice } from "./customers.js";
import { createOpeningBalance, openingBalanceIdFor } from "./opening-balances.js";

const MAX_ROWS = 5000;
const hash = (v) => createHash("sha256").update(String(v)).digest("hex");
const nameKey = (v) => String(v ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
// Request keys for the keyed writes (16-64 chars).
export const setupKey = (businessId, ...parts) => `setup-${hash([businessId, ...parts].join("|")).slice(0, 40)}`;

// ---- Map: a sheet's header row → Luna fields ----
const syn = (fieldsOf) => Object.fromEntries(fieldsOf.flatMap(([key, names]) => names.map((n) => [nameKey(n), key])));
const PRODUCT_HEADERS = syn([
  ...IMPORT_TYPES.products.fields.map((f) => [f.key, [f.key, f.label, ...f.synonyms]]),
  ["cost", ["cost", "cost per unit", "unit cost", "cost price", "puhunan", "capital"]],
  ["openingStock", ["opening stock", "stock", "stock on hand", "on hand", "quantity", "qty", "beginning inventory", "inventory"]],
]);
const CUSTOMER_HEADERS = syn([
  ...IMPORT_TYPES.customers.fields.map((f) => [f.key, [f.key, f.label, ...f.synonyms]]),
  ["openingBalance", ["opening balance", "balance", "outstanding", "outstanding balance", "receivable", "utang", "amount owed", "owes"]],
]);
const PRICE_HEADERS = syn([
  ["customer", ["customer", "customer name", "store", "buyer", "name"]],
  ["sku", ["sku", "item code", "code", "product code"]],
  ["price", ["price", "special price", "customer price", "agreed price"]],
]);
// rows: arrays (first = header). → [{ row (1-based sheet row), values: { field: text } }]
export function mapSheet(rows, kind) {
  const headers = { products: PRODUCT_HEADERS, customers: CUSTOMER_HEADERS, prices: PRICE_HEADERS }[kind];
  if (!Array.isArray(rows) || !rows.length) return { rows: [], unknownColumns: [] };
  const [head, ...body] = rows;
  const cols = head.map((h) => headers[nameKey(h)] ?? null);
  const unknownColumns = head.filter((h, i) => String(h ?? "").trim() && !cols[i]).map(String);
  return {
    unknownColumns,
    rows: body
      .map((cells, i) => ({ row: i + 2, values: Object.fromEntries(cols.flatMap((k, j) => (k && cells[j] !== undefined && cells[j] !== null && String(cells[j]).trim() !== "" ? [[k, String(cells[j]).trim()]] : []))) }))
      .filter((r) => Object.keys(r.values).length),
  };
}

// ---- Validate + Preview ----
const money = (text) => parseCentavos(String(text).replace(/^₱\s*/, "").replace(/^PHP\s*/i, ""));
const unitOf = (text) => {
  const t = nameKey(text || "pcs");
  if (isUnit(t)) return t;
  return Object.entries(UNITS).find(([, u]) => nameKey(u.label) === t)?.[0] ?? t;
};
const err = (list, sheet, row, message) => list.push({ sheet, row, message: `${sheet} row ${row}: ${message}` });

// input: { cutoverDay, products: mapped rows, customers: mapped rows, prices: mapped rows }
// existing: what's already in the business ({ skus: Map(sku → { id, hasMovements }), customers: Map(nameKey → { id }) }).
export function planFromRows(input, existing = { skus: new Map(), customers: new Map() }) {
  const errors = [];
  const warnings = [];
  if (!isDayId(input?.cutoverDay)) err(errors, "Setup", 1, "Choose the cutover date (YYYY-MM-DD)");
  const total = (input.products?.length || 0) + (input.customers?.length || 0) + (input.prices?.length || 0);
  if (total > MAX_ROWS) err(errors, "Setup", 1, `Too many rows (${total}); up to ${MAX_ROWS} per import`);

  const products = [];
  const seenSku = new Map();
  for (const { row, values: v } of input.products || []) {
    const where = (m) => err(errors, "Products", row, m);
    if (!v.name) {
      where("Product name is missing.");
      continue;
    }
    if (!v.sku) {
      where(`SKU is missing for ${v.name}.`);
      continue;
    }
    let product;
    try {
      product = validateProductInput({ sku: v.sku, name: v.name, unit: unitOf(v.unit), sellingPrice: v.sellingPrice === undefined ? NaN : money(v.sellingPrice), reorderLevel: v.reorderLevel ? parseQuantity(v.reorderLevel, unitOf(v.unit)) : 0, ...(v.category ? { category: v.category } : {}) });
    } catch (e) {
      where(e instanceof InventoryError ? e.message : v.sellingPrice === undefined ? "Selling price is missing." : `Selling price "${v.sellingPrice}" isn't an amount.`);
      continue;
    }
    if (seenSku.has(product.sku)) {
      where(`SKU ${product.sku} is also on row ${seenSku.get(product.sku)} (each SKU once).`);
      continue;
    }
    seenSku.set(product.sku, row);
    let openingStock = null;
    let cost = null;
    try {
      if (v.openingStock !== undefined) openingStock = parseQuantity(v.openingStock, product.unit);
      if (v.cost !== undefined) cost = money(v.cost);
    } catch (e) {
      where(v.openingStock !== undefined && openingStock === null ? `Opening stock "${v.openingStock}" isn't a quantity in ${UNITS[product.unit].label}.` : `Cost per unit "${v.cost}" isn't an amount.`);
      continue;
    }
    if (openingStock && cost === null) {
      where(`Cost per unit is missing for ${product.name} (needed with opening stock, for profit / COGS).`);
      continue;
    }
    const prior = existing.skus.get(product.sku) || null;
    if (prior) warnings.push({ sheet: "Products", row, message: `Products row ${row}: SKU ${product.sku} is already in Luna — its details are kept as they are (never overwritten)${!openingStock ? "" : prior.hasMovements && !prior.fromSetup ? "; it already has stock movements, so its stock is NOT changed" : "; its opening stock is recorded"}.` });
    products.push({ row, product, openingStock: openingStock || 0, cost: cost ?? 0, existingId: prior?.id ?? null, stockLocked: Boolean(prior && prior.hasMovements && !prior.fromSetup) });
  }

  const customers = [];
  const seenName = new Map();
  for (const { row, values: v } of input.customers || []) {
    const where = (m) => err(errors, "Customers", row, m);
    if (!v.name) {
      where("Customer name is missing.");
      continue;
    }
    let customer;
    try {
      customer = validateCustomerInput(Object.fromEntries(Object.entries({ name: v.name, company: v.company, phone: v.phone, email: v.email, address: v.address, notes: v.notes }).filter(([, x]) => x !== undefined)));
    } catch (e) {
      where(e instanceof CustomerError ? e.message : "Invalid customer.");
      continue;
    }
    const k = nameKey(customer.name);
    if (seenName.has(k)) {
      where(`${customer.name} is also on row ${seenName.get(k)} (each customer once).`);
      continue;
    }
    seenName.set(k, row);
    let openingBalance = 0;
    if (v.openingBalance !== undefined) {
      try {
        openingBalance = money(v.openingBalance);
      } catch {
        where(`Opening balance "${v.openingBalance}" isn't an amount.`);
        continue;
      }
    }
    const prior = existing.customers.get(k) || null;
    if (prior) warnings.push({ sheet: "Customers", row, message: `Customers row ${row}: ${customer.name} is already in Luna — kept as it is (never overwritten).` });
    customers.push({ row, key: k, customer, openingBalance, existingId: prior?.id ?? null });
  }

  const prices = [];
  const seenPrice = new Set();
  const skuKnown = (sku) => seenSku.has(sku) || existing.skus.has(sku);
  const custKnown = (k) => seenName.has(k) || existing.customers.has(k);
  for (const { row, values: v } of input.prices || []) {
    const where = (m) => err(errors, "Special prices", row, m);
    const sku = String(v.sku ?? "").trim().toUpperCase();
    const k = nameKey(v.customer);
    if (!k) {
      where("Customer is missing.");
      continue;
    }
    if (!sku) {
      where("SKU is missing.");
      continue;
    }
    if (!custKnown(k)) {
      where(`Customer "${v.customer}" isn't on the Customers sheet or in Luna.`);
      continue;
    }
    if (!skuKnown(sku)) {
      where(`SKU ${sku} isn't on the Products sheet or in Luna.`);
      continue;
    }
    let price;
    try {
      price = money(v.price);
    } catch {
      where(v.price === undefined ? "Special price is missing." : `Special price "${v.price}" isn't an amount.`);
      continue;
    }
    if (price < 1) {
      where("Special price must be more than ₱0.");
      continue;
    }
    if (seenPrice.has(`${k}|${sku}`)) {
      where(`${v.customer} already has a special price for ${sku} above.`);
      continue;
    }
    seenPrice.add(`${k}|${sku}`);
    prices.push({ row, customerKey: k, sku, price });
  }

  const withStock = products.filter((p) => p.openingStock > 0 && !p.stockLocked);
  const summary = {
    cutoverDay: input?.cutoverDay ?? null,
    products: products.length,
    productsNew: products.filter((p) => !p.existingId).length,
    customers: customers.length,
    customersNew: customers.filter((c) => !c.existingId).length,
    openingStockRecords: withStock.length,
    openingStockValue: withStock.reduce((t, p) => t + Math.round((p.openingStock * p.cost) / 1000), 0),
    customersWithSpecialPrices: new Set(prices.map((p) => p.customerKey)).size,
    specialPrices: prices.length,
    customersWithOpeningBalances: customers.filter((c) => c.openingBalance > 0).length,
    openingReceivables: customers.reduce((t, c) => t + c.openingBalance, 0),
    rowsWithErrors: errors.length,
  };
  return { summary, errors, warnings, products, customers, prices };
}

// What's already in the business (for the plan).
async function existingOf(tenant) {
  const [products, customers, setupMoves] = await Promise.all([tenant.collection("products").get(), tenant.collection("customers").get(), tenant.collection("idempotencyKeys").where("kind", "==", "stock").get()]);
  const fromSetup = new Set(setupMoves.docs.filter((d) => d.id.startsWith("setup-")).map((d) => d.data().productId));
  return {
    skus: new Map(products.docs.map((d) => [d.data().sku, { id: d.id, hasMovements: (d.data().movementCount || 0) > 0, fromSetup: fromSetup.has(d.id) }])),
    customers: new Map(customers.docs.map((d) => [nameKey(d.data().name), { id: d.id }])),
  };
}
export async function planSetupImport({ tenant, input }) {
  return planFromRows(input, await existingOf(tenant));
}

// ---- Commit (Luna operator) + Reconcile ----
export async function commitSetupImport({ db, tenant, FieldValue, businessId, input, actor, allowWarnings = true }) {
  const plan = await planSetupImport({ tenant, input });
  if (plan.errors.length) return { committed: false, plan };
  if (!allowWarnings && plan.warnings.length) return { committed: false, plan };
  const result = { productsCreated: 0, productsKept: 0, openingStockRecorded: 0, openingStockReplayed: 0, customersCreated: 0, customersKept: 0, specialPricesSet: 0, specialPricesUnchanged: 0, openingBalancesCreated: 0, openingBalancesReplayed: 0 };
  const productIds = new Map();
  for (const p of plan.products) {
    let id = p.existingId;
    if (!id) {
      try {
        id = (await createProduct({ db, tenant, FieldValue, actor, input: p.product })).productId;
        result.productsCreated += 1;
      } catch (e) {
        // Created by an earlier, interrupted run of this same import: use it.
        if (e?.code !== "duplicate-sku") throw e;
        id = (await tenant.collection("products").where("sku", "==", p.product.sku).limit(1).get()).docs[0].id;
        result.productsKept += 1;
      }
    } else result.productsKept += 1;
    productIds.set(p.product.sku, id);
    if (p.openingStock > 0 && !p.stockLocked) {
      const r = await recordMovement({ db, tenant, FieldValue, productId: id, actor, idempotencyKey: setupKey(businessId, "opening", p.product.sku), movement: { type: "opening", quantity: p.openingStock, unitCost: p.cost, reason: "opening_balance", note: `Opening stock at cutover ${input.cutoverDay}`, referenceType: "manual", referenceId: "setup-import" } });
      if (r.replayed) result.openingStockReplayed += 1;
      else result.openingStockRecorded += 1;
    }
  }
  const customerIds = new Map();
  for (const c of plan.customers) {
    let id = c.existingId;
    if (!id) {
      id = (await createCustomer({ db, tenant, FieldValue, actor, input: c.customer })).customerId;
      result.customersCreated += 1;
    } else result.customersKept += 1;
    customerIds.set(c.key, id);
    if (c.openingBalance > 0) {
      const r = await createOpeningBalance({ db, tenant, FieldValue, customerId: id, amount: c.openingBalance, effectiveDay: input.cutoverDay, note: "Opening balance (setup import)", source: "setup_import", actor, idempotencyKey: setupKey(businessId, "opening-balance", c.key, input.cutoverDay) });
      if (r.replayed) result.openingBalancesReplayed += 1;
      else result.openingBalancesCreated += 1;
    }
  }
  const existing = await existingOf(tenant);
  for (const p of plan.prices) {
    const customerId = customerIds.get(p.customerKey) ?? existing.customers.get(p.customerKey)?.id;
    const productId = productIds.get(p.sku) ?? existing.skus.get(p.sku)?.id;
    const r = await setCustomerPrice({ db, tenant, FieldValue, customerId, productId, price: p.price, actor, source: "setup_import" });
    if (r.unchanged) result.specialPricesUnchanged += 1;
    else result.specialPricesSet += 1;
  }
  const reconciliation = await reconcileSetupImport({ tenant, businessId, plan, input });
  await tenant.collection("setupImports").doc(setupKey(businessId, "job", input.cutoverDay, hash(JSON.stringify(plan.summary)))).set({ schemaVersion: 1, cutoverDay: input.cutoverDay, summary: plan.summary, result, reconciliation, warnings: plan.warnings.map((w) => w.message), by: actor, at: FieldValue.serverTimestamp() });
  return { committed: true, plan, result, reconciliation };
}

// Read back from the database: what this import's rows now are in Luna.
export async function reconcileSetupImport({ tenant, businessId, plan, input }) {
  const products = await tenant.collection("products").get();
  const bySku = new Map(products.docs.map((d) => [d.data().sku, { id: d.id, ...d.data() }]));
  const customers = await tenant.collection("customers").get();
  const byName = new Map(customers.docs.map((d) => [nameKey(d.data().name), { id: d.id, ...d.data() }]));
  let openingStockRecords = 0;
  let openingStockValue = 0;
  for (const p of plan.products.filter((x) => x.openingStock > 0 && !x.stockLocked)) {
    const k = await tenant.doc("idempotencyKeys", setupKey(businessId, "opening", p.product.sku)).get();
    if (k.exists) {
      openingStockRecords += 1;
      openingStockValue += Math.round((p.openingStock * p.cost) / 1000);
    }
  }
  let openingReceivables = 0;
  let customersWithOpeningBalances = 0;
  for (const c of plan.customers.filter((x) => x.openingBalance > 0)) {
    const ob = await tenant.doc("openingBalances", openingBalanceIdFor(setupKey(businessId, "opening-balance", c.key, input.cutoverDay))).get();
    if (ob.exists && ob.data().status !== "voided") {
      openingReceivables += ob.data().amount;
      customersWithOpeningBalances += 1;
    }
  }
  let specialPrices = 0;
  const priceCustomers = new Set();
  for (const p of plan.prices) {
    const cu = byName.get(p.customerKey);
    const pr = bySku.get(p.sku);
    const doc = cu && pr ? await tenant.doc("customerPrices", `${cu.id}_${pr.id}`).get() : null;
    if (doc?.exists && doc.data().active !== false && doc.data().price === p.price) {
      specialPrices += 1;
      priceCustomers.add(p.customerKey);
    }
  }
  const actual = {
    products: plan.products.filter((p) => bySku.has(p.product.sku)).length,
    customers: plan.customers.filter((c) => byName.has(c.key)).length,
    openingStockRecords,
    openingStockValue,
    customersWithSpecialPrices: priceCustomers.size,
    specialPrices,
    customersWithOpeningBalances,
    openingReceivables,
  };
  const expected = Object.fromEntries(Object.keys(actual).map((k) => [k, plan.summary[k]]));
  return { expected, actual, matches: Object.keys(actual).every((k) => actual[k] === expected[k]) };
}
