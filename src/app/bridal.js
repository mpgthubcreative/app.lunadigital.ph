// Luna Bridal, public (2026-10-28): what it is, before anyone signs up.
//   /bridal        a short visual page: invitation designs, the guest's RSVP,
//                  the guest list, Wedding Setup, prices, Request free trial
//   /bridal/demo   the real guest invitation (?design=gold|monochrome|rustic)
//                  with the designs' own sample couple, read-only
// No login. Only sample content (the designs' sample couple and made-up
// guests): never a customer's wedding, guests, links or payments. A trial
// request is stored for Luna Super Admin (/api/trial-request); trial access
// is still granted by Luna, never by this page.

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";
import { getTemplateEntry, OFFERED_TEMPLATE_IDS } from "../modules/wedding/invitation/registry.js";
import { previewSetup } from "../modules/wedding/invitation/samples.js";
import { invitationData, resolveDesign } from "@shared/invitation-design.js";
import { TRIAL_RSVP_GUESTS } from "@shared/wedding.js";

const DESIGNS = OFFERED_TEMPLATE_IDS;
const DEMO_GUEST = Object.freeze({ name: "Maria & Jose Santos", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [], party: { named: ["Jose Santos"], open: 0 } });
const heroOf = (id) => getTemplateEntry(id).sampleAssets?.hero || "";
const demoHref = (id) => `/bridal/demo?design=${encodeURIComponent(id)}`;

// The demo invitation: the design's sample wedding through the guest renderer.
export function demoInvitation(id) {
  const entry = getTemplateEntry(id);
  const p = previewSetup(entry, {}, {});
  const setup = { ...p.setup, templateId: id, rsvpEnabled: true, mealOptions: ["Beef", "Fish", "Vegetarian"], askDietary: true };
  return invitationData({ setup, hero: p.hero, guest: DEMO_GUEST, rsvpOpen: true, look: { design: { config: resolveDesign({ templateId: id }), assets: {}, standard: true }, photos: p.photos, gallery: [], entourage: [] }, sample: true, timezone: "Asia/Manila" });
}

export async function renderBridalDemo(root, { search = window.location.search } = {}) {
  const want = new URLSearchParams(search).get("design");
  const id = DESIGNS.includes(want) ? want : DESIGNS[0];
  document.title = "Demo wedding · Luna Bridal";
  render(
    root,
    html`<div class="bp-demo" data-role="bridal-demo">
      <div class="bp-demo-bar"><a class="bp-back" href="/bridal">← Luna Bridal</a><span class="bp-demo-note">Demo wedding · sample couple</span><a class="bp-btn bp-small bp-primary" href="/bridal#trial">Free trial</a></div>
      <nav class="bp-demo-designs" aria-label="Designs">${DESIGNS.map((d) => html`<a class="bp-chip${d === id ? " is-on" : ""}" href="${demoHref(d)}" aria-current="${d === id ? "page" : "false"}">${getTemplateEntry(d).name}</a>`)}</nav>
      <div data-role="demo-invitation"></div>
    </div>`
  );
  const invitation = demoInvitation(id);
  const { renderInvitePage } = await import("../modules/wedding/invitation/renderer.js");
  await renderInvitePage(root.querySelector('[data-role="demo-invitation"]'), { token: "D".repeat(32), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) }), preview: true, previewMessage: "This is a demo: in a real invitation, the answer goes straight to the couple's guest list." });
}

const peso = (n) => `₱${n.toLocaleString("en-PH")}`;
// The wedding serif the invitations use (Google Fonts, allowed by the site's policy).
function loadSerif() {
  if (document.querySelector("link[data-invite-font]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&display=swap";
  l.dataset.inviteFont = "1";
  document.head.appendChild(l);
}

export function renderBridalPage(root, { fetchImpl = (...a) => window.fetch(...a) } = {}) {
  document.title = "Luna Bridal · Wedding invitation, RSVP and guest list";
  loadSerif();
  const state = { sent: false, busy: false, error: "" };
  const phone = (id, extra = "") => html`<figure class="bp-phone ${extra}"><div class="bp-phone-screen"><img src="${heroOf(id)}" alt="" loading="lazy"><div class="bp-phone-card"><p class="bp-phone-names">Nicky <i>&amp;</i> Sam</p><p class="bp-phone-date">June 12, 2027 · Tagaytay</p><span class="bp-phone-btn">RSVP</span></div></div></figure>`;
  function draw() {
    render(
      root,
      html`<main class="bp" data-role="bridal-page">
        <header class="bp-top"><span class="bp-brand">${lunaMark()}<span>Luna <b>Bridal</b></span></span><a class="bp-signin" href="/">Sign in</a></header>

        <section class="bp-hero" data-section="hero">
          <div class="bp-hero-text">
            <h1>Your wedding invitation, RSVP and guest list in one place</h1>
            <p>Each guest opens their own invitation link and answers in a tap. Their answer appears in your guest list right away.</p>
            <p class="bp-cta"><a class="bp-btn bp-primary" href="${demoHref(DESIGNS[0])}" data-role="view-demo">View demo wedding</a><a class="bp-btn" href="#trial">Request free trial</a></p>
          </div>
          ${phone(DESIGNS[1] ?? DESIGNS[0], "bp-phone-hero")}
        </section>

        <section class="bp-section" data-section="designs">
          <h2>Invitation designs</h2>
          <p class="bp-lead">Pick a design, add your names, date, venue and photos. Made for phones.</p>
          <ul class="bp-designs">${DESIGNS.map((id) => html`<li><a href="${demoHref(id)}" data-design="${id}"><img src="${heroOf(id)}" alt="" loading="lazy"><span class="bp-design-name">${getTemplateEntry(id).name}</span><span class="bp-design-go">View demo →</span></a></li>`)}</ul>
        </section>

        <section class="bp-section bp-split" data-section="rsvp">
          <div><h2>RSVP from the invitation</h2><p class="bp-lead">Every party gets a private link with their name and reserved seats. They choose who's coming, a meal and any dietary note.</p></div>
          <div class="bp-mock bp-mock-rsvp" aria-label="Example RSVP">
            <p class="bp-mock-kicker">This invitation is for</p>
            <p class="bp-mock-guest">Maria &amp; Jose Santos</p>
            <p class="bp-mock-quiet">2 seats reserved</p>
            <p>Will you be attending?</p>
            <span class="bp-mock-btn bp-mock-primary">Yes, I'll be there</span><span class="bp-mock-btn">Sorry, I can't make it</span>
          </div>
        </section>

        <section class="bp-section bp-split" data-section="guests">
          <div><h2>Your guest list</h2><p class="bp-lead">See who's attending, who hasn't answered and who can't come. Seating and roles too.</p></div>
          <div class="bp-mock" aria-label="Example guest list">
            <p class="bp-mock-sum">54 invited · 38 attending · 6 waiting</p>
            <ul class="bp-mock-rows">
              ${[["Santos Family", "2", "Attending", "ok"], ["Reyes Family", "4", "Waiting", "wait"], ["Tito Ben", "1", "Attending", "ok"], ["Office friends", "3", "Not attending", "no"]].map(([n, s, st, tone]) => html`<li><span>${n}</span><span class="bp-mock-seats">${s}</span><span class="bp-tag" data-tone="${tone}">${st}</span></li>`)}
            </ul>
          </div>
        </section>

        <section class="bp-section bp-split" data-section="setup">
          <div><h2>Edit it yourself</h2><p class="bp-lead">Tap any part of the invitation to change it: names, date, venue, story, dress code and photos. Publish when it's ready.</p></div>
          <div class="bp-mock" aria-label="Example Wedding Setup">
            <p class="bp-mock-kicker">Names &amp; date</p>
            <div class="bp-field"><span>Partner 1</span><b>Nicky</b></div>
            <div class="bp-field"><span>Partner 2</span><b>Sam</b></div>
            <div class="bp-field"><span>Wedding date</span><b>June 12, 2027</b></div>
            <div class="bp-field"><span>Venue</span><b>Sky Garden Pavilion</b></div>
            <div class="bp-field bp-field-photo"><img src="${heroOf(DESIGNS[0])}" alt="" loading="lazy"><span class="bp-mock-btn">Replace photo</span></div>
          </div>
        </section>

        <section class="bp-section" data-section="pricing" id="pricing">
          <h2>Simple prices</h2>
          <ul class="bp-prices">
            <li data-price="trial"><b>Free Trial</b><span class="bp-price">₱0</span><span>RSVP links for up to ${TRIAL_RSVP_GUESTS} invited guests</span></li>
            <li data-price="3"><b>3 Months</b><span class="bp-price">${peso(499)}</span><span>Your whole guest list</span></li>
            <li data-price="6"><b>6 Months</b><span class="bp-price">${peso(799)}</span><span>Your whole guest list</span></li>
          </ul>
          <p class="bp-addon" data-price="premium-link"><b>Premium wedding link</b> +${peso(499)} one-time · e.g. <span class="bp-url">carloyaniewedding.lunadigitalsystem.com</span></p>
        </section>

        <section class="bp-section bp-trial" data-section="trial" id="trial">
          <h2>Request your free trial</h2>
          ${state.sent
            ? html`<p class="bp-done" data-role="trial-sent" role="status">Thank you! Luna will message you to set up your free trial.</p>`
            : html`<p class="bp-lead">Leave your name and how to reach you. Luna sets up your workspace and sends your sign-in link.</p>
              <form class="bp-form" data-role="trial-form" novalidate>
                <label>Your name<input name="name" maxlength="80" autocomplete="name" required></label>
                <label>Mobile, email or Messenger<input name="contact" maxlength="120" autocomplete="email" required></label>
                <label>Couple's names <small>(optional)</small><input name="coupleNames" maxlength="120" placeholder="e.g. Carlo & Yanie"></label>
                <label>Wedding date <small>(optional)</small><input name="weddingDate" type="date"></label>
                <label class="bp-hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
                ${state.error ? html`<p class="bp-error" role="alert" data-role="trial-error">${state.error}</p>` : ""}
                <button type="submit" class="bp-btn bp-primary" ${state.busy ? "disabled" : ""}>Request free trial</button>
              </form>`}
          <p class="bp-quiet">Already have an account? <a href="/">Sign in</a></p>
        </section>
        <footer class="bp-foot">Luna Digital System</footer>
      </main>`
    );
  }
  root.addEventListener("submit", async (event) => {
    const f = event.target.closest('[data-role="trial-form"]');
    if (!f) return;
    event.preventDefault();
    const v = Object.fromEntries(new FormData(f).entries());
    if (!String(v.name || "").trim() || !String(v.contact || "").trim()) {
      state.error = "Add your name and a mobile number, email or Messenger name.";
      draw();
      return;
    }
    state.busy = true;
    state.error = "";
    draw();
    try {
      const body = Object.fromEntries(Object.entries({ name: v.name, contact: v.contact, coupleNames: v.coupleNames, weddingDate: v.weddingDate, website: v.website }).filter(([, x]) => typeof x === "string" && x.trim() !== ""));
      const res = await fetchImpl("/api/trial-request", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || "Couldn't send. Please try again.");
      state.sent = true;
    } catch (err) {
      state.error = err.message || "Couldn't send. Please try again.";
    }
    state.busy = false;
    draw();
  });
  draw();
}
