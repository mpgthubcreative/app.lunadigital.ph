// The "signature" invitation layout (2026-10-24): a full page rather than
// one card, for the Gold Elegance, Black & White and Rustic Garden
// templates (one layout, three looks: data-variant + the template's
// theme). Every word comes from the wedding profile (Wedding Setup) or the
// template's wording lines (the couple can reword them); every section is
// left out when its content is empty, so a wedding with only names and a
// date still reads well. The initials monogram is drawn from the names.
// No hard-coded couple, photo or artwork.

import { html } from "../../../lib/html.js";
import { familyRelationLabel } from "../../../../shared/wedding.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayParts = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m, day, weekday: DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()] };
};
export const fullDate = (d) => {
  if (!d) return "";
  const p = dayParts(d);
  return `${p.weekday}, ${MONTHS[p.m - 1]} ${p.day}, ${p.y}`;
};
const shortDate = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${Number(d.slice(8))}, ${d.slice(0, 4)}` : "");

// The wedding's start as a moment, in the business's time zone.
export function zonedEpoch(day, time, timeZone) {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = (time || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "Asia/Manila", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    return guess - (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - guess);
  } catch {
    return guess - 8 * 3600_000;
  }
}
// { days, hours, minutes } until then, or null once it has started.
export function countdown(target, now = Date.now()) {
  const ms = target - now;
  if (!(ms > 0)) return null;
  const min = Math.floor(ms / 60_000);
  return { days: Math.floor(min / 1440), hours: Math.floor((min % 1440) / 60), minutes: min % 60 };
}
// The two names set apart: the partners' names, else the names line split
// at "&" / "and" (as shared/wedding.js coupleNameParts, for older weddings).
export function namesOf(w) {
  const p = [w.partner1Name, w.partner2Name].map((n) => (typeof n === "string" ? n.trim() : ""));
  if (p[0] || p[1]) return p.filter(Boolean);
  const line = typeof w.coupleNames === "string" ? w.coupleNames.trim() : "";
  const m = /^(.+?)\s+(?:&|and|\+)\s+(.+)$/i.exec(line);
  return m ? [m[1], m[2]] : line ? [line] : [];
}
// Invitation section → the Owner's editable section (registry.js).
const EDIT_OF = { welcome: "welcome", story: "story", ceremony: "details", dressCode: "dress", entourage: "entourage", gallery: "gallery", faq: "goodToKnow" };
const initial = (n) => (String(n || "").trim()[0] || "").toUpperCase();
const paragraphsOf = (t) => String(t || "").split(/\n\s*\n/).map((p) => p.replace(/\n/g, " ").trim()).filter(Boolean);

// ctx: { inv, names, wording, time12, rsvpBlock, message, now }
export function signaturePage({ inv, names, wording: W, time12, rsvpBlock, message, now = Date.now() }) {
  const { wedding: w, hero, guest, design, photos = {}, gallery = [], entourage = [] } = inv;
  const d = design.config;
  const variant = d.variant || "gold";
  const on = (id) => d.sections.visible[id] !== false;
  const [n1, n2] = names;
  const mono = n2 ? html`<span class="sg-mono" aria-hidden="true">${initial(n1)}<i>&amp;</i>${initial(n2)}</span>` : html`<span class="sg-mono" aria-hidden="true">${initial(n1)}</span>`;
  const namesLine = n2 ? `${n1} & ${n2}` : n1 || "";
  const photo = (slot, cls = "sg-photo") => (photos[slot] ? html`<img class="${cls}" src="${photos[slot]}" alt="" loading="lazy" data-slot="${slot}">` : "");
  // Numbered eyebrows (Gold: "01 How it began") follow the sections shown.
  let num = 0;
  const eyebrow = (text) => {
    if (!text) return "";
    num += 1;
    return html`<p class="sg-eyebrow">${variant === "gold" ? html`<span class="sg-num">${String(num).padStart(2, "0")}</span>` : ""}${text}</p>`;
  };
  // data-edit / data-slot: which editable section / photo slot a part is
  // (the Owner's editor reads them; a guest's page has no controls).
  const sec = (id, cls, inner) => (inner ? html`<section class="sg-section ${cls}" data-section="${id}" data-edit="${EDIT_OF[id]}" id="sg-${id}"><div class="sg-inner">${inner}</div></section>` : "");

  const target = w.weddingDate ? zonedEpoch(w.weddingDate, w.ceremonyTime, inv.timezone) : null;
  const left = target ? countdown(target, now) : null;
  const meta = [
    ["Date", shortDate(w.weddingDate)],
    ["Time", time12(w.ceremonyTime)],
    ["City", w.city],
  ].filter(([, v]) => v);

  const heroPart = on("hero")
    ? html`<section class="sg-hero" data-section="hero" data-has-photo="${hero ? "1" : "0"}">
        ${hero ? html`<img class="sg-hero-photo" src="${hero}" alt="" data-slot="hero">` : html`<div class="sg-hero-photo sg-hero-plain" aria-hidden="true" data-slot="hero" data-role="hero-fallback">${mono}</div>`}
        <div class="sg-hero-card" data-edit="hero">
          ${W.intro ? html`<p class="sg-intro">${W.intro}</p>` : ""}
          <h1 class="sg-names">${n2 ? html`<span>${n1}</span><span class="sg-amp">&amp;</span><span>${n2}</span>` : html`<span>${n1 || ""}</span>`}</h1>
          ${W.tagline ? html`<p class="sg-tagline">${W.tagline}</p>` : ""}
          ${meta.length ? html`<dl class="sg-meta">${meta.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ""}
          <p class="sg-actions"><button type="button" class="sg-btn sg-primary" data-jump="rsvp">RSVP</button><button type="button" class="sg-btn" data-jump="ceremony">View details</button></p>
        </div>
      </section>
      ${left ? html`<section class="sg-countdown" data-role="countdown" aria-label="Countdown">${W.countdownTitle ? html`<p class="sg-cd-title">${W.countdownTitle}</p>` : ""}<div class="sg-cd-units">${[["days", "Days"], ["hours", "Hours"], ["minutes", "Minutes"]].map(([k, l]) => html`<div><span class="sg-cd-n" data-cd="${k}">${left[k]}</span><span class="sg-cd-l">${l}</span></div>`)}</div></section>` : ""}`
    : "";

  // Each side's family: the list (relation, name), or the older one line.
  const familyOf = (list, line) => (Array.isArray(list) && list.length ? list.filter((m) => m && m.name) : line ? [{ name: line }] : []);
  const parents = [
    [n1, familyOf(w.partner1Family, w.partner1Parents)],
    [n2, familyOf(w.partner2Family, w.partner2Parents)],
  ].filter(([, p]) => p.length);
  const welcome = on("welcome") && (w.welcomeMessage || parents.length)
    ? sec("welcome", "sg-welcome", html`${w.welcomeMessage ? html`<p class="sg-lead">${w.welcomeMessage}</p>` : ""}${parents.length ? html`<div class="sg-parents" data-edit="family">${parents.map(([n, people]) => html`<div class="sg-family"><p class="sg-kicker">${n ? `Family of ${n}` : "Family"}</p>${people.map((m) => html`<p class="sg-family-member">${familyRelationLabel(m) ? html`<span class="sg-family-rel">${familyRelationLabel(m)}</span>` : ""}<span>${m.name}</span></p>`)}</div>`)}</div>` : ""}`)
    : "";

  const story = paragraphsOf(w.story);
  const storyPart = on("story") && story.length
    ? sec(
        "story",
        "sg-story",
        html`${eyebrow(W.storyEyebrow)}<h2 class="sg-title">${W.storyTitle}</h2>
          ${photos.story1 || photos.story2 ? html`<div class="sg-story-photos">${photo("story1")}${photo("story2")}</div>` : ""}
          <div class="sg-story-text">${story.map((p, i) => (variant === "rustic" ? html`<div class="sg-chapter"><p class="sg-kicker">Chapter ${i + 1}</p><p>${p}</p></div>` : html`<p class="${i === 0 ? "sg-lead" : ""}">${p}</p>`))}</div>
          ${namesLine ? html`<p class="sg-sign">— ${n2 ? `${initial(n1)} & ${initial(n2)}` : n1}</p>` : ""}`
      )
    : "";

  // Details: When (date, times, a photo), Where (one place, or ceremony and
  // reception apart), how to get there, and the day's schedule.
  const oneVenue = w.sameVenue === true || !(w.receptionVenue || w.receptionAddress);
  const times = [
    ["Ceremony", w.ceremonyTime],
    ["Reception", w.receptionTime],
  ].filter(([, t]) => t);
  const place = (label, name, address, map) =>
    name || address
      ? html`<div class="sg-place">${label ? html`<p class="sg-kicker">${label}</p>` : ""}${name ? html`<h3 class="sg-place-name">${name}</h3>` : ""}${address ? html`<p>${address}</p>` : ""}${map ? html`<p><a class="sg-btn sg-small" href="${map}" target="_blank" rel="noopener noreferrer">Get directions</a></p>` : ""}</div>`
      : "";
  const places = oneVenue
    ? place(null, w.ceremonyVenue, w.ceremonyAddress, w.ceremonyMap || w.receptionMap)
    : html`${place("Ceremony", w.ceremonyVenue, w.ceremonyAddress, w.ceremonyMap)}${place("Reception", w.receptionVenue, w.receptionAddress, w.receptionMap)}`;
  const schedule = Array.isArray(w.schedule) ? w.schedule.filter((s) => s?.title) : [];
  const hasWhere = Boolean(w.ceremonyVenue || w.ceremonyAddress || w.receptionVenue || w.receptionAddress);
  const detailsPart = (on("ceremony") || on("reception")) && (w.weddingDate || times.length || hasWhere || schedule.length)
    ? sec(
        "ceremony",
        "sg-details",
        html`${eyebrow(W.detailsEyebrow)}<h2 class="sg-title">${W.detailsTitle}</h2>
          <div class="sg-cards">
            ${w.weddingDate || times.length ? html`<article class="sg-card">${photo("when", "sg-card-photo")}<div class="sg-card-body"><p class="sg-kicker">When</p>${w.weddingDate ? html`<h3 class="sg-place-name">${fullDate(w.weddingDate)}</h3>` : ""}${times.length ? html`<dl class="sg-times">${times.map(([l, t]) => html`<div><dt>${l}</dt><dd>${time12(t)}</dd></div>`)}</dl>` : ""}</div></article>` : ""}
            ${hasWhere ? html`<article class="sg-card">${photo("venue", "sg-card-photo")}<div class="sg-card-body"><p class="sg-kicker">Where</p>${places}${w.gettingThere ? html`<p class="sg-quiet sg-pre">${w.gettingThere}</p>` : ""}</div></article>` : ""}
          </div>
          ${schedule.length ? html`<div class="sg-schedule" data-edit="schedule"><h3 class="sg-subtitle">${W.scheduleTitle}</h3><ol class="sg-timeline">${schedule.map((s) => html`<li><span class="sg-time">${s.time ? time12(s.time) : ""}</span><span>${s.title}</span></li>`)}</ol></div>` : ""}`
      )
    : "";

  const palette = Array.isArray(w.palette) ? w.palette : [];
  const notes = Array.isArray(w.attireNotes) ? w.attireNotes : [];
  const dressPart = on("dressCode") && (w.dressCode || w.dressCodeDetails || palette.length || notes.length)
    ? sec(
        "dressCode",
        "sg-dress",
        html`${eyebrow(W.dressEyebrow)}<h2 class="sg-title">${W.dressTitle}</h2>
          <div class="sg-dress-grid">${photo("dressCode", "sg-dress-photo")}<div>
            ${w.dressCode ? html`<h3 class="sg-dress-title">${w.dressCode}</h3>` : ""}
            ${w.dressCodeDetails ? html`<p class="sg-pre">${w.dressCodeDetails}</p>` : ""}
            ${palette.length ? html`<ul class="sg-palette" aria-label="Colour palette">${palette.map((c) => html`<li><span class="sg-swatch" data-hex="${c.hex}"></span><span>${c.name || ""}</span></li>`)}</ul>` : ""}
            ${notes.length ? html`<ul class="sg-notes">${notes.map((n) => html`<li>${n}</li>`)}</ul>` : ""}
          </div></div>`
      )
    : "";

  const entouragePart = on("entourage") && entourage.length ? sec("entourage", "sg-entourage", html`<h2 class="sg-title">The Entourage</h2><div class="sg-roles">${entourage.map((g) => html`<div><p class="sg-kicker">${g.label}</p><p>${g.names.join(" · ")}</p></div>`)}</div>`) : "";
  const galleryPart = on("gallery") && gallery.length ? sec("gallery", "sg-gallery", html`<div class="sg-gallery-grid">${gallery.map((src) => html`<img src="${src}" alt="" loading="lazy">`)}</div>`) : "";
  const faq = Array.isArray(w.faq) ? w.faq : [];
  const reminders = Array.isArray(w.reminders) ? w.reminders : [];
  const faqPart = on("faq") && (faq.length || reminders.length || w.giftNote)
    ? sec(
        "faq",
        "sg-faq",
        html`<h2 class="sg-title">Good to know</h2>
          ${reminders.length ? html`<ul class="sg-notes">${reminders.map((r) => html`<li>${r}</li>`)}</ul>` : ""}
          ${w.giftNote ? html`<div class="sg-gift"><p class="sg-kicker">Gifts</p><p class="sg-pre">${w.giftNote}</p></div>` : ""}
          ${faq.length ? html`<dl class="sg-qa">${faq.map((f) => html`<div><dt>${f.q}</dt><dd>${f.a}</dd></div>`)}</dl>` : ""}`
      )
    : "";

  const rsvpPart = html`<section class="sg-section sg-rsvp inv-rsvp" data-role="rsvp" data-section="rsvp" data-edit="rsvp" id="sg-rsvp"><div class="sg-inner">
      ${eyebrow(W.rsvpEyebrow)}<h2 class="sg-title">${W.rsvpTitle}</h2>
      <div class="sg-rsvp-box">
        <p class="inv-quiet">This invitation is for</p>
        <p class="inv-guest" data-role="guest-name">${guest.name}</p>
        <p class="inv-quiet" data-role="seats">${guest.seats} seat${guest.seats === 1 ? "" : "s"} reserved</p>
        ${rsvpBlock()}
        ${message ? html`<p class="inv-error" role="alert">${message}</p>` : ""}
      </div>
      ${w.rsvpContact ? html`<p class="sg-quiet">Questions? ${w.rsvpContact}</p>` : ""}
    </div></section>`;

  const footerPart = on("footer")
    ? html`<footer class="sg-footer" data-section="footer" data-edit="closing">${mono}<p class="sg-footer-names">${namesLine}</p><p class="sg-quiet">${[shortDate(w.weddingDate), w.city].filter(Boolean).join(" · ")}</p>${w.footerNote ? html`<p>${w.footerNote}</p>` : ""}${W.closing ? html`<p class="sg-closing">${W.closing}</p>` : ""}</footer>`
    : "";

  // Ceremony, Reception and Map links are one Details section (at Ceremony's place).
  const parts = { hero: heroPart, welcome, story: storyPart, ceremony: detailsPart, dressCode: dressPart, entourage: entouragePart, gallery: galleryPart, faq: faqPart, rsvp: rsvpPart, footer: footerPart };
  const body = d.sections.order.filter((id) => parts[id] !== undefined).map((id) => parts[id]);
  return html`<main class="inv-page inv-signature" data-role="invite-page" data-template="${d.templateId}" data-variant="${variant}">
    <nav class="sg-nav">${mono}<button type="button" class="sg-btn sg-small sg-primary" data-jump="rsvp">RSVP</button></nav>
    ${body}
  </main>`;
}
