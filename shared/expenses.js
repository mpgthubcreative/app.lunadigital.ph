// Expenses vocabulary (module approved in Phase 5, built in Phase 10).
// Nothing reads or writes expenses yet; this fixes the record shape and the
// starting categories so the dashboard and reports can be designed around
// them now.
//
// Future record: businesses/{bid}/expenses/{expenseId}
//   date              business-local YYYY-MM-DD the expense belongs to
//   categoryId        one of the business's categories (see below)
//   amount            integer centavos, > 0
//   payee             vendor / payee name (optional)
//   paymentMethod     cash | bank_transfer | gcash | maya | card | other
//   referenceNumber   optional (OR no., invoice no., transfer ref)
//   notes             optional
//   recurring         null | { frequency: "monthly" | "weekly", ... }
//   receipt           later (Storage tenants/{bid}/expenses/...), not Phase 10 scope yet
//   status            recorded | voided   (expenses.delete voids; the record stays for audit)
//   createdBy, createdAt, updatedBy, updatedAt
// Every create, update or void adjusts financialMetrics/{date}.operatingExpenses
// in the same transaction (netlify/functions/_lib/metrics.js).
//
// Categories are configurable per business (settings/expenseCategories,
// seeded from the defaults below). Ids are stable so a renamed category
// keeps its history.

export const DEFAULT_EXPENSE_CATEGORIES = Object.freeze([
  { id: "rent", label: "Rent" },
  { id: "utilities", label: "Utilities" },
  { id: "salaries", label: "Salaries / wages" },
  { id: "delivery", label: "Delivery" },
  { id: "fuel", label: "Fuel" },
  { id: "packaging", label: "Packaging" },
  { id: "marketing", label: "Marketing" },
  { id: "supplies", label: "Supplies" },
  { id: "repairs", label: "Repairs / maintenance" },
  { id: "software", label: "Software / subscriptions" },
  { id: "misc", label: "Miscellaneous" },
]);

export const EXPENSE_PAYMENT_METHODS = Object.freeze(["cash", "bank_transfer", "gcash", "maya", "card", "other"]);
export const EXPENSE_STATUSES = Object.freeze(["recorded", "voided"]);
