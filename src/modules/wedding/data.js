// Bridal / Wedding (Phase 16) data access for the Wedding screens and the
// Wedding dashboard. Reads go straight to Firestore under the rules with
// the SAME list specs the Excel downloads use (shared/list-queries.js);
// every write goes through the API, which computes spent, remaining,
// supplier paid / balance and the RSVP totals itself.

import { runListQuery } from "../../lib/query.js";
import { getFirestoreLite } from "../../lib/firebase.js";
import { api } from "../../lib/api.js";
import { expensesQuery, weddingSuppliersQuery, supplierPaymentsQuery, weddingTasksQuery, guestsQuery } from "@shared/list-queries.js";
import { TOTALS_DOC_ID } from "@shared/wedding.js";
export { getBudget, listCategories } from "../baby/data.js";

export const PAGE_SIZE = 25;

async function getOne(businessId, collection, id) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, collection, id));
  return snap.exists() ? snap.data() : null;
}
export const getGuestTotals = (businessId) => getOne(businessId, "guestTotals", TOTALS_DOC_ID);
export const getTaskTotals = (businessId) => getOne(businessId, "taskTotals", TOTALS_DOC_ID);

export const listWeddingExpenses = (businessId, filters = {}, { cursor = null, pageSize = PAGE_SIZE } = {}) => runListQuery(businessId, "expenses", expensesQuery(filters), { cursor, pageSize });
export const listSuppliers = (businessId, filters = {}, { cursor = null, pageSize = PAGE_SIZE } = {}) => runListQuery(businessId, "weddingSuppliers", weddingSuppliersQuery(filters), { cursor, pageSize });
// Active suppliers for the pickers (a wedding has a few dozen at most).
export const activeSuppliers = async (businessId) => (await listSuppliers(businessId, { status: "active" }, { pageSize: 200 })).rows;
export const listSupplierPayments = (businessId, filters = {}, { cursor = null, pageSize = PAGE_SIZE } = {}) => runListQuery(businessId, "supplierPayments", supplierPaymentsQuery(filters), { cursor, pageSize });
export const listTasks = (businessId, filters = {}, { today, cursor = null, pageSize = PAGE_SIZE } = {}) => runListQuery(businessId, "weddingTasks", weddingTasksQuery(filters, { today }), { cursor, pageSize });
export const listGuests = (businessId, filters = {}, { cursor = null, pageSize = PAGE_SIZE } = {}) => runListQuery(businessId, "guests", guestsQuery(filters), { cursor, pageSize });

const post = (endpoint, body) => api(endpoint, { method: "POST", body });
export const budgetApi = (body) => post("budget", body);
export const expensesApi = (body) => post("expenses", body);
export const suppliersApi = (body) => post("wedding-suppliers", body);
export const paymentsApi = (body) => post("supplier-payments", body);
export const tasksApi = (body) => post("wedding-tasks", body);
export const guestsApi = (body) => post("guests", body);
