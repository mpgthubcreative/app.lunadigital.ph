// Rustic Garden's own sample content and photos (from the original design).
// TEMPLATE-OWNED: Owner editor / Clean Preview only, never stored, never
// shown to guests.
import { SAMPLE_STORY, SAMPLE_SCHEDULE, SAMPLE_COMMON } from "../../samples.js";

export default {
  data: {
    ...SAMPLE_COMMON,
    story: SAMPLE_STORY,
    schedule: SAMPLE_SCHEDULE,
    dressCode: "Garden Formal",
    dressCodeDetails: "Think elegant and breathable: suits or linen for him, midi or floor-length dresses for her. Soft neutrals and muted tones are perfect.",
    palette: [
      { name: "Sage green", hex: "#8fa382" },
      { name: "Rustic orange", hex: "#b4532a" },
      { name: "Black", hex: "#1a1a17" },
      { name: "Cream", hex: "#f3ebdd" },
    ],
    attireNotes: ["The ceremony is on the lawn: block heels recommended", "Evenings get cool, so bring a light layer", "Please avoid white and ivory"],
  },
  assets: {
    hero: "/invitations/samples/rustic/hero.webp",
    story1: "/invitations/samples/rustic/story1.webp",
    story2: "/invitations/samples/rustic/story2.webp",
    when: "/invitations/samples/shared/when.webp",
    venue: "/invitations/samples/shared/venue.webp",
    dressCode: "/invitations/samples/rustic/dressCode.webp",
  },
};
