// Owner-pilot Bridal: ONE shared invitation engine, per-business design.
//
//   A. Wedding content     businesses/{bid}/weddingSetup/*  (Owner edits)
//   B. Invitation design   businesses/{bid}/invitationDesign/current
//                          businesses/{bid}/invitationAssets/{assetId}
//                          (Luna Super Admin edits; server-only)
//   C. Guest party         businesses/{bid}/guests/{id} + its secure token
//
// Plans: Luna Bridal (bridal-basic) = Standard invitation (the Owner picks
// one of the Standard templates; weddingSetup/current.templateId); Luna
// Bridal Custom (bridal-plus) = Customized invitation (Super Admin's design
// over any template). The level comes from the PLAN, never
// from a tenant id. Upgrading / downgrading only changes the plan: content,
// guests, tokens, slugs and design data are all kept.
//
// A design is a validated config over shared components (no raw HTML/CSS):
// a template supplies every default; the config overrides colours (hex),
// fonts (an allow-list of Google fonts), layout enums, hero style, the
// section order / visibility / per-section colours, asset references
// (uploaded images), a few wording lines and the gallery style. The page
// applies colours and fonts as CSS variables through the CSSOM.

export const INVITATION_LEVELS = Object.freeze({ standard: { label: "Standard Invitation" }, custom: { label: "Customized Invitation" } });
// Plan → invitation level (a plan property; new plans add a line here).
export const INVITATION_LEVEL_BY_PLAN = Object.freeze({ "bridal-plus": "custom" });
export const invitationLevelOf = (planId) => INVITATION_LEVEL_BY_PLAN[planId] ?? "standard";
export const PLAN_MARKETING_NAMES = Object.freeze({ "bridal-basic": "Luna Bridal", "bridal-plus": "Luna Bridal Custom" });

// The wedding details a guest's invitation shows: the ONLY Wedding Setup
// fields that leave the couple's workspace, for a guest link and for Luna
// Super Admin's invitation work (2026-10-20 privacy model).
// 2026-10-24: plus the generic profile fields any template may show.
export const INVITATION_CONTENT_FIELDS = Object.freeze(["coupleNames", "weddingDate", "ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap", "receptionTime", "receptionVenue", "receptionAddress", "receptionMap", "dressCode", "welcomeMessage", "rsvpDeadline", "story", "footerNote", "faq", "partner1Name", "partner2Name", "partner1Parents", "partner2Parents", "city", "sameVenue", "schedule", "gettingThere", "dressCodeDetails", "palette", "attireNotes", "reminders", "giftNote", "rsvpContact", "mealOptions", "askDietary"]);
// coupleNames: the names line ("Partner 1 & Partner 2" when not typed).
export const invitationContent = (setup) => ({ ...Object.fromEntries(INVITATION_CONTENT_FIELDS.map((k) => [k, setup?.[k] ?? null])), coupleNames: coupleDisplayName(setup) || null });
// The couple's wording / accent for the Standard template being shown
// (setup.templateOptions[templateId]); a Custom design uses its own texts.
export function templateOptionsFor(setup, look) {
  const d = look?.design;
  const id = d?.config ? (d.standard ? d.config.templateId : null) : DEFAULT_TEMPLATE_ID;
  const o = id ? setup?.templateOptions?.[id] : null;
  if (!o || typeof o !== "object") return null;
  const entry = getTemplateEntry(id);
  const wording = Object.fromEntries(Object.entries(o.wording && typeof o.wording === "object" ? o.wording : {}).filter(([k, v]) => Object.hasOwn(entry.wording, k) && typeof v === "string" && v));
  const accent = entry.accents.find((a) => a.id === o.accent)?.hex ?? null;
  return { wording, accent };
}
// The one invitation data contract (2026-10-21): what the renderer
// (src/modules/wedding/invitation/renderer.js) draws, for a guest's link,
// the Owner's Wedding Setup Preview and Super Admin's preview alike.
// look = { design, gallery, entourage } from the same server loader
// (liveDesignFor / previewDesign). Only the source (live / draft) and the
// guest (real / sample) differ.
// photos: the design's photo slots (look.photos); timezone: the business's,
// for the countdown.
export function invitationData({ setup, hero = null, guest, rsvpOpen, look = null, path = null, sample = false, timezone = null }) {
  const photos = look?.photos && typeof look.photos === "object" ? Object.fromEntries(Object.entries(look.photos).filter(([k, v]) => Object.hasOwn(PHOTO_SLOTS, k) && typeof v === "string")) : {};
  return {
    wedding: invitationContent(setup),
    hero: typeof hero === "string" ? hero : null,
    photos,
    options: templateOptionsFor(setup, look),
    ...(typeof timezone === "string" && timezone ? { timezone } : {}),
    guest,
    rsvpOpen: rsvpOpen === true,
    design: look?.design ?? null,
    gallery: Array.isArray(look?.gallery) ? look.gallery.filter((u) => typeof u === "string") : [],
    entourage: Array.isArray(look?.entourage) ? look.entourage : [],
    ...(path ? { path } : {}),
    ...(sample ? { sample: true } : {}),
  };
}
// The guest a Super Admin preview shows: never a real guest or link.
export const SAMPLE_GUEST = Object.freeze({ name: "Sample Guest", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [] });

export const SECTION_LABELS = Object.freeze({ hero: "Hero (names, date, photo)", welcome: "Welcome message", story: "Our story", ceremony: "Ceremony", reception: "Reception", map: "Map links", dressCode: "Dress code", entourage: "Entourage (from Roles)", gallery: "Gallery", faq: "FAQ", rsvp: "RSVP", footer: "Footer" });
export const FONTS = Object.freeze(["Cormorant Garamond", "Playfair Display", "EB Garamond", "Libre Baskerville", "Young Serif", "Great Vibes", "Dancing Script", "Parisienne", "Pinyon Script", "Montserrat", "Lato", "Josefin Sans", "Poppins", "Inter", "Mulish", "Jost", "Nunito Sans"]);
const ENUMS = Object.freeze({
  cardWidth: ["narrow", "normal", "wide"],
  spacing: ["compact", "normal", "airy"],
  align: ["center", "left"],
  corners: ["square", "soft", "round"],
  buttonStyle: ["pill", "outline", "solid", "square"],
  frame: ["card", "full"],
  namesCase: ["upper", "normal"],
  heroStyle: ["photo-below-names", "photo-above-names", "full-bleed", "framed", "none"],
  galleryStyle: ["grid", "stack", "carousel"],
});
export const DESIGN_ENUMS = ENUMS;
const COLOR_KEYS = ["background", "card", "text", "muted", "accent", "accentText", "border"];
const ASSET_SLOTS = ["pageBackground", "cardBackground", "heroOverlay", "ornamentTop", "ornamentBottom", "divider"];
export const ASSET_SLOT_LABELS = Object.freeze({ pageBackground: "Page background", cardBackground: "Card background", heroOverlay: "Hero frame / overlay", ornamentTop: "Top ornament", ornamentBottom: "Bottom ornament", divider: "Section divider" });
const TEXT_LIMITS = { scriptLine: 60, rsvpTitle: 30, footerLine: 120 };

// The designs live in src/modules/wedding/invitation/templates/{id}/
// (Standard) and customized/{id}/ (Luna Bridal Custom); registry.js is one
// list for the guest page, Wedding Setup, Super Admin and this validation.
// Nothing about a template is copied into a wedding.
export { TEMPLATES, TEMPLATE_IDS, TEMPLATE_REGISTRY, CATEGORIES as TEMPLATE_CATEGORIES, STANDARD_TEMPLATE_IDS, CUSTOMIZED_TEMPLATE_IDS, DEFAULT_TEMPLATE_ID, SECTION_IDS, PHOTO_SLOTS, LAYOUT_KINDS, getTemplate, getTemplateEntry, isStandardTemplate } from "../src/modules/wedding/invitation/registry.js";
import { TEMPLATES, TEMPLATE_IDS, SECTION_IDS, PHOTO_SLOTS, DEFAULT_TEMPLATE_ID, getTemplateEntry } from "../src/modules/wedding/invitation/registry.js";
import { coupleDisplayName } from "./wedding.js";

export class DesignError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid-design";
  }
}
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const HEX = /^#[0-9a-fA-F]{6}$/;
const ASSET_ID = /^[A-Za-z0-9]{6,40}$/;
const only = (o, keys, what) => {
  if (o === undefined) return {};
  if (!isObj(o)) throw new DesignError(`${what} must be an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new DesignError(`${what}: unknown setting ${k}`);
  return o;
};

// The full design: template defaults + the stored overrides.
export function resolveDesign(config) {
  const c = isObj(config) ? config : {};
  const t = TEMPLATES[c.templateId] || TEMPLATES.standard;
  const visible = { ...t.sections.visible, ...(isObj(c.sections?.visible) ? c.sections.visible : {}) };
  const order = Array.isArray(c.sections?.order) ? [...c.sections.order, ...SECTION_IDS.filter((id) => !c.sections.order.includes(id))] : [...t.sections.order];
  return {
    templateId: TEMPLATES[c.templateId] ? c.templateId : "standard",
    // the template's layout ("card" / "signature"); never stored
    kind: t.kind,
    variant: t.variant,
    theme: { ...t.theme, ...(isObj(c.theme) ? c.theme : {}) },
    layout: { ...t.layout, ...(isObj(c.layout) ? c.layout : {}) },
    hero: { ...t.hero, ...(isObj(c.hero) ? c.hero : {}) },
    sections: { order, visible, styles: isObj(c.sections?.styles) ? c.sections.styles : {} },
    assets: isObj(c.assets) ? c.assets : {},
    texts: isObj(c.texts) ? c.texts : {},
    gallery: { ...t.gallery, ...(isObj(c.gallery) ? c.gallery : {}) },
  };
}

// A design config as stored (Super Admin input), or a DesignError.
export function validateDesignConfig(input) {
  const c = only(input, ["templateId", "theme", "layout", "hero", "sections", "assets", "texts", "gallery"], "Design");
  const out = {};
  if (c.templateId !== undefined) {
    if (!TEMPLATE_IDS.includes(c.templateId)) throw new DesignError("Choose a template");
    out.templateId = c.templateId;
  }
  const theme = only(c.theme, [...COLOR_KEYS, "headingFont", "bodyFont", "scriptFont"], "Theme");
  if (Object.keys(theme).length) {
    out.theme = {};
    for (const [k, v] of Object.entries(theme)) {
      if (COLOR_KEYS.includes(k)) {
        if (typeof v !== "string" || !HEX.test(v)) throw new DesignError(`Theme ${k}: a colour like #8a6d4b`);
        out.theme[k] = v.toLowerCase();
      } else {
        if (!FONTS.includes(v)) throw new DesignError(`Theme ${k}: choose one of the listed fonts`);
        out.theme[k] = v;
      }
    }
  }
  const layout = only(c.layout, Object.keys(ENUMS).filter((k) => !["heroStyle", "galleryStyle"].includes(k)), "Layout");
  if (Object.keys(layout).length) {
    out.layout = {};
    for (const [k, v] of Object.entries(layout)) {
      if (!ENUMS[k].includes(v)) throw new DesignError(`Layout ${k}: one of ${ENUMS[k].join(", ")}`);
      out.layout[k] = v;
    }
  }
  const hero = only(c.hero, ["style"], "Hero");
  if (hero.style !== undefined) {
    if (!ENUMS.heroStyle.includes(hero.style)) throw new DesignError("Hero style: choose one of the listed styles");
    out.hero = { style: hero.style };
  }
  const sections = only(c.sections, ["order", "visible", "styles"], "Sections");
  if (Object.keys(sections).length) {
    out.sections = {};
    if (sections.order !== undefined) {
      if (!Array.isArray(sections.order) || sections.order.length !== SECTION_IDS.length || new Set(sections.order).size !== SECTION_IDS.length || !sections.order.every((id) => SECTION_IDS.includes(id))) throw new DesignError("Section order must list every section once");
      out.sections.order = [...sections.order];
    }
    if (sections.visible !== undefined) {
      const v = only(sections.visible, SECTION_IDS, "Section visibility");
      for (const [k, on] of Object.entries(v)) if (typeof on !== "boolean") throw new DesignError(`Section ${k}: shown or hidden`);
      if (v.rsvp === false) throw new DesignError("The RSVP section can't be hidden");
      out.sections.visible = { ...v };
    }
    if (sections.styles !== undefined) {
      const st = only(sections.styles, SECTION_IDS, "Section styles");
      out.sections.styles = {};
      for (const [id, s] of Object.entries(st)) {
        const one = only(s, ["background", "text", "backgroundAsset"], `Section ${id}`);
        const o = {};
        for (const k of ["background", "text"]) if (one[k] !== undefined && one[k] !== null) {
          if (!HEX.test(one[k])) throw new DesignError(`Section ${id} ${k}: a colour like #ffffff`);
          o[k] = one[k].toLowerCase();
        }
        if (one.backgroundAsset !== undefined && one.backgroundAsset !== null) {
          if (!ASSET_ID.test(one.backgroundAsset)) throw new DesignError(`Section ${id}: invalid image`);
          o.backgroundAsset = one.backgroundAsset;
        }
        if (Object.keys(o).length) out.sections.styles[id] = o;
      }
    }
  }
  const assets = only(c.assets, ASSET_SLOTS, "Assets");
  if (Object.keys(assets).length) {
    out.assets = {};
    for (const [k, v] of Object.entries(assets)) {
      if (v === null) continue;
      if (typeof v !== "string" || !ASSET_ID.test(v)) throw new DesignError(`Asset ${k}: invalid image`);
      out.assets[k] = v;
    }
  }
  const texts = only(c.texts, Object.keys(TEXT_LIMITS), "Texts");
  if (Object.keys(texts).length) {
    out.texts = {};
    for (const [k, v] of Object.entries(texts)) {
      if (v === null || v === "") continue;
      if (typeof v !== "string" || v.trim().length > TEXT_LIMITS[k]) throw new DesignError(`${k}: up to ${TEXT_LIMITS[k]} characters`);
      out.texts[k] = v.trim();
    }
  }
  const gallery = only(c.gallery, ["style"], "Gallery");
  if (gallery.style !== undefined) {
    if (!ENUMS.galleryStyle.includes(gallery.style)) throw new DesignError("Gallery style: grid, stack or carousel");
    out.gallery = { style: gallery.style };
  }
  return out;
}

// Every asset id a config uses (to send with it / to refuse deleting it).
export function assetIdsOf(config) {
  const d = resolveDesign(config);
  return [...new Set([...Object.values(d.assets), ...Object.values(d.sections.styles).map((s) => s.backgroundAsset).filter(Boolean)])];
}
// Fonts a design needs from Google Fonts.
export const fontsOf = (d) => [...new Set([d.theme.headingFont, d.theme.bodyFont, d.theme.scriptFont])].filter((f) => FONTS.includes(f));

// What the Owner sees in Wedding Setup → Invitation.
export function invitationStatus({ planId, design }) {
  const level = invitationLevelOf(planId);
  const d = design || {};
  const published = Boolean(d.published?.config);
  const customLive = level === "custom" && d.live === "custom" && published;
  return {
    level,
    planName: PLAN_MARKETING_NAMES[planId] ?? null,
    live: customLive ? "custom" : "standard",
    draftState: d.draft ? d.draft.state || "draft" : null,
    publishedVersion: published ? d.published.version : null,
    hasDraft: Boolean(d.draft?.config),
    // kept (not deleted) on a downgrade so an upgrade can bring it back
    preservedCustom: level !== "custom" && published,
  };
}
