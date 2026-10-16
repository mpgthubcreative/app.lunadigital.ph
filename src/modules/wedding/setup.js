// Wedding Setup (Owner-pilot Bridal; More → Wedding Setup): what the guests'
// invitation shows and how RSVPs work. Controlled fields, one theme, no page
// builder. Saved through /api/wedding-setup (guests.manage edits; others
// read). Guests' links are made from Guests → ⋯.

import { html, render } from "../../lib/html.js";
import { pageHeader, skeleton } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";

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

export function mount(container, session, { api = defaultApi, toast = defaultToast } = {}) {
  const canEdit = session.member.permissions["guests.manage"] === true;
  const state = { setup: null, hasHero: false, error: null };
  let alive = true;
  const field = (name, label, placeholder, value, type = "text") =>
    html`<div class="field"><label for="ws-${name}">${label}</label><input class="input" id="ws-${name}" name="${name}" type="${type}" value="${value ?? ""}" ${placeholder ? html`placeholder="${placeholder}"` : ""} ${canEdit ? "" : "disabled"}></div>`;

  function draw() {
    if (!alive) return;
    const s = state.setup;
    render(
      container,
      html`
        ${pageHeader({ title: "Wedding Setup" })}
        ${state.error
          ? html`<p class="form-error">${state.error}</p>`
          : !s
            ? skeleton(6)
            : html`<form class="wl-form" data-role="setup">
                ${field("coupleNames", "Couple names", "e.g. Camille & Carlo", s.coupleNames)}
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
                <fieldset class="wl-fieldset"><legend>Cover photo</legend>
                  <p class="stat-hint" data-role="hero-state">${state.hasHero ? "A photo is set." : "No photo: the invitation shows a soft colour instead."}</p>
                  ${canEdit ? html`<input class="input" type="file" accept="image/jpeg,image/png,image/webp" data-role="hero" aria-label="Cover photo">${state.hasHero ? html` <button type="button" class="btn btn-ghost" data-act="hero-remove">Remove photo</button>` : ""}` : ""}
                </fieldset>
                ${canEdit ? html`<div class="page-actions"><button type="submit" class="btn btn-primary">Save</button></div>` : ""}
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
    const f = event.target.elements;
    const setup = {};
    for (const n of ["coupleNames", "ceremonyVenue", "ceremonyAddress", "receptionVenue", "receptionAddress", "dressCode", "welcomeMessage"]) setup[n] = f[n].value.trim() || null;
    for (const n of ["weddingDate", "rsvpDeadline", "ceremonyTime", "receptionTime", "ceremonyMap", "receptionMap"]) setup[n] = f[n].value.trim() || null;
    setup.rsvpEnabled = f.rsvpEnabled.checked;
    setup.closeAfterDeadline = f.closeAfterDeadline.checked;
    try {
      await api("wedding-setup", { method: "POST", body: { action: "save", setup } });
      state.setup = { ...state.setup, ...setup };
      toast("Wedding setup saved.", "success");
    } catch (err) {
      toast(err.message || "Couldn't save.", "danger");
    }
  };
  const onChange = async (event) => {
    if (event.target.dataset?.role !== "hero") return;
    try {
      const dataUrl = await shrinkPhoto(event.target.files[0]);
      await api("wedding-setup", { method: "POST", body: { action: "hero", dataUrl } });
      state.hasHero = true;
      toast("Cover photo saved.", "success");
      draw();
    } catch (err) {
      toast(err.message || "Couldn't save the photo.", "danger");
    }
  };
  const onClick = async (event) => {
    if (!event.target.closest('[data-act="hero-remove"]')) return;
    await api("wedding-setup", { method: "POST", body: { action: "hero", dataUrl: null } });
    state.hasHero = false;
    draw();
  };
  container.addEventListener("submit", onSubmit);
  container.addEventListener("change", onChange);
  container.addEventListener("click", onClick);
  draw();
  load();
  return () => {
    alive = false;
    container.removeEventListener("submit", onSubmit);
    container.removeEventListener("change", onChange);
    container.removeEventListener("click", onClick);
  };
}
