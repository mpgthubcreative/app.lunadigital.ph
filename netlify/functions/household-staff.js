// POST /api/household-staff   (Phase 14: Household Staff module)
//   { action: "create", staff: { name, dailyWage, payCycle, position?, phone?, startDate?, notes? } }   household.manage
//   { action: "update", staffId, changes: { ...any of the above } }                                   household.manage
//   { action: "setStatus", staffId, status: "active" | "inactive" }                                   household.manage
// dailyWage is integer centavos. Reads go straight to Firestore (household.view).
// Phase 18.6, the person's own login (household.manage + users.manage):
//   { action: "createLogin", staffId, email? }   -> activation link token, shown once
//   { action: "newLink", staffId }               -> a new link (old one stops; signs them out)
//   { action: "setLogin", staffId, enabled }     -> turn the login off / on

import { getAdmin } from "./_lib/firebase-admin.js";
import { payrollActionHandler } from "./_lib/payroll-http.js";
import { createStaff, updateStaff, setStaffStatus, deleteStaff } from "./_lib/payroll.js";
import { createStaffLogin, newStaffActivation, setStaffLogin } from "./_lib/staff-accounts.js";
import { RequestError } from "./_lib/http.js";

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
      createLogin: { permission: P, also: ["users.manage"], created: true, fields: ["action", "staffId", "email"], run: (c, b) => createStaffLogin({ ...c, staffId: b.staffId, email: b.email ?? null }) },
      newLink: { permission: P, also: ["users.manage"], fields: ["action", "staffId"], run: (c, b) => newStaffActivation({ ...c, staffId: b.staffId }) },
      setLogin: {
        permission: P,
        also: ["users.manage"],
        fields: ["action", "staffId", "enabled"],
        run: (c, b) => {
          if (typeof b.enabled !== "boolean") throw new RequestError("invalid-request", "Invalid request.", 400);
          return setStaffLogin({ ...c, staffId: b.staffId, enabled: b.enabled });
        },
      },
    },
  });

export const handler = createHouseholdStaffHandler({ getAdmin });
