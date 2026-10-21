// Wedding Setup (Owner-pilot Bridal; More → Wedding Setup): what the guests'
// invitation shows and how RSVPs work. Controlled fields, one theme, no page
// builder. Saved through /api/wedding-setup (guests.manage edits; others
// read). Guests' links are made from Guests → ⋯.
//
// Owner-pilot fix: what's typed is kept as a draft, so a redraw never wipes
// it (choosing a cover photo used to redraw the form from the last SAVED
// values, so Save then stored blanks). Save shows Saving… / Saved ✓ (from
// the values the server read back) / a clear error.
//
// 2026-10-21: Luna Bridal chooses its Standard template here (Luna Standard,
// Classic, Modern, Romantic, Editorial: src/modules/wedding/invitation/
// templates/); Preview shows it. During the free trial the couple
// previews; guest links open once Luna Bridal is paid.

import { html, render } from "../../lib/html.js";
import { photoDataUrl, PHOTO_ACCEPT } from "../../lib/image.js";
import { pageHeader, skeleton } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { isWeddingSlug, suggestWeddingSlug, rsvpOpen, businessDate, MAX_FAQ } from "@shared/index.js";
import { openInvitePreview, copyText } from "./invitation/preview.js";
import { TEMPLATES, STANDARD_TEMPLATE_IDS, DEFAULT_TEMPLATE_ID, resolveDesign, invitationData } from "@shared/invitation-design.js";

// The guest the Owner's Preview shows (never a real guest or link).
const OWNER_SAMPLE_GUEST = Object.freeze({ name: "Your guest's name", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [] });
export const TRIAL_PREVIEW_MESSAGE = "Preview your invitation during your free trial. Publish it when you continue with Luna Bridal.";
// The chosen Standard template as a design (Luna Standard: the original page).
export const standardPreviewDesign = (templateId) => (STANDARD_TEMPLATE_IDS.includes(templateId) && templateId !== DEFAULT_TEMPLATE_ID ? { config: resolveDesign({ templateId }), assets: {}, standard: true } : null);

const TEXT = [
  ["coupleNames", "Couple names", "e.g. Camille & Carlo"],
  ["ceremonyVenue", "Ceremony venue", ""],
  ["ceremonyAddress", "Ceremony address / city", ""],
  ["ceremonyMap", "Ceremony map link (https://…)", ""],
  ["receptionVenue", "Reception venue", ""],
  ["receptionAddress", "Reception address / city", ""],
  ["receptionMap", "Reception map link (https://…)", ""],
  ["dressCode", "Dress code", "e.g. Formal"],
];
const VALUE_FIELDS = ["coupleNames", "ceremonyVenue", "ceremonyAddress", "receptionVenue", "receptionAddress", "dressCode", "welcomeMessage", "weddingDate", "rsvpDeadline", "ceremonyTime", "receptionTime", "ceremonyMap", "receptionMap", "weddingSlug"];
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

// Frequently Asked Questions (2026-10-21): what the guests' invitation shows
// in its FAQ section. Optional: none by default, + Add FAQ adds one at a
// time (up to MAX_FAQ); a pair missing its question or answer is skipped.
// Stored as before: setup.faq = [{ q, a }].
export const FAQ_EXAMPLE = Object.freeze({ q: "e.g. What time should we arrive?", a: "e.g. Please arrive 30 minutes before the ceremony." });
const faqItem = (i, f, canEdit) => html`<fieldset class="ws-faq" data-faq="${i}"><legend>FAQ ${i + 1}</legend>
    <div class="field"><label for="ws-faqQ${i}">Question</label><input class="input" id="ws-faqQ${i}" name="faqQ${i}" placeholder="${FAQ_EXAMPLE.q}" maxlength="150" value="${f?.q ?? ""}" ${canEdit ? "" : "disabled"}></div>
    <div class="field"><label for="ws-faqA${i}">Answer</label><textarea class="input" id="ws-faqA${i}" name="faqA${i}" rows="2" placeholder="${FAQ_EXAMPLE.a}" maxlength="500" ${canEdit ? "" : "disabled"}>${f?.a ?? ""}</textarea></div>
    ${canEdit ? html`<button type="button" class="btn btn-compact btn-ghost ws-faq-remove" data-act="faq-remove" data-i="${i}" aria-label="Remove FAQ ${i + 1}">Remove</button>` : ""}
  </fieldset>`;
export const faqListHtml = (list, canEdit) => html`${list.map((f, i) => faqItem(i, f, canEdit))}${canEdit && list.length < MAX_FAQ ? html`<button type="button" class="btn btn-compact" data-act="faq-add">+ Add FAQ</button>` : ""}`;

// The form's values, as the API takes them (blank = null).
export function readSetupForm(form) {
  const f = form.elements;
  const setup = {};
  for (const n of VALUE_FIELDS) setup[n] = f[n].value.trim() || null;
  // Luna Bridal+ content (only on the form when the plan includes it).
  for (const n of ["story", "footerNote"]) if (f[n]) setup[n] = f[n].value.trim() || null;
  if (f.faqOn || f.faqQ0) {
    const faq = [];
    for (let i = 0; i < 8 && f[`faqQ${i}`]; i++) {
      const q = f[`faqQ${i}`].value.trim();
      const a = f[`faqA${i}`].value.trim();
      if (q && a) faq.push({ q, a });
    }
    setup.faq = faq;
  }
  if (setup.weddingSlug) setup.weddingSlug = cleanSlugInput(setup.weddingSlug).replace(/^-+|-+$/g, "") || null;
  if (f.templateId) setup.templateId = f.templateId.value || null;
  setup.rsvpEnabled = f.rsvpEnabled.checked;
  setup.closeAfterDeadline = f.closeAfterDeadline.checked;
  return setup;
}

export function mount(container, session, { api = defaultApi, toast = defaultToast, shrink = shrinkPhoto, preview = openInvitePreview } = {}) {
  const canEdit = session.member.permissions["guests.manage"] === true;
  const state = { setup: null, draft: null, hasHero: false, hero: null, gallery: [], invitation: null, error: null, saving: false, status: null };
  let alive = true;
  const field = (name, label, placeholder, value, type = "text") =>
    html`<div class="field"><label for="ws-${name}">${label}</label><input class="input" id="ws-${name}" name="${name}" type="${type}" value="${value ?? ""}" ${placeholder ? html`placeholder="${placeholder}"` : ""} ${canEdit ? "" : "disabled"}></div>`;
  // Only a form this screen drew (opening Wedding Setup again replaces the
  // old screen: its form isn't this one's draft).
  let drawn = false;
  const form = () => (drawn ? container.querySelector('[data-role="setup"]') : null);
  // "Wedding link / hashtag": the friendly part of every guest's link
  // (/w/{slug}/invite/{private code}). Blank = made from the couple's names.
  const host = () => globalThis.location?.host || "app.lunadigital.ph";
  const slugPreview = (slug, names) => `Guests' links look like ${host()}/w/${slug || suggestWeddingSlug(names) || "your-names-wedding"}/invite/… (the private part after /invite/ is different for each guest).`;
  const slugField = (s) =>
    html`<div class="field"><label for="ws-weddingSlug">Wedding link / hashtag</label><input class="input" id="ws-weddingSlug" name="weddingSlug" type="text" autocapitalize="none" autocomplete="off" spellcheck="false" maxlength="60" value="${s.weddingSlug ?? ""}" placeholder="${suggestWeddingSlug(s.coupleNames) || "e.g. carlo-and-yanie-wedding"}" aria-describedby="ws-slug-hint" ${canEdit ? "" : "disabled"}><p class="stat-hint" id="ws-slug-hint" data-role="slug-preview">${slugPreview(s.weddingSlug, s.coupleNames)}</p><p class="stat-hint">Lowercase letters, numbers and hyphens, e.g. carloyanieforever. Leave blank to use the suggestion. Change it before sharing; links already sent keep working.</p></div>`;
  // Wedding Setup → Invitation: Standard (Luna Bridal) or Customized (Luna
  // Bridal+) with its state. The design itself is Luna's (Super Admin);
  // the couple edits content only, so an approved design can't be broken.
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
    const faq = Array.isArray(s.faq) ? s.faq : [];
    const trial = session.subscription?.trial?.open === true;
    const chosen = STANDARD_TEMPLATE_IDS.includes(s.templateId) ? s.templateId : DEFAULT_TEMPLATE_ID;
    const picker = custom
      ? ""
      : html`<div class="field" data-role="template-choice"><span class="field-label">Template</span>
          <div class="tpl-options">${STANDARD_TEMPLATE_IDS.map((id) => html`<label class="tpl-option"><input type="radio" name="templateId" value="${id}" ${id === chosen ? "checked" : ""} ${canEdit ? "" : "disabled"}><span class="tpl-swatch" data-template="${id}" aria-hidden="true"></span><span class="tpl-text"><strong>${TEMPLATES[id].label}</strong><span class="stat-hint">${TEMPLATES[id].description}</span></span></label>`)}</div>
          <p class="stat-hint">Save, then Preview to see it with your details. You can change it any time; links already sent keep working.</p></div>`;
    return html`<fieldset class="wl-fieldset" data-role="invitation-level"><legend>Invitation</legend>
      ${trial ? html`<div class="banner banner-info" role="note" data-role="trial-preview">${TRIAL_PREVIEW_MESSAGE}</div>` : ""}
      <p><strong data-role="invitation-name">${custom ? "Customized Invitation" : "Standard Invitation"}</strong> <span class="stat-hint">${custom ? "Luna Bridal Custom" : "Included with Luna Bridal"}</span>${custom ? html` <span class="wl-chip" data-role="invitation-state" data-tone="${inv.live === "custom" ? "success" : "warning"}">${inv.live === "custom" ? "Live" : inv.draftState === "ready" ? "Ready" : "Draft"}</span>` : ""}</p>
      <p class="stat-hint" data-role="invitation-line">${stateLine}</p>
      ${picker}
      <div class="ws-link-actions"><button type="button" class="btn btn-compact" data-act="preview">Preview${custom && inv.live !== "custom" ? " (live: Standard)" : ""}</button>${custom && inv.hasDraft ? html`<button type="button" class="btn btn-compact" data-act="preview-draft">Preview draft design</button>` : ""}</div>
      ${custom ? html`<details class="wl-fold" data-role="plus-content"><summary>More for your customized invitation</summary>
        <div class="field"><label for="ws-story">Our story</label><textarea class="input" id="ws-story" name="story" rows="4" maxlength="1500" ${canEdit ? "" : "disabled"}>${s.story ?? ""}</textarea></div>
        ${faqSection(faq)}
        <div class="field"><label for="ws-footerNote">Closing line</label><input class="input" id="ws-footerNote" name="footerNote" maxlength="200" value="${s.footerNote ?? ""}" placeholder="e.g. With love, Carlo & Yanie" ${canEdit ? "" : "disabled"}></div>
        <p class="stat-hint">Gallery photos (up to 6)</p>
        <div class="ws-gallery" data-role="gallery">${state.gallery.map((g) => html`<figure class="ws-gallery-item"><img src="${g.dataUrl}" alt="Gallery photo">${canEdit ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="gallery-remove" data-id="${g.id}" aria-label="Remove this photo">Remove</button>` : ""}</figure>`)}</div>
        ${canEdit && state.gallery.length < 6 ? html`<label class="btn btn-compact">Add photo<input class="visually-hidden" type="file" accept="${PHOTO_ACCEPT}" data-role="gallery-add" aria-label="Add a gallery photo"></label>` : ""}
        <p class="stat-hint">Luna shows these where your design has a Story, FAQ, Gallery or Footer section. The design itself is set up by Luna.</p>
      </details>` : ""}
    </fieldset>`;
  };
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
  const syncSlug = () => {
    const f = form();
    if (!f) return;
    f.elements.weddingSlug.placeholder = suggestWeddingSlug(f.elements.coupleNames.value) || "e.g. carlo-and-yanie-wedding";
    const box = container.querySelector('[data-role="slug-preview"]');
    if (box) box.textContent = slugPreview(cleanSlugInput(f.elements.weddingSlug.value).replace(/^-+|-+$/g, ""), f.elements.coupleNames.value);
  };
  // Next to Save: Saving… / Saved ✓ / Not saved yet / the error.
  const statusLine = () => {
    const st = state.status;
    if (!st) return "";
    return st.state === "error"
      ? html`<p class="form-error" role="alert" data-role="save-state" data-state="error">${st.text}</p>`
      : html`<p class="save-state" role="status" data-role="save-state" data-state="${st.state}">${st.text}</p>`;
  };
  // The current photo is shown (a browser file box always says "No file
  // chosen" after a reload, which looked like the photo was lost).
  const heroBox = () =>
    html`${state.hero ? html`<img class="ws-hero-thumb" src="${state.hero}" alt="Current cover photo" data-role="hero-preview">` : ""}
      <p class="stat-hint" data-role="hero-state">${state.hasHero ? "A photo is set." : "No photo: the invitation shows a soft colour instead."}</p>
      ${canEdit ? html`<div class="ws-hero-actions"><label class="btn btn-compact">${state.hasHero ? "Change photo" : "Choose photo"}<input class="visually-hidden" type="file" accept="${PHOTO_ACCEPT}" data-role="hero" aria-label="Cover photo"></label>${state.hasHero ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="hero-remove">Remove photo</button>` : ""}</div>` : ""}`;
  // Partial redraws: the photo part, and the Save button + status.
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

  // The FAQ section of the form, kept as typed while FAQs are added / removed.
  const faqSection = (faq) => html`<section class="ws-faq-section" data-role="faq"><input type="hidden" name="faqOn" value="1">
      <h4 class="ws-sub-title">Frequently Asked Questions</h4>
      <p class="stat-hint">Add helpful information for your guests (optional).</p>
      <div data-role="faq-list">${faqListHtml(faq, canEdit)}</div>
    </section>`;
  const faqTyped = () => [...container.querySelectorAll('[data-role="faq-list"] .ws-faq')].map((fs) => ({ q: fs.querySelector("input").value, a: fs.querySelector("textarea").value }));
  const drawFaq = (list) => {
    const box = container.querySelector('[data-role="faq-list"]');
    if (box) render(box, faqListHtml(list, canEdit));
  };

  function draw() {
    if (!alive) return;
    // Whatever is typed survives a redraw. The draft holds only the fields
    // on the form; the rest (e.g. Luna Bridal Custom's Story / FAQ / closing
    // line before the plan is known) stay as saved, never blanked.
    if (form() && canEdit) state.draft = readSetupForm(form());
    const s = state.draft ? { ...(state.setup || {}), ...state.draft } : state.setup;
    render(
      container,
      html`
        ${pageHeader({ title: "Wedding Setup" })}
        ${state.error
          ? html`<p class="form-error">${state.error}</p>`
          : !s
            ? skeleton(6)
            : html`<form class="wl-form" data-role="setup" novalidate>
                <p class="stat-hint">What your guests see on their invitation. After saving, make each guest's link from Guests → ⋯ → Create invitation link.</p>
                ${field("coupleNames", "Couple names", "e.g. Camille & Carlo", s.coupleNames)}
                ${slugField(s)}
                ${linkBox()}
                ${field("weddingDate", "Wedding date", "", s.weddingDate, "date")}
                <fieldset class="wl-fieldset"><legend>Ceremony</legend>${field("ceremonyTime", "Time", "", s.ceremonyTime, "time")}${TEXT.slice(1, 4).map(([n, l, p]) => field(n, l.replace("Ceremony ", "").replace(/^./, (c) => c.toUpperCase()), p, s[n], n.endsWith("Map") ? "url" : "text"))}</fieldset>
                <fieldset class="wl-fieldset"><legend>Reception</legend>${field("receptionTime", "Time", "", s.receptionTime, "time")}${TEXT.slice(4, 7).map(([n, l, p]) => field(n, l.replace("Reception ", "").replace(/^./, (c) => c.toUpperCase()), p, s[n], n.endsWith("Map") ? "url" : "text"))}</fieldset>
                ${field("dressCode", "Dress code", "e.g. Formal", s.dressCode)}
                <div class="field"><label for="ws-welcomeMessage">Welcome message</label><textarea class="input" id="ws-welcomeMessage" name="welcomeMessage" rows="3" maxlength="600" ${canEdit ? "" : "disabled"}>${s.welcomeMessage ?? ""}</textarea></div>
                <fieldset class="wl-fieldset"><legend>RSVP</legend>
                  <label class="wl-check"><input type="checkbox" name="rsvpEnabled" ${s.rsvpEnabled ? "checked" : ""} ${canEdit ? "" : "disabled"}> Guests can RSVP from their invitation</label>
                  ${field("rsvpDeadline", "RSVP deadline", "", s.rsvpDeadline, "date")}
                  <label class="wl-check"><input type="checkbox" name="closeAfterDeadline" ${s.closeAfterDeadline === false ? "" : "checked"} ${canEdit ? "" : "disabled"}> Close guest RSVPs after the deadline (you can still change RSVPs in Luna)</label>
                </fieldset>
                <fieldset class="wl-fieldset"><legend>Cover photo</legend><div data-role="hero-box">${heroBox()}</div></fieldset>
                ${invitationBox(s)}
                ${canEdit ? html`<div class="page-actions"><button type="submit" class="btn btn-primary" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save"}</button></div><div data-role="save-box">${statusLine()}</div>` : ""}
              </form>`}`
    );
    drawn = true;
  }

  async function load() {
    try {
      const r = await api("wedding-setup", { method: "POST", body: { action: "get" } });
      state.setup = r.setup || {};
      state.hasHero = Boolean(r.hasHero);
      state.hero = typeof r.hero === "string" && r.hero.startsWith("data:image/") ? r.hero : null;
      state.gallery = Array.isArray(r.gallery) ? r.gallery.filter((g) => typeof g.dataUrl === "string" && g.dataUrl.startsWith("data:image/")) : [];
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
    const setup = readSetupForm(event.target);
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
    if (!event.target.closest('[data-role="setup"]') || event.target.dataset?.role === "hero" || event.target.dataset?.role === "gallery-add" || state.saving) return;
    if (event.target.name === "weddingSlug") {
      const clean = cleanSlugInput(event.target.value);
      if (clean !== event.target.value) event.target.value = clean;
    }
    if (event.target.name === "weddingSlug" || event.target.name === "coupleNames") syncSlug();
    if (state.status?.state !== "dirty") {
      state.status = { state: "dirty", text: "Not saved yet: press Save to keep these changes." };
      drawStatus();
    }
  };
  async function reloadGallery() {
    const r = await api("wedding-setup", { method: "POST", body: { action: "get" } });
    state.gallery = Array.isArray(r.gallery) ? r.gallery.filter((g) => typeof g.dataUrl === "string" && g.dataUrl.startsWith("data:image/")) : [];
    const box = container.querySelector('[data-role="invitation-level"]');
    const open = container.querySelector('[data-role="plus-content"]')?.open;
    if (box) {
      state.draft = readSetupForm(form());
      const holder = document.createElement("div");
      render(holder, invitationBox(state.draft));
      box.replaceWith(holder.firstElementChild);
      if (open) container.querySelector('[data-role="plus-content"]')?.setAttribute("open", "");
    }
  }
  const onChange = async (event) => {
    if (event.target.dataset?.role === "gallery-add") {
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
    if (event.target.dataset?.role !== "hero") return;
    try {
      const dataUrl = await shrink(event.target.files[0]);
      await api("wedding-setup", { method: "POST", body: { action: "hero", dataUrl } });
      state.hasHero = true;
      state.hero = dataUrl;
      toast("Cover photo saved.", "success");
      drawHero(); // only the photo part: the typed details stay as they are
    } catch (err) {
      toast(err.message || "Couldn't save the photo.", "danger");
    }
  };
  const onClick = async (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "faq-add" || act === "faq-remove") {
      const list = faqTyped();
      if (act === "faq-add") list.push({ q: "", a: "" });
      else list.splice(Number(event.target.closest("[data-act]").dataset.i), 1);
      drawFaq(list);
      if (act === "faq-add") container.querySelector(`#ws-faqQ${list.length - 1}`)?.focus();
      if (state.status?.state !== "dirty") {
        state.status = { state: "dirty", text: "Not saved yet: press Save to keep these changes." };
        drawStatus();
      }
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
      // (not yet saved too) and a sample guest.
      const now = form() ? readSetupForm(form()) : {};
      const w = { ...(state.setup || {}), ...now };
      const custom = state.invitation?.level === "custom";
      let look;
      try {
        look = await api("wedding-setup", { method: "POST", body: { action: "preview", which: act === "preview-draft" ? "draft" : "live", ...(custom ? {} : { templateId: w.templateId || DEFAULT_TEMPLATE_ID }) } });
      } catch (err) {
        // Offline: the template on screen and the photos already loaded here.
        toast(err.message || "Couldn't load the design", "danger");
        look = { design: custom ? null : standardPreviewDesign(w.templateId), gallery: state.gallery.map((g) => g.dataUrl) };
      }
      const invitation = invitationData({ setup: w, hero: state.hero, guest: OWNER_SAMPLE_GUEST, rsvpOpen: rsvpOpen(w, businessDate(session.business?.timezone || "Asia/Manila")), look, sample: true });
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) });
      await preview({ token: "P".repeat(32), fetchImpl, note: act === "preview-draft" ? "Draft design (not live yet), with a sample guest" : "Preview: what your guests see (with a sample guest)" });
      return;
    }
    if (act === "gallery-remove") {
      try {
        await api("wedding-setup", { method: "POST", body: { action: "galleryRemove", photoId: event.target.closest("[data-act]").dataset.id } });
        await reloadGallery();
      } catch (err) {
        toast(err.message || "Couldn't remove the photo.", "danger");
      }
      return;
    }
    if (!event.target.closest('[data-act="hero-remove"]')) return;
    try {
      await api("wedding-setup", { method: "POST", body: { action: "hero", dataUrl: null } });
      state.hasHero = false;
      state.hero = null;
      toast("Cover photo removed.", "success");
      drawHero();
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
