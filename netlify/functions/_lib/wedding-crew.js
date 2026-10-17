// Owner-pilot Bridal: Crew Meals records (see shared/wedding-crew.js).
// Server-only collections; a linked supplier must be one of THIS wedding's
// suppliers (its name is kept on the entry for lists and the backup).

import { WeddingError } from "../../../shared/wedding.js";
import { CREW_SCHEMA_VERSION, CREW_MAX_ITEMS, validateCrewItem, validateMealPrices } from "../../../shared/wedding-crew.js";

const TX_OPTIONS = { maxAttempts: 10 };
const ITEM_ID = /^[A-Za-z0-9]{1,40}$/;
const col = (tenant) => tenant.collection("weddingCrewMeals");
const settingsRef = (tenant) => tenant.doc("crewMealSettings", "current");
const who = (actor) => (actor ? { uid: actor.uid, name: actor.name } : null);
const itemRef = (tenant, id) => {
  if (typeof id !== "string" || !ITEM_ID.test(id)) throw new WeddingError("invalid-input", "Invalid crew meal");
  return tenant.doc("weddingCrewMeals", id);
};
const publicItem = (d) => {
  const i = d.data();
  return { id: d.id, name: i.name, supplierId: i.supplierId ?? null, supplierName: i.supplierName ?? null, breakfast: i.breakfast ?? 0, lunch: i.lunch ?? 0, dinner: i.dinner ?? 0, location: i.location ?? null, remarks: i.remarks ?? null };
};
// The supplier's name, or an error when it isn't this wedding's supplier.
async function supplierNameOf(tx, tenant, supplierId) {
  if (!supplierId) return null;
  const s = await tx.get(tenant.doc("weddingSuppliers", supplierId));
  if (!s.exists) throw new WeddingError("invalid-supplier", "Choose one of your suppliers");
  return s.data().name;
}

export async function listCrewMeals({ tenant }) {
  const [snap, settings] = await Promise.all([col(tenant).limit(CREW_MAX_ITEMS + 1).get(), settingsRef(tenant).get()]);
  const items = snap.docs.map(publicItem).sort((a, b) => a.name.localeCompare(b.name));
  return { items, prices: settings.exists ? settings.data().prices ?? {} : {} };
}

export async function createCrewMeal({ db, tenant, FieldValue, input, actor }) {
  const data = validateCrewItem(input || {});
  return db.runTransaction(async (tx) => {
    const n = (await tx.get(col(tenant).limit(CREW_MAX_ITEMS + 1))).size;
    if (n >= CREW_MAX_ITEMS) throw new WeddingError("invalid-input", `At most ${CREW_MAX_ITEMS} crew entries`);
    const supplierName = await supplierNameOf(tx, tenant, data.supplierId);
    const ref = col(tenant).doc();
    const stamp = FieldValue.serverTimestamp();
    tx.create(ref, { schemaVersion: CREW_SCHEMA_VERSION, name: data.name, supplierId: data.supplierId ?? null, supplierName, breakfast: data.breakfast ?? 0, lunch: data.lunch ?? 0, dinner: data.dinner ?? 0, location: data.location ?? null, remarks: data.remarks ?? null, createdBy: who(actor), createdAt: stamp, updatedBy: who(actor), updatedAt: stamp });
    return { itemId: ref.id };
  }, TX_OPTIONS);
}

export async function updateCrewMeal({ db, tenant, FieldValue, itemId, changes, actor }) {
  const data = validateCrewItem(changes || {}, { partial: true });
  const ref = itemRef(tenant, itemId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Crew meal not found");
    const extra = "supplierId" in data ? { supplierName: await supplierNameOf(tx, tenant, data.supplierId) } : {};
    tx.update(ref, { ...data, ...extra, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { itemId };
  }, TX_OPTIONS);
}

export async function deleteCrewMeal({ db, tenant, itemId }) {
  const ref = itemRef(tenant, itemId);
  return db.runTransaction(async (tx) => {
    if (!(await tx.get(ref)).exists) throw new WeddingError("not-found", "Crew meal not found");
    tx.delete(ref);
    return { itemId, deleted: true };
  }, TX_OPTIONS);
}

export async function setMealPrices({ tenant, FieldValue, prices, actor }) {
  const p = validateMealPrices(prices || {});
  await settingsRef(tenant).set({ prices: p, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { prices: p };
}
