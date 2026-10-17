// POST /api/wedding-crew-meals   (Owner-pilot Bridal: More → Crew Meals)
//   { action: "list" }                                     vendors.view: entries + meal prices
//   { action: "create", item: { name, supplierId?, breakfast?, lunch?, dinner?, location?, remarks? } }   vendors.manage
//   { action: "update", itemId, changes: { ...any of the above } }                                         vendors.manage
//   { action: "delete", itemId }                                                                           vendors.manage
//   { action: "setPrices", prices: { breakfast?, lunch?, dinner? } }   optional cost per head (centavos)   vendors.manage
// Server-only records; see ./_lib/wedding-crew.js.

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { listCrewMeals, createCrewMeal, updateCrewMeal, deleteCrewMeal, setMealPrices } from "./_lib/wedding-crew.js";

const M = "vendors.manage";
export const createWeddingCrewMealsHandler = (deps) =>
  weddingActionHandler("wedding-crew-meals", {
    ...deps,
    actions: {
      list: { permission: "vendors.view", fields: ["action"], run: (c) => listCrewMeals(c) },
      create: { permission: M, created: true, fields: ["action", "item"], run: (c, b) => createCrewMeal({ ...c, input: b.item }) },
      update: { permission: M, fields: ["action", "itemId", "changes"], run: (c, b) => updateCrewMeal({ ...c, itemId: b.itemId, changes: b.changes }) },
      delete: { permission: M, fields: ["action", "itemId"], run: (c, b) => deleteCrewMeal({ ...c, itemId: b.itemId }) },
      setPrices: { permission: M, fields: ["action", "prices"], run: (c, b) => setMealPrices({ ...c, prices: b.prices }) },
    },
  });

export const handler = createWeddingCrewMealsHandler({ getAdmin });
