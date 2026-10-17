// Luna Household money (household-payroll v3) data access: Expenses, Bills
// (the Payment Schedule) and Budget & Categories on the shared primitives
// (../baby/data.js), plus the computed month (/api/household-money).
// Every write goes through the API, which keeps Spent / Upcoming itself.

import { api } from "../../lib/api.js";
import { getFirestoreLite } from "../../lib/firebase.js";

export { getBudget, listCategories, listBabyExpenses as listExpenses, listScheduled as listBills, budgetApi, expensesApi, scheduleApi } from "../baby/data.js";

const post = (endpoint, body) => api(endpoint, { method: "POST", body });
// { month, spent, staffPaid, billsRemaining, payrollDue, budget, left, categories, byCategory }
export const householdMonth = async (month = null) => (await api(`household-money${month ? `?month=${encodeURIComponent(month)}` : ""}`)).month;
export const attachExpenseProof = (expenseId, proof) => post("expenses", { action: "attachProof", expenseId, proof });
export const expenseProof = (expenseId) => post("expenses", { action: "proof", expenseId });

// One bill / scheduled expense (for Edit from the Expenses list).
export async function getBill(businessId, scheduleId) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "scheduledPayments", scheduleId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
