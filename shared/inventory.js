// Products and inventory movements: validation and the PURE movement
// planner. Server code (netlify/functions/_lib/inventory.js) reads the
// current state inside a Firestore transaction, calls planMovement(), and
// writes what it returns. The browser never computes balances or costs.
//
// Balances (scaled quantities, see shared/quantity.js):
//   onHand     physically in stock
//   reserved   promised to open orders (Phase 7)
//   available  = onHand - reserved, never negative
// Low stock = active && available <= reorderLevel (maintained as isLowStock).
//
// Costing: perpetual moving weighted average (cost units, see quantity.js).
//   opening      sets onHand and the average; only before any movement
//   receipt      +onHand, recomputes the average
//   adjustment+  +onHand at the CURRENT average (rate unchanged); refused
//                when the product has no cost basis yet
//   adjustment-  -onHand, average unchanged; can't cut into reserved stock
//   reservation  +reserved only            (Phase 7 orders)
//   release      -reserved only            (Phase 7 cancellations)
//   fulfillment  -onHand and -reserved; returns the cost consumed at the
//                current average: the COGS snapshot for Phase 7
//   correction_in   +onHand at a KNOWN total cost (a fulfilled order corrected
//                   down: units return at their original cost snapshot)
//   correction_out  -onHand from unreserved stock at the current average
//                   (a fulfilled order corrected up); returns cost consumed
// No movement may oversell: there is no backorder policy yet.

import {
  UNITS,
  isUnit,
  isQuantity,
  isCentavos,
  movingAverage,
  movingAverageByValue,
  costOfQuantity,
  inventoryValue,
  centavosToCostUnits,
} from "./quantity.js";

export const PRODUCT_SCHEMA_VERSION = 1;
export const PRODUCT_STATUSES = Object.freeze(["active", "inactive"]);

export const MOVEMENT_TYPES = Object.freeze({
  opening: { label: "Starting stock", sign: +1, needsCost: true },
  receipt: { label: "Received", sign: +1, needsCost: true },
  adjustment_increase: { label: "Adjustment", sign: +1, needsCost: false },
  adjustment_decrease: { label: "Adjustment", sign: -1, needsCost: false },
  reservation: { label: "Set aside for order", sign: 0, needsCost: false },
  release: { label: "Released from order", sign: 0, needsCost: false },
  fulfillment: { label: "Fulfilled", sign: -1, needsCost: false },
  correction_in: { label: "Order correction", sign: +1, needsCost: false },
  correction_out: { label: "Order correction", sign: -1, needsCost: false },
});

// Movements a browser may request through /api/inventory. Reservation,
// release and fulfillment are only reachable from server code (Phase 7).
export const MANUAL_MOVEMENTS = Object.freeze(["opening", "receipt", "adjustment_increase", "adjustment_decrease"]);

// Reasons for manual adjustments (free text detail is required as well).
export const ADJUSTMENT_REASONS = Object.freeze({
  count_correction: "Stock count correction",
  damaged: "Damaged",
  expired: "Expired",
  lost: "Lost / missing",
  found: "Found",
  sample: "Sample / internal use",
  other: "Other",
});

export class InventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- Product master data ----------

const SKU = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;

// SKUs compare case-insensitively within a business: "ab-1" and "AB-1" are
// the same SKU. The normalized form is the uniqueness key.
export function normalizeSku(input) {
  return typeof input === "string" ? input.trim().toUpperCase() : "";
}

export function isValidSku(sku) {
  return SKU.test(sku) && !/\.\.|^\.|\.$/.test(sku);
}

const PRODUCT_ID = /^[A-Za-z0-9]{8,40}$/;
export function isValidProductId(value) {
  return typeof value === "string" && PRODUCT_ID.test(value);
}

function cleanText(value, { field, max, required }) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value === undefined || value === null ? "" : null;
  if (text === null) throw new InventoryError("invalid-input", `${field} must be text`);
  if (required && !text) throw new InventoryError("invalid-input", `${field} is required`);
  if (text.length > max) throw new InventoryError("invalid-input", `${field} is too long (max ${max})`);
  return text;
}

// Validates create/update input. `existing` (for updates) supplies the
// unit when the update doesn't change it. Quantities and money arrive as
// integers (scaled / centavos); the UI converts with shared/quantity.js.
// Returns only the master-data fields; balances and costs are never accepted.
const MASTER_FIELDS = ["sku", "name", "category", "unit", "sellingPrice", "reorderLevel"];

export function validateProductInput(input, { existing = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InventoryError("invalid-input", "Invalid product");
  for (const key of Object.keys(input)) {
    if (!MASTER_FIELDS.includes(key)) throw new InventoryError("invalid-input", `Field ${key} can't be set here`);
  }
  const creating = !existing;
  const out = {};

  if (creating || "sku" in input) {
    const sku = normalizeSku(input.sku);
    if (!isValidSku(sku)) throw new InventoryError("invalid-sku", "SKU must be 1-40 letters, digits, '.', '-' or '_'");
    out.sku = sku;
  }
  if (creating || "name" in input) out.name = cleanText(input.name, { field: "Name", max: 120, required: true });
  if (creating || "category" in input) out.category = cleanText(input.category, { field: "Category", max: 60, required: false });
  if (creating || "unit" in input) {
    if (!isUnit(input.unit)) throw new InventoryError("invalid-unit", `Unit must be one of ${Object.keys(UNITS).join(", ")}`);
    if (existing && input.unit !== existing.unit && (existing.movementCount || 0) > 0) {
      throw new InventoryError("unit-locked", "The unit can't change once the product has stock movements");
    }
    out.unit = input.unit;
  }
  const unit = out.unit ?? existing?.unit;
  if (creating || "sellingPrice" in input) {
    if (!isCentavos(input.sellingPrice)) throw new InventoryError("invalid-price", "Selling price must be a whole number of centavos, 0 or more");
    out.sellingPrice = input.sellingPrice;
  }
  if (creating || "reorderLevel" in input || "unit" in out) {
    const level = "reorderLevel" in input ? input.reorderLevel : existing?.reorderLevel ?? 0;
    if (!isQuantity(level, unit)) throw new InventoryError("invalid-quantity", `Reorder level isn't a valid ${UNITS[unit].label} quantity`);
    out.reorderLevel = level;
  }
  return out;
}

export function isLowStock({ status, available, reorderLevel }) {
  return status === "active" && available <= reorderLevel;
}

// ---------- Movements ----------

// state: { status, unit, onHand, reserved, reorderLevel, movementCount,
//          avgCostUnits (number | null: no cost basis yet) }
// movement: { type, quantity (scaled, > 0), unitCost? (centavos), reason?, note?,
//             referenceType?, referenceId? }
// Returns { next, delta, costConsumed, valueBefore, valueAfter } or throws.
export function planMovement(state, movement) {
  const def = MOVEMENT_TYPES[movement && movement.type];
  if (!def) throw new InventoryError("invalid-movement", `Unknown movement type ${JSON.stringify(movement && movement.type)}`);
  const { quantity } = movement;
  if (!isQuantity(quantity, state.unit) || quantity === 0) {
    throw new InventoryError("invalid-quantity", `Quantity must be more than 0 and valid for ${UNITS[state.unit]?.label ?? "this unit"}`);
  }
  if (def.needsCost && !isCentavos(movement.unitCost)) throw new InventoryError("invalid-cost", "Unit cost must be a whole number of centavos, 0 or more");

  const onHand = state.onHand;
  const reserved = state.reserved;
  let nextOnHand = onHand;
  let nextReserved = reserved;
  let nextAvg = state.avgCostUnits;
  let costConsumed = 0;

  switch (movement.type) {
    case "opening":
      if ((state.movementCount || 0) > 0 || onHand !== 0 || reserved !== 0) {
        throw new InventoryError("opening-not-allowed", "An opening balance can only be recorded before any other stock movement");
      }
      nextOnHand = quantity;
      nextAvg = centavosToCostUnits(movement.unitCost);
      break;
    case "receipt":
      nextOnHand = onHand + quantity;
      nextAvg = movingAverage({ onHand, avgCostUnits: state.avgCostUnits ?? 0, receivedQty: quantity, unitCostCentavos: movement.unitCost });
      break;
    case "adjustment_increase":
      if (state.avgCostUnits === null || state.avgCostUnits === undefined) {
        throw new InventoryError("no-cost-basis", "This product has no cost yet. Record an opening balance or a stock receipt first");
      }
      nextOnHand = onHand + quantity;
      break;
    case "adjustment_decrease":
      if (onHand - quantity < reserved) {
        throw new InventoryError("insufficient-stock", "Not enough unreserved stock for this adjustment");
      }
      nextOnHand = onHand - quantity;
      costConsumed = costOfQuantity(quantity, state.avgCostUnits ?? 0);
      break;
    case "reservation":
      if (state.status !== "active") throw new InventoryError("product-inactive", "Inactive products can't be reserved");
      if (onHand - reserved < quantity) throw new InventoryError("insufficient-stock", "Not enough available stock");
      nextReserved = reserved + quantity;
      break;
    case "release":
      if (reserved < quantity) throw new InventoryError("insufficient-reserved", "Can't release more than is reserved");
      nextReserved = reserved - quantity;
      break;
    case "correction_in":
      if (!isCentavos(movement.value)) throw new InventoryError("invalid-cost", "Correction value must be whole centavos");
      nextOnHand = onHand + quantity;
      nextAvg = movingAverageByValue({ onHand, avgCostUnits: state.avgCostUnits ?? 0, qty: quantity, valueCentavos: movement.value });
      break;
    case "correction_out":
      if (onHand - quantity < reserved) throw new InventoryError("insufficient-stock", "Not enough unreserved stock for this correction");
      nextOnHand = onHand - quantity;
      costConsumed = costOfQuantity(quantity, state.avgCostUnits ?? 0);
      break;
    case "fulfillment":
      if (reserved < quantity || onHand < quantity) throw new InventoryError("insufficient-reserved", "Can't fulfill more than is reserved and on hand");
      nextOnHand = onHand - quantity;
      nextReserved = reserved - quantity;
      costConsumed = costOfQuantity(quantity, state.avgCostUnits ?? 0);
      break;
    default:
      throw new InventoryError("invalid-movement", "Unsupported movement");
  }

  if (nextReserved < 0 || nextOnHand < nextReserved || !isQuantity(nextOnHand, state.unit)) {
    throw new InventoryError("impossible-balance", "That movement would leave an impossible balance");
  }

  const next = {
    onHand: nextOnHand,
    reserved: nextReserved,
    available: nextOnHand - nextReserved,
    avgCostUnits: nextAvg ?? null,
    movementCount: (state.movementCount || 0) + 1,
  };
  next.isLowStock = isLowStock({ status: state.status, available: next.available, reorderLevel: state.reorderLevel });

  return {
    next,
    delta: { onHand: nextOnHand - onHand, reserved: nextReserved - reserved },
    costConsumed,
    valueBefore: inventoryValue(onHand, state.avgCostUnits ?? 0),
    valueAfter: inventoryValue(nextOnHand, nextAvg ?? 0),
  };
}
