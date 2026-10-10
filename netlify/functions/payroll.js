// POST /api/payroll   (Phase 14: Payroll module)
//   { action: "prepare", staffId, periodStart }                                    payroll.manage
//   { action: "addDeduction", payrollId, deduction: { description, amount } }      payroll.manage
//   { action: "removeDeduction", payrollId, deductionId }                          payroll.manage
//   { action: "deferAdvance", payrollId, advanceId }                               payroll.manage
//   { action: "deleteDraft", payrollId }                                           payroll.manage
//   { action: "release", payrollId, payment: { method, reference?, paidDate? } }   payroll.release
//   { action: "newReceiptLink", payrollId }                                        payroll.release
// Phase 18.6:
//   { action: "release", ..., proof?: { contentType, dataBase64 } }               payroll.release (GCash / bank screenshot)
//   { action: "addAddition", payrollId, addition: { type: "bonus" | "thirteenth", amount?, description?, year? } }   payroll.manage
//   { action: "removeAddition", payrollId, additionId }                            payroll.manage
//   { action: "thirteenth", staffId, year }                                        payroll.view (earned / given / left)
//   { action: "attachProof", payrollId, proof }                                    payroll.release (after paying)
//   { action: "proof", payrollId }                                                 payroll.view (the image)
//   { action: "resolveDispute", payrollId, note }                                  payroll.release
// 13th month = 1/12 of the year's basic pay, never more than what's left.
// Counts, base pay, deductions and net pay are computed by the server. A
// release returns the employee's one-time receipt link token ONCE. Reads go
// straight to Firestore (payroll.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { preparePayroll, addDeduction, removeDeduction, deferAdvance, deleteDraftPayroll, releaseSalary, newReceiptLink, addAddition, removeAddition, thirteenthMonthSummary, attachSalaryProof, readSalaryProof, resolveSalaryDispute } from "./_lib/payroll.js";

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
      release: { permission: R, fields: ["action", "payrollId", "payment", "proof"], run: (c, b) => releaseSalary({ ...c, payrollId: b.payrollId, release: b.payment, proof: b.proof ?? null }) },
      addAddition: { permission: M, fields: ["action", "payrollId", "addition"], run: (c, b) => addAddition({ ...c, payrollId: b.payrollId, addition: b.addition }) },
      removeAddition: { permission: M, fields: ["action", "payrollId", "additionId"], run: (c, b) => removeAddition({ ...c, payrollId: b.payrollId, additionId: b.additionId }) },
      thirteenth: { permission: "payroll.view", fields: ["action", "staffId", "year"], run: (c, b) => thirteenthMonthSummary({ ...c, staffId: b.staffId, year: b.year }) },
      attachProof: { permission: R, fields: ["action", "payrollId", "proof"], run: (c, b) => attachSalaryProof({ ...c, businessId: c.businessId, payrollId: b.payrollId, proof: b.proof }) },
      proof: { permission: "payroll.view", fields: ["action", "payrollId"], run: async (c, b) => ({ proof: await readSalaryProof({ ...c, businessId: c.businessId, payrollId: b.payrollId }) }) },
      resolveDispute: { permission: R, fields: ["action", "payrollId", "note"], run: (c, b) => resolveSalaryDispute({ ...c, payrollId: b.payrollId, note: b.note }) },
      newReceiptLink: { permission: R, fields: ["action", "payrollId"], run: (c, b) => newReceiptLink({ ...c, payrollId: b.payrollId }) },
    },
  });

export const handler = createPayrollHandler({ getAdmin });
