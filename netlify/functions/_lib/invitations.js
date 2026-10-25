// Owner-pilot Bridal: Wedding Setup, personal invitation links and guest
// RSVP. The Bridal Guest record stays the ONE source of truth: a guest's
// answer updates that same guest (RSVP, confirmed seats, history with
// source "guest"), the RSVP totals (overall and per category) and frees a
// table seat when they're no longer attending, exactly like an Owner change.
//
// Records:
//   weddingSetup/current          the invitation details + RSVP settings
//   weddingSetup/hero             the cover photo (small JPEG data URL)
//   weddingPhotos/{slot}          a design's other photos (story1, story2,
//                                 when, venue, dressCode; server-only)
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
import { WeddingError, WEDDING_SCHEMA_VERSION, TOTALS_DOC_ID, SEATING_DOC_ID, RSVP_STATUSES, validateRsvp, validateWeddingSetup, rsvpOpen, setupMissing, isWeddingSlug, suggestWeddingSlug, invitePath, coupleDisplayName, isInvitationPublished, WEDDING_SLUG_MIN, WEDDING_SLUG_MAX } from "../../../shared/wedding.js";
import { businessDate, isDayId } from "../../../shared/metrics.js";
import { prepareNotifications } from "./notifications.js";
import { tenantDb } from "./tenant-db.js";
import { guestTotalsWrite, releasedText } from "./wedding.js";
import { roleLabel, rolesPlan, membersOf } from "../../../shared/wedding-roles.js";
import { accessPolicy } from "../../../shared/subscription.js";
import { attendingMarksFor, nameCompanions } from "./wedding-roles.js";
import { liveDesignFor, ownerInvitationStatus, previewDesign, TRIAL_PREVIEW_MESSAGE } from "./invitation-design.js";
import { trialOpen } from "../../../shared/trial.js";
import { invitationData, PHOTO_SLOTS, isOfferedTemplate } from "../../../shared/invitation-design.js";
import { reconcileSeats } from "../../../shared/wedding-seating.js";
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
// The party as its own guest sees it: the other named people, and the seats with no name yet.
const partyOf = (g) => {
  const named = membersOf(g).map((m) => m.name);
  return { named, open: Math.max(0, int(g.partySize) - 1 - named.length) };
};
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
  const slots = Object.keys(PHOTO_SLOTS);
  const [s, h, g, guests, ...p] = await Promise.all([setupRef(tenant).get(), heroRef(tenant).get(), galleryCol(tenant).orderBy("order").limit(MAX_GALLERY).get(), tenant.collection("guests").limit(2000).get(), ...slots.map((slot) => photoRef(tenant, slot).get())]);
  // The entourage comes from the guests' roles (Guests → Role): counts only.
  const entourage = rolesPlan(guests.docs.map((d) => ({ id: d.id, ...d.data() }))).map((gr) => ({ label: gr.label, count: gr.people.length }));
  const hero = h.exists && typeof h.data().dataUrl === "string" ? h.data().dataUrl : null;
  const photos = Object.fromEntries(p.flatMap((snap, i) => (snap.exists && typeof snap.data().dataUrl === "string" ? [[slots[i], snap.data().dataUrl]] : [])));
  // hero: the current cover photo, so the Owner sees what's set.
  // invitation: Standard (Luna Bridal) / Customized (Luna Bridal+) and its state.
  return { setup: s.exists ? s.data() : {}, hasHero: Boolean(hero), hero, photos, entourage, gallery: g.docs.map((d) => ({ id: d.id, dataUrl: d.data().dataUrl })), invitation: business ? await ownerInvitationStatus({ tenant, business }) : null };
}
// A design's photo slot (shrunk in the browser), or null to remove it.
const photoRef = (tenant, slot) => tenant.doc("weddingPhotos", slot);
export async function savePhoto({ tenant, FieldValue, slot, dataUrl, actor }) {
  if (typeof slot !== "string" || !Object.hasOwn(PHOTO_SLOTS, slot)) throw new WeddingError("invalid-input", "Invalid photo");
  if (dataUrl === null) {
    await photoRef(tenant, slot).delete();
    return { slot, photo: false };
  }
  if (typeof dataUrl !== "string" || dataUrl.length > 400_000 || !dataUrlImageType(dataUrl)) throw new WeddingError("invalid-input", "Choose a JPEG, PNG or WebP photo (it's shrunk before upload)");
  await photoRef(tenant, slot).set({ dataUrl, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
  return { slot, photo: true };
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
export const previewInvitation = ({ tenant, business, which, templateId }) => previewDesign({ tenant, business, which: which === "draft" ? "draft" : "live", templateId: typeof templateId === "string" ? templateId : undefined });
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
  // Publishing needs a paid wedding (the trial previews only).
  if (data.published === true) await requirePaid(tenant);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(setupRef(tenant));
    const before = cur.exists ? cur.data() : {};
    // Only the offered designs can be newly chosen; a wedding already on an
    // older one keeps it (and can save it again).
    if (Object.hasOwn(data, "templateId") && (data.templateId ?? null) !== (before.templateId ?? null) && !isOfferedTemplate(data.templateId)) throw new WeddingError("invalid-input", "Choose Gold Elegance, Black & White or Rustic Garden");
    // Publish: the guests' invitation needs the real names and date (never
    // a template's sample). Unpublished is only for a NEW invitation: a live
    // one is never taken down by a save.
    if (data.published === true) {
      const missing = setupMissing({ ...before, ...data });
      if (missing.length) throw new WeddingError("setup-incomplete", `Add ${missing.join(" and ")} before publishing.`);
    }
    if (data.published === false && cur.exists && before.published !== false) delete data.published;
    const coupleNames = coupleDisplayName({ ...before, ...data });
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
    const plan = await prepareSlug(tx, { db, tenant, current: null, wanted: null, coupleNames: coupleDisplayName(s), now });
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

// Reset invitation (Wedding Setup → ⋯, 2026-10-25): the design returns to
// its own example presentation. Clears the invitation-only content, every
// design's wording / accent, the cover photo, the design photos and the
// gallery. Kept: the names, the date, the city, ceremony / reception
// details, the RSVP settings (guests' answers depend on them), the chosen
// design, published state and the wedding link. Guests, RSVPs, roles,
// seating and the rest of the wedding are never touched (that is Reset
// Data, Settings).
export const INVITATION_RESET_FIELDS = Object.freeze(["welcomeMessage", "partner1Family", "partner2Family", "partner1Parents", "partner2Parents", "story", "schedule", "gettingThere", "dressCode", "dressCodeDetails", "palette", "attireNotes", "reminders", "giftNote", "faq", "footerNote", "templateOptions"]);
export async function resetInvitation({ db, tenant, FieldValue, actor }) {
  const slots = Object.keys(PHOTO_SLOTS);
  const gallery = await galleryCol(tenant).limit(MAX_GALLERY + 10).get();
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(setupRef(tenant));
    if (cur.exists) {
      const next = Object.fromEntries(Object.entries(cur.data()).filter(([k]) => !INVITATION_RESET_FIELDS.includes(k)));
      tx.set(setupRef(tenant), { ...next, updatedBy: who(actor), updatedAt: FieldValue.serverTimestamp() });
    }
    tx.delete(heroRef(tenant));
    for (const slot of slots) tx.delete(photoRef(tenant, slot));
    for (const d of gallery.docs) tx.delete(d.ref);
  }, TX_OPTIONS);
  const back = await setupRef(tenant).get();
  return { reset: true, setup: back.exists ? back.data() : {} };
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

export async function viewInvite({ db, token, now = new Date() }) {
  const r = await resolve(db, token);
  const [s, h] = await Promise.all([r.biz.collection("weddingSetup").doc("current").get(), r.biz.collection("weddingSetup").doc("hero").get()]);
  const setup = s.exists ? s.data() : {};
  if (!isInvitationPublished(setup)) throw NOT_PUBLISHED();
  const today = businessDate(r.business.timezone || "Asia/Manila", now);
  // The shared invitation contract (shared/invitation-design.js), as the
  // Owner's and Super Admin's previews use it. Only what this party needs:
  // their name, seats and answer. No ids.
  return invitationData({
    setup,
    hero: h.exists ? h.data().dataUrl : null,
    // roles: ready for personal wording later ("…one of our Principal Sponsors"); not shown yet.
    // meal / note: this party's own earlier answer (to change it).
    // party: the names already known in this party, and how many seats
    // have no name yet (the guest can name them when they accept).
    guest: { name: r.guest.name, seats: int(r.guest.partySize), rsvp: r.guest.rsvp, confirmed: int(r.guest.confirmed), roles: (Array.isArray(r.guest.roles) ? r.guest.roles : []).map((x) => roleLabel(x)), meal: typeof r.guest.rsvpMeal === "string" ? r.guest.rsvpMeal : null, note: typeof r.guest.rsvpNote === "string" ? r.guest.rsvpNote : null, party: partyOf(r.guest) },
    rsvpOpen: rsvpOpen(setup, today),
    // The canonical address (current wedding link): an older link moves to it.
    path: invitePath(setup.weddingSlug, token),
    // The live design (published Custom, the chosen Standard template, or
    // null = the Luna Standard page) with the images / gallery / entourage
    // its sections need.
    look: await liveDesignFor({ tenant: tenantDb(db, r.businessId), business: r.business, setup }),
    timezone: r.business.timezone || "Asia/Manila",
  });
}

export async function respondInvite({ db, FieldValue, token, rsvp, now = new Date() }) {
  const r = await resolve(db, token);
  const gRef = r.biz.collection("guests").doc(r.guestId);
  const sRef = r.biz.collection("weddingSetup").doc("current");
  const tenant = tenantDb(db, r.businessId);
  return db.runTransaction(async (tx) => {
    const [link, snap, setupSnap] = [await tx.get(r.linkRef), await tx.get(gRef), await tx.get(sRef)];
    await tx.get(totalsRef(tenant));
    const seatingSnap = await tx.get(tenant.doc("guestTotals", SEATING_DOC_ID));
    if (!link.exists || !snap.exists) throw BAD_LINK();
    const setup = setupSnap.exists ? setupSnap.data() : {};
    if (!isInvitationPublished(setup)) throw NOT_PUBLISHED();
    const today = businessDate(r.business.timezone || "Asia/Manila", now);
    if (!rsvpOpen(setup, today)) throw new WeddingError("rsvp-closed", isDayId(setup.rsvpDeadline) && setup.rsvpEnabled ? "RSVPs for this wedding are closed. Please contact the couple." : "RSVPs aren't open. Please contact the couple.");
    const g = snap.data();
    const status = rsvp?.status;
    if (!["attending", "declined"].includes(status)) throw new WeddingError("invalid-input", "Choose Accept or Decline");
    const v = validateRsvp(status === "attending" ? { status, confirmed: Number(rsvp.confirmed) } : { status }, g.partySize);
    // The meal choice / dietary note, only where Wedding Setup asks for them.
    const extra = guestExtras(setup, v.status, rsvp);
    const extraChanged = Object.entries(extra).some(([k, x]) => (g[k] ?? null) !== x);
    // Names for the party's unnamed seats (accepting only): they become the
    // party's named members, each keeping the seat / table that was theirs.
    const named = v.status === "attending" ? nameCompanions(g, rsvp?.companions) : null;
    const party = named ? { members: named.members } : {};
    const namedText = named ? ` · named ${named.names.join(", ")}` : "";
    if (v.status === g.rsvp && v.confirmed === int(g.confirmed) && !extraChanged && !named) return { rsvp: v.status, confirmed: v.confirmed, unchanged: true, name: g.name };
    if (v.status === g.rsvp && v.confirmed === int(g.confirmed)) {
      const kept = named ? reconcileSeats(g, { ...g, ...party }, { rename: named.rename }).fields : {};
      tx.update(gRef, { ...extra, ...party, ...kept, history: append(g.history, { at: now, actor: null, label: named ? `Guest named their party${namedText.replace(" · named", ":")}` : "Guest updated their meal / dietary note", source: "guest" }), revision: int(g.revision) + 1, updatedBy: { uid: null, name: `${g.name} (invitation)` }, updatedAt: FieldValue.serverTimestamp() });
      return { rsvp: v.status, confirmed: v.confirmed, name: g.name, ...extra };
    }
    const base = { ...g, ...party };
    const marks = attendingMarksFor(base, v);
    const next = { ...base, rsvp: v.status, confirmed: v.confirmed, ...marks };
    // Seats follow the confirmed people (shared/wedding-seating.js): fewer
    // frees the last people's seats, named in the history.
    const seating = reconcileSeats(g, next, named ? { rename: named.rename } : undefined);
    const tables = seatingSnap.exists && seatingSnap.data().tables ? seatingSnap.data().tables : {};
    const label = `${guestRsvpLabel({ rsvp: g.rsvp, confirmed: int(g.confirmed) }, v, int(g.partySize))}${namedText}${releasedText(seating.released, tables)}`;
    const notes = await prepareNotifications(tx, {
      tenant,
      events: [{ type: "guest.rsvp", key: `${r.guestId}-${now.getTime()}`, title: `${g.name} RSVP'd ${rsvpWords(v.status, v.confirmed).replace(/ (\d+)$/, " · $1")}`, message: `${g.name} answered their invitation: ${rsvpWords(v.status, v.confirmed).replace(/ (\d+)$/, " · $1")}.`, recordType: "guest", recordId: r.guestId }],
    });
    const stamp = FieldValue.serverTimestamp();
    tx.update(gRef, { rsvp: v.status, confirmed: v.confirmed, rsvpDate: today, rsvpSource: "guest", ...extra, ...party, ...seating.fields, ...marks, history: append(g.history, { at: now, actor: null, label, source: "guest", from: { rsvp: g.rsvp, confirmed: int(g.confirmed) }, to: v }), revision: int(g.revision) + 1, updatedBy: { uid: null, name: `${g.name} (invitation)` }, updatedAt: stamp });
    tx.set(totalsRef(tenant), { schemaVersion: WEDDING_SCHEMA_VERSION, ...guestTotalsWrite(FieldValue, g, next), updatedAt: stamp }, { merge: true });
    notes.commit({ FieldValue });
    return { rsvp: v.status, confirmed: v.confirmed, name: g.name, ...extra };
  }, TX_OPTIONS);
}
// { rsvpMeal, rsvpNote } to store with a guest's answer: a meal from the
// setup's options and a short dietary note, each only when the setup asks
// (cleared when they decline). {} when neither is asked.
export function guestExtras(setup, status, rsvp) {
  const meals = Array.isArray(setup.mealOptions) ? setup.mealOptions : [];
  const out = {};
  if (meals.length) {
    const m = rsvp?.meal === undefined || rsvp.meal === null || rsvp.meal === "" ? null : rsvp.meal;
    if (m !== null && (typeof m !== "string" || !meals.includes(m))) throw new WeddingError("invalid-input", "Choose one of the meal options");
    out.rsvpMeal = status === "attending" ? m : null;
  }
  if (setup.askDietary === true) {
    const n = rsvp?.note === undefined || rsvp.note === null ? "" : rsvp.note;
    if (typeof n !== "string" || n.trim().length > 300) throw new WeddingError("invalid-input", "Dietary note: up to 300 characters");
    out.rsvpNote = status === "attending" ? n.trim().replace(/\s+/g, " ") || null : null;
  }
  return out;
}

export { RSVP_STATUSES };
