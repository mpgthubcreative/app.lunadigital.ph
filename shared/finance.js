// Financial definitions: the ONE place Luna derives profitability figures.
// UI, reports and server code call these; nobody re-types a formula.
//
//   Net Sales                  = Gross Sales - Discounts - Returns/Refunds
//   Gross Profit               = Net Sales - Cost of Goods Sold
//   Estimated Operating Profit = Gross Profit - Operating Expenses
//
// All amounts are integer centavos. Only components are stored (in
// financialMetrics documents); derived figures are computed here so they
// can never disagree with their inputs. A figure is null ("not known")
// when any input is missing or not an integer. It is never guessed as 0.
//
// When a sale counts (order created, confirmed, fulfilled or paid) is decided
// with the Orders lifecycle (Phase 7); this file only defines the arithmetic.
//
// "Estimated Operating Profit" is deliberately not called net income or net
// profit: Luna only knows what is recorded in Luna.

export const ESTIMATED_PROFIT_NOTE =
  "Estimated from the sales, costs and expenses recorded in Luna. It may exclude taxes, depreciation, financing costs and other accounting adjustments, so it isn't your accounting net income.";

export const FINANCIAL_FIGURES = Object.freeze({
  grossSales: { label: "Gross sales" },
  discounts: { label: "Discounts" },
  returns: { label: "Returns / refunds" },
  netSales: { label: "Net sales" },
  cogs: { label: "Cost of goods sold" },
  grossProfit: { label: "Gross profit" },
  operatingExpenses: { label: "Operating expenses" },
  estimatedOperatingProfit: { label: "Estimated operating profit", note: ESTIMATED_PROFIT_NOTE },
  paymentsReceived: { label: "Payments received" },
  receivablesOutstanding: { label: "Unpaid balance" },
});

const amount = (value) => (Number.isSafeInteger(value) ? value : null);
const minus = (a, ...rest) => (a === null || rest.some((v) => v === null) ? null : rest.reduce((acc, v) => acc - v, a));

export function netSales({ grossSales, discounts, returns }) {
  return minus(amount(grossSales), amount(discounts), amount(returns));
}

export function grossProfit(components) {
  return minus(netSales(components), amount(components.cogs));
}

export function estimatedOperatingProfit(components) {
  return minus(grossProfit(components), amount(components.operatingExpenses));
}

// Gross margin as a percentage of net sales, one decimal (e.g. 40.0).
// null when either input is unknown or there are no net sales.
export function grossMarginPct(summary) {
  if (!summary || summary.grossProfit === null || summary.netSales === null || !summary.netSales) return null;
  return Math.round((summary.grossProfit * 1000) / summary.netSales) / 10;
}

// Every figure from one (or a summed) set of financial counters + gauges.
// Absent input -> every figure that needs it is null.
export function financialSummary(counters = {}, gauges = {}) {
  const c = counters || {};
  return {
    grossSales: amount(c.grossSales),
    discounts: amount(c.discounts),
    returns: amount(c.returns),
    netSales: netSales(c),
    cogs: amount(c.cogs),
    grossProfit: grossProfit(c),
    operatingExpenses: amount(c.operatingExpenses),
    estimatedOperatingProfit: estimatedOperatingProfit(c),
    paymentsReceived: amount(c.paymentsReceived),
    receivablesOutstanding: amount((gauges || {}).receivablesOutstanding),
  };
}

// Owner pilot 2026-10-19: current product pricing, NOT sales history.
// Per active SKU: Profit / Unit = current selling price − current unit
// cost (COGS); Net Margin % = Profit / Unit ÷ price × 100. Overall SKU
// Margin % = Σ unit profits ÷ Σ selling prices of the SKUs that have both a
// price and a cost (percentages are never added together, and quantities
// sold never weigh in). products: [{ productId, name, sku, price, unitCost }]
// with centavos; unitCost null = no cost set (shown, left out of overall).
const pct1 = (part, whole) => Math.round((part * 1000) / whole) / 10;
export function skuMargins(products = []) {
  let price = 0;
  let profit = 0;
  const rows = products.map((p) => {
    const priced = Number.isSafeInteger(p.price) && p.price > 0;
    const costed = Number.isSafeInteger(p.unitCost);
    const unitProfit = priced && costed ? p.price - p.unitCost : null;
    if (unitProfit !== null) {
      price += p.price;
      profit += unitProfit;
    }
    return { productId: p.productId, name: p.name ?? null, sku: p.sku ?? null, price: Number.isSafeInteger(p.price) ? p.price : null, unitCost: costed ? p.unitCost : null, unitProfit, marginPct: unitProfit === null ? null : pct1(unitProfit, p.price) };
  });
  return { rows, overall: { included: rows.filter((r) => r.unitProfit !== null).length, priceTotal: price, unitProfitTotal: profit, marginPct: price > 0 ? pct1(profit, price) : null } };
}
