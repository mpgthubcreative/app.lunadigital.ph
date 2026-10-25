// POST /api/advances   (Phase 14: Advances module)
//   { action: "create", advance: { staffId, date, amount, description? } }           advances.manage
//   { action: "update", advanceId, changes: { date?, amount?, description? } }       advances.manage (Not Yet Paid only)
//   { action: "markPaid", advanceId, release: { paidDate?, method?, reference? } }   advances.manage
//   { action: "delete", advanceId }                                                  advances.manage (Not Yet Paid only)
//   { action: "decide", advanceId, decision: { decision, note? }, approval?: { amount?, installment? } }  advances.manage (Phase 18.6: a staff request)
// Owner-pilot simplification batch (Owner-led advances, repayment plans):
//   { action: "give", advance: { staffId, date, amount, description?, installment?, method?, reference? }, proof? }
//        records AND releases in one step (limit checked), plan from the next unpaid payroll
//   { action: "markPaid", ..., proof? }                       optional GCash / bank screenshot or PDF
//   { action: "schedule", advanceId, schedule: [{ periodStart, amount, state? }] }   the repayment plan
//   { action: "repay", advanceId, repayment: { amount, date?, method?, reference?, note?, notTakenPeriod? } }
//        money given back outside payroll (reduces what's owed)
//   { action: "proof", advanceId } (advances.view) · { action: "attachProof", advanceId, proof }
// A plan never changes the debt; only paid payroll deductions and repayments do.
// installment (optional, centavos): how much each payroll deducts until it's repaid.
// Status is a controlled value (Not Yet Paid / Paid), never free text. A
// paid advance is deducted in full from the person's next payroll.

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { voidAdvance, listVoided, createAdvance, updateAdvance, markAdvancePaid, deleteAdvance, decideAdvanceRequest, giveAdvance, setAdvanceSchedule, recordAdvanceRepayment, readAdvanceProof, attachAdvanceProof } from "./_lib/payroll.js";

const P = "advances.manage";
export const createAdvancesHandler = (deps) =>
  payrollActionHandler("advances", {
    ...deps,
    actions: {
      create: { permission: P, created: true, keyed: true, fields: ["action", "advance"], run: (c, b) => createAdvance({ ...c, input: b.advance, idempotencyKey: b.idempotencyKey }) },
      update: { permission: P, fields: ["action", "advanceId", "changes"], run: (c, b) => updateAdvance({ ...c, advanceId: b.advanceId, changes: b.changes }) },
      markPaid: { permission: P, fields: ["action", "advanceId", "release", "proof"], run: (c, b) => markAdvancePaid({ ...c, advanceId: b.advanceId, release: b.release ?? {}, proof: b.proof ?? null }) },
      // Owner-pilot change: void a GIVEN advance (reason required; reversals kept).
      void: { permission: P, fields: ["action", "advanceId", "reason"], run: (c, b) => voidAdvance({ ...c, advanceId: b.advanceId, reason: b.reason }) },
      voided: { permission: "advances.view", fields: ["action", "staffId"], run: async (c, b) => ({ voided: await listVoided({ tenant: c.tenant, kind: "advance", staffId: b.staffId ?? null }) }) },
      give: { permission: P, created: true, keyed: true, fields: ["action", "advance", "proof"], run: (c, b) => giveAdvance({ ...c, input: b.advance, proof: b.proof ?? null, idempotencyKey: b.idempotencyKey }) },
      schedule: { permission: P, fields: ["action", "advanceId", "schedule"], run: (c, b) => setAdvanceSchedule({ ...c, advanceId: b.advanceId, schedule: b.schedule }) },
      repay: { permission: P, keyed: true, fields: ["action", "advanceId", "repayment"], run: (c, b) => recordAdvanceRepayment({ ...c, advanceId: b.advanceId, repayment: b.repayment, idempotencyKey: b.idempotencyKey }) },
      proof: { permission: "advances.view", fields: ["action", "advanceId"], run: async (c, b) => ({ proof: await readAdvanceProof({ ...c, businessId: c.businessId, advanceId: b.advanceId }) }) },
      attachProof: { permission: P, fields: ["action", "advanceId", "proof"], run: (c, b) => attachAdvanceProof({ ...c, advanceId: b.advanceId, proof: b.proof }) },
      delete: { permission: P, fields: ["action", "advanceId"], run: (c, b) => deleteAdvance({ ...c, advanceId: b.advanceId }) },
      decide: { permission: P, fields: ["action", "advanceId", "decision", "approval"], run: (c, b) => decideAdvanceRequest({ ...c, advanceId: b.advanceId, decision: b.decision, approval: b.approval ?? {} }) },
    },
  });

export const handler = createAdvancesHandler({ getAdmin });
