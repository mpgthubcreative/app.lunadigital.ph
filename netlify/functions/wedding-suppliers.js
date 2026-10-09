// POST /api/wedding-suppliers   (Phase 16: Wedding Suppliers; vendors.manage)
//   { action: "create", supplier: { name, service, contactPerson?, phone?, email?, location?, agreedAmount?, categoryId?, notes? } }
//   { action: "update", supplierId, expectedRevision?, changes: { ...any of the above } }
//   { action: "setStatus", supplierId, status: "active" | "inactive" }
// A wedding-only directory: not Distributor Customers, not Baby providers.
// Paid, balance, upcoming and next due are computed by Luna; the browser
// can't send them. Reads go straight to Firestore (vendors.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { createSupplier, updateSupplier, setSupplierStatus } from "./_lib/wedding.js";

const M = "vendors.manage";
export const createWeddingSuppliersHandler = (deps) =>
  weddingActionHandler("wedding-suppliers", {
    ...deps,
    actions: {
      create: { permission: M, created: true, fields: ["action", "supplier"], run: (c, b) => createSupplier({ ...c, input: b.supplier }) },
      update: { permission: M, fields: ["action", "supplierId", "expectedRevision", "changes"], run: (c, b) => updateSupplier({ ...c, supplierId: b.supplierId, changes: b.changes, expectedRevision: b.expectedRevision ?? null }) },
      setStatus: { permission: M, fields: ["action", "supplierId", "status"], run: (c, b) => setSupplierStatus({ ...c, supplierId: b.supplierId, status: b.status }) },
    },
  });

export const handler = createWeddingSuppliersHandler({ getAdmin });
