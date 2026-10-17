// Owner-pilot Bridal: Crew Meals. Who needs food on the wedding day, how
// many meals, and where they get them.
//   weddingCrewMeals/{id}       (server-only; /api/wedding-crew-meals)
//     { name, supplierId, supplierName, breakfast, lunch, dinner, location,
//       remarks, schemaVersion, createdBy/At, updatedBy/At }
//   crewMealSettings/current    { prices: { breakfast, lunch, dinner } }
//                               optional cost per head (centavos) for an
//                               estimated total; never required.
// Totals are computed from the list (never stored).

import { WeddingError } from "./wedding.js";

export const CREW_SCHEMA_VERSION = 1;
export const CREW_MAX_ITEMS = 200;
export const MEALS = Object.freeze(["breakfast", "lunch", "dinner"]);
export const MEAL_LABELS = Object.freeze({ breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" });
export const MEAL_SHORT = Object.freeze({ breakfast: "B", lunch: "L", dinner: "D" });
export const CREW_LOCATIONS = Object.freeze(["Hotel", "Church", "Reception"]);
export const SAMPLE_CREW = Object.freeze(["Photo team", "Video team", "HMUA team", "Coordinator", "Lights & sounds crew", "Photobooth crew", "Host / emcee", "Drivers", "Church assistants", "Reception staff"]);
const FIELDS = ["name", "supplierId", "breakfast", "lunch", "dinner", "location", "remarks"];
const MAX_MEALS = 999;
const MAX_PRICE = 100_000_00; // ₱100,000 per head

const text = (v, field, max, required = false) => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw new WeddingError("invalid-input", `${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new WeddingError("invalid-input", `${field} must be text`);
  const t = v.trim().replace(/\s+/g, " ");
  if (t.length > max) throw new WeddingError("invalid-input", `${field} must be ${max} characters or fewer`);
  return t;
};
const count = (v, field) => {
  if (v === undefined || v === null || v === "") return 0;
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_MEALS) throw new WeddingError("invalid-input", `${field}: a whole number from 0 to ${MAX_MEALS}`);
  return v;
};

export function validateCrewItem(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WeddingError("invalid-input", "Invalid crew meal");
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new WeddingError("invalid-input", `Field ${k} can't be set here`);
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("name")) out.name = text(input.name, "Crew / person", 60, true);
  for (const m of MEALS) if (has(m)) out[m] = count(input[m], MEAL_LABELS[m]);
  if (has("location")) out.location = text(input.location, "Location", 60);
  if (has("remarks")) out.remarks = text(input.remarks, "Remarks", 300);
  if (has("supplierId")) {
    const s = input.supplierId;
    if (s !== null && s !== undefined && s !== "" && !(typeof s === "string" && /^[A-Za-z0-9]{1,40}$/.test(s))) throw new WeddingError("invalid-input", "Invalid supplier");
    out.supplierId = s || null;
  }
  if (partial && !Object.keys(out).length) throw new WeddingError("invalid-input", "Nothing to change");
  return out;
}

export function validateMealPrices(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WeddingError("invalid-input", "Invalid meal prices");
  for (const k of Object.keys(input)) if (!MEALS.includes(k)) throw new WeddingError("invalid-input", "Invalid meal prices");
  const out = {};
  for (const m of MEALS) {
    const v = input[m];
    if (v === undefined || v === null) out[m] = null;
    else if (!Number.isSafeInteger(v) || v < 0 || v > MAX_PRICE) throw new WeddingError("invalid-input", `${MEAL_LABELS[m]} price per head must be ₱0 or more`);
    else out[m] = v;
  }
  return out;
}

// { breakfast, lunch, dinner, meals, cost (centavos | null when no price set) }
export function crewTotals(items, prices = {}) {
  const t = { breakfast: 0, lunch: 0, dinner: 0 };
  for (const i of items || []) for (const m of MEALS) t[m] += Number.isSafeInteger(i[m]) ? i[m] : 0;
  const priced = MEALS.filter((m) => Number.isSafeInteger(prices?.[m]));
  const cost = priced.length ? priced.reduce((sum, m) => sum + t[m] * prices[m], 0) : null;
  return { ...t, meals: t.breakfast + t.lunch + t.dinner, cost };
}
// "B 3 · L 3 · D 3" (meals with 0 left out; "—" when none).
export const mealLine = (i) => MEALS.filter((m) => i[m] > 0).map((m) => `${MEAL_SHORT[m]} ${i[m]}`).join(" · ") || "—";
