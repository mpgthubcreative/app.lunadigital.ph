// Phase 5: business-local dates, ranges, the fewest documents per range,
// and the central financial definitions.

import { describe, it, expect } from "vitest";
import {
  businessDate,
  businessMonth,
  isDayId,
  isMonthId,
  isMetricsDocId,
  addDays,
  resolveRange,
  metricDocIdsForRange,
  sumCounters,
  FINANCIAL_COUNTERS,
  OPERATIONAL_COUNTERS,
} from "../../shared/metrics.js";
import { netSales, grossProfit, estimatedOperatingProfit, financialSummary, FINANCIAL_FIGURES, ESTIMATED_PROFIT_NOTE } from "../../shared/finance.js";
import { DASHBOARD_WIDGETS } from "../../shared/dashboard.js";

describe("businessDate: the business's own calendar day", () => {
  it("12:30 AM in Manila counts toward that Manila day, not the UTC day", () => {
    // 2026-10-07T16:30Z is 2026-10-08 00:30 in Manila (UTC+8).
    expect(businessDate("Asia/Manila", new Date("2026-10-07T16:30:00Z"))).toBe("2026-10-08");
    expect(businessDate("UTC", new Date("2026-10-07T16:30:00Z"))).toBe("2026-10-07");
  });

  it("11:59 PM stays on the same local day", () => {
    expect(businessDate("Asia/Manila", new Date("2026-10-08T15:59:00Z"))).toBe("2026-10-08");
  });

  it("works for any IANA timezone, including DST zones", () => {
    // New York: 2026-03-08 is the spring-forward day.
    expect(businessDate("America/New_York", new Date("2026-03-08T04:30:00Z"))).toBe("2026-03-07");
    expect(businessDate("America/New_York", new Date("2026-03-08T05:30:00Z"))).toBe("2026-03-08");
    expect(businessDate("Pacific/Kiritimati", new Date("2026-10-07T10:30:00Z"))).toBe("2026-10-08");
  });

  it("month rollups follow the local date", () => {
    expect(businessMonth("Asia/Manila", new Date("2026-09-30T16:30:00Z"))).toBe("2026-10");
  });

  it("refuses an invalid timezone or date instead of guessing", () => {
    expect(() => businessDate("Mars/Olympus", new Date())).toThrow(RangeError);
    expect(() => businessDate("Asia/Manila", new Date("nope"))).toThrow(RangeError);
  });
});

describe("metric document ids", () => {
  it("validates day, month and current ids", () => {
    expect(isDayId("2026-10-08")).toBe(true);
    expect(isDayId("2026-02-30")).toBe(false);
    expect(isDayId("2026-10-8")).toBe(false);
    expect(isMonthId("2026-10")).toBe(true);
    expect(isMonthId("2026-13")).toBe(false);
    expect(isMetricsDocId("current")).toBe(true);
    expect(isMetricsDocId("../orders")).toBe(false);
  });

  it("addDays crosses months and leap days", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("resolveRange (business-local)", () => {
  const tz = "Asia/Manila";
  const now = new Date("2026-10-07T16:30:00Z"); // Thu 2026-10-08 00:30 Manila

  it("today / yesterday", () => {
    expect(resolveRange("today", { timezone: tz, now })).toEqual({ preset: "today", from: "2026-10-08", to: "2026-10-08" });
    expect(resolveRange("yesterday", { timezone: tz, now })).toMatchObject({ from: "2026-10-07", to: "2026-10-07" });
  });

  it("this week starts Monday; on a Sunday it covers the past six days", () => {
    expect(resolveRange("thisWeek", { timezone: tz, now })).toMatchObject({ from: "2026-10-05", to: "2026-10-08" });
    const sunday = new Date("2026-10-11T04:00:00Z");
    expect(resolveRange("thisWeek", { timezone: tz, now: sunday })).toMatchObject({ from: "2026-10-05", to: "2026-10-11" });
    expect(resolveRange("thisWeek", { timezone: tz, now: sunday, weekStartsOn: 0 })).toMatchObject({ from: "2026-10-11", to: "2026-10-11" });
  });

  it("this month", () => {
    expect(resolveRange("thisMonth", { timezone: tz, now })).toMatchObject({ from: "2026-10-01", to: "2026-10-08" });
  });

  it("custom ranges are validated and capped", () => {
    expect(resolveRange("custom", { timezone: tz, from: "2026-09-01", to: "2026-09-30" })).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(() => resolveRange("custom", { timezone: tz, from: "2026-09-30", to: "2026-09-01" })).toThrow();
    expect(() => resolveRange("custom", { timezone: tz, from: "2024-01-01", to: "2026-01-01" })).toThrow(/longer than/);
    expect(() => resolveRange("custom", { timezone: tz, from: "x", to: "2026-01-01" })).toThrow();
    expect(() => resolveRange("forever", { timezone: tz })).toThrow();
  });
});

describe("metricDocIdsForRange: fewest documents, no scans", () => {
  it("a single day is one document", () => {
    expect(metricDocIdsForRange({ from: "2026-10-08", to: "2026-10-08" })).toEqual(["2026-10-08"]);
  });

  it("a whole month is one rollup document", () => {
    expect(metricDocIdsForRange({ from: "2026-09-01", to: "2026-09-30" })).toEqual(["2026-09"]);
  });

  it("a partial month is its days", () => {
    expect(metricDocIdsForRange({ from: "2026-10-01", to: "2026-10-08" })).toHaveLength(8);
  });

  it("mixes days and months across boundaries", () => {
    expect(metricDocIdsForRange({ from: "2026-08-30", to: "2026-10-02" })).toEqual(["2026-08-30", "2026-08-31", "2026-09", "2026-10-01", "2026-10-02"]);
  });

  it("a calendar year is 12 reads, not 365", () => {
    expect(metricDocIdsForRange({ from: "2026-01-01", to: "2026-12-31" })).toHaveLength(12);
  });
});

describe("sumCounters", () => {
  it("missing documents are no activity; malformed fields are unknown", () => {
    const { hasData, totals } = sumCounters([{ orderCount: 2 }, null, { orderCount: 3 }], ["orderCount", "cancelledOrders"]);
    expect(hasData).toBe(true);
    expect(totals).toEqual({ orderCount: 5, cancelledOrders: 0 });
    expect(sumCounters([{ orderCount: "2" }], ["orderCount"]).totals.orderCount).toBeNull();
    expect(sumCounters([null, undefined], ["orderCount"]).hasData).toBe(false);
  });
});

describe("financial definitions (shared/finance.js)", () => {
  const day = { grossSales: 100000, discounts: 5000, returns: 2000, cogs: 50000, operatingExpenses: 20000, paymentsReceived: 60000 };

  it("net sales, gross profit, estimated operating profit", () => {
    expect(netSales(day)).toBe(93000);
    expect(grossProfit(day)).toBe(43000);
    expect(estimatedOperatingProfit(day)).toBe(23000);
  });

  it("can go negative (a loss is a real answer)", () => {
    expect(estimatedOperatingProfit({ ...day, operatingExpenses: 90000 })).toBe(-47000);
  });

  it("a missing or non-integer input makes dependent figures unknown, never 0", () => {
    const { cogs, ...noCogs } = day;
    expect(grossProfit(noCogs)).toBeNull();
    expect(estimatedOperatingProfit(noCogs)).toBeNull();
    expect(netSales(noCogs)).toBe(93000);
    expect(netSales({ ...day, discounts: 12.5 })).toBeNull();
    expect(netSales({ ...day, grossSales: "100000" })).toBeNull();
    expect(cogs).toBe(50000);
  });

  it("financialSummary of nothing is all unknown", () => {
    const s = financialSummary(null);
    expect(Object.values(s).every((v) => v === null)).toBe(true);
  });

  it("COGS comes from the cost snapshotted on each sale, so history doesn't move", () => {
    // One unit sold last month when its cost was ₱50, one this month at ₱60.
    // Each day's document stored the cost of ITS sale; profit for last month
    // is unchanged by the later cost. There is no product-cost input at all.
    const lastMonthDay = { grossSales: 10000, discounts: 0, returns: 0, cogs: 5000, operatingExpenses: 0 };
    const thisMonthDay = { grossSales: 10000, discounts: 0, returns: 0, cogs: 6000, operatingExpenses: 0 };
    expect(grossProfit(lastMonthDay)).toBe(5000);
    expect(grossProfit(thisMonthDay)).toBe(4000);
    const both = sumCounters([lastMonthDay, thisMonthDay], Object.keys(FINANCIAL_COUNTERS)).totals;
    expect(grossProfit(both)).toBe(9000);
  });

  it("never calls the estimate net income or net profit", () => {
    const labels = [...Object.values(FINANCIAL_FIGURES).map((f) => f.label), ...DASHBOARD_WIDGETS.map((w) => w.label)].join(" | ");
    expect(labels).not.toMatch(/net income|net profit/i);
    expect(FINANCIAL_FIGURES.estimatedOperatingProfit.label).toBe("Estimated operating profit");
    expect(ESTIMATED_PROFIT_NOTE).toMatch(/taxes, depreciation, financing costs/);
  });

  it("every stored money component is defined in centavos", () => {
    for (const def of Object.values(FINANCIAL_COUNTERS)) expect(def.unit).toBe("centavos");
    for (const def of Object.values(OPERATIONAL_COUNTERS)) expect(def.unit).toBe("count");
  });
});
