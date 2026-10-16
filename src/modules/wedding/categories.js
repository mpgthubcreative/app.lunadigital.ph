// Owner-pilot Bridal UX: a category is typed, not administered. The forms
// take a category NAME (suggestions: the wedding's own categories, then the
// usual wedding ones); on save Luna uses the matching category, brings back
// an inactive one, or creates it on the spot (no budget: Budget can come
// later). Nothing is required first. A blank category is "Miscellaneous".
// Financial logic is unchanged: every expense still has a real category id.

import { SUGGESTED_WEDDING_CATEGORIES, SUPPLIER_SERVICES } from "@shared/index.js";

export const DEFAULT_CATEGORY = "Miscellaneous";
const key = (s) => (s || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");

export const categoryNameOf = (categories, id) => categories.find((c) => c.id === id)?.name ?? "";

// The typed field (a text box with suggestions; any name allowed).
export function categoryField(categories, { value = "", label = "Category", more = false, hint = "" } = {}) {
  const own = categories.filter((c) => c.status === "active").map((c) => c.name);
  const seen = new Set(own.map(key));
  return { name: "category", label, value, placeholder: "e.g. Venue", suggestions: [...own, ...SUGGESTED_WEDDING_CATEGORIES.filter((n) => !seen.has(key(n)))], hint, more };
}

// The category id for a typed name, creating / reactivating it if needed.
// canCreate = budget.manage (the server re-checks).
export async function resolveCategory(text, { categories, data, canCreate }) {
  const name = (text || "").trim().replace(/\s+/g, " ") || DEFAULT_CATEGORY;
  const found = categories.find((c) => key(c.name) === key(name));
  if (found && found.status === "active") return found.id;
  if (!canCreate) throw new Error(found ? `${found.name} is switched off. Ask the Owner to turn it back on under Budget.` : `There's no category "${name}" yet. Pick one from the list, or ask the Owner to add it.`);
  if (found) {
    await data.budgetApi({ action: "setCategoryStatus", categoryId: found.id, status: "active" });
    found.status = "active";
    return found.id;
  }
  const r = await data.budgetApi({ action: "createCategory", category: { name, budget: null } });
  categories.push({ id: r.categoryId, name, status: "active", budget: null });
  return r.categoryId;
}

// A supplier's service, guessed from its category when not chosen.
const GUESS = [
  [/venue|reception|hall/, "venue"],
  [/church|ceremony|officiant/, "church"],
  [/cater|food/, "catering"],
  [/flower|floral|styl|decor/, "styling"],
  [/photo|video|film/, "photo_video"],
  [/gown|suit|attire|dress|barong/, "attire"],
  [/hair|make ?up|hmua|glam/, "hair_makeup"],
  [/coordinat|planner/, "coordinator"],
  [/music|band|dj|host|entertain|sound|light/, "entertainment"],
  [/cake|dessert|pastr/, "cake"],
  [/invit|station|print/, "stationery"],
  [/transport|car|van|bus/, "transport"],
  [/hotel|accommod|room/, "accommodation"],
];
export function guessService(categoryName) {
  const k = key(categoryName);
  for (const [re, id] of GUESS) if (re.test(k) && SUPPLIER_SERVICES[id]) return id;
  return "other";
}
