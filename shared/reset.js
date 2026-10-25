// Reset Workspace Data (2026-10-21): Settings → Data → Data Management.
// The Owner empties THIS workspace's everyday records and starts again in
// the same workspace. Owner only, checked on the server; they type RESET;
// it's recorded in the audit log. Never touched: the workspace itself (name,
// product, subscription, bills and payments to Luna, trial), its members
// (except kasambahay logins, whose staff records are removed), settings,
// the audit log, usage history, sign-in accounts (Firebase Auth) and every
// other business. A Bridal wedding keeps its Wedding Setup and the
// invitation design Luna made (template, draft / published).
//
// What is removed, by workspace (tenant collections under businesses/{bid}/):

export const RESET_CONFIRM_WORD = "RESET";

// Derived totals, indexes and counters that only describe removed records.
const DERIVED = ["metrics", "financialMetrics", "orderCosts", "spendingMetrics", "reportRollups", "counters", "idempotencyKeys", "storageObjects"];

export const RESET_PLAN = Object.freeze({
  distributor: {
    label: "Luna Distributor",
    removes: ["orders", "orderPayLinks", "payments", "paymentRefs", "products", "productCosts", "skuIndex", "inventoryTransactions", "inventoryTransactionCosts", "customers", "customerPrices", "openingBalances", "setupImports", "expenses", "imports", "reports", ...DERIVED],
    summary: ["Orders and their payments", "Products, stock and stock movements (and costs)", "Customers, their special prices and opening balances", "Expenses", "Dashboard and report totals", "Uploaded files (product photos, payment and expense proofs)"],
  },
  "household-payroll": {
    label: "Luna Household",
    removes: ["householdStaff", "attendance", "attendanceRequests", "attendanceCorrections", "attendanceConfirmations", "payrolls", "voidedPayrolls", "advances", "voidedAdvances", "expenses", "expenseCategories", "budgets", "scheduledPayments", "groceryItems", "groceryLists", "providers", ...DERIVED],
    summary: ["Household staff (and their kasambahay logins)", "Attendance and requests", "Payroll, salary receipts and advances", "Expenses, bills, categories and recurring items", "Grocery List", "Providers", "Uploaded files (expense and salary proofs)"],
    removesStaffLogins: true,
  },
  "bridal-expense": {
    label: "Luna Bridal",
    removes: ["guests", "guestTotals", "guestInvites", "weddingSuppliers", "supplierPayments", "weddingTasks", "taskTotals", "weddingProgram", "weddingCrewMeals", "crewMealSettings", "weddingGallery", "weddingPhotos", "expenses", "expenseCategories", "budgets", "providers", ...DERIVED],
    summary: ["Guests, RSVPs, tables, wedding roles and guest invitation links", "Suppliers and supplier payments", "Tasks", "Expenses and categories", "Music & Program and Crew Meals", "Photo gallery", "Uploaded files"],
    keeps: ["Wedding Setup (couple, date, venue, story)", "The invitation design and template (draft and published)"],
  },
  "baby-expense": {
    label: "Baby",
    removes: ["expenses", "expenseCategories", "budgets", "scheduledPayments", "providers", ...DERIVED],
    summary: ["Budget, categories and expenses", "Payment schedule", "Providers", "Uploaded files"],
  },
});

// Subcollections inside removed records (deleted with them).
export const RESET_NESTED = Object.freeze({ imports: ["rows"] });

// Always kept, for every workspace.
export const RESET_KEEPS = Object.freeze(["The workspace, its product and subscription (bills and payments to Luna, the free trial)", "Members and their sign-in accounts", "Settings", "The audit log (with this reset)", "Usage history"]);

export const resetPlanFor = (workspaceTemplateId) => RESET_PLAN[workspaceTemplateId] ?? null;
