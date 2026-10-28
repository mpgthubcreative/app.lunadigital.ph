// Wedding photo retention (2026-10-28, after a production smoke test
// overwrote and then removed a couple's real cover photo with no copy left).
//
// Wedding photos are small JPEG/PNG/WebP data URLs stored IN Firestore
// (weddingSetup/hero, weddingPhotos/{slot}, weddingGallery/{id}), not in
// Storage, so Storage soft delete never covered them and a replace or
// remove destroyed the only copy. Now, in the same transaction that
// replaces or removes one, the previous photo is kept here:
//
//   businesses/{bid}/weddingPhotoHistory/{id}   server-only (rules deny all)
//     { kind: hero | slot | gallery, slot, photoId, dataUrl, reason:
//       replaced | removed | reset, retainedAt, expiresAt (+30 days), by,
//       restoredAt? }
//
// Guests and Owners never see it: the invitation switches at once. Luna can
// restore a version (scripts/restore-wedding-photo.js). Copies older than
// PHOTO_RETENTION_DAYS are pruned on the business's next photo change.
// Cost: one extra document (≤ ~0.7 MB) per change, for 30 days.

export const PHOTO_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
export const photoHistory = (tenant) => tenant.collection("weddingPhotoHistory");
const who = (actor) => (actor ? { uid: actor.uid ?? null, name: actor.name ?? null } : null);

// Inside the caller's transaction, after its reads: keep `dataUrl` (the
// photo about to be replaced or removed). Nothing when there was none.
export function retainPhoto(tx, tenant, { kind, slot = null, photoId = null, dataUrl, reason, actor = null, now = new Date() }) {
  if (typeof dataUrl !== "string" || !dataUrl) return null;
  const ref = photoHistory(tenant).doc();
  tx.set(ref, { kind, slot, photoId, dataUrl, reason, retainedAt: now, expiresAt: new Date(now.getTime() + PHOTO_RETENTION_DAYS * DAY_MS), by: who(actor) });
  return ref.id;
}

// Expired copies (best effort; a failure never blocks the Owner's change).
export async function pruneRetained({ tenant, now = new Date(), max = 20 }) {
  try {
    const old = await photoHistory(tenant).where("expiresAt", "<", now).limit(max).get();
    await Promise.all(old.docs.map((d) => d.ref.delete()));
    return old.size;
  } catch {
    return 0;
  }
}

// Luna (ops script): what's retained, newest first (no image data).
export async function listRetained({ tenant }) {
  const s = await photoHistory(tenant).get();
  const iso = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : null);
  return s.docs
    .map((d) => {
      const x = d.data();
      return { id: d.id, kind: x.kind, slot: x.slot ?? null, photoId: x.photoId ?? null, reason: x.reason, retainedAt: iso(x.retainedAt), expiresAt: iso(x.expiresAt), restoredAt: iso(x.restoredAt), bytes: typeof x.dataUrl === "string" ? x.dataUrl.length : 0, by: x.by ?? null };
    })
    .sort((a, b) => String(b.retainedAt).localeCompare(String(a.retainedAt)));
}

// Luna (ops script): put a retained photo back where it was. The photo it
// replaces (if any) is itself retained first, so a restore is reversible.
export async function restoreRetained({ db, tenant, historyId, actor, now = new Date() }) {
  const hRef = photoHistory(tenant).doc(historyId);
  return db.runTransaction(async (tx) => {
    const h = await tx.get(hRef);
    if (!h.exists) throw new Error("No retained photo with that id");
    const x = h.data();
    const target = x.kind === "hero" ? tenant.doc("weddingSetup", "hero") : x.kind === "slot" ? tenant.doc("weddingPhotos", x.slot) : tenant.collection("weddingGallery").doc(x.photoId || h.id);
    const cur = await tx.get(target);
    if (cur.exists && cur.data().dataUrl !== x.dataUrl) retainPhoto(tx, tenant, { kind: x.kind, slot: x.slot, photoId: x.photoId, dataUrl: cur.data().dataUrl, reason: "replaced", actor, now });
    const keep = x.kind === "gallery" && cur.exists ? { order: cur.data().order } : x.kind === "gallery" ? { order: 1000 } : {};
    tx.set(target, { ...keep, dataUrl: x.dataUrl, updatedBy: who(actor), updatedAt: now, restoredFrom: h.id });
    tx.update(hRef, { restoredAt: now });
    return { restored: true, kind: x.kind, slot: x.slot, target: target.path };
  });
}
