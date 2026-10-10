// Household payroll (Phase 14) data access for the Household Staff,
// Attendance, Payroll and Advances screens. Reads go straight to Firestore
// under the rules with the SAME list specs the Excel downloads use
// (shared/list-queries.js); every write goes through the API.

import { runListQuery } from "../../lib/query.js";
import { getFirestoreLite } from "../../lib/firebase.js";
import { api } from "../../lib/api.js";
import { householdStaffQuery, attendanceQuery, payrollsQuery, advancesQuery } from "@shared/list-queries.js";

export const listStaff = (businessId, filters = {}, { cursor = null, pageSize = 50 } = {}) => runListQuery(businessId, "householdStaff", householdStaffQuery(filters), { cursor, pageSize });
// Everyone active (a household has a handful of people).
export const activeStaff = async (businessId) => (await listStaff(businessId, { status: "active" }, { pageSize: 100 })).rows;
export const listAttendance = (businessId, filters = {}, { cursor = null, pageSize = 31 } = {}) => runListQuery(businessId, "attendance", attendanceQuery(filters), { cursor, pageSize });
export const listPayrolls = (businessId, filters = {}, { cursor = null } = {}) => runListQuery(businessId, "payrolls", payrollsQuery(filters), { cursor, pageSize: 25 });
export const listAdvances = (businessId, filters = {}, { cursor = null, pageSize = 25 } = {}) => runListQuery(businessId, "advances", advancesQuery(filters), { cursor, pageSize });

export async function getPayroll(businessId, payrollId) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "payrolls", payrollId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

const post = (endpoint, body) => api(endpoint, { method: "POST", body });
export const staffApi = (body) => post("household-staff", body);
export const setAttendance = (staffId, date, status, note) => post("attendance", { action: "set", staffId, date, status, ...(note ? { note } : {}) });
export const payrollApi = (body) => post("payroll", body);
export const advancesApi = (body) => post("advances", body);
