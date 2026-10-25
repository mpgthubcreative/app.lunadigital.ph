// Who owes us (2026-10-25): one row per saved customer with a balance.
//   TOTAL UNPAID ₱X
//   Customer | Balance | Oldest unpaid | View
// The balance is the customer's own figure (kept by the server from orders,
// payments, cancellations, corrections and opening balances). The orders
// and opening balances still unpaid explain it and give the oldest date.
// Walk-in orders (no saved customer) aren't listed here: Orders shows them.

const dayMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const daysBetween = (from, to) => Math.max(0, Math.round((dayMs(to) - dayMs(from)) / 86_400_000));

// What still makes up one customer's balance, oldest first:
// [{ kind: "order" | "opening", id, label, day, due }].
export function balanceItems(customerId, { orders = [], openings = [] } = {}) {
  const items = [
    ...openings.filter((b) => b.customerId === customerId && b.status !== "voided" && b.balance > 0).map((b) => ({ kind: "opening", id: b.id, label: "Opening balance", day: b.effectiveDay, due: b.balance, note: b.note || null })),
    ...orders.filter((o) => o.customerId === customerId && o.fulfillmentStatus !== "cancelled" && o.balance > 0).map((o) => ({ kind: "order", id: o.id, label: o.orderNumber, day: o.orderDate, due: o.balance, paid: o.amountPaid || 0, total: o.total })),
  ];
  return items.sort((a, b) => (a.day || "").localeCompare(b.day || ""));
}

// customers: those with stats.outstandingBalance > 0 (server order: biggest first).
export function receivableRows(customers, { orders = [], openings = [], today }) {
  const rows = customers
    .filter((c) => (c.stats?.outstandingBalance ?? 0) > 0)
    .map((c) => {
      const items = balanceItems(c.id, { orders, openings });
      const oldest = items.find((i) => i.day)?.day ?? null;
      return { id: c.id, name: c.name, balance: c.stats.outstandingBalance, oldestDay: oldest, oldestDays: oldest && today ? daysBetween(oldest, today) : null, items, customer: c };
    })
    .sort((a, b) => b.balance - a.balance || (b.oldestDays ?? -1) - (a.oldestDays ?? -1));
  return { rows, total: rows.reduce((t, r) => t + r.balance, 0) };
}
