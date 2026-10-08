// Quantities and inventory cost arithmetic. The ONLY place Luna converts,
// adds or multiplies quantities and unit costs.
//
// Quantities: scaled integers with 3 implied decimal places
// (QTY_SCALE = 1000). "12.5 kg" is stored as 12500. Each unit allows at
// most its own decimals (pcs 0, kg 3, ...); see UNITS. Integer adds and
// subtracts are exact, so balances never drift the way 0.1 + 0.2 does.
//
// Money: integer centavos everywhere (prices, purchase costs, values).
//
// Average unit cost: higher precision, so repeated receipts don't
// accumulate rounding drift. Stored as "cost units" = centavos x 10,000
// per ONE whole unit (COST_SCALE = 10000). ₱53.333333 per unit is stored
// as 53333333. Products of quantity x cost can exceed 2^53, so every
// intermediate product and division uses BigInt and rounds half-up (all
// values are non-negative).

export const QTY_DECIMALS = 3;
export const QTY_SCALE = 1000;
export const COST_SCALE = 10000;

// Hard ceilings: comfortably inside Number.MAX_SAFE_INTEGER after scaling.
export const MAX_QUANTITY = 1_000_000_000 * QTY_SCALE; // 1e9 units
export const MAX_CENTAVOS = 10_000_000_000; // ₱100,000,000 per price / unit cost

export const UNITS = Object.freeze({
  pcs: { label: "pcs", decimals: 0 },
  box: { label: "box", decimals: 0 },
  case: { label: "case", decimals: 0 },
  pack: { label: "pack", decimals: 0 },
  dozen: { label: "dozen", decimals: 0 },
  set: { label: "set", decimals: 0 },
  sack: { label: "sack", decimals: 0 },
  bottle: { label: "bottle", decimals: 0 },
  roll: { label: "roll", decimals: 0 },
  kg: { label: "kg", decimals: 3 },
  g: { label: "g", decimals: 0 },
  l: { label: "L", decimals: 3 },
  ml: { label: "mL", decimals: 0 },
  m: { label: "m", decimals: 3 },
});

export const UNIT_IDS = Object.freeze(Object.keys(UNITS));

export class QuantityError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid-quantity";
  }
}

export function isUnit(unit) {
  return Object.prototype.hasOwnProperty.call(UNITS, unit);
}

// Smallest step allowed for a unit, in scaled integers (pcs -> 1000, kg -> 1).
export function unitStep(unit) {
  if (!isUnit(unit)) throw new QuantityError(`Unknown unit ${JSON.stringify(unit)}`);
  return 10 ** (QTY_DECIMALS - UNITS[unit].decimals);
}

// Is `value` a valid stored (scaled) quantity for `unit`? Zero allowed.
export function isQuantity(value, unit) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_QUANTITY && isUnit(unit) && value % unitStep(unit) === 0;
}

// Parses user input ("12.5", "100", 3) to a scaled integer, by its decimal
// text, never by floating-point multiplication. Rejects NaN, Infinity,
// exponents, signs, and more decimals than the unit allows.
export function parseQuantity(input, unit) {
  if (!isUnit(unit)) throw new QuantityError(`Unknown unit ${JSON.stringify(unit)}`);
  const text = typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") : typeof input === "string" ? input.trim() : "";
  const m = /^(\d{1,10})(?:\.(\d+))?$/.exec(text);
  if (!m) throw new QuantityError(`Invalid quantity ${JSON.stringify(input)}`);
  const decimals = m[2] || "";
  if (decimals.length > UNITS[unit].decimals && /[1-9]/.test(decimals.slice(UNITS[unit].decimals))) {
    throw new QuantityError(`${UNITS[unit].label} allows at most ${UNITS[unit].decimals} decimal place(s)`);
  }
  const scaled = Number(m[1]) * QTY_SCALE + Number((decimals + "000").slice(0, QTY_DECIMALS));
  if (scaled > MAX_QUANTITY) throw new QuantityError("Quantity is too large");
  return scaled;
}

// 12500 -> "12.5" (trailing zeros trimmed).
export function formatQuantity(scaled) {
  const whole = Math.trunc(scaled / QTY_SCALE);
  const frac = String(Math.abs(scaled % QTY_SCALE)).padStart(QTY_DECIMALS, "0").replace(/0+$/, "");
  return `${scaled < 0 && whole === 0 ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// Money input "60", "60.5", "1,250.00" -> centavos. Max 2 decimals.
export function parseCentavos(input) {
  const text = typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") : typeof input === "string" ? input.trim().replace(/,/g, "") : "";
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new QuantityError(`Invalid amount ${JSON.stringify(input)}`);
  const centavos = Number(m[1]) * 100 + Number(((m[2] || "") + "00").slice(0, 2));
  if (centavos > MAX_CENTAVOS) throw new QuantityError("Amount is too large");
  return centavos;
}

export function isCentavos(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTAVOS;
}

// ---------- Cost arithmetic (BigInt inside, safe integers outside) ----------

const big = (n) => BigInt(n);

// Round-half-up integer division for non-negative BigInts.
function divRound(numerator, denominator) {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function toSafe(b) {
  if (b > big(Number.MAX_SAFE_INTEGER)) throw new QuantityError("Value out of range");
  return Number(b);
}

// Purchase cost in centavos per whole unit -> cost units.
export function centavosToCostUnits(centavos) {
  return toSafe(big(centavos) * big(COST_SCALE));
}

// Cost units -> centavos per whole unit, rounded half-up (for display).
export function costUnitsToCentavos(costUnits) {
  return toSafe(divRound(big(costUnits), big(COST_SCALE)));
}

// Perpetual moving weighted average after receiving `receivedQty` at
// `unitCostCentavos`:
//   newAvg = (onHand x avg + received x unitCost) / (onHand + received)
// in cost units, rounded half-up. With nothing on hand the new average is
// simply the receipt's cost.
export function movingAverage({ onHand, avgCostUnits, receivedQty, unitCostCentavos }) {
  const total = big(onHand) + big(receivedQty);
  if (total === 0n) throw new QuantityError("Nothing on hand after the receipt");
  const existing = onHand > 0 ? big(onHand) * big(avgCostUnits || 0) : 0n;
  const incoming = big(receivedQty) * big(unitCostCentavos) * big(COST_SCALE);
  return toSafe(divRound(existing + incoming, total));
}

// Cost of `quantity` at `avgCostUnits`, in centavos, rounded half-up. This
// is the amount Phase 7 snapshots onto an order line as COGS, and what a
// loss/damage adjustment removes from inventory value.
export function costOfQuantity(quantity, avgCostUnits) {
  return toSafe(divRound(big(quantity) * big(avgCostUnits || 0), big(QTY_SCALE) * big(COST_SCALE)));
}

// Operational inventory value estimate: on hand x moving average cost.
// Not a statutory / tax valuation.
export function inventoryValue(onHand, avgCostUnits) {
  return costOfQuantity(onHand, avgCostUnits);
}

// Line amount: quantity x unit price per whole unit, in centavos, rounded
// half-up ("2.5 kg @ ₱120.00" -> 30000). The only place a line total is computed.
export function lineAmount(quantity, unitPriceCentavos) {
  return toSafe(divRound(big(quantity) * big(unitPriceCentavos), big(QTY_SCALE)));
}
