// Phase 11: pure report definitions — business-local presets, inclusive
// ranges, which summary documents cover a range, discount allocation and
// rollup arithmetic.

import { describe, it, expect } from "vitest";
import { reportPresets, validateRange, rangePlan, allocateDiscount, orderContribution, diffRollup, addRollup, daysBetween, addDays, REPORT_MAX_DAYS, WALK_IN_KEY } from "../../shared/reports.js";
import { grossMarginPct, financialSummary } from "../../shared/finance.js";

describe("presets come from the BUSINESS-local today (never the device)", () => {
  it("Thursday Oct 8 2026: weeks start Monday, months inclusive", () => {
    expect(reportPresets("2026-10-08")).toMatchObject({
      today: { from: "2026-10-08", to: "2026-10-08" },
      yesterday: { from: "2026-10-07", to: "2026-10-07" },
      thisWeek: { from: "2026-10-05", to: "2026-10-08" },
      thisMonth: { from: "2026-10-01", to: "2026-10-08" },
      lastMonth: { from: "2026-09-01", to: "2026-09-30" },
    });
  });
  it("January's last month is December; leap February; Monday's week is one day", () => {
    expect(reportPresets("2026-01-15").lastMonth).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(reportPresets("2028-03-02").lastMonth).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
    expect(reportPresets("2026-10-05").thisWeek).toMatchObject({ from: "2026-10-05", to: "2026-10-05" });
    expect(reportPresets("2026-10-01").yesterday).toMatchObject({ from: "2026-09-30" });
  });
});

describe("ranges are inclusive, bounded and never in the future", () => {
  it("counts both ends", () => {
    expect(daysBetween("2026-10-01", "2026-10-01")).toBe(1);
    expect(validateRange({ from: "2026-10-01", to: "2026-10-08" }, "2026-10-08").days).toBe(8);
  });
  it("refuses bad, reversed, future and too-long ranges", () => {
    expect(() => validateRange({ from: "2026-02-30", to: "2026-03-01" })).toThrow(/valid/);
    expect(() => validateRange({ from: "2026-10-08", to: "2026-10-01" })).toThrow(/after the end/);
    expect(() => validateRange({ from: "2026-10-01", to: "2026-10-09" }, "2026-10-08")).toThrow(/after today/);
    expect(validateRange({ from: addDays("2026-10-08", -(REPORT_MAX_DAYS - 1)), to: "2026-10-08" }).days).toBe(366);
    expect(() => validateRange({ from: addDays("2026-10-08", -REPORT_MAX_DAYS), to: "2026-10-08" })).toThrow(/at most 366/);
    for (const v of [undefined, "", "2026-1-1", "today", ["2026-10-01"]]) expect(() => validateRange({ from: v, to: "2026-10-08" })).toThrow();
  });
});

describe("which documents cover a range", () => {
  it("up to 62 days: one bucket per day", () => {
    const p = rangePlan("2026-09-28", "2026-10-03");
    expect(p.granularity).toBe("day");
    expect(p.buckets.map((b) => b.period)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
  });
  it("longer: whole months read their month document, edge months their days", () => {
    const p = rangePlan("2026-07-15", "2026-10-08");
    expect(p.granularity).toBe("month");
    expect(p.buckets.map((b) => [b.period, b.docs.length])).toEqual([["2026-07", 17], ["2026-08", 1], ["2026-09", 1], ["2026-10", 8]]);
    expect(p.buckets[1].docs).toEqual(["2026-08"]);
    const year = rangePlan("2025-10-09", "2026-10-08");
    expect(year.buckets.flatMap((b) => b.docs).length).toBeLessThanOrEqual(31 + 11 + 8);
  });
});

describe("discount allocation and order contributions", () => {
  it("splits an order discount across lines exactly (largest remainder)", () => {
    const lines = [{ lineSubtotal: 1000 }, { lineSubtotal: 1000 }, { lineSubtotal: 1000 }];
    expect(allocateDiscount(lines, 100)).toEqual([34, 33, 33]);
    expect(allocateDiscount(lines, 0)).toEqual([0, 0, 0]);
    for (const d of [1, 7, 999, 2999]) expect(allocateDiscount([{ lineSubtotal: 1234 }, { lineSubtotal: 567 }, { lineSubtotal: 1199 }], d).reduce((s, v) => s + v, 0)).toBe(d);
  });
  it("per-product net sales add up to the order's net sales; walk-ins have their own key", () => {
    const c = orderContribution({
      lines: [
        { productId: "pA", quantity: 2000, lineSubtotal: 150000, costConsumed: 90000, sku: "A", name: "Wings", unit: "pcs" },
        { productId: "pB", quantity: 1000, lineSubtotal: 50000, costConsumed: 30000, sku: "B", name: "Thighs", unit: "pcs" },
      ],
      discount: 10000,
    });
    expect(c.products.pA.netSales + c.products.pB.netSales).toBe(190000);
    expect(c.products.pA).toMatchObject({ qty: 2000, cogs: 90000, netSales: 142500 });
    expect(c.customers).toEqual({ [WALK_IN_KEY]: { orders: 1, netSales: 190000 } });
  });
  it("diffRollup gives exactly after − before, dropping zeros; addRollup sums", () => {
    const before = { products: { pA: { qty: 10, netSales: 100, cogs: 60, sku: "A", name: "A", unit: "pcs" } }, customers: { c1: { orders: 1, netSales: 100 } } };
    const after = { products: { pA: { qty: 8, netSales: 80, cogs: 48, sku: "A", name: "A", unit: "pcs" } }, customers: { c2: { orders: 1, netSales: 80 } } };
    const d = diffRollup(after, before);
    expect(d.products.pA).toMatchObject({ qty: -2, netSales: -20, cogs: -12 });
    expect(d.customers).toEqual({ c1: { orders: -1, netSales: -100 }, c2: { orders: 1, netSales: 80 } });
    expect(diffRollup(before, before)).toEqual({});
    expect(addRollup(addRollup({}, before), d)).toMatchObject({ products: { pA: { qty: 8, netSales: 80, cogs: 48 } }, customers: { c1: { orders: 0, netSales: 0 }, c2: { orders: 1 } } });
  });
});

describe("gross margin uses the shared definitions", () => {
  it("is gross profit / net sales, one decimal; unknown or no sales → null", () => {
    expect(grossMarginPct(financialSummary({ grossSales: 1500000, discounts: 0, returns: 0, cogs: 900000 }))).toBe(40);
    expect(grossMarginPct(financialSummary({ grossSales: 0, discounts: 0, returns: 0, cogs: 0 }))).toBeNull();
    expect(grossMarginPct(financialSummary({}))).toBeNull();
  });
});
