// Notifications reads, straight from Firestore under the rules (the caller's
// OWN inbox only; businesses/{bid}/members/{uid}/inbox). Writes (read,
// read-all, preferences) go through POST /api/notifications.

import { getFirestoreLite } from "../../lib/firebase.js";
import { runListQuery } from "../../lib/query.js";
import { api } from "../../lib/api.js";
import { notificationsQuery, NOTIFICATION_RECENT, NOTIFICATION_PAGE_SIZE } from "@shared/notifications.js";

const inboxPath = (uid) => `members/${uid}/inbox`;

// The bell: one document read, never a count over the inbox.
export async function fetchUnreadCount(businessId, uid) {
  const { db, lite } = await getFirestoreLite();
  const snap = await lite.getDoc(lite.doc(db, "businesses", businessId, "members", uid, "inboxState", "summary"));
  return snap.exists() ? Math.max(0, Number(snap.data().unread) || 0) : 0;
}

export async function fetchRecent(businessId, uid) {
  return (await runListQuery(businessId, inboxPath(uid), notificationsQuery(), { pageSize: NOTIFICATION_RECENT })).rows;
}

// { unread?, category? } filters; `cursor` = last row of the previous page.
export function listNotifications(businessId, uid, filters = {}, { cursor = null } = {}) {
  return runListQuery(businessId, inboxPath(uid), notificationsQuery(filters), { cursor, pageSize: NOTIFICATION_PAGE_SIZE });
}

export const markRead = (notificationId) => api("notifications", { method: "POST", body: { action: "read", notificationId } });
export const markAllRead = () => api("notifications", { method: "POST", body: { action: "readAll" } });
export const savePreferences = (preferences) => api("notifications", { method: "POST", body: { action: "preferences", preferences } });
