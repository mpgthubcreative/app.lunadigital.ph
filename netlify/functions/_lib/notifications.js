// Luna Notifications Core, server side (Phase 13).
//
// Documents (businesses/{bid}/members/{uid}/...):
//   inbox/{notificationId}   one notification for ONE recipient    (own uid + notifications.view)
//   inboxState/summary       { unread }: the bell's counter         (own uid + notifications.view)
//   (members/{uid}.notificationPreferences: per-category channel choices)
//
// Consistency model: a notification is written IN THE SAME Firestore
// transaction as the business event that caused it (payment recorded,
// stock movement, order stage). Both commit or neither does: a payment can
// never exist without its "awaiting verification" notification, and a
// failed notification write can never leave a half-applied payment. The
// notification code adds reads only when an event actually notifies, never
// throws on bad member data (that member is skipped), and has no external
// dependency (email / push are not called inside transactions), so it
// can't make a valid operation fail.
//
// Idempotency: the notification id is derived from (type, event key), and
// the event key from state read in the transaction (payment id, the
// product's low-stock episode, the order revision). Retries and concurrent
// requests serialize on the business documents they touch, and an id that
// already exists in a recipient's inbox is never written again.
//
// Unread counter: incremented with the notification; mark-read / mark-all
// read it inside their transaction and write the exact clamped value, so
// concurrent creation, read and read-all can't make it wrong or negative.
//
// Usage (inside a transaction, all reads before writes):
//   const notes = await prepareNotifications(tx, { tenant, actor, events: [...] });
//   ...business writes...
//   notes.commit({ FieldValue });

import { NOTIFICATION_SCHEMA_VERSION, NOTIFICATION_TYPES, NotificationError, isEligibleRecipient, notificationId, notificationsEnabled, validatePreferences } from "../../../shared/notifications.js";

const NOOP = Object.freeze({ count: 0, recipients: [], commit: () => 0 });
const MAX_RECIPIENTS = 100; // per event; far above any plan's user limit
const READ_ALL_CHUNK = 200;
const READ_ALL_MAX_CHUNKS = 50;

const inbox = (tenant, uid) => tenant.member(uid).collection("inbox");
const stateRef = (tenant, uid) => tenant.member(uid).collection("inboxState").doc("summary");
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// events: [{ type, key, title, message, recordType?, recordId? }]
export async function prepareNotifications(tx, { tenant, events, actor = null }) {
  const list = (events || []).filter(Boolean);
  if (!list.length) return NOOP;
  for (const e of list) if (!NOTIFICATION_TYPES[e.type]) throw new Error(`Unknown notification type ${e.type}`);

  const [businessSnap, membersSnap] = await Promise.all([tx.get(tenant.ref), tx.get(tenant.collection("members").where("status", "==", "active"))]);
  const entitlements = businessSnap.exists ? businessSnap.data().entitlements : null;
  if (!notificationsEnabled(entitlements)) return NOOP;

  const planned = [];
  for (const e of list) {
    const rule = NOTIFICATION_TYPES[e.type];
    let n = 0;
    for (const m of membersSnap.docs) {
      if (rule.excludeActor && actor && m.id === actor.uid) continue;
      let ok = false;
      try {
        ok = isEligibleRecipient(e.type, { entitlements, member: m.data() });
      } catch {
        ok = false; // malformed member data: skip that member, never fail the event
      }
      if (!ok || ++n > MAX_RECIPIENTS) continue;
      planned.push({ uid: m.id, event: e, rule, ref: inbox(tenant, m.id).doc(notificationId(e.type, e.key)) });
    }
  }
  if (!planned.length) return NOOP;

  // Dedupe against what each inbox already holds (and within this call).
  const seen = new Set();
  const unique = planned.filter((p) => !seen.has(p.ref.path) && seen.add(p.ref.path));
  const existing = await tx.getAll(...unique.map((p) => p.ref));
  const fresh = unique.filter((_, i) => !existing[i].exists);

  return {
    count: fresh.length,
    recipients: [...new Set(fresh.map((p) => p.uid))],
    // `actor` may also be given here (callers that only know it at write time).
    commit({ FieldValue, actor: by = actor }) {
      const stamp = FieldValue.serverTimestamp();
      const perUser = new Map();
      for (const { uid, event: e, rule, ref } of fresh) {
        tx.create(ref, {
          schemaVersion: NOTIFICATION_SCHEMA_VERSION,
          businessId: tenant.businessId,
          recipientUid: uid,
          type: e.type,
          category: rule.category,
          module: rule.module,
          title: text(e.title, 80),
          message: text(e.message, 240),
          recordType: e.recordType ?? null,
          recordId: e.recordId ?? null,
          action: { ...rule.action },
          eventKey: e.key,
          actorName: by ? text(by.name || by.email || "", 80) : "",
          read: false,
          readAt: null,
          resolved: false,
          resolvedAt: null,
          // Channel state: in-app is the record; others aren't delivered yet.
          delivery: { inApp: "delivered", email: "not_sent", push: "not_sent" },
          createdAt: stamp,
        });
        perUser.set(uid, (perUser.get(uid) || 0) + 1);
      }
      for (const [uid, n] of perUser) tx.set(stateRef(tenant, uid), { unread: FieldValue.increment(n), updatedAt: stamp }, { merge: true });
      return fresh.length;
    },
  };
}

// The item a notification asked about was dealt with (e.g. the payment was
// verified or removed): every recipient's copy is marked resolved, and an
// unread one stops counting as unread. Reads all members (any status: a
// since-disabled recipient's counter stays right too).
export async function prepareResolution(tx, { tenant, type, key }) {
  const id = notificationId(type, key);
  const members = await tx.get(tenant.collection("members"));
  if (members.empty) return NOOP;
  const refs = members.docs.map((m) => inbox(tenant, m.id).doc(id));
  const snaps = await tx.getAll(...refs);
  const open = snaps.map((s, i) => ({ s, uid: members.docs[i].id, ref: refs[i] })).filter(({ s }) => s.exists && s.data().resolved !== true);
  if (!open.length) return NOOP;
  const unreadUids = open.filter(({ s }) => s.data().read !== true).map(({ uid }) => uid);
  const states = unreadUids.length ? await tx.getAll(...unreadUids.map((uid) => stateRef(tenant, uid))) : [];
  return {
    count: open.length,
    recipients: open.map(({ uid }) => uid),
    commit({ FieldValue }) {
      const stamp = FieldValue.serverTimestamp();
      for (const { s, ref } of open) tx.update(ref, { resolved: true, resolvedAt: stamp, ...(s.data().read !== true ? { read: true, readAt: stamp } : {}) });
      unreadUids.forEach((uid, i) => tx.set(stateRef(tenant, uid), { unread: Math.max(0, (states[i].exists ? states[i].data().unread : 0) - 1), updatedAt: stamp }, { merge: true }));
      return open.length;
    },
  };
}

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export async function markRead({ db, tenant, uid, notificationId: id, FieldValue }) {
  if (typeof id !== "string" || !ID.test(id)) throw new NotificationError("invalid-notification", "Invalid notification");
  const ref = inbox(tenant, uid).doc(id);
  return db.runTransaction(async (tx) => {
    const [snap, state] = await Promise.all([tx.get(ref), tx.get(stateRef(tenant, uid))]);
    if (!snap.exists) throw new NotificationError("not-found", "Notification not found");
    const unread = state.exists ? state.data().unread || 0 : 0;
    if (snap.data().read === true) return { notificationId: id, unread: Math.max(0, unread), unchanged: true };
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, { read: true, readAt: stamp });
    const next = Math.max(0, unread - 1);
    tx.set(stateRef(tenant, uid), { unread: next, updatedAt: stamp }, { merge: true });
    return { notificationId: id, unread: next };
  });
}

// Marks every unread notification of this user read, in chunks. Each chunk
// re-reads the counter, so a notification created meanwhile stays unread
// and counted; when the last chunk finds fewer than a full page, nothing
// else is unread, so the counter is exactly 0 (also repairs any drift).
export async function markAllRead({ db, tenant, uid, FieldValue }) {
  const unreadQuery = inbox(tenant, uid).where("read", "==", false).limit(READ_ALL_CHUNK);
  let marked = 0;
  for (let i = 0; i < READ_ALL_MAX_CHUNKS; i++) {
    const { n, done, unread } = await db.runTransaction(async (tx) => {
      const [snap, state] = await Promise.all([tx.get(unreadQuery), tx.get(stateRef(tenant, uid))]);
      const stamp = FieldValue.serverTimestamp();
      for (const d of snap.docs) tx.update(d.ref, { read: true, readAt: stamp });
      const current = state.exists ? state.data().unread || 0 : 0;
      const last = snap.size < READ_ALL_CHUNK;
      const next = last ? 0 : Math.max(0, current - snap.size);
      if (snap.size || current !== next) tx.set(stateRef(tenant, uid), { unread: next, updatedAt: stamp }, { merge: true });
      return { n: snap.size, done: last, unread: next };
    });
    marked += n;
    if (done) return { marked, unread };
  }
  return { marked, unread: null };
}

// The member's own per-category channel choices (stored on their member
// document, which recipient resolution already reads).
export async function setPreferences({ db, tenant, uid, preferences, FieldValue }) {
  const changes = validatePreferences(preferences);
  const ref = tenant.member(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new NotificationError("not-found", "Member not found");
    const current = snap.data().notificationPreferences || {};
    const next = { ...current };
    for (const [category, channels] of Object.entries(changes)) next[category] = { ...(current[category] || {}), ...channels };
    tx.update(ref, { notificationPreferences: next, updatedAt: FieldValue.serverTimestamp() });
    return { preferences: next };
  });
}
