// Owner-pilot Bridal: ONE shared invitation engine, per-business design.
//
//   A. Wedding content     businesses/{bid}/weddingSetup/*  (Owner edits)
//   B. Invitation design   businesses/{bid}/invitationDesign/current
//                          businesses/{bid}/invitationAssets/{assetId}
//                          (Luna Super Admin edits; server-only)
//   C. Guest party         businesses/{bid}/guests/{id} + its secure token
//
// Plans: Luna Bridal (bridal-basic) = Standard invitation; Luna Bridal+
// (bridal-plus) = Customized invitation. The level comes from the PLAN, never
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
export const INVITATION_CONTENT_FIELDS = Object.freeze(["coupleNames", "weddingDate", "ceremonyTime", "ceremonyVenue", "ceremonyAddress", "ceremonyMap", "receptionTime", "receptionVenue", "receptionAddress", "receptionMap", "dressCode", "welcomeMessage", "rsvpDeadline", "story", "footerNote", "faq"]);
export const invitationContent = (setup) => Object.fromEntries(INVITATION_CONTENT_FIELDS.map((k) => [k, setup?.[k] ?? null]));
// The guest a Super Admin preview shows: never a real guest or link.
export const SAMPLE_GUEST = Object.freeze({ name: "Sample Guest", seats: 2, rsvp: "awaiting", confirmed: 0, roles: [] });

export const SECTION_IDS = Object.freeze(["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"]);
export const SECTION_LABELS = Object.freeze({ hero: "Hero (names, date, photo)", welcome: "Welcome message", story: "Our story", ceremony: "Ceremony", reception: "Reception", map: "Map links", dressCode: "Dress code", entourage: "Entourage (from Roles)", gallery: "Gallery", faq: "FAQ", rsvp: "RSVP", footer: "Footer" });
export const FONTS = Object.freeze(["Cormorant Garamond", "Playfair Display", "EB Garamond", "Libre Baskerville", "Great Vibes", "Dancing Script", "Parisienne", "Montserrat", "Lato", "Josefin Sans", "Poppins", "Inter"]);
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

const STANDARD_ORDER = ["hero", "welcome", "ceremony", "reception", "dressCode", "rsvp"];
const ALL_HIDDEN = Object.fromEntries(SECTION_IDS.map((id) => [id, false]));
// Built-in templates: complete defaults. "standard" IS today's invitation.
export const TEMPLATES = Object.freeze({
  standard: {
    label: "Standard (Luna)",
    theme: { background: "#f6f1ea", card: "#fffdf9", text: "#3b3430", muted: "#7b6f66", accent: "#8a6d4b", accentText: "#fffdf9", border: "#e8dccb", headingFont: "Cormorant Garamond", bodyFont: "Inter", scriptFont: "Cormorant Garamond" },
    layout: { cardWidth: "normal", spacing: "normal", align: "center", corners: "square", buttonStyle: "pill", frame: "card", namesCase: "upper" },
    hero: { style: "photo-below-names" },
    sections: { order: [...STANDARD_ORDER, "story", "map", "entourage", "gallery", "faq", "footer"], visible: { ...ALL_HIDDEN, hero: true, welcome: true, ceremony: true, reception: true, dressCode: true, rsvp: true } },
    gallery: { style: "grid" },
  },
  classic: {
    label: "Classic serif",
    theme: { background: "#efe9df", card: "#ffffff", text: "#2d2a26", muted: "#6f675f", accent: "#7a5c3e", accentText: "#ffffff", border: "#ddd0bd", headingFont: "Playfair Display", bodyFont: "Lato", scriptFont: "Great Vibes" },
    layout: { cardWidth: "normal", spacing: "airy", align: "center", corners: "soft", buttonStyle: "solid", frame: "card", namesCase: "normal" },
    hero: { style: "framed" },
    sections: { order: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"], visible: { ...ALL_HIDDEN, hero: true, welcome: true, story: true, ceremony: true, reception: true, map: true, dressCode: true, rsvp: true, footer: true } },
    gallery: { style: "grid" },
  },
  modern: {
    label: "Modern minimal",
    theme: { background: "#ffffff", card: "#ffffff", text: "#1d1d1f", muted: "#6e6e73", accent: "#1d1d1f", accentText: "#ffffff", border: "#e5e5ea", headingFont: "Josefin Sans", bodyFont: "Inter", scriptFont: "Josefin Sans" },
    layout: { cardWidth: "wide", spacing: "airy", align: "left", corners: "square", buttonStyle: "square", frame: "full", namesCase: "upper" },
    hero: { style: "full-bleed" },
    sections: { order: ["hero", "welcome", "ceremony", "reception", "map", "dressCode", "gallery", "faq", "rsvp", "footer", "story", "entourage"], visible: { ...ALL_HIDDEN, hero: true, welcome: true, ceremony: true, reception: true, map: true, dressCode: true, gallery: true, rsvp: true, footer: true } },
    gallery: { style: "carousel" },
  },
  garden: {
    label: "Garden",
    theme: { background: "#eef3ec", card: "#fbfdf9", text: "#2f3b2f", muted: "#66756a", accent: "#4f6f52", accentText: "#ffffff", border: "#d5e0d2", headingFont: "Cormorant Garamond", bodyFont: "Lato", scriptFont: "Parisienne" },
    layout: { cardWidth: "normal", spacing: "normal", align: "center", corners: "round", buttonStyle: "pill", frame: "card", namesCase: "normal" },
    hero: { style: "photo-above-names" },
    sections: { order: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"], visible: { ...ALL_HIDDEN, hero: true, welcome: true, story: true, ceremony: true, reception: true, dressCode: true, entourage: true, gallery: true, rsvp: true, footer: true } },
    gallery: { style: "grid" },
  },
});
export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

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
