// Wedding Setup (Owner-pilot Bridal; More → Wedding Setup): what the guests'
// invitation shows and how RSVPs work. Controlled fields, one theme, no page
// builder. Saved through /api/wedding-setup (guests.manage edits; others
// read). Guests' links are made from Guests → ⋯.
//
// Owner-pilot fix: what's typed is kept as a draft, so a redraw never wipes
// it (choosing a cover photo used to redraw the form from the last SAVED
// values, so Save then stored blanks). Save shows Saving… / Saved ✓ (from
// the values the server read back) / a clear error.

import { html, render } from "../../lib/html.js";
import { pageHeader, skeleton } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { isWeddingSlug, suggestWeddingSlug } from "@shared/index.js";

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

// A photo shrunk in the browser to a small JPEG data URL (≤ 1200 px).
export async function shrinkPhoto(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Choose a JPEG, PNG or WebP photo");
  const url = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("Couldn't read the photo"));
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Couldn't open the photo"));
    i.src = url;
  });
  const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}

// The form's values, as the API takes them (blank = null).
export function readSetupForm(form) {
  const f = form.elements;
  const setup = {};
  for (const n of VALUE_FIELDS) setup[n] = f[n].value.trim() || null;
  if (setup.weddingSlug) setup.weddingSlug = cleanSlugInput(setup.weddingSlug).replace(/^-+|-+$/g, "") || null;
  setup.rsvpEnabled = f.rsvpEnabled.checked;
  setup.closeAfterDeadline = f.closeAfterDeadline.checked;
  return setup;
}

export function mount(container, session, { api = defaultApi, toast = defaultToast, shrink = shrinkPhoto } = {}) {
  const canEdit = session.member.permissions["guests.manage"] === true;
  const state = { setup: null, draft: null, hasHero: false, error: null, saving: false, status: null };
  let alive = true;
  const field = (name, label, placeholder, value, type = "text") =>
    html`<div class="field"><label for="ws-${name}">${label}</label><input class="input" id="ws-${name}" name="${name}" type="${type}" value="${value ?? ""}" ${placeholder ? html`placeholder="${placeholder}"` : ""} ${canEdit ? "" : "disabled"}></div>`;
  const form = () => container.querySelector('[data-role="setup"]');
  // "Wedding link / hashtag": the friendly part of every guest's link
  // (/w/{slug}/invite/{private code}). Blank = made from the couple's names.
  const host = () => globalThis.location?.host || "app.lunadigital.ph";
  const slugPreview = (slug, names) => `Guests' links look like ${host()}/w/${slug || suggestWeddingSlug(names) || "your-names-wedding"}/invite/… (the private part after /invite/ is different for each guest).`;
  const slugField = (s) =>
    html`<div class="field"><label for="ws-weddingSlug">Wedding link / hashtag</label><input class="input" id="ws-weddingSlug" name="weddingSlug" type="text" autocapitalize="none" autocomplete="off" spellcheck="false" maxlength="60" value="${s.weddingSlug ?? ""}" placeholder="${suggestWeddingSlug(s.coupleNames) || "e.g. carlo-and-yanie-wedding"}" aria-describedby="ws-slug-hint" ${canEdit ? "" : "disabled"}><p class="stat-hint" id="ws-slug-hint" data-role="slug-preview">${slugPreview(s.weddingSlug, s.coupleNames)}</p><p class="stat-hint">Lowercase letters, numbers and hyphens, e.g. carloyanieforever. Leave blank to use the suggestion. Change it before sharing; links already sent keep working.</p></div>`;
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
  const heroBox = () =>
    html`<p class="stat-hint" data-role="hero-state">${state.hasHero ? "A photo is set." : "No photo: the invitation shows a soft colour instead."}</p>
      ${canEdit ? html`<input class="input" type="file" accept="image/jpeg,image/png,image/webp" data-role="hero" aria-label="Cover photo">${state.hasHero ? html` <button type="button" class="btn btn-ghost" data-act="hero-remove">Remove photo</button>` : ""}` : ""}`;
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

  function draw() {
    if (!alive) return;
    // Whatever is typed survives a redraw.
    if (form() && canEdit) state.draft = readSetupForm(form());
    const s = state.draft || state.setup;
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
                ${canEdit ? html`<div class="page-actions"><button type="submit" class="btn btn-primary" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save"}</button></div><div data-role="save-box">${statusLine()}</div>` : ""}
              </form>`}`
    );
  }

  async function load() {
    try {
      const r = await api("wedding-setup", { method: "POST", body: { action: "get" } });
      state.setup = r.setup || {};
      state.hasHero = Boolean(r.hasHero);
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
    if (!event.target.closest('[data-role="setup"]') || event.target.dataset?.role === "hero" || state.saving) return;
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
  const onChange = async (event) => {
    if (event.target.dataset?.role !== "hero") return;
    try {
      const dataUrl = await shrink(event.target.files[0]);
      await api("wedding-setup", { method: "POST", body: { action: "hero", dataUrl } });
      state.hasHero = true;
      toast("Cover photo saved.", "success");
      drawHero(); // only the photo part: the typed details stay as they are
    } catch (err) {
      toast(err.message || "Couldn't save the photo.", "danger");
    }
  };
  const onClick = async (event) => {
    if (!event.target.closest('[data-act="hero-remove"]')) return;
    try {
      await api("wedding-setup", { method: "POST", body: { action: "hero", dataUrl: null } });
      state.hasHero = false;
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
