// Owner-pilot Bridal: the built-in Sample Checklist (Tasks) and Sample
// Budget (Money). A curated starter guide drawn from a real Filipino bride's
// planning checklist and payment plan: duplicates merged, plain short
// labels, grouped, with church- or wedding-specific items marked optional.
// No supplier names, no prices. Reference only: nothing here is a record
// until the bride taps + Add (a normal task / a Planned Money line).

const freeze = (groups) => Object.freeze(groups.map((g) => Object.freeze({ ...g, items: Object.freeze(g.items.map((i) => Object.freeze(typeof i === "string" ? { title: i, optional: false } : { optional: false, ...i }))) })));
const opt = (title) => ({ title, optional: true });

// Each group's label becomes the task's category when added.
export const SAMPLE_CHECKLIST = freeze([
  { id: "documents", label: "Documents", items: ["PSA birth certificates", "CENOMAR", "Marriage license", "Valid IDs / passports", opt("Baptismal certificates"), opt("Confirmation certificates"), opt("Marriage banns"), opt("Canonical interview"), opt("Pre-Cana / Cana seminar"), opt("Joint bank account")] },
  { id: "ceremony", label: "Ceremony", items: ["Church / ceremony venue", "Officiant / priest", "Ceremony requirements", opt("Ceremony accessories (lanterns, aisle)")] },
  { id: "entourage", label: "Entourage", items: ["Principal sponsors", "Maid / Matron of Honor", "Best Man", "Bridesmaids", "Groomsmen", opt("Flower girl"), opt("Ring bearer")] },
  { id: "reception", label: "Reception", items: ["Reception venue", "Caterer", "Stylist / florist", "Host / emcee", "Program flow", "Lights & sounds (with operator)", "Wedding cake (and delivery)", "Registration / reception setup", "Crew meals", "Bridal car / transportation", opt("Wine & beverages"), opt("Cocktail / waiting area")] },
  { id: "attire", label: "Attire & HMUA", items: ["Bridal gown", "Veil", "Bride's shoes", "Bride's hair & makeup", "Groom's attire", "Groom's shoes", "Groom's grooming", "Bride's family attire", "Groom's family attire", "Maid of Honor & bridesmaids attire", "Best Man & groomsmen attire", opt("Flower girl & ring bearer attire"), opt("Family / entourage hair & makeup")] },
  { id: "flowers", label: "Flowers", items: ["Bridal bouquet", "Boutonnieres", "Corsages", opt("Flower girl baskets")] },
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
