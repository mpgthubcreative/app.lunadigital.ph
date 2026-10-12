// POST /api/attendance   (Phase 14: Attendance module)
//   { action: "set", staffId, date, status: "present" | "absent" | "official_leave" | "unpaid_leave" | "rest_day", note? }   attendance.edit
//   { action: "decide", requestId, decision: { decision: "approve" | "reject", note? } }  attendance.edit (Phase 18.6)
//   { action: "decideMany", requestIds: [...], decision }                   attendance.edit (Approve all / Reject all)
// Owner-pilot simplification batch (the Owner records attendance):
//   { action: "setMany", staffId, days: [{ date, status }], reason? }    attendance.edit (one helper, several days)
//   { action: "review", staffId?, periodStart? }                         attendance.view (open reports, legacy
//        requests, the helper's confirmation of that period)
//   { action: "resolveCorrection", correctionId, note? }                 attendance.edit
// official_leave is shown as "Paid Leave". Leave and rest days may be
// planned ahead; Present / Absent only up to today.
// One line per person per business-local day; Luna computes payable days
// and amounts (and moves an unpaid payroll for that period). Reads go
// straight to Firestore (attendance.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { setAttendance, decideAttendanceRequest, decideAttendanceRequests, setAttendanceMany, attendanceReview, resolveCorrection } from "./_lib/payroll.js";

export const createAttendanceHandler = (deps) =>
  payrollActionHandler("attendance", {
    ...deps,
    actions: {
      set: { permission: "attendance.edit", fields: ["action", "staffId", "date", "status", "note", "reason"], run: (c, b) => setAttendance({ ...c, input: { staffId: b.staffId, date: b.date, status: b.status, note: b.note, reason: b.reason } }) },
      decide: { permission: "attendance.edit", fields: ["action", "requestId", "decision"], run: (c, b) => decideAttendanceRequest({ ...c, requestId: b.requestId, decision: b.decision }) },
      decideMany: { permission: "attendance.edit", fields: ["action", "requestIds", "decision"], run: (c, b) => decideAttendanceRequests({ ...c, requestIds: b.requestIds, decision: b.decision }) },
      setMany: { permission: "attendance.edit", fields: ["action", "staffId", "days", "reason"], run: (c, b) => setAttendanceMany({ ...c, staffId: b.staffId, days: b.days, reason: typeof b.reason === "string" && b.reason.trim() ? b.reason : null }) },
      review: { permission: "attendance.view", fields: ["action", "staffId", "periodStart"], run: async (c, b) => ({ review: await attendanceReview({ tenant: c.tenant, staffId: b.staffId ?? null, periodStart: b.periodStart ?? null }) }) },
      resolveCorrection: { permission: "attendance.edit", fields: ["action", "correctionId", "note"], run: (c, b) => resolveCorrection({ ...c, correctionId: b.correctionId, note: b.note ?? null }) },
    },
  });

export const handler = createAttendanceHandler({ getAdmin });
