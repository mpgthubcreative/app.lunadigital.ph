// The Bridal invitation registry: ONE list of every invitation design, for
// the guest page, the Owner's Wedding Setup, Super Admin and the server's
// validation (shared/invitation-design.js re-exports it). Designs are
// source code, never copied into a wedding: a wedding stores only a
// registered id (plus, for Luna Bridal Custom, Super Admin's overrides and
// draft / published state). Nothing anywhere picks a design by business or
// wedding: a wedding is given a design only through its registered id.
//
// Two categories, two folders (README.md):
//   templates/{id}/   "standard"    Luna Bridal: the Owner chooses one in
//                                   Wedding Setup (the free trial too)
//   customized/{id}/  "customized"  Luna Bridal Custom: Super Admin assigns
//                                   it in the design (Preview / Publish)
// Ids are permanent (weddings and designs store them).
//
// 2026-10-24: a design is presentation over ONE wedding profile (Wedding
// Setup). Each entry also says which profile fields it shows (`uses`),
// which it looks best with (`recommended`, for the "add these" prompt),
// its photo slots, its wording lines (with defaults the couple can
// reword) and accent colours, a version and a preview image. Two kinds of
// layout: "card" (the original card page) and "signature" (a full page:
// hero, countdown, story, details, schedule, dress code, RSVP).
//
// 2026-10-25 (template-first editing): only the designs marked `offered`
// (Gold Elegance, Black & White, Rustic Garden) are offered to new
// invitations; the older ones stay registered so the weddings that use
// them keep rendering. A design can also bring its own sample content and
// photos (templates/{id}/sample.js: sampleData / sampleAssets, preview
// only, never wedding data) and names its editable sections: which
// visible section edits which Wedding Setup fields, photo slots and
// wording lines, with a one-line guide (editableSections).

import standard from "./templates/standard/template.js";
import classic from "./templates/classic/template.js";
import modern from "./templates/modern/template.js";
import romantic from "./templates/romantic/template.js";
import editorial from "./templates/editorial/template.js";
import gold from "./templates/gold/template.js";
import monochrome from "./templates/monochrome/template.js";
import rustic from "./templates/rustic/template.js";
import garden from "./customized/garden/template.js";
import goldSample from "./templates/gold/sample.js";
import monochromeSample from "./templates/monochrome/sample.js";
import rusticSample from "./templates/rustic/sample.js";

const SAMPLES = { gold: goldSample, monochrome: monochromeSample, rustic: rusticSample };

export const CATEGORIES = Object.freeze({
  standard: { label: "Standard", availability: "Luna Bridal: the Owner chooses it in Wedding Setup (free trial: preview only)" },
  customized: { label: "Customized", availability: "Luna Bridal Custom: Super Admin assigns it, then previews and publishes" },
});

// Every section an invitation can show, in the default order.
export const SECTION_IDS = Object.freeze(["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"]);
export const LAYOUT_KINDS = Object.freeze(["card", "signature"]);

// The Wedding Setup fields each section shows, per layout kind. The RSVP
// meal choice and dietary note are part of every design's RSVP.
const CARD_FIELDS = {
  hero: ["coupleNames", "weddingDate"],
  welcome: ["welcomeMessage"],
  story: ["story"],
  ceremony: ["ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap"],
  reception: ["receptionTime", "receptionVenue", "receptionAddress", "receptionMap"],
  map: ["ceremonyMap", "receptionMap"],
  dressCode: ["dressCode"],
  entourage: [],
  gallery: [],
  faq: ["faq"],
  rsvp: ["rsvpEnabled", "rsvpDeadline", "closeAfterDeadline", "mealOptions", "askDietary"],
  footer: ["footerNote"],
};
const SECTION_FIELDS = Object.freeze({
  card: CARD_FIELDS,
  signature: {
    ...CARD_FIELDS,
    hero: ["coupleNames", "partner1Name", "partner2Name", "weddingDate", "ceremonyTime", "city"],
    welcome: ["welcomeMessage", "partner1Parents", "partner2Parents"],
    ceremony: [...CARD_FIELDS.ceremony, "schedule", "gettingThere"],
    reception: [...CARD_FIELDS.reception, "sameVenue"],
    dressCode: ["dressCode", "dressCodeDetails", "palette", "attireNotes"],
    faq: ["faq", "reminders", "giftNote"],
    rsvp: [...CARD_FIELDS.rsvp, "rsvpContact"],
    footer: ["footerNote", "city"],
  },
});
// Photo slots a design can ask for (weddingPhotos/{slot}; the cover photo
// is weddingSetup/hero and the gallery weddingGallery/*).
export const PHOTO_SLOTS = Object.freeze({ story1: "Story photo 1", story2: "Story photo 2", when: "Date photo", venue: "Venue photo", dressCode: "Dress code photo" });
// The card layout's wording lines (the same keys a Custom design's texts use).
const CARD_WORDING = Object.freeze({ scriptLine: "are getting married", rsvpTitle: "RSVP" });

// The Owner's editor, per layout: each editable section (data-edit in the
// renderer) → the Wedding Setup fields, photo slots ("hero" = the cover
// photo) and wording lines it edits, the invitation sections it belongs to
// (it's offered only when the design shows one of them) and its guide line.
// entourage → Guests (roles); gallery → the gallery photos.
const ED = (id, label, sections, o) => Object.freeze({ id, label, sections, fields: o.fields ?? [], photos: o.photos ?? [], wording: o.wording ?? [], guide: o.guide, ...(o.link ? { link: o.link } : {}) });
const SECTION_EDITORS = Object.freeze({
  signature: [
    ED("hero", "Names & date", ["hero"], { fields: ["partner1Name", "partner2Name", "coupleNames", "weddingDate", "city"], photos: ["hero"], wording: ["intro", "tagline", "countdownTitle"], guide: "Names · Date · City · Cover photo. Tap the names or the photo." }),
    ED("welcome", "Welcome & families", ["welcome"], { fields: ["welcomeMessage", "partner1Parents", "partner2Parents"], guide: "Welcome message · Parents. Tap the welcome text." }),
    ED("story", "Our story", ["story"], { fields: ["story"], photos: ["story1", "story2"], wording: ["storyEyebrow", "storyTitle"], guide: "Your story · Two photos. Tap Our Love Story." }),
    ED("details", "Wedding details", ["ceremony", "reception", "map"], { fields: ["ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap", "sameVenue", "receptionTime", "receptionVenue", "receptionAddress", "receptionMap", "gettingThere"], photos: ["when", "venue"], wording: ["detailsEyebrow", "detailsTitle"], guide: "Ceremony · Reception · Times · Map · Parking. Tap Wedding Details." }),
    ED("schedule", "Schedule", ["ceremony"], { fields: ["schedule"], wording: ["scheduleTitle"], guide: "The day's timeline. Tap the schedule." }),
    ED("dress", "Dress code", ["dressCode"], { fields: ["dressCode", "dressCodeDetails", "palette", "attireNotes"], photos: ["dressCode"], wording: ["dressEyebrow", "dressTitle"], guide: "Attire · Colours · Notes · Photo. Tap Dress Code." }),
    ED("goodToKnow", "Good to know", ["faq"], { fields: ["reminders", "giftNote", "faq"], guide: "Reminders · Gift note · FAQ. Tap Good to know." }),
    ED("rsvp", "RSVP", ["rsvp"], { fields: ["rsvpEnabled", "rsvpDeadline", "closeAfterDeadline", "rsvpContact", "mealOptions", "askDietary"], wording: ["rsvpEyebrow", "rsvpTitle"], guide: "Deadline · Meal choices · Dietary question · Contact. Tap RSVP." }),
    ED("entourage", "Entourage", ["entourage"], { link: "/guests", guide: "Comes from your guests' Roles (Guests → Role)." }),
    ED("gallery", "Gallery", ["gallery"], { guide: "Up to 6 photos. Tap the gallery." }),
    ED("closing", "Closing", ["footer"], { fields: ["footerNote"], wording: ["closing"], guide: "Closing line · Closing words. Tap the footer." }),
  ],
  card: [
    ED("hero", "Names & date", ["hero"], { fields: ["partner1Name", "partner2Name", "coupleNames", "weddingDate"], photos: ["hero"], wording: ["scriptLine"], guide: "Names · Date · Cover photo. Tap the names or the photo." }),
    ED("welcome", "Welcome message", ["welcome"], { fields: ["welcomeMessage"], guide: "Tap the welcome text." }),
    ED("story", "Our story", ["story"], { fields: ["story"], guide: "Tap Our story." }),
    ED("details", "Ceremony & reception", ["ceremony", "reception", "map"], { fields: ["ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap", "receptionTime", "receptionVenue", "receptionAddress", "receptionMap"], guide: "Times · Venues · Addresses · Maps. Tap Ceremony or Reception." }),
    ED("dress", "Dress code", ["dressCode"], { fields: ["dressCode"], guide: "Tap Dress code." }),
    ED("goodToKnow", "FAQ", ["faq"], { fields: ["faq"], guide: "Questions and answers. Tap Questions." }),
    ED("rsvp", "RSVP", ["rsvp"], { fields: ["rsvpEnabled", "rsvpDeadline", "closeAfterDeadline", "mealOptions", "askDietary"], wording: ["rsvpTitle"], guide: "Deadline · Meal choices · Dietary question. Tap RSVP." }),
    ED("entourage", "Entourage", ["entourage"], { link: "/guests", guide: "Comes from your guests' Roles (Guests → Role)." }),
    ED("gallery", "Gallery", ["gallery"], { guide: "Up to 6 photos. Tap the gallery." }),
    ED("closing", "Closing line", ["footer"], { fields: ["footerNote"], guide: "Tap the closing line." }),
  ],
});

// id · name · category · version · kind · source · preview · availability ·
// the sections the design shows and the ones it deliberately doesn't (a
// wedding's saved Gallery, Story or FAQ isn't shown by a design that lists
// it in doesNotShow; the README's table says the same) · the fields it uses.
// In the order they're offered.
export const TEMPLATE_REGISTRY = Object.freeze(
  [
    [standard, "standard"],
    [classic, "standard"],
    [modern, "standard"],
    [romantic, "standard"],
    [editorial, "standard"],
    [gold, "standard"],
    [monochrome, "standard"],
    [rustic, "standard"],
    [garden, "customized"],
  ].map(([file, category]) => {
    const kind = file.kind ?? "card";
    const sections = [...new Set([...file.show, ...(file.showsWhenAdded ?? [])])];
    return Object.freeze({
      id: file.id,
      name: file.label,
      description: file.description,
      category,
      version: file.version ?? 1,
      kind,
      variant: file.variant ?? null,
      source: `src/modules/wedding/invitation/${category === "standard" ? "templates" : "customized"}/${file.id}/template.js`,
      // The picker's thumbnail (Standard designs: Wedding Setup shows them).
      preview: category === "standard" ? `/invitations/previews/${file.id}.webp` : null,
      availability: CATEGORIES[category].availability,
      shows: Object.freeze([...file.show]),
      doesNotShow: Object.freeze(SECTION_IDS.filter((id) => !file.show.includes(id))),
      // Every invitation needs the names and the date (setupMissing).
      required: Object.freeze(["coupleNames", "weddingDate"]),
      uses: Object.freeze([...new Set(sections.flatMap((id) => SECTION_FIELDS[kind][id] ?? []))]),
      recommended: Object.freeze([...(file.recommended ?? ["ceremonyVenue", "ceremonyTime"])]),
      photoSlots: Object.freeze([...(file.photoSlots ?? [])]),
      wording: Object.freeze({ ...(file.wording ?? CARD_WORDING) }),
      accents: Object.freeze((file.accents ?? []).map((a) => Object.freeze({ ...a }))),
      offered: file.offered === true,
      // Template-owned preview content (templates/{id}/sample.js); null = none.
      sampleData: SAMPLES[file.id] ? Object.freeze(structuredClone(SAMPLES[file.id].data)) : null,
      sampleAssets: Object.freeze({ ...(SAMPLES[file.id]?.assets ?? {}) }),
      editableSections: Object.freeze(SECTION_EDITORS[kind].filter((e) => e.sections.some((s) => sections.includes(s)))),
      file,
    });
  })
);
const BY_ID = Object.fromEntries(TEMPLATE_REGISTRY.map((r) => [r.id, r]));

// A design file → the full defaults the design engine expects. `tier` is
// the older name of the category ("standard" / "custom"), kept because
// stored designs and the console read it.
function build(r) {
  const t = r.file;
  const order = [...t.order, ...SECTION_IDS.filter((id) => !t.order.includes(id))];
  return Object.freeze({
    label: t.label,
    description: t.description,
    category: r.category,
    tier: r.category === "standard" ? "standard" : "custom",
    kind: r.kind,
    variant: r.variant,
    version: r.version,
    theme: { ...t.theme },
    layout: { ...t.layout },
    hero: { ...t.hero },
    sections: { order, visible: Object.fromEntries(SECTION_IDS.map((id) => [id, t.show.includes(id)])) },
    gallery: { ...t.gallery },
    wording: r.wording,
    accents: r.accents,
    photoSlots: r.photoSlots,
  });
}

export const TEMPLATES = Object.freeze(Object.fromEntries(TEMPLATE_REGISTRY.map((r) => [r.id, build(r)])));
export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));
export const DEFAULT_TEMPLATE_ID = "standard";
// What an Owner can choose in Wedding Setup (Luna Bridal and the trial).
export const STANDARD_TEMPLATE_IDS = Object.freeze(TEMPLATE_REGISTRY.filter((r) => r.category === "standard").map((r) => r.id));
export const CUSTOMIZED_TEMPLATE_IDS = Object.freeze(TEMPLATE_REGISTRY.filter((r) => r.category === "customized").map((r) => r.id));
export const getTemplate = (id) => TEMPLATES[id] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
export const getTemplateEntry = (id) => BY_ID[id] ?? BY_ID[DEFAULT_TEMPLATE_ID];
export const isStandardTemplate = (id) => STANDARD_TEMPLATE_IDS.includes(id);
// What a new invitation can choose (Wedding Setup); the other Standard
// designs only keep rendering for the weddings that already use them.
export const OFFERED_TEMPLATE_IDS = Object.freeze(TEMPLATE_REGISTRY.filter((r) => r.offered).map((r) => r.id));
export const isOfferedTemplate = (id) => OFFERED_TEMPLATE_IDS.includes(id);
