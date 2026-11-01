// A reseller's earned commission total (resellers/{id}.earned), kept in step
// INSIDE the transaction that changes it: order edits, cancellations and
// (2026-11-01) customer payments, since commission is earned as verified
// customer payments come in (shared/resellers.js earnedOf). Never below what
// the reseller has already been paid: that change is refused until a payout
// is reversed.

const peso = (c) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

// Reads the resellers whose earned total changes (call before any write),
// checks earned never drops below paid, and returns apply() for the writes.
// changes: [{ resellerId, delta }]; fail(code, message) -> the caller's error.
export async function prepareEarned(tx, tenant, changes, FieldValue, fail, { action = "make this change" } = {}) {
  const merged = new Map();
  for (const c of changes) if (c.resellerId && c.delta) merged.set(c.resellerId, (merged.get(c.resellerId) || 0) + c.delta);
  const ids = [...merged.keys()].filter((id) => merged.get(id) !== 0);
  const snaps = await Promise.all(ids.map((id) => tx.get(tenant.doc("resellers", id))));
  snaps.forEach((snap, i) => {
    if (!snap.exists) throw fail("reseller-not-found", "Reseller not found");
    const r = snap.data();
    const next = (r.earned || 0) + merged.get(ids[i]);
    if (next < (r.paid || 0)) throw fail("commission-below-paid", `${r.name} has already been paid ${peso(r.paid || 0)} in commission. Reverse that payout on Resellers first, then ${action}.`);
  });
  return {
    apply() {
      ids.forEach((id, i) => tx.update(snaps[i].ref, { earned: FieldValue.increment(merged.get(id)), updatedAt: FieldValue.serverTimestamp() }));
    },
  };
}
