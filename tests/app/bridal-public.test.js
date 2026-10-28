// @vitest-environment jsdom
// Luna Bridal before signup (2026-10-28): /bridal shows the product (designs,
// the guest's RSVP, the guest list, Wedding Setup), the current prices and
// Request free trial; /bridal/demo is the real guest invitation with the
// designs' sample couple, read-only. Plus the cover photo: a guest sees the
// couple's saved photo, or the design's monogram (never an empty block, never
// the example photo); the editor marks example photos on the photo.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderBridalPage, renderBridalDemo, demoInvitation } from "../../src/app/bridal.js";
import { renderInvitePage } from "../../src/modules/wedding/invitation/renderer.js";
import { invitationData, resolveDesign } from "../../shared/invitation-design.js";
import { mount } from "../../src/modules/wedding/setup.js";
import { getTemplateEntry } from "../../src/modules/wedding/invitation/registry.js";

let root;
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  root = document.getElementById("app");
});
const text = (sel) => root.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim();

describe("/bridal (no login)", () => {
  it("in order: what it is + View demo wedding, designs, RSVP, guest list, setup, prices, Request free trial", () => {
    renderBridalPage(root, { fetchImpl: vi.fn() });
    expect([...root.querySelectorAll("[data-section]")].map((s) => s.dataset.section)).toEqual(["hero", "designs", "rsvp", "guests", "setup", "pricing", "trial"]);
    expect(text("h1")).toBe("Your wedding invitation, RSVP and guest list in one place");
    expect(root.querySelector('[data-role="view-demo"]').getAttribute("href")).toBe("/bridal/demo?design=gold");
    expect([...root.querySelectorAll("[data-design]")].map((a) => [a.dataset.design, a.getAttribute("href")])).toEqual([["gold", "/bridal/demo?design=gold"], ["monochrome", "/bridal/demo?design=monochrome"], ["rustic", "/bridal/demo?design=rustic"]]);
    expect(text('[data-section="rsvp"]')).toMatch(/2 seats reserved.*Will you be attending\?.*Yes, I'll be there.*Sorry, I can't make it/);
    expect(text('[data-section="guests"]')).toMatch(/Attending.*Waiting.*Not attending/);
  });

  it("today's prices only: Free Trial (50 invited guests), ₱499 — 3 Months, ₱799 — 6 Months, Premium wedding link +₱499 once; no 12 months", () => {
    renderBridalPage(root, { fetchImpl: vi.fn() });
    expect(text('[data-price="trial"]')).toMatch(/^Free Trial ?₱0 ?RSVP links for up to 50 invited guests$/);
    expect(text('[data-price="3"]')).toMatch(/^3 Months ?₱499/);
    expect(text('[data-price="6"]')).toMatch(/^6 Months ?₱799/);
    expect(text('[data-price="premium-link"]')).toBe("Premium wedding link +₱499 one-time · e.g. carloyaniewedding.lunadigitalsystem.com");
    expect(text('[data-section="pricing"]')).not.toMatch(/12|year|₱999/i);
  });

  it("only sample content: no customer weddings, tokens or payments", () => {
    renderBridalPage(root, { fetchImpl: vi.fn() });
    const page = root.innerHTML;
    expect(page).not.toMatch(/\/rsvp\/|\/invite\/|token|GC-|Shane|yanie-bridal/i);
  });

  it("Request free trial: needs a name and contact; sends only the form's fields; then says Luna will message", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, received: true }) }));
    renderBridalPage(root, { fetchImpl });
    const form = root.querySelector('[data-role="trial-form"]');
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(text('[data-role="trial-error"]')).toMatch(/name and a mobile number, email or Messenger/);
    expect(fetchImpl).not.toHaveBeenCalled();
    const f = root.querySelector('[data-role="trial-form"]');
    f.elements.name.value = "Yanie";
    f.elements.contact.value = "0917 123 4567";
    f.elements.coupleNames.value = "Carlo & Yanie";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith("/api/trial-request", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ name: "Yanie", contact: "0917 123 4567", coupleNames: "Carlo & Yanie" });
    expect(text('[data-role="trial-sent"]')).toBe("Thank you! Luna will message you to set up your free trial.");
  });

  it("a refused request says why and keeps the form", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({ success: false, message: "We've received your requests today. Luna will message you soon." }) }));
    renderBridalPage(root, { fetchImpl });
    const f = root.querySelector('[data-role="trial-form"]');
    f.elements.name.value = "A";
    f.elements.contact.value = "x";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(text('[data-role="trial-error"]')).toBe("We've received your requests today. Luna will message you soon.");
    expect(root.querySelector('[data-role="trial-form"]')).not.toBeNull();
  });
});

describe("/bridal/demo", () => {
  it("the real guest invitation with the design's sample couple and photo; RSVP works without sending anything", async () => {
    await renderBridalDemo(root, { search: "?design=monochrome" });
    await flush();
    expect(root.querySelector('[data-role="invite-page"]').dataset.template).toBe("monochrome");
    expect(root.querySelector(".sg-hero-photo").getAttribute("src")).toBe(getTemplateEntry("monochrome").sampleAssets.hero);
    expect(text('[data-role="guest-name"]')).toBe("Maria & Jose Santos");
    expect(text('[data-role="seats"]')).toBe("2 seats reserved");
    expect(root.querySelector(".bp-chip.is-on").textContent).toBe(getTemplateEntry("monochrome").name);
    root.querySelector('[data-act="decline"]').click();
    await flush();
    expect(root.querySelector('[data-role="rsvp"]').textContent).toMatch(/This is a demo: in a real invitation, the answer goes straight to the couple's guest list\./);
  });

  it("an unknown design falls back to the first offered one", async () => {
    await renderBridalDemo(root, { search: "?design=<script>" });
    await flush();
    expect(root.querySelector('[data-role="invite-page"]').dataset.template).toBe("gold");
  });

  it("the demo data is the sample couple only", () => {
    const inv = demoInvitation("rustic");
    expect(inv).toMatchObject({ sample: true, rsvpOpen: true, guest: { name: "Maria & Jose Santos", seats: 2 } });
    expect(inv.wedding.partner1Name).toBe("Nicky");
  });
});

describe("the cover photo on a guest's invitation", () => {
  const show = async (hero) => {
    const invitation = invitationData({ setup: { coupleNames: "Carlo & Yanie", partner1Name: "Carlo", partner2Name: "Yanie", weddingDate: "2026-12-15", templateId: "monochrome", rsvpEnabled: true }, hero, guest: { name: "Shane", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [] }, rsvpOpen: true, look: { design: { config: resolveDesign({ templateId: "monochrome" }), assets: {}, standard: true }, photos: {}, gallery: [], entourage: [] } });
    await renderInvitePage(root, { token: "T".repeat(32), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) }), preview: true });
    await flush();
  };
  it("the couple's saved photo shows as the photo", async () => {
    await show("data:image/jpeg;base64,/9j/AAAA");
    expect(root.querySelector('.sg-hero [data-slot="hero"]').tagName).toBe("IMG");
    expect(root.querySelector(".sg-hero-photo").getAttribute("src")).toBe("data:image/jpeg;base64,/9j/AAAA");
    expect(root.querySelector('[data-role="hero-fallback"]')).toBeNull();
  });
  it("no photo: the design's monogram (C & Y), not an empty block", async () => {
    await show(null);
    const fb = root.querySelector('[data-role="hero-fallback"]');
    expect(fb.querySelector(".sg-mono").textContent.replace(/\s+/g, "")).toBe("C&Y");
    expect(root.querySelector(".sg-hero").dataset.hasPhoto).toBe("0");
  });
});

describe("Wedding Setup marks example photos", () => {
  const api = (setup, hero = null) => async (_p, { body }) => (body.action === "get" ? { setup, hero, hasHero: Boolean(hero), photos: {}, gallery: [], entourage: [], invitation: null } : body.action === "preview" ? { design: { config: resolveDesign({ templateId: setup.templateId }), assets: {}, standard: true }, gallery: [], entourage: [], photos: {} } : {});
  const SESSION = { member: { permissions: { "guests.manage": true } }, business: { timezone: "Asia/Manila" }, subscription: {} };
  it("the design's example cover photo says 'Example photo · guests won't see it'; the notice offers Add your cover photo", async () => {
    mount(root, SESSION, { api: api({ templateId: "monochrome", coupleNames: "Carlo & Yanie", weddingDate: "2026-12-15", published: true }), toast: () => {} });
    await flush(20);
    const hero = root.querySelector('.ie-photo [data-slot="hero"]').closest(".ie-photo");
    expect(hero.querySelector('[data-role="example-photo"]').textContent).toBe("Example photo · guests won't see it");
    // Clean Preview's notice names the cover photo with its own button.
    root.querySelector('[data-mode="preview"]').click();
    await flush(20);
    expect(text('[data-role="hero-sample-note"]')).toBe("The cover photo is the design's example: guests see your monogram instead until you add your own.");
    expect(root.querySelector('[data-role="sample-notice"] [data-ie-photo="hero"]').textContent).toBe("Add your cover photo");
  });
  it("with the couple's own photo: no example tag", async () => {
    mount(root, SESSION, { api: api({ templateId: "monochrome", coupleNames: "Carlo & Yanie", weddingDate: "2026-12-15", published: true }, "data:image/jpeg;base64,/9j/BBBB"), toast: () => {} });
    await flush(20);
    const hero = root.querySelector('.ie-photo [data-slot="hero"]').closest(".ie-photo");
    expect(hero.querySelector('[data-role="example-photo"]')).toBeNull();
    expect(root.querySelector('[data-role="hero-sample-note"]')).toBeNull();
  });
});
