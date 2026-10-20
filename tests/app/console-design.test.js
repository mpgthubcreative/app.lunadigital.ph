// @vitest-environment jsdom
// Luna Console: one wedding's invitation design editor (Super Admin).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { invitationDesignView } from "../../src/console/design.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const WORKSPACE = (planId = "bridal-plus", extra = {}) => ({
  success: true,
  business: { id: "biz-wed", name: "Reyes-Prado Wedding", planId },
  status: { level: planId === "bridal-plus" ? "custom" : "standard", live: "standard", publishedVersion: null, hasDraft: false },
  draft: { config: { templateId: "standard" }, state: "draft", version: null },
  published: null,
  live: "standard",
  history: [],
  assets: [{ id: "orn0000001", name: "ornament.png", contentType: "image/png", bytes: 2048, dataUrl: "data:image/png;base64,iVBORw0KGgo=" }],
  content: { setup: { coupleNames: "Carlo & Yanie" }, hero: null },
  ...extra,
});

let el;
let calls;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  el = document.getElementById("content");
  calls = [];
});
const mockApi = (ws) => {
  globalThis.fetch = vi.fn(async (_u, { body }) => {
    const b = JSON.parse(body);
    calls.push(b);
    const out = b.action === "get" ? ws : { success: true };
    return { ok: true, status: 200, json: async () => out };
  });
};
const ctx = { base: "/console", toast: vi.fn() };

describe("Console → Invitation design", () => {
  it("edits one business's draft: template, colours, fonts, section order / visibility, images; Save draft sends a validated-shape config", async () => {
    mockApi(WORKSPACE());
    await invitationDesignView(el, ctx, "biz-wed");
    await flush();
    expect(el.querySelector('[data-role="design-status"]').textContent).toContain("Guests see: Standard invitation");
    const f = el.querySelector('[data-role="design-form"]').elements;
    expect(f.templateId.value).toBe("standard");
    // Move Welcome up above Hero, hide it, recolour the accent, pick a font and an ornament.
    el.querySelector('[data-act="up"][data-id="welcome"]').click();
    const f2 = el.querySelector('[data-role="design-form"]').elements;
    f2["show-welcome"].checked = false;
    f2["color-accent"].value = "#4f6f52";
    f2.headingFont.value = "Playfair Display";
    f2["asset-ornamentTop"].value = "orn0000001";
    el.querySelector('[data-act="save"]').click();
    await flush();
    const save = calls.find((c) => c.action === "saveDraft");
    expect(save.businessId).toBe("biz-wed");
    expect(save.config.sections.order.slice(0, 2)).toEqual(["welcome", "hero"]);
    expect(save.config.sections.visible.welcome).toBe(false);
    expect(save.config.sections.visible.rsvp).toBe(true);
    expect(save.config.theme).toMatchObject({ accent: "#4f6f52", headingFont: "Playfair Display" });
    expect(save.config.assets).toEqual({ ornamentTop: "orn0000001" });
    expect(Object.keys(save.config).sort()).toEqual(["assets", "gallery", "hero", "layout", "sections", "templateId", "texts", "theme"]);
  });

  it("Luna Bridal: a note that publishing needs Luna Bridal Custom, and Publish is disabled", async () => {
    mockApi(WORKSPACE("bridal-basic"));
    await invitationDesignView(el, ctx, "biz-wed");
    await flush();
    expect(el.querySelector('[data-role="not-entitled"]').textContent).toMatch(/publishing needs Luna Bridal Custom/);
    expect(el.querySelector('[data-act="publish"]').disabled).toBe(true);
  });
});
