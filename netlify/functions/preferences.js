// POST /api/preferences   (the signed-in member's OWN preferences in this business)
//   { action: "setNavigation", navigation: { primary: [ids] } | null }
//     the phone's main tabs, in order (null = the workspace's default).
// Any active member except household staff (they have their own portal).
// Stored on members/{uid} of this business only; it changes nothing about
// modules, permissions or entitlements (shared/navigation-prefs.js).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { only } from "./_lib/inventory-http.js";
import { validateNavigationPreference, NavigationPrefError } from "../../shared/navigation-prefs.js";

export function createPreferencesHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("preferences", async (event) => {
    requireMethod(event, "POST");
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth });
    const body = parseJsonBody(event);
    if (body?.action !== "setNavigation") throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, ["action", "navigation"]);
    if (ctx.member.roleTemplate === "household_staff") throw new RequestError("forbidden", "This isn't available for your account.", 403);
    let navigation;
    try {
      navigation = validateNavigationPreference(body.navigation ?? null);
    } catch (err) {
      if (err instanceof NavigationPrefError) throw new RequestError(err.code, err.message, 400);
      throw err;
    }
    const FieldValue = admin.firestore.FieldValue;
    await ctx.tenant.member(ctx.uid).update({ navigationPreference: navigation, updatedAt: FieldValue.serverTimestamp() });
    return respond(200, { success: true, navigation });
  });
}

export const handler = createPreferencesHandler({ getAdmin });
