// The Bridal invitation templates: ONE list for the guest page, the Owner's
// Wedding Setup, Super Admin's design editor and the server's validation
// (shared/invitation-design.js re-exports it). Templates are source code,
// never copied into a wedding: a wedding stores only its templateId (plus,
// for Luna Bridal Custom, Super Admin's overrides and draft / published
// state).
//
// To add a template: make templates/{id}/template.js (copy one) and add it
// below. Ids are permanent (weddings and designs store them).
//   tier "standard"  the Owner can choose it (Luna Bridal, the free trial too)
//   tier "custom"    Super Admin designs only (Luna Bridal Custom)

import standard from "./templates/standard/template.js";
import classic from "./templates/classic/template.js";
import modern from "./templates/modern/template.js";
import romantic from "./templates/romantic/template.js";
import editorial from "./templates/editorial/template.js";
import garden from "./templates/garden/template.js";

// Every section an invitation can show, in the default order.
export const SECTION_IDS = Object.freeze(["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"]);

// A template file → the full defaults the design engine expects.
function build(t) {
  const order = [...t.order, ...SECTION_IDS.filter((id) => !t.order.includes(id))];
  return Object.freeze({
    label: t.label,
    description: t.description,
    tier: t.tier,
    theme: { ...t.theme },
    layout: { ...t.layout },
    hero: { ...t.hero },
    sections: { order, visible: Object.fromEntries(SECTION_IDS.map((id) => [id, t.show.includes(id)])) },
    gallery: { ...t.gallery },
  });
}

const FILES = [standard, classic, modern, romantic, editorial, garden];
export const TEMPLATES = Object.freeze(Object.fromEntries(FILES.map((t) => [t.id, build(t)])));
export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));
export const DEFAULT_TEMPLATE_ID = "standard";
// What an Owner can choose in Wedding Setup (Luna Bridal and the trial).
export const STANDARD_TEMPLATE_IDS = Object.freeze(TEMPLATE_IDS.filter((id) => TEMPLATES[id].tier === "standard"));
export const getTemplate = (id) => TEMPLATES[id] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
export const isStandardTemplate = (id) => STANDARD_TEMPLATE_IDS.includes(id);
