// Phase 6 pure logic: quantity precision, money parsing, moving weighted
// average cost, and every movement rule.

import { describe, it, expect } from "vitest";
import {
  parseQuantity,
  formatQuantity,
  parseCentavos,
  isQuantity,
  unitStep,
  movingAverage,
  costOfQuantity,
  inventoryValue,
  costUnitsToCentavos,
  centavosToCostUnits,
  QTY_SCALE,
  COST_SCALE,
  MAX_QUANTITY,
} from "../../shared/quantity.js";
import { planMovement, validateProductInput, normalizeSku, isValidSku, isLowStock, isValidProductId, InventoryError } from "../../shared/inventory.js";

const Q = (n) => n * QTY_SCALE; // whole units -> scaled
const pesos = (centavos) => centavos / 100;

describe("quantities: scaled integers, 3 decimals, per-unit precision", () => {
  it("parses by decimal text, never float maths", () => {
    expect(parseQuantity("12.5", "kg")).toBe(12500);
    expect(parseQuantity("0.001", "kg")).toBe(1);
    expect(parseQuantity("100", "pcs")).toBe(100000);
    expect(parseQuantity(3, "box")).toBe(3000);
    expect(parseQuantity("1.10", "l")).toBe(1100);
    expect(parseQuantity("5.000", "pcs")).toBe(5000); // trailing zeros are fine
  });

  it.each([["NaN"], ["Infinity"], ["-1"], ["1e3"], [""], [" "], ["1,000"], ["0x10"], ["1.2.3"], [NaN], [Infinity], [null], [{}]])("rejects %s", (input) => {
    expect(() => parseQuantity(input, "kg")).toThrow();
  });

  it("rejects more decimals than the unit allows", () => {
    expect(() => parseQuantity("1.5", "pcs")).toThrow(/at most 0/);
    expect(() => parseQuantity("1.2345", "kg")).toThrow(/at most 3/);
    expect(() => parseQuantity("1", "barrel")).toThrow(/Unknown unit/);
  });

  it("rejects excessive quantities", () => {
    expect(() => parseQuantity("1000000001", "pcs")).toThrow(/too large/);
  });

  it("0.1 + 0.2 kg is exactly 0.3 kg", () => {
    expect(formatQuantity(parseQuantity("0.1", "kg") + parseQuantity("0.2", "kg"))).toBe("0.3");
  });

  it("isQuantity enforces the unit step", () => {
    expect(unitStep("pcs")).toBe(1000);
    expect(unitStep("kg")).toBe(1);
    expect(isQuantity(1500, "pcs")).toBe(false);
    expect(isQuantity(1500, "kg")).toBe(true);
    expect(isQuantity(-1000, "pcs")).toBe(false);
    expect(isQuantity(1.5, "kg")).toBe(false);
    expect(isQuantity(MAX_QUANTITY + 1000, "pcs")).toBe(false);
  });

  it("formats", () => {
    expect(formatQuantity(150000)).toBe("150");
    expect(formatQuantity(12500)).toBe("12.5");
    expect(formatQuantity(1)).toBe("0.001");
  });
});

describe("money: integer centavos", () => {
  it("parses peso text", () => {
    expect(parseCentavos("60")).toBe(6000);
    expect(parseCentavos("53.5")).toBe(5350);
    expect(parseCentavos("1,250.75")).toBe(125075);
    expect(parseCentavos("0")).toBe(0);
  });

  it.each([["-5"], ["1.234"], ["NaN"], ["Infinity"], ["abc"], [""], [NaN], ["9999999999"]])("rejects %s", (input) => {
    expect(() => parseCentavos(input)).toThrow();
  });
});

describe("moving weighted average cost", () => {
  it("THE example: 100 @ ₱50 + 50 @ ₱60 = 150 @ ₱53.33", () => {
    const avg = movingAverage({ onHand: Q(100), avgCostUnits: centavosToCostUnits(5000), receivedQty: Q(50), unitCostCentavos: 6000 });
    expect(avg).toBe(53333333); // ₱53.333333 per unit in cost units (centavos x 10^4)
    expect(pesos(costUnitsToCentavos(avg))).toBe(53.33);
    expect(inventoryValue(Q(150), avg)).toBe(800000); // ₱8,000.00 (= 5,000 + 3,000)
  });

  it("with nothing on hand the average is the receipt's cost", () => {
    expect(movingAverage({ onHand: 0, avgCostUnits: 50000000, receivedQty: Q(10), unitCostCentavos: 7000 })).toBe(70000000);
  });

  it("rounds half-up at 1/10,000 of a centavo", () => {
    // (1 @ ₱1.00 + 2 @ ₱0.01) / 3 = 34 centavos -> 340000 cost units exactly
    expect(movingAverage({ onHand: Q(1), avgCostUnits: centavosToCostUnits(100), receivedQty: Q(2), unitCostCentavos: 1 })).toBe(340000);
    // 2 @ 1 centavo + 1 @ 2 centavos = 4/3 centavos -> 13333.33 -> 13333
    expect(movingAverage({ onHand: Q(2), avgCostUnits: centavosToCostUnits(1), receivedQty: Q(1), unitCostCentavos: 2 })).toBe(13333);
  });

  it("stays exact on huge quantities (BigInt inside)", () => {
    const avg = movingAverage({ onHand: Q(900_000_000), avgCostUnits: centavosToCostUnits(9_999_999), receivedQty: Q(99_999_999), unitCostCentavos: 1 });
    expect(Number.isSafeInteger(avg)).toBe(true);
    expect(avg).toBeGreaterThan(0);
  });

  it("drift over 1,000 receipts stays under a centavo per unit", () => {
    let onHand = 0;
    let avg = 0;
    let exactValueCentavos = 0;
    for (let i = 1; i <= 1000; i++) {
      const qty = Q((i % 7) + 1);
      const cost = 4000 + ((i * 37) % 2000);
      avg = movingAverage({ onHand, avgCostUnits: avg, receivedQty: qty, unitCostCentavos: cost });
      onHand += qty;
      exactValueCentavos += (qty / QTY_SCALE) * cost;
    }
    const exactAvgCostUnits = (exactValueCentavos * COST_SCALE) / (onHand / QTY_SCALE);
    expect(Math.abs(avg - exactAvgCostUnits)).toBeLessThan(COST_SCALE); // < 1 centavo
  });

  it("cost of quantity = the COGS snapshot amount", () => {
    expect(costOfQuantity(Q(10), 53333333)).toBe(53333); // ₱533.33
    expect(costOfQuantity(Q(3), 50000000)).toBe(15000);
  });
});

describe("planMovement", () => {
  const base = { status: "active", unit: "pcs", onHand: 0, reserved: 0, reorderLevel: Q(20), movementCount: 0, avgCostUnits: null };
  const plan = (state, movement) => planMovement({ ...base, ...state }, movement);

  it("THE scenario: opening 100 @ ₱50, receive 50 @ ₱60, then -10: average unchanged", () => {
    const opening = plan({}, { type: "opening", quantity: Q(100), unitCost: 5000 }).next;
    expect(opening).toMatchObject({ onHand: Q(100), reserved: 0, available: Q(100), avgCostUnits: 50000000, movementCount: 1 });

    const received = plan(opening, { type: "receipt", quantity: Q(50), unitCost: 6000 });
    expect(received.next).toMatchObject({ onHand: Q(150), available: Q(150), avgCostUnits: 53333333, movementCount: 2 });
    expect(pesos(costUnitsToCentavos(received.next.avgCostUnits))).toBe(53.33);

    const adjusted = plan(received.next, { type: "adjustment_decrease", quantity: Q(10), reason: "damaged" });
    expect(adjusted.next).toMatchObject({ onHand: Q(140), avgCostUnits: 53333333 });
    expect(adjusted.costConsumed).toBe(53333);
    expect(adjusted.valueAfter).toBe(inventoryValue(Q(140), 53333333));
  });

  it("opening only before any movement", () => {
    expect(() => plan({ movementCount: 1, onHand: Q(5), avgCostUnits: 1 }, { type: "opening", quantity: Q(1), unitCost: 100 })).toThrow(/before any other/);
  });

  it("positive adjustment uses the current average and never changes it", () => {
    const r = plan({ onHand: Q(10), avgCostUnits: 50000000, movementCount: 1 }, { type: "adjustment_increase", quantity: Q(2) });
    expect(r.next).toMatchObject({ onHand: Q(12), avgCostUnits: 50000000 });
  });

  it("positive adjustment with no cost basis is refused (safest rule)", () => {
    expect(() => plan({}, { type: "adjustment_increase", quantity: Q(5) })).toThrow(expect.objectContaining({ code: "no-cost-basis" }));
  });

  it("negative adjustment can't go below zero or into reserved stock", () => {
    expect(() => plan({ onHand: Q(5), avgCostUnits: 1, movementCount: 1 }, { type: "adjustment_decrease", quantity: Q(6) })).toThrow(/Not enough/);
    expect(() => plan({ onHand: Q(5), reserved: Q(4), avgCostUnits: 1, movementCount: 1 }, { type: "adjustment_decrease", quantity: Q(2) })).toThrow(/unreserved/);
  });

  it("reservation / release / fulfillment (Phase 7 helpers)", () => {
    const stock = { onHand: Q(10), avgCostUnits: 50000000, movementCount: 1 };
    const reserved = plan(stock, { type: "reservation", quantity: Q(4) }).next;
    expect(reserved).toMatchObject({ onHand: Q(10), reserved: Q(4), available: Q(6), avgCostUnits: 50000000 });
    expect(() => plan({ ...stock, ...reserved }, { type: "reservation", quantity: Q(7) })).toThrow(/available/);
    const released = plan({ ...stock, ...reserved }, { type: "release", quantity: Q(1) }).next;
    expect(released).toMatchObject({ reserved: Q(3), available: Q(7) });
    expect(() => plan({ ...stock, ...released }, { type: "release", quantity: Q(4) })).toThrow(/more than is reserved/);
    const fulfilled = plan({ ...stock, ...released }, { type: "fulfillment", quantity: Q(3) });
    expect(fulfilled.next).toMatchObject({ onHand: Q(7), reserved: 0, available: Q(7), avgCostUnits: 50000000 });
    expect(fulfilled.costConsumed).toBe(15000); // 3 x ₱50: the COGS snapshot
    expect(() => plan({ ...stock, reserved: Q(1) }, { type: "fulfillment", quantity: Q(2) })).toThrow();
  });

  it("COGS snapshot keeps September's cost after October's receipt", () => {
    // September: reserve 2 @ ₱50 and fulfil -> cost ₱100 snapshotted then.
    const sept = plan({ onHand: Q(10), reserved: Q(2), avgCostUnits: centavosToCostUnits(5000), movementCount: 2 }, { type: "fulfillment", quantity: Q(2) });
    expect(sept.costConsumed).toBe(10000);
    // October: receipts at ₱60 raise the average; September's number was
    // returned once and stored on that order line, so it can't change.
    const oct = plan(sept.next, { type: "receipt", quantity: Q(8), unitCost: 6000 });
    expect(costUnitsToCentavos(oct.next.avgCostUnits)).toBe(5500);
    expect(sept.costConsumed).toBe(10000);
  });

  it("inactive products can't be reserved", () => {
    expect(() => plan({ status: "inactive", onHand: Q(10), avgCostUnits: 1, movementCount: 1 }, { type: "reservation", quantity: Q(1) })).toThrow(/Inactive/);
  });

  it.each([
    ["zero quantity", { type: "receipt", quantity: 0, unitCost: 100 }],
    ["negative quantity", { type: "receipt", quantity: -1000, unitCost: 100 }],
    ["fraction for pcs", { type: "receipt", quantity: 1500, unitCost: 100 }],
    ["NaN quantity", { type: "receipt", quantity: NaN, unitCost: 100 }],
    ["missing cost", { type: "receipt", quantity: Q(1) }],
    ["fractional centavos", { type: "receipt", quantity: Q(1), unitCost: 10.5 }],
    ["negative cost", { type: "receipt", quantity: Q(1), unitCost: -1 }],
    ["Infinity cost", { type: "receipt", quantity: Q(1), unitCost: Infinity }],
    ["unknown type", { type: "teleport", quantity: Q(1) }],
  ])("rejects %s", (_label, movement) => {
    expect(() => plan({}, movement)).toThrow(InventoryError);
  });

  it("low stock = active && available <= reorder level", () => {
    expect(isLowStock({ status: "active", available: Q(20), reorderLevel: Q(20) })).toBe(true);
    expect(isLowStock({ status: "active", available: Q(21), reorderLevel: Q(20) })).toBe(false);
    expect(isLowStock({ status: "inactive", available: 0, reorderLevel: Q(20) })).toBe(false);
    // Reserved stock can't satisfy another order: 30 on hand, 15 reserved, reorder at 20 -> low.
    expect(plan({ onHand: Q(30), avgCostUnits: 1, movementCount: 1 }, { type: "reservation", quantity: Q(15) }).next.isLowStock).toBe(true);
  });
});

describe("product validation", () => {
  const good = { sku: " ab-001 ", name: "  Rice   25kg ", category: "Grains", unit: "sack", sellingPrice: 125000, reorderLevel: Q(5) };

  it("normalizes SKU and text", () => {
    expect(validateProductInput(good)).toEqual({ sku: "AB-001", name: "Rice 25kg", category: "Grains", unit: "sack", sellingPrice: 125000, reorderLevel: Q(5) });
    expect(normalizeSku("ab-1")).toBe(normalizeSku("AB-1"));
  });

  it.each([
    ["blank SKU", { sku: "  " }],
    ["SKU with spaces", { sku: "AB 1" }],
    ["SKU with slash", { sku: "AB/1" }],
    ["SKU too long", { sku: "A".repeat(41) }],
    ["SKU of dots", { sku: ".." }],
    ["blank name", { name: "" }],
    ["invalid unit", { unit: "barrel" }],
    ["negative price", { sellingPrice: -1 }],
    ["fractional price", { sellingPrice: 10.5 }],
    ["string price", { sellingPrice: "100" }],
    ["NaN price", { sellingPrice: NaN }],
    ["fractional reorder for pcs", { unit: "pcs", reorderLevel: 1500 }],
    ["balances can't be set", { onHand: Q(100) }],
    ["costs can't be set", { avgCostUnits: 1 }],
    ["status can't be set here", { status: "active" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => validateProductInput({ ...good, ...patch })).toThrow(InventoryError);
  });

  it("unit is locked once stock has moved", () => {
    expect(() => validateProductInput({ unit: "kg" }, { existing: { unit: "pcs", movementCount: 2, reorderLevel: 0 } })).toThrow(/can't change/);
    expect(validateProductInput({ unit: "kg" }, { existing: { unit: "pcs", movementCount: 0, reorderLevel: 0 } }).unit).toBe("kg");
  });

  it("ids and SKUs", () => {
    expect(isValidSku("SKU-1.A_B")).toBe(true);
    expect(isValidProductId("aZ09aZ09aZ09aZ09aZ09")).toBe(true);
    for (const bad of ["../x", "short", "has space here!!", "", null]) expect(isValidProductId(bad)).toBe(false);
  });
});
