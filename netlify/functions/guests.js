// POST /api/guests   (Phase 16: Guests & RSVP; guests.manage)
//   { action: "create", guest: { name, side, partySize, group?, contact?, invitationSent?, notes? } }
//   { action: "update", guestId, expectedRevision?, changes: { ...any of the above } }
//   { action: "setRsvp", guestId, rsvp: { status: "awaiting" | "attending" | "declined", confirmed? } }
//   { action: "remove", guestId }
//   Seating (Owner-pilot Bridal UX):
//   { action: "createTable", table: { name, capacity } }
//   { action: "updateTable", tableId, changes: { name?, capacity? } }
//   { action: "deleteTable", tableId }      its guests go back to Unassigned
//   { action: "seat", guestId, tableId }    assign / move; tableId null = unassign
//   Invitations (Owner-pilot Bridal):
//   { action: "inviteLink", guestId }       the guest's link (made on first use)
//   { action: "regenerateInvite", guestId } a new link; the old one stops working
// Party size (invited) and confirmed attendees are kept apart; the RSVP
// totals are computed by Luna. Reads go straight to Firestore (guests.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { createGuest, updateGuest, setRsvp, removeGuest, createTable, updateTable, deleteTable, seatGuest } from "./_lib/wedding.js";
import { inviteLink, issueInvite } from "./_lib/invitations.js";
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
      seat: { permission: M, fields: ["action", "guestId", "tableId"], run: (c, b) => seatGuest({ ...c, guestId: b.guestId, tableId: b.tableId ?? null }) },
    },
  });

export const handler = createGuestsHandler({ getAdmin });
