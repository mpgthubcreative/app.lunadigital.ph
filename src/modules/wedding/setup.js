// Wedding Setup (Owner-pilot Bridal; More → Wedding Setup): what the guests'
// invitation shows and how RSVPs work. Saved through /api/wedding-setup
// (guests.manage edits; others read). Guests' links are made from Guests → ⋯.
//
// Owner-pilot fix: what's typed is kept as a draft, so a redraw never wipes
// it (choosing a cover photo used to redraw the form from the last SAVED
// values, so Save then stored blanks). Save shows Saving… / Saved ✓ (from
// the values the server read back) / a clear error.
//
// 2026-10-24 generic Wedding Setup: ONE wedding profile (information) and
// a separate invitation design (presentation), as two tabs:
//   Wedding details   Couple · Wedding information · Wedding details ·
//                     Entourage (from Guests → Role) · RSVP · Photos & media
//   Invitation design the template picker (previews, Preview with your
//                     details), what the chosen design looks best with,
//                     and its wording / colour
// Every field is optional and entered once; switching designs never loses
// anything (each design shows what it supports; registry.js `uses`). The
// fields the chosen design doesn't show say so. During the free trial the
// couple previews; guest links open once Luna Bridal is paid.

import { html, render } from "../../lib/html.js";
import { photoDataUrl, PHOTO_ACCEPT } from "../../lib/image.js";
import { pageHeader, skeleton } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { isWeddingSlug, suggestWeddingSlug, rsvpOpen, businessDate, coupleDisplayName, MAX_FAQ, MAX_SCHEDULE, MAX_PALETTE, SETUP_LISTS } from "@shared/index.js";
import { openInvitePreview, copyText } from "./invitation/preview.js";
import { TEMPLATE_REGISTRY, STANDARD_TEMPLATE_IDS, DEFAULT_TEMPLATE_ID, PHOTO_SLOTS, resolveDesign, invitationData, getTemplateEntry } from "@shared/invitation-design.js";

// The guest the Owner's Preview shows (never a real guest or link).
const OWNER_SAMPLE_GUEST = Object.freeze({ name: "Your guest's name", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [] });
export const TRIAL_PREVIEW_MESSAGE = "Preview your invitation during your free trial. Publish it when you continue with Luna Bridal.";
// The chosen Standard template as a design (Luna Standard: the original page).
export const standardPreviewDesign = (templateId) => (STANDARD_TEMPLATE_IDS.includes(templateId) && templateId !== DEFAULT_TEMPLATE_ID ? { config: resolveDesign({ templateId }), assets: {}, standard: true } : null);

// What each field is called (labels, the "looks best with" list).
export const FIELD_LABELS = Object.freeze({
  coupleNames: "Couple names",
  partner1Name: "Partner names",
  partner2Name: "Partner names",
  partner1Parents: "Parents",
  partner2Parents: "Parents",
  weddingDate: "Wedding date",
  city: "City",
  ceremonyTime: "Ceremony time",
  ceremonyVenue: "Ceremony venue",
  ceremonyAddress: "Ceremony address",
  ceremonyMap: "Ceremony map link",
  receptionTime: "Reception time",
  receptionVenue: "Reception venue",
  receptionAddress: "Reception address",
  receptionMap: "Reception map link",
  welcomeMessage: "Welcome message",
  story: "Our story",
  schedule: "Schedule",
  dressCode: "Dress code",
  dressCodeDetails: "Dress code details",
  palette: "Colour palette",
  attireNotes: "Attire notes",
  gettingThere: "Getting there / parking",
  reminders: "Reminders",
  giftNote: "Gift note",
  faq: "FAQ",
  footerNote: "Closing line",
  rsvpContact: "RSVP contact",
  ...Object.fromEntries(Object.entries(PHOTO_SLOTS)),
  hero: "Cover photo",
});
export const WORDING_LABELS = Object.freeze({ intro: "Line above the names", tagline: "Line under the names", scriptLine: "Line under the names", countdownTitle: "Countdown title", storyEyebrow: "Story label", storyTitle: "Story title", detailsEyebrow: "Details label", detailsTitle: "Details title", scheduleTitle: "Schedule title", dressEyebrow: "Dress code label", dressTitle: "Dress code title", rsvpEyebrow: "RSVP label", rsvpTitle: "RSVP title", closing: "Closing words" });

// Plain inputs: [name, label, placeholder, type].
const INPUTS = {
  partner1Name: ["Partner 1", "e.g. Camille", "text"],
  partner2Name: ["Partner 2", "e.g. Carlo", "text"],
  coupleNames: ["Names on the invitation", "", "text"],
  partner1Parents: ["Partner 1's parents", "e.g. Mr. & Mrs. Reyes", "text"],
  partner2Parents: ["Partner 2's parents", "e.g. Mr. & Mrs. Santos", "text"],
  weddingDate: ["Wedding date", "", "date"],
  city: ["City", "e.g. Tagaytay", "text"],
  ceremonyTime: ["Time", "", "time"],
  ceremonyVenue: ["Venue", "", "text"],
  ceremonyAddress: ["Address / city", "", "text"],
  ceremonyMap: ["Map link (https://…)", "", "url"],
  receptionTime: ["Time", "", "time"],
  receptionVenue: ["Venue", "", "text"],
  receptionAddress: ["Address / city", "", "text"],
  receptionMap: ["Map link (https://…)", "", "url"],
  dressCode: ["Dress code", "e.g. Formal", "text"],
  rsvpDeadline: ["RSVP deadline", "", "date"],
  rsvpContact: ["Questions go to", "e.g. Camille · 0917 123 4567", "text"],
  footerNote: ["Closing line", "e.g. With love, Carlo & Yanie", "text"],
};
const MAX = { coupleNames: 80, partner1Name: 60, partner2Name: 60, partner1Parents: 160, partner2Parents: 160, city: 80, ceremonyVenue: 100, ceremonyAddress: 160, receptionVenue: 100, receptionAddress: 160, dressCode: 80, rsvpContact: 120, footerNote: 200, welcomeMessage: 600, story: 1500, dressCodeDetails: 400, gettingThere: 400, giftNote: 400 };
const AREAS = { welcomeMessage: ["Welcome message", 3, ""], story: ["Our story", 5, "A blank line starts a new paragraph."], dressCodeDetails: ["Dress code details", 2, "e.g. Long gowns and suits; earth tones welcome."], gettingThere: ["Getting there / parking", 2, "e.g. Free parking beside the chapel."], giftNote: ["Gift note", 2, "e.g. Your presence is our gift."] };
const TEXT_FIELDS = [...Object.keys(INPUTS).filter((n) => n !== "coupleNames"), ...Object.keys(AREAS)];
// Optional content that appears on request (+ …); saved content always shows.
const EXTRAS = [
  ["story", "Our story"],
  ["schedule", "Schedule"],
  ["dressCodeDetails", "Dress code details"],
  ["palette", "Colour palette"],
  ["attireNotes", "Attire notes"],
  ["gettingThere", "Getting there / parking"],
  ["reminders", "Reminders"],
  ["giftNote", "Gift note"],
  ["faq", "FAQ"],
  ["footerNote", "Closing line"],
];
// Short lists: [placeholder, max items].
const LISTS = { attireNotes: ["e.g. No white, please", SETUP_LISTS.attireNotes[1]], reminders: ["e.g. Please arrive 30 minutes early", SETUP_LISTS.reminders[1]], mealOptions: ["e.g. Beef", SETUP_LISTS.mealOptions[1]] };

// What's typed in "Wedding link / hashtag", as a slug: "#CarloYanieForever"
// -> "carloyanieforever", "carlo and yanie" -> "carlo-and-yanie".
export const cleanSlugInput = (v) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);

// A photo shrunk in the browser to a small JPEG data URL (≤ 1200 px, under
// the gallery's 400,000-character limit): iPhone HEIC photos too
// (../../lib/image.js).
export const shrinkPhoto = (file) => photoDataUrl(file, { maxSide: 1200, quality: 0.8, maxChars: 400_000 });

// Frequently Asked Questions (2026-10-21). Optional: none by default,
// + Add FAQ adds one at a time (up to MAX_FAQ); a pair missing its question
// or answer is skipped. Stored as before: setup.faq = [{ q, a }].
export const FAQ_EXAMPLE = Object.freeze({ q: "e.g. What time should we arrive?", a: "e.g. Please arrive 30 minutes before the ceremony." });
const faqItem = (i, f, canEdit) => html`<fieldset class="ws-faq" data-faq="${i}"><legend>FAQ ${i + 1}</legend>
    <div class="field"><label for="ws-faqQ${i}">Question</label><input class="input" id="ws-faqQ${i}" name="faqQ${i}" placeholder="${FAQ_EXAMPLE.q}" maxlength="150" value="${f?.q ?? ""}" ${canEdit ? "" : "disabled"}></div>
    <div class="field"><label for="ws-faqA${i}">Answer</label><textarea class="input" id="ws-faqA${i}" name="faqA${i}" rows="2" placeholder="${FAQ_EXAMPLE.a}" maxlength="500" ${canEdit ? "" : "disabled"}>${f?.a ?? ""}</textarea></div>
    ${canEdit ? html`<button type="button" class="btn btn-compact btn-ghost ws-faq-remove" data-act="faq-remove" data-i="${i}" aria-label="Remove FAQ ${i + 1}">Remove</button>` : ""}
  </fieldset>`;
export const faqListHtml = (list, canEdit) => html`${list.map((f, i) => faqItem(i, f, canEdit))}${canEdit && list.length < MAX_FAQ ? html`<button type="button" class="btn btn-compact" data-act="faq-add">+ Add FAQ</button>` : ""}`;

// A list editor's rows (schedule, palette, notes, reminders, meal options).
const rowHtml = (key, i, v, canEdit) => {
  const dis = canEdit ? "" : "disabled";
  const remove = canEdit ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="list-remove" data-key="${key}" data-i="${i}" aria-label="Remove">Remove</button>` : "";
  if (key === "schedule")
    return html`<div class="ws-row" data-row="${i}"><input class="input ws-row-time" type="time" name="schedule-time-${i}" aria-label="Time" value="${v?.time ?? ""}" ${dis}><input class="input" name="schedule-title-${i}" aria-label="What happens" placeholder="e.g. Ceremony" maxlength="60" value="${v?.title ?? ""}" ${dis}>${remove}</div>`;
  if (key === "palette")
    return html`<div class="ws-row" data-row="${i}"><input class="ws-row-color" type="color" name="palette-hex-${i}" aria-label="Colour" value="${v?.hex || "#c8b49a"}" ${dis}><input class="input" name="palette-name-${i}" aria-label="Colour name" placeholder="e.g. Sage" maxlength="30" value="${v?.name ?? ""}" ${dis}>${remove}</div>`;
  return html`<div class="ws-row" data-row="${i}"><input class="input" name="${key}-${i}" aria-label="${FIELD_LABELS[key] || "Meal option"} ${i + 1}" placeholder="${LISTS[key][0]}" maxlength="${SETUP_LISTS[key][2]}" value="${v ?? ""}" ${dis}>${remove}</div>`;
};
const maxOf = (key) => (key === "schedule" ? MAX_SCHEDULE : key === "palette" ? MAX_PALETTE : LISTS[key][1]);
const addLabel = { schedule: "+ Add time", palette: "+ Add colour", attireNotes: "+ Add note", reminders: "+ Add reminder", mealOptions: "+ Add meal option" };
export const listHtml = (key, list, canEdit) => html`${list.map((v, i) => rowHtml(key, i, v, canEdit))}${canEdit && list.length < maxOf(key) ? html`<button type="button" class="btn btn-compact" data-act="list-add" data-key="${key}">${addLabel[key]}</button>` : ""}`;
// The rows as typed (one list).
function readList(f, key) {
  const out = [];
  for (let i = 0; i < 20; i++) {
    if (key === "schedule") {
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
const cleanList = (key, list) => (key === "schedule" ? list.map((x) => ({ time: x.time || null, title: x.title.trim() })).filter((x) => x.title) : key === "palette" ? list.map((x) => ({ name: x.name.trim() || null, hex: x.hex.toLowerCase() })) : list.map((v) => v.trim()).filter(Boolean));

// The two names → the names line, unless the couple typed their own.
const joinNames = (a, b) => [a, b].map((x) => (x || "").trim()).filter(Boolean).join(" & ");

// The form's values, as the API takes them (blank = null). Only the fields
// on the form are sent: the rest stay as saved. saved: the stored setup
// (other designs' wording is kept as it is).
export function readSetupForm(form, saved = {}) {
  const f = form.elements;
  const setup = {};
  for (const n of TEXT_FIELDS) if (f[n]) setup[n] = f[n].value.trim() || null;
  if (f.coupleNames) setup.coupleNames = f.coupleNames.value.trim() || joinNames(f.partner1Name?.value, f.partner2Name?.value) || null;
  if (f.weddingSlug) setup.weddingSlug = f.weddingSlug.value.trim() || null;
  if (f.faqOn || f.faqQ0) {
    const faq = [];
    for (let i = 0; i < 8 && f[`faqQ${i}`]; i++) {
      const q = f[`faqQ${i}`].value.trim();
      const a = f[`faqA${i}`].value.trim();
      if (q && a) faq.push({ q, a });
    }
    setup.faq = faq;
  }
  for (const key of ["schedule", "palette", ...Object.keys(LISTS)]) if (f[`${key}On`]) setup[key] = cleanList(key, readList(f, key));
  if (setup.weddingSlug) setup.weddingSlug = cleanSlugInput(setup.weddingSlug).replace(/^-+|-+$/g, "") || null;
  if (f.templateId) setup.templateId = f.templateId.value || null;
  for (const k of ["rsvpEnabled", "closeAfterDeadline", "sameVenue", "askDietary"]) if (f[k]) setup[k] = f[k].checked;
  // The chosen design's wording / colour (the other designs' stay as saved).
  if (f.wordingFor) {
    const id = f.wordingFor.value;
    const entry = getTemplateEntry(id);
    const wording = Object.fromEntries(Object.keys(entry.wording).map((k) => [k, f[`wording-${k}`]?.value.trim() || null]));
    const accent = f.accent ? f.accent.value || null : null;
    setup.templateOptions = { ...(saved.templateOptions || {}), [id]: { wording, ...(entry.accents.length ? { accent } : {}) } };
  }
  return setup;
}
const filled = (s, k) => {
  if (k === "coupleNames") return Boolean(coupleDisplayName(s));
  const v = s[k];
  return Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v != null;
};

export function mount(container, session, { api = defaultApi, toast = defaultToast, shrink = shrinkPhoto, preview = openInvitePreview } = {}) {
  const canEdit = session.member.permissions["guests.manage"] === true;
  const state = { setup: null, draft: null, hasHero: false, hero: null, photos: {}, gallery: [], entourage: [], invitation: null, error: null, saving: false, status: null, tab: "details", shown: new Set() };
  let alive = true;
  const dis = canEdit ? "" : "disabled";
  // Only a form this screen drew (opening Wedding Setup again replaces the
  // old screen: its form isn't this one's draft).
  let drawn = false;
  const form = () => (drawn ? container.querySelector('[data-role="setup"]') : null);
  const isCustom = () => (state.invitation || {}).level === "custom";
  const chosenId = (s) => (STANDARD_TEMPLATE_IDS.includes(s.templateId) ? s.templateId : DEFAULT_TEMPLATE_ID);
  // The fields the design on screen shows (Custom: Luna's design decides).
  const usesOf = (s) => (isCustom() ? null : new Set(getTemplateEntry(chosenId(s)).uses));
  const notShown = (s, name) => {
    const u = usesOf(s);
    return u && !u.has(name) ? html` <span class="ws-unused" data-role="not-shown">Not shown by ${getTemplateEntry(chosenId(s)).name}</span>` : "";
  };
  const input = (s, name, opts = {}) => {
    const [label, placeholder, type] = INPUTS[name];
    const ph = opts.placeholder ?? placeholder;
    return html`<div class="field"><label for="ws-${name}">${opts.label ?? label}${notShown(s, name)}</label><input class="input" id="ws-${name}" name="${name}" type="${type}" value="${opts.value ?? s[name] ?? ""}" ${ph ? html`placeholder="${ph}"` : ""} ${MAX[name] ? html`maxlength="${MAX[name]}"` : ""} ${dis}></div>`;
  };
  const area = (s, name) => {
    const [label, rows, hint] = AREAS[name];
    return html`<div class="field"><label for="ws-${name}">${label}${notShown(s, name)}</label><textarea class="input" id="ws-${name}" name="${name}" rows="${rows}" maxlength="${MAX[name]}" ${hint ? html`placeholder="${hint}"` : ""} ${dis}>${s[name] ?? ""}</textarea></div>`;
  };
  const listBlock = (s, key, label) => {
    const list = Array.isArray(s[key]) ? s[key] : [];
    return html`<div class="field ws-list" data-list="${key}"><input type="hidden" name="${key}On" value="1"><span class="field-label">${label}${notShown(s, key)}</span><div data-role="list-${key}">${listHtml(key, list.length || !canEdit ? list : [key === "palette" ? { name: "", hex: "#c8b49a" } : key === "schedule" ? { time: "", title: "" } : ""], canEdit)}</div></div>`;
  };
  const host = () => globalThis.location?.host || "app.lunadigital.ph";
  const slugPreview = (slug, names) => `Guests' links look like ${host()}/w/${slug || suggestWeddingSlug(names) || "your-names-wedding"}/invite/… (the private part after /invite/ is different for each guest).`;
  const slugField = (s) =>
    html`<div class="field"><label for="ws-weddingSlug">Wedding link / hashtag</label><input class="input" id="ws-weddingSlug" name="weddingSlug" type="text" autocapitalize="none" autocomplete="off" spellcheck="false" maxlength="60" value="${s.weddingSlug ?? ""}" placeholder="${suggestWeddingSlug(coupleDisplayName(s)) || "e.g. carlo-and-yanie-wedding"}" aria-describedby="ws-slug-hint" ${dis}><p class="stat-hint" id="ws-slug-hint" data-role="slug-preview">${slugPreview(s.weddingSlug, coupleDisplayName(s))}</p><p class="stat-hint">Lowercase letters, numbers and hyphens, e.g. carloyanieforever. Leave blank to use the suggestion. Change it before sharing; links already sent keep working.</p></div>`;

  // ---- Wedding details ----
  const coupleSection = (s) => {
    // The names line shows only when it differs from "Partner 1 & Partner 2".
    const auto = joinNames(s.partner1Name, s.partner2Name);
    const own = s.coupleNames && s.coupleNames !== auto ? s.coupleNames : "";
    const parents = state.shown.has("parents") || s.partner1Parents || s.partner2Parents;
    return html`<section class="ws-section" data-role="couple-section"><h3 class="ws-sub-title">Couple</h3>
      <div class="ws-pair">${input(s, "partner1Name")}${input(s, "partner2Name")}</div>
      ${input(s, "coupleNames", { value: own, placeholder: auto || "e.g. Camille & Carlo", label: auto ? "Names on the invitation (optional)" : "Couple names" })}
      ${parents ? html`<div class="ws-pair">${input(s, "partner1Parents")}${input(s, "partner2Parents")}</div>` : canEdit ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="reveal" data-key="parents">+ Add parents</button>` : ""}
      ${slugField(s)}
      ${linkBox()}
    </section>`;
  };
  const infoSection = (s) => html`<section class="ws-section" data-role="info-section"><h3 class="ws-sub-title">Wedding information</h3>
      <div class="ws-pair">${input(s, "weddingDate")}${input(s, "city")}</div>
      <fieldset class="wl-fieldset"><legend>Ceremony</legend>${input(s, "ceremonyTime")}${input(s, "ceremonyVenue")}${input(s, "ceremonyAddress")}${input(s, "ceremonyMap")}</fieldset>
      <label class="wl-check"><input type="checkbox" name="sameVenue" ${s.sameVenue ? "checked" : ""} ${dis}> The reception is at the same place</label>
      <fieldset class="wl-fieldset"><legend>Reception</legend>${input(s, "receptionTime")}<div data-role="reception-place" ${s.sameVenue ? "hidden" : ""}>${input(s, "receptionVenue")}${input(s, "receptionAddress")}${input(s, "receptionMap")}</div></fieldset>
    </section>`;
  const extraOn = (s, key) => state.shown.has(key) || filled(s, key);
  const extraBlock = (s, key) =>
    key === "faq"
      ? faqSection(Array.isArray(s.faq) ? s.faq : [])
      : AREAS[key]
        ? area(s, key)
        : key === "footerNote"
          ? input(s, "footerNote")
          : listBlock(s, key, FIELD_LABELS[key]);
  const detailsSection = (s) => {
    const u = usesOf(s);
    // The chosen design's extras first.
    const order = [...EXTRAS].sort((a, b) => (u ? Number(!u.has(a[0])) - Number(!u.has(b[0])) : 0));
    const open = order.filter(([k]) => extraOn(s, k));
    const closed = order.filter(([k]) => !extraOn(s, k));
    return html`<section class="ws-section" data-role="details-section"><h3 class="ws-sub-title">Wedding details</h3>
      ${area(s, "welcomeMessage")}
      ${input(s, "dressCode")}
      ${open.map(([k]) => html`<div data-extra="${k}">${extraBlock(s, k)}</div>`)}
      ${canEdit && closed.length ? html`<div class="ws-add-more" data-role="add-more"><span class="stat-hint">Add more (optional)</span><div class="ws-chips">${closed.map(([k, l]) => html`<button type="button" class="btn btn-compact btn-ghost${u && u.has(k) ? " ws-used" : ""}" data-act="reveal" data-key="${k}">+ ${l}</button>`)}</div></div>` : ""}
    </section>`;
  };
  // The FAQ section of the form, kept as typed while FAQs are added / removed.
  const faqSection = (faq) => html`<section class="ws-faq-section" data-role="faq"><input type="hidden" name="faqOn" value="1">
      <h4 class="ws-sub-title">Frequently Asked Questions</h4>
      <p class="stat-hint">Add helpful information for your guests (optional).</p>
      <div data-role="faq-list">${faqListHtml(faq, canEdit)}</div>
    </section>`;
  const entourageSection = () => {
    const n = state.entourage.reduce((t, r) => t + r.count, 0);
    return html`<section class="ws-section" data-role="entourage-section"><h3 class="ws-sub-title">Entourage</h3>
      <p class="stat-hint">${n ? `${n} ${n === 1 ? "person" : "people"} in ${state.entourage.length} ${state.entourage.length === 1 ? "role" : "roles"}: ${state.entourage.map((r) => `${r.label} (${r.count})`).join(", ")}.` : "No roles yet."} The entourage comes from your guest list: set a guest's Role in Guests (nothing to type twice).</p>
      <a class="btn btn-compact" href="/guests" data-link>Open Guests</a>
    </section>`;
  };
  const rsvpSection = (s) => html`<section class="ws-section" data-role="rsvp-section"><h3 class="ws-sub-title">RSVP</h3>
      <label class="wl-check"><input type="checkbox" name="rsvpEnabled" ${s.rsvpEnabled ? "checked" : ""} ${dis}> Guests can RSVP from their invitation</label>
      ${input(s, "rsvpDeadline")}
      <label class="wl-check"><input type="checkbox" name="closeAfterDeadline" ${s.closeAfterDeadline === false ? "" : "checked"} ${dis}> Close guest RSVPs after the deadline (you can still change RSVPs in Luna)</label>
      ${input(s, "rsvpContact")}
      ${listBlock({ ...s, mealOptions: Array.isArray(s.mealOptions) ? s.mealOptions : [] }, "mealOptions", "Meal choices (optional: guests pick one when they accept)")}
      <label class="wl-check"><input type="checkbox" name="askDietary" ${s.askDietary ? "checked" : ""} ${dis}> Ask guests about dietary needs or allergies</label>
    </section>`;

  // ---- Photos & media ----
  const heroBox = () =>
    html`${state.hero ? html`<img class="ws-hero-thumb" src="${state.hero}" alt="Current cover photo" data-role="hero-preview">` : ""}
      <p class="stat-hint" data-role="hero-state">${state.hasHero ? "A photo is set." : "No photo: the invitation shows a soft colour instead."}</p>
      ${canEdit ? html`<div class="ws-hero-actions"><label class="btn btn-compact">${state.hasHero ? "Change photo" : "Choose photo"}<input class="visually-hidden" type="file" accept="${PHOTO_ACCEPT}" data-role="hero" aria-label="Cover photo"></label>${state.hasHero ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="hero-remove">Remove photo</button>` : ""}</div>` : ""}`;
  const slotsOf = (s) => {
    const wanted = isCustom() ? [] : getTemplateEntry(chosenId(s)).photoSlots;
    return Object.keys(PHOTO_SLOTS).filter((k) => wanted.includes(k) || state.photos[k]);
  };
  const photoSlotBox = (s) => {
    const slots = slotsOf(s);
    return slots.length
      ? html`<div class="ws-slots">${slots.map((k) => html`<figure class="ws-slot" data-slot="${k}">${state.photos[k] ? html`<img src="${state.photos[k]}" alt="${PHOTO_SLOTS[k]}">` : html`<span class="ws-slot-empty" aria-hidden="true"></span>`}<figcaption>${PHOTO_SLOTS[k]}${notShown(s, k)}</figcaption>${canEdit ? html`<span class="ws-hero-actions"><label class="btn btn-compact">${state.photos[k] ? "Change" : "Add"}<input class="visually-hidden" type="file" accept="${PHOTO_ACCEPT}" data-role="photo" data-slot="${k}" aria-label="${PHOTO_SLOTS[k]}"></label>${state.photos[k] ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="photo-remove" data-slot="${k}">Remove</button>` : ""}</span>` : ""}</figure>`)}</div>`
      : "";
  };
  const galleryBox = () => html`<p class="stat-hint">Gallery (up to 6)</p>
    <div class="ws-gallery" data-role="gallery">${state.gallery.map((g) => html`<figure class="ws-gallery-item"><img src="${g.dataUrl}" alt="Gallery photo">${canEdit ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="gallery-remove" data-id="${g.id}" aria-label="Remove this photo">Remove</button>` : ""}</figure>`)}</div>
    ${canEdit && state.gallery.length < 6 ? html`<label class="btn btn-compact">+ Add photo<input class="visually-hidden" type="file" accept="${PHOTO_ACCEPT}" data-role="gallery-add" aria-label="Add a gallery photo"></label>` : ""}`;
  const photosSection = (s) => {
    const u = usesOf(s);
    const galleryShown = isCustom() || state.gallery.length > 0 || (u && getTemplateEntry(chosenId(s)).shows.includes("gallery")) || chosenId(s) === DEFAULT_TEMPLATE_ID;
    return html`<section class="ws-section" data-role="photos-section" id="ws-photos"><h3 class="ws-sub-title">Photos &amp; media</h3>
      <p class="stat-hint">Cover photo</p><div data-role="hero-box">${heroBox()}</div>
      <div data-role="slots-box">${photoSlotBox(s)}</div>
      ${galleryShown ? html`<div data-role="gallery-box">${galleryBox()}</div>` : ""}
    </section>`;
  };

  // ---- Invitation design ----
  // Standard (Luna Bridal) or Customized (Luna Bridal+) with its state. A
  // Custom design is Luna's (Super Admin); the couple edits content only.
  const invitationBox = (s) => {
    const inv = state.invitation || { level: "standard", live: "standard" };
    const custom = inv.level === "custom";
    const stateLine = !custom
      ? inv.preservedCustom
        ? "Your customized design is saved and comes back with Luna Bridal Custom."
        : "Want an invitation designed just for your wedding? The Customized Invitation comes with Luna Bridal Custom. Ask Luna to upgrade: your guests, links and RSVPs stay exactly as they are."
      : inv.live === "custom"
        ? `Live${inv.publishedVersion ? ` (version ${inv.publishedVersion})` : ""}. All guest links show it.${inv.hasDraft && inv.draftState === "ready" ? " A new version is ready with Luna." : ""}`
        : inv.hasDraft
          ? `${inv.draftState === "ready" ? "Ready for publishing" : "Draft"} · Your current Standard invitation remains live.`
          : "Luna is preparing your design. Your current Standard invitation remains live.";
    const trial = session.subscription?.trial?.open === true;
    return html`<fieldset class="wl-fieldset" data-role="invitation-level"><legend>Invitation</legend>
      ${trial ? html`<div class="banner banner-info" role="note" data-role="trial-preview">${TRIAL_PREVIEW_MESSAGE}</div>` : ""}
      <p><strong data-role="invitation-name">${custom ? "Customized Invitation" : "Standard Invitation"}</strong> <span class="stat-hint">${custom ? "Luna Bridal Custom" : "Included with Luna Bridal"}</span>${custom ? html` <span class="wl-chip" data-role="invitation-state" data-tone="${inv.live === "custom" ? "success" : "warning"}">${inv.live === "custom" ? "Live" : inv.draftState === "ready" ? "Ready" : "Draft"}</span>` : ""}</p>
      <p class="stat-hint" data-role="invitation-line">${stateLine}</p>
      <div class="ws-link-actions"><button type="button" class="btn btn-compact" data-act="preview">Preview${custom && inv.live !== "custom" ? " (live: Standard)" : ""}</button>${custom && inv.hasDraft ? html`<button type="button" class="btn btn-compact" data-act="preview-draft">Preview draft design</button>` : ""}</div>
      ${custom ? html`<p class="stat-hint">Luna shows your details, story, FAQ, photos and gallery where your design has those sections. The design itself is set up by Luna.</p>` : ""}
    </fieldset>`;
  };
  const picker = (s) => {
    const chosen = chosenId(s);
    const entries = TEMPLATE_REGISTRY.filter((r) => r.category === "standard");
    return html`<div class="field" data-role="template-choice"><span class="field-label">Choose a design</span>
      <div class="tpl-options">${entries.map((r) => html`<div class="tpl-item"><label class="tpl-option"><input type="radio" name="templateId" value="${r.id}" ${r.id === chosen ? "checked" : ""} ${dis}><img class="tpl-thumb" src="${r.preview}" alt="" loading="lazy" width="120" height="160"><span class="tpl-text"><strong>${r.name}</strong><span class="stat-hint">${r.description}</span></span></label><button type="button" class="btn btn-compact btn-ghost tpl-preview" data-act="preview" data-id="${r.id}" aria-label="Preview ${r.name} with your details">Preview</button></div>`)}</div>
      <p class="stat-hint">Your details stay the same whichever design you choose. Links already sent keep working.</p></div>`;
  };
  // What the chosen design looks best with and isn't filled yet.
  const missingOf = (s) => {
    const e = getTemplateEntry(chosenId(s));
    const fields = [...e.required, ...e.recommended].filter((k, i, a) => a.indexOf(k) === i && !filled(s, k));
    const photos = [...(state.hasHero ? [] : ["hero"]), ...e.photoSlots.filter((k) => !state.photos[k])];
    return { fields, photos, entry: e };
  };
  const readiness = (s) => {
    const { fields, photos, entry } = missingOf(s);
    const items = [...fields.map((k) => ({ k, kind: "field" })), ...photos.map((k) => ({ k, kind: "photo" }))];
    return html`<div class="ws-ready" data-role="design-ready">${items.length
      ? html`<p><strong>${entry.name}</strong> looks best with:</p><div class="ws-chips">${items.map((it) => html`<button type="button" class="btn btn-compact${entry.required.includes(it.k) ? " btn-primary" : ""}" data-act="goto" data-field="${it.k}" data-kind="${it.kind}">+ ${FIELD_LABELS[it.k]}</button>`)}</div><p class="stat-hint">All optional except the names and the date. Empty parts are simply left out.</p>`
      : html`<p data-role="design-complete"><strong>${entry.name}</strong> has everything it shows ✓</p>`}</div>`;
  };
  const wordingBox = (s) => {
    const id = chosenId(s);
    const e = getTemplateEntry(id);
    const own = s.templateOptions?.[id] || {};
    const accent = own.accent ?? e.accents[0]?.id ?? null;
    return html`<details class="ws-wording" data-role="wording"><summary>Customize wording${e.accents.length ? " and colour" : ""}</summary><input type="hidden" name="wordingFor" value="${id}">
      ${e.accents.length ? html`<div class="field"><span class="field-label">Accent colour</span><div class="ws-accents">${e.accents.map((a) => html`<label class="ws-accent"><input type="radio" name="accent" value="${a.id}" ${a.id === accent ? "checked" : ""} ${dis}><span class="ws-accent-dot" data-hex="${a.hex}" aria-hidden="true"></span>${a.label}</label>`)}</div></div>` : ""}
      ${Object.entries(e.wording).map(([k, def]) => html`<div class="field"><label for="ws-wording-${k}">${WORDING_LABELS[k] || k}</label><input class="input" id="ws-wording-${k}" name="wording-${k}" maxlength="80" placeholder="${def}" value="${own.wording?.[k] ?? ""}" ${dis}></div>`)}
      <p class="stat-hint">Blank = the design's own words (shown faintly). Kept for this design if you switch.</p>
    </details>`;
  };
  const designPanel = (s) => html`${invitationBox(s)}${isCustom() ? "" : html`${picker(s)}${readiness(s)}${wordingBox(s)}`}`;

  // The wedding's own link (identity) vs each guest's private invitation.
  const origin = () => globalThis.location?.origin || "https://app.lunadigital.ph";
  const linkBox = () => {
    const slug = state.setup?.weddingSlug;
    return html`<div class="ws-link" data-role="wedding-link">
      <span class="stat-hint">Wedding link</span>
      ${isWeddingSlug(slug) ? html`<span class="ws-link-url" data-role="wedding-url">${origin()}/w/${slug}</span>` : html`<span class="stat-hint" data-role="wedding-url-none">Save to get your wedding link.</span>`}
      <div class="ws-link-actions">${isWeddingSlug(slug) ? html`<button type="button" class="btn btn-compact" data-act="copy-wedding-link">Copy link</button>` : ""}<button type="button" class="btn btn-compact" data-act="preview">Preview</button><span class="ws-link-copied" data-role="copied" aria-live="polite"></span></div>
      <p class="stat-hint">Each guest gets a personal invitation link: ${host()}/w/${isWeddingSlug(slug) ? slug : "…"}/invite/••••••. The private part is different for every guest, and only that party can open it and RSVP. Copy or share each one from Guests → ⋯.</p>
    </div>`;
  };
  const typedNames = () => {
    const f = form();
    if (!f) return "";
    return f.elements.coupleNames.value.trim() || joinNames(f.elements.partner1Name?.value, f.elements.partner2Name?.value);
  };
  const syncNames = () => {
    const f = form();
    if (!f) return;
    const auto = joinNames(f.elements.partner1Name.value, f.elements.partner2Name.value);
    f.elements.coupleNames.placeholder = auto || "e.g. Camille & Carlo";
    f.elements.weddingSlug.placeholder = suggestWeddingSlug(typedNames()) || "e.g. carlo-and-yanie-wedding";
    const box = container.querySelector('[data-role="slug-preview"]');
    if (box) box.textContent = slugPreview(cleanSlugInput(f.elements.weddingSlug.value).replace(/^-+|-+$/g, ""), typedNames());
  };
  // Next to Save: Saving… / Saved ✓ / Not saved yet / the error.
  const statusLine = () => {
    const st = state.status;
    if (!st) return "";
    return st.state === "error"
      ? html`<p class="form-error" role="alert" data-role="save-state" data-state="error">${st.text}</p>`
      : html`<p class="save-state" role="status" data-role="save-state" data-state="${st.state}">${st.text}</p>`;
  };
  const drawHero = () => {
    const box = container.querySelector('[data-role="hero-box"]');
    if (box) render(box, heroBox());
  };
  const drawStatus = () => {
    const box = container.querySelector('[data-role="save-box"]');
    if (box) render(box, statusLine());
    const btn = container.querySelector('[data-role="setup"] button[type="submit"]');
    if (btn) {
      btn.disabled = state.saving;
      btn.textContent = state.saving ? "Saving…" : "Save";
    }
  };
  const dirty = () => {
    if (state.status?.state !== "dirty") {
      state.status = { state: "dirty", text: "Not saved yet: press Save to keep these changes." };
      drawStatus();
    }
  };
  const faqTyped = () => [...container.querySelectorAll('[data-role="faq-list"] .ws-faq')].map((fs) => ({ q: fs.querySelector("input").value, a: fs.querySelector("textarea").value }));
  const drawFaq = (list) => {
    const box = container.querySelector('[data-role="faq-list"]');
    if (box) render(box, faqListHtml(list, canEdit));
  };
  const current = () => (state.draft ? { ...(state.setup || {}), ...state.draft } : state.setup);
  const paintSwatches = () => {
    for (const el of container.querySelectorAll(".ws-accent-dot[data-hex]")) if (/^#[0-9a-f]{6}$/i.test(el.dataset.hex)) el.style.setProperty("--dot", el.dataset.hex);
  };

  function draw() {
    if (!alive) return;
    // Whatever is typed survives a redraw. The draft holds only the fields
    // on the form; the rest stay as saved, never blanked.
    if (form() && canEdit) state.draft = readSetupForm(form(), state.setup || {});
    const s = current();
    const tab = state.tab;
    render(
      container,
      html`
        ${pageHeader({ title: "Wedding Setup" })}
        ${state.error
          ? html`<p class="form-error">${state.error}</p>`
          : !s
            ? skeleton(6)
            : html`<form class="wl-form" data-role="setup" novalidate>
                <div class="ws-tabs" role="tablist" aria-label="Wedding Setup">
                  <button type="button" role="tab" class="ws-tab" data-tab="details" aria-selected="${tab === "details" ? "true" : "false"}">Wedding details</button>
                  <button type="button" role="tab" class="ws-tab" data-tab="design" aria-selected="${tab === "design" ? "true" : "false"}">Invitation design</button>
                </div>
                <div data-panel="details" ${tab === "details" ? "" : "hidden"}>
                  <p class="stat-hint">Your wedding's information, entered once. Every invitation design uses it; all of it is optional except the names and the date.</p>
                  ${coupleSection(s)}
                  ${infoSection(s)}
                  ${detailsSection(s)}
                  ${entourageSection()}
                  ${rsvpSection(s)}
                  ${photosSection(s)}
                </div>
                <div data-panel="design" ${tab === "design" ? "" : "hidden"}>${designPanel(s)}</div>
                ${canEdit ? html`<div class="page-actions ws-save"><button type="submit" class="btn btn-primary" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save"}</button></div><div data-role="save-box">${statusLine()}</div>` : ""}
              </form>`}`
    );
    drawn = true;
    paintSwatches();
  }

  const photosFrom = (r) => Object.fromEntries(Object.entries(r.photos && typeof r.photos === "object" ? r.photos : {}).filter(([k, v]) => Object.hasOwn(PHOTO_SLOTS, k) && typeof v === "string" && v.startsWith("data:image/")));
  async function load() {
    try {
      const r = await api("wedding-setup", { method: "POST", body: { action: "get" } });
      state.setup = r.setup || {};
      state.hasHero = Boolean(r.hasHero);
      state.hero = typeof r.hero === "string" && r.hero.startsWith("data:image/") ? r.hero : null;
      state.photos = photosFrom(r);
      state.gallery = Array.isArray(r.gallery) ? r.gallery.filter((g) => typeof g.dataUrl === "string" && g.dataUrl.startsWith("data:image/")) : [];
      state.entourage = Array.isArray(r.entourage) ? r.entourage.filter((x) => x && typeof x.label === "string" && Number.isSafeInteger(x.count)) : [];
      state.invitation = r.invitation || null;
    } catch (err) {
      state.error = err.message || "Couldn't load the setup.";
    }
    draw();
  }

  const onSubmit = async (event) => {
    if (event.target.dataset.role !== "setup") return;
    event.preventDefault();
    if (state.saving) return;
    const setup = readSetupForm(event.target, state.setup || {});
    state.draft = setup;
    if (setup.weddingSlug && !isWeddingSlug(setup.weddingSlug)) {
      state.status = { state: "error", text: "Not saved: the wedding link needs 3 to 60 lowercase letters, numbers or hyphens (e.g. carlo-and-yanie-wedding)." };
      drawStatus();
      return;
    }
    const badMap = ["ceremonyMap", "receptionMap"].find((n) => setup[n] && !/^https:\/\/\S+$/.test(setup[n]));
    if (badMap) {
      state.status = { state: "error", text: `Not saved: the ${badMap === "ceremonyMap" ? "ceremony" : "reception"} map link must start with https:// (copy it from Google Maps → Share).` };
      drawStatus();
      return;
    }
    state.saving = true;
    state.status = { state: "saving", text: "Saving…" };
    drawStatus();
    try {
      const r = await api("wedding-setup", { method: "POST", body: { action: "save", setup } });
      // Show what the server stored (read back after the write).
      state.setup = r.setup && typeof r.setup === "object" ? r.setup : { ...state.setup, ...setup };
      state.draft = null;
      state.saving = false;
      state.status = { state: "saved", text: "Saved ✓ Guests' invitations now use these details." };
      form()?.remove(); // redraw from the saved values, not the draft
      draw();
      toast("Wedding setup saved.", "success");
    } catch (err) {
      state.saving = false;
      state.status = { state: "error", text: `Not saved: ${err.message || "something went wrong"}. Your changes are still here; press Save to try again.` };
      drawStatus();
      toast(err.message || "Couldn't save.", "danger");
    }
  };
  const onInput = (event) => {
    if (!event.target.closest('[data-role="setup"]') || ["hero", "gallery-add", "photo"].includes(event.target.dataset?.role) || state.saving) return;
    if (event.target.name === "weddingSlug") {
      const clean = cleanSlugInput(event.target.value);
      if (clean !== event.target.value) event.target.value = clean;
    }
    if (["weddingSlug", "coupleNames", "partner1Name", "partner2Name"].includes(event.target.name)) syncNames();
    dirty();
  };
  async function reloadGallery() {
    const r = await api("wedding-setup", { method: "POST", body: { action: "get" } });
    state.gallery = Array.isArray(r.gallery) ? r.gallery.filter((g) => typeof g.dataUrl === "string" && g.dataUrl.startsWith("data:image/")) : [];
    const box = container.querySelector('[data-role="gallery-box"]');
    if (box) render(box, galleryBox());
  }
  // Only the photos part / the design checklist redraw: the typed details stay.
  const drawPhotos = () => {
    const s = form() ? { ...(state.setup || {}), ...readSetupForm(form(), state.setup || {}) } : current();
    const box = container.querySelector('[data-role="slots-box"]');
    if (box) render(box, photoSlotBox(s));
    const ready = container.querySelector('[data-role="design-ready"]');
    if (ready) {
      const tmp = document.createElement("div");
      render(tmp, readiness(s));
      ready.replaceWith(tmp.firstElementChild);
    }
  };
  const onChange = async (event) => {
    const role = event.target.dataset?.role;
    if (event.target.name === "templateId") {
      draw(); // the design's hints, photo slots, checklist and wording
      return;
    }
    if (event.target.name === "sameVenue") {
      const box = container.querySelector('[data-role="reception-place"]');
      if (box) box.hidden = event.target.checked;
      return;
    }
    if (role === "gallery-add") {
      try {
        const dataUrl = await shrink(event.target.files[0]);
        await api("wedding-setup", { method: "POST", body: { action: "galleryAdd", dataUrl } });
        toast("Photo added.", "success");
        await reloadGallery();
      } catch (err) {
        toast(err.message || "Couldn't add the photo.", "danger");
      }
      return;
    }
    if (role === "photo") {
      const slot = event.target.dataset.slot;
      try {
        const dataUrl = await shrink(event.target.files[0]);
        await api("wedding-setup", { method: "POST", body: { action: "photo", slot, dataUrl } });
        state.photos = { ...state.photos, [slot]: dataUrl };
        toast(`${PHOTO_SLOTS[slot]} saved.`, "success");
        drawPhotos();
      } catch (err) {
        toast(err.message || "Couldn't save the photo.", "danger");
      }
      return;
    }
    if (role !== "hero") return;
    try {
      const dataUrl = await shrink(event.target.files[0]);
      await api("wedding-setup", { method: "POST", body: { action: "hero", dataUrl } });
      state.hasHero = true;
      state.hero = dataUrl;
      toast("Cover photo saved.", "success");
      drawHero(); // only the photo part: the typed details stay as they are
      drawPhotos();
    } catch (err) {
      toast(err.message || "Couldn't save the photo.", "danger");
    }
  };
  const focusField = (key) => {
    const el = container.querySelector(`#ws-${key}`) || container.querySelector(`[data-extra="${key}"] input, [data-extra="${key}"] textarea, [data-extra="${key}"] button`) || container.querySelector(`[data-slot="${key}"]`);
    el?.scrollIntoView?.({ block: "center" });
    el?.focus?.();
  };
  const onClick = async (event) => {
    const el = event.target.closest("[data-act], [data-tab]");
    if (!el) return;
    if (el.dataset.tab) {
      state.tab = el.dataset.tab;
      for (const p of container.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== state.tab;
      for (const t of container.querySelectorAll("[data-tab]")) t.setAttribute("aria-selected", t.dataset.tab === state.tab ? "true" : "false");
      return;
    }
    const act = el.dataset.act;
    if (act === "reveal") {
      const key = el.dataset.key;
      state.shown.add(key);
      draw();
      focusField(key === "parents" ? "partner1Parents" : key);
      return;
    }
    if (act === "goto") {
      // "Looks best with": open Wedding details at that field.
      const key = el.dataset.field;
      state.tab = "details";
      if (EXTRAS.some(([k]) => k === key)) state.shown.add(key);
      if (key === "partner1Parents" || key === "partner2Parents") state.shown.add("parents");
      draw();
      if (el.dataset.kind === "photo") container.querySelector(key === "hero" ? '[data-role="hero-box"]' : `[data-slot="${key}"]`)?.scrollIntoView?.({ block: "center" });
      else focusField(key === "coupleNames" ? "partner1Name" : key);
      return;
    }
    if (act === "list-add" || act === "list-remove") {
      const key = el.dataset.key;
      const f = form();
      const list = readList(f.elements, key);
      if (act === "list-add") list.push(key === "palette" ? { name: "", hex: "#c8b49a" } : key === "schedule" ? { time: "", title: "" } : "");
      else list.splice(Number(el.dataset.i), 1);
      const box = container.querySelector(`[data-role="list-${key}"]`);
      if (box) render(box, listHtml(key, list, canEdit));
      if (act === "list-add") box?.querySelector(`[data-row="${list.length - 1}"] input:not([type="color"]):not([type="time"])`)?.focus();
      dirty();
      return;
    }
    if (act === "faq-add" || act === "faq-remove") {
      const list = faqTyped();
      if (act === "faq-add") list.push({ q: "", a: "" });
      else list.splice(Number(el.dataset.i), 1);
      drawFaq(list);
      if (act === "faq-add") container.querySelector(`#ws-faqQ${list.length - 1}`)?.focus();
      dirty();
      return;
    }
    if (act === "copy-wedding-link") {
      const ok = await copyText(`${origin()}/w/${state.setup.weddingSlug}`);
      const box = container.querySelector('[data-role="copied"]');
      if (box) box.textContent = ok ? "Copied ✓" : "Couldn't copy: select the link above";
      if (ok) toast("Copied ✓ Wedding link", "success");
      return;
    }
    if (act === "preview" || act === "preview-draft") {
      // What a guest sees: the same loader as a guest's link (the server:
      // live or draft design, the saved photos, the entourage) and the same
      // invitation contract (invitationData), with the details on screen now
      // (not yet saved too) and a sample guest. data-id: a design's own
      // Preview button in the picker.
      const now = form() ? readSetupForm(form(), state.setup || {}) : {};
      const w = { ...(state.setup || {}), ...now, ...(el.dataset.id ? { templateId: el.dataset.id } : {}) };
      const custom = state.invitation?.level === "custom";
      let look;
      try {
        look = await api("wedding-setup", { method: "POST", body: { action: "preview", which: act === "preview-draft" ? "draft" : "live", ...(custom ? {} : { templateId: w.templateId || DEFAULT_TEMPLATE_ID }) } });
      } catch (err) {
        // Offline: the template on screen and the photos already loaded here.
        toast(err.message || "Couldn't load the design", "danger");
        look = { design: custom ? null : standardPreviewDesign(w.templateId), gallery: state.gallery.map((g) => g.dataUrl), photos: state.photos };
      }
      const tz = session.business?.timezone || "Asia/Manila";
      const invitation = invitationData({ setup: w, hero: state.hero, guest: OWNER_SAMPLE_GUEST, rsvpOpen: rsvpOpen(w, businessDate(tz)), look, sample: true, timezone: tz });
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) });
      const name = el.dataset.id ? getTemplateEntry(el.dataset.id).name : null;
      await preview({ token: "P".repeat(32), fetchImpl, note: act === "preview-draft" ? "Draft design (not live yet), with a sample guest" : name ? `Preview: ${name} with your details (a sample guest)` : "Preview: what your guests see (with a sample guest)" });
      return;
    }
    if (act === "gallery-remove") {
      try {
        await api("wedding-setup", { method: "POST", body: { action: "galleryRemove", photoId: el.dataset.id } });
        await reloadGallery();
      } catch (err) {
        toast(err.message || "Couldn't remove the photo.", "danger");
      }
      return;
    }
    if (act === "photo-remove") {
      const slot = el.dataset.slot;
      try {
        await api("wedding-setup", { method: "POST", body: { action: "photo", slot, dataUrl: null } });
        const { [slot]: _gone, ...rest } = state.photos;
        state.photos = rest;
        drawPhotos();
      } catch (err) {
        toast(err.message || "Couldn't remove the photo.", "danger");
      }
      return;
    }
    if (act !== "hero-remove") return;
    try {
      await api("wedding-setup", { method: "POST", body: { action: "hero", dataUrl: null } });
      state.hasHero = false;
      state.hero = null;
      toast("Cover photo removed.", "success");
      drawHero();
      drawPhotos();
    } catch (err) {
      toast(err.message || "Couldn't remove the photo.", "danger");
    }
  };
  container.addEventListener("submit", onSubmit);
  container.addEventListener("input", onInput);
  container.addEventListener("change", onChange);
  container.addEventListener("click", onClick);
  draw();
  load();
  return () => {
    alive = false;
    container.removeEventListener("submit", onSubmit);
    container.removeEventListener("input", onInput);
    container.removeEventListener("change", onChange);
    container.removeEventListener("click", onClick);
  };
}
