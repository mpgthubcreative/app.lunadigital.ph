// POST /api/wedding-setup   (Owner-pilot Bridal: More → Wedding Setup)
//   { action: "get" }                       guests.view: the setup + hasHero
//   { action: "save", setup: { ... } }      guests.manage: couple, date, venues,
//                                           maps, dress code, message, RSVP deadline,
//                                           RSVP on/off, close after deadline
//   { action: "hero", dataUrl | null }      guests.manage: the cover photo (shrunk
//                                           in the browser) or remove it
//   { action: "galleryAdd", dataUrl } / { action: "galleryRemove", photoId }   gallery photos
//                                           (shown by a customized Luna Bridal+ design)
//   { action: "preview", which }            guests.view: the draft / live design to preview
// get also returns the invitation level (Standard / Customized) and state.
// Content only: the design is Luna Super Admin's (/api/invitation-design).

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { readSetup, saveSetup, saveHero, addGalleryPhoto, removeGalleryPhoto, previewInvitation } from "./_lib/invitations.js";

export const createWeddingSetupHandler = (deps) =>
  weddingActionHandler("wedding-setup", {
    ...deps,
    actions: {
      get: { permission: "guests.view", fields: ["action"], run: (c) => readSetup(c) },
      // Owner-pilot Bridal+: gallery photos and a preview of the draft / live design.
      galleryAdd: { permission: "guests.manage", fields: ["action", "dataUrl"], run: (c, b) => addGalleryPhoto({ ...c, dataUrl: b.dataUrl }) },
      galleryRemove: { permission: "guests.manage", fields: ["action", "photoId"], run: (c, b) => removeGalleryPhoto({ ...c, photoId: b.photoId }) },
      preview: { permission: "guests.view", fields: ["action", "which"], run: (c, b) => previewInvitation({ ...c, which: b.which }) },
      save: { permission: "guests.manage", fields: ["action", "setup"], run: (c, b) => saveSetup({ ...c, input: b.setup }) },
      hero: { permission: "guests.manage", fields: ["action", "dataUrl"], run: (c, b) => saveHero({ ...c, dataUrl: b.dataUrl ?? null }) },
    },
  });

export const handler = createWeddingSetupHandler({ getAdmin });
