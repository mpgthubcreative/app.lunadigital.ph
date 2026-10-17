// Owner-pilot Bridal: per-business invitation design (shared/invitation-design.js).
//   businesses/{bid}/invitationDesign/current   server-only
//     { draft: { config, state: "draft" | "ready", version, updatedAt, updatedBy },
//       published: { config, version, publishedAt, publishedBy } | null,
//       live: "standard" | "custom",
//       history: [{ version, config, publishedAt, publishedBy }]   (last 10)
//       nextVersion }
//   businesses/{bid}/invitationAssets/{assetId} server-only
//     { name, contentType, dataUrl, bytes, uploadedAt, uploadedBy }
// Guests see the PUBLISHED custom design only while the plan includes it
// (Luna Bridal+) and it's live; otherwise the Standard invitation. Nothing
// is deleted when a plan changes (a later upgrade brings the design back).
// Publishing changes appearance only: guests, tokens, slugs, RSVPs untouched.

import { randomBytes } from "node:crypto";
import { validateDesignConfig, resolveDesign, assetIdsOf, invitationLevelOf, invitationStatus, TEMPLATES, SECTION_IDS, DesignError } from "../../../shared/invitation-design.js";
import { rolesPlan } from "../../../shared/wedding-roles.js";

const TX_OPTIONS = { maxAttempts: 10 };
const MAX_ASSETS = 24;
const ASSET_MAX_CHARS = 700_000; // a data URL (~500 KB image)
const HISTORY = 10;
const ASSET_TYPES = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;
const designRef = (tenant) => tenant.doc("invitationDesign", "current");
const assetsCol = (tenant) => tenant.collection("invitationAssets");
const who = (actor) => (typeof actor === "string" ? { name: actor } : actor ? { uid: actor.uid ?? null, name: actor.name ?? actor.email ?? null } : null);
export class InvitationDesignError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const asError = (err) => (err instanceof DesignError ? new InvitationDesignError("invalid-design", err.message) : err);

async function requireWedding(tenant) {
  const b = await tenant.ref.get();
  if (!b.exists) throw new InvitationDesignError("not-found", "Business not found");
  const d = b.data();
  if (d.workspaceTemplateId !== "bridal-expense") throw new InvitationDesignError("not-available", "Invitation designs are for wedding (Bridal) workspaces");
  return d;
}
const planOf = (business) => business?.subscription?.planId ?? business?.planId ?? business?.entitlements?.planId ?? null;
// Whole-field writes (a merge would deep-merge an old config into the new one).
const write = (tx, ref, snap, fields) => (snap.exists ? tx.update(ref, fields) : tx.set(ref, fields));

// ---------- Read side ----------

export async function readDesign(tenant) {
  const s = await designRef(tenant).get();
  return s.exists ? s.data() : null;
}
async function assetsByIds(tenant, ids) {
  const out = {};
  for (const id of ids) {
    const a = await assetsCol(tenant).doc(id).get();
    if (a.exists) out[id] = a.data().dataUrl;
  }
  return out;
}

// The content components need (gallery, entourage), only when shown.
async function componentData(tenant, resolved) {
  const extra = {};
  if (resolved.sections.visible.gallery) {
    const g = await tenant.collection("weddingGallery").orderBy("order").limit(6).get();
    extra.gallery = g.docs.map((d) => d.data().dataUrl).filter((u) => typeof u === "string");
  }
  if (resolved.sections.visible.entourage) {
    const guests = await tenant.collection("guests").limit(2000).get();
    extra.entourage = rolesPlan(guests.docs.map((d) => ({ id: d.id, ...d.data() }))).map((gr) => ({ label: gr.label, names: gr.people.map((p) => p.name) }));
  }
  return extra;
}
// What a guest link shows: { design: { config, assets }, ...component data } or null (Standard).
export async function liveDesignFor({ tenant, business }) {
  if (invitationLevelOf(planOf(business)) !== "custom") return null;
  const doc = await readDesign(tenant);
  if (!doc || doc.live !== "custom" || !doc.published?.config) return null;
  const resolved = resolveDesign(doc.published.config);
  return { design: { config: resolved, assets: await assetsByIds(tenant, assetIdsOf(doc.published.config)), version: doc.published.version }, ...(await componentData(tenant, resolved)) };
}
// Owner / Super Admin preview of the draft or the live design.
export async function previewDesign({ tenant, business, which = "live" }) {
  const doc = await readDesign(tenant);
  const config = which === "draft" ? doc?.draft?.config : doc?.live === "custom" && invitationLevelOf(planOf(business)) === "custom" ? doc?.published?.config : null;
  if (!config) return { design: null };
  const resolved = resolveDesign(config);
  return { design: { config: resolved, assets: await assetsByIds(tenant, assetIdsOf(config)) }, ...(await componentData(tenant, resolved)) };
}
export async function ownerInvitationStatus({ tenant, business }) {
  return invitationStatus({ planId: planOf(business), design: await readDesign(tenant) });
}

// ---------- Luna Super Admin ----------

export async function designWorkspace({ tenant }) {
  const business = await requireWedding(tenant);
  const doc = await readDesign(tenant);
  const assets = (await assetsCol(tenant).limit(MAX_ASSETS + 1).get()).docs.map((d) => ({ id: d.id, name: d.data().name, contentType: d.data().contentType, bytes: d.data().bytes, dataUrl: d.data().dataUrl }));
  const [setup, hero] = await Promise.all([tenant.doc("weddingSetup", "current").get(), tenant.doc("weddingSetup", "hero").get()]);
  return {
    business: { id: tenant.businessId, name: business.name, planId: planOf(business) },
    status: invitationStatus({ planId: planOf(business), design: doc }),
    // Starts from the Standard design when nothing was drafted yet.
    draft: doc?.draft ?? { config: { templateId: "standard" }, state: "draft", version: null },
    published: doc?.published ?? null,
    live: doc?.live ?? "standard",
    history: (doc?.history ?? []).map((h) => ({ version: h.version, publishedAt: h.publishedAt, publishedBy: h.publishedBy })),
    assets,
    content: { setup: setup.exists ? setup.data() : {}, hero: hero.exists ? hero.data().dataUrl : null },
    templates: Object.fromEntries(Object.entries(TEMPLATES).map(([id, t]) => [id, { label: t.label }])),
    sections: SECTION_IDS,
  };
}

export async function saveDraft({ db, tenant, FieldValue, config, actor }) {
  await requireWedding(tenant);
  let clean;
  try {
    clean = validateDesignConfig(config);
  } catch (err) {
    throw asError(err);
  }
  const used = assetIdsOf(clean);
  for (const id of used) if (!(await assetsCol(tenant).doc(id).get()).exists) throw new InvitationDesignError("invalid-design", "The design uses an image that isn't uploaded");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(designRef(tenant));
    const d = snap.exists ? snap.data() : {};
    write(tx, designRef(tenant), snap, { draft: { config: clean, state: "draft", version: d.draft?.version ?? null, updatedAt: FieldValue.serverTimestamp(), updatedBy: who(actor) }, live: d.live ?? "standard", published: d.published ?? null, history: d.history ?? [], nextVersion: d.nextVersion ?? 1 });
    return { saved: true, state: "draft" };
  }, TX_OPTIONS);
}

// Draft ↔ Ready (ready = approved design, waiting to be published).
export async function setDraftState({ db, tenant, FieldValue, state, actor }) {
  if (!["draft", "ready"].includes(state)) throw new InvitationDesignError("invalid-input", "Draft or Ready");
  await requireWedding(tenant);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(designRef(tenant));
    if (!snap.exists || !snap.data().draft?.config) throw new InvitationDesignError("not-found", "Save a draft first");
    tx.update(designRef(tenant), { draft: { ...snap.data().draft, state, updatedAt: FieldValue.serverTimestamp(), updatedBy: who(actor) } });
    return { state };
  }, TX_OPTIONS);
}

// Publish: the draft becomes the live custom design (Luna Bridal+ only).
export async function publishDesign({ db, tenant, FieldValue, actor, now = new Date() }) {
  const business = await requireWedding(tenant);
  if (invitationLevelOf(planOf(business)) !== "custom") throw new InvitationDesignError("not-entitled", "Publishing a customized invitation needs Luna Bridal+");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(designRef(tenant));
    const d = snap.exists ? snap.data() : {};
    if (!d.draft?.config) throw new InvitationDesignError("not-found", "Save a draft first");
    const version = d.nextVersion ?? 1;
    const entry = { version, config: d.draft.config, publishedAt: now, publishedBy: who(actor) };
    write(tx, designRef(tenant), snap, { published: entry, live: "custom", draft: { ...d.draft, state: "draft", version }, history: [entry, ...(d.history ?? [])].slice(0, HISTORY), nextVersion: version + 1 });
    tx.set(tenant.collection("auditLog").doc(), { type: "invitation.published", version, actor: who(actor), at: FieldValue.serverTimestamp() });
    return { published: true, version, live: "custom" };
  }, TX_OPTIONS);
}

// Guests see the Standard invitation again (the custom design is kept).
export async function useStandard({ db, tenant, FieldValue, actor }) {
  await requireWedding(tenant);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(designRef(tenant));
    tx.set(designRef(tenant), { live: "standard" }, { merge: true });
    if (snap.exists && snap.data().live === "custom") tx.set(tenant.collection("auditLog").doc(), { type: "invitation.standard", actor: who(actor), at: FieldValue.serverTimestamp() });
    return { live: "standard" };
  }, TX_OPTIONS);
}
// Put the custom design back live (after useStandard), if published.
export async function useCustom({ db, tenant, actor }) {
  const business = await requireWedding(tenant);
  if (invitationLevelOf(planOf(business)) !== "custom") throw new InvitationDesignError("not-entitled", "A customized invitation needs Luna Bridal+");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(designRef(tenant));
    if (!snap.exists || !snap.data().published?.config) throw new InvitationDesignError("not-found", "Nothing published yet");
    tx.set(designRef(tenant), { live: "custom" }, { merge: true });
    return { live: "custom", by: who(actor)?.name ?? null };
  }, TX_OPTIONS);
}
// Copy a published version back into the draft.
export async function restoreVersion({ db, tenant, FieldValue, version, actor }) {
  await requireWedding(tenant);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(designRef(tenant));
    const h = (snap.exists ? snap.data().history ?? [] : []).find((x) => x.version === version);
    if (!h) throw new InvitationDesignError("not-found", "That version isn't in the history");
    tx.update(designRef(tenant), { draft: { config: h.config, state: "draft", version, updatedAt: FieldValue.serverTimestamp(), updatedBy: who(actor) } });
    return { restored: version };
  }, TX_OPTIONS);
}

export async function uploadAsset({ tenant, FieldValue, name, dataUrl, actor }) {
  await requireWedding(tenant);
  const m = typeof dataUrl === "string" && dataUrl.length <= ASSET_MAX_CHARS ? ASSET_TYPES.exec(dataUrl) : null;
  if (!m) throw new InvitationDesignError("invalid-asset", "Upload a PNG, JPG, WebP or SVG image up to about 500 KB");
  const bytes = Buffer.from(m[2], "base64");
  if (m[1] === "image/svg+xml") {
    // Rendered only as an image (never inline), but refuse active content anyway.
    const svg = bytes.toString("utf8");
    if (!/<svg[\s>]/i.test(svg) || /<script|javascript:|on[a-z]+\s*=|<foreignObject/i.test(svg)) throw new InvitationDesignError("invalid-asset", "That SVG has scripts or isn't an SVG");
  }
  const n = (await assetsCol(tenant).limit(MAX_ASSETS + 1).get()).size;
  if (n >= MAX_ASSETS) throw new InvitationDesignError("invalid-asset", `At most ${MAX_ASSETS} design images`);
  const clean = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "image";
  const id = randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x");
  await assetsCol(tenant).doc(id).set({ name: clean, contentType: m[1], dataUrl, bytes: bytes.length, uploadedAt: FieldValue.serverTimestamp(), uploadedBy: who(actor) });
  return { assetId: id };
}
export async function deleteAsset({ tenant, assetId }) {
  await requireWedding(tenant);
  if (typeof assetId !== "string" || !/^[A-Za-z0-9]{6,40}$/.test(assetId)) throw new InvitationDesignError("invalid-input", "Invalid image");
  const doc = await readDesign(tenant);
  const used = new Set([...assetIdsOf(doc?.draft?.config), ...assetIdsOf(doc?.published?.config), ...(doc?.history ?? []).flatMap((h) => assetIdsOf(h.config))]);
  if (used.has(assetId)) throw new InvitationDesignError("asset-in-use", "That image is used by the draft, the live design or a saved version");
  await assetsCol(tenant).doc(assetId).delete();
  return { deleted: true };
}
