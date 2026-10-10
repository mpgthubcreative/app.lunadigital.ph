// POST /api/attendance   (Phase 14: Attendance module)
//   { action: "set", staffId, date, status: "present" | "absent" | "official_leave" | "unpaid_leave" | "rest_day", note? }   attendance.edit
//   { action: "decide", requestId, decision: { decision: "approve" | "reject", note? } }  attendance.edit (Phase 18.6)
// official_leave is shown as "Paid Leave". Leave and rest days may be
// planned ahead; Present / Absent only up to today.
// One line per person per business-local day; Luna computes payable days
// and amounts (and moves an unpaid payroll for that period). Reads go
// straight to Firestore (attendance.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { setAttendance, decideAttendanceRequest } from "./_lib/payroll.js";

export const createAttendanceHandler = (deps) =>
  payrollActionHandler("attendance", {
    ...deps,
    actions: {
      set: { permission: "attendance.edit", fields: ["action", "staffId", "date", "status", "note"], run: (c, b) => setAttendance({ ...c, input: { staffId: b.staffId, date: b.date, status: b.status, note: b.note } }) },
      decide: { permission: "attendance.edit", fields: ["action", "requestId", "decision"], run: (c, b) => decideAttendanceRequest({ ...c, requestId: b.requestId, decision: b.decision }) },
    },
  });

export const handler = createAttendanceHandler({ getAdmin });
