// POST /api/notifications   (Phase 13: the caller's OWN inbox only)
//   { action: "read", notificationId }      mark one read
//   { action: "readAll" }                   mark every unread one read
//   { action: "preferences", preferences }  { [category]: { inApp: bool } }
// Needs notifications.view (core Dashboard module) and the plan's in-app
// notifications. The uid always comes from the verified token, never the
// body, so nobody can touch another member's or business's inbox. Reads go
// straight to Firestore under the rules (own inbox only). Read state is the
// user's own, not business data: it works while the account is suspended.
// Notifications themselves are created only by server-side business events.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { only } from "./_lib/inventory-http.js";
import { markRead, markAllRead, setPreferences } from "./_lib/notifications.js";
import { NOTIFICATIONS_PERMISSION, NotificationError, notificationsEnabled } from "../../shared/notifications.js";

const ACTIONS = {
  read: ["action", "notificationId"],
  readAll: ["action"],
  preferences: ["action", "preferences"],
};

const STATUS = { "not-found": 404, "invalid-notification": 400, "invalid-preferences": 400, "mandatory-notification": 400 };

export function createNotificationsHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("notifications", async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 4000);
    } catch (err) {
      bodyError = err;
    }
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: NOTIFICATIONS_PERMISSION });
    if (!notificationsEnabled(ctx.entitlements)) throw new RequestError("forbidden", "This feature isn't available for your account.", 403);
    if (bodyError) throw bodyError;
    const fields = body && Object.prototype.hasOwnProperty.call(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    if (!fields) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, fields);

    const common = { db, tenant: ctx.tenant, uid: ctx.uid, FieldValue: admin.firestore.FieldValue };
    try {
      switch (body.action) {
        case "read":
          return respond(200, { success: true, ...(await markRead({ ...common, notificationId: body.notificationId })) });
        case "readAll":
          return respond(200, { success: true, ...(await markAllRead(common)) });
        default:
          return respond(200, { success: true, ...(await setPreferences({ ...common, preferences: body.preferences })) });
      }
    } catch (err) {
      if (err instanceof NotificationError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createNotificationsHandler({ getAdmin });
