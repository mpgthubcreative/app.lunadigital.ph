// Reseller commission recognition (2026-11-01): earned = final commission ×
// verified customer payments ÷ order total, capped 0..1, rounded half up to
// the centavo; dated pieces per verified payment add up exactly.
import { describe, it, expect } from "vitest";
import { recognizedCommission, earnedOf, potentialOf, earnedPieces } from "../../shared/resellers.js";

const order = (extra = {}) => ({ resellerId: "resRiza000001", total: 50000, verifiedPaid: 0, fulfillmentStatus: "pending", orderDate: "2026-10-10", commission: { calculated: 15000, final: 15000, adjusted: false }, ...extra });

describe("recognizedCommission", () => {
  it("THE example: ₱150 on a ₱500 order — ₱0, ₱200 → ₱60, ₱300 → ₱90, ₱500 → ₱150", () => {
    expect([0, 20000, 30000, 50000].map((paid) => recognizedCommission(15000, paid, 50000))).toEqual([0, 6000, 9000, 15000]);
  });
  it("20% / 40% / 100%; an override (₱120 at 40% = ₱48)", () => {
    expect(recognizedCommission(15000, 10000, 50000)).toBe(3000);
    expect(recognizedCommission(12000, 20000, 50000)).toBe(4800);
  });
  it("capped to 0..1; nothing for ₱0 commission, a ₱0 total or bad input", () => {
    expect(recognizedCommission(15000, 90000, 50000)).toBe(15000);
    expect(recognizedCommission(15000, -100, 50000)).toBe(0);
    expect(recognizedCommission(0, 50000, 50000)).toBe(0);
    expect(recognizedCommission(15000, 50000, 0)).toBe(0);
    expect(recognizedCommission(null, 50000, 50000)).toBe(0);
  });
  it("rounds half up to the centavo, exactly, even on large amounts", () => {
    expect(recognizedCommission(10000, 10000, 30000)).toBe(3333);
    expect(recognizedCommission(10000, 20000, 30000)).toBe(6667);
    expect(recognizedCommission(1, 1, 2)).toBe(1);
    expect(recognizedCommission(9_000_000_000_00, 3_000_000_000_00, 9_000_000_000_00)).toBe(3_000_000_000_00);
  });
});

describe("earnedOf / potentialOf", () => {
  it("only VERIFIED payments count (pending never does); cancelled and direct orders earn nothing", () => {
    expect(earnedOf(order({ verifiedPaid: 0, pendingPaid: 50000 }))).toBe(0);
    expect(earnedOf(order({ verifiedPaid: 20000, pendingPaid: 30000 }))).toBe(6000);
    expect(potentialOf(order())).toBe(15000);
    expect(earnedOf(order({ verifiedPaid: 50000, fulfillmentStatus: "cancelled" }))).toBe(0);
    expect(potentialOf(order({ fulfillmentStatus: "cancelled" }))).toBe(0);
    expect(earnedOf(order({ resellerId: null, verifiedPaid: 50000 }))).toBe(0);
  });
});

describe("earnedPieces", () => {
  it("one dated piece per verified payment; the pieces add up to earnedOf exactly", () => {
    const o = order({ total: 30000, verifiedPaid: 30000, commission: { calculated: 10000, final: 10000 } });
    const pieces = earnedPieces(o, [{ amount: 10000, day: "2026-10-12" }, { amount: 10000, day: "2026-10-01" }, { amount: 10000, day: "2026-11-02" }]);
    expect(pieces).toEqual([{ day: "2026-10-01", amount: 3333 }, { day: "2026-10-12", amount: 3334 }, { day: "2026-11-02", amount: 3333 }]);
    expect(pieces.reduce((t, p) => t + p.amount, 0)).toBe(earnedOf(o));
  });
  it("anything the listed payments don't explain is dated to the last payment, or the order date", () => {
    expect(earnedPieces(order({ verifiedPaid: 20000 }), [])).toEqual([{ day: "2026-10-10", amount: 6000 }]);
    expect(earnedPieces(order({ verifiedPaid: 20000 }), [{ amount: 10000, day: "2026-10-11" }])).toEqual([{ day: "2026-10-11", amount: 3000 }, { day: "2026-10-11", amount: 3000 }]);
    expect(earnedPieces(order(), [])).toEqual([]);
  });
});
