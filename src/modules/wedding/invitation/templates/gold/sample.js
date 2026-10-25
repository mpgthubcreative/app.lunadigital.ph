// Gold Elegance's own sample content and photos (from the original design).
// TEMPLATE-OWNED: shown only in the Owner's editor and Clean Preview where
// the wedding has nothing yet. Never stored as wedding data, never shown on
// a guest's invitation.
import { SAMPLE_STORY, SAMPLE_SCHEDULE, SAMPLE_COMMON } from "../../samples.js";

export default {
  data: {
    ...SAMPLE_COMMON,
    story: SAMPLE_STORY,
    schedule: SAMPLE_SCHEDULE,
    dressCode: "Garden Formal",
    dressCodeDetails: "Think elegant and breathable: suits or linen for him, midi or floor-length dresses for her. Soft neutrals and muted tones are perfect.",
    palette: [
      { name: "Light pink", hex: "#f4d3d7" },
      { name: "Sorbet yellow", hex: "#f6e3a1" },
      { name: "Light blue", hex: "#c9ddee" },
      { name: "Sage green", hex: "#b9c8ae" },
      { name: "Light purple", hex: "#d9cce8" },
    ],
    attireNotes: ["The ceremony is on the lawn: block heels recommended", "Evenings get cool, so bring a light layer", "Please avoid white and ivory"],
    mealOptions: ["Herb-roasted chicken", "Seared salmon", "Wild mushroom risotto (vegetarian)"],
  },
  assets: {
    hero: "/invitations/samples/gold/hero.webp",
    story1: "/invitations/samples/gold/story1.webp",
    story2: "/invitations/samples/gold/story2.webp",
    when: "/invitations/samples/shared/when.webp",
    venue: "/invitations/samples/shared/venue.webp",
    dressCode: "/invitations/samples/gold/dressCode.webp",
  },
};
