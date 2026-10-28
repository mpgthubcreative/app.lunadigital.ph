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
  it("in order: what it is + View demo wedding + Request free trial, designs, RSVP, guest list, setup, prices, the form", async () => {
    renderBridalPage(root, { fetchImpl: vi.fn() });
    await flush();
    expect([...root.querySelectorAll("main.bp > [data-section]")].map((s) => s.dataset.section)).toEqual(["hero", "designs", "rsvp", "guests", "setup", "pricing", "trial"]);
    expect(text("h1")).toBe("Your wedding invitation, RSVP and guest list in one place");
    expect(root.querySelector('[data-role="view-demo"]').getAttribute("href")).toBe("/bridal/demo?design=gold");
    expect(root.querySelector('[data-section="hero"] a[href="#trial"]').textContent).toBe("Request free trial");
    expect(text('[data-section="guests"]')).toMatch(/Attending.*Waiting.*Not attending/);
    // No lookalike invitation mock-ups.
    expect(root.querySelector(".bp-phone, .bp-mock-rsvp")).toBeNull();
  });

  it("the designs are the REAL guest invitation (renderer, layout, sample photos), switchable Gold / Black & White / Rustic", async () => {
    renderBridalPage(root, { fetchImpl: vi.fn() });
    await flush();
    const viewer = () => root.querySelector('[data-role="design-viewer"]');
    expect([...root.querySelectorAll(".bp-tabs [data-design]")].map((b) => b.dataset.design)).toEqual(["gold", "monochrome", "rustic"]);
    for (const id of ["gold", "monochrome", "rustic"]) {
      root.querySelector(`.bp-tabs [data-design="${id}"]`).click();
      await flush();
      const page = viewer().querySelector('[data-role="invite-page"]');
      expect(page.classList.contains("inv-signature")).toBe(true);
      expect(page.dataset.template).toBe(id);
      expect(page.querySelector(".sg-hero-photo").getAttribute("src")).toBe(getTemplateEntry(id).sampleAssets.hero);
      expect([...page.querySelectorAll("[data-section]")].map((x) => x.dataset.section)).toEqual(expect.arrayContaining(["hero", "welcome", "story", "entourage", "rsvp"]));
      expect(root.querySelector(`.bp-tabs [data-design="${id}"]`).getAttribute("aria-selected")).toBe("true");
      expect(root.querySelector('[data-role="open-demo"]').getAttribute("href")).toBe(`/bridal/demo?design=${id}`);
    }
  });

  it("the RSVP example is the real invitation's RSVP (try it: nothing is sent)", async () => {
    const fetchImpl = vi.fn();
    renderBridalPage(root, { fetchImpl });
    await flush();
    const box = root.querySelector('[data-role="rsvp-live"]');
    expect(box.querySelector(".inv-signature .sg-rsvp")).not.toBeNull();
    expect(box.querySelector('[data-role="guest-name"]').textContent).toBe("Maria & Jose Santos");
    expect(box.querySelector('[data-role="seats"]').textContent).toBe("2 seats reserved");
    box.querySelector('[data-act="decline"]').click();
    await flush();
    expect(box.querySelector('[data-role="rsvp"]').textContent).toMatch(/This is a demo/);
    expect(fetchImpl).not.toHaveBeenCalled();
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

describe("Wedding Setup photo states (2026-10-28)", () => {
  // An in-memory /api/wedding-setup that stores the cover photo like the server.
  const store = (setup, hero = null) => {
    const db = { hero, calls: [] };
    const api = async (_p, { body }) => {
      db.calls.push(body);
      if (body.action === "get") return { setup, hero: db.hero, hasHero: Boolean(db.hero), photos: {}, gallery: [], entourage: [], invitation: null };
      if (body.action === "preview") return { design: { config: resolveDesign({ templateId: setup.templateId }), assets: {}, standard: true }, gallery: [], entourage: [], photos: {} };
      if (body.action === "hero") {
        if (body.dataUrl === "data:image/jpeg;base64,FAIL") throw new Error("The photo couldn't be uploaded");
        db.hero = body.dataUrl;
        return { hero: Boolean(body.dataUrl) };
      }
      return {};
    };
    return { db, api };
  };
  const SESSION = { member: { permissions: { "guests.manage": true } }, business: { timezone: "Asia/Manila" }, subscription: {} };
  const SETUP = { templateId: "monochrome", coupleNames: "Carlo & Yanie", weddingDate: "2026-12-15", published: true };
  const heroBox = () => root.querySelector('.ie-photo [data-slot="hero"]').closest(".ie-photo");
  const buttons = () => [...heroBox().querySelectorAll(".ie-photo-actions button")].map((b) => b.textContent);
  const pickHero = async (dataUrl) => {
    heroBox().querySelector("[data-ie-photo]").click();
    const pick = document.querySelector('[data-role="photo-pick"][data-slot="hero"]');
    Object.defineProperty(pick, "files", { value: [new File(["x"], "c.jpg", { type: "image/jpeg" })] });
    pick.dispatchEvent(new Event("change"));
    await flush(20);
    document.querySelector('[data-pv="cover-save"]')?.click();
    await flush(20);
    return dataUrl;
  };

  it("A. the design's example photo: labelled, Add your photo, no Remove", async () => {
    const { api } = store(SETUP);
    mount(root, SESSION, { api, toast: () => {} });
    await flush(20);
    expect(heroBox().querySelector('[data-role="example-photo"]').textContent).toBe("Example photo · guests won't see it");
    expect(buttons()).toEqual(["Add your photo"]);
  });

  it("C. a saved photo: shown, Change photo + Remove photo, no Example label; Change replaces it", async () => {
    const { api, db } = store(SETUP, "data:image/jpeg;base64,OLD");
    let next = "data:image/jpeg;base64,NEW";
    mount(root, SESSION, { api, toast: () => {}, shrink: async () => next, measure: async () => ({ w: 1600, h: 2000 }) });
    await flush(20);
    expect(root.querySelector(".sg-hero-photo").getAttribute("src")).toBe("data:image/jpeg;base64,OLD");
    expect(heroBox().querySelector('[data-role="example-photo"]')).toBeNull();
    expect(buttons()).toEqual(["Change photo", "Remove photo"]);
    await pickHero();
    expect(db.hero).toBe("data:image/jpeg;base64,NEW");
    expect(root.querySelector(".sg-hero-photo").getAttribute("src")).toBe("data:image/jpeg;base64,NEW");
    // A failed upload changes nothing on screen and says so.
    const toast = vi.fn();
    document.body.innerHTML = '<main id="app"></main>';
    root = document.getElementById("app");
    mount(root, SESSION, { api, toast, shrink: async () => next, measure: async () => ({ w: 1600, h: 2000 }) });
    await flush(20);
    next = "data:image/jpeg;base64,FAIL";
    await pickHero();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Couldn't save the photo: The photo couldn't be uploaded\. Please try again\.$/), "danger");
    expect(root.querySelector(".sg-hero-photo").getAttribute("src")).toBe("data:image/jpeg;base64,NEW");
    expect(db.hero).toBe("data:image/jpeg;base64,NEW");
  });

  it("Remove photo asks first; Cancel keeps it; Remove stores the removal and the example state returns", async () => {
    const { api, db } = store(SETUP, "data:image/jpeg;base64,SAVED");
    const answers = [false, true];
    const confirm = vi.fn(async () => answers.shift());
    mount(root, SESSION, { api, toast: () => {}, confirm });
    await flush(20);
    heroBox().querySelector('[data-act="photo-remove"]').click();
    await flush(20);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Remove this wedding photo?", confirmLabel: "Remove" }));
    expect(db.hero).toBe("data:image/jpeg;base64,SAVED");
    expect(db.calls.filter((c) => c.action === "hero")).toEqual([]);
    heroBox().querySelector('[data-act="photo-remove"]').click();
    await flush(20);
    expect(db.calls.filter((c) => c.action === "hero")).toEqual([{ action: "hero", dataUrl: null }]);
    expect(db.hero).toBeNull();
    expect(buttons()).toEqual(["Add your photo"]);
    expect(heroBox().querySelector('[data-role="example-photo"]')).not.toBeNull();
    // Refresh: still removed.
    document.body.innerHTML = '<main id="app"></main>';
    root = document.getElementById("app");
    mount(root, SESSION, { api, toast: () => {} });
    await flush(20);
    expect(buttons()).toEqual(["Add your photo"]);
  });
});

describe("cover photo guide and preview-before-save (2026-10-28)", () => {
  const SESSION = { member: { permissions: { "guests.manage": true } }, business: { timezone: "Asia/Manila" }, subscription: {} };
  const SETUP = { templateId: "gold", coupleNames: "Carlo & Yanie", weddingDate: "2026-12-15", published: true };
  const store = () => {
    const db = { hero: null, calls: [] };
    const api = async (_p, { body }) => {
      db.calls.push(body);
      if (body.action === "get") return { setup: SETUP, hero: db.hero, hasHero: Boolean(db.hero), photos: {}, gallery: [], entourage: [], invitation: null };
      if (body.action === "preview") return { design: { config: resolveDesign({ templateId: "gold" }), assets: {}, standard: true }, gallery: [], entourage: [], photos: {} };
      if (body.action === "hero") {
        db.hero = body.dataUrl;
        return { hero: Boolean(body.dataUrl) };
      }
      return { saved: true, setup: SETUP };
    };
    return { db, api };
  };
  const choose = async (type) => {
    root.querySelector('.ie-photo [data-slot="hero"]').closest(".ie-photo").querySelector("[data-ie-photo]").click();
    const pick = [...document.querySelectorAll('[data-role="photo-pick"][data-slot="hero"]')].at(-1);
    expect(pick.accept).toMatch(/image\/jpeg/);
    expect(pick.accept).toMatch(/image\/png/);
    Object.defineProperty(pick, "files", { value: [new File(["x"], type === "image/png" ? "c.png" : "c.jpg", { type })] });
    pick.dispatchEvent(new Event("change"));
    await flush(20);
  };

  it("the cover photo's sheet shows the size guide", async () => {
    const { api } = store();
    mount(root, SESSION, { api, toast: () => {} });
    await flush(20);
    root.querySelector('[data-ie-edit="hero"]').click();
    await flush(5);
    expect(document.querySelector('[data-role="photo-guide"]').textContent).toBe("Recommended: portrait photo, 1600 × 2000 px or larger (JPG or PNG, under 5 MB). Keep faces near the center for the best crop.");
  });

  it("JPG and PNG: previewed in the real invitation (same hero) before anything is saved; Save photo stores it", async () => {
    for (const type of ["image/jpeg", "image/png"]) {
      document.body.innerHTML = '<main id="app"></main>';
      root = document.getElementById("app");
      const { api, db } = store();
      const url = `data:image/jpeg;base64,${type === "image/png" ? "PNG0" : "JPG0"}`;
      mount(root, SESSION, { api, toast: () => {}, shrink: async () => url, measure: async () => ({ w: 1600, h: 2000 }) });
      await flush(20);
      await choose(type);
      const pv = document.querySelector('[data-role="invite-preview"]');
      expect(pv.querySelector(".inv-signature .sg-hero-photo").getAttribute("src")).toBe(url);
      expect(pv.querySelector('[data-role="owner-bar"]').textContent).toMatch(/Your new cover photo, as your guests will see it\./);
      expect(db.calls.some((c) => c.action === "hero")).toBe(false);
      pv.querySelector('[data-pv="cover-save"]').click();
      await flush(20);
      expect(db.hero).toBe(url);
      expect(document.querySelector('[data-role="invite-preview"]')).toBeNull();
      expect(root.querySelector(".sg-hero-photo").getAttribute("src")).toBe(url);
    }
  });

  it("a small photo warns (and can still be saved); Choose another / Close save nothing", async () => {
    const { api, db } = store();
    mount(root, SESSION, { api, toast: () => {}, shrink: async () => "data:image/jpeg;base64,SMALL", measure: async () => ({ w: 800, h: 1000 }) });
    await flush(20);
    await choose("image/jpeg");
    const bar = document.querySelector('[data-role="owner-bar"]');
    expect(bar.dataset.lowRes).toBe("1");
    expect(bar.textContent).toMatch(/This photo may look blurry on larger screens\. For best results, use at least 1200 × 1500 px\. You can still save it\./);
    bar.querySelector('[data-pv="close"]').click();
    await flush(5);
    expect(db.calls.some((c) => c.action === "hero")).toBe(false);
    await choose("image/jpeg");
    document.querySelector('[data-pv="cover-other"]').click();
    await flush(5);
    expect(document.querySelector('[data-role="invite-preview"]')).toBeNull();
    expect(document.querySelector('[data-role="photo-pick"][data-slot="hero"]')).not.toBeNull();
    expect(db.calls.some((c) => c.action === "hero")).toBe(false);
  });
});
