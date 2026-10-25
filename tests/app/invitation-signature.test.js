// @vitest-environment jsdom
// The signature invitation layout (Gold Elegance, Black & White, Rustic
// Garden; 2026-10-24) through the real guest page: empty parts are left
// out, the couple's wording / accent apply, the RSVP asks a meal and a
// dietary note only when Wedding Setup does, and the countdown counts to
// the ceremony in the business's time zone.

import { describe, it, expect, beforeEach } from "vitest";
import { renderInvitePage } from "../../src/modules/wedding/invitation/renderer.js";
import { zonedEpoch, countdown, namesOf } from "../../src/modules/wedding/invitation/signature.js";
import { invitationData, resolveDesign } from "../../shared/invitation-design.js";

const TOKEN = "a".repeat(32);
let root;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById("root");
});
const look = (templateId) => ({ design: { config: resolveDesign({ templateId }), assets: {}, standard: true } });
async function open(setup, { templateId = "gold", guest = { name: "Maria Santos", seats: 1, rsvp: "awaiting", confirmed: 0, roles: [] }, sent = [] } = {}) {
  const invitation = invitationData({ setup, guest, rsvpOpen: true, look: look(templateId), timezone: "Asia/Manila" });
  const fetchImpl = async (_u, { body }) => {
    const b = JSON.parse(body);
    if (b.action === "respond") sent.push(b.rsvp);
    return { ok: true, status: 200, json: async () => (b.action === "view" ? { invitation } : { rsvp: b.rsvp.status, confirmed: b.rsvp.confirmed ?? 0 }) };
  };
  await renderInvitePage(root, { token: TOKEN, fetchImpl, preview: false });
  return root.querySelector('[data-role="invite-page"]');
}

describe("signature layout", () => {
  it("names and a date only: a clean page (no empty story / details / dress code / good-to-know sections)", async () => {
    const page = await open({ coupleNames: "Ana and Ben", weddingDate: "2027-02-14" });
    expect(page.classList.contains("inv-signature")).toBe(true);
    expect(page.dataset.variant).toBe("gold");
    expect([...page.querySelectorAll(".sg-names span")].map((s) => s.textContent)).toEqual(["Ana", "&", "Ben"]);
    expect(page.querySelector(".sg-mono").textContent).toBe("A&B");
    expect([...page.querySelectorAll("[data-section]")].map((s) => s.dataset.section)).toEqual(["hero", "ceremony", "rsvp", "footer"]);
    expect(page.querySelector(".sg-intro").textContent).toBe("Together with their families");
  });
  it("the couple's wording and accent; Rustic tells the story in chapters", async () => {
    const page = await open({ partner1Name: "Camille", partner2Name: "Carlo", weddingDate: "2027-02-14", story: "One.\n\nTwo.", templateOptions: { rustic: { wording: { tagline: "are tying the knot" }, accent: "olive" } } }, { templateId: "rustic" });
    expect(page.querySelector(".sg-tagline").textContent).toBe("are tying the knot");
    expect(page.style.getPropertyValue("--inv-accent")).toBe("#6b7a3a");
    expect([...page.querySelectorAll(".sg-chapter .sg-kicker")].map((k) => k.textContent)).toEqual(["Chapter 1", "Chapter 2"]);
  });
  it("RSVP: a party of one accepts at once when nothing is asked", async () => {
    const sent = [];
    await open({ coupleNames: "Ana & Ben", weddingDate: "2027-02-14" }, { sent });
    root.querySelector('[data-act="accept"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([{ status: "attending", confirmed: 1 }]);
  });
  it("RSVP: with meal options and the dietary question, Accept asks them (meal required) and sends both", async () => {
    const sent = [];
    await open({ coupleNames: "Ana & Ben", weddingDate: "2027-02-14", mealOptions: ["Beef", "Fish"], askDietary: true }, { sent });
    root.querySelector('[data-act="accept"]').click();
    expect(root.querySelector('[data-act="send"]').disabled).toBe(true);
    const note = root.querySelector('[data-role="rsvp-note"]');
    note.value = "No nuts";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector('[data-meal="Fish"]').click();
    expect(root.querySelector('[data-role="rsvp-note"]').value).toBe("No nuts");
    root.querySelector('[data-act="send"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([{ status: "attending", confirmed: 1, meal: "Fish", note: "No nuts" }]);
  });
  it("an older wedding on a card template is unchanged (no signature parts)", async () => {
    const page = await open({ coupleNames: "Ana & Ben", weddingDate: "2027-02-14" }, { templateId: "classic" });
    expect(page.classList.contains("inv-signature")).toBe(false);
    expect(page.querySelector(".inv-names").textContent).toBe("Ana & Ben");
  });
  it("countdown: to the ceremony time in the business's time zone", () => {
    const t = zonedEpoch("2027-02-14", "15:00", "Asia/Manila");
    expect(new Date(t).toISOString()).toBe("2027-02-14T07:00:00.000Z");
    expect(countdown(t, t - (2 * 1440 + 3 * 60 + 5) * 60_000)).toEqual({ days: 2, hours: 3, minutes: 5 });
    expect(countdown(t, t + 1)).toBeNull();
    expect(namesOf({ partner1Name: "Camille", partner2Name: "" })).toEqual(["Camille"]);
  });
});
