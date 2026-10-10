// POST /api/household-staff   (Phase 14: Household Staff module)
//   { action: "create", staff: { name, dailyWage, payCycle, position?, phone?, startDate?, notes? } }   household.manage
//   { action: "update", staffId, changes: { ...any of the above } }                                   household.manage
//   { action: "setStatus", staffId, status: "active" | "inactive" }                                   household.manage
// dailyWage is integer centavos. Reads go straight to Firestore (household.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { createStaff, updateStaff, setStaffStatus, deleteStaff } from "./_lib/payroll.js";

const P = "household.manage";
export const createHouseholdStaffHandler = (deps) =>
  payrollActionHandler("household-staff", {
    ...deps,
    actions: {
      create: { permission: P, created: true, fields: ["action", "staff"], run: (c, b) => createStaff({ ...c, input: b.staff }) },
      update: { permission: P, fields: ["action", "staffId", "changes"], run: (c, b) => updateStaff({ ...c, staffId: b.staffId, changes: b.changes }) },
      setStatus: { permission: P, fields: ["action", "staffId", "status"], run: (c, b) => setStaffStatus({ ...c, staffId: b.staffId, status: b.status }) },
      // Phase 18.5: only someone with no attendance, payroll or advances.
      delete: { permission: P, fields: ["action", "staffId"], run: (c, b) => deleteStaff({ ...c, staffId: b.staffId }) },
    },
  });

export const handler = createHouseholdStaffHandler({ getAdmin });
