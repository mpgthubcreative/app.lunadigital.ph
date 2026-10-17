// Luna Household Grocery List (server). A plain shared checklist: no money,
// no history arrays. Owner / Admin (grocery.manage) add, edit, delete and
// clear; anyone with grocery.check (incl. household staff) ticks items as
// bought; household staff may add items only when the Owner switched
// "Helpers can add items" on (groceryLists/current.staffCanAdd).
// Adding an item already on the active list returns it instead of a copy.

import { BabyError } from "../../../shared/baby.js";
import { validateGroceryItem, groceryKey, GROCERY_SETTINGS_DOC_ID, MAX_GROCERY_ITEMS, MAX_GROCERY_BATCH } from "../../../shared/grocery.js";

const ID = /^[A-Za-z0-9]{8,40}$/;
const who = (a) => (a ? { uid: a.uid, name: a.name ?? null } : null);
const itemsRef = (tenant) => tenant.collection("groceryItems");
const settingsRef = (tenant) => tenant.doc("groceryLists", GROCERY_SETTINGS_DOC_ID);
function itemRef(tenant, id) {
  if (typeof id !== "string" || !ID.test(id)) throw new BabyError("not-found", "Item not found");
  return itemsRef(tenant).doc(id);
}

export async function grocerySettings({ tenant }) {
  const s = await settingsRef(tenant).get();
  return { staffCanAdd: s.exists && s.data().staffCanAdd === true };
}
async function requireAdd({ tenant, permissions }) {
  if (permissions["grocery.manage"] === true) return;
  if (permissions["grocery.check"] === true && (await grocerySettings({ tenant })).staffCanAdd) return;
  throw new BabyError("not-available", "Only the Owner can add items here. Ask them to turn on \"Helpers can add items\".");
}

// items: [{ name, qty?, category? }]; source "manual" | "sample".
export async function addGroceryItems({ db, tenant, FieldValue, actor, permissions, items, source = "manual" }) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_GROCERY_BATCH) throw new BabyError("invalid-input", `Add 1 to ${MAX_GROCERY_BATCH} items at a time`);
  await requireAdd({ tenant, permissions });
  const clean = items.map((i) => validateGroceryItem(i));
  return db.runTransaction(async (tx) => {
    const all = await tx.get(itemsRef(tenant).limit(MAX_GROCERY_ITEMS + 1));
    const active = new Map(all.docs.filter((d) => d.data().bought !== true).map((d) => [d.data().nameLower, d.id]));
    const out = [];
    let count = all.size;
    for (const it of clean) {
      const key = groceryKey(it.name);
      if (active.has(key)) {
        out.push({ itemId: active.get(key), existing: true });
        continue;
      }
      if (count >= MAX_GROCERY_ITEMS) throw new BabyError("too-many-items", `The list holds up to ${MAX_GROCERY_ITEMS} items. Clear bought items first.`);
      const ref = itemsRef(tenant).doc();
      const stamp = FieldValue.serverTimestamp();
      tx.create(ref, { name: it.name, nameLower: key, qty: it.qty, category: it.category, bought: false, boughtAt: null, boughtBy: null, source: source === "sample" ? "sample" : "manual", createdAt: stamp, createdBy: who(actor), updatedAt: stamp, updatedBy: who(actor) });
      active.set(key, ref.id);
      count += 1;
      out.push({ itemId: ref.id, existing: false });
    }
    return { items: out, added: out.filter((x) => !x.existing).length };
  });
}

export async function updateGroceryItem({ db, tenant, FieldValue, actor, itemId, changes }) {
  const ref = itemRef(tenant, itemId);
  const diff = validateGroceryItem(changes, { partial: true });
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BabyError("not-found", "Item not found");
    const cur = snap.data();
    const next = { ...diff, ...(diff.name ? { nameLower: groceryKey(diff.name) } : {}) };
    if (Object.entries(next).every(([k, v]) => (cur[k] ?? null) === (v ?? null))) return { unchanged: true };
    tx.update(ref, { ...next, updatedAt: FieldValue.serverTimestamp(), updatedBy: who(actor) });
    return { itemId };
  });
}

export async function checkGroceryItem({ db, tenant, FieldValue, actor, itemId, bought }) {
  if (typeof bought !== "boolean") throw new BabyError("invalid-input", "Invalid item");
  const ref = itemRef(tenant, itemId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BabyError("not-found", "Item not found");
    if ((snap.data().bought === true) === bought) return { unchanged: true };
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, { bought, boughtAt: bought ? stamp : null, boughtBy: bought ? who(actor) : null, updatedAt: stamp, updatedBy: who(actor) });
    return { itemId, bought };
  });
}

export async function removeGroceryItem({ tenant, itemId }) {
  const ref = itemRef(tenant, itemId);
  if (!(await ref.get()).exists) throw new BabyError("not-found", "Item not found");
  await ref.delete();
  return { itemId, removed: true };
}

// Deletes every bought item (the list is a checklist, not a record of spending).
export async function clearBoughtGrocery({ db, tenant }) {
  const snap = await itemsRef(tenant).where("bought", "==", true).limit(MAX_GROCERY_ITEMS).get();
  const batch = db.batch();
  for (const d of snap.docs) batch.delete(d.ref);
  if (snap.size) await batch.commit();
  return { cleared: snap.size };
}

export async function setGrocerySettings({ tenant, FieldValue, actor, staffCanAdd }) {
  if (typeof staffCanAdd !== "boolean") throw new BabyError("invalid-input", "Invalid setting");
  await settingsRef(tenant).set({ staffCanAdd, updatedAt: FieldValue.serverTimestamp(), updatedBy: who(actor) }, { merge: true });
  return { staffCanAdd };
}
