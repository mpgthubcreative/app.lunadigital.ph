// The Bridal invitation registry: ONE list of every invitation design, for
// the guest page, the Owner's Wedding Setup, Super Admin and the server's
// validation (shared/invitation-design.js re-exports it). Designs are
// source code, never copied into a wedding: a wedding stores only a
// registered id (plus, for Luna Bridal Custom, Super Admin's overrides and
// draft / published state). Nothing anywhere picks a design by business or
// wedding: a wedding is given a design only through its registered id.
//
// Two categories, two folders (README.md):
//   templates/{id}/   "standard"    Luna Bridal: the Owner chooses one in
//                                   Wedding Setup (the free trial too)
//   customized/{id}/  "customized"  Luna Bridal Custom: Super Admin assigns
//                                   it in the design (Preview / Publish)
// Ids are permanent (weddings and designs store them).

import standard from "./templates/standard/template.js";
import classic from "./templates/classic/template.js";
import modern from "./templates/modern/template.js";
import romantic from "./templates/romantic/template.js";
import editorial from "./templates/editorial/template.js";
import garden from "./customized/garden/template.js";

export const CATEGORIES = Object.freeze({
  standard: { label: "Standard", availability: "Luna Bridal: the Owner chooses it in Wedding Setup (free trial: preview only)" },
  customized: { label: "Customized", availability: "Luna Bridal Custom: Super Admin assigns it, then previews and publishes" },
});

// id · name · category · source · availability, in the order they're shown.
export const TEMPLATE_REGISTRY = Object.freeze(
  [
    [standard, "standard"],
    [classic, "standard"],
    [modern, "standard"],
    [romantic, "standard"],
    [editorial, "standard"],
    [garden, "customized"],
  ].map(([file, category]) =>
    Object.freeze({
      id: file.id,
      name: file.label,
      category,
      source: `src/modules/wedding/invitation/${category === "standard" ? "templates" : "customized"}/${file.id}/template.js`,
      availability: CATEGORIES[category].availability,
      file,
    })
  )
);

// Every section an invitation can show, in the default order.
export const SECTION_IDS = Object.freeze(["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"]);

// A design file → the full defaults the design engine expects. `tier` is
// the older name of the category ("standard" / "custom"), kept because
// stored designs and the console read it.
function build({ file: t, category }) {
  const order = [...t.order, ...SECTION_IDS.filter((id) => !t.order.includes(id))];
  return Object.freeze({
    label: t.label,
    description: t.description,
    category,
    tier: category === "standard" ? "standard" : "custom",
    theme: { ...t.theme },
    layout: { ...t.layout },
    hero: { ...t.hero },
    sections: { order, visible: Object.fromEntries(SECTION_IDS.map((id) => [id, t.show.includes(id)])) },
    gallery: { ...t.gallery },
  });
}

export const TEMPLATES = Object.freeze(Object.fromEntries(TEMPLATE_REGISTRY.map((r) => [r.id, build(r)])));
export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));
export const DEFAULT_TEMPLATE_ID = "standard";
// What an Owner can choose in Wedding Setup (Luna Bridal and the trial).
export const STANDARD_TEMPLATE_IDS = Object.freeze(TEMPLATE_REGISTRY.filter((r) => r.category === "standard").map((r) => r.id));
export const CUSTOMIZED_TEMPLATE_IDS = Object.freeze(TEMPLATE_REGISTRY.filter((r) => r.category === "customized").map((r) => r.id));
export const getTemplate = (id) => TEMPLATES[id] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
export const isStandardTemplate = (id) => STANDARD_TEMPLATE_IDS.includes(id);
