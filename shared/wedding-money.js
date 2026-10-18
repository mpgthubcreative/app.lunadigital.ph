// The Bridal Money rows (Owner-pilot Bridal UX), shared by the Money screen
// (src/modules/wedding/suppliers.js) and the Download Excel workbook, so the
// file lists exactly what the screen does.
//   Row kinds
//             supplier  a saved supplier: total = its contract (or what was
//                       paid without one), Paid / Partial / Unpaid
//             planned   a budget line (category with a budget) that has no
//                       supplier yet: "No supplier yet", Planned. Adding a
//                       supplier in that category replaces it (no duplicate)
//             expense   an expense paid to no saved supplier: Paid, ₱0 left

import { supplierBalance } from "./wedding.js";

// Derived from what's recorded (paid = the supplier's Wedding Expenses).
export function paidState(s) {
  const paid = s.paid ?? 0;
  if (!(paid > 0)) return "unpaid";
  if (Number.isSafeInteger(s.agreedAmount) && paid < s.agreedAmount) return "partly";
  return "paid";
}
// Words in the Money list.
export const MONEY_STATUS = Object.freeze({ unpaid: "Unpaid", partly: "Partial", paid: "Paid", planned: "Planned" });

// The unified Money rows, in budget-category order.
export function moneyRows({ suppliers = [], categories = [], budget = null, expenses = [], upcoming = [] }) {
  const order = new Map(categories.map((c, i) => [c.id, i]));
  const name = (id) => categories.find((c) => c.id === id)?.name ?? "";
  const spentBy = budget?.spentByCategory && typeof budget.spentByCategory === "object" ? budget.spentByCategory : {};
  const rows = [];
  for (const s of suppliers) {
    const bal = supplierBalance(s);
    const scheduled = upcoming.filter((p) => p.supplierId === s.id).reduce((n, p) => n + p.amount, 0);
    rows.push({ kind: "supplier", id: s.id, categoryId: s.categoryId ?? null, category: name(s.categoryId), name: s.name, total: Number.isSafeInteger(s.agreedAmount) ? s.agreedAmount : (s.paid ?? 0) + scheduled, status: paidState(s), remaining: bal === null ? scheduled : Math.max(0, bal), record: s });
  }
  const withSupplier = new Set(suppliers.filter((s) => s.status === "active").map((s) => s.categoryId));
  for (const c of categories) {
    if (c.status !== "active" || !(c.budget > 0 || c.planned === true) || withSupplier.has(c.id)) continue;
    const amount = c.budget > 0 ? c.budget : null; // null: on the plan, amount not set yet
    rows.push({ kind: "planned", id: c.id, categoryId: c.id, category: c.name, name: null, total: amount, status: "planned", remaining: amount === null ? null : Math.max(0, amount - (spentBy[c.id] ?? 0)), record: c });
  }
  for (const e of expenses) {
    if (e.supplierId) continue;
    rows.push({ kind: "expense", id: e.id, categoryId: e.category, category: name(e.category) || e.categoryName || "", name: e.payee || null, total: e.amount, status: "paid", remaining: 0, record: e });
  }
  const rank = { supplier: 0, planned: 1, expense: 2 };
  return rows.sort((a, b) => (order.get(a.categoryId) ?? 999) - (order.get(b.categoryId) ?? 999) || rank[a.kind] - rank[b.kind] || (a.name || "").localeCompare(b.name || ""));
}

// The row's label: supplier, payee or description; a plan line without a supplier says so.
export const moneyLabel = (r) => r.name || (r.kind === "expense" ? r.record?.notes || "Expense" : "No supplier yet");
