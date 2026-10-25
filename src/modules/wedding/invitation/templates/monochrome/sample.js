// Black & White's own sample content and photos (from the original design).
// TEMPLATE-OWNED: Owner editor / Clean Preview only, never stored, never
// shown to guests.
import { SAMPLE_STORY, SAMPLE_SCHEDULE, SAMPLE_COMMON } from "../../samples.js";

export default {
  data: {
    ...SAMPLE_COMMON,
    story: SAMPLE_STORY,
    schedule: SAMPLE_SCHEDULE,
    dressCode: "Black Tie: Black & White",
    dressCodeDetails: "An evening in black and white. Gentlemen in black suits or tuxedos with crisp white shirts; ladies in black: floor-length gowns, sleek tailoring or elegant separates.",
    palette: [
      { name: "Black", hex: "#000000" },
      { name: "White (gentlemen only)", hex: "#ffffff" },
    ],
    attireNotes: ["Ladies in black only: white is reserved for the bride", "Gentlemen: black suit or tuxedo, white shirt, black tie optional", "Polished black shoes and minimal, refined accessories"],
  },
  assets: {
    hero: "/invitations/samples/monochrome/hero.webp",
    story1: "/invitations/samples/monochrome/story1.webp",
    story2: "/invitations/samples/monochrome/story2.webp",
    when: "/invitations/samples/shared/when.webp",
    venue: "/invitations/samples/shared/venue.webp",
    dressCode: "/invitations/samples/monochrome/dressCode.webp",
  },
};
