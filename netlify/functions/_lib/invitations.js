// Owner-pilot Bridal: Wedding Setup, personal invitation links and guest
// RSVP. The Bridal Guest record stays the ONE source of truth: a guest's
// answer updates that same guest (RSVP, confirmed seats, history with
// source "guest"), the RSVP totals (overall and per category) and frees a
// table seat when they're no longer attending, exactly like an Owner change.
//
// Records:
//   weddingSetup/current          the invitation details + RSVP settings
//   weddingSetup/hero             the cover photo (small JPEG data URL)
//   guestInvites/{guestId}        { token, hash, createdAt }  server-only
//   invitations/{sha256(token)}   { businessId, guestId, createdAt }  top
//                                 level, server-only (rules deny all)
// The token is 24 random bytes (base64url), never derived from ids; the
// lookup is by its SHA-256. Regenerating deletes the old lookup, so the old
// link stops working at once. Every bad / revoked link gets the same answer.

import { createHash, randomBytes } from "node:crypto";
import { WeddingError, WEDDING_SCHEMA_VERSION, TOTALS_DOC_ID, RSVP_STATUSES, validateRsvp, validateWeddingSetup, rsvpOpen, setupMissing } from "../../../shared/wedding.js";
import { businessDate, isDayId } from "../../../shared/metrics.js";
import { prepareNotifications } from "./notifications.js";
import { tenantDb } from "./tenant-db.js";
import { guestTotalsWrite } from "./wedding.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_HISTORY = 200;
const HERO_MAX = 700_000; // characters of the data URL (~500 KB image)
export const hashInviteToken = (token) => createHash("sha256").update(token, "utf8").digest("hex");
const newToken = () => randomBytes(24).toString("base64url");
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const who = (actor) => (actor ? { uid: actor.uid, name: actor.name } : null);
const WORDS = { awaiting: "Waiting", attending: "Attending", declined: "Declined" };
export const rsvpWords = (status, seats) => `${WORDS[status] ?? status}${status === "attending" ? ` ${seats}` : ""}`;
const append = (list, e) => {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new WeddingError("history-full", "Too many changes on this record");
  return [...l, e];
};
const setupRef = (tenant) => tenant.doc("weddingSetup", "current");
const heroRef = (tenant) => tenant.doc("weddingSetup", "hero");
const totalsRef = (tenant) => tenant.doc("guestTotals", TOTALS_DOC_ID);
const BAD_LINK = () => new WeddingError("invalid-link", "This invitation link isn't valid. Please ask the couple for a new one.");

// ---- Wedding Setup (Owner side, guests.manage) ----
export async function readSetup({ tenant }) {
  const [s, h] = await Promise.all([setupRef(tenant).get(), heroRef(tenant).get()]);
  return { setup: s.exists ? s.data() : {}, hasHero: h.exists && typeof h.data().dataUrl === "string" };
}
export async function saveSetup({ db, tenant, FieldValue, input, actor }) {
  const data = validateWeddingSetup(input || {});
  await setupRef(tenant).set({ schemaVersion: WEDDING_SCHEMA_VERSION, ...data, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  // Read back: the Owner sees what was really stored.
  const back = await setupRef(tenant).get();
  return { saved: true, setup: back.exists ? back.data() : {} };
}
export async function saveHero({ tenant, FieldValue, dataUrl, actor }) {
  if (dataUrl === null) {
    await heroRef(tenant).delete();
    return { hero: false };
  }
  if (typeof dataUrl !== "string" || dataUrl.length > HERO_MAX || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new WeddingError("invalid-input", "Choose a JPEG, PNG or WebP photo (it's shrunk before upload)");
  await heroRef(tenant).set({ dataUrl, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
  return { hero: true };
}

// ---- Links (Owner side, guests.manage) ----
// A link needs a set-up invitation: the couple's names and the date.
async function requireSetup(tenant) {
  const s = await setupRef(tenant).get();
  const missing = setupMissing(s.exists ? s.data() : {});
  if (missing.length) throw new WeddingError("setup-incomplete", `Complete Wedding Setup first (More → Wedding Setup): add ${missing.join(" and ")}.`);
}
// Creates the guest's link, or a new one replacing (revoking) the old.
export async function issueInvite({ db, tenant, guestId, actor, now = new Date() }) {
  const gRef = tenant.doc("guests", guestId);
  const iRef = tenant.doc("guestInvites", guestId);
  if (!(await gRef.get()).exists) throw new WeddingError("not-found", "Guest not found");
  await requireSetup(tenant);
  const token = newToken();
  const hash = hashInviteToken(token);
  await db.runTransaction(async (tx) => {
    const [g, prev] = [await tx.get(gRef), await tx.get(iRef)];
    if (!g.exists) throw new WeddingError("not-found", "Guest not found");
    if (prev.exists && prev.data().hash) tx.delete(db.collection("invitations").doc(prev.data().hash));
    tx.create(db.collection("invitations").doc(hash), { businessId: tenant.businessId, guestId, createdAt: now });
    tx.set(iRef, { token, hash, createdAt: now, createdBy: who(actor) });
    const gd = g.data();
    tx.update(gRef, { invitation: { status: "active", issuedAt: now, regenerated: prev.exists }, history: append(gd.history, { at: now, actor: who(actor), label: prev.exists ? "Invitation link replaced (the old link no longer works)" : "Invitation link created" }) });
  }, TX_OPTIONS);
  return { token, path: `/invite/${token}`, created: true };
}
// The current link (made on first use).
export async function inviteLink({ db, tenant, guestId, actor, now }) {
  const i = await tenant.doc("guestInvites", guestId).get();
  if (i.exists && i.data().token) return { token: i.data().token, path: `/invite/${i.data().token}`, created: false };
  return issueInvite({ db, tenant, guestId, actor, now });
}

// ---- Public (the guest; no login) ----
async function resolve(db, token) {
  if (typeof token !== "string" || !TOKEN.test(token)) throw BAD_LINK();
  const link = await db.collection("invitations").doc(hashInviteToken(token)).get();
  if (!link.exists) throw BAD_LINK();
  const { businessId, guestId } = link.data();
  const biz = db.collection("businesses").doc(businessId);
  const [b, g] = await Promise.all([biz.get(), biz.collection("guests").doc(guestId).get()]);
  if (!b.exists || !g.exists || b.data().entitlements?.workspaceTemplateId !== "bridal-expense") throw BAD_LINK();
  return { businessId, guestId, biz, business: b.data(), guest: g.data(), linkRef: link.ref };
}
const publicSetup = (s) => Object.fromEntries(["coupleNames", "weddingDate", "ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap", "receptionTime", "receptionVenue", "receptionAddress", "receptionMap", "dressCode", "welcomeMessage", "rsvpDeadline"].map((k) => [k, s[k] ?? null]));

export async function viewInvite({ db, token, now = new Date() }) {
  const r = await resolve(db, token);
  const [s, h] = await Promise.all([r.biz.collection("weddingSetup").doc("current").get(), r.biz.collection("weddingSetup").doc("hero").get()]);
  const setup = s.exists ? s.data() : {};
  const today = businessDate(r.business.timezone || "Asia/Manila", now);
  // Only what this party needs: their name, seats and answer. No ids.
  return {
    wedding: publicSetup(setup),
    hero: h.exists ? h.data().dataUrl : null,
    guest: { name: r.guest.name, seats: int(r.guest.partySize), rsvp: r.guest.rsvp, confirmed: int(r.guest.confirmed) },
    rsvpOpen: rsvpOpen(setup, today),
  };
}

export async function respondInvite({ db, FieldValue, token, rsvp, now = new Date() }) {
  const r = await resolve(db, token);
  const gRef = r.biz.collection("guests").doc(r.guestId);
  const sRef = r.biz.collection("weddingSetup").doc("current");
  const tenant = tenantDb(db, r.businessId);
  return db.runTransaction(async (tx) => {
    const [link, snap, setupSnap] = [await tx.get(r.linkRef), await tx.get(gRef), await tx.get(sRef)];
    await tx.get(totalsRef(tenant));
    if (!link.exists || !snap.exists) throw BAD_LINK();
    const setup = setupSnap.exists ? setupSnap.data() : {};
    const today = businessDate(r.business.timezone || "Asia/Manila", now);
    if (!rsvpOpen(setup, today)) throw new WeddingError("rsvp-closed", isDayId(setup.rsvpDeadline) && setup.rsvpEnabled ? "RSVPs for this wedding are closed. Please contact the couple." : "RSVPs aren't open. Please contact the couple.");
    const g = snap.data();
    const status = rsvp?.status;
    if (!["attending", "declined"].includes(status)) throw new WeddingError("invalid-input", "Choose Accept or Decline");
    const v = validateRsvp(status === "attending" ? { status, confirmed: Number(rsvp.confirmed) } : { status }, g.partySize);
    if (v.status === g.rsvp && v.confirmed === int(g.confirmed)) return { rsvp: v.status, confirmed: v.confirmed, unchanged: true, name: g.name };
    const next = { ...g, rsvp: v.status, confirmed: v.confirmed };
    const unseat = v.status !== "attending" && Boolean(g.tableId);
    const label = `Guest responded: ${rsvpWords(v.status, v.confirmed)}${g.rsvp !== "awaiting" ? ` (was ${rsvpWords(g.rsvp, int(g.confirmed))})` : ""}${unseat ? " · removed from their table" : ""}`;
    const notes = await prepareNotifications(tx, {
      tenant,
      events: [{ type: "guest.rsvp", key: `${r.guestId}-${now.getTime()}`, title: `${g.name} RSVP'd ${rsvpWords(v.status, v.confirmed).replace(/ (\d+)$/, " · $1")}`, message: `${g.name} answered their invitation: ${rsvpWords(v.status, v.confirmed).replace(/ (\d+)$/, " · $1")}.`, recordType: "guest", recordId: r.guestId }],
    });
    const stamp = FieldValue.serverTimestamp();
    tx.update(gRef, { rsvp: v.status, confirmed: v.confirmed, rsvpDate: today, rsvpSource: "guest", ...(unseat ? { tableId: null } : {}), history: append(g.history, { at: now, actor: null, label, source: "guest", from: { rsvp: g.rsvp, confirmed: int(g.confirmed) }, to: v }), revision: int(g.revision) + 1, updatedBy: { uid: null, name: `${g.name} (invitation)` }, updatedAt: stamp });
    tx.set(totalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...guestTotalsWrite(FieldValue, g, next), updatedAt: stamp }, { merge: true });
    notes.commit({ FieldValue });
    return { rsvp: v.status, confirmed: v.confirmed, name: g.name };
  }, TX_OPTIONS);
}

export { RSVP_STATUSES };
