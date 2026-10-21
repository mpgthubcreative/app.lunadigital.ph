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
//   weddingSlugs/{slug}           { businessId }  the friendly part of the
//                                 links (/w/{slug}/invite/{token}), unique,
//                                 top level, server-only. Cosmetic: only
//                                 the token opens an invitation.
// The token is 24 random bytes (base64url), never derived from ids; the
// lookup is by its SHA-256. Regenerating deletes the old lookup, so the old
// link stops working at once. Every bad / revoked link gets the same answer.

import { createHash, randomBytes } from "node:crypto";
import { WeddingError, WEDDING_SCHEMA_VERSION, TOTALS_DOC_ID, RSVP_STATUSES, validateRsvp, validateWeddingSetup, rsvpOpen, setupMissing, isWeddingSlug, suggestWeddingSlug, invitePath, WEDDING_SLUG_MIN, WEDDING_SLUG_MAX } from "../../../shared/wedding.js";
import { businessDate, isDayId } from "../../../shared/metrics.js";
import { prepareNotifications } from "./notifications.js";
import { tenantDb } from "./tenant-db.js";
import { guestTotalsWrite } from "./wedding.js";
import { roleLabel } from "../../../shared/wedding-roles.js";
import { accessPolicy } from "../../../shared/subscription.js";
import { attendingMarksFor } from "./wedding-roles.js";
import { liveDesignFor, ownerInvitationStatus, previewDesign, TRIAL_PREVIEW_MESSAGE } from "./invitation-design.js";
import { trialOpen } from "../../../shared/trial.js";
import { invitationContent } from "../../../shared/invitation-design.js";
import { dataUrlImageType } from "../../../shared/image-type.js";

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
// A guest's own answer in the history: "1 of 2" (attending of invited), "Declined".
export const partyWords = (status, confirmed, invited) => (status === "attending" ? `${confirmed} of ${invited}` : WORDS[status] ?? status);
// "Guest responded: Attending · 1 of 2" the first time; then
// "Guest changed RSVP: 1 of 2 → 2 of 2".
export function guestRsvpLabel(from, to, invited) {
  if (from.rsvp === "awaiting") return `Guest responded: ${to.status === "attending" ? `Attending · ${partyWords(to.status, to.confirmed, invited)}` : WORDS[to.status]}`;
  return `Guest changed RSVP: ${partyWords(from.rsvp, from.confirmed, invited)} → ${partyWords(to.status, to.confirmed, invited)}`;
}
const append = (list, e) => {
  const l = Array.isArray(list) ? list : [];
  if (l.length >= MAX_HISTORY) throw new WeddingError("history-full", "Too many changes on this record");
  return [...l, e];
};
const setupRef = (tenant) => tenant.doc("weddingSetup", "current");
const heroRef = (tenant) => tenant.doc("weddingSetup", "hero");
const totalsRef = (tenant) => tenant.doc("guestTotals", TOTALS_DOC_ID);
const BAD_LINK = () => new WeddingError("invalid-link", "This invitation link isn't valid. Please ask the couple for a new one.");
// A free trial (2026-10-21): the couple previews; guest links are made and
// opened once Luna Bridal is paid (the trial converts). Same links after.
const NOT_PUBLISHED = () => new WeddingError("not-published", "This invitation isn't published yet. Please check back soon.");
async function requirePaid(tenant) {
  const b = await tenant.ref.get();
  if (b.exists && trialOpen(b.data().subscription)) throw new WeddingError("trial-preview", TRIAL_PREVIEW_MESSAGE);
}

// ---- Wedding Setup (Owner side, guests.manage) ----
export async function readSetup({ tenant, business }) {
  const [s, h, g] = await Promise.all([setupRef(tenant).get(), heroRef(tenant).get(), galleryCol(tenant).orderBy("order").limit(MAX_GALLERY).get()]);
  const hero = h.exists && typeof h.data().dataUrl === "string" ? h.data().dataUrl : null;
  // hero: the current cover photo, so the Owner sees what's set.
  // invitation: Standard (Luna Bridal) / Customized (Luna Bridal+) and its state.
  return { setup: s.exists ? s.data() : {}, hasHero: Boolean(hero), hero, gallery: g.docs.map((d) => ({ id: d.id, dataUrl: d.data().dataUrl })), invitation: business ? await ownerInvitationStatus({ tenant, business }) : null };
}
// Gallery photos for a customized invitation (shrunk in the browser).
const galleryCol = (tenant) => tenant.collection("weddingGallery");
const MAX_GALLERY = 6;
export async function addGalleryPhoto({ tenant, FieldValue, dataUrl, actor }) {
  if (typeof dataUrl !== "string" || dataUrl.length > 400_000 || !dataUrlImageType(dataUrl)) throw new WeddingError("invalid-input", "Choose a JPEG, PNG or WebP photo (it's shrunk before upload)");
  const all = await galleryCol(tenant).orderBy("order").limit(MAX_GALLERY + 1).get();
  if (all.size >= MAX_GALLERY) throw new WeddingError("invalid-input", `Up to ${MAX_GALLERY} gallery photos`);
  const last = all.docs.at(-1);
  const ref = galleryCol(tenant).doc();
  await ref.set({ dataUrl, order: (last ? last.data().order : 0) + 10, addedBy: who(actor), addedAt: FieldValue.serverTimestamp() });
  return { photoId: ref.id };
}
export async function removeGalleryPhoto({ tenant, photoId }) {
  if (typeof photoId !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(photoId)) throw new WeddingError("invalid-input", "Invalid photo");
  await galleryCol(tenant).doc(photoId).delete();
  return { removed: true };
}
export const previewInvitation = ({ tenant, business, which }) => previewDesign({ tenant, business, which: which === "draft" ? "draft" : "live" });
// The wedding link (slug) is unique in Luna: weddingSlugs/{slug} =
// { businessId } (top level, server-only; rules deny all). Blank = made
// from the couple's names ("carlo-and-yanie-wedding", then -2, -3… when
// taken). A chosen slug that another wedding holds is refused. Changing it
// frees the old one; old links keep working (the token decides) and the
// page moves the address bar to the current slug.
const slugRef = (db, slug) => db.collection("weddingSlugs").doc(slug);
async function freeSlugFor(tx, db, businessId, base) {
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, WEDDING_SLUG_MAX - String(n).length - 1)}-${n}`;
    const snap = await tx.get(slugRef(db, candidate));
    if (!snap.exists || snap.data().businessId === businessId) return candidate;
  }
  return `${base.slice(0, WEDDING_SLUG_MAX - 7)}-${randomBytes(3).toString("hex")}`;
}
// In the caller's transaction (reads first): the slug to store, and the commit.
async function prepareSlug(tx, { db, tenant, current, wanted, coupleNames, now }) {
  const businessId = tenant.businessId;
  let slug = wanted;
  if (slug) {
    const snap = await tx.get(slugRef(db, slug));
    if (snap.exists && snap.data().businessId !== businessId) throw new WeddingError("slug-taken", `The wedding link "${slug}" is already used by another wedding. Try another, e.g. ${slug}-${new Date(now).getFullYear()}.`);
  } else {
    const base = suggestWeddingSlug(coupleNames);
    slug = base.length >= WEDDING_SLUG_MIN ? await freeSlugFor(tx, db, businessId, base) : null;
  }
  const old = isWeddingSlug(current) && current !== slug ? await tx.get(slugRef(db, current)) : null;
  return {
    slug,
    commit() {
      if (slug) tx.set(slugRef(db, slug), { businessId, claimedAt: now });
      if (old?.exists && old.data().businessId === businessId) tx.delete(old.ref);
    },
  };
}
export async function saveSetup({ db, tenant, FieldValue, input, actor, now = new Date() }) {
  const data = validateWeddingSetup(input || {});
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(setupRef(tenant));
    const before = cur.exists ? cur.data() : {};
    const coupleNames = Object.hasOwn(data, "coupleNames") ? data.coupleNames : before.coupleNames;
    // Not sent = keep the current one (or make one); blank = make one from the names.
    const wanted = Object.hasOwn(data, "weddingSlug") ? data.weddingSlug : before.weddingSlug ?? null;
    const plan = await prepareSlug(tx, { db, tenant, current: before.weddingSlug ?? null, wanted, coupleNames, now });
    tx.set(setupRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...data, weddingSlug: plan.slug, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    plan.commit();
  }, TX_OPTIONS);
  // Read back: the Owner sees what was really stored.
  const back = await setupRef(tenant).get();
  return { saved: true, setup: back.exists ? back.data() : {} };
}
// A wedding set up before links had a slug gets one on its next link.
async function ensureSlug({ db, tenant, now = new Date() }) {
  return db.runTransaction(async (tx) => {
    const cur = await tx.get(setupRef(tenant));
    const s = cur.exists ? cur.data() : {};
    if (isWeddingSlug(s.weddingSlug)) {
      const own = await tx.get(slugRef(db, s.weddingSlug));
      if (own.exists && own.data().businessId === tenant.businessId) return s.weddingSlug;
    }
    const plan = await prepareSlug(tx, { db, tenant, current: null, wanted: null, coupleNames: s.coupleNames, now });
    if (plan.slug) tx.set(setupRef(tenant), { weddingSlug: plan.slug }, { merge: true });
    plan.commit();
    return plan.slug;
  }, TX_OPTIONS);
}
export async function saveHero({ tenant, FieldValue, dataUrl, actor }) {
  if (dataUrl === null) {
    await heroRef(tenant).delete();
    return { hero: false };
  }
  if (typeof dataUrl !== "string" || dataUrl.length > HERO_MAX || !dataUrlImageType(dataUrl)) throw new WeddingError("invalid-input", "Choose a JPEG, PNG or WebP photo (it's shrunk before upload)");
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
const slugOf = async ({ db, tenant, now }) => ensureSlug({ db, tenant, now });
// Creates the guest's link, or a new one replacing (revoking) the old.
export async function issueInvite({ db, tenant, guestId, actor, now = new Date() }) {
  const gRef = tenant.doc("guests", guestId);
  const iRef = tenant.doc("guestInvites", guestId);
  if (!(await gRef.get()).exists) throw new WeddingError("not-found", "Guest not found");
  await requirePaid(tenant);
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
  return { token, path: invitePath(await slugOf({ db, tenant, now }), token), created: true };
}
// The current link (made on first use), under the wedding's current slug.
export async function inviteLink({ db, tenant, guestId, actor, now }) {
  await requirePaid(tenant);
  const i = await tenant.doc("guestInvites", guestId).get();
  if (i.exists && i.data().token) return { token: i.data().token, path: invitePath(await slugOf({ db, tenant, now }), i.data().token), created: false };
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
  // A deleted business (Super Admin, recoverable) or an unknown status: the link stops working at once.
  if (!accessPolicy(b.data().subscription?.status).canRead) throw BAD_LINK();
  if (trialOpen(b.data().subscription)) throw NOT_PUBLISHED();
  return { businessId, guestId, biz, business: b.data(), guest: g.data(), linkRef: link.ref };
}
// What a guest sees of the Wedding Setup (shared/invitation-design.js).
const publicSetup = (s) => invitationContent(s);

export async function viewInvite({ db, token, now = new Date() }) {
  const r = await resolve(db, token);
  const [s, h] = await Promise.all([r.biz.collection("weddingSetup").doc("current").get(), r.biz.collection("weddingSetup").doc("hero").get()]);
  const setup = s.exists ? s.data() : {};
  const today = businessDate(r.business.timezone || "Asia/Manila", now);
  // Only what this party needs: their name, seats and answer. No ids.
  return {
    wedding: publicSetup(setup),
    hero: h.exists ? h.data().dataUrl : null,
    // roles: ready for personal wording later ("…one of our Principal Sponsors"); not shown yet.
    guest: { name: r.guest.name, seats: int(r.guest.partySize), rsvp: r.guest.rsvp, confirmed: int(r.guest.confirmed), roles: (Array.isArray(r.guest.roles) ? r.guest.roles : []).map((x) => roleLabel(x)) },
    rsvpOpen: rsvpOpen(setup, today),
    // The canonical address (current wedding link): an older link moves to it.
    path: invitePath(setup.weddingSlug, token),
    // The published Luna Bridal+ design (or null = the Standard invitation),
    // with the images / gallery / entourage its sections need.
    ...((await liveDesignFor({ tenant: tenantDb(db, r.businessId), business: r.business, setup })) ?? { design: null }),
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
    const label = `${guestRsvpLabel({ rsvp: g.rsvp, confirmed: int(g.confirmed) }, v, int(g.partySize))}${unseat ? " · removed from their table" : ""}`;
    const notes = await prepareNotifications(tx, {
      tenant,
      events: [{ type: "guest.rsvp", key: `${r.guestId}-${now.getTime()}`, title: `${g.name} RSVP'd ${rsvpWords(v.status, v.confirmed).replace(/ (\d+)$/, " · $1")}`, message: `${g.name} answered their invitation: ${rsvpWords(v.status, v.confirmed).replace(/ (\d+)$/, " · $1")}.`, recordType: "guest", recordId: r.guestId }],
    });
    const stamp = FieldValue.serverTimestamp();
    tx.update(gRef, { rsvp: v.status, confirmed: v.confirmed, rsvpDate: today, rsvpSource: "guest", ...(unseat ? { tableId: null } : {}), ...attendingMarksFor(g, v), history: append(g.history, { at: now, actor: null, label, source: "guest", from: { rsvp: g.rsvp, confirmed: int(g.confirmed) }, to: v }), revision: int(g.revision) + 1, updatedBy: { uid: null, name: `${g.name} (invitation)` }, updatedAt: stamp });
    tx.set(totalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...guestTotalsWrite(FieldValue, g, next), updatedAt: stamp }, { merge: true });
    notes.commit({ FieldValue });
    return { rsvp: v.status, confirmed: v.confirmed, name: g.name };
  }, TX_OPTIONS);
}

export { RSVP_STATUSES };
