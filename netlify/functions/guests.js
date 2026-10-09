// POST /api/guests   (Phase 16: Guests & RSVP; guests.manage)
//   { action: "create", guest: { name, side, partySize, group?, contact?, invitationSent?, notes? } }
//   { action: "update", guestId, expectedRevision?, changes: { ...any of the above } }
//   { action: "setRsvp", guestId, rsvp: { status: "awaiting" | "attending" | "declined", confirmed? } }
//   { action: "remove", guestId }
// Party size (invited) and confirmed attendees are kept apart; the RSVP
// totals are computed by Luna. Reads go straight to Firestore (guests.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { createGuest, updateGuest, setRsvp, removeGuest } from "./_lib/wedding.js";

const M = "guests.manage";
export const createGuestsHandler = (deps) =>
  weddingActionHandler("guests", {
    ...deps,
    actions: {
      create: { permission: M, created: true, fields: ["action", "guest"], run: (c, b) => createGuest({ ...c, input: b.guest }) },
      update: { permission: M, fields: ["action", "guestId", "expectedRevision", "changes"], run: (c, b) => updateGuest({ ...c, guestId: b.guestId, changes: b.changes, expectedRevision: b.expectedRevision ?? null }) },
      setRsvp: { permission: M, fields: ["action", "guestId", "rsvp"], run: (c, b) => setRsvp({ ...c, guestId: b.guestId, rsvp: b.rsvp }) },
      remove: { permission: M, fields: ["action", "guestId"], run: (c, b) => removeGuest({ ...c, guestId: b.guestId }) },
    },
  });

export const handler = createGuestsHandler({ getAdmin });
