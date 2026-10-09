// Export dataset descriptors (Phase 12.5): which module, permissions and
// filters each download has. The filters are exactly the list's filters
// (shared/list-queries.js); the server validates them against these
// schemas and refuses anything else. Columns and queries live with the
// server code for each dataset (netlify/functions/_lib/exports/).
//
// New workspaces add their own descriptors (e.g. payroll: module "payroll")
// when their modules are built; none are defined before then.

import { filter, EXPORT_PERMISSION } from "./exports.js";
import { FULFILLMENT_STATUSES } from "./orders.js";
import { ORDER_PAYMENT_STATUSES, PAYMENT_STATES, PAYMENT_METHOD_IDS } from "./payments.js";
import { ORDER_SOURCE_IDS } from "./orders.js";
import { EXPENSE_CATEGORY_IDS, EXPENSE_METHOD_IDS } from "./expenses.js";
import { PRODUCT_STATUSES } from "./inventory.js";
import { CUSTOMER_STATUSES } from "./customers.js";

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
    view: ["expenses.view"],
    exportPermission: EXPORT_PERMISSION,
    // Active expenses only: removed ones are an audit view, not an export.
    filters: { status: filter.oneOf(["active"]), category: filter.oneOf(EXPENSE_CATEGORY_IDS), method: filter.oneOf(EXPENSE_METHOD_IDS), search: filter.text(100), ...range },
    filterLabels: { status: "Status", category: "Category", method: "Method", search: "Search", ...RANGE_LABELS },
  },
});

export const EXPORT_DATASET_IDS = Object.freeze(Object.keys(EXPORT_DATASETS));
