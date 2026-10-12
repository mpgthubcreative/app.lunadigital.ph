// /api/me   (Phase 18.6: household staff self-service, their OWN record only)
//   GET [?period=YYYY-MM-DD]                              their attendance this period (or that one), requests,
//                                                         salaries and advances (any self permission)
//   POST { action: "attendance", date, status, note? }    ask for a day's status (attendance.self)
//   POST { action: "attendanceDays", days: [{ date, status }], note? }   several days in one go,
//        all or nothing (attendance.self)
//   POST { action: "advance", amount, reason? }           ask for a cash advance (advances.self)
//   POST { action: "received", payrollId }                "I received my salary" (payroll.self)
//   POST { action: "notReceived", payrollId, note? }      "I didn't receive it" (payroll.self)
// Owner-pilot simplification batch (the helper reviews and confirms):
//   POST { action: "confirmAttendance", periodStart }      "I reviewed my attendance" (attendance.self)
//   POST { action: "reportCorrection", date?, message }    "Something is wrong" (attendance.self)
//   POST { action: "advanceReceived", advanceId }          "I received this advance" (advances.self)
//   POST { action: "proof", kind: "salary" | "advance", recordId }   their OWN proof only
// The staff record is the one linked to the caller's membership
// (member.staffId, server-set). Nothing in the request can point elsewhere.
// Requests change nothing until the Owner approves them.

import { respond, withErrorHandling, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { PAYROLL_STATUS } from "./_lib/payroll-http.js";
import { submitAttendanceRequest, submitAttendanceDays, requestAdvance } from "./_lib/payroll.js";
import { myHousehold, confirmSalaryReceived, reportSalaryNotReceived, confirmAdvanceReceived, myProof } from "./_lib/household-self.js";
import { confirmAttendance, reportCorrection } from "./_lib/payroll.js";
import { PayrollError } from "../../shared/payroll.js";

const SELF = ["attendance.self", "advances.self", "payroll.self"];
const ACTIONS = {
  attendance: { permission: "attendance.self", fields: ["action", "date", "status", "note"], run: (c, b) => submitAttendanceRequest({ ...c, input: { date: b.date, status: b.status, ...(b.note !== undefined ? { note: b.note } : {}) } }) },
  attendanceDays: { permission: "attendance.self", fields: ["action", "days", "note"], run: (c, b) => submitAttendanceDays({ ...c, input: { days: b.days, ...(b.note !== undefined ? { note: b.note } : {}) } }) },
  advance: { permission: "advances.self", fields: ["action", "amount", "reason"], run: (c, b) => requestAdvance({ ...c, input: { amount: b.amount, ...(b.reason !== undefined ? { reason: b.reason } : {}) } }) },
  received: { permission: "payroll.self", fields: ["action", "payrollId"], run: (c, b) => confirmSalaryReceived({ ...c, payrollId: b.payrollId }) },
  notReceived: { permission: "payroll.self", fields: ["action", "payrollId", "note"], run: (c, b) => reportSalaryNotReceived({ ...c, payrollId: b.payrollId, note: b.note ?? null }) },
  confirmAttendance: { permission: "attendance.self", fields: ["action", "periodStart"], run: (c, b) => confirmAttendance({ ...c, periodStart: b.periodStart }) },
  reportCorrection: { permission: "attendance.self", fields: ["action", "date", "message"], run: (c, b) => reportCorrection({ ...c, input: { message: b.message, ...(b.date !== undefined ? { date: b.date } : {}) } }) },
  advanceReceived: { permission: "advances.self", fields: ["action", "advanceId"], run: (c, b) => confirmAdvanceReceived({ ...c, advanceId: b.advanceId }) },
  proof: {
    permission: (b) => (b.kind === "advance" ? "advances.self" : "payroll.self"),
    fields: ["action", "kind", "recordId"],
    run: async (c, b) => ({ proof: await myProof({ tenant: c.tenant, bucket: c.bucket, businessId: c.businessId, staffId: c.staffId, kind: b.kind, recordId: b.recordId }) }),
  },
};

export function createMeHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("me", async (event) => {
    const { db, auth, admin, bucket } = await loadAdmin();
    try {
      if (event.httpMethod === "GET") {
        const ctx = await requireTenant(event, { db, auth });
        if (!SELF.some((p) => ctx.permissions[p] === true)) throw new RequestError("forbidden", "This page is for household staff accounts.", 403);
        return respond(200, { success: true, me: await myHousehold({ db, tenant: ctx.tenant, business: ctx.business, staffId: ctx.member.staffId, now: now(), periodStart: event.queryStringParameters?.period ?? null }) });
      }
      if (event.httpMethod !== "POST") throw new RequestError("method-not-allowed", "Method not allowed.", 405);
      const body = parseJsonBody(event, 4000);
      const action = body && Object.prototype.hasOwnProperty.call(ACTIONS, body.action) ? ACTIONS[body.action] : null;
      if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
      const ctx = await requireTenant(event, { db, auth, permission: typeof action.permission === "function" ? action.permission(body) : action.permission, write: action !== ACTIONS.proof });
      only(body, action.fields);
      const common = { db, bucket, businessId: ctx.businessId, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, business: ctx.business, staffId: ctx.member.staffId, actor: actorOf(ctx), now: now() };
      return respond(200, { success: true, ...(await action.run(common, body)) });
    } catch (err) {
      if (err instanceof PayrollError) throw new RequestError(err.code, err.message, PAYROLL_STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createMeHandler({ getAdmin });
