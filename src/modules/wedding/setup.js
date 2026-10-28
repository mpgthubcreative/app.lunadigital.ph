// Wedding Setup (More → Wedding Setup): the couple's invitation, edited ON
// the invitation (2026-10-25, template-first).
//
//   Choose a design (Gold Elegance · Black & White · Rustic Garden)
//   → the complete invitation at once (the design's own sample content and
//     photos wherever the wedding has nothing yet)
//   → Edit: tap a section's Edit / a photo's Replace; a small sheet edits
//     only that section's fields and saves them
//   → Clean Preview: exactly the guest's page, no controls
//   → Publish
// The bar: Edit · Clean Preview · Undo (the last change, one step) · ⋯
// (Guide, Reset invitation). Each sheet can Reset its own section.
//
// ONE source of truth: every sheet saves the same Wedding Setup fields
// (weddingSetup/current, /hero, weddingPhotos/{slot}) through
// /api/wedding-setup. The design's sample content (registry.js sampleData /
// sampleAssets) is merged in on THIS screen only (invitation/samples.js
// previewSetup): it is never saved and never reaches a guest. Guests'
// invitations are built by the server from the real record only, so an
// empty section is simply left out for them.
//
// Older weddings keep their design (Luna Standard, Classic, …): it still
// renders and can be edited here; only the three offered designs can be
// newly chosen. Older Luna Bridal Custom weddings (legacy): the design is
// Luna's (Super Admin); the couple edits content the same way.

import { html, render } from "../../lib/html.js";
import { photoDataUrl, PHOTO_ACCEPT } from "../../lib/image.js";
import { pageHeader, skeleton } from "../../components/ui.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { isWeddingSlug, rsvpOpen, businessDate, coupleDisplayName, setupMissing, MAX_FAQ, MAX_SCHEDULE, MAX_PALETTE, SETUP_LISTS, FAMILY_RELATIONS, MAX_FAMILY } from "@shared/index.js";
import { openInvitePreview, copyText } from "./invitation/preview.js";
import { TEMPLATE_REGISTRY, OFFERED_TEMPLATE_IDS, STANDARD_TEMPLATE_IDS, DEFAULT_TEMPLATE_ID, PHOTO_SLOTS, resolveDesign, invitationData, getTemplateEntry, isOfferedTemplate } from "@shared/invitation-design.js";
import { previewSetup, isEmptyValue } from "./invitation/samples.js";
import { mountCustomLink } from "../../components/custom-link.js";

// The guest the Owner's previews show (never a real guest or link).
const OWNER_SAMPLE_GUEST = Object.freeze({ name: "Your guest's name", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [] });
export const TRIAL_PREVIEW_MESSAGE = "Free trial: publish your invitation and send RSVP links to up to 50 guests. Upgrade for your whole guest list.";
// The chosen Standard template as a design (Luna Standard: the original page).
export const standardPreviewDesign = (templateId) => (STANDARD_TEMPLATE_IDS.includes(templateId) && templateId !== DEFAULT_TEMPLATE_ID ? { config: resolveDesign({ templateId }), assets: {}, standard: true } : null);

// What's typed in "Wedding link", as a slug: "#CarloYanieForever" ->
// "carloyanieforever", "carlo and yanie" -> "carlo-and-yanie".
export const cleanSlugInput = (v) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
// A photo shrunk in the browser to a small JPEG data URL (≤ 1200 px, under
// the 400,000-character limit): iPhone HEIC photos too (../../lib/image.js).
export const shrinkPhoto = (file) => photoDataUrl(file, { maxSide: 1200, quality: 0.8, maxChars: 400_000 });
// The cover photo (2026-10-28): kept sharper, up to 2000 px on its longest
// side, within the server's cover-photo limit (HERO_MAX, 700,000 characters).
export const shrinkCoverPhoto = (file) => photoDataUrl(file, { maxSide: 2000, quality: 0.85, maxChars: 690_000 });
export const COVER_PHOTO_GUIDE = "Recommended: portrait photo, 1600 × 2000 px or larger (JPG or PNG, under 5 MB). Keep faces near the center for the best crop.";
export const COVER_LOW_RES = "This photo may look blurry on larger screens. For best results, use at least 1200 × 1500 px. You can still save it.";
// Is a (shrunk) photo at least 1200 × 1500 px (either way round)? null = couldn't tell.
export const coverIsLowRes = (size) => (size ? Math.min(size.w, size.h) < 1200 || Math.max(size.w, size.h) < 1500 : false);
const measurePhoto = (dataUrl) =>
  new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve(null);
    const img = new Image();
    const done = (v) => resolve(v);
    img.onload = () => done(img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    img.src = dataUrl;
  });

// ---- Fields (one definition; each section's sheet shows only its own) ----
// type: text | textarea | date | time | url | check | list | schedule | palette | faq
const F = {
  partner1Name: { label: "Partner 1", type: "text", max: 60 },
  partner2Name: { label: "Partner 2", type: "text", max: 60 },
  coupleNames: { label: "Names as shown (optional)", type: "text", max: 80, hint: "Leave blank to show “Partner 1 & Partner 2”." },
  weddingDate: { label: "Wedding date", type: "date" },
  city: { label: "City", type: "text", max: 80 },
  welcomeMessage: { label: "Welcome message", type: "textarea", max: 600, rows: 3 },
  partner1Family: { label: "Family of Partner 1", type: "family", side: 1 },
  partner2Family: { label: "Family of Partner 2", type: "family", side: 2 },
  // The older one-line entry: shown in the sheet only while it has text.
  partner1Parents: { label: "Partner 1's family (one line, as typed before)", type: "text", max: 160, legacy: true, hint: "Shown only while the list above is empty." },
  partner2Parents: { label: "Partner 2's family (one line, as typed before)", type: "text", max: 160, legacy: true, hint: "Shown only while the list above is empty." },
  story: { label: "Your story", type: "textarea", max: 1500, rows: 6, hint: "A blank line starts a new paragraph." },
  ceremonyTime: { label: "Ceremony time", type: "time" },
  ceremonyVenue: { label: "Ceremony venue", type: "text", max: 100 },
  ceremonyAddress: { label: "Ceremony address", type: "text", max: 160 },
  ceremonyMap: { label: "Ceremony map link (https://…)", type: "url", max: 500 },
  sameVenue: { label: "The reception is at the same place", type: "check" },
  receptionTime: { label: "Reception time", type: "time" },
  receptionVenue: { label: "Reception venue", type: "text", max: 100, group: "reception" },
  receptionAddress: { label: "Reception address", type: "text", max: 160, group: "reception" },
  receptionMap: { label: "Reception map link (https://…)", type: "url", max: 500, group: "reception" },
  gettingThere: { label: "Getting there / parking", type: "textarea", max: 400, rows: 2 },
  schedule: { label: "Schedule", type: "schedule" },
  dressCode: { label: "Attire", type: "text", max: 80 },
  dressCodeDetails: { label: "Details", type: "textarea", max: 400, rows: 3 },
  palette: { label: "Colours", type: "palette" },
  attireNotes: { label: "Notes", type: "list" },
  reminders: { label: "Reminders", type: "list" },
  giftNote: { label: "Gift note", type: "textarea", max: 400, rows: 2 },
  faq: { label: "Questions & answers", type: "faq" },
  rsvpEnabled: { label: "Guests can RSVP from their invitation", type: "check", default: true },
  rsvpDeadline: { label: "RSVP deadline", type: "date" },
  closeAfterDeadline: { label: "Close RSVPs after the deadline (you can still change RSVPs in Luna)", type: "check", default: true },
  rsvpContact: { label: "Questions go to", type: "text", max: 120 },
  mealOptions: { label: "Meal choices (guests pick one when they accept)", type: "list" },
  askDietary: { label: "Ask about dietary needs or allergies", type: "check" },
  footerNote: { label: "Closing line", type: "text", max: 200 },
  weddingSlug: { label: "Wedding link", type: "text", max: 60 },
};
const TEXTUAL = Object.keys(F).filter((k) => ["text", "textarea", "date", "time", "url"].includes(F[k].type) && k !== "coupleNames");
const CHECKS = Object.keys(F).filter((k) => F[k].type === "check");
const LIST_PH = { attireNotes: "e.g. Please avoid white", reminders: "e.g. Please arrive 30 minutes early", mealOptions: "e.g. Beef" };
// Never cleared by Reset section: the invitation always needs them.
const REQUIRED_FIELDS = new Set(["partner1Name", "partner2Name", "coupleNames", "weddingDate"]);
const FAMILY_KEYS = ["partner1Family", "partner2Family"];
export const WORDING_LABELS = Object.freeze({ intro: "Line above the names", tagline: "Line under the names", scriptLine: "Line under the names", countdownTitle: "Countdown title", storyEyebrow: "Story label", storyTitle: "Story title", detailsEyebrow: "Details label", detailsTitle: "Details title", scheduleTitle: "Schedule title", dressEyebrow: "Dress code label", dressTitle: "Dress code title", rsvpEyebrow: "RSVP label", rsvpTitle: "RSVP title", closing: "Closing words" });
// "Add your …" on a section still showing the design's example.
const ADD_LABEL = { hero: "Add your names", welcome: "Add your welcome", family: "Add your family", story: "Add your story", details: "Add your venue", schedule: "Add your schedule", dress: "Add your dress code", goodToKnow: "Add yours", rsvp: "Set up RSVP", closing: "Add your closing line" };

// Frequently Asked Questions: + Add FAQ adds one at a time (up to MAX_FAQ);
// a pair missing its question or answer is skipped. setup.faq = [{ q, a }].
export const FAQ_EXAMPLE = Object.freeze({ q: "e.g. What time should we arrive?", a: "e.g. Please arrive 30 minutes before the ceremony." });
const faqItem = (i, f) => html`<fieldset class="ws-faq" data-faq="${i}"><legend>FAQ ${i + 1}</legend>
    <div class="field"><label for="ws-faqQ${i}">Question</label><input class="input" id="ws-faqQ${i}" name="faqQ${i}" placeholder="${FAQ_EXAMPLE.q}" maxlength="150" value="${f?.q ?? ""}"></div>
    <div class="field"><label for="ws-faqA${i}">Answer</label><textarea class="input" id="ws-faqA${i}" name="faqA${i}" rows="2" placeholder="${FAQ_EXAMPLE.a}" maxlength="500">${f?.a ?? ""}</textarea></div>
    <button type="button" class="btn btn-compact btn-ghost ws-faq-remove" data-act="faq-remove" data-i="${i}" aria-label="Remove FAQ ${i + 1}">Remove</button>
  </fieldset>`;
export const faqListHtml = (list) => html`${list.map((f, i) => faqItem(i, f))}${list.length < MAX_FAQ ? html`<button type="button" class="btn btn-compact" data-act="faq-add">+ Add FAQ</button>` : ""}`;

// A list editor's rows (schedule, palette, notes, reminders, meal options).
const rowHtml = (key, i, v, ph, count = 0) => {
  const remove = html`<button type="button" class="btn btn-compact btn-ghost" data-act="list-remove" data-key="${key}" data-i="${i}" aria-label="Remove">Remove</button>`;
  // A family member: relationship (or none / Other with its own word), name, and its place in the list.
  if (FAMILY_KEYS.includes(key)) {
    const rel = v?.relation ?? "";
    return html`<div class="ws-row ie-fam-row" data-row="${i}">
      <select class="select ie-fam-rel" name="${key}-rel-${i}" aria-label="Relationship">${[["", "No label"], ...Object.entries(FAMILY_RELATIONS)].map(([id, l]) => html`<option value="${id}" ${id === rel ? "selected" : ""}>${l}</option>`)}</select>
      <input class="input ie-fam-label" name="${key}-label-${i}" aria-label="Relationship, in your words" placeholder="e.g. Ninang" maxlength="30" value="${v?.label ?? ""}" ${rel === "other" ? "" : "hidden"}>
      <input class="input ie-fam-name" name="${key}-name-${i}" aria-label="Name" placeholder="${ph?.name || "e.g. Ramon A. Prado"}" maxlength="80" value="${v?.name ?? ""}">
      <span class="ie-fam-tools"><button type="button" class="btn btn-compact btn-ghost" data-act="list-up" data-key="${key}" data-i="${i}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn btn-compact btn-ghost" data-act="list-down" data-key="${key}" data-i="${i}" aria-label="Move down" ${i >= count - 1 ? "disabled" : ""}>↓</button>${remove}</span>
    </div>`;
  }
  if (key === "schedule") return html`<div class="ws-row" data-row="${i}"><input class="input ws-row-time" type="time" name="schedule-time-${i}" aria-label="Time" value="${v?.time ?? ""}"><input class="input" name="schedule-title-${i}" aria-label="What happens" placeholder="${ph?.title || "e.g. Ceremony"}" maxlength="60" value="${v?.title ?? ""}">${remove}</div>`;
  if (key === "palette") return html`<div class="ws-row" data-row="${i}"><input class="ws-row-color" type="color" name="palette-hex-${i}" aria-label="Colour" value="${v?.hex || ph?.hex || "#c8b49a"}"><input class="input" name="palette-name-${i}" aria-label="Colour name" placeholder="${ph?.name || "e.g. Sage"}" maxlength="30" value="${v?.name ?? ""}">${remove}</div>`;
  return html`<div class="ws-row" data-row="${i}"><input class="input" name="${key}-${i}" aria-label="${F[key]?.label || key} ${i + 1}" placeholder="${ph || LIST_PH[key] || ""}" maxlength="${SETUP_LISTS[key][2]}" value="${v ?? ""}">${remove}</div>`;
};
const maxOf = (key) => (key === "schedule" ? MAX_SCHEDULE : key === "palette" ? MAX_PALETTE : FAMILY_KEYS.includes(key) ? MAX_FAMILY : SETUP_LISTS[key][1]);
const addLabel = { schedule: "+ Add time", palette: "+ Add colour", attireNotes: "+ Add note", reminders: "+ Add reminder", mealOptions: "+ Add meal choice", partner1Family: "+ Add family member", partner2Family: "+ Add family member" };
const blankRow = (key) => (key === "palette" ? { name: "", hex: "#c8b49a" } : key === "schedule" ? { time: "", title: "" } : FAMILY_KEYS.includes(key) ? { relation: "", label: "", name: "" } : "");
// samples: the design's example rows, shown as placeholders only.
export const listHtml = (key, list, samples = []) => html`${list.map((v, i) => rowHtml(key, i, v, samples[i], list.length))}${list.length < maxOf(key) ? html`<button type="button" class="btn btn-compact" data-act="list-add" data-key="${key}">${addLabel[key]}</button>` : ""}`;
function readList(f, key) {
  const out = [];
  for (let i = 0; i < 20; i++) {
    if (FAMILY_KEYS.includes(key)) {
      if (!f[`${key}-name-${i}`]) break;
      out.push({ relation: f[`${key}-rel-${i}`].value, label: f[`${key}-label-${i}`].value, name: f[`${key}-name-${i}`].value });
    } else if (key === "schedule") {
      if (!f[`schedule-title-${i}`]) break;
      out.push({ time: f[`schedule-time-${i}`].value || null, title: f[`schedule-title-${i}`].value });
    } else if (key === "palette") {
      if (!f[`palette-hex-${i}`]) break;
      out.push({ name: f[`palette-name-${i}`].value, hex: f[`palette-hex-${i}`].value });
    } else {
      if (!f[`${key}-${i}`]) break;
      out.push(f[`${key}-${i}`].value);
    }
  }
  return out;
}
const cleanFamily = (list) => list.filter((x) => x.name.trim()).map((x) => (x.relation === "other" && x.label.trim() ? { relation: "other", label: x.label.trim(), name: x.name.trim() } : { relation: x.relation === "other" ? "" : x.relation, name: x.name.trim() }));
const cleanList = (key, list) => (FAMILY_KEYS.includes(key) ? cleanFamily(list) : key === "schedule" ? list.map((x) => ({ time: x.time || null, title: x.title.trim() })).filter((x) => x.title) : key === "palette" ? list.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), hex: x.hex.toLowerCase() })) : list.map((v) => v.trim()).filter(Boolean));
const joinNames = (a, b) => [a, b].map((x) => (x || "").trim()).filter(Boolean).join(" & ");

// A sheet's values, as the API takes them (blank = null). Only the fields
// in the sheet are sent; everything else stays as saved. saved: the stored
// setup (wording lines from other sections / designs are kept).
export function readSetupForm(form, saved = {}) {
  const f = form.elements;
  const setup = {};
  for (const n of TEXTUAL) if (f[n]) setup[n] = f[n].value.trim() || null;
  if (f.coupleNames) setup.coupleNames = f.coupleNames.value.trim() || joinNames(f.partner1Name?.value ?? saved.partner1Name, f.partner2Name?.value ?? saved.partner2Name) || null;
  if (f.faqOn || f.faqQ0) {
    const faq = [];
    for (let i = 0; i < MAX_FAQ && f[`faqQ${i}`]; i++) {
      const q = f[`faqQ${i}`].value.trim();
      const a = f[`faqA${i}`].value.trim();
      if (q && a) faq.push({ q, a });
    }
    setup.faq = faq;
  }
  for (const key of ["schedule", "palette", ...FAMILY_KEYS, ...Object.keys(SETUP_LISTS)]) if (f[`${key}On`]) setup[key] = cleanList(key, readList(f, key));
  if (Object.hasOwn(setup, "weddingSlug") && setup.weddingSlug) setup.weddingSlug = cleanSlugInput(setup.weddingSlug).replace(/^-+|-+$/g, "") || null;
  if (f.templateId) setup.templateId = f.templateId.value || null;
  for (const k of CHECKS) if (f[k]) setup[k] = f[k].checked;
  // This design's wording / colour: the lines in this sheet; the rest as saved.
  if (f.wordingFor) {
    const id = f.wordingFor.value;
    const entry = getTemplateEntry(id);
    const own = saved.templateOptions?.[id] || {};
    const wording = Object.fromEntries(Object.keys(entry.wording).map((k) => [k, f[`wording-${k}`] ? f[`wording-${k}`].value.trim() || null : own.wording?.[k] ?? null]));
    // RadioNodeList.value: the checked accent ("" when none).
    const accent = f.accent ? f.accent.value || null : own.accent ?? null;
    setup.templateOptions = { ...(saved.templateOptions || {}), [id]: { wording, ...(entry.accents.length ? { accent: accent || null } : {}) } };
  }
  return setup;
}

export function mount(container, session, { api = defaultApi, toast = defaultToast, shrink = shrinkPhoto, shrinkCover = null, measure = measurePhoto, preview = openInvitePreview, confirm = confirmDialog } = {}) {
  const coverShrink = shrinkCover ?? (shrink === shrinkPhoto ? shrinkCoverPhoto : shrink);
  const canEdit = session.member.permissions["guests.manage"] === true;
  const tz = session.business?.timezone || "Asia/Manila";
  const trial = session.subscription?.trial?.open === true;
  // undo: the last successful change, one step ({ label, steps }); null = nothing to undo.
  const state = { setup: null, hero: null, photos: {}, gallery: [], entourage: [], invitation: null, look: null, error: null, mode: "edit", choosing: false, busy: false, undo: null };
  let alive = true;
  let sheet = null; // the open mini editor { backdrop, id }

  const isCustom = () => (state.invitation || {}).level === "custom";
  const real = () => state.setup || {};
  const templateId = () => (isCustom() ? state.look?.design?.config?.templateId || DEFAULT_TEMPLATE_ID : real().templateId || DEFAULT_TEMPLATE_ID);
  const entry = () => getTemplateEntry(templateId());
  const isNew = () => !isCustom() && !real().templateId && !coupleDisplayName(real()) && !real().weddingDate;
  const published = () => real().published !== false;
  const editable = (id) => entry().editableSections.find((e) => e.id === id) || null;
  // Real values + the design's samples where the wedding has nothing (this screen only).
  const merged = () => (isCustom() ? { setup: real(), hero: state.hero, photos: state.photos, sampled: [], sampledPhotos: [], sampledFields: new Set() } : previewSetup(entry(), real(), { hero: state.hero, photos: state.photos }));

  // ---------- The screen ----------
  const bar = () => {
    const inv = state.invitation || {};
    const status = isCustom()
      ? html`<span class="wl-chip" data-role="invitation-state" data-tone="${inv.live === "custom" ? "success" : "warning"}">${inv.live === "custom" ? "Live" : inv.draftState === "ready" ? "Ready" : "Draft"}</span>`
      : published()
        ? html`<span class="wl-chip" data-tone="success" data-role="publish-state">Live</span>`
        : html`<span class="wl-chip" data-tone="warning" data-role="publish-state">Not published</span>`;
    return { status, publish: canEdit && !isCustom() && !published() ? html`<button type="button" class="btn btn-compact btn-primary" data-act="publish">Publish</button>` : "" };
  };
  // The sticky bar: Edit · Clean Preview, Undo and ⋯ (Guide, Reset
  // invitation). Status and Publish sit below.
  const modes = () => html`<div class="ie-bar" data-role="editor-bar">
      <div class="ie-modes" role="tablist" aria-label="Invitation">${[["edit", "Edit"], ["preview", html`<span class="ie-long">Clean </span>Preview`]].map(([m, l]) => html`<button type="button" role="tab" class="ie-mode ie-mode-${m}" data-mode="${m}" aria-selected="${state.mode === m ? "true" : "false"}">${l}</button>`)}</div>
      <div class="ie-bar-end">
        ${canEdit && state.mode !== "preview" ? html`<button type="button" class="btn btn-compact" data-act="undo" data-role="undo" ${state.undo ? html`title="Undo: ${state.undo.label}"` : "disabled"}>Undo</button>` : ""}
        <details class="line-menu ie-more" data-role="editor-more"><summary class="btn btn-compact btn-ghost" aria-label="More">⋯</summary><div class="line-menu-list" role="menu">
          <button type="button" class="menu-item ie-mode-guide" role="menuitem" data-mode="guide">Guide</button>
          ${canEdit && !isCustom() ? html`<button type="button" class="menu-item" role="menuitem" data-act="change-design">Change design</button>` : ""}
          ${canEdit ? html`<div class="menu-sep" role="separator"></div><button type="button" class="menu-item menu-danger" role="menuitem" data-act="reset-invitation">Reset invitation</button>` : ""}
        </div></details>
      </div>
    </div>`;
  const designLine = () => {
    const e = entry();
    const { status, publish } = bar();
    const legacy = !isCustom() && !isOfferedTemplate(templateId());
    return html`<div class="ie-design" data-role="design-line">
      ${trial ? html`<div class="banner banner-info" role="note" data-role="trial-preview">${TRIAL_PREVIEW_MESSAGE}</div>` : ""}
      <div class="ie-status">${status}${publish}</div>
      ${isCustom() ? html`<p class="stat-hint" data-role="invitation-line"><strong data-role="invitation-name">Customized Invitation</strong> · Luna Bridal Custom. The design is set up by Luna; you edit your details here.${state.invitation?.hasDraft ? html` <button type="button" class="btn btn-compact btn-ghost" data-act="preview-draft">Preview draft design</button>` : ""}</p>` : html`<p class="ie-design-name"><span class="stat-hint">Design</span> <strong data-role="design-name">${e.name}</strong>${canEdit ? html` <button type="button" class="btn btn-compact btn-ghost" data-act="change-design">Change design</button>` : ""}</p>`}
      ${legacy ? html`<p class="stat-hint" data-role="legacy-note">${e.name} is no longer offered for new invitations. It keeps working for your guests; choose a new design any time.</p>` : ""}
      ${!isCustom() && published() ? html`<p class="stat-hint" data-role="live-note">Your invitation is live: guests see your changes as soon as you save them.</p>` : ""}
    </div>`;
  };
  const sampleNotice = (m) => {
    const items = [...m.sampled, ...m.sampledPhotos];
    if (!items.length) return "";
    const heroSample = m.sampledPhotos.some((x) => x.id === "hero");
    return html`<div class="banner banner-info ie-notice" role="note" data-role="sample-notice"><strong>${items.length} ${items.length === 1 ? "item is" : "items are"} still using template examples.</strong> Replace them before publishing: ${items.map((x) => x.label).join(", ")}. Until then, your guests' invitation leaves them out.${heroSample ? html` <span data-role="hero-sample-note">The cover photo is the design's example: guests see your monogram instead until you add your own.</span> <button type="button" class="btn btn-compact" data-ie-photo="hero">Add your cover photo</button>` : ""}</div>`;
  };
  const guide = () => {
    const slug = real().weddingSlug;
    const n = state.entourage.reduce((t, r) => t + r.count, 0);
    return html`<div class="ie-guide" data-role="guide">
      <p class="stat-hint">${entry().name}: what each part shows. Personalize it right on the invitation.</p>
      <ul class="ie-guide-list">${entry().editableSections.map((e) => html`<li data-guide="${e.id}"><div><strong>${e.label}</strong><p class="ie-guide-shows">${e.id === "entourage" && n ? `${n} ${n === 1 ? "person" : "people"} · ${e.shows}` : e.shows}</p><p class="stat-hint">${e.tap}</p></div>${e.link ? html`<a class="btn btn-compact" href="${e.link}" data-link>Open Guests</a>` : canEdit ? html`<button type="button" class="btn btn-compact" data-ie-edit="${e.id}">Edit</button>` : ""}</li>`)}</ul>
      <div class="ie-link" data-role="wedding-link"><strong>Your wedding link</strong>
        ${isWeddingSlug(slug) ? html`<p class="ws-link-url" data-role="wedding-url">${origin()}/w/${slug}</p>` : html`<p class="stat-hint" data-role="wedding-url-none">Your link is made from your names when you save them.</p>`}
        <div class="ws-link-actions">${isWeddingSlug(slug) ? html`<button type="button" class="btn btn-compact" data-act="copy-wedding-link">Copy link</button>` : ""}${canEdit && !trial ? html`<button type="button" class="btn btn-compact btn-ghost" data-ie-edit="link">Change link</button>` : ""}<span class="ws-link-copied" data-role="copied" aria-live="polite"></span></div>
        ${trial ? html`<p class="stat-hint" data-role="slug-paid">Luna made this link for your free trial. Choose your own (e.g. /w/carlo-yanie) with Luna Bridal: <a href="/subscription" data-link>₱499 — 3 Months · ₱799 — 6 Months</a>.</p>` : ""}
        <p class="stat-hint">Each guest gets a personal link from Guests → ⋯; only that party can open it and RSVP.</p>
      </div>
    </div>`;
  };
  const chooser = () => {
    const cur = templateId();
    const legacy = !isNew() && !isOfferedTemplate(cur);
    return html`<section class="ie-choose" data-role="template-choice">
      <h2 class="ie-choose-title">Choose your invitation design</h2>
      <p class="stat-hint">Each design opens complete, with its own example words and photos. Then personalize it right on the invitation.</p>
      <div class="ie-choose-grid">${OFFERED_TEMPLATE_IDS.map((id) => {
        const r = getTemplateEntry(id);
        return html`<button type="button" class="ie-choice${id === cur && !isNew() ? " is-current" : ""}" data-choose="${id}"><img src="${r.sampleAssets.hero || r.preview}" alt="" loading="lazy"><span class="ie-choice-text"><strong>${r.name}</strong><span class="stat-hint">${r.description}</span></span><span class="btn btn-compact btn-primary ie-choice-go">${id === cur && !isNew() ? "Current design" : "Use this design"}</span></button>`;
      })}</div>
      ${legacy ? html`<p class="stat-hint" data-role="keep-current">Your current design, ${getTemplateEntry(cur).name}, keeps working. <button type="button" class="btn btn-compact btn-ghost" data-act="keep-design">Keep ${getTemplateEntry(cur).name}</button></p>` : !isNew() ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="keep-design">Back to my invitation</button>` : ""}
    </section>`;
  };

  function draw() {
    if (!alive) return;
    if (state.error) return render(container, html`${pageHeader({ title: "Wedding Setup" })}<p class="form-error">${state.error}</p>`);
    if (!state.setup || !state.look) return render(container, html`${pageHeader({ title: "Wedding Setup" })}${skeleton(6)}`);
    if (state.choosing || (isNew() && canEdit)) {
      render(container, html`${pageHeader({ title: "Wedding Setup" })}${chooser()}`);
      return;
    }
    const m = merged();
    render(
      container,
      html`${pageHeader({ title: "Wedding Setup" })}
        <div class="ie" data-role="invitation-editor" data-mode="${state.mode}">
          ${modes()}
          ${designLine()}
          ${state.mode === "preview" ? html`${sampleNotice(m)}<p class="ie-back"><button type="button" class="btn btn-compact" data-mode="edit">Back to editing</button></p>` : ""}
          <div class="ie-layout">
            <div class="ie-canvas" data-role="canvas" ${state.mode === "guide" ? "hidden" : ""}></div>
            <aside class="ie-aside" data-role="aside" ${state.mode === "preview" ? "hidden" : ""}>${guide()}</aside>
          </div>
        </div>`
    );
    if (state.mode !== "guide") drawInvitation(m);
    // The Premium wedding link (own address, an add-on): one section that
    // keeps its state across redraws.
    const aside = container.querySelector('[data-role="aside"]');
    if (aside) {
      if (!linkBox) {
        linkBox = document.createElement("div");
        linkBox.dataset.role = "custom-link-host";
        mountCustomLink(linkBox, session, { api, toast });
      }
      aside.appendChild(linkBox);
    }
  }
  let linkBox = null;

  // The invitation itself: the guest renderer (preview mode), then in Edit
  // mode the Edit / Replace controls on top. Clean Preview: none.
  async function drawInvitation(m = merged(), scrollTo = null) {
    const canvas = container.querySelector('[data-role="canvas"]');
    if (!canvas) return;
    const look = { ...(state.look || {}), photos: m.photos };
    const invitation = invitationData({ setup: m.setup, hero: m.hero, guest: OWNER_SAMPLE_GUEST, rsvpOpen: rsvpOpen(m.setup, businessDate(tz)), look, sample: true, timezone: tz });
    const holder = document.createElement("div");
    holder.className = "ie-holder";
    canvas.replaceChildren(holder);
    const { renderInvitePage } = await import("./invitation/renderer.js");
    await renderInvitePage(holder, { token: "P".repeat(32), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) }), preview: true });
    if (state.mode === "edit") decorate(holder, m);
    if (scrollTo) holder.querySelector(`[data-edit="${scrollTo}"], [data-slot="${scrollTo}"]`)?.scrollIntoView?.({ block: "center" });
  }
  function decorate(root, m) {
    if (!canEdit) return;
    for (const el of root.querySelectorAll("[data-edit]")) {
      const ed = editable(el.dataset.edit);
      if (!ed) continue;
      // Example content in this part; "Add your …" until any of it is the couple's own.
      const usesSample = ed.fields.some((k) => m.sampledFields.has(k));
      const hasOwn = ed.fields.some((k) => !isEmptyValue(real()[k]));
      el.classList.add("ie-target");
      if (usesSample) el.classList.add("ie-sample");
      // Entourage: a link to Guests (roles are typed once, there).
      const b = document.createElement(ed.link ? "a" : "button");
      if (ed.link) {
        b.href = ed.link;
        b.dataset.link = "";
      } else {
        b.type = "button";
        b.dataset.ieEdit = ed.id;
      }
      b.className = "ie-edit";
      b.textContent = ed.link ? "Edit in Guests" : usesSample && !hasOwn ? ADD_LABEL[ed.id] || "Edit" : "Edit";
      b.setAttribute("aria-label", `${b.textContent}: ${ed.label}`);
      el.appendChild(b);
    }
    const slots = new Set(entry().editableSections.flatMap((e) => e.photos));
    for (const el of root.querySelectorAll("[data-slot]")) {
      const slot = el.dataset.slot;
      if (!slots.has(slot)) continue;
      const wrap = document.createElement("span");
      wrap.className = "ie-photo";
      el.replaceWith(wrap);
      wrap.appendChild(el);
      // Three states (2026-10-28): the couple's saved photo → Change photo /
      // Remove photo; the design's example photo → labelled, Add your photo
      // (nothing to remove); no photo at all → Add photo.
      const own = slot === "hero" ? state.hero : state.photos[slot];
      const example = !own && el.tagName === "IMG";
      const actions = document.createElement("span");
      actions.className = "ie-photo-actions";
      const button = (label, data) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ie-replace";
        Object.assign(b.dataset, data);
        b.textContent = label;
        actions.appendChild(b);
      };
      button(own ? "Change photo" : example ? "Add your photo" : "Add photo", { iePhoto: slot });
      if (own) button("Remove photo", { act: "photo-remove", photoSlot: slot });
      wrap.appendChild(actions);
      if (example) {
        const tag = document.createElement("span");
        tag.className = "ie-example";
        tag.dataset.role = "example-photo";
        tag.textContent = "Example photo · guests won't see it";
        wrap.appendChild(tag);
      }
    }
  }

  // ---------- Undo (one step) and Reset ----------
  // The values a save is about to replace, as a save that puts them back:
  // every field it sends (blank = null / [] / the field's default), and for
  // a design's wording / accent every line it sends (saves merge them).
  const blankOf = (k) => (F[k]?.type === "check" ? F[k].default === true : ["list", "schedule", "palette", "faq", "family"].includes(F[k]?.type) ? [] : null);
  function undoSetupOf(changes) {
    const s = real();
    const out = {};
    for (const k of Object.keys(changes)) {
      if (k === "templateOptions") {
        out.templateOptions = Object.fromEntries(Object.entries(changes.templateOptions).map(([id, o]) => {
          const was = s.templateOptions?.[id] || {};
          return [id, { wording: Object.fromEntries(Object.keys(o.wording || {}).map((w) => [w, was.wording?.[w] ?? null])), ...(Object.hasOwn(o, "accent") ? { accent: was.accent ?? null } : {}) }];
        }));
      } else out[k] = isEmptyValue(s[k]) && F[k] ? blankOf(k) : s[k] ?? null;
    }
    return out;
  }
  const sheetLabel = (id) => (id === "link" ? "Wedding link" : editable(id)?.label || "Change");
  // The last successful change replaces the one before (one step only).
  function remember(label, steps) {
    state.undo = { label, steps };
    const b = container.querySelector('[data-role="undo"]');
    if (b) {
      b.disabled = false;
      b.title = `Undo: ${label}`;
    }
  }
  async function undo() {
    const u = state.undo;
    if (!u || state.busy) return;
    state.busy = true;
    try {
      for (const st of u.steps) {
        if (st.kind === "setup") {
          const r = await api("wedding-setup", { method: "POST", body: { action: "save", setup: st.setup } });
          state.setup = r.setup && typeof r.setup === "object" ? r.setup : { ...real(), ...st.setup };
        } else if (st.kind === "photo") await putPhoto(st.slot, st.dataUrl);
        else if (st.kind === "galleryRemove") await api("wedding-setup", { method: "POST", body: { action: "galleryRemove", photoId: st.photoId } });
        else if (st.kind === "galleryAdd") await api("wedding-setup", { method: "POST", body: { action: "galleryAdd", dataUrl: st.dataUrl } });
      }
      if (u.steps.some((st) => st.kind.startsWith("gallery"))) await reloadGallery();
      state.undo = null;
      state.busy = false;
      toast(`Undone: ${u.label}`, "success");
      draw();
    } catch (err) {
      state.busy = false;
      toast(`Couldn't undo: ${err.message || "something went wrong"}`, "danger");
    }
  }
  // Reset section: this section's fields, wording and photos back to the
  // design's examples. The names and date stay (every invitation needs them).
  async function resetSection(id) {
    const ed = editable(id);
    if (!ed || state.busy) return;
    const s = real();
    const fields = ed.fields.filter((k) => !REQUIRED_FIELDS.has(k));
    const own = s.templateOptions?.[templateId()] || {};
    const words = ed.wording.filter((w) => own.wording?.[w]);
    const accent = id === "hero" && own.accent;
    const photos = ed.photos.filter((slot) => photoOf(slot));
    const typed = fields.filter((k) => !isEmptyValue(s[k]) && !(F[k]?.type === "check" && s[k] === (F[k].default === true)));
    if (!typed.length && !words.length && !accent && !photos.length) {
      closeSheet();
      toast("This section already shows the design's examples.", "success");
      return;
    }
    const ok = await confirm({ title: `Reset ${ed.label}?`, body: `What you entered here${photos.length ? " and your photos" : ""} will be removed. This section shows the design's examples again.${fields.length < ed.fields.length ? " Your names and date stay." : ""} Other sections are not changed. You can Undo right after.`, confirmLabel: "Reset section", danger: true });
    if (!ok) return;
    const changes = Object.fromEntries(fields.map((k) => [k, blankOf(k)]));
    if (words.length || accent) changes.templateOptions = { [templateId()]: { wording: Object.fromEntries(ed.wording.map((w) => [w, null])), ...(id === "hero" && getTemplateEntry(templateId()).accents.length ? { accent: null } : {}) } };
    state.busy = true;
    try {
      const before = undoSetupOf(changes);
      const steps = [{ kind: "setup", setup: before }, ...photos.map((slot) => ({ kind: "photo", slot, dataUrl: photoOf(slot) }))];
      const r = await api("wedding-setup", { method: "POST", body: { action: "save", setup: changes } });
      state.setup = r.setup && typeof r.setup === "object" ? r.setup : { ...real(), ...changes };
      for (const slot of photos) await putPhoto(slot, null);
      remember(`${ed.label} reset`, steps);
      state.busy = false;
      closeSheet();
      toast(`${ed.label} reset ✓`, "success");
      draw();
      await drawInvitation(merged(), id);
    } catch (err) {
      state.busy = false;
      sheetError(`Not reset: ${err.message || "something went wrong"}.`);
    }
  }
  // ⋯ → Reset invitation: the whole invitation back to the design's
  // examples (server: resetInvitation). Never guests, RSVPs or the link.
  async function resetInvitation() {
    if (state.busy) return;
    const ok = await confirm({
      title: "Reset invitation?",
      body: "Your invitation's words, family list, schedule, dress code, FAQ, closing line, design wording and colours, and all your photos are removed, so the design shows its own examples again. Your names, date, venues, RSVP settings, wedding link and published state stay. Guests, RSVP answers, roles, seating, expenses, tasks, crew meals and program are not touched.",
      confirmLabel: "Reset invitation",
      danger: true,
    });
    if (!ok) return;
    state.busy = true;
    try {
      const r = await api("wedding-setup", { method: "POST", body: { action: "resetInvitation" } });
      if (r?.setup && typeof r.setup === "object") state.setup = r.setup;
      state.hero = null;
      state.photos = {};
      state.gallery = [];
      state.look = { ...(state.look || {}), gallery: [] };
      state.undo = null;
      state.busy = false;
      toast("Invitation reset ✓", "success");
      draw();
    } catch (err) {
      state.busy = false;
      toast(`Couldn't reset: ${err.message || "something went wrong"}`, "danger");
    }
  }

  // ---------- Mini editors (one section's fields) ----------
  const fieldHtml = (name, s, sample) => {
    const d = F[name];
    // The names line shows only when the couple typed their own (else it
    // follows "Partner 1 & Partner 2" when they change).
    const v = name === "coupleNames" && s.coupleNames === joinNames(s.partner1Name, s.partner2Name) ? "" : s[name];
    const ex = sample?.[name];
    const ph = typeof ex === "string" ? ex : "";
    if (d.legacy && isEmptyValue(v)) return "";
    if (d.type === "family") {
      const list = Array.isArray(v) ? v : [];
      const who = (d.side === 1 ? s.partner1Name : s.partner2Name) || (d.side === 1 ? "Partner 1" : "Partner 2");
      return html`<div class="field ws-list ie-family" data-field="${name}"><input type="hidden" name="${name}On" value="1"><span class="field-label">Family of ${who}</span><div data-role="list-${name}">${listHtml(name, list.length ? list : [blankRow(name)], Array.isArray(ex) ? ex : [])}</div></div>`;
    }
    if (d.type === "check") return html`<label class="wl-check" data-field="${name}"><input type="checkbox" name="${name}" ${v === true || (v == null && d.default) ? "checked" : ""}> ${d.label}</label>`;
    if (["list", "schedule", "palette"].includes(d.type)) {
      const list = Array.isArray(v) ? v : [];
      const samples = Array.isArray(ex) ? ex : [];
      const rows = list.length ? list : [d.type === "palette" ? { name: "", hex: samples[0]?.hex || "#c8b49a" } : d.type === "schedule" ? { time: "", title: "" } : ""];
      return html`<div class="field ws-list" data-field="${name}"><input type="hidden" name="${name}On" value="1"><span class="field-label">${d.label}</span><div data-role="list-${name}">${listHtml(name, rows, samples)}</div></div>`;
    }
    if (d.type === "faq") return html`<section class="ws-faq-section" data-role="faq" data-field="faq"><input type="hidden" name="faqOn" value="1"><span class="field-label">${d.label}</span><div data-role="faq-list">${faqListHtml(Array.isArray(v) ? v : [])}</div></section>`;
    const id = `ie-${name}`;
    const input =
      d.type === "textarea"
        ? html`<textarea class="input" id="${id}" name="${name}" rows="${d.rows || 2}" maxlength="${d.max}" ${ph ? html`placeholder="${ph}"` : ""}>${v ?? ""}</textarea>`
        : html`<input class="input" id="${id}" name="${name}" type="${d.type}" value="${v ?? ""}" ${d.max ? html`maxlength="${d.max}"` : ""} ${ph ? html`placeholder="${ph}"` : ""} ${name === "weddingSlug" ? html`autocapitalize="none" autocomplete="off" spellcheck="false"` : ""}>`;
    return html`<div class="field" data-field="${name}" ${d.group === "reception" && s.sameVenue ? "hidden" : ""}><label for="${id}">${d.label}</label>${input}${d.hint ? html`<p class="stat-hint">${d.hint}</p>` : ""}</div>`;
  };
  const photoRow = (slots) => {
    const m = merged();
    return html`<div class="ie-sheet-photos" data-role="sheet-photos">${slots.map((slot) => {
      const realSrc = slot === "hero" ? state.hero : state.photos[slot];
      const src = slot === "hero" ? m.hero : m.photos[slot];
      const example = !realSrc && Boolean(src);
      return html`<figure class="ws-slot" data-slot-row="${slot}" data-state="${realSrc ? "saved" : example ? "example" : "none"}">${src ? html`<img src="${src}" alt="">` : html`<span class="ws-slot-empty" aria-hidden="true"></span>`}<figcaption>${slot === "hero" ? "Cover photo" : PHOTO_SLOTS[slot]}${example ? html` <span class="ws-unused" data-role="example-photo">Example photo · guests won't see it</span>` : ""}</figcaption><span class="ws-hero-actions"><button type="button" class="btn btn-compact" data-ie-photo="${slot}">${realSrc ? "Change photo" : example ? "Add your photo" : "Add photo"}</button>${realSrc ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="photo-remove" data-slot="${slot}">Remove photo</button>` : ""}</span></figure>`;
    })}${slots.includes("hero") ? html`<p class="stat-hint ws-photo-guide" data-role="photo-guide">${COVER_PHOTO_GUIDE}</p>` : ""}</div>`;
  };
  function openSheet(id) {
    if (!canEdit) return;
    if (id === "link" && trial) return;
    const ed = id === "link" ? { id: "link", label: "Wedding link", fields: ["weddingSlug"], photos: [], wording: [] } : editable(id);
    if (!ed) return;
    if (ed.link) return;
    closeSheet();
    const s = real();
    const e = entry();
    const sample = isCustom() ? null : e.sampleData;
    const wordingOn = !isCustom() && ed.wording.length > 0;
    const own = s.templateOptions?.[templateId()] || {};
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop ie-sheet-backdrop";
    document.body.appendChild(backdrop);
    sheet = { backdrop, id };
    const gallery = id === "gallery";
    render(
      backdrop,
      html`<form class="modal form ie-sheet" role="dialog" aria-modal="true" aria-label="${ed.label}" data-role="mini-editor" data-editor="${id}" novalidate>
        <div class="modal-header"><h2 class="card-title">${ed.label}</h2></div>
        <div class="modal-body">
          ${ed.photos.length ? photoRow(ed.photos) : ""}
          ${gallery ? html`<div data-role="gallery-box">${galleryBox()}</div>` : ""}
          ${ed.fields.map((n) => fieldHtml(n, s, sample))}
          ${id === "link"
            ? html`<p class="stat-hint" data-role="slug-prefix">Your link: ${origin()}/w/<strong>your-name</strong></p>
                <div class="ws-link-actions"><button type="button" class="btn btn-compact" data-act="slug-check">Check</button><span class="ws-link-copied" data-role="slug-check" aria-live="polite"></span></div>
                <p class="stat-hint">Lowercase letters, numbers and hyphens, e.g. carlo-yanie. Leave blank to make it from your names. Links already sent keep working.</p>`
            : ""}
          ${id === "hero" && wordingOn && e.accents.length ? html`<div class="field"><span class="field-label">Accent colour</span><div class="ws-accents">${e.accents.map((a) => html`<label class="ws-accent"><input type="radio" name="accent" value="${a.id}" ${a.id === (own.accent ?? e.accents[0].id) ? "checked" : ""}><span class="ws-accent-dot" data-hex="${a.hex}" aria-hidden="true"></span>${a.label}</label>`)}</div></div>` : ""}
          ${wordingOn ? html`<details class="ws-wording" data-role="wording"><summary>Wording</summary><input type="hidden" name="wordingFor" value="${templateId()}">${ed.wording.map((k) => html`<div class="field"><label for="ie-w-${k}">${WORDING_LABELS[k] || k}</label><input class="input" id="ie-w-${k}" name="wording-${k}" maxlength="80" placeholder="${e.wording[k]}" value="${own.wording?.[k] ?? ""}"></div>`)}<p class="stat-hint">Blank = the design's own words.</p></details>` : ""}
          <p class="form-error" data-role="sheet-error" role="alert" hidden></p>
        </div>
        <div class="modal-footer">${gallery ? html`<button type="button" class="btn btn-primary" data-sheet="cancel">Done</button>` : html`${id === "link" ? "" : html`<button type="button" class="btn btn-ghost ie-reset-section" data-act="reset-section">Reset section</button>`}<button type="button" class="btn" data-sheet="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-sheet="save">Save</button>`}</div>
      </form>`
    );
    for (const el of backdrop.querySelectorAll(".ws-accent-dot[data-hex]")) if (/^#[0-9a-f]{6}$/i.test(el.dataset.hex)) el.style.setProperty("--dot", el.dataset.hex);
    backdrop.addEventListener("click", onSheetClick);
    backdrop.addEventListener("change", onSheetChange);
    backdrop.addEventListener("submit", onSheetSubmit);
    // The first field the couple can see (a hidden "Other" word is skipped).
    [...backdrop.querySelectorAll(".modal-body input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=color]), .modal-body textarea")].find((el) => !el.hidden && !el.closest("[hidden]"))?.focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!sheet) return;
    sheet.backdrop.remove();
    sheet = null;
  }
  const sheetError = (text) => {
    const p = sheet?.backdrop.querySelector('[data-role="sheet-error"]');
    if (!p) return;
    p.textContent = text;
    p.hidden = !text;
  };
  async function onSheetSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    const form = event.target;
    const id = form.dataset.editor;
    const changes = readSetupForm(form, real());
    if (changes.weddingSlug && !isWeddingSlug(changes.weddingSlug)) return sheetError("The wedding link needs 3 to 60 lowercase letters, numbers or hyphens (e.g. carlo-and-yanie-wedding).");
    const badMap = ["ceremonyMap", "receptionMap"].find((n) => changes[n] && !/^https:\/\/\S+$/.test(changes[n]));
    if (badMap) return sheetError(`The ${badMap === "ceremonyMap" ? "ceremony" : "reception"} map link must start with https:// (copy it from Google Maps → Share).`);
    state.busy = true;
    const btn = form.querySelector('[data-sheet="save"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving…";
    }
    try {
      const before = undoSetupOf(changes);
      const r = await api("wedding-setup", { method: "POST", body: { action: "save", setup: changes } });
      state.setup = r.setup && typeof r.setup === "object" ? r.setup : { ...real(), ...changes };
      remember(sheetLabel(id), [{ kind: "setup", setup: before }]);
      state.busy = false;
      closeSheet();
      toast("Saved ✓", "success");
      draw();
      await drawInvitation(merged(), id === "link" ? null : id);
    } catch (err) {
      state.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Save";
      }
      sheetError(`Not saved: ${err.message || "something went wrong"}.`);
    }
  }
  function onSheetChange(event) {
    const rel = /^(partner[12]Family)-rel-(\d+)$/.exec(event.target.name || "");
    if (rel) {
      const label = sheet.backdrop.querySelector(`[name="${rel[1]}-label-${rel[2]}"]`);
      if (label) label.hidden = event.target.value !== "other";
    }
    if (event.target.name === "sameVenue") for (const el of sheet.backdrop.querySelectorAll('[data-field="receptionVenue"], [data-field="receptionAddress"], [data-field="receptionMap"]')) el.hidden = event.target.checked;
    if (event.target.dataset?.role === "gallery-add") addGallery(event.target.files[0]);
  }
  // The wedding link name: free or taken (the save decides; this only tells).
  async function checkSlug() {
    const box = sheet?.backdrop.querySelector('[data-role="slug-check"]');
    const input = sheet?.backdrop.querySelector('input[name="weddingSlug"]');
    if (!box || !input) return;
    const slug = cleanSlugInput(input.value).replace(/^-+|-+$/g, "");
    if (!isWeddingSlug(slug)) {
      box.textContent = "Use 3 to 60 lowercase letters, numbers or hyphens.";
      return;
    }
    input.value = slug;
    box.textContent = "Checking…";
    try {
      const r = await api("wedding-setup", { method: "POST", body: { action: "checkSlug", slug } });
      box.textContent = r.available ? `✓ Available: ${origin()}/w/${slug}` : "Already taken by another wedding. Try another.";
    } catch (err) {
      box.textContent = err.message || "Couldn't check. Try again.";
    }
  }
  function onSheetClick(event) {
    const el = event.target.closest("[data-sheet], [data-act], [data-ie-photo]");
    if (event.target === sheet?.backdrop) return closeSheet();
    if (!el) return;
    if (el.dataset.act === "slug-check") return checkSlug();
    if (el.dataset.sheet === "cancel") return closeSheet();
    if (el.dataset.iePhoto) return pickPhoto(el.dataset.iePhoto);
    const act = el.dataset.act;
    const form = sheet.backdrop.querySelector("form");
    if (act === "reset-section") return resetSection(sheet.id);
    if (["list-add", "list-remove", "list-up", "list-down"].includes(act)) {
      const key = el.dataset.key;
      const list = readList(form.elements, key);
      const i = Number(el.dataset.i);
      if (act === "list-add") list.push(blankRow(key));
      else if (act === "list-remove") list.splice(i, 1);
      else {
        const j = act === "list-up" ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
      }
      const box = form.querySelector(`[data-role="list-${key}"]`);
      render(box, listHtml(key, list, Array.isArray(entry().sampleData?.[key]) && !isCustom() ? entry().sampleData[key] : []));
      if (act === "list-add") box.querySelector(`[data-row="${list.length - 1}"] input:not([type="color"]):not([type="time"])`)?.focus();
      return;
    }
    if (act === "faq-add" || act === "faq-remove") {
      const list = [...form.querySelectorAll('[data-role="faq-list"] .ws-faq')].map((fs) => ({ q: fs.querySelector("input").value, a: fs.querySelector("textarea").value }));
      if (act === "faq-add") list.push({ q: "", a: "" });
      else list.splice(Number(el.dataset.i), 1);
      render(form.querySelector('[data-role="faq-list"]'), faqListHtml(list));
      if (act === "faq-add") form.querySelector(`#ws-faqQ${list.length - 1}`)?.focus();
      return;
    }
    if (act === "photo-remove") return removePhoto(el.dataset.slot);
    if (act === "gallery-remove") return removeGallery(el.dataset.id);
  }

  // ---------- Photos (straight from the invitation or a sheet) ----------
  function pickPhoto(slot) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = PHOTO_ACCEPT;
    input.className = "visually-hidden";
    input.dataset.role = "photo-pick";
    input.dataset.slot = slot;
    input.addEventListener("change", () => {
      input.remove();
      if (input.files?.[0]) savePhoto(slot, input.files[0]);
    });
    document.body.appendChild(input);
    input.click();
  }
  const photoOf = (slot) => (slot === "hero" ? state.hero : state.photos[slot]) || null;
  const photoLabel = (slot) => (slot === "hero" ? "Cover photo" : PHOTO_SLOTS[slot]);
  // One photo set (a data URL) or removed (null), and this screen's copy of it.
  async function putPhoto(slot, dataUrl) {
    await api("wedding-setup", { method: "POST", body: slot === "hero" ? { action: "hero", dataUrl } : { action: "photo", slot, dataUrl } });
    if (slot === "hero") state.hero = dataUrl;
    else if (dataUrl) state.photos = { ...state.photos, [slot]: dataUrl };
    else {
      const { [slot]: _gone, ...rest } = state.photos;
      state.photos = rest;
    }
  }
  // The cover photo is shown first in the real invitation (the same crop a
  // guest gets on this screen), with a warning when it's small; only Save
  // photo uploads it. Nothing is stored before that.
  async function previewCover(file) {
    let dataUrl;
    try {
      dataUrl = await coverShrink(file);
    } catch (err) {
      toast(`Couldn't use that photo${err.message ? `: ${err.message}` : ""}. Please try another.`, "danger");
      return;
    }
    const low = coverIsLowRes(await measure(dataUrl));
    const m = merged();
    const invitation = invitationData({ setup: m.setup, hero: dataUrl, guest: OWNER_SAMPLE_GUEST, rsvpOpen: rsvpOpen(m.setup, businessDate(tz)), look: { ...(state.look || {}), photos: m.photos }, sample: true, timezone: tz });
    const holder = {};
    holder.pv = await preview({
      token: "C".repeat(32),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) }),
      note: low ? COVER_LOW_RES : "Your new cover photo, as your guests will see it.",
      actions: [{ id: "cover-other", label: "Choose another" }, { id: "cover-save", label: "Save photo", primary: true }],
      onAction: async (id, btn) => {
        if (id === "cover-other") {
          holder.pv?.close();
          pickPhoto("hero");
          return;
        }
        if (id !== "cover-save") return;
        if (btn) btn.disabled = true;
        try {
          const before = photoOf("hero");
          await putPhoto("hero", dataUrl);
          remember(`${photoLabel("hero")} replaced`, [{ kind: "photo", slot: "hero", dataUrl: before }]);
          holder.pv?.close();
          toast("Photo saved ✓", "success");
          afterPhoto("hero");
        } catch (err) {
          if (btn) btn.disabled = false;
          toast(`Couldn't save the photo${err.message ? `: ${err.message}` : ""}. Please try again.`, "danger");
        }
      },
    });
    holder.pv?.backdrop?.querySelector('[data-role="owner-bar"]')?.setAttribute("data-low-res", low ? "1" : "0");
  }
  async function savePhoto(slot, file) {
    if (slot === "hero") return previewCover(file);
    try {
      const dataUrl = await shrink(file);
      const before = photoOf(slot);
      await putPhoto(slot, dataUrl);
      remember(`${photoLabel(slot)} replaced`, [{ kind: "photo", slot, dataUrl: before }]);
      toast("Photo saved ✓", "success");
      afterPhoto(slot);
    } catch (err) {
      // Nothing changed on screen: the saved photo (if any) stays as it was.
      toast(`Couldn't save the photo${err.message ? `: ${err.message}` : ""}. Please try again.`, "danger");
    }
  }
  async function removePhoto(slot) {
    if (!photoOf(slot)) return;
    const ok = await confirm({ title: "Remove this wedding photo?", body: "Your guests' invitation shows the design's fallback instead. You can add a photo again any time.", confirmLabel: "Remove", danger: true });
    if (!ok) return;
    try {
      const before = photoOf(slot);
      await putPhoto(slot, null);
      remember(`${photoLabel(slot)} removed`, [{ kind: "photo", slot, dataUrl: before }]);
      toast("Photo removed ✓", "success");
      afterPhoto(slot);
    } catch (err) {
      toast(err.message || "Couldn't remove the photo.", "danger");
    }
  }
  function afterPhoto(slot) {
    const row = sheet?.backdrop.querySelector('[data-role="sheet-photos"]');
    if (row) {
      const slots = [...row.querySelectorAll("[data-slot-row]")].map((x) => x.dataset.slotRow);
      const tmp = document.createElement("div");
      render(tmp, photoRow(slots));
      row.replaceWith(tmp.firstElementChild);
    }
    drawInvitation(merged(), sheet ? null : slot);
  }
  const galleryBox = () => html`<p class="stat-hint">Up to 6 photos.</p>
    <div class="ws-gallery" data-role="gallery">${state.gallery.map((g) => html`<figure class="ws-gallery-item"><img src="${g.dataUrl}" alt="Gallery photo"><button type="button" class="btn btn-compact btn-ghost" data-act="gallery-remove" data-id="${g.id}" aria-label="Remove this photo">Remove</button></figure>`)}</div>
    ${state.gallery.length < 6 ? html`<label class="btn btn-compact">+ Add photo<input class="visually-hidden" type="file" accept="${PHOTO_ACCEPT}" data-role="gallery-add" aria-label="Add a gallery photo"></label>` : ""}`;
  async function reloadGallery() {
    const r = await api("wedding-setup", { method: "POST", body: { action: "get" } });
    state.gallery = Array.isArray(r.gallery) ? r.gallery.filter((g) => typeof g.dataUrl === "string" && g.dataUrl.startsWith("data:image/")) : [];
    state.look = { ...(state.look || {}), gallery: state.gallery.map((g) => g.dataUrl) };
    const box = sheet?.backdrop.querySelector('[data-role="gallery-box"]');
    if (box) render(box, galleryBox());
    drawInvitation();
  }
  async function addGallery(file) {
    try {
      const r = await api("wedding-setup", { method: "POST", body: { action: "galleryAdd", dataUrl: await shrink(file) } });
      if (r?.photoId) remember("Gallery photo added", [{ kind: "galleryRemove", photoId: r.photoId }]);
      await reloadGallery();
    } catch (err) {
      toast(err.message || "Couldn't add the photo.", "danger");
    }
  }
  async function removeGallery(photoId) {
    try {
      const was = state.gallery.find((g) => g.id === photoId)?.dataUrl;
      await api("wedding-setup", { method: "POST", body: { action: "galleryRemove", photoId } });
      if (was) remember("Gallery photo removed", [{ kind: "galleryAdd", dataUrl: was }]);
      await reloadGallery();
    } catch (err) {
      toast(err.message || "Couldn't remove the photo.", "danger");
    }
  }

  // ---------- Design choice, publishing ----------
  async function loadLook() {
    state.look = await api("wedding-setup", { method: "POST", body: { action: "preview", which: "live", ...(isCustom() ? {} : { templateId: templateId() }) } }).catch(() => ({ design: isCustom() ? null : standardPreviewDesign(templateId()), gallery: state.gallery.map((g) => g.dataUrl), photos: state.photos }));
    // Never a design object the client can't render: fall back to the chosen Standard one.
    if (!isCustom() && state.look && state.look.design === undefined) state.look.design = standardPreviewDesign(templateId());
  }
  async function choose(id) {
    if (state.busy) return;
    state.busy = true;
    try {
      // A brand-new invitation starts unpublished while it's personalized.
      const r = await api("wedding-setup", { method: "POST", body: { action: "save", setup: { templateId: id, ...(isNew() ? { published: false } : {}) } } });
      state.setup = r.setup && typeof r.setup === "object" ? r.setup : { ...real(), templateId: id };
      state.choosing = false;
      state.mode = "edit";
      state.undo = null;
      await loadLook();
      state.busy = false;
      draw();
      container.querySelector('[data-role="invitation-editor"]')?.scrollIntoView?.({ block: "start" });
    } catch (err) {
      state.busy = false;
      toast(err.message || "Couldn't choose the design.", "danger");
    }
  }
  function openPublish() {
    closeSheet();
    const m = merged();
    const missing = setupMissing(real());
    const items = [...m.sampled, ...m.sampledPhotos];
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop ie-sheet-backdrop";
    document.body.appendChild(backdrop);
    sheet = { backdrop, id: "publish" };
    render(
      backdrop,
      html`<div class="modal ie-sheet" role="dialog" aria-modal="true" aria-label="Publish" data-role="publish-sheet">
        <div class="modal-header"><h2 class="card-title">Publish your invitation</h2></div>
        <div class="modal-body">
          ${missing.length
            ? html`<p data-role="publish-missing">Add ${missing.join(" and ")} first: your guests' invitation always shows your real names and date.</p><button type="button" class="btn btn-compact" data-ie-edit="hero">Add names &amp; date</button>`
            : html`<p>Your guests will see your invitation as soon as you share their links (Guests → ⋯).</p>
              ${items.length ? html`<div class="banner banner-info" role="note" data-role="publish-samples"><strong>Still using the design's examples:</strong> ${items.map((x) => x.label).join(", ")}. These are left out of your guests' invitation until you replace them.</div>` : html`<p class="stat-hint" data-role="publish-complete">Everything shown is your own ✓</p>`}`}
          <p class="form-error" data-role="sheet-error" role="alert" hidden></p>
        </div>
        <div class="modal-footer"><button type="button" class="btn" data-sheet="cancel">Not yet</button>${missing.length ? "" : html`<button type="button" class="btn btn-primary" data-act="confirm-publish">Publish</button>`}</div>
      </div>`
    );
    backdrop.addEventListener("click", async (event) => {
      const el = event.target.closest("[data-sheet], [data-act], [data-ie-edit]");
      if (event.target === backdrop || el?.dataset.sheet === "cancel") return closeSheet();
      if (el?.dataset.ieEdit) return openSheet(el.dataset.ieEdit);
      if (el?.dataset.act !== "confirm-publish") return;
      el.disabled = true;
      try {
        const r = await api("wedding-setup", { method: "POST", body: { action: "save", setup: { published: true } } });
        state.setup = r.setup && typeof r.setup === "object" ? r.setup : { ...real(), published: true };
        closeSheet();
        toast("Published ✓ Your guests can open their invitations.", "success");
        draw();
      } catch (err) {
        el.disabled = false;
        sheetError(err.message || "Couldn't publish.");
      }
    });
  }

  // ---------- Events on the screen ----------
  const origin = () => globalThis.location?.origin || "https://app.lunadigital.ph";
  const onClick = async (event) => {
    const el = event.target.closest("[data-mode], [data-act], [data-ie-edit], [data-ie-photo], [data-choose]");
    if (!el) return;
    if (el.dataset.mode) {
      el.closest("details")?.removeAttribute("open");
      state.mode = el.dataset.mode;
      draw();
      return;
    }
    if (el.dataset.choose) return choose(el.dataset.choose);
    if (el.dataset.ieEdit) return openSheet(el.dataset.ieEdit);
    if (el.dataset.iePhoto) return pickPhoto(el.dataset.iePhoto);
    if (el.dataset.act === "photo-remove") return removePhoto(el.dataset.photoSlot);
    const act = el.dataset.act;
    el.closest("details.ie-more")?.removeAttribute("open");
    if (act === "undo") return undo();
    if (act === "reset-invitation") return resetInvitation();
    if (act === "change-design") {
      state.choosing = true;
      draw();
    } else if (act === "keep-design") {
      state.choosing = false;
      draw();
    } else if (act === "publish") openPublish();
    else if (act === "copy-wedding-link") {
      const ok = await copyText(`${origin()}/w/${real().weddingSlug}`);
      const box = container.querySelector('[data-role="copied"]');
      if (box) box.textContent = ok ? "Copied ✓" : "Couldn't copy: select the link above";
      if (ok) toast("Copied ✓ Wedding link", "success");
    } else if (act === "preview-draft") {
      let look;
      try {
        look = await api("wedding-setup", { method: "POST", body: { action: "preview", which: "draft" } });
      } catch (err) {
        toast(err.message || "Couldn't load the design", "danger");
        return;
      }
      const invitation = invitationData({ setup: real(), hero: state.hero, guest: OWNER_SAMPLE_GUEST, rsvpOpen: rsvpOpen(real(), businessDate(tz)), look, sample: true, timezone: tz });
      await preview({ token: "P".repeat(32), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) }), note: "Draft design (not live yet), with a sample guest" });
    }
  };
  container.addEventListener("click", onClick);

  async function load() {
    try {
      const r = await api("wedding-setup", { method: "POST", body: { action: "get" } });
      state.setup = r.setup || {};
      state.hero = typeof r.hero === "string" && r.hero.startsWith("data:image/") ? r.hero : null;
      state.photos = Object.fromEntries(Object.entries(r.photos && typeof r.photos === "object" ? r.photos : {}).filter(([k, v]) => Object.hasOwn(PHOTO_SLOTS, k) && typeof v === "string" && v.startsWith("data:image/")));
      state.gallery = Array.isArray(r.gallery) ? r.gallery.filter((g) => typeof g.dataUrl === "string" && g.dataUrl.startsWith("data:image/")) : [];
      state.entourage = Array.isArray(r.entourage) ? r.entourage.filter((x) => x && typeof x.label === "string" && Number.isSafeInteger(x.count)) : [];
      state.invitation = r.invitation || null;
      await loadLook();
    } catch (err) {
      state.error = err.message || "Couldn't load the setup.";
    }
    draw();
  }
  draw();
  load();
  return () => {
    alive = false;
    closeSheet();
    container.removeEventListener("click", onClick);
  };
}

// Exported for tests: the empty-check the sample merge uses.
export { isEmptyValue, TEMPLATE_REGISTRY };
