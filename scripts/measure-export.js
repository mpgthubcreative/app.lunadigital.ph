// Measures the CPU / memory / size cost of building export workbooks (no
// Firestore, no network): the part of an export the function controls.
//
//   node scripts/measure-export.js [rows=10000]
//
// Reading the rows from Firestore is measured separately on staging (see
// docs/ARCHITECTURE.md "Exports"); together they set EXPORT_MAX_ROWS.

import { RECORD_BUILDERS } from "../netlify/functions/_lib/exports/records.js";
import { writeXlsx } from "../shared/xlsx.js";
import { resolvePermissions } from "../shared/permissions.js";

const n = Number(process.argv[2] || 10000);
const day = (i) => `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`;
const orders = Array.from({ length: n }, (_, i) => ({
  id: `o${String(i).padStart(19, "0")}`,
  orderNumber: `ORD-20261008-${String(i).padStart(5, "0")}`,
  orderDate: day(i),
  createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 2, i % 60)),
  customer: { name: `Sari-sari Store Number ${i}`, phone: "0917 123 4567" },
  items: Array.from({ length: 3 }, (_, k) => ({ lineId: `L${k + 1}`, sku: `SKU-${k}-${i % 500}`, name: `Frozen product ${k}`, unit: "kg", quantity: 2500, unitPrice: 25050, lineSubtotal: 62625 })),
  itemCount: 3,
  subtotal: 187875,
  discount: 0,
  total: 187875,
  amountPaid: 187875,
  balance: 0,
  paymentStatus: "paid",
  fulfillmentStatus: "fulfilled",
  source: "messenger",
  lastPaymentRef: `GC${i}`,
}));

const heap0 = process.memoryUsage().heapUsed;
const t0 = performance.now();
const built = await RECORD_BUILDERS.orders({
  filters: {},
  permissions: resolvePermissions("owner"),
  timezone: "Asia/Manila",
  readRows: async () => orders,
  readByIds: async (_c, ids) => new Map(ids.map((id) => [id, { cogs: 112725, grossProfit: 75150, lines: [{ lineId: "L1", costConsumed: 37575 }, { lineId: "L2", costConsumed: 37575 }, { lineId: "L3", costConsumed: 37575 }] }])),
});
const t1 = performance.now();
const bytes = writeXlsx(built.sheets, { title: "Orders", created: new Date() });
const t2 = performance.now();
const heap1 = process.memoryUsage().heapUsed;
const rss = process.memoryUsage().rss;
console.log(
  JSON.stringify({
    rows: n,
    lineRows: n * 3,
    buildMs: Math.round(t1 - t0),
    writeMs: Math.round(t2 - t1),
    fileKB: Math.round(bytes.length / 1024),
    base64KB: Math.round((bytes.length * 4) / 3 / 1024),
    heapDeltaMB: Math.round((heap1 - heap0) / 1048576),
    rssMB: Math.round(rss / 1048576),
  })
);
