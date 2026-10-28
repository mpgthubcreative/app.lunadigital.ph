// @vitest-environment jsdom
// Wedding Setup = the invitation, edited in place (2026-10-25): choose one
// of three designs → the complete invitation with the design's examples →
// Edit a section / Replace a photo in a small sheet that saves only that
// section's fields → Clean Preview (no controls) → Publish. Samples are
// never sent to the server; older designs keep rendering.

import { describe, it, expect, beforeEach } from "vitest";
import { mount, standardPreviewDesign } from "../../src/modules/wedding/setup.js";
import { renderInvitePage } from "../../src/modules/wedding/invitation/renderer.js";
import { invitationData, resolveDesign } from "../../shared/invitation-design.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};
const SESSION = { member: { permissions: { "guests.manage": true } }, business: { timezone: "Asia/Manila" }, subscription: {} };
const SAMPLE_WORDS = /Nicky|Sam\b|Magnolia|Charleston|rainy October|nickyandsam|Garden Formal|\/invitations\/samples\//;
let container;
let calls;

// An in-memory /api/wedding-setup (merge saves like the server).
function fakeApi(initial = {}, { invitation = null, entourage = [] } = {}) {
  const db = { setup: structuredClone(initial), hero: null, photos: {} };
  calls = [];
  const api = async (_path, { body }) => {
    calls.push(structuredClone(body));
    if (body.action === "get") return { setup: structuredClone(db.setup), hero: db.hero, hasHero: Boolean(db.hero), photos: { ...db.photos }, gallery: [], entourage, invitation };
    if (body.action === "save") {
      db.setup = { ...db.setup, ...body.setup };
      return { saved: true, setup: structuredClone(db.setup) };
    }
    if (body.action === "preview") return { design: invitation?.level === "custom" ? { config: resolveDesign({ templateId: "garden" }), assets: {} } : standardPreviewDesign(body.templateId), gallery: [], entourage, photos: {} };
    if (body.action === "photo") {
      if (body.dataUrl) db.photos[body.slot] = body.dataUrl;
      else delete db.photos[body.slot];
      return { slot: body.slot, photo: Boolean(body.dataUrl) };
    }
    if (body.action === "hero") {
      db.hero = body.dataUrl;
      return { hero: Boolean(body.dataUrl) };
    }
    return {};
  };
  return { api, db };
}
const sheet = () => document.querySelector('[data-role="mini-editor"]');
const sendSheet = async () => {
  sheet().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
};
const lastSave = () => calls.filter((c) => c.action === "save").at(-1)?.setup;

beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

describe("a brand-new invitation", () => {
  it("opens on the choice of exactly three designs; choosing one shows the complete invitation with the design's examples", async () => {
    const { api } = fakeApi({});
    mount(container, SESSION, { api, toast: () => {}, shrink: async () => "data:image/jpeg;base64,AAAA" });
    await flush();
    expect([...container.querySelectorAll("[data-choose]")].map((b) => b.dataset.choose)).toEqual(["gold", "monochrome", "rustic"]);
    expect(container.textContent).not.toMatch(/Classic|Romantic|Editorial|Luna Standard|Modern/);
    container.querySelector('[data-choose="gold"]').click();
    await flush(16);
    // Only the choice is saved (unpublished) — never the examples.
    expect(lastSave()).toEqual({ templateId: "gold", published: false });
    const page = container.querySelector('[data-role="canvas"] [data-role="invite-page"]');
    expect(page.dataset.variant).toBe("gold");
    expect(page.querySelector(".sg-names").textContent).toMatch(/Nicky.*Sam/);
    expect(page.querySelector(".sg-hero-photo").getAttribute("src")).toBe("/invitations/samples/gold/hero.webp");
    expect(page.textContent).toMatch(/The Magnolia House/);
    // Edit mode: one control per editable part, "Add your …" on examples.
    const labels = [...page.querySelectorAll(".ie-edit")].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Add your names", "Add your story", "Add your venue", "Add your schedule", "Add your dress code", "Set up RSVP"]));
    expect(page.querySelectorAll(".ie-replace").length).toBeGreaterThanOrEqual(6);
    expect(container.querySelector('[data-role="publish-state"]').textContent).toBe("Not published");
    expect(container.querySelector('[data-act="publish"]')).not.toBeNull();
  });
});

describe("editing on the invitation", () => {
  const start = async (setup = { templateId: "gold", published: false }) => {
    const f = fakeApi(setup);
    mount(container, SESSION, { api: f.api, toast: () => {}, shrink: async () => "data:image/jpeg;base64,BBBB", measure: async () => ({ w: 1600, h: 2000 }) });
    await flush(16);
    return f;
  };
  it("Edit on the names opens ONLY names / date / city (examples as placeholders); Save sends only those, then the invitation shows them", async () => {
    const { db } = await start();
    container.querySelector('[data-ie-edit="hero"]').click();
    const names = [...sheet().querySelectorAll("[data-field]")].map((x) => x.dataset.field);
    expect(names).toEqual(["partner1Name", "partner2Name", "coupleNames", "weddingDate", "city"]);
    expect(sheet().elements.partner1Name.value).toBe("");
    expect(sheet().elements.partner1Name.placeholder).toBe("Nicky");
    expect(sheet().querySelector('[data-role="sheet-photos"] [data-slot-row="hero"]')).not.toBeNull();
    sheet().elements.partner1Name.value = "Camille";
    sheet().elements.partner2Name.value = "Carlo";
    sheet().elements.weddingDate.value = "2027-05-15";
    await sendSheet();
    expect(sheet()).toBeNull();
    const saved = lastSave();
    expect(saved).toMatchObject({ partner1Name: "Camille", partner2Name: "Carlo", coupleNames: "Camille & Carlo", weddingDate: "2027-05-15", city: null });
    expect(Object.keys(saved).sort()).toEqual(["city", "coupleNames", "partner1Name", "partner2Name", "templateOptions", "weddingDate"]);
    expect(JSON.stringify(db.setup)).not.toMatch(SAMPLE_WORDS);
    expect(container.querySelector(".sg-names").textContent).toMatch(/Camille.*Carlo/);
    // Names are real now: the names part says Edit.
    expect(container.querySelector('[data-ie-edit="hero"]').textContent).toBe("Edit");
    // Changing a partner's name later updates the names line (it was never typed).
    container.querySelector('[data-ie-edit="hero"]').click();
    expect(sheet().elements.coupleNames.value).toBe("");
    sheet().elements.partner1Name.value = "Cami";
    await sendSheet();
    expect(lastSave().coupleNames).toBe("Cami & Carlo");
  });
  it("ceremony / reception, schedule, story, dress code + palette, RSVP, good to know and wording: each from its own section", async () => {
    const { db } = await start();
    container.querySelector('[data-ie-edit="details"]').click();
    expect([...sheet().querySelectorAll("[data-field]")].map((x) => x.dataset.field)).toEqual(["ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap", "sameVenue", "receptionTime", "receptionVenue", "receptionAddress", "receptionMap", "gettingThere"]);
    sheet().elements.ceremonyVenue.value = "St. Michael Parish";
    sheet().elements.ceremonyTime.value = "15:00";
    sheet().elements.receptionVenue.value = "Sky Garden";
    await sendSheet();
    expect(lastSave()).toMatchObject({ ceremonyVenue: "St. Michael Parish", ceremonyTime: "15:00", receptionVenue: "Sky Garden", sameVenue: false });
    expect(container.querySelector('[data-edit="details"]').textContent).toMatch(/St. Michael Parish/);
    expect(container.querySelector('[data-edit="details"]').textContent).not.toMatch(/Magnolia/); // never mixed with the example
    // Schedule: + Add time
    container.querySelector('[data-ie-edit="schedule"]').click();
    sheet().elements["schedule-time-0"].value = "15:00";
    sheet().elements["schedule-title-0"].value = "Ceremony";
    sheet().querySelector('[data-act="list-add"][data-key="schedule"]').click();
    sheet().elements["schedule-time-1"].value = "18:00";
    sheet().elements["schedule-title-1"].value = "Dinner";
    await sendSheet();
    expect(lastSave().schedule).toEqual([{ time: "15:00", title: "Ceremony" }, { time: "18:00", title: "Dinner" }]);
    // Story + its wording line
    container.querySelector('[data-ie-edit="story"]').click();
    sheet().elements.story.value = "We met in Cebu.\n\nThen Manila.";
    sheet().elements["wording-storyTitle"].value = "How We Met";
    await sendSheet();
    expect(lastSave()).toMatchObject({ story: "We met in Cebu.\n\nThen Manila." });
    expect(lastSave().templateOptions.gold.wording.storyTitle).toBe("How We Met");
    expect(container.querySelector('[data-edit="story"] .sg-title').textContent).toBe("How We Met");
    // Dress code: attire + colours
    container.querySelector('[data-ie-edit="dress"]').click();
    expect([...sheet().querySelectorAll("[data-field]")].map((x) => x.dataset.field)).toEqual(["dressCode", "dressCodeDetails", "palette", "attireNotes"]);
    sheet().elements.dressCode.value = "Formal";
    sheet().elements["palette-name-0"].value = "Sage";
    sheet().elements["palette-hex-0"].value = "#8fa382";
    sheet().querySelector('[data-act="list-add"][data-key="palette"]').click();
    sheet().elements["palette-name-1"].value = "Terracotta";
    sheet().elements["palette-hex-1"].value = "#b4532a";
    await sendSheet();
    expect(lastSave()).toMatchObject({ dressCode: "Formal", palette: [{ name: "Sage", hex: "#8fa382" }, { name: "Terracotta", hex: "#b4532a" }] });
    // RSVP: deadline, meal choices, dietary question
    container.querySelector('[data-ie-edit="rsvp"]').click();
    sheet().elements.rsvpDeadline.value = "2027-04-15";
    sheet().elements["mealOptions-0"].value = "Beef";
    sheet().querySelector('[data-act="list-add"][data-key="mealOptions"]').click();
    sheet().elements["mealOptions-1"].value = "Fish";
    sheet().elements.askDietary.checked = true;
    await sendSheet();
    expect(lastSave()).toMatchObject({ rsvpDeadline: "2027-04-15", mealOptions: ["Beef", "Fish"], askDietary: true, rsvpEnabled: true });
    // Good to know: FAQ + gift note
    container.querySelector('[data-ie-edit="goodToKnow"]').click();
    sheet().querySelector('[data-act="faq-add"]').click();
    sheet().elements.faqQ0.value = "Parking?";
    sheet().elements.faqA0.value = "Beside the church.";
    sheet().elements.giftNote.value = "Your presence is enough.";
    await sendSheet();
    expect(lastSave()).toMatchObject({ faq: [{ q: "Parking?", a: "Beside the church." }], giftNote: "Your presence is enough." });
    // Earlier wording kept when another section's wording is saved.
    expect(db.setup.templateOptions.gold.wording.storyTitle).toBe("How We Met");
    expect(JSON.stringify(db.setup)).not.toMatch(SAMPLE_WORDS);
  });
  it("Add / Change photo straight from the invitation: the photo slot is saved and shown at once (cover photo too)", async () => {
    const { db } = await start();
    container.querySelector('[data-ie-photo="story1"]').click();
    const pick = document.querySelector('[data-role="photo-pick"][data-slot="story1"]');
    Object.defineProperty(pick, "files", { value: [new File(["x"], "a.jpg", { type: "image/jpeg" })] });
    pick.dispatchEvent(new Event("change"));
    await flush(16);
    expect(calls).toContainEqual({ action: "photo", slot: "story1", dataUrl: "data:image/jpeg;base64,BBBB" });
    expect(db.photos.story1).toBe("data:image/jpeg;base64,BBBB");
    expect(container.querySelector('[data-slot="story1"]').getAttribute("src")).toBe("data:image/jpeg;base64,BBBB");
    expect(container.querySelector('[data-ie-photo="story1"]').textContent).toBe("Change photo");
    container.querySelector('[data-ie-photo="hero"]').click();
    const hero = document.querySelector('[data-role="photo-pick"][data-slot="hero"]');
    Object.defineProperty(hero, "files", { value: [new File(["x"], "b.jpg", { type: "image/jpeg" })] });
    hero.dispatchEvent(new Event("change"));
    await flush(16);
    // The cover photo is previewed in the invitation first; Save photo stores it.
    expect(calls.some((c) => c.action === "hero")).toBe(false);
    document.querySelector('[data-pv="cover-save"]').click();
    await flush(16);
    expect(calls).toContainEqual({ action: "hero", dataUrl: "data:image/jpeg;base64,BBBB" });
    expect(container.querySelector(".sg-hero-photo").getAttribute("src")).toBe("data:image/jpeg;base64,BBBB");
  });
  it("Clean Preview: the whole invitation with no controls; a notice OUTSIDE it lists what still uses examples; Back to editing", async () => {
    await start();
    container.querySelector('[data-mode="preview"]').click();
    await flush(16);
    const canvas = container.querySelector('[data-role="canvas"]');
    expect(canvas.querySelector('[data-role="invite-page"]')).not.toBeNull();
    expect(canvas.querySelectorAll(".ie-edit, .ie-replace, .ie-sample, .ie-target, .ie-photo").length).toBe(0);
    expect(canvas.textContent).not.toMatch(/Sample|Example|Edit/);
    const notice = container.querySelector('[data-role="sample-notice"]');
    expect(canvas.contains(notice)).toBe(false);
    expect(notice.textContent).toMatch(/items are still using template examples. Replace them before publishing/);
    expect(notice.textContent).toMatch(/Names, Wedding date/);
    container.querySelector('.ie-back [data-mode="edit"]').click();
    await flush(16);
    expect(container.querySelectorAll('[data-role="canvas"] .ie-edit').length).toBeGreaterThan(0);
  });
  it("Guide: each part of THIS design and what it shows; Edit opens the same sheet; Entourage links to Guests", async () => {
    await start();
    container.querySelector('[data-mode="guide"]').click();
    await flush();
    expect([...container.querySelectorAll("[data-guide]")].map((li) => li.dataset.guide)).toEqual(["hero", "welcome", "family", "story", "details", "schedule", "dress", "goodToKnow", "rsvp", "entourage", "gallery", "closing"]);
    expect(container.querySelector('[data-guide="dress"]').textContent).toMatch(/Attire · Colours/);
    expect(container.querySelector('[data-guide="entourage"] a[data-link]').getAttribute("href")).toBe("/guests");
    container.querySelector('[data-guide="rsvp"] [data-ie-edit]').click();
    expect(sheet().dataset.editor).toBe("rsvp");
  });
  it("Publish: names and date must be real (the examples don't count); then it publishes and says what stays hidden", async () => {
    const { db } = await start();
    container.querySelector('[data-act="publish"]').click();
    expect(document.querySelector('[data-role="publish-missing"]').textContent).toMatch(/the couple's names and the wedding date/);
    expect(document.querySelector('[data-act="confirm-publish"]')).toBeNull();
    document.querySelector('[data-role="publish-sheet"] [data-sheet="cancel"]').click();
    expect(document.querySelector('[data-role="publish-sheet"]')).toBeNull();
    expect(calls.some((c) => c.action === "save" && c.setup.published === true)).toBe(false);
    expect(db.setup.published).toBe(false);
  });
});

// A second api over the same stored data (for a remount).
function fakeApiFrom(db) {
  return async (_p, { body }) => {
    calls.push(structuredClone(body));
    if (body.action === "get") return { setup: structuredClone(db.setup), hero: db.hero, photos: { ...db.photos }, gallery: [], entourage: [], invitation: null };
    if (body.action === "save") {
      db.setup = { ...db.setup, ...body.setup };
      return { setup: structuredClone(db.setup) };
    }
    if (body.action === "preview") return { design: standardPreviewDesign(body.templateId), gallery: [], entourage: [], photos: {} };
    return {};
  };
}

describe("publishing, older designs, Custom, guests", () => {
  it("Publish with real names and date sends only { published: true } and lists the examples guests won't see", async () => {
    const db = { setup: { templateId: "rustic", published: false, coupleNames: "Ana & Ben", weddingDate: "2027-03-01" }, hero: null, photos: {} };
    calls = [];
    mount(container, SESSION, { api: fakeApiFrom(db), toast: () => {} });
    await flush(16);
    container.querySelector('[data-act="publish"]').click();
    expect(document.querySelector('[data-role="publish-samples"]').textContent).toMatch(/Our story/);
    document.querySelector('[data-act="confirm-publish"]').click();
    await flush(16);
    expect(lastSave()).toEqual({ published: true });
    expect(container.querySelector('[data-role="publish-state"]').textContent).toBe("Live");
    expect(container.querySelector('[data-act="publish"]')).toBeNull();
  });
  it("an older wedding on Classic: still rendered and editable on the invitation (no examples); the design choice offers only the three, plus keeping Classic", async () => {
    const db = { setup: { templateId: "classic", coupleNames: "Ana & Ben", weddingDate: "2027-03-01", ceremonyVenue: "Old Church", rsvpEnabled: true }, hero: null, photos: {} };
    calls = [];
    mount(container, SESSION, { api: fakeApiFrom(db), toast: () => {} });
    await flush(16);
    const page = container.querySelector('[data-role="canvas"] [data-role="invite-page"]');
    expect(page.dataset.template).toBe("classic");
    expect(page.textContent).toMatch(/Ana & Ben/);
    expect(page.textContent).not.toMatch(SAMPLE_WORDS);
    expect(container.querySelector('[data-role="legacy-note"]').textContent).toMatch(/Classic is no longer offered/);
    expect(container.querySelector('[data-role="publish-state"]').textContent).toBe("Live"); // no flag = live, as before
    container.querySelector('[data-ie-edit="details"]').click();
    expect([...sheet().querySelectorAll("[data-field]")].map((x) => x.dataset.field)).toEqual(["ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap", "receptionTime", "receptionVenue", "receptionAddress", "receptionMap"]);
    sheet().querySelector('[data-sheet="cancel"]').click();
    container.querySelector('[data-act="change-design"]').click();
    expect([...container.querySelectorAll("[data-choose]")].map((b) => b.dataset.choose)).toEqual(["gold", "monochrome", "rustic"]);
    expect(container.querySelector('[data-role="keep-current"]').textContent).toMatch(/Keep Classic/);
    // Switching: the details stay; switching back is not offered for Classic, but Gold ↔ Rustic keeps each one's wording.
    container.querySelector('[data-choose="gold"]').click();
    await flush(16);
    expect(lastSave()).toEqual({ templateId: "gold" }); // never published:false for a live wedding
    expect(container.querySelector(".sg-names").textContent).toMatch(/Ana.*Ben/);
  });
  it("per-design wording and photos survive switching designs and back", async () => {
    const db = { setup: { templateId: "gold", coupleNames: "Ana & Ben", weddingDate: "2027-03-01", templateOptions: { gold: { wording: { tagline: "tie the knot" } } } }, hero: null, photos: { story1: "data:image/jpeg;base64,CCCC" } };
    calls = [];
    mount(container, SESSION, { api: fakeApiFrom(db), toast: () => {} });
    await flush(16);
    expect(container.querySelector(".sg-tagline").textContent).toBe("tie the knot");
    container.querySelector('[data-act="change-design"]').click();
    container.querySelector('[data-choose="rustic"]').click();
    await flush(16);
    expect(container.querySelector(".sg-tagline").textContent).toBe("are getting married"); // Rustic's own words
    expect(container.querySelector('[data-slot="story1"]').getAttribute("src")).toBe("data:image/jpeg;base64,CCCC");
    container.querySelector('[data-act="change-design"]').click();
    container.querySelector('[data-choose="gold"]').click();
    await flush(16);
    expect(container.querySelector(".sg-tagline").textContent).toBe("tie the knot");
    expect(db.setup.templateOptions.gold.wording.tagline).toBe("tie the knot");
  });
  it("Luna Bridal Custom: no design choice and no Publish (Luna's design); content still edited on the invitation without examples", async () => {
    const f = fakeApi({ coupleNames: "Ana & Ben", weddingDate: "2027-03-01" }, { invitation: { level: "custom", live: "custom", publishedVersion: 1 } });
    mount(container, SESSION, { api: f.api, toast: () => {} });
    await flush(16);
    expect(container.querySelector("[data-choose], [data-act='change-design'], [data-act='publish']")).toBeNull();
    expect(container.querySelector('[data-role="invitation-name"]').textContent).toBe("Customized Invitation");
    expect(container.querySelector('[data-role="canvas"]').textContent).not.toMatch(SAMPLE_WORDS);
    expect(container.querySelector('[data-role="canvas"] [data-ie-edit="hero"]')).not.toBeNull();
  });
  it("a guest's invitation has no editor UI and no examples", async () => {
    const invitation = invitationData({ setup: { coupleNames: "Ana & Ben", weddingDate: "2027-03-01", rsvpEnabled: true }, guest: { name: "Lito", seats: 1, rsvp: "awaiting", confirmed: 0, roles: [] }, rsvpOpen: true, look: { design: standardPreviewDesign("gold") } });
    await renderInvitePage(container, { token: "a".repeat(32), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ invitation }) }), preview: false });
    expect(container.querySelector('[data-role="invite-page"]')).not.toBeNull();
    expect(container.querySelectorAll(".ie-edit, .ie-replace, .ie-target, [data-ie-edit], [data-ie-photo]").length).toBe(0);
    expect(container.textContent).not.toMatch(SAMPLE_WORDS);
    // Sections without real content are left out (the examples never fill them).
    expect(container.querySelector('[data-section="story"], [data-section="dressCode"]')).toBeNull();
  });
});

describe("the wedding link during the free trial (2026-10-28)", () => {
  it("a trial shows its Luna-made link (Copy) but no Change link: choosing one comes with Luna Bridal 3 / 6 months; paid can change it", async () => {
    const setup = { templateId: "gold", published: true, coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", weddingSlug: "carlo-and-yanie-wedding-4f2a" };
    let f = fakeApi(setup);
    mount(container, { ...SESSION, subscription: { trial: { open: true } } }, { api: f.api, toast: () => {}, shrink: async () => "data:image/jpeg;base64,BBBB" });
    await flush(16);
    container.querySelector('[data-mode="guide"]').click();
    await flush();
    const link = container.querySelector('[data-role="wedding-link"]');
    expect(link.querySelector('[data-role="wedding-url"]').textContent).toMatch(/\/w\/carlo-and-yanie-wedding-4f2a$/);
    expect(link.querySelector('[data-act="copy-wedding-link"]')).not.toBeNull();
    expect(link.querySelector('[data-ie-edit="link"]')).toBeNull();
    expect(link.querySelector('[data-role="slug-paid"]').textContent).toMatch(/Choose your own .* with Luna Bridal: ₱499 — 3 Months · ₱799 — 6 Months/);
    expect(link.querySelector('[data-role="slug-paid"] a').getAttribute("href")).toBe("/subscription");
    // Paid: Change link is there.
    container.innerHTML = "";
    f = fakeApi(setup);
    mount(container, SESSION, { api: f.api, toast: () => {}, shrink: async () => "data:image/jpeg;base64,BBBB" });
    await flush(16);
    container.querySelector('[data-mode="guide"]').click();
    await flush();
    expect(container.querySelector('[data-role="wedding-link"] [data-ie-edit="link"]')).not.toBeNull();
    expect(container.querySelector('[data-role="slug-paid"]')).toBeNull();
  });
});
