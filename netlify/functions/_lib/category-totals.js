// One-off repair (2026-11-02): a budget's per-category spent totals
// (budgets/current.spentByCategory) rebuilt from its ACTIVE expenses.
// Before the fix, an expense edit that moved no money (notes, payee, Paid
// by) wrote an empty increments map with merge, which real Firestore treats
// as a value: the stored split was replaced by {} (Total spent itself stayed
// right). Household, Baby and Bridal share budgets/current. Reads and the
// write are ONE transaction, so an edit made at the same time is never lost.
// apply = false: report only.

const MAX_EXPENSES = 5000;

export async function recomputeCategoryTotals({ db, tenant, FieldValue, apply = false, actor }) {
  return db.runTransaction(async (tx) => {
    const budgetRef = tenant.doc("budgets", "current");
    const [budgetSnap, expSnap] = await Promise.all([tx.get(budgetRef), tx.get(tenant.collection("expenses").where("status", "==", "active").limit(MAX_EXPENSES + 1))]);
    if (!budgetSnap.exists) return { exists: false, changed: false };
    if (expSnap.docs.length > MAX_EXPENSES) throw new Error(`More than ${MAX_EXPENSES} expenses: not recomputed`);
    const b = budgetSnap.data();
    const after = {};
    let spent = 0;
    for (const d of expSnap.docs) {
      const e = d.data();
      if (!Number.isSafeInteger(e.amount)) continue;
      after[e.category] = (after[e.category] || 0) + e.amount;
      spent += e.amount;
    }
    const before = b.spentByCategory && typeof b.spentByCategory === "object" ? b.spentByCategory : {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed = [...keys].some((k) => (before[k] || 0) !== (after[k] || 0));
    // Total spent is kept as stored; a mismatch is reported, never "fixed" here.
    const out = { exists: true, before, after, changed, spentStored: b.spent ?? 0, spentFromExpenses: spent, expenses: expSnap.size };
    if (!apply || !changed) return out;
    // update() with a whole map REPLACES it: exactly the rebuilt split.
    tx.update(budgetRef, { spentByCategory: after, updatedAt: FieldValue.serverTimestamp() });
    tx.set(tenant.collection("auditLog").doc(), { type: "budget.category_totals_recomputed", before, after, actor, at: FieldValue.serverTimestamp() });
    return { ...out, applied: true };
  });
}
