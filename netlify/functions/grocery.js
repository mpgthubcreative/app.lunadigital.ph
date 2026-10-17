// /api/grocery   (Luna Household Grocery List)
//   { action: "add", item: { name, qty?, category? } }        grocery.manage, or grocery.check when the Owner allows helpers to add
//   { action: "addMany", items: [...], source?: "sample" }     same (Sample Grocery List: Add selected)
//   { action: "update", itemId, changes: { name?, qty?, category? } }   grocery.manage
//   { action: "check", itemId, bought }                        grocery.check (bought / not yet)
//   { action: "remove", itemId }                               grocery.manage
//   { action: "clearBought" }                                  grocery.manage
//   { action: "settings", staffCanAdd }                        grocery.manage
// Reads go straight to Firestore (grocery.view). Nothing here touches money.

import { getAdmin } from "./_lib/firebase-admin.js";
import { babyActionHandler } from "./_lib/baby-http.js";
import { addGroceryItems, updateGroceryItem, checkGroceryItem, removeGroceryItem, clearBoughtGrocery, setGrocerySettings } from "./_lib/grocery.js";

const M = "grocery.manage";
const C = "grocery.check";
export function createGroceryHandler(deps) {
  return babyActionHandler("grocery", {
    ...deps,
    actions: {
      add: { permission: C, created: true, fields: ["action", "item"], run: (c, b, ctx) => addGroceryItems({ ...c, permissions: ctx.permissions, items: [b.item] }) },
      addMany: { permission: C, created: true, fields: ["action", "items", "source"], run: (c, b, ctx) => addGroceryItems({ ...c, permissions: ctx.permissions, items: b.items, source: b.source }) },
      update: { permission: M, fields: ["action", "itemId", "changes"], run: (c, b) => updateGroceryItem({ ...c, itemId: b.itemId, changes: b.changes }) },
      check: { permission: C, fields: ["action", "itemId", "bought"], run: (c, b) => checkGroceryItem({ ...c, itemId: b.itemId, bought: b.bought }) },
      remove: { permission: M, fields: ["action", "itemId"], run: (c, b) => removeGroceryItem({ ...c, itemId: b.itemId }) },
      clearBought: { permission: M, fields: ["action"], run: (c) => clearBoughtGrocery(c) },
      settings: { permission: M, fields: ["action", "staffCanAdd"], run: (c, b) => setGrocerySettings({ ...c, staffCanAdd: b.staffCanAdd }) },
    },
  });
}

export const handler = createGroceryHandler({ getAdmin });
