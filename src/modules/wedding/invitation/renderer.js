// Public wedding invitation (Owner-pilot Bridal): /w/{weddingSlug}/invite/{token}
// (or the older /invite/{token}). No login:
// the guest opens the personal link the couple sent, sees the invitation for
// THEIR party (name and seats already known) and answers Accept / Decline.
// The token is posted to /api/invite, which updates the same Bridal guest
// record. One elegant theme; every word of the wedding comes from the
// couple's Wedding Setup (nothing about a couple is built in).

import { html, render } from "../../../lib/html.js";
import { fontsOf, FONTS, TEMPLATES } from "@shared/invitation-design.js";
import { signaturePage, namesOf, zonedEpoch, countdown } from "./signature.js";

// A published Luna Bridal+ design: colours / fonts as CSS variables (set
// through the CSSOM: the site's policy blocks inline style attributes),
// layout choices as data-* attributes. Values were validated by the server
// (hex colours, allow-listed fonts, enums, base64 image data URLs).
const WIDTH = { narrow: "460px", normal: "560px", wide: "760px" };
const PAD = { compact: ["28px 18px", "18px", "18px"], normal: ["40px 24px", "24px", "24px"], airy: ["56px 32px", "32px", "36px"] };
const RADIUS = { square: "2px", soft: "8px", round: "18px" };
const BTN_RADIUS = { pill: "999px", outline: "999px", solid: "6px", square: "0" };
const HEX = /^#[0-9a-fA-F]{6}$/;
const IMG = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const fontStack = (f) => (FONTS.includes(f) ? `"${f}", Georgia, "Times New Roman", serif` : null);
export function applyDesign(page, design) {
  const d = design.config;
  const set = (k, v) => v && page.style.setProperty(k, v);
  const t = d.theme;
  for (const [k, v] of Object.entries({ "--inv-bg": t.background, "--inv-card-bg": t.card, "--inv-text": t.text, "--inv-muted": t.muted, "--inv-accent": t.accent, "--inv-accent-text": t.accentText, "--inv-border": t.border })) if (HEX.test(v || "")) set(k, v);
  set("--inv-heading-font", fontStack(t.headingFont));
  set("--inv-body-font", fontStack(t.bodyFont));
  set("--inv-script-font", fontStack(t.scriptFont));
  set("--inv-card-width", WIDTH[d.layout.cardWidth]);
  const pad = PAD[d.layout.spacing] || PAD.normal;
  set("--inv-pad", pad[0]);
  set("--inv-pad-x", pad[1]);
  set("--inv-gap", pad[2]);
  set("--inv-align", d.layout.align === "left" ? "left" : "center");
  set("--inv-radius", RADIUS[d.layout.corners]);
  set("--inv-btn-radius", BTN_RADIUS[d.layout.buttonStyle]);
  set("--inv-names-case", d.layout.namesCase === "normal" ? "none" : "uppercase");
  const img = (id) => (id && IMG.test(design.assets?.[id] || "") ? `url("${design.assets[id]}")` : null);
  set("--inv-page-image", img(d.assets.pageBackground));
  set("--inv-card-image", img(d.assets.cardBackground));
  for (const el of page.querySelectorAll("[data-section]")) {
    const st = d.sections.styles?.[el.dataset.section];
    if (!st) continue;
    if (HEX.test(st.background || "")) el.style.setProperty("--inv-section-bg", st.background);
    if (HEX.test(st.text || "")) el.style.setProperty("--inv-section-text", st.text);
    const bg = img(st.backgroundAsset);
    if (bg) el.style.setProperty("--inv-section-image", bg);
  }
  // Only the design's (allow-listed) Google fonts.
  const fams = fontsOf(d).filter((f) => f !== "Inter");
  if (fams.length) {
    const href = `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${f.replace(/ /g, "+")}`).join("&")}&display=swap`;
    if (!document.querySelector(`link[data-invite-design-font="${href}"]`)) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.dataset.inviteDesignFont = href;
      document.head.appendChild(l);
    }
  }
}

// Card section → the Owner's editable section (registry.js editableSections).
const CARD_EDIT = { hero: "hero", welcome: "welcome", story: "story", ceremony: "details", reception: "details", map: "details", dressCode: "dress", entourage: "entourage", gallery: "gallery", faq: "goodToKnow", footer: "closing" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}, ${d.slice(0, 4)}` : "");
const time12 = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const firstName = (name) => String(name || "").split(/\s+/)[0];

async function call(body, fetchImpl) {
  const res = await fetchImpl("/api/invite", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.message || "This invitation link isn't valid. Please ask the couple for a new one."), { status: res.status });
  return out;
}

// The token is the credential; the wedding slug is only the friendly part
// of the address (never sent, never trusted). A link with an old slug or no
// slug moves to the wedding's current address once the token checks out.
export const inviteTokenFrom = (path) => (/^(?:\/w\/[a-z0-9-]{1,60})?\/(?:invite|rsvp)\/([A-Za-z0-9_-]{32})\/?$/.exec(path) || [])[1] || "";

// The wedding link alone (/w/{slug}): invitations are personal, so nothing
// about the wedding is shown without a guest's private code.
export const isWeddingHomePath = (path) => /^\/w\/[a-z0-9-]{1,60}\/?$/.test(path || "");

// preview (Owner, inside Luna): the same page, but answers aren't sent and
// the tab title / address bar are left alone.
export function renderInvitePage(root, { token = inviteTokenFrom(window.location.pathname), fetchImpl = (...a) => window.fetch(...a), preview = false } = {}) {
  // companions: names typed for the party's unnamed seats (optional).
  const state = { status: "loading", inv: null, message: "", choosing: null, seats: null, meal: null, note: "", companions: [], done: null, busy: false, timer: null };
  // The party's known names and how many seats still have none (older links: none).
  const partyOf = () => {
    const p = state.inv.guest.party;
    return { named: Array.isArray(p?.named) ? p.named.filter((n) => typeof n === "string") : [], open: Number.isSafeInteger(p?.open) ? p.open : 0 };
  };
  // Name fields: the unnamed seats among the ones coming (never the guest's own).
  const companionSlots = () => Math.min(partyOf().open, Math.max(0, (state.seats || 0) - 1));
  // What Wedding Setup asks with an Accept: a meal (one of its options) and
  // a dietary note. Neither = Accept answers at once for a party of one.
  const asks = () => {
    const w = state.inv.wedding;
    return { meals: Array.isArray(w.mealOptions) ? w.mealOptions : [], note: w.askDietary === true };
  };
  const needsStep = () => state.inv.guest.seats > 1 || asks().meals.length > 0 || asks().note;
  const of = (n) => `${n} of ${state.inv.guest.seats}`;
  if (!preview) document.title = "You're invited";
  // The theme's serif (Google Fonts is allowed by the site's policy).
  if (!document.querySelector("link[data-invite-font]")) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&display=swap";
    l.dataset.inviteFont = "1";
    document.head.appendChild(l);
  }

  const venue = (label, t, name, address, map) =>
    name || t
      ? html`<div class="inv-venue"><h3>${label}</h3>${t ? html`<p class="inv-time">${time12(t)}</p>` : ""}${name ? html`<p>${name}</p>` : ""}${address ? html`<p class="inv-quiet">${address}</p>` : ""}${map ? html`<p><a href="${map}" target="_blank" rel="noopener noreferrer">View map</a></p>` : ""}</div>`
      : "";

  function rsvpBlock() {
    const { guest, rsvpOpen, wedding } = state.inv;
    if (state.done) {
      return state.done.rsvp === "attending"
        ? html`<div class="inv-done" data-role="done"><p class="inv-script">Thank you, ${firstName(guest.name)}.</p><p>We've saved your RSVP for ${state.done.confirmed} guest${state.done.confirmed === 1 ? "" : "s"}${guest.seats > 1 ? ` (${of(state.done.confirmed)} reserved seats)` : ""}.</p></div>`
        : html`<div class="inv-done" data-role="done"><p class="inv-script">Thank you for letting us know.</p><p>You'll be missed on our special day.</p></div>`;
    }
    const answered = guest.rsvp !== "awaiting" ? html`<p class="inv-quiet" data-role="current">Your answer: ${guest.rsvp === "attending" ? `Attending · ${guest.seats > 1 ? of(guest.confirmed) : guest.confirmed}` : "Not attending"}${rsvpOpen ? " (you can change it)" : ""}</p>` : "";
    if (!rsvpOpen) return html`${answered}<p class="inv-quiet" data-role="closed">RSVPs are closed. Please contact the couple for any change.</p>`;
    if (state.choosing === "attending" && needsStep()) {
      const { meals, note } = asks();
      const ready = state.seats && (!meals.length || state.meal) && !state.busy;
      return html`${guest.seats > 1 ? html`<p>How many will attend?</p>
        <div class="inv-seats" role="group" aria-label="How many will attend">${Array.from({ length: guest.seats }, (_, i) => i + 1).map((n) => html`<button type="button" class="inv-seat${state.seats === n ? " is-on" : ""}" data-seats="${n}" aria-pressed="${state.seats === n ? "true" : "false"}">${n}</button>`)}</div>
        ${partyOf().named.length ? html`<p class="inv-quiet" data-role="party-named">In your party: ${partyOf().named.join(", ")}</p>` : ""}
        ${companionSlots() ? html`<div class="inv-companions" data-role="companions"><p>Who's coming with you? <span class="inv-quiet">(optional)</span></p>${Array.from({ length: companionSlots() }, (_, i) => html`<input class="inv-note inv-companion" data-role="companion" data-i="${i}" maxlength="80" autocomplete="off" aria-label="Guest ${partyOf().named.length + i + 2} name" placeholder="Guest ${partyOf().named.length + i + 2} name" value="${state.companions[i] ?? ""}">`)}</div>` : ""}` : ""}
        ${meals.length ? html`<p>Meal preference</p><div class="inv-seats inv-meals" role="group" aria-label="Meal preference">${meals.map((m) => html`<button type="button" class="inv-seat${state.meal === m ? " is-on" : ""}" data-meal="${m}" aria-pressed="${state.meal === m ? "true" : "false"}">${m}</button>`)}</div>` : ""}
        ${note ? html`<label class="inv-note-label" for="inv-note">Dietary needs or allergies (optional)</label><textarea class="inv-note" id="inv-note" data-role="rsvp-note" rows="2" maxlength="300">${state.note}</textarea>` : ""}
        <div class="inv-actions"><button type="button" class="inv-btn" data-act="back">Back</button><button type="button" class="inv-btn inv-primary" data-act="send" ${ready ? "" : "disabled"}>Confirm RSVP</button></div>`;
    }
    return html`${answered}<p>Will you be attending?</p>
      <div class="inv-actions"><button type="button" class="inv-btn inv-primary" data-act="accept" ${state.busy ? "disabled" : ""}>Yes, I'll be there</button><button type="button" class="inv-btn" data-act="decline" ${state.busy ? "disabled" : ""}>Sorry, I can't make it</button></div>
      ${wedding.rsvpDeadline ? html`<p class="inv-quiet">RSVP before ${longDate(wedding.rsvpDeadline)}</p>` : ""}`;
  }

  // A Luna Bridal+ design: the same components, in the design's order.
  function designedPage() {
    const { wedding: w, hero, guest, design, gallery = [], entourage = [] } = state.inv;
    const d = design.config;
    const A = design.assets || {};
    const asset = (id) => (id && A[id] ? A[id] : null);
    // A Standard template: the couple's own wording lines (Wedding Setup).
    const texts = { ...(d.texts || {}), ...(design.standard ? state.inv.options?.wording || {} : {}) };
    const heroPhoto = () =>
      d.hero.style === "none" ? "" : html`<div class="inv-hero-wrap">${hero ? html`<img class="inv-hero" src="${hero}" alt="" data-slot="hero">` : html`<div class="inv-hero inv-hero-plain" aria-hidden="true" data-slot="hero"></div>`}${asset(d.assets.heroOverlay) ? html`<img class="inv-hero-frame" src="${asset(d.assets.heroOverlay)}" alt="" aria-hidden="true">` : ""}</div>`;
    const head = html`<header class="inv-head"><p class="inv-names">${w.coupleNames || ""}</p><p class="inv-script">${texts.scriptLine || "are getting married"}</p>${w.weddingDate ? html`<p class="inv-date">${longDate(w.weddingDate)}</p>` : ""}</header>`;
    const block = (id, inner) => (inner ? html`<section class="inv-section inv-sec-${id}" data-section="${id}" data-edit="${CARD_EDIT[id]}" ${d.sections.styles?.[id] ? "data-styled" : ""}>${inner}</section>` : "");
    const parts = {
      hero: () => block("hero", d.hero.style === "photo-above-names" || d.hero.style === "full-bleed" ? html`${heroPhoto()}${head}` : html`${head}${heroPhoto()}`),
      welcome: () => block("welcome", w.welcomeMessage ? html`<p class="inv-message">${w.welcomeMessage}</p>` : ""),
      story: () => block("story", w.story ? html`<h3>Our story</h3><p class="inv-story">${w.story}</p>` : ""),
      ceremony: () => block("ceremony", venue("Ceremony", w.ceremonyTime, w.ceremonyVenue, w.ceremonyAddress, w.ceremonyMap)),
      reception: () => block("reception", venue("Reception", w.receptionTime, w.receptionVenue, w.receptionAddress, w.receptionMap)),
      map: () => block("map", w.ceremonyMap || w.receptionMap ? html`<h3>Getting there</h3><p class="inv-map-links">${w.ceremonyMap ? html`<a class="inv-btn" href="${w.ceremonyMap}" target="_blank" rel="noopener noreferrer">Ceremony map</a>` : ""}${w.receptionMap ? html`<a class="inv-btn" href="${w.receptionMap}" target="_blank" rel="noopener noreferrer">Reception map</a>` : ""}</p>` : ""),
      dressCode: () => block("dressCode", w.dressCode ? html`<h3>Dress code</h3><p>${w.dressCode}</p>` : ""),
      entourage: () => block("entourage", entourage.length ? html`<h3>The entourage</h3><div class="inv-entourage">${entourage.map((g) => html`<div><p class="inv-quiet">${g.label}</p><p>${g.names.join(" · ")}</p></div>`)}</div>` : ""),
      gallery: () => block("gallery", gallery.length ? html`<div class="inv-gallery" data-style="${d.gallery.style}">${gallery.map((src) => html`<img src="${src}" alt="" loading="lazy">`)}</div>` : ""),
      faq: () => block("faq", Array.isArray(w.faq) && w.faq.length ? html`<h3>Questions</h3><dl class="inv-faq">${w.faq.map((f) => html`<dt>${f.q}</dt><dd>${f.a}</dd>`)}</dl>` : ""),
      rsvp: () => html`<section class="inv-rsvp inv-section" data-role="rsvp" data-section="rsvp" data-edit="rsvp" ${d.sections.styles?.rsvp ? "data-styled" : ""}>
            <h2>${texts.rsvpTitle || "RSVP"}</h2>
            <p class="inv-quiet">This invitation is for</p>
            <p class="inv-guest" data-role="guest-name">${guest.name}</p>
            <p class="inv-quiet" data-role="seats">${guest.seats} seat${guest.seats === 1 ? "" : "s"} reserved</p>
            ${rsvpBlock()}
            ${state.message ? html`<p class="inv-error" role="alert">${state.message}</p>` : ""}
          </section>`,
      footer: () => block("footer", html`<div class="inv-footer"><p>${w.coupleNames || ""}${w.weddingDate ? ` · ${longDate(w.weddingDate)}` : ""}</p>${w.footerNote || texts.footerLine ? html`<p>${w.footerNote || texts.footerLine}</p>` : ""}</div>`),
    };
    const shown = d.sections.order.filter((id) => d.sections.visible[id] && parts[id]);
    const divider = asset(d.assets.divider);
    const out = [];
    shown.forEach((id, i) => {
      // Ceremony + Reception side by side when they follow each other.
      if (id === "reception" && shown[i - 1] === "ceremony") return;
      if (i && divider && id !== "rsvp") out.push(html`<img class="inv-divider" src="${divider}" alt="" aria-hidden="true">`);
      if (id === "ceremony" && shown[i + 1] === "reception") out.push(html`<div class="inv-venues">${parts.ceremony()}${parts.reception()}</div>`);
      else out.push(parts[id]());
    });
    render(
      root,
      html`<main class="inv-page inv-designed" data-role="invite-page" data-template="${d.templateId}" data-frame="${d.layout.frame}" data-align="${d.layout.align}" data-hero="${d.hero.style}">
        <article class="inv-card">
          ${asset(d.assets.ornamentTop) ? html`<img class="inv-ornament" src="${asset(d.assets.ornamentTop)}" alt="" aria-hidden="true">` : ""}
          ${out}
          ${asset(d.assets.ornamentBottom) ? html`<img class="inv-ornament inv-ornament-bottom" src="${asset(d.assets.ornamentBottom)}" alt="" aria-hidden="true">` : ""}
        </article>
      </main>`
    );
    applyDesign(root.querySelector(".inv-page"), design);
  }

  // The signature layout (Gold Elegance, Black & White, Rustic Garden).
  function signature() {
    const { design, options } = state.inv;
    const d = design.config;
    const t = TEMPLATES[d.templateId] || {};
    // Template wording, a Custom design's texts, then the couple's own words.
    const W = { ...(t.wording || {}), ...(d.texts?.scriptLine ? { tagline: d.texts.scriptLine } : {}), ...(d.texts?.rsvpTitle ? { rsvpTitle: d.texts.rsvpTitle } : {}), ...(design.standard ? options?.wording || {} : {}) };
    render(root, signaturePage({ inv: state.inv, names: namesOf(state.inv.wedding), wording: W, time12, rsvpBlock, message: state.message }));
    const page = root.querySelector(".inv-page");
    applyDesign(page, design);
    if (design.standard && HEX.test(options?.accent || "")) page.style.setProperty("--inv-accent", options.accent);
    // Palette swatches: colours through the CSSOM (no inline styles).
    for (const sw of page.querySelectorAll(".sg-swatch[data-hex]")) if (HEX.test(sw.dataset.hex)) sw.style.setProperty("--sw", sw.dataset.hex);
    // The countdown ticks while the page is open.
    const w = state.inv.wedding;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (w.weddingDate && page.querySelector('[data-role="countdown"]')) {
      const target = zonedEpoch(w.weddingDate, w.ceremonyTime, state.inv.timezone);
      state.timer = setInterval(() => {
        const left = countdown(target);
        if (!root.isConnected || !left) {
          clearInterval(state.timer);
          state.timer = null;
          return;
        }
        for (const el of root.querySelectorAll("[data-cd]")) el.textContent = String(left[el.dataset.cd]);
      }, 30_000);
    }
  }

  function draw() {
    if (state.status === "ready" && state.inv.design?.config?.kind === "signature") return signature();
    if (state.status === "ready" && state.inv.design?.config) return designedPage();
    if (state.status !== "ready") {
      render(root, html`<main class="inv-page"><article class="inv-card"><p class="inv-quiet" data-role="message">${state.status === "loading" ? "Opening your invitation…" : state.message}</p></article></main>`);
      return;
    }
    // Luna Standard (the original page). Our story, Gallery, FAQ and the
    // closing line appear when the couple added them (Wedding Setup); a
    // wedding without them sees exactly the original page.
    const { wedding: w, hero, guest, gallery = [] } = state.inv;
    const faq = Array.isArray(w.faq) ? w.faq : [];
    const own = state.inv.options?.wording || {};
    render(
      root,
      html`<main class="inv-page" data-role="invite-page">
        <article class="inv-card">
          <header class="inv-head" data-edit="hero">
            <p class="inv-names">${w.coupleNames || ""}</p>
            <p class="inv-script">${own.scriptLine || "are getting married"}</p>
            ${w.weddingDate ? html`<p class="inv-date">${longDate(w.weddingDate)}</p>` : ""}
          </header>
          ${hero ? html`<img class="inv-hero" src="${hero}" alt="" data-slot="hero">` : html`<div class="inv-hero inv-hero-plain" aria-hidden="true" data-slot="hero"></div>`}
          ${w.welcomeMessage ? html`<p class="inv-message" data-edit="welcome">${w.welcomeMessage}</p>` : ""}
          ${w.story ? html`<section class="inv-section inv-sec-story" data-section="story" data-edit="story"><h3>Our story</h3><p class="inv-story">${w.story}</p></section>` : ""}
          <section class="inv-venues" data-edit="details">${venue("Ceremony", w.ceremonyTime, w.ceremonyVenue, w.ceremonyAddress, w.ceremonyMap)}${venue("Reception", w.receptionTime, w.receptionVenue, w.receptionAddress, w.receptionMap)}</section>
          ${w.dressCode ? html`<section class="inv-venue" data-edit="dress"><h3>Dress code</h3><p>${w.dressCode}</p></section>` : ""}
          ${gallery.length ? html`<section class="inv-section inv-sec-gallery" data-section="gallery" data-edit="gallery"><div class="inv-gallery" data-style="grid">${gallery.map((src) => html`<img src="${src}" alt="" loading="lazy">`)}</div></section>` : ""}
          ${faq.length ? html`<section class="inv-section inv-sec-faq" data-section="faq" data-edit="goodToKnow"><h3>Questions</h3><dl class="inv-faq">${faq.map((f) => html`<dt>${f.q}</dt><dd>${f.a}</dd>`)}</dl></section>` : ""}
          <section class="inv-rsvp" data-role="rsvp" data-edit="rsvp">
            <h2>${own.rsvpTitle || "RSVP"}</h2>
            <p class="inv-quiet">This invitation is for</p>
            <p class="inv-guest" data-role="guest-name">${guest.name}</p>
            <p class="inv-quiet" data-role="seats">${guest.seats} seat${guest.seats === 1 ? "" : "s"} reserved</p>
            ${rsvpBlock()}
            ${state.message ? html`<p class="inv-error" role="alert">${state.message}</p>` : ""}
          </section>
          ${w.footerNote ? html`<section class="inv-section inv-sec-footer" data-section="footer" data-edit="closing"><div class="inv-footer"><p>${w.footerNote}</p></div></section>` : ""}
        </article>
      </main>`
    );
  }

  async function send(status, confirmed) {
    if (preview) {
      state.message = "Preview only: your guest answers from their own link.";
      draw();
      return;
    }
    state.busy = true;
    state.message = "";
    draw();
    try {
      const { meals, note } = asks();
      const names = state.companions.slice(0, companionSlots()).map((n) => (n || "").trim()).filter(Boolean);
      const extra = status === "attending" ? { ...(meals.length && state.meal ? { meal: state.meal } : {}), ...(note && state.note.trim() ? { note: state.note.trim() } : {}), ...(names.length ? { companions: names } : {}) } : {};
      const r = await call({ action: "respond", token, rsvp: status === "attending" ? { status, confirmed, ...extra } : { status } }, fetchImpl);
      state.done = { rsvp: r.rsvp, confirmed: r.confirmed };
      state.inv.guest = { ...state.inv.guest, rsvp: r.rsvp, confirmed: r.confirmed };
    } catch (err) {
      state.message = err.message;
    }
    state.busy = false;
    draw();
  }

  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act], [data-seats], [data-meal], [data-jump]");
    if (!el || state.status !== "ready") return;
    if (el.dataset.jump) {
      root.querySelector(`#sg-${el.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (el.dataset.seats) {
      state.seats = Number(el.dataset.seats);
      draw();
      return;
    }
    if (el.dataset.meal !== undefined) {
      state.meal = el.dataset.meal;
      draw();
      return;
    }
    const a = el.dataset.act;
    if (a === "accept") {
      if (needsStep()) {
        state.choosing = "attending";
        // Never assume every reserved seat is coming: the guest picks.
        const g = state.inv.guest;
        state.seats = g.seats === 1 ? 1 : g.rsvp === "attending" ? g.confirmed : null;
        state.meal = asks().meals.includes(g.meal) ? g.meal : null;
        state.note = typeof g.note === "string" ? g.note : "";
        draw();
      } else send("attending", 1);
    } else if (a === "decline") send("declined");
    else if (a === "back") {
      state.choosing = null;
      draw();
    } else if (a === "send" && state.seats) send("attending", state.seats);
  });

  root.addEventListener("input", (event) => {
    if (event.target.dataset?.role === "rsvp-note") state.note = event.target.value;
    if (event.target.dataset?.role === "companion") state.companions[Number(event.target.dataset.i)] = event.target.value;
  });

  if (!token) {
    state.status = "error";
    state.message = isWeddingHomePath(window.location.pathname) ? "Wedding invitations are personal. Please open the invitation link the couple sent you." : "This invitation link isn't valid. Please ask the couple for a new one.";
    draw();
    return Promise.resolve();
  }
  draw();
  return call({ action: "view", token }, fetchImpl).then(
    (r) => {
      state.status = "ready";
      state.inv = r.invitation;
      // Move an older address (no slug / an old slug) to the current one.
      const path = r.invitation.path;
      if (!preview && typeof path === "string" && inviteTokenFrom(path) === token && path !== window.location.pathname) {
        try {
          window.history.replaceState(null, "", path);
        } catch {
          /* keep the address as it is */
        }
      }
      draw();
    },
    (err) => {
      state.status = "error";
      state.message = err.message;
      draw();
    }
  );
}
