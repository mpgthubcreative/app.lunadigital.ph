// Export dataset descriptors (Phase 12.5): which module, permissions and
// filters each download has. The filters are exactly the list's filters
// (shared/list-queries.js); the server validates them against these
// schemas and refuses anything else. Columns and queries live with the
// server code for each dataset (netlify/functions/_lib/exports/).
//
// Each workspace adds descriptors for its own modules when they are built
// (Phase 14: household payroll; Phase 15: baby). The module gate keeps them
// inside their workspace: a Distributor can never download payroll, and the
// reverse. `workspaces` (optional) narrows a dataset further where one
// module serves several workspaces with different meanings (Expenses:
// Distributor operating expenses vs Baby Expenses).

import { filter, EXPORT_PERMISSION } from "./exports.js";
import { FULFILLMENT_STATUSES } from "./orders.js";
import { ORDER_PAYMENT_STATUSES, PAYMENT_STATES, PAYMENT_METHOD_IDS } from "./payments.js";
import { ORDER_SOURCE_IDS } from "./orders.js";
import { EXPENSE_CATEGORY_IDS, EXPENSE_METHOD_IDS } from "./expenses.js";
import { PRODUCT_STATUSES } from "./inventory.js";
import { CUSTOMER_STATUSES } from "./customers.js";
import { ATTENDANCE_STATUS_IDS, PAYROLL_STATUSES, RECEIPT_STATUSES, ADVANCE_STATUSES, STAFF_STATUSES } from "./payroll.js";
import { CATEGORY_STATUSES, PROVIDER_STATUSES, PROVIDER_TYPE_IDS, SCHEDULE_STATUS_IDS } from "./baby.js";
import { SUPPLIER_SERVICE_IDS, SUPPLIER_STATUSES, SUPPLIER_PAYMENT_STATUS_IDS, TASK_STATUS_IDS, TASK_PRIORITY_IDS, RSVP_STATUS_IDS, GUEST_SIDE_IDS } from "./wedding.js";

const range = { from: filter.day(), to: filter.day() };
const RANGE_LABELS = { from: "From", to: "To" };

export const EXPORT_DATASETS = Object.freeze({
  dashboard: {
    id: "dashboard",
    label: "Dashboard",
    module: "dashboard",
    view: ["dashboard.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: range,
    rangeRequired: true,
    filterLabels: RANGE_LABELS,
  },
  reports: {
    id: "reports",
    label: "Report",
    module: "reports",
    view: ["reports.view"],
    // Reports keeps its own export permission (Phase 11 CSV behaviour).
    exportPermission: "reports.export",
    filters: range,
    rangeRequired: true,
    filterLabels: RANGE_LABELS,
  },
  orders: {
    id: "orders",
    label: "Orders",
    module: "orders",
    view: ["orders.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { fulfillmentStatus: filter.oneOf(Object.keys(FULFILLMENT_STATUSES)), paymentStatus: filter.oneOf(Object.keys(ORDER_PAYMENT_STATUSES)), source: filter.oneOf(ORDER_SOURCE_IDS), ...range },
    filterLabels: { fulfillmentStatus: "Fulfillment", paymentStatus: "Payment", source: "Source", ...RANGE_LABELS },
  },
  payments: {
    id: "payments",
    label: "Payments",
    module: "payments",
    view: ["payments.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { state: filter.oneOf(Object.keys(PAYMENT_STATES)), method: filter.oneOf(PAYMENT_METHOD_IDS), ...range },
    filterLabels: { state: "Status", method: "Method", from: "Received from", to: "Received to" },
  },
  products: {
    id: "products",
    label: "Products",
    module: "inventory",
    view: ["inventory.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { status: filter.oneOf(PRODUCT_STATUSES), lowOnly: filter.flag(), search: filter.text(100), category: filter.text(100) },
    filterLabels: { status: "Status", lowOnly: "Low stock only", search: "Search", category: "Category" },
  },
  inventory: {
    id: "inventory",
    label: "Inventory",
    module: "inventory",
    view: ["inventory.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { status: filter.oneOf(PRODUCT_STATUSES), lowOnly: filter.flag(), search: filter.text(100), category: filter.text(100) },
    filterLabels: { status: "Status", lowOnly: "Low stock only", search: "Search", category: "Category" },
  },
  customers: {
    id: "customers",
    label: "Customers",
    module: "customers",
    view: ["customers.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { status: filter.oneOf(Object.keys(CUSTOMER_STATUSES)), search: filter.text(100) },
    filterLabels: { status: "Status", search: "Search" },
  },
  expenses: {
    id: "expenses",
    label: "Expenses",
    module: "expenses",
    // The Distributor (operating-expense) columns and fixed categories; Baby
    // Expenses have their own dataset below.
    workspaces: ["distributor"],
    view: ["expenses.view"],
    exportPermission: EXPORT_PERMISSION,
    // Active expenses only: removed ones are an audit view, not an export.
    filters: { status: filter.oneOf(["active"]), category: filter.oneOf(EXPENSE_CATEGORY_IDS), method: filter.oneOf(EXPENSE_METHOD_IDS), search: filter.text(100), ...range },
    filterLabels: { status: "Status", category: "Category", method: "Method", search: "Search", ...RANGE_LABELS },
  },

  // ---- Household / Kasambahay Payroll (Phase 14) ----
  householdStaff: {
    id: "householdStaff",
    label: "Household Staff",
    module: "household",
    view: ["household.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { status: filter.oneOf(Object.keys(STAFF_STATUSES)) },
    filterLabels: { status: "Status" },
  },
  attendance: {
    id: "attendance",
    label: "Attendance",
    module: "attendance",
    view: ["attendance.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { staffId: filter.id(), status: filter.oneOf(ATTENDANCE_STATUS_IDS), ...range },
    filterLabels: { staffId: "Employee", status: "Status", ...RANGE_LABELS },
  },
  payroll: {
    id: "payroll",
    label: "Payroll",
    module: "payroll",
    view: ["payroll.view"],
    exportPermission: EXPORT_PERMISSION,
    // from / to: the pay period start.
    filters: { staffId: filter.id(), status: filter.oneOf(Object.keys(PAYROLL_STATUSES)), receiptStatus: filter.oneOf(Object.keys(RECEIPT_STATUSES)), ...range },
    filterLabels: { staffId: "Employee", status: "Salary", receiptStatus: "Receipt", from: "Periods from", to: "Periods to" },
  },
  advances: {
    id: "advances",
    label: "Advances",
    module: "advances",
    view: ["advances.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { staffId: filter.id(), status: filter.oneOf(Object.keys(ADVANCE_STATUSES)), ...range },
    filterLabels: { staffId: "Employee", status: "Status", ...RANGE_LABELS },
  },

  // ---- Baby Expense Tracker (Phase 15) ----
  budget: {
    id: "budget",
    label: "Budget",
    module: "budget",
    workspaces: ["baby-expense"],
    view: ["budget.view"],
    exportPermission: EXPORT_PERMISSION,
    // The budget as of export time: overall + one line per category.
    filters: { category: filter.id(), status: filter.oneOf(Object.keys(CATEGORY_STATUSES)) },
    filterLabels: { category: "Category", status: "Status" },
  },
  babyExpenses: {
    id: "babyExpenses",
    label: "Baby Expenses",
    module: "expenses",
    workspaces: ["baby-expense"],
    view: ["expenses.view"],
    exportPermission: EXPORT_PERMISSION,
    // Active only, like the Distributor expenses export.
    filters: { status: filter.oneOf(["active"]), category: filter.id(), providerId: filter.id(), method: filter.oneOf(EXPENSE_METHOD_IDS), search: filter.text(100), ...range },
    filterLabels: { status: "Status", category: "Category", providerId: "Provider", method: "Method", search: "Search", ...RANGE_LABELS },
  },
  providers: {
    id: "providers",
    label: "Providers",
    module: "providers",
    workspaces: ["baby-expense"],
    view: ["providers.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { status: filter.oneOf(Object.keys(PROVIDER_STATUSES)), type: filter.oneOf(PROVIDER_TYPE_IDS), search: filter.text(100) },
    filterLabels: { status: "Status", type: "Type", search: "Search" },
  },
  paymentSchedule: {
    id: "paymentSchedule",
    label: "Payment Schedule",
    module: "schedule",
    workspaces: ["baby-expense"],
    view: ["schedule.view"],
    exportPermission: EXPORT_PERMISSION,
    // from / to: the due date.
    filters: { status: filter.oneOf(SCHEDULE_STATUS_IDS), category: filter.id(), providerId: filter.id(), ...range },
    filterLabels: { status: "Status", category: "Category", providerId: "Provider", from: "Due from", to: "Due to" },
  },

  // ---- Bridal / Wedding (Phase 16) ----
  weddingBudget: {
    id: "weddingBudget",
    label: "Wedding Budget",
    module: "budget",
    workspaces: ["bridal-expense"],
    view: ["budget.view"],
    exportPermission: EXPORT_PERMISSION,
    // The budget as of export time: overall + one line per category.
    filters: { category: filter.id(), status: filter.oneOf(Object.keys(CATEGORY_STATUSES)) },
    filterLabels: { category: "Category", status: "Status" },
  },
  weddingExpenses: {
    id: "weddingExpenses",
    label: "Wedding Expenses",
    module: "expenses",
    workspaces: ["bridal-expense"],
    view: ["expenses.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { status: filter.oneOf(["active"]), category: filter.id(), supplierId: filter.id(), method: filter.oneOf(EXPENSE_METHOD_IDS), search: filter.text(100), ...range },
    filterLabels: { status: "Status", category: "Category", supplierId: "Supplier", method: "Method", search: "Search", ...RANGE_LABELS },
  },
  weddingSuppliers: {
    id: "weddingSuppliers",
    label: "Wedding Suppliers",
    module: "vendors",
    workspaces: ["bridal-expense"],
    view: ["vendors.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { status: filter.oneOf(Object.keys(SUPPLIER_STATUSES)), service: filter.oneOf(SUPPLIER_SERVICE_IDS), search: filter.text(100) },
    filterLabels: { status: "Status", service: "Service", search: "Search" },
  },
  supplierPayments: {
    id: "supplierPayments",
    label: "Supplier Payments",
    module: "vendorpayments",
    workspaces: ["bridal-expense"],
    view: ["vendorpayments.view"],
    exportPermission: EXPORT_PERMISSION,
    // from / to: the due date.
    filters: { status: filter.oneOf(SUPPLIER_PAYMENT_STATUS_IDS), supplierId: filter.id(), category: filter.id(), ...range },
    filterLabels: { status: "Status", supplierId: "Supplier", category: "Category", from: "Due from", to: "Due to" },
  },
  weddingTasks: {
    id: "weddingTasks",
    label: "Wedding Tasks",
    module: "tasks",
    workspaces: ["bridal-expense"],
    view: ["tasks.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { state: filter.oneOf(["open", "overdue", "all"]), status: filter.oneOf(TASK_STATUS_IDS), categoryKey: filter.text(40), assigneeKey: filter.text(60), priority: filter.oneOf(TASK_PRIORITY_IDS), ...range },
    filterLabels: { state: "Show", status: "Status", categoryKey: "Category", assigneeKey: "Assigned to", priority: "Priority", from: "Due from", to: "Due to" },
  },
  guests: {
    id: "guests",
    label: "Guests & RSVP",
    module: "guests",
    workspaces: ["bridal-expense"],
    view: ["guests.view"],
    exportPermission: EXPORT_PERMISSION,
    filters: { rsvp: filter.oneOf(RSVP_STATUS_IDS), side: filter.oneOf(GUEST_SIDE_IDS), invited: filter.oneOf(["sent", "not_sent"]), search: filter.text(100) },
    filterLabels: { rsvp: "RSVP", side: "Side", invited: "Invitation", search: "Search" },
  },
});

export const EXPORT_DATASET_IDS = Object.freeze(Object.keys(EXPORT_DATASETS));
