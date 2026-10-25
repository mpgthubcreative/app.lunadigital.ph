// The Bridal invitation registry (2026-10-21): two obvious folders,
// templates/ (Standard: the Owner chooses) and customized/ (Luna Bridal
// Custom: Super Admin assigns), one registry, stable ids. Moving files must
// not change what any wedding shows.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { TEMPLATE_REGISTRY, SECTION_IDS, TEMPLATES, TEMPLATE_IDS, STANDARD_TEMPLATE_IDS, CUSTOMIZED_TEMPLATE_IDS, DEFAULT_TEMPLATE_ID, getTemplate, isStandardTemplate } from "../../src/modules/wedding/invitation/registry.js";
import * as shared from "../../shared/invitation-design.js";
import * as wedding from "../../shared/wedding.js";

const ROOT = `${process.cwd()}/src/modules/wedding/invitation`;

describe("invitation registry", () => {
  it("keeps every stored id (standard, classic, modern, romantic, editorial, garden) and adds gold, monochrome, rustic", () => {
    expect(TEMPLATE_IDS).toEqual(["standard", "classic", "modern", "romantic", "editorial", "gold", "monochrome", "rustic", "garden"]);
    expect(DEFAULT_TEMPLATE_ID).toBe("standard");
    expect(getTemplate(undefined)).toBe(TEMPLATES.standard); // no choice = the original Luna Standard
    expect(getTemplate("no-such-id")).toBe(TEMPLATES.standard);
  });
  it("two categories: Standard (Owner chooses) and Customized (Super Admin); Garden stays Custom-only", () => {
    expect(STANDARD_TEMPLATE_IDS).toEqual(["standard", "classic", "modern", "romantic", "editorial", "gold", "monochrome", "rustic"]);
    expect(CUSTOMIZED_TEMPLATE_IDS).toEqual(["garden"]);
    expect(isStandardTemplate("garden")).toBe(false);
    expect(TEMPLATES.garden.tier).toBe("custom"); // the older name, still read by stored designs / the console
    expect(STANDARD_TEMPLATE_IDS.every((id) => TEMPLATES[id].tier === "standard" && TEMPLATES[id].category === "standard")).toBe(true);
  });
  it("each entry names its id, name, category, source file (in the matching folder) and availability", () => {
    for (const r of TEMPLATE_REGISTRY) {
      expect(r.source).toBe(`src/modules/wedding/invitation/${r.category === "standard" ? "templates" : "customized"}/${r.id}/template.js`);
      expect(existsSync(`${process.cwd()}/${r.source}`), r.source).toBe(true);
      expect(r.name).toBe(TEMPLATES[r.id].label);
      expect(r.availability).toMatch(r.category === "standard" ? /Wedding Setup/ : /Super Admin/);
      expect(r.file.id).toBe(r.id);
    }
  });
  it("every design folder is registered (nothing hidden, nothing missing)", () => {
    const folders = [...readdirSync(`${ROOT}/templates`).map((d) => `templates/${d}`), ...readdirSync(`${ROOT}/customized`).map((d) => `customized/${d}`)];
    expect(folders.sort()).toEqual(TEMPLATE_REGISTRY.map((r) => r.source.replace("src/modules/wedding/invitation/", "").replace("/template.js", "")).sort());
  });
  it("design files hold presentation only: no customer content, no business / wedding ids", () => {
    for (const r of TEMPLATE_REGISTRY) {
      const src = readFileSync(`${process.cwd()}/${r.source}`, "utf8");
      expect(src, r.id).not.toMatch(/businessId|weddingId|guestId|coupleNames|weddingDate|\b20\d\d-\d\d-\d\d\b/);
      const ALLOWED = ["description", "gallery", "hero", "id", "label", "layout", "order", "show", "theme", "version", "kind", "variant", "recommended", "photoSlots", "wording", "accents", "showsWhenAdded"];
      for (const k of ["description", "gallery", "hero", "id", "label", "layout", "order", "show", "theme"]) expect(Object.keys(r.file), r.id).toContain(k);
      expect(Object.keys(r.file).filter((k) => !ALLOWED.includes(k)), r.id).toEqual([]);
    }
  });
  it("each design says which sections it shows; the README table matches (nothing dropped silently)", () => {
    const all = readFileSync(`${ROOT}/README.md`, "utf8");
    const readme = all.slice(all.indexOf("## Which sections each design shows"));
    const cols = ["story", "map", "entourage", "gallery", "faq", "footer"];
    for (const r of TEMPLATE_REGISTRY.filter((x) => x.id !== "standard")) {
      expect([...r.shows, ...r.doesNotShow].sort(), r.id).toEqual([...SECTION_IDS].sort());
      const row = readme.split("\n").find((l) => l.startsWith(`| \`${r.id}\``));
      expect(row, r.id).toBeTruthy();
      const cells = row.split("|").slice(2, 8).map((c) => !/no/.test(c));
      expect(cells, r.id).toEqual(cols.map((c) => r.shows.includes(c)));
    }
  });
  it("each entry: version, kind, preview image (in public/), required + recommended + used fields, photo slots, wording and accents", () => {
    const SETUP_FIELDS_ALL = new Set([...wedding.SETUP_FIELDS]);
    for (const r of TEMPLATE_REGISTRY) {
      expect(Number.isSafeInteger(r.version) && r.version >= 1, r.id).toBe(true);
      expect(["card", "signature"], r.id).toContain(r.kind);
      if (r.category === "standard") {
        expect(r.preview).toBe(`/invitations/previews/${r.id}.webp`);
        expect(existsSync(`${process.cwd()}/public${r.preview}`), r.preview).toBe(true);
      } else expect(r.preview).toBeNull();
      expect(r.required).toEqual(["coupleNames", "weddingDate"]);
      for (const k of [...r.uses, ...r.recommended]) expect(SETUP_FIELDS_ALL.has(k), `${r.id}: ${k}`).toBe(true);
      for (const k of r.recommended) expect(r.uses, `${r.id} recommends ${k} but doesn't show it`).toContain(k);
      for (const k of r.photoSlots) expect(Object.keys(shared.PHOTO_SLOTS)).toContain(k);
      expect(Object.keys(r.wording).length > 0 && Object.values(r.wording).every((v) => typeof v === "string" && v.length <= 80), r.id).toBe(true);
      for (const a of r.accents) expect(a.hex).toMatch(/^#[0-9a-f]{6}$/);
      for (const f of [r.file.theme.headingFont, r.file.theme.bodyFont, r.file.theme.scriptFont]) expect(shared.FONTS, `${r.id}: ${f}`).toContain(f);
    }
    // The three signature designs share one layout and every new field.
    for (const id of ["gold", "monochrome", "rustic"]) {
      const r = TEMPLATE_REGISTRY.find((x) => x.id === id);
      expect(r).toMatchObject({ kind: "signature", variant: id, category: "standard" });
      expect(r.uses).toEqual(expect.arrayContaining(["partner1Name", "city", "schedule", "palette", "attireNotes", "gettingThere", "reminders", "giftNote", "rsvpContact", "mealOptions"]));
      expect(shared.resolveDesign({ templateId: id })).toMatchObject({ kind: "signature", variant: id });
    }
    // The original six keep the card layout (what their weddings show is unchanged).
    for (const id of ["standard", "classic", "modern", "romantic", "editorial", "garden"]) expect(TEMPLATES[id].kind).toBe("card");
  });
  it("the shared module re-exports the same registry (one source)", () => {
    expect(shared.TEMPLATES).toBe(TEMPLATES);
    expect(shared.TEMPLATE_REGISTRY).toBe(TEMPLATE_REGISTRY);
    expect(shared.CUSTOMIZED_TEMPLATE_IDS).toBe(CUSTOMIZED_TEMPLATE_IDS);
  });
  it("no business-specific design logic in the app (designs are assigned only by registered id)", () => {
    const files = ["renderer.js", "preview.js", "registry.js"].map((f) => readFileSync(`${ROOT}/${f}`, "utf8"));
    for (const src of files) expect(src).not.toMatch(/businessId\s*===|weddingId\s*===/);
  });
});
