// Public wedding invitation (Owner-pilot Bridal): /w/{weddingSlug}/invite/{token}
// (or the older /invite/{token}). No login:
// the guest opens the personal link the couple sent, sees the invitation for
// THEIR party (name and seats already known) and answers Accept / Decline.
// The token is posted to /api/invite, which updates the same Bridal guest
// record. One elegant theme; every word of the wedding comes from the
// couple's Wedding Setup (nothing about a couple is built in).

import { html, render } from "../lib/html.js";

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
export const inviteTokenFrom = (path) => (/^(?:\/w\/[a-z0-9-]{1,60})?\/invite\/([A-Za-z0-9_-]{32})\/?$/.exec(path) || [])[1] || "";

export function renderInvitePage(root, { token = inviteTokenFrom(window.location.pathname), fetchImpl = (...a) => window.fetch(...a) } = {}) {
  const state = { status: "loading", inv: null, message: "", choosing: null, seats: null, done: null, busy: false };
  const of = (n) => `${n} of ${state.inv.guest.seats}`;
  document.title = "You're invited";
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
    if (state.choosing === "attending" && guest.seats > 1) {
      return html`<p>How many will attend?</p>
        <div class="inv-seats" role="group" aria-label="How many will attend">${Array.from({ length: guest.seats }, (_, i) => i + 1).map((n) => html`<button type="button" class="inv-seat${state.seats === n ? " is-on" : ""}" data-seats="${n}" aria-pressed="${state.seats === n ? "true" : "false"}">${n}</button>`)}</div>
        <div class="inv-actions"><button type="button" class="inv-btn" data-act="back">Back</button><button type="button" class="inv-btn inv-primary" data-act="send" ${state.seats && !state.busy ? "" : "disabled"}>Confirm RSVP</button></div>`;
    }
    return html`${answered}<p>Will you be joining us?</p>
      <div class="inv-actions"><button type="button" class="inv-btn inv-primary" data-act="accept" ${state.busy ? "disabled" : ""}>Accept</button><button type="button" class="inv-btn" data-act="decline" ${state.busy ? "disabled" : ""}>Decline</button></div>
      ${wedding.rsvpDeadline ? html`<p class="inv-quiet">RSVP before ${longDate(wedding.rsvpDeadline)}</p>` : ""}`;
  }

  function draw() {
    if (state.status !== "ready") {
      render(root, html`<main class="inv-page"><article class="inv-card"><p class="inv-quiet" data-role="message">${state.status === "loading" ? "Opening your invitation…" : state.message}</p></article></main>`);
      return;
    }
    const { wedding: w, hero, guest } = state.inv;
    render(
      root,
      html`<main class="inv-page" data-role="invite-page">
        <article class="inv-card">
          <header class="inv-head">
            <p class="inv-names">${w.coupleNames || ""}</p>
            <p class="inv-script">are getting married</p>
            ${w.weddingDate ? html`<p class="inv-date">${longDate(w.weddingDate)}</p>` : ""}
          </header>
          ${hero ? html`<img class="inv-hero" src="${hero}" alt="">` : html`<div class="inv-hero inv-hero-plain" aria-hidden="true"></div>`}
          ${w.welcomeMessage ? html`<p class="inv-message">${w.welcomeMessage}</p>` : ""}
          <section class="inv-venues">${venue("Ceremony", w.ceremonyTime, w.ceremonyVenue, w.ceremonyAddress, w.ceremonyMap)}${venue("Reception", w.receptionTime, w.receptionVenue, w.receptionAddress, w.receptionMap)}</section>
          ${w.dressCode ? html`<section class="inv-venue"><h3>Dress code</h3><p>${w.dressCode}</p></section>` : ""}
          <section class="inv-rsvp" data-role="rsvp">
            <h2>RSVP</h2>
            <p class="inv-quiet">This invitation is for</p>
            <p class="inv-guest" data-role="guest-name">${guest.name}</p>
            <p class="inv-quiet" data-role="seats">${guest.seats} seat${guest.seats === 1 ? "" : "s"} reserved</p>
            ${rsvpBlock()}
            ${state.message ? html`<p class="inv-error" role="alert">${state.message}</p>` : ""}
          </section>
        </article>
      </main>`
    );
  }

  async function send(status, confirmed) {
    state.busy = true;
    state.message = "";
    draw();
    try {
      const r = await call({ action: "respond", token, rsvp: status === "attending" ? { status, confirmed } : { status } }, fetchImpl);
      state.done = { rsvp: r.rsvp, confirmed: r.confirmed };
      state.inv.guest = { ...state.inv.guest, rsvp: r.rsvp, confirmed: r.confirmed };
    } catch (err) {
      state.message = err.message;
    }
    state.busy = false;
    draw();
  }

  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act], [data-seats]");
    if (!el || state.status !== "ready") return;
    if (el.dataset.seats) {
      state.seats = Number(el.dataset.seats);
      draw();
      return;
    }
    const a = el.dataset.act;
    if (a === "accept") {
      if (state.inv.guest.seats > 1) {
        state.choosing = "attending";
        // Never assume every reserved seat is coming: the guest picks.
        state.seats = state.inv.guest.rsvp === "attending" ? state.inv.guest.confirmed : null;
        draw();
      } else send("attending", 1);
    } else if (a === "decline") send("declined");
    else if (a === "back") {
      state.choosing = null;
      draw();
    } else if (a === "send" && state.seats) send("attending", state.seats);
  });

  draw();
  return call({ action: "view", token }, fetchImpl).then(
    (r) => {
      state.status = "ready";
      state.inv = r.invitation;
      // Move an older address (no slug / an old slug) to the current one.
      const path = r.invitation.path;
      if (typeof path === "string" && inviteTokenFrom(path) === token && path !== window.location.pathname) {
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
