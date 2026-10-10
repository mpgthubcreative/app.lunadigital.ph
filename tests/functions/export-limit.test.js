// Phase 12.5: the synchronous export limit at its REAL value
// (EXPORT_MAX_ROWS, not a test-sized one), end to end through
// POST /api/exports:
//   - exactly EXPORT_MAX_ROWS matching rows -> 200, every row in the file;
//   - one more -> 413 with the plain "narrow your filters" message;
//   - the refusal happens while reading, BEFORE any workbook is generated,
//     and leaves no audit / usage trace of an export that didn't happen;
//   - never a silently truncated file.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Pass-through spy: proves whether a workbook was generated at all.
vi.mock("../../shared/xlsx.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, writeXlsx: vi.fn(actual.writeXlsx) };
});

const { writeXlsx, readXlsx } = await import("../../shared/xlsx.js");
const { createExportsHandler } = await import("../../netlify/functions/exports.js");
const { EXPORT_MAX_ROWS, TOO_MANY_ROWS_MESSAGE, reportRows } = await import("../../shared/exports.js");
const { buildWorld, request } = await import("../helpers/tenants.js");

const NOW = new Date("2026-10-08T06:00:00Z");
let world;

beforeEach(async () => {
  world = await buildWorld();
  writeXlsx.mockClear();
});

function seedOrders(n, start = 0) {
  for (let i = start; i < start + n; i++) {
    const id = `ord${String(i).padStart(17, "0")}`;
    world.db.seed(`businesses/biz-a/orders/${id}`, {
      orderNumber: `ORD-${String(i).padStart(5, "0")}`,
      orderDate: "2026-10-05",
      createdAt: new Date(Date.UTC(2026, 9, 5, 1) + i * 1000),
      customer: { name: `Customer ${i % 300}`, phone: "0917" },
      items: [{ lineId: "L1", sku: "SKU-1", name: "Item", unit: "pcs", quantity: 1000, unitPrice: 10000, lineSubtotal: 10000 }],
      itemCount: 1,
      subtotal: 10000,
      discount: 0,
      total: 10000,
      amountPaid: 10000,
      balance: 0,
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
      source: "phone",
    });
  }
}

async function exportOrders(filters = {}) {
  const res = await createExportsHandler({ getAdmin: async () => world, now: () => NOW })({ ...request({ uid: world.uids.ownera, method: "POST" }), body: JSON.stringify({ dataset: "orders", filters }) });
  return res;
}
const traces = () => [...world.db.docs.keys()].filter((k) => /^businesses\/biz-a\/(auditLog|usage)\//.test(k));

describe(`export limit at its real value (${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows)`, () => {
  it("is the documented initial limit", () => {
    expect(EXPORT_MAX_ROWS).toBe(10_000);
  });

  it(`exactly ${EXPORT_MAX_ROWS} rows: accepted, every row in the file`, async () => {
    seedOrders(EXPORT_MAX_ROWS);
    const res = await exportOrders({ from: "2026-10-01", to: "2026-10-31" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["X-Luna-Export-Rows"]).toBe(String(EXPORT_MAX_ROWS));
    // Phase 18.6: one sheet, an Order row + a Line row per order, under a title block.
    const all = reportRows(readXlsx(new Uint8Array(Buffer.from(res.body, "base64")), { sheet: "Orders", maxRows: 2 * EXPORT_MAX_ROWS + 20 }).rows);
    const rows = [all[0], ...all.slice(1).filter((r) => r[0] === "Order")];
    expect(rows.length - 1).toBe(EXPORT_MAX_ROWS);
    expect(all.length - 1).toBe(2 * EXPORT_MAX_ROWS);
    const numbers = rows.slice(1).map((r) => r[rows[0].indexOf("Order #")]);
    expect(new Set(numbers).size).toBe(EXPORT_MAX_ROWS);
    expect(writeXlsx).toHaveBeenCalledTimes(1);
    expect(traces().length).toBe(2); // one audit entry + the usage month
  }, 120_000);

  it(`${EXPORT_MAX_ROWS + 1} rows: refused with the plain message, before any workbook is built, no truncated file, no trace`, async () => {
    seedOrders(EXPORT_MAX_ROWS + 1);
    const res = await exportOrders({ from: "2026-10-01", to: "2026-10-31" });
    expect(res.statusCode).toBe(413);
    expect(res.headers["Content-Type"]).toMatch(/json/);
    expect(res.isBase64Encoded).toBeFalsy();
    expect(JSON.parse(res.body)).toMatchObject({ error: "too-many-rows", message: TOO_MANY_ROWS_MESSAGE });
    expect(TOO_MANY_ROWS_MESSAGE).toBe("This export contains too many rows. Narrow your filters and try again.");
    expect(writeXlsx).not.toHaveBeenCalled();
    expect(traces()).toEqual([]);
  }, 120_000);

  it("narrowing the filters below the limit makes the same data downloadable", async () => {
    seedOrders(EXPORT_MAX_ROWS + 1);
    world.db.seed("businesses/biz-a/orders/ordZZZZZZZZZZZZZZZZZ", { orderNumber: "ORD-UNPAID", orderDate: "2026-10-06", createdAt: NOW, customer: { name: "U" }, items: [], itemCount: 0, subtotal: 5000, discount: 0, total: 5000, amountPaid: 0, balance: 5000, paymentStatus: "unpaid", fulfillmentStatus: "pending", source: "phone" });
    expect((await exportOrders({})).statusCode).toBe(413);
    const res = await exportOrders({ paymentStatus: "unpaid" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["X-Luna-Export-Rows"]).toBe("1");
  }, 120_000);
});
