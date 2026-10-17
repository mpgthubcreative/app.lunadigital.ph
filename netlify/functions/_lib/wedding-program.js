// Owner-pilot Bridal: Music & Program records (see shared/wedding-program.js).
// Server-only collection weddingProgram/{itemId}; every write is one
// transaction over the wedding's items (a wedding has at most 200), so the
// order stays consistent under concurrent edits.

import { WeddingError } from "../../../shared/wedding.js";
import { PROGRAM_SCHEMA_VERSION, PROGRAM_MAX_ITEMS, validateProgramItem, programSection } from "../../../shared/wedding-program.js";

const TX_OPTIONS = { maxAttempts: 10 };
const ITEM_ID = /^[A-Za-z0-9]{1,40}$/;
const col = (tenant) => tenant.collection("weddingProgram");
const who = (actor) => (actor ? { uid: actor.uid, name: actor.name } : null);
const itemRef = (tenant, id) => {
  if (typeof id !== "string" || !ITEM_ID.test(id)) throw new WeddingError("invalid-input", "Invalid program item");
  return tenant.doc("weddingProgram", id);
};
const shape = (d) => ({ id: d.id, ...d.data() });
// What the screens get (no audit fields they don't show).
const publicItem = (i) => ({ id: i.id, section: i.section, order: i.order, moment: i.moment, song: i.song ?? null, durationSec: i.durationSec ?? null, person: i.person ?? null, notes: i.notes ?? null });

export async function listProgram({ tenant }) {
  const snap = await col(tenant).limit(PROGRAM_MAX_ITEMS + 1).get();
  const items = snap.docs.map(shape);
  return { items: [...programSection(items, "ceremony"), ...programSection(items, "reception")].map(publicItem) };
}

export async function createProgramItem({ db, tenant, FieldValue, input, actor }) {
  const data = validateProgramItem(input || {});
  return db.runTransaction(async (tx) => {
    const all = (await tx.get(col(tenant).limit(PROGRAM_MAX_ITEMS + 1))).docs.map(shape);
    if (all.length >= PROGRAM_MAX_ITEMS) throw new WeddingError("invalid-input", `A program can have at most ${PROGRAM_MAX_ITEMS} items`);
    const last = programSection(all, data.section).at(-1);
    const ref = col(tenant).doc();
    const stamp = FieldValue.serverTimestamp();
    const item = { schemaVersion: PROGRAM_SCHEMA_VERSION, section: data.section, order: (last ? last.order : 0) + 10, moment: data.moment, song: data.song ?? null, durationSec: data.durationSec ?? null, person: data.person ?? null, notes: data.notes ?? null, createdBy: who(actor), createdAt: stamp, updatedBy: who(actor), updatedAt: stamp };
    tx.create(ref, item);
    return { itemId: ref.id };
  }, TX_OPTIONS);
}

export async function updateProgramItem({ db, tenant, FieldValue, itemId, changes, actor }) {
  const data = validateProgramItem(changes || {}, { partial: true });
  const ref = itemRef(tenant, itemId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Program item not found");
    const cur = snap.data();
    const next = { ...data };
    // A moved item goes to the end of its new section.
    if (next.section && next.section !== cur.section) {
      const all = (await tx.get(col(tenant).limit(PROGRAM_MAX_ITEMS + 1))).docs.map(shape);
      const last = programSection(all, next.section).at(-1);
      next.order = (last ? last.order : 0) + 10;
    }
    tx.update(ref, { ...next, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { itemId };
  }, TX_OPTIONS);
}

export async function deleteProgramItem({ db, tenant, itemId }) {
  const ref = itemRef(tenant, itemId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Program item not found");
    tx.delete(ref);
    return { itemId, deleted: true };
  }, TX_OPTIONS);
}

// Move up / down: swap with the neighbour in the same section (and renumber
// the section when two share an order, so a swap always moves something).
export async function moveProgramItem({ db, tenant, FieldValue, itemId, direction, actor }) {
  if (!["up", "down"].includes(direction)) throw new WeddingError("invalid-input", "Choose up or down");
  const ref = itemRef(tenant, itemId);
  return db.runTransaction(async (tx) => {
    const all = (await tx.get(col(tenant).limit(PROGRAM_MAX_ITEMS + 1))).docs.map(shape);
    const me = all.find((i) => i.id === ref.id);
    if (!me) throw new WeddingError("not-found", "Program item not found");
    const list = programSection(all, me.section);
    const at = list.findIndex((i) => i.id === me.id);
    const to = direction === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= list.length) return { itemId, moved: false };
    [list[at], list[to]] = [list[to], list[at]];
    const stamp = FieldValue.serverTimestamp();
    list.forEach((i, n) => {
      const order = (n + 1) * 10;
      if (i.order !== order) tx.update(col(tenant).doc(i.id), { order, ...(i.id === me.id ? { updatedBy: who(actor), updatedAt: stamp } : {}) });
    });
    return { itemId, moved: true };
  }, TX_OPTIONS);
}
