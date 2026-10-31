// COGS may be ₱0 (2026-10-31): 0 and 0.00 are valid costs everywhere a cost
// is typed (Costs page, Starting stock / Receive, import); blank, negative,
// NaN and malformed input get a plain message, never "Invalid number" for 0.
import { describe, it, expect } from "vitest";
import { parseCost, parseCentavos, QuantityError } from "../../shared/quantity.js";
import { planMovement } from "../../shared/inventory.js";

describe("a cost per unit of ₱0", () => {
  it("0, 0.00, positive whole and decimal amounts are valid", () => {
    expect(parseCost("0")).toBe(0);
    expect(parseCost("0.00")).toBe(0);
    expect(parseCost(" 0.0 ")).toBe(0);
    expect(parseCost(0)).toBe(0);
    expect(parseCost("250")).toBe(25000);
    expect(parseCost("250.50")).toBe(25050);
    expect(parseCost("1,250.5")).toBe(125050);
  });
  it("blank, negative, NaN and malformed get plain messages", () => {
    expect(() => parseCost("")).toThrow("Enter the cost per unit (₱0 is fine)");
    expect(() => parseCost("   ")).toThrow("Enter the cost per unit (₱0 is fine)");
    expect(() => parseCost(null)).toThrow(QuantityError);
    expect(() => parseCost(Number.NaN)).toThrow("Enter the cost per unit (₱0 is fine)");
    expect(() => parseCost("-5")).toThrow("The cost per unit can't be negative");
    expect(() => parseCost("abc")).toThrow("Enter a cost like 0, 250 or 250.50");
    expect(() => parseCost("1.234")).toThrow("Enter a cost like 0, 250 or 250.50");
    for (const v of ["0", "0.00"]) expect(() => parseCost(v)).not.toThrow();
  });
  it("starting stock at ₱0 cost is a valid movement (inventory value ₱0)", () => {
    expect(parseCentavos("0")).toBe(0);
    const out = planMovement({ unit: "pcs", onHand: 0, reserved: 0, avgCostUnits: null, movementCount: 0 }, { type: "opening", quantity: 5000, unitCost: 0 });
    expect(JSON.stringify(out)).toMatch(/5000/);
    expect(() => planMovement({ unit: "pcs", onHand: 5000, reserved: 0, avgCostUnits: 0, movementCount: 1 }, { type: "receipt", quantity: 1000, unitCost: 0 })).not.toThrow();
  });
});
