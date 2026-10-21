// The Bridal Money rows (Owner-pilot Bridal UX), shared by the Money screen
// (src/modules/wedding/suppliers.js) and the Download Excel workbook, so the
// file lists exactly what the screen does.
//   Row kinds
//             supplier  a saved supplier: total = its contract (or what was
//                       paid without one), Paid / Partial / Unpaid
//             expense   an expense paid to no saved supplier: Paid, ₱0 left
// Bridal has no Budget (2026-10-21): a category's old budget amount or
// "planned" flag stays stored (backup, compatibility) but makes no row.

import { supplierBalance } from "./wedding.js";

// Derived from what's recorded (paid = the supplier's Wedding Expenses).
export function paidState(s) {
  const paid = s.paid ?? 0;
  if (!(paid > 0)) return "unpaid";
  if (Number.isSafeInteger(s.agreedAmount) && paid < s.agreedAmount) return "partly";
  return "paid";
}
// Words in the Money list.
export const MONEY_STATUS = Object.freeze({ unpaid: "Unpaid", partly: "Partial", paid: "Paid" });

// The unified Money rows, in category order.
export function moneyRows({ suppliers = [], categories = [], expenses = [], upcoming = [] }) {
  const order = new Map(categories.map((c, i) => [c.id, i]));
  const name = (id) => categories.find((c) => c.id === id)?.name ?? "";
  const rows = [];
  for (const s of suppliers) {
    const bal = supplierBalance(s);
    const scheduled = upcoming.filter((p) => p.supplierId === s.id).reduce((n, p) => n + p.amount, 0);
    rows.push({ kind: "supplier", id: s.id, categoryId: s.categoryId ?? null, category: name(s.categoryId), name: s.name, total: Number.isSafeInteger(s.agreedAmount) ? s.agreedAmount : (s.paid ?? 0) + scheduled, status: paidState(s), remaining: bal === null ? scheduled : Math.max(0, bal), record: s });
  }
  for (const e of expenses) {
    if (e.supplierId) continue;
    rows.push({ kind: "expense", id: e.id, categoryId: e.category, category: name(e.category) || e.categoryName || "", name: e.payee || null, total: e.amount, status: "paid", remaining: 0, record: e });
  }
  const rank = { supplier: 0, expense: 1 };
  return rows.sort((a, b) => (order.get(a.categoryId) ?? 999) - (order.get(b.categoryId) ?? 999) || rank[a.kind] - rank[b.kind] || (a.name || "").localeCompare(b.name || ""));
}

// The row's label: supplier, payee or description.
export const moneyLabel = (r) => r.name || r.record?.notes || "Expense";
