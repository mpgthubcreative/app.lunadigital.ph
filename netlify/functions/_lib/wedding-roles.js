// Owner-pilot Bridal: wedding roles on guest records (shared/wedding-roles.js).
// Each change is one transaction on the guest(s); a single role (Best Man…)
// is checked against the other guests holding it (roleKeys array-contains).
// Removing a role never touches the guest, RSVP, seats or table.

import { WeddingError } from "../../../shared/wedding.js";
import { validateRole, roleKey, roleLabel, isSingleRole, MAX_ROLES_PER_GUEST } from "../../../shared/wedding-roles.js";

const TX_OPTIONS = { maxAttempts: 10 };
const GUEST_ID = /^[A-Za-z0-9]{1,40}$/;
const MAX_HISTORY = 200;
const who = (actor) => (actor ? { uid: actor.uid, name: actor.name } : null);
const gRef = (tenant, id) => {
  if (typeof id !== "string" || !GUEST_ID.test(id)) throw new WeddingError("invalid-input", "Invalid guest");
  return tenant.doc("guests", id);
};
const append = (list, e) => {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new WeddingError("history-full", "Too many changes on this record");
  return [...l, e];
};
const rolesOf = (g) => (Array.isArray(g.roles) ? g.roles : []);
const withRoles = (roles) => ({ roles, roleKeys: roles.map(roleKey) });

async function holders(tx, tenant, key) {
  return (await tx.get(tenant.collection("guests").where("roleKeys", "array-contains", key))).docs;
}

export async function assignRole({ db, tenant, FieldValue, guestId, role, actor, now = new Date() }) {
  const r = validateRole(role);
  const key = roleKey(r);
  const ref = gRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const others = isSingleRole(r) ? (await holders(tx, tenant, key)).filter((d) => d.id !== ref.id) : [];
    if (others.length) throw new WeddingError("role-taken", `${roleLabel(r)} is already ${others[0].data().name}. Use ⋯ → Change person instead.`);
    const g = snap.data();
    const roles = rolesOf(g);
    if (roles.some((x) => roleKey(x) === key)) return { guestId, unchanged: true };
    if (roles.length >= MAX_ROLES_PER_GUEST) throw new WeddingError("invalid-input", `A guest can have at most ${MAX_ROLES_PER_GUEST} roles`);
    tx.update(ref, { ...withRoles([...roles, r]), history: append(g.history, { at: now, actor: who(actor), label: `Role added: ${roleLabel(r)}` }), updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { guestId, role: r };
  }, TX_OPTIONS);
}

export async function unassignRole({ db, tenant, FieldValue, guestId, role, actor, now = new Date() }) {
  const r = validateRole(role);
  const key = roleKey(r);
  const ref = gRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    const roles = rolesOf(g);
    if (!roles.some((x) => roleKey(x) === key)) return { guestId, unchanged: true };
    tx.update(ref, { ...withRoles(roles.filter((x) => roleKey(x) !== key)), history: append(g.history, { at: now, actor: who(actor), label: `Role removed: ${roleLabel(r)}` }), updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { guestId, removed: true };
  }, TX_OPTIONS);
}

// Change person: the role moves from one guest to another (one transaction).
// Change role: the same guest swaps one role for another (toRole).
export async function moveRole({ db, tenant, FieldValue, fromGuestId, toGuestId = null, role, toRole = null, actor, now = new Date() }) {
  const r = validateRole(role);
  const next = toRole ? validateRole(toRole) : r;
  const fromRef = gRef(tenant, fromGuestId);
  const toRef = gRef(tenant, toGuestId ?? fromGuestId);
  return db.runTransaction(async (tx) => {
    const [a, b] = [await tx.get(fromRef), await tx.get(toRef)];
    if (!a.exists || !b.exists) throw new WeddingError("not-found", "Guest not found");
    const others = isSingleRole(next) ? (await holders(tx, tenant, roleKey(next))).filter((d) => d.id !== fromRef.id && d.id !== toRef.id) : [];
    if (others.length) throw new WeddingError("role-taken", `${roleLabel(next)} is already ${others[0].data().name}.`);
    const stamp = FieldValue.serverTimestamp();
    const ga = a.data();
    if (!rolesOf(ga).some((x) => roleKey(x) === roleKey(r))) throw new WeddingError("not-found", `${ga.name} doesn't have that role`);
    if (fromRef.id === toRef.id) {
      const roles = rolesOf(ga).filter((x) => roleKey(x) !== roleKey(r));
      if (!roles.some((x) => roleKey(x) === roleKey(next))) roles.push(next);
      tx.update(fromRef, { ...withRoles(roles), history: append(ga.history, { at: now, actor: who(actor), label: `Role changed: ${roleLabel(r)} → ${roleLabel(next)}` }), updatedBy: who(actor), updatedAt: stamp });
      return { guestId: fromRef.id, role: next };
    }
    const gb = b.data();
    const toRoles = rolesOf(gb).filter((x) => roleKey(x) !== roleKey(next));
    if (toRoles.length >= MAX_ROLES_PER_GUEST) throw new WeddingError("invalid-input", `A guest can have at most ${MAX_ROLES_PER_GUEST} roles`);
    tx.update(fromRef, { ...withRoles(rolesOf(ga).filter((x) => roleKey(x) !== roleKey(r))), history: append(ga.history, { at: now, actor: who(actor), label: `Role moved to ${gb.name}: ${roleLabel(r)}` }), updatedBy: who(actor), updatedAt: stamp });
    tx.update(toRef, { ...withRoles([...toRoles, next]), history: append(gb.history, { at: now, actor: who(actor), label: `Role added: ${roleLabel(next)} (from ${ga.name})` }), updatedBy: who(actor), updatedAt: stamp });
    return { guestId: toRef.id, role: next };
  }, TX_OPTIONS);
}
