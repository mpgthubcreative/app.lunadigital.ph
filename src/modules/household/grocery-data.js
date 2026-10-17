// Grocery List data access: reads straight from Firestore under the rules
// (grocery.view); every write goes through /api/grocery.

import { getFirestoreLite } from "../../lib/firebase.js";
import { api } from "../../lib/api.js";
import { GROCERY_SETTINGS_DOC_ID, MAX_GROCERY_ITEMS } from "@shared/grocery.js";

export async function listGrocery(businessId) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDocs(lite.query(lite.collection(db, "businesses", businessId, "groceryItems"), lite.limit(MAX_GROCERY_ITEMS)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function grocerySettings(businessId) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "groceryLists", GROCERY_SETTINGS_DOC_ID));
  return { staffCanAdd: snap.exists() && snap.data().staffCanAdd === true };
}

export const groceryApi = (body) => api("grocery", { method: "POST", body });
