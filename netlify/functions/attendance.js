// POST /api/attendance   (Phase 14: Attendance module)
//   { action: "set", staffId, date, status: "present" | "absent" | "official_leave", note? }   attendance.edit
// One line per person per business-local day; Luna computes payable days
// and amounts (and moves an unpaid payroll for that period). Reads go
// straight to Firestore (attendance.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { setAttendance } from "./_lib/payroll.js";

export const createAttendanceHandler = (deps) =>
  payrollActionHandler("attendance", {
    ...deps,
    actions: {
      set: { permission: "attendance.edit", fields: ["action", "staffId", "date", "status", "note"], run: (c, b) => setAttendance({ ...c, input: { staffId: b.staffId, date: b.date, status: b.status, note: b.note } }) },
    },
  });

export const handler = createAttendanceHandler({ getAdmin });
