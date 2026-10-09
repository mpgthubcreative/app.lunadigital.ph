// Baby Expense Tracker (Phase 15) data access for the Budget, Baby
// Expenses, Payment Schedule and Providers screens and the Baby dashboard.
// Reads go straight to Firestore under the rules with the SAME list specs
// the Excel downloads use (shared/list-queries.js); every write goes
// through the API, which computes Spent / Remaining / Upcoming itself.

import { runListQuery } from "../../lib/query.js";
import { getFirestoreLite } from "../../lib/firebase.js";
import { api } from "../../lib/api.js";
import { expensesQuery, categoriesQuery, providersQuery, scheduledPaymentsQuery } from "@shared/list-queries.js";
import { BUDGET_DOC_ID, MAX_CATEGORIES, sortCategories } from "@shared/baby.js";

export const PAGE_SIZE = 25;

// budgets/current, or null before anything is recorded.
export async function getBudget(businessId) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "budgets", BUDGET_DOC_ID));
  return snap.exists() ? snap.data() : null;
}

// Every category (a budget has at most MAX_CATEGORIES), display order.
export const listCategories = async (businessId) => sortCategories((await runListQuery(businessId, "expenseCategories", categoriesQuery(), { pageSize: MAX_CATEGORIES })).rows);

export const listBabyExpenses = (businessId, filters = {}, { cursor = null, pageSize = PAGE_SIZE } = {}) => runListQuery(businessId, "expenses", expensesQuery(filters), { cursor, pageSize });
export const listProviders = (businessId, filters = {}, { cursor = null, pageSize = PAGE_SIZE } = {}) => runListQuery(businessId, "providers", providersQuery(filters), { cursor, pageSize });
// Active providers for the pickers (a family's directory is small).
export const activeProviders = async (businessId) => (await listProviders(businessId, { status: "active" }, { pageSize: 200 })).rows;
export const listScheduled = (businessId, filters = {}, { cursor = null, pageSize = PAGE_SIZE } = {}) => runListQuery(businessId, "scheduledPayments", scheduledPaymentsQuery(filters), { cursor, pageSize });

const post = (endpoint, body) => api(endpoint, { method: "POST", body });
export const budgetApi = (body) => post("budget", body);
export const expensesApi = (body) => post("expenses", body);
export const providersApi = (body) => post("providers", body);
export const scheduleApi = (body) => post("schedule", body);
