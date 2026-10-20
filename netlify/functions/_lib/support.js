// Luna Super Admin support access to a customer's workspace (2026-10-20).
//
// Managing a business (plan, billing, members, the Bridal invitation) is
// normal Super Admin work and never needs the customer's records. Looking
// at those records (guests, RSVPs, money, tasks, orders, payroll…) is
// SUPPORT access: explicit, with a reason, read-only, time-limited and
// audited.
//
//   supportSessions/{id}   server-only (rules deny every browser)
//     { businessId, operator: { uid, email }, reason, mode: "read-only",
//       startedAt, expiresAt (startedAt + 30 min), endedAt, endedBy }
//
// Every start, every area viewed and every exit is written to platformAudit
// AND the business's own auditLog (the customer's record of Luna's access).
// There is no edit mode: changes go through Super Admin's own audited tools
// (plan, billing, members, invitation), never through support access.

import { randomBytes } from "node:crypto";
import { getModule } from "../../../shared/modules.js";
import { tenantDb } from "./tenant-db.js";

export const SUPPORT_MINUTES = 30;
export const SUPPORT_MODES = Object.freeze(["read-only"]);
const MAX_ROWS = 100;
const sessions = (db) => db.collection("supportSessions");

export class SupportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// What support can look at: the collections of the modules this business
// has on (its entitlements), plus the wedding setup for a Bridal workspace.
// Never credentials or links: invitation tokens, activation / receipt links
// and payment proofs aren't areas.
export function supportAreas(business) {
  const on = business?.entitlements?.modules || {};
  const areas = [];
  for (const [id, enabled] of Object.entries(on)) {
    if (!enabled) continue;
    const m = getModule(id);
    if (!m || m.core) continue;
    for (const col of Object.keys(m.collections || {})) if (!areas.some((a) => a.id === col)) areas.push({ id: col, label: `${m.label}${Object.keys(m.collections).length > 1 ? ` · ${col}` : ""}`, module: id });
  }
  if (business?.workspaceTemplateId === "bridal-expense") areas.push({ id: "weddingSetup", label: "Wedding Setup", module: "setup" });
  return areas;
}

const iso = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v);
// A record as plain JSON (timestamps as ISO), long images left out.
function plain(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (value?.toDate) return iso(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.startsWith("data:") ? `[image ${Math.round(value.length / 1024)} KB]` : value;
  if (Array.isArray(value)) return depth > 3 ? `[${value.length} items]` : value.slice(0, 50).map((v) => plain(v, depth + 1));
  if (typeof value === "object") return depth > 3 ? "[…]" : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v, depth + 1)]));
  return value;
}

function record(db, FieldValue, businessId, entry) {
  const at = FieldValue.serverTimestamp();
  return [
    [db.collection("platformAudit").doc(), { ...entry, businessId, at }],
    [tenantDb(db, businessId).collection("auditLog").doc(), { ...entry, at }],
  ];
}

export async function startSupport({ db, FieldValue, businessId, reason, operator, now = new Date() }) {
  const why = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (why.length < 5 || why.length > 300) throw new SupportError("reason-required", "Say why you need to look (5 to 300 characters): it's recorded and the business can see it");
  const b = await db.collection("businesses").doc(businessId).get();
  if (!b.exists) throw new SupportError("not-found", "Business not found");
  const id = `sup${randomBytes(12).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + SUPPORT_MINUTES * 60_000);
  const batch = db.batch();
  batch.set(sessions(db).doc(id), { businessId, operator: { uid: operator.uid, email: operator.email ?? null }, reason: why, mode: "read-only", startedAt: FieldValue.serverTimestamp(), startedAtMs: now.getTime(), expiresAt, endedAt: null, endedBy: null });
  for (const [ref, data] of record(db, FieldValue, businessId, { type: "support.started", summary: `Luna support opened the workspace (read-only, ${SUPPORT_MINUTES} min): ${why}`, actor: operator.email ?? operator.uid, operator: { uid: operator.uid, email: operator.email ?? null }, reason: why, sessionId: id, mode: "read-only" })) batch.set(ref, data);
  await batch.commit();
  return { sessionId: id, mode: "read-only", expiresAt: expiresAt.toISOString(), areas: supportAreas(b.data()) };
}

// The operator's own live session for this business, or an error.
async function liveSession({ db, sessionId, businessId, operator, now }) {
  if (typeof sessionId !== "string" || !/^sup[0-9a-f]{24}$/.test(sessionId)) throw new SupportError("no-session", "Open the workspace as support first");
  const s = await sessions(db).doc(sessionId).get();
  if (!s.exists) throw new SupportError("no-session", "Open the workspace as support first");
  const d = s.data();
  if (d.operator?.uid !== operator.uid || (businessId && d.businessId !== businessId)) throw new SupportError("no-session", "That support session isn't yours");
  if (d.endedAt) throw new SupportError("session-ended", "This support session has ended. Open a new one with a reason.");
  const exp = d.expiresAt?.toDate ? d.expiresAt.toDate() : new Date(d.expiresAt);
  if (exp <= now) throw new SupportError("session-ended", "This support session has expired. Open a new one with a reason.");
  return { ref: s.ref, data: d, expiresAt: exp };
}
export const requireSupportSession = (args) => liveSession(args);

// One area, read-only (the newest records first where they have a date).
export async function supportRead({ db, FieldValue, sessionId, businessId, area, operator, now = new Date() }) {
  const s = await liveSession({ db, sessionId, businessId, operator, now });
  const b = await db.collection("businesses").doc(s.data.businessId).get();
  const areas = supportAreas(b.data());
  const a = areas.find((x) => x.id === area);
  if (!a) throw new SupportError("invalid-input", "That area isn't part of this workspace");
  const tenant = tenantDb(db, s.data.businessId);
  const snap = await tenant.collection(area).limit(MAX_ROWS + 1).get();
  const rows = snap.docs.slice(0, MAX_ROWS).map((d) => ({ id: d.id, ...plain(d.data()) }));
  const batch = db.batch();
  for (const [ref, data] of record(db, FieldValue, s.data.businessId, { type: "support.viewed", summary: `Luna support viewed ${a.label} (read-only)`, actor: operator.email ?? operator.uid, operator: { uid: operator.uid, email: operator.email ?? null }, sessionId, area, rows: rows.length })) batch.set(ref, data);
  await batch.commit();
  return { area, label: a.label, rows, more: snap.docs.length > MAX_ROWS, mode: "read-only", expiresAt: s.expiresAt.toISOString() };
}

export async function endSupport({ db, FieldValue, sessionId, operator, now = new Date() }) {
  let s;
  try {
    s = await liveSession({ db, sessionId, operator, now });
  } catch (err) {
    if (err.code === "session-ended") return { ended: true, alreadyEnded: true };
    throw err;
  }
  const minutes = Math.max(0, Math.round((now.getTime() - (s.data.startedAtMs ?? now.getTime())) / 60_000));
  const batch = db.batch();
  batch.update(s.ref, { endedAt: FieldValue.serverTimestamp(), endedBy: operator.email ?? operator.uid });
  for (const [ref, data] of record(db, FieldValue, s.data.businessId, { type: "support.ended", summary: `Luna support closed the workspace (${minutes} min)`, actor: operator.email ?? operator.uid, operator: { uid: operator.uid, email: operator.email ?? null }, sessionId })) batch.set(ref, data);
  await batch.commit();
  return { ended: true };
}

// The operator's open session for a business (to resume after a reload).
export async function openSupportSession({ db, businessId, operator, now = new Date() }) {
  // One equality filter (no composite index); a business has few sessions.
  const snap = await sessions(db).where("businessId", "==", businessId).limit(200).get();
  const live = snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((d) => d.operator?.uid === operator.uid && !d.endedAt && (d.expiresAt?.toDate ? d.expiresAt.toDate() : new Date(d.expiresAt)) > now);
  return live ? { sessionId: live.id, mode: live.mode, reason: live.reason, expiresAt: (live.expiresAt?.toDate ? live.expiresAt.toDate() : new Date(live.expiresAt)).toISOString() } : null;
}
