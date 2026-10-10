// POST /api/advances   (Phase 14: Advances module)
//   { action: "create", advance: { staffId, date, amount, description? } }           advances.manage
//   { action: "update", advanceId, changes: { date?, amount?, description? } }       advances.manage (Not Yet Paid only)
//   { action: "markPaid", advanceId, release: { paidDate?, method?, reference? } }   advances.manage
//   { action: "delete", advanceId }                                                  advances.manage (Not Yet Paid only)
//   { action: "decide", advanceId, decision: { decision, note? }, approval?: { amount?, installment? } }  advances.manage (Phase 18.6: a staff request)
// installment (optional, centavos): how much each payroll deducts until it's repaid.
// Status is a controlled value (Not Yet Paid / Paid), never free text. A
// paid advance is deducted in full from the person's next payroll.

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { createAdvance, updateAdvance, markAdvancePaid, deleteAdvance, decideAdvanceRequest } from "./_lib/payroll.js";

const P = "advances.manage";
export const createAdvancesHandler = (deps) =>
  payrollActionHandler("advances", {
    ...deps,
    actions: {
      create: { permission: P, created: true, fields: ["action", "advance"], run: (c, b) => createAdvance({ ...c, input: b.advance }) },
      update: { permission: P, fields: ["action", "advanceId", "changes"], run: (c, b) => updateAdvance({ ...c, advanceId: b.advanceId, changes: b.changes }) },
      markPaid: { permission: P, fields: ["action", "advanceId", "release"], run: (c, b) => markAdvancePaid({ ...c, advanceId: b.advanceId, release: b.release ?? {} }) },
      delete: { permission: P, fields: ["action", "advanceId"], run: (c, b) => deleteAdvance({ ...c, advanceId: b.advanceId }) },
      decide: { permission: P, fields: ["action", "advanceId", "decision", "approval"], run: (c, b) => decideAdvanceRequest({ ...c, advanceId: b.advanceId, decision: b.decision, approval: b.approval ?? {} }) },
    },
  });

export const handler = createAdvancesHandler({ getAdmin });
