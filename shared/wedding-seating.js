// Reception seating, one PERSON at a time (2026-10-21). The RSVP stays
// party-based (guests/{id}: rsvp, partySize, confirmed); seating is per
// confirmed person:
//   guests/{id}.seats     { [seatKey]: tableId }  one entry per seated person
//   guests/{id}.tableIds  the party's tables, sorted (so "who sits at table
//                         X" is one array-contains query)
//   seatKey  "primary"     the guest themself
//            "m…"          a named party member (shared/wedding-roles.js)
//            "u1", "u2" …  confirmed people without a name yet ("Member 3")
// Who can be seated: the party's `confirmed` people, in this order: those
// marked attending, then the other named people (primary first), then the
// unnamed ones. A declined / waiting party seats no one.
// An older record seated as a whole party (guests/{id}.tableId) reads as
// every confirmed person at that table; its next seating change rewrites it
// per person (no migration).

import { membersOf, PRIMARY } from "./wedding-roles.js";

export const UNNAMED_SEAT = /^u([1-9]\d?)$/;
const int = (v) => (Number.isSafeInteger(v) ? v : 0);

// The people of a party who can be seated now, in seat order.
// [{ key, name, memberId, primary, unnamed }]
export function seatablePeople(g) {
  if (!g || g.rsvp !== "attending") return [];
  const confirmed = Math.max(0, int(g.confirmed));
  const named = [{ key: PRIMARY, name: g.name, memberId: null, primary: true, unnamed: false, marked: g.attending === true }, ...membersOf(g).map((m) => ({ key: m.id, name: m.name, memberId: m.id, primary: false, unnamed: false, marked: m.attending === true }))];
  const ordered = [...named.filter((p) => p.marked), ...named.filter((p) => !p.marked)].slice(0, confirmed);
  const out = ordered.map(({ marked, ...p }) => p);
  for (let n = 1; out.length < confirmed; n += 1) out.push({ key: `u${n}`, name: `Member ${named.length + n}`, memberId: null, primary: false, unnamed: true });
  return out;
}

// The party's seats as they stand: { [seatKey]: tableId } (an older
// whole-party tableId = every seatable person at that table).
export function seatsOf(g) {
  if (g && g.seats && typeof g.seats === "object" && !Array.isArray(g.seats)) return Object.fromEntries(Object.entries(g.seats).filter(([, t]) => typeof t === "string" && t));
  if (g && typeof g.tableId === "string" && g.tableId) return Object.fromEntries(seatablePeople(g).map((p) => [p.key, g.tableId]));
  return {};
}

// After a change to the party (RSVP, confirmed count, names, attending
// marks): the seats that still belong to someone who can be seated, and the
// ones released. `rename` maps an old seat key to a new one (an unnamed
// person who just got a name keeps their table). Returns the guest-doc
// fields to write and what was released (for the history line).
export function reconcileSeats(before, after, { rename = {} } = {}) {
  const allowed = new Set(seatablePeople(after).map((p) => p.key));
  const was = new Map(seatablePeople(before).map((p) => [p.key, p.name]));
  const nameOf = (k) => was.get(k) ?? (k === PRIMARY ? before?.name : membersOf(before).find((m) => m.id === k)?.name) ?? k;
  const seats = {};
  const released = [];
  for (const [k, t] of Object.entries(seatsOf(before))) {
    const to = rename[k] ?? k;
    if (allowed.has(to)) seats[to] = t;
    else released.push({ key: k, name: nameOf(k), tableId: t });
  }
  return { fields: seatFields(seats), released };
}

// The guest-doc fields for a seats map (and the older field cleared).
export function seatFields(seats) {
  return { seats, tableIds: [...new Set(Object.values(seats))].sort(), tableId: null };
}

// How many people of this party sit at a table.
export const peopleAt = (g, tableId) => Object.values(seatsOf(g)).filter((t) => t === tableId).length;

// Tables in order with the PEOPLE seated at each, and the confirmed people
// not seated yet (grouped by party). Counts are people, never parties.
//   { tables: [{ id, name, capacity, order, used, people }], unassigned: [{ guest, people }],
//     attendingSeats, seatedSeats, unassignedSeats }
// A person's entry: { key, guestId, name, party, primary, unnamed, guest }.
export function seatingPlan(guests, seatingDoc) {
  const raw = seatingDoc && typeof seatingDoc.tables === "object" && seatingDoc.tables ? seatingDoc.tables : {};
  const tables = Object.entries(raw)
    .map(([id, t]) => ({ id, name: t.name, capacity: int(t.capacity), order: int(t.order), people: [], used: 0 }))
    .sort((a, b) => a.order - b.order || String(a.name).localeCompare(String(b.name)));
  const byId = new Map(tables.map((t) => [t.id, t]));
  const unassigned = [];
  let attendingSeats = 0;
  for (const g of guests || []) {
    const people = seatablePeople(g);
    attendingSeats += people.length;
    const seats = seatsOf(g);
    const waiting = [];
    for (const p of people) {
      const person = { ...p, guestId: g.id, party: g.name, guest: g };
      const t = seats[p.key] ? byId.get(seats[p.key]) : null;
      if (t) {
        t.people.push(person);
        t.used += 1;
      } else waiting.push(person);
    }
    if (waiting.length) unassigned.push({ guest: g, people: waiting });
  }
  const seatedSeats = tables.reduce((s, t) => s + t.used, 0);
  return { tables, unassigned, attendingSeats, seatedSeats, unassignedSeats: attendingSeats - seatedSeats };
}

// Where each person of a party sits: { [seatKey]: tableId | null }.
export function partySeating(g) {
  const seats = seatsOf(g);
  return Object.fromEntries(seatablePeople(g).map((p) => [p.key, seats[p.key] ?? null]));
}
