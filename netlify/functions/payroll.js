// POST /api/payroll   (Phase 14: Payroll module)
//   { action: "prepare", staffId, periodStart }                                    payroll.manage
//   { action: "addDeduction", payrollId, deduction: { description, amount } }      payroll.manage
//   { action: "removeDeduction", payrollId, deductionId }                          payroll.manage
//   { action: "deferAdvance", payrollId, advanceId }                               payroll.manage
//   { action: "deleteDraft", payrollId }                                           payroll.manage
//   { action: "release", payrollId, payment: { method, reference?, paidDate? } }   payroll.release
//   { action: "newReceiptLink", payrollId }                                        payroll.release
// Counts, base pay, deductions and net pay are computed by the server. A
// release returns the employee's one-time receipt link token ONCE. Reads go
// straight to Firestore (payroll.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { preparePayroll, addDeduction, removeDeduction, deferAdvance, deleteDraftPayroll, releaseSalary, newReceiptLink } from "./_lib/payroll.js";

const M = "payroll.manage";
const R = "payroll.release";
export const createPayrollHandler = (deps) =>
  payrollActionHandler("payroll", {
    ...deps,
    actions: {
      prepare: { permission: M, created: true, fields: ["action", "staffId", "periodStart"], run: (c, b) => preparePayroll({ ...c, staffId: b.staffId, periodStart: b.periodStart }) },
      addDeduction: { permission: M, fields: ["action", "payrollId", "deduction"], run: (c, b) => addDeduction({ ...c, payrollId: b.payrollId, deduction: b.deduction }) },
      removeDeduction: { permission: M, fields: ["action", "payrollId", "deductionId"], run: (c, b) => removeDeduction({ ...c, payrollId: b.payrollId, deductionId: b.deductionId }) },
      deferAdvance: { permission: M, fields: ["action", "payrollId", "advanceId"], run: (c, b) => deferAdvance({ ...c, payrollId: b.payrollId, advanceId: b.advanceId }) },
      deleteDraft: { permission: M, fields: ["action", "payrollId"], run: (c, b) => deleteDraftPayroll({ ...c, payrollId: b.payrollId }) },
      release: { permission: R, fields: ["action", "payrollId", "payment"], run: (c, b) => releaseSalary({ ...c, payrollId: b.payrollId, release: b.payment }) },
      newReceiptLink: { permission: R, fields: ["action", "payrollId"], run: (c, b) => newReceiptLink({ ...c, payrollId: b.payrollId }) },
    },
  });

export const handler = createPayrollHandler({ getAdmin });
