// Owner-pilot Bridal: the built-in Sample Checklist (Tasks) and Sample
// Budget (Money). A curated starter guide drawn from a real Filipino bride's
// planning checklist and payment plan: duplicates merged, plain short
// labels, grouped, with church- or wedding-specific items marked optional.
// No supplier names, no prices. Reference only: nothing here is a record
// until the bride taps + Add (a normal task / a Planned Money line).

// Item shapes: "Title" | { title, optional?, both? } | { heading } (a small
// subheading inside a group). both: needed for the bride AND the groom (the
// task tracks each one's done mark). A group may carry a note shown only in
// the sample view (e.g. "requirements vary by parish").
const item = (i) => (typeof i === "string" ? { title: i, optional: false, both: false } : i.heading ? { heading: i.heading } : { optional: false, both: false, ...i });
const freeze = (groups) => Object.freeze(groups.map((g) => Object.freeze({ ...g, items: Object.freeze(g.items.map((i) => Object.freeze(item(i)))) })));
const opt = (title, extra = {}) => ({ title, optional: true, ...extra });
const both = (title, extra = {}) => ({ title, both: true, ...extra });

// Each group's label becomes the task's category when added. Duplicates are
// merged: PSA / CENOMAR live under the marriage license (the parish asks
// for the same papers); Veil appears once (attire), the ceremony one is the
// sponsors' unity veil.
export const SAMPLE_CHECKLIST = freeze([
  { id: "documents", label: "Documents & Legal", items: [both("Valid government IDs"), both("Recent 2x2 ID photos"), opt("Passports (honeymoon / travel)"), opt("Joint bank account"), opt("Update names on IDs and accounts (after the wedding)")] },
  {
    id: "church",
    label: "Church Requirements",
    optional: true,
    note: "Optional · requirements vary by church / parish. Ask your parish office for its list.",
    items: [
      both("Baptismal certificate (for marriage purposes)"),
      both("Confirmation certificate (for marriage purposes)"),
      "Copy of the marriage license for the parish",
      both("Canonical interview"),
      "Marriage banns",
      opt("Parish permission / endorsement (if marrying outside your parish)"),
      both("Pre-Cana / marriage counseling"),
      "Principal sponsors list",
      both("Confession before the wedding"),
      { heading: "Officiating priest (if not from the parish)" },
      opt("Priest's celebret / letter of good standing"),
      opt("Delegation / permission from the parish priest"),
      opt("Priest's honorarium and transportation"),
    ],
  },
  {
    id: "civil",
    label: "Civil / Marriage License",
    note: "Requirements vary by city / municipality. Verify with your local civil registrar.",
    items: [both("PSA birth certificate"), both("CENOMAR (Certificate of No Marriage)"), both("Pre-marriage orientation / counseling"), opt("Barangay certificate / barangay ID (if required)", { both: true }), both("Valid government ID for the application"), "Marriage license application", opt("Parental consent / advice (if under 25)")],
  },
  { id: "ceremony", label: "Ceremony", items: ["Church / ceremony venue", "Officiant / priest", "Ceremony program & readings", opt("Ceremony accessories (lanterns, aisle)")] },
  { id: "reception", label: "Reception", items: ["Reception venue", "Caterer", "Stylist / florist", "Host / emcee", "Program flow", "Lights & sounds (with operator)", "Wedding cake (and delivery)", "Registration / reception setup", "Crew meals", "Bridal car / transportation", opt("Wine & beverages"), opt("Cocktail / waiting area")] },
  { id: "attire", label: "Attire & HMUA", items: ["Bridal gown", "Veil", "Bride's shoes", "Bride's hair & makeup", "Groom's attire", "Groom's shoes", "Groom's grooming", "Bridal bouquet", "Boutonnieres & corsages", "Bride's family attire", "Groom's family attire", "Maid of Honor & bridesmaids attire", "Best Man & groomsmen attire", opt("Flower girl & ring bearer attire"), opt("Flower girl baskets"), opt("Family / entourage hair & makeup")] },
  { id: "entourage", label: "Entourage", items: ["Principal sponsors", "Maid / Matron of Honor", "Best Man", "Bridesmaids", "Groomsmen", opt("Candle, veil & cord sponsors"), opt("Flower girl"), opt("Ring bearer"), opt("Coin / arras & Bible bearers")] },
  { id: "essentials", label: "Wedding Essentials", items: ["Wedding rings", opt("Cord"), opt("Candles"), opt("Unity veil (veil sponsors)"), opt("Arras (coins)"), opt("Bible"), opt("Garter")] },
  { id: "photo", label: "Photo & Video", items: ["Photographer", "Videographer", opt("Same-day edit (SDE)"), opt("Photobooth")] },
  { id: "invitations", label: "Invitations", items: ["Guest list", "Principal sponsor invitations", "Guest invitations", "Online invitation & RSVP (More → Wedding Setup)", "Send invitations"] },
  { id: "gifts", label: "Gifts & Souvenirs", items: ["Principal sponsor souvenirs", "Bridesmaids gifts", "Groomsmen gifts", "Guest souvenirs"] },
  { id: "prenup", label: "Prenup / Engagement Shoot", optional: true, items: ["Location", "Photographer", "Hair & makeup", "Theme", "Her outfit", "His outfit"] },
]);

// Each item's name becomes a Money category (a Planned line, no amount yet).
export const SAMPLE_BUDGET = freeze([
  { id: "venue", label: "Venue & Ceremony", items: ["Ceremony venue / church", "Officiant / priest", "Reception venue"] },
  { id: "food", label: "Food & Drinks", items: ["Catering", "Wedding cake", "Crew meals", opt("Wine & beverages")] },
  { id: "photo", label: "Photo & Video", items: ["Photo & Video", opt("Same-day edit (SDE)"), opt("Photobooth"), opt("Prenup shoot")] },
  { id: "attire", label: "Attire & HMUA", items: ["Bridal gown", "Groom's attire", "Entourage attire", "Hair & makeup"] },
  { id: "styling", label: "Flowers & Styling", items: ["Flowers & styling"] },
  { id: "entertainment", label: "Entertainment", items: ["Host / emcee", "Lights & sounds", opt("Band / music")] },
  { id: "rings", label: "Rings & Essentials", items: ["Wedding rings", "Wedding essentials (cord, candles)"] },
  { id: "guests", label: "Guests", items: ["Invitations", "Souvenirs"] },
  { id: "travel", label: "Transportation", items: ["Bridal car / transportation"] },
  { id: "other", label: "Other", items: ["Documents & fees", "Miscellaneous / allowance"] },
]);

const key = (s) => String(s || "").trim().toLocaleLowerCase("en");
// Is this sample line already on the bride's own list? (case-insensitive)
export const sampleAdded = (title, existingTitles) => new Set([...existingTitles].map(key)).has(key(title));
export const sampleKey = key;
