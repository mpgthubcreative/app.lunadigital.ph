// POST /api/payroll   (Phase 14: Payroll module)
//   { action: "prepare", staffId, periodStart }                                    payroll.manage
//   { action: "prepareAll", asOf? }  everyone on payroll for the period including asOf (default today)   payroll.manage
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
// Owner-pilot batch (automatic payroll):
//   { action: "period", period?: { start, end } }   payroll.view: the pay periods and, for one
//        period, everyone on payroll (stored payroll or worked out now; nothing is stored)
//   { action: "release", staffId, periodStart, payment, expectedNetPay?, proof? }   payroll.release:
//        pays a period nobody touched yet (its payroll is stored first, once). A salary may be
//        paid before the period ends (early payment); never with a future payment date.
//        expectedNetPay: refused if the take-home changed since the Owner looked.
// Owner-pilot simplification batch:
//   { action: "editLine", payrollId, lineId, changes: { amount?, description? } }   payroll.manage (a bonus or a
//        manual deduction on an unpaid payroll; generated lines change at their source)
//   { action: "correctPayroll", payrollId, change: { op: "line" | "advance" | "prepaid", ... }, reason }
//        payroll.release (Owner-pilot polish: a PAID payroll's breakdown, line by
//        line; the payment record is never changed by it)
//   { action: "correctPayment", payrollId, correction: { paidDate?, method?, reference?, amount? }, reason }
//        payroll.release: a paid salary is corrected with a reason, before / after kept, never erased
//   { action: "period", ..., staffId? }   one helper's periods only
// 13th month = 1/12 of the year's basic pay, never more than what's left.
// Counts, base pay, deductions and net pay are computed by the server. A
// release returns the employee's one-time receipt link token ONCE. Reads go
// straight to Firestore (payroll.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { changeOverpayment, payAdditional, voidPayroll, listVoided, editPayrollLine, correctPayment, correctPayroll, payrollPeriodView, preparePayroll, prepareEligible, addDeduction, removeDeduction, deferAdvance, deleteDraftPayroll, releaseSalary, newReceiptLink, addAddition, removeAddition, thirteenthMonthSummary, attachSalaryProof, readSalaryProof, resolveSalaryDispute } from "./_lib/payroll.js";

const M = "payroll.manage";
const R = "payroll.release";
export const createPayrollHandler = (deps) =>
  payrollActionHandler("payroll", {
    ...deps,
    actions: {
      prepare: { permission: M, created: true, fields: ["action", "staffId", "periodStart"], run: (c, b) => preparePayroll({ ...c, staffId: b.staffId, periodStart: b.periodStart }) },
      // Owner-pilot fix: everyone on payroll for the period that includes asOf.
      prepareAll: { permission: M, fields: ["action", "asOf"], run: (c, b) => prepareEligible({ ...c, asOf: b.asOf ?? null }) },
      addDeduction: { permission: M, keyed: true, fields: ["action", "payrollId", "deduction"], run: (c, b) => addDeduction({ ...c, payrollId: b.payrollId, deduction: b.deduction, idempotencyKey: b.idempotencyKey }) },
      removeDeduction: { permission: M, fields: ["action", "payrollId", "deductionId"], run: (c, b) => removeDeduction({ ...c, payrollId: b.payrollId, deductionId: b.deductionId }) },
      deferAdvance: { permission: M, fields: ["action", "payrollId", "advanceId"], run: (c, b) => deferAdvance({ ...c, payrollId: b.payrollId, advanceId: b.advanceId }) },
      deleteDraft: { permission: M, fields: ["action", "payrollId"], run: (c, b) => deleteDraftPayroll({ ...c, payrollId: b.payrollId }) },
      period: { permission: "payroll.view", fields: ["action", "period", "staffId"], run: async (c, b) => ({ view: await payrollPeriodView({ ...c, period: b.period ?? null, staffId: b.staffId ?? null }) }) },
      // Owner-pilot change: void a PAID payroll (reason required; reversals kept).
      // Owner-pilot refinement: salary overpayment (keep / move / repay / waive) and additional salary due.
      overpayment: { permission: R, fields: ["action", "payrollId", "change"], run: (c, b) => changeOverpayment({ ...c, payrollId: b.payrollId, change: b.change }) },
      payAdditional: { permission: R, fields: ["action", "payrollId", "payment"], run: (c, b) => payAdditional({ ...c, payrollId: b.payrollId, payment: b.payment ?? {} }) },
      void: { permission: R, fields: ["action", "payrollId", "reason"], run: (c, b) => voidPayroll({ ...c, payrollId: b.payrollId, reason: b.reason }) },
      voided: { permission: "payroll.view", fields: ["action", "staffId"], run: async (c, b) => ({ voided: await listVoided({ tenant: c.tenant, kind: "payroll", staffId: b.staffId ?? null }) }) },
      editLine: { permission: M, fields: ["action", "payrollId", "lineId", "changes"], run: (c, b) => editPayrollLine({ ...c, payrollId: b.payrollId, lineId: b.lineId, changes: b.changes }) },
      correctPayroll: { permission: R, fields: ["action", "payrollId", "change", "reason"], run: (c, b) => correctPayroll({ ...c, payrollId: b.payrollId, change: b.change, reason: b.reason }) },
      correctPayment: { permission: R, fields: ["action", "payrollId", "correction", "reason"], run: (c, b) => correctPayment({ ...c, payrollId: b.payrollId, correction: b.correction, reason: b.reason }) },
      release: {
        permission: R,
        fields: ["action", "payrollId", "staffId", "periodStart", "payment", "proof", "expectedNetPay"],
        run: (c, b) => releaseSalary({ ...c, payrollId: b.payrollId ?? null, staffId: b.payrollId ? null : b.staffId ?? null, periodStart: b.periodStart ?? null, release: b.payment, proof: b.proof ?? null, expectedNetPay: b.expectedNetPay ?? null }),
      },
      addAddition: { permission: M, keyed: true, fields: ["action", "payrollId", "addition"], run: (c, b) => addAddition({ ...c, payrollId: b.payrollId, addition: b.addition, idempotencyKey: b.idempotencyKey }) },
      removeAddition: { permission: M, fields: ["action", "payrollId", "additionId"], run: (c, b) => removeAddition({ ...c, payrollId: b.payrollId, additionId: b.additionId }) },
      thirteenth: { permission: "payroll.view", fields: ["action", "staffId", "year"], run: (c, b) => thirteenthMonthSummary({ ...c, staffId: b.staffId, year: b.year }) },
      attachProof: { permission: R, fields: ["action", "payrollId", "proof"], run: (c, b) => attachSalaryProof({ ...c, businessId: c.businessId, payrollId: b.payrollId, proof: b.proof }) },
      proof: { permission: "payroll.view", fields: ["action", "payrollId"], run: async (c, b) => ({ proof: await readSalaryProof({ ...c, businessId: c.businessId, payrollId: b.payrollId }) }) },
      resolveDispute: { permission: R, fields: ["action", "payrollId", "note"], run: (c, b) => resolveSalaryDispute({ ...c, payrollId: b.payrollId, note: b.note }) },
      newReceiptLink: { permission: R, fields: ["action", "payrollId"], run: (c, b) => newReceiptLink({ ...c, payrollId: b.payrollId }) },
    },
  });

export const handler = createPayrollHandler({ getAdmin });
