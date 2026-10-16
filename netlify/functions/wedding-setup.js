// POST /api/wedding-setup   (Owner-pilot Bridal: More → Wedding Setup)
//   { action: "get" }                       guests.view: the setup + hasHero
//   { action: "save", setup: { ... } }      guests.manage: couple, date, venues,
//                                           maps, dress code, message, RSVP deadline,
//                                           RSVP on/off, close after deadline
//   { action: "hero", dataUrl | null }      guests.manage: the cover photo (shrunk
//                                           in the browser) or remove it
// One elegant invitation theme; no page builder (./_lib/invitations.js).

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { readSetup, saveSetup, saveHero } from "./_lib/invitations.js";

export const createWeddingSetupHandler = (deps) =>
  weddingActionHandler("wedding-setup", {
    ...deps,
    actions: {
      get: { permission: "guests.view", fields: ["action"], run: (c) => readSetup(c) },
      save: { permission: "guests.manage", fields: ["action", "setup"], run: (c, b) => saveSetup({ ...c, input: b.setup }) },
      hero: { permission: "guests.manage", fields: ["action", "dataUrl"], run: (c, b) => saveHero({ ...c, dataUrl: b.dataUrl ?? null }) },
    },
  });

export const handler = createWeddingSetupHandler({ getAdmin });
