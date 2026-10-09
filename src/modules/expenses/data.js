// Expense reads, straight from Firestore as the signed-in user (rules:
// membership + Expenses module + expenses.view). Every query is
// tenant-scoped, filtered and limited; the browser never loads the whole
// expense history. All writes go through POST /api/expenses.

import { runListQuery } from "../../lib/query.js";
import { expensesQuery } from "@shared/list-queries.js";

export const PAGE_SIZE = 25;

// filters: { status ("active" | "removed"), from?, to? (YYYY-MM-DD),
// category?, method?, search? (payee prefix, or an exact reference) }.
// Newest date first (shared/list-queries.js: the export reads the same query).
export async function listExpenses(businessId, { filters = {}, cursor = null, pageSize = PAGE_SIZE } = {}) {
  return runListQuery(businessId, "expenses", expensesQuery(filters), { cursor, pageSize });
}
