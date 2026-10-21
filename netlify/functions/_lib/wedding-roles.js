// Owner-pilot Bridal: people in a party and their wedding roles, on the
// guest record (shared/wedding-roles.js). Each change is one transaction on
// the guest(s). Roles are person ↔ role (many-to-many); only the same person
// in the same role twice is refused. Removing a role or renaming a person
// never touches the guest, RSVP, seats or table.

import { randomBytes } from "node:crypto";
import { WeddingError, keyOf } from "../../../shared/wedding.js";
import { validateRole, roleKey, roleLabel, MAX_ROLES_PER_PERSON, PRIMARY, partyRoleKeys, membersOf } from "../../../shared/wedding-roles.js";
import { reconcileSeats, seatsOf, UNNAMED_SEAT } from "../../../shared/wedding-seating.js";

const TX_OPTIONS = { maxAttempts: 10 };
const GUEST_ID = /^[A-Za-z0-9]{1,40}$/;
const MEMBER_ID = /^m[A-Za-z0-9]{6,20}$/;
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
const list = (v) => (Array.isArray(v) ? v : []);
const memberIdOf = (v) => (v === undefined || v === null || v === PRIMARY ? null : typeof v === "string" && MEMBER_ID.test(v) ? v : (() => { throw new WeddingError("invalid-input", "Invalid party member"); })());
const newMemberId = () => `m${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;
const cleanName = (v) => {
  const t = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!t || t.length > 80) throw new WeddingError("invalid-input", "Enter a name (up to 80 characters)");
  return t;
};

// The person's roles + name, and how to write them back (one guest doc).
function personOf(g, memberId) {
  if (!memberId) return { name: g.name, roles: list(g.roles), set: (roles) => ({ roles }) };
  const members = membersOf(g);
  const m = members.find((x) => x.id === memberId);
  if (!m) throw new WeddingError("not-found", "Party member not found");
  return { name: m.name, roles: list(m.roles), set: (roles) => ({ members: members.map((x) => (x.id === memberId ? { ...x, roles } : x)) }) };
}
// Writes for a guest whose roles changed somewhere in the party.
const withKeys = (g, patch) => ({ ...patch, roleKeys: partyRoleKeys({ ...g, ...patch }) });

export async function assignRole({ db, tenant, FieldValue, guestId, memberId = null, role, actor, now = new Date() }) {
  const r = validateRole(role);
  const mid = memberIdOf(memberId);
  const ref = gRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    const p = personOf(g, mid);
    if (p.roles.some((x) => roleKey(x) === roleKey(r))) throw new WeddingError("role-taken", `${p.name} is already ${roleLabel(r)}.`);
    if (p.roles.length >= MAX_ROLES_PER_PERSON) throw new WeddingError("invalid-input", `A person can have at most ${MAX_ROLES_PER_PERSON} roles`);
    tx.update(ref, { ...withKeys(g, p.set([...p.roles, r])), history: append(g.history, { at: now, actor: who(actor), label: `Role added: ${roleLabel(r)}${mid ? ` (${p.name})` : ""}` }), updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { guestId: ref.id, memberId: mid, role: r };
  }, TX_OPTIONS);
}

export async function unassignRole({ db, tenant, FieldValue, guestId, memberId = null, role, actor, now = new Date() }) {
  const r = validateRole(role);
  const mid = memberIdOf(memberId);
  const ref = gRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    const p = personOf(g, mid);
    if (!p.roles.some((x) => roleKey(x) === roleKey(r))) return { guestId: ref.id, unchanged: true };
    tx.update(ref, { ...withKeys(g, p.set(p.roles.filter((x) => roleKey(x) !== roleKey(r)))), history: append(g.history, { at: now, actor: who(actor), label: `Role removed: ${roleLabel(r)}${mid ? ` (${p.name})` : ""}` }), updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { guestId: ref.id, removed: true };
  }, TX_OPTIONS);
}

// Change person: the role moves from one person to another (any party).
// Change role: the same person swaps one role for another (toRole).
export async function moveRole({ db, tenant, FieldValue, fromGuestId, fromMemberId = null, toGuestId = null, toMemberId = null, role, toRole = null, actor, now = new Date() }) {
  const r = validateRole(role);
  const next = toRole ? validateRole(toRole) : r;
  const fromMid = memberIdOf(fromMemberId);
  const toMid = toGuestId ? memberIdOf(toMemberId) : fromMid;
  const fromRef = gRef(tenant, fromGuestId);
  const toRef = gRef(tenant, toGuestId ?? fromGuestId);
  return db.runTransaction(async (tx) => {
    const [a, b] = [await tx.get(fromRef), await tx.get(toRef)];
    if (!a.exists || !b.exists) throw new WeddingError("not-found", "Guest not found");
    const stamp = FieldValue.serverTimestamp();
    const ga = a.data();
    const from = personOf(ga, fromMid);
    if (!from.roles.some((x) => roleKey(x) === roleKey(r))) throw new WeddingError("not-found", `${from.name} doesn't have that role`);
    const samePerson = fromRef.id === toRef.id && fromMid === toMid;
    if (samePerson) {
      const roles = from.roles.filter((x) => roleKey(x) !== roleKey(r));
      if (!roles.some((x) => roleKey(x) === roleKey(next))) roles.push(next);
      tx.update(fromRef, { ...withKeys(ga, from.set(roles)), history: append(ga.history, { at: now, actor: who(actor), label: `Role changed: ${roleLabel(r)} → ${roleLabel(next)}${fromMid ? ` (${from.name})` : ""}` }), updatedBy: who(actor), updatedAt: stamp });
      return { guestId: fromRef.id, memberId: fromMid, role: next };
    }
    if (fromRef.id === toRef.id) {
      // Two people in the same party: one write.
      const afterFrom = { ...ga, ...from.set(from.roles.filter((x) => roleKey(x) !== roleKey(r))) };
      const to = personOf(afterFrom, toMid);
      if (to.roles.some((x) => roleKey(x) === roleKey(next))) throw new WeddingError("role-taken", `${to.name} is already ${roleLabel(next)}.`);
      const patch = to.set([...to.roles, next]);
      tx.update(fromRef, { ...withKeys(afterFrom, { ...from.set(from.roles.filter((x) => roleKey(x) !== roleKey(r))), ...patch }), history: append(ga.history, { at: now, actor: who(actor), label: `Role moved: ${roleLabel(r)} · ${from.name} → ${to.name}` }), updatedBy: who(actor), updatedAt: stamp });
      return { guestId: toRef.id, memberId: toMid, role: next };
    }
    const gb = b.data();
    const to = personOf(gb, toMid);
    if (to.roles.some((x) => roleKey(x) === roleKey(next))) throw new WeddingError("role-taken", `${to.name} is already ${roleLabel(next)}.`);
    if (to.roles.length >= MAX_ROLES_PER_PERSON) throw new WeddingError("invalid-input", `A person can have at most ${MAX_ROLES_PER_PERSON} roles`);
    tx.update(fromRef, { ...withKeys(ga, from.set(from.roles.filter((x) => roleKey(x) !== roleKey(r)))), history: append(ga.history, { at: now, actor: who(actor), label: `Role moved to ${to.name}: ${roleLabel(r)}${fromMid ? ` (from ${from.name})` : ""}` }), updatedBy: who(actor), updatedAt: stamp });
    tx.update(toRef, { ...withKeys(gb, to.set([...to.roles, next])), history: append(gb.history, { at: now, actor: who(actor), label: `Role added: ${roleLabel(next)}${toMid ? ` (${to.name})` : ""} (from ${from.name})` }), updatedBy: who(actor), updatedAt: stamp });
    return { guestId: toRef.id, memberId: toMid, role: next };
  }, TX_OPTIONS);
}

// ---------- Party members (named companions) ----------
// Seats follow the people (shared/wedding-seating.js): naming someone gives
// them the first unnamed seat (its table stays with them); removing a named
// member, or changing who's marked attending, frees seats that no longer
// belong to a confirmed person (named in the history).

// u1 → the new member, u2 → u1, u3 → u2 … (the unnamed seats shift down).
function namingShift(g, memberId) {
  const rename = { u1: memberId };
  for (const k of Object.keys(seatsOf(g))) {
    const n = UNNAMED_SEAT.exec(k)?.[1];
    if (n && Number(n) > 1) rename[k] = `u${Number(n) - 1}`;
  }
  return rename;
}
const freedText = (released) => (released.length ? ` · seat freed: ${released.map((r) => r.name).join(", ")}` : "");

export async function addMember({ db, tenant, FieldValue, guestId, name, actor, now = new Date() }) {
  const n = cleanName(name);
  const ref = gRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    const members = membersOf(g);
    const seats = Number.isSafeInteger(g.partySize) ? g.partySize : 1;
    if (members.length + 1 >= seats) throw new WeddingError("invalid-input", `All ${seats} invited seats already have names. Raise the invited seats first.`);
    const lowered = keyOf(n);
    if ([g.name, ...members.map((m) => m.name)].some((x) => keyOf(x) === lowered)) throw new WeddingError("invalid-input", `${n} is already in this party`);
    const m = { id: newMemberId(), name: n, roles: [] };
    const next = { ...g, members: [...members, m] };
    const seating = reconcileSeats(g, next, { rename: namingShift(g, m.id) });
    tx.update(ref, { members: next.members, ...seating.fields, history: append(g.history, { at: now, actor: who(actor), label: `Party member added: ${n}${freedText(seating.released)}` }), updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { guestId: ref.id, memberId: m.id };
  }, TX_OPTIONS);
}

export async function renameMember({ db, tenant, FieldValue, guestId, memberId, name, actor, now = new Date() }) {
  const n = cleanName(name);
  const mid = memberIdOf(memberId);
  if (!mid) throw new WeddingError("invalid-input", "Rename the guest with Edit");
  const ref = gRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    const members = membersOf(g);
    const m = members.find((x) => x.id === mid);
    if (!m) throw new WeddingError("not-found", "Party member not found");
    if (m.name === n) return { guestId: ref.id, unchanged: true };
    // Same id: roles, attending mark and seating stay with the person.
    tx.update(ref, { members: members.map((x) => (x.id === mid ? { ...x, name: n } : x)), history: append(g.history, { at: now, actor: who(actor), label: `Party member renamed: ${m.name} → ${n}` }), updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { guestId: ref.id, memberId: mid };
  }, TX_OPTIONS);
}

// A member with roles or an attending mark needs force: true (the screen
// warns first: "Anna is assigned as Bridesmaid. Remove her anyway?").
export async function removeMember({ db, tenant, FieldValue, guestId, memberId, force = false, actor, now = new Date() }) {
  const mid = memberIdOf(memberId);
  if (!mid) throw new WeddingError("invalid-input", "The primary guest can't be removed from their own party");
  const ref = gRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    const members = membersOf(g);
    const m = members.find((x) => x.id === mid);
    if (!m) throw new WeddingError("not-found", "Party member not found");
    const links = [...list(m.roles).map((r) => roleLabel(r)), ...(m.attending === true ? ["marked attending"] : [])];
    if (links.length && force !== true) throw new WeddingError("member-linked", `${m.name} is ${links.join(", ")}. Remove them from this party anyway?`);
    const next = members.filter((x) => x.id !== mid);
    const seating = reconcileSeats(g, { ...g, members: next });
    tx.update(ref, { ...withKeys(g, { members: next }), ...seating.fields, history: append(g.history, { at: now, actor: who(actor), label: `Party member removed: ${m.name}${links.length ? ` (was ${links.join(", ")})` : ""}${freedText(seating.released)}` }), updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { guestId: ref.id, removed: true };
  }, TX_OPTIONS);
}

// Which named people are coming (optional; the RSVP count stays the truth).
// At most `confirmed` people can be marked in an Attending party.
export async function setMemberAttending({ db, tenant, FieldValue, guestId, memberId = null, attending, actor, now = new Date() }) {
  if (typeof attending !== "boolean") throw new WeddingError("invalid-input", "Choose attending or not");
  const mid = memberIdOf(memberId);
  const ref = gRef(tenant, guestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WeddingError("not-found", "Guest not found");
    const g = snap.data();
    if (g.rsvp !== "attending") throw new WeddingError("invalid-input", "Set the party's RSVP to Attending first");
    const members = membersOf(g);
    const target = mid ? members.find((x) => x.id === mid) : g;
    if (!target) throw new WeddingError("not-found", "Party member not found");
    if ((target.attending === true) === attending) return { guestId: ref.id, unchanged: true };
    const marked = (g.attending === true ? 1 : 0) + members.filter((m) => m.attending === true).length;
    if (attending && marked + 1 > (g.confirmed || 0)) throw new WeddingError("invalid-input", `Only ${g.confirmed} are attending. Raise the number attending first.`);
    const name = mid ? target.name : g.name;
    const patch = mid ? { members: members.map((x) => (x.id === mid ? { ...x, attending } : x)) } : { attending };
    const seating = reconcileSeats(g, { ...g, ...patch });
    tx.update(ref, { ...patch, ...seating.fields, history: append(g.history, { at: now, actor: who(actor), label: `${name}: ${attending ? "attending" : "not marked attending"}${freedText(seating.released)}` }), updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    return { guestId: ref.id, attending };
  }, TX_OPTIONS);
}

// RSVP changed (Owner or guest): attending marks only survive while they
// still fit (Attending and no more marks than confirmed). Returns the patch.
export function attendingMarksFor(g, next) {
  const members = membersOf(g);
  const marked = (g.attending === true ? 1 : 0) + members.filter((m) => m.attending === true).length;
  if (!marked) return {};
  if (next.status === "attending" && marked <= next.confirmed) return {};
  return { attending: null, members: members.map((m) => (m.attending === undefined ? m : { ...m, attending: null })) };
}
