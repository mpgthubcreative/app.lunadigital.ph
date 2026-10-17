// Luna Household: Grocery List (household-payroll v4). A shared shopping
// checklist, separate from Household money: checking an item means it was
// bought; it never creates an expense (the price isn't known here). After a
// trip, "Record grocery expense" opens Expenses with Groceries + today and
// the Owner enters the real total (one expense, never one per item).
//
// groceryItems/{id}:
//   name, nameLower, qty (free text, optional), category (free text,
//   optional; suggestions = the sample groups), bought, boughtAt, boughtBy,
//   source ("manual" | "sample"), createdAt / createdBy, updatedAt / updatedBy
// groceryLists/current: { staffCanAdd } (the Owner lets household staff add items)
// Room for later (not built): "Frequently bought" / "Buy again" can be read
// from the same records (name + times bought); no recurring schedules.

import { BabyError } from "./baby.js";

export const GROCERY_SETTINGS_DOC_ID = "current";
export const MAX_GROCERY_ITEMS = 300;
export const MAX_GROCERY_BATCH = 60;
const LIMITS = { name: 80, qty: 30, category: 40 };

// The Sample Grocery List: a starter library (nothing is on the user's list
// until they add it). Groups double as the category suggestions.
export const SAMPLE_GROCERY = Object.freeze([
  { group: "Fresh Produce", items: ["Onion", "Garlic", "Tomato", "Potato", "Carrot", "Cabbage", "Pechay", "Sayote", "Calamansi", "Banana", "Apple"] },
  { group: "Meat & Seafood", items: ["Chicken", "Pork", "Beef", "Fish", "Shrimp", "Hotdog"] },
  { group: "Dairy & Eggs", items: ["Eggs", "Fresh milk", "Cheese", "Butter", "Yogurt"] },
  { group: "Pantry", items: ["Rice", "Cooking oil", "Sugar", "Salt", "Soy sauce", "Vinegar", "Fish sauce", "Ketchup", "Canned goods", "Instant noodles", "Coffee"] },
  { group: "Breakfast", items: ["Bread", "Oatmeal", "Cereal", "Peanut butter", "Jam"] },
  { group: "Snacks", items: ["Biscuits", "Chips", "Crackers", "Chocolate"] },
  { group: "Drinks", items: ["Bottled water", "Juice", "Soft drinks", "Powdered juice"] },
  { group: "Frozen", items: ["Frozen dumplings", "Nuggets", "Ice cream"] },
  { group: "Baby", items: ["Diapers", "Baby wipes", "Formula / milk", "Baby wash"] },
  { group: "Pets", items: ["Dog/cat food", "Treats", "Pee pads", "Pet shampoo"] },
  { group: "Cleaning", items: ["Dishwashing liquid", "Bleach", "Floor cleaner", "Sponges"] },
  { group: "Laundry", items: ["Laundry detergent", "Fabric conditioner"] },
  { group: "Toiletries", items: ["Tissue", "Shampoo", "Soap", "Toothpaste", "Toothbrush"] },
  { group: "Household Supplies", items: ["Trash bags", "Paper towels", "Aluminum foil", "Light bulbs", "Batteries"] },
].map((g) => Object.freeze({ group: g.group, items: Object.freeze(g.items) })));
export const GROCERY_CATEGORIES = Object.freeze(SAMPLE_GROCERY.map((g) => g.group));

export const groceryKey = (name) => String(name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
const text = (v, field, { required = false } = {}) => {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new BabyError("invalid-input", "Enter the item");
    return null;
  }
  if (typeof v !== "string") throw new BabyError("invalid-input", `Invalid ${field}`);
  const s = v.trim().replace(/\s+/g, " ");
  if (s.length > LIMITS[field]) throw new BabyError("invalid-input", `Keep the ${field === "qty" ? "quantity" : field} under ${LIMITS[field]} characters`);
  return s;
};

// { name, qty?, category? } (partial: only the given fields).
export function validateGroceryItem(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BabyError("invalid-input", "Invalid item");
  for (const k of Object.keys(input)) if (!["name", "qty", "category"].includes(k)) throw new BabyError("invalid-input", `Field ${k} can't be set here`);
  const out = {};
  if (!partial || "name" in input) out.name = text(input.name, "name", { required: true });
  if (!partial || "qty" in input) out.qty = text(input.qty, "qty");
  if (!partial || "category" in input) out.category = text(input.category, "category");
  if (partial && !Object.keys(out).length) throw new BabyError("invalid-input", "Nothing to change");
  return out;
}

// Active list first (by category, then name); bought ones in the order bought (latest first).
export function sortGrocery(rows) {
  // No category last.
  const active = rows.filter((r) => !r.bought).sort((a, b) => (a.category ? 0 : 1) - (b.category ? 0 : 1) || (a.category || "").localeCompare(b.category || "") || a.nameLower.localeCompare(b.nameLower));
  const t = (r) => (r.boughtAt && typeof r.boughtAt.toMillis === "function" ? r.boughtAt.toMillis() : r.boughtAt ? new Date(r.boughtAt).getTime() : 0);
  const bought = rows.filter((r) => r.bought).sort((a, b) => t(b) - t(a));
  return { active, bought };
}
