// POST /api/supplier-payments   (Phase 16: Supplier Payments)
//   { action: "create", payment: { supplierId, description, category, amount, dueDate, notes? } }   vendorpayments.manage
//   { action: "update", paymentId, expectedRevision?, changes: { description?, category?, amount?, dueDate?, notes? } }
//   { action: "cancel", paymentId, reason? }
//   { action: "markPaid", paymentId, payment: { method, paidDate?, reference?, amount? } }        vendorpayments.manage + expenses.create
// An Upcoming payment is committed money, not spending. Marking it Paid
// records exactly ONE Wedding Expense (a retry returns the same one). Reads
// go straight to Firestore (vendorpayments.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { createSupplierPayment, updateSupplierPayment, cancelSupplierPayment, markSupplierPaymentPaid } from "./_lib/wedding.js";

const M = "vendorpayments.manage";
export const createSupplierPaymentsHandler = (deps) =>
  weddingActionHandler("supplier-payments", {
    ...deps,
    actions: {
      create: { permission: M, created: true, fields: ["action", "payment"], run: (c, b) => createSupplierPayment({ ...c, input: b.payment }) },
      update: { permission: M, fields: ["action", "paymentId", "expectedRevision", "changes"], run: (c, b) => updateSupplierPayment({ ...c, paymentId: b.paymentId, changes: b.changes, expectedRevision: b.expectedRevision ?? null }) },
      cancel: { permission: M, fields: ["action", "paymentId", "reason"], run: (c, b) => cancelSupplierPayment({ ...c, paymentId: b.paymentId, reason: b.reason ?? null }) },
      markPaid: { permission: M, also: ["expenses.create"], fields: ["action", "paymentId", "payment"], run: (c, b) => markSupplierPaymentPaid({ ...c, paymentId: b.paymentId, payment: b.payment }) },
    },
  });

export const handler = createSupplierPaymentsHandler({ getAdmin });
