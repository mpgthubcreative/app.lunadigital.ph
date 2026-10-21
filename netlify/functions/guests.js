// POST /api/guests   (Phase 16: Guests & RSVP; guests.manage)
//   { action: "create", guest: { name, side, partySize, group?, contact?, invitationSent?, notes? } }
//   { action: "update", guestId, expectedRevision?, changes: { ...any of the above } }
//   { action: "setRsvp", guestId, rsvp: { status: "awaiting" | "attending" | "declined", confirmed? } }
//   { action: "remove", guestId }
//   Seating (Owner-pilot Bridal UX):
//   { action: "createTable", table: { name, capacity } }
//   { action: "updateTable", tableId, changes: { name?, capacity? } }
//   { action: "deleteTable", tableId }      its guests go back to Unassigned
//   { action: "seat", guestId, tableId }    the whole party (every confirmed person); null = unassign all
//   { action: "seatPerson", guestId, seatKey, tableId }   one person ("primary", a member id or "u1"…); null = unassign
//   Invitations (Owner-pilot Bridal):
//   { action: "inviteLink", guestId }       the guest's link (made on first use)
//   { action: "regenerateInvite", guestId } a new link; the old one stops working
//   Wedding roles (Owner-pilot Bridal; on the same guest record):
//   A person = the guest (primary) or a named party member (memberId).
//   { action: "assignRole", guestId, memberId?, role: { id, label? } }   many people per role
//   { action: "unassignRole", guestId, memberId?, role }                 the guest and RSVP stay
//   { action: "moveRole", fromGuestId, fromMemberId?, toGuestId?, toMemberId?, role, toRole? }
//   Party members (Owner-pilot Bridal):
//   { action: "addMember", guestId, name }                  at most party size − 1 names
//   { action: "renameMember", guestId, memberId, name }     roles / marks stay (same id)
//   { action: "removeMember", guestId, memberId, force? }   force after the "has a role" warning
//   { action: "setAttending", guestId, memberId?, attending }   which named people are coming
// Party size (invited) and confirmed attendees are kept apart; the RSVP
// totals are computed by Luna. Reads go straight to Firestore (guests.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { createGuest, updateGuest, setRsvp, removeGuest, createTable, updateTable, deleteTable, seatGuest, seatPerson } from "./_lib/wedding.js";
import { inviteLink, issueInvite } from "./_lib/invitations.js";
import { assignRole, unassignRole, moveRole, addMember, renameMember, removeMember, setMemberAttending } from "./_lib/wedding-roles.js";
import { RequestError } from "./_lib/http.js";

const guestIdOf = (b) => {
  if (typeof b.guestId !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(b.guestId)) throw new RequestError("invalid-request", "Invalid guest.", 400);
  return b.guestId;
};

const M = "guests.manage";
export const createGuestsHandler = (deps) =>
  weddingActionHandler("guests", {
    ...deps,
    actions: {
      create: { permission: M, created: true, fields: ["action", "guest"], run: (c, b) => createGuest({ ...c, input: b.guest }) },
      update: { permission: M, fields: ["action", "guestId", "expectedRevision", "changes"], run: (c, b) => updateGuest({ ...c, guestId: b.guestId, changes: b.changes, expectedRevision: b.expectedRevision ?? null }) },
      setRsvp: { permission: M, fields: ["action", "guestId", "rsvp"], run: (c, b) => setRsvp({ ...c, guestId: b.guestId, rsvp: b.rsvp }) },
      remove: { permission: M, fields: ["action", "guestId"], run: (c, b) => removeGuest({ ...c, guestId: b.guestId }) },
      createTable: { permission: M, created: true, fields: ["action", "table"], run: (c, b) => createTable({ ...c, input: b.table }) },
      updateTable: { permission: M, fields: ["action", "tableId", "changes"], run: (c, b) => updateTable({ ...c, tableId: b.tableId, changes: b.changes }) },
      deleteTable: { permission: M, fields: ["action", "tableId"], run: (c, b) => deleteTable({ ...c, tableId: b.tableId }) },
      inviteLink: { permission: M, fields: ["action", "guestId"], run: (c, b) => inviteLink({ ...c, guestId: guestIdOf(b) }) },
      regenerateInvite: { permission: M, fields: ["action", "guestId"], run: (c, b) => issueInvite({ ...c, guestId: guestIdOf(b) }) },
      assignRole: { permission: M, fields: ["action", "guestId", "memberId", "role"], run: (c, b) => assignRole({ ...c, guestId: guestIdOf(b), memberId: b.memberId ?? null, role: b.role }) },
      unassignRole: { permission: M, fields: ["action", "guestId", "memberId", "role"], run: (c, b) => unassignRole({ ...c, guestId: guestIdOf(b), memberId: b.memberId ?? null, role: b.role }) },
      moveRole: { permission: M, fields: ["action", "fromGuestId", "fromMemberId", "toGuestId", "toMemberId", "role", "toRole"], run: (c, b) => moveRole({ ...c, fromGuestId: b.fromGuestId, fromMemberId: b.fromMemberId ?? null, toGuestId: b.toGuestId ?? null, toMemberId: b.toMemberId ?? null, role: b.role, toRole: b.toRole ?? null }) },
      addMember: { permission: M, created: true, fields: ["action", "guestId", "name"], run: (c, b) => addMember({ ...c, guestId: guestIdOf(b), name: b.name }) },
      renameMember: { permission: M, fields: ["action", "guestId", "memberId", "name"], run: (c, b) => renameMember({ ...c, guestId: guestIdOf(b), memberId: b.memberId, name: b.name }) },
      removeMember: { permission: M, fields: ["action", "guestId", "memberId", "force"], run: (c, b) => removeMember({ ...c, guestId: guestIdOf(b), memberId: b.memberId, force: b.force === true }) },
      setAttending: { permission: M, fields: ["action", "guestId", "memberId", "attending"], run: (c, b) => setMemberAttending({ ...c, guestId: guestIdOf(b), memberId: b.memberId ?? null, attending: b.attending }) },
      seat: { permission: M, fields: ["action", "guestId", "tableId"], run: (c, b) => seatGuest({ ...c, guestId: b.guestId, tableId: b.tableId ?? null }) },
      seatPerson: { permission: M, fields: ["action", "guestId", "seatKey", "tableId"], run: (c, b) => seatPerson({ ...c, guestId: b.guestId, seatKey: b.seatKey, tableId: b.tableId ?? null }) },
    },
  });

export const handler = createGuestsHandler({ getAdmin });
