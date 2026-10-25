// The sample couple the three signature designs were drawn with (Nicky &
// Sam, The Magnolia House). TEMPLATE-OWNED preview content only: see
// registry.js (sampleData) and the Owner's editor (setup.js, previewSetup).
export const SAMPLE_STORY = [
  "We met on a rainy October afternoon in a tiny bookshop, both reaching for the last copy of the same novel.",
  "Sam let Nicky have it, on the condition she tell him how it ended over coffee. Five years, two cities and one very patient dog later, he asked the question on that same street corner, in the rain, of course.",
  "We can't wait to begin this next chapter surrounded by the people who have shaped our story.",
].join("\n\n");
export const SAMPLE_SCHEDULE = [
  { time: "15:30", title: "Guests arrive" },
  { time: "16:00", title: "Ceremony in the garden" },
  { time: "16:45", title: "Cocktails & lawn games" },
  { time: "18:00", title: "Dinner & toasts" },
  { time: "20:00", title: "First dance" },
];
export const SAMPLE_COMMON = {
  partner1Name: "Nicky",
  partner2Name: "Sam",
  weddingDate: "2027-06-12",
  city: "Charleston, SC",
  ceremonyTime: "16:00",
  ceremonyVenue: "The Magnolia House",
  ceremonyAddress: "12 Garden Lane, Charleston, SC 29401",
  receptionTime: "18:00",
  sameVenue: true,
  gettingThere: "Free parking on site. Valet at the main entrance from 3:15 PM.",
  welcomeMessage: "Together with our families, we would love for you to celebrate with us.",
  partner1Family: [
    { relation: "father", name: "Robert Hayes" },
    { relation: "mother", name: "Linda Hayes" },
  ],
  partner2Family: [
    { relation: "father", name: "Daniel Brooks" },
    { relation: "mother", name: "Maria Brooks" },
    { relation: "sister", name: "Ella Brooks" },
  ],
  reminders: ["Please arrive 30 minutes before the ceremony"],
  giftNote: "Your presence is the greatest gift.",
  faq: [{ q: "Can we bring our children?", a: "We love your little ones, but this will be an adults-only celebration." }],
  rsvpEnabled: true,
  rsvpDeadline: "2027-05-01",
  rsvpContact: "hello@nickyandsam.com",
  footerNote: "We can't wait to celebrate with you.",
};

// ---- The Owner's preview: real wedding values, template samples where empty ----
// Groups fill as a whole: a group shows the template's sample only when the
// wedding has NOTHING in it (a real venue is never shown next to a sample
// address). Returns new objects; the real setup is never changed, and the
// result is for the Owner's editor / Clean Preview only (never saved, never
// sent to a guest).
export const SAMPLE_GROUPS = Object.freeze([
  ["names", "Names", ["partner1Name", "partner2Name", "coupleNames"]],
  ["date", "Wedding date", ["weddingDate"]],
  ["city", "City", ["city"]],
  ["details", "Ceremony & reception", ["ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap", "receptionTime", "receptionVenue", "receptionAddress", "receptionMap", "sameVenue"]],
  ["gettingThere", "Getting there", ["gettingThere"]],
  ["welcome", "Welcome message", ["welcomeMessage"]],
  ["family", "Family", ["partner1Family", "partner2Family", "partner1Parents", "partner2Parents"]],
  ["story", "Our story", ["story"]],
  ["schedule", "Schedule", ["schedule"]],
  ["dress", "Dress code", ["dressCode", "dressCodeDetails", "palette", "attireNotes"]],
  ["goodToKnow", "Good to know", ["reminders", "giftNote", "faq"]],
  ["rsvp", "RSVP details", ["rsvpDeadline", "rsvpContact", "mealOptions"]],
  ["closing", "Closing line", ["footerNote"]],
]);
const PHOTO_LABELS = { hero: "Cover photo", story1: "Story photo 1", story2: "Story photo 2", when: "Date photo", venue: "Venue photo", dressCode: "Dress code photo" };
export const isEmptyValue = (v) => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);
// entry: the registry entry (sampleData / sampleAssets); real: the stored
// setup; hero / photos: the couple's real photos.
export function previewSetup(entry, real = {}, { hero = null, photos = {} } = {}) {
  const sample = entry?.sampleData || null;
  const setup = structuredClone(real || {});
  const sampledFields = new Set();
  const sampled = [];
  if (sample) {
    for (const [id, label, fields] of SAMPLE_GROUPS) {
      if (!fields.every((k) => isEmptyValue(setup[k])) || !fields.some((k) => !isEmptyValue(sample[k]))) continue;
      for (const k of fields) if (!isEmptyValue(sample[k])) {
        setup[k] = structuredClone(sample[k]);
        sampledFields.add(k);
      }
      sampled.push({ id, label });
    }
    // RSVP on/off is a setting: only a wedding that never set it previews it on.
    if (setup.rsvpEnabled === undefined || setup.rsvpEnabled === null) setup.rsvpEnabled = sample.rsvpEnabled === true;
  }
  const assets = entry?.sampleAssets || {};
  const outPhotos = { ...photos };
  const sampledPhotos = [];
  for (const [slot, url] of Object.entries(assets)) {
    if (slot === "hero") continue;
    if (!outPhotos[slot]) {
      outPhotos[slot] = url;
      sampledPhotos.push({ id: slot, label: PHOTO_LABELS[slot] || slot });
    }
  }
  const outHero = hero || assets.hero || null;
  if (!hero && assets.hero) sampledPhotos.unshift({ id: "hero", label: PHOTO_LABELS.hero });
  return { setup, hero: outHero, photos: outPhotos, sampled, sampledPhotos, sampledFields };
}
