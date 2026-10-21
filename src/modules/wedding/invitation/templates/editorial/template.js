// Editorial: a magazine layout: wide, left-aligned, outline buttons.
export default {
  id: "editorial",
  label: "Editorial",
  description: "A magazine feel: wide, left-aligned, refined serif headlines.",
  theme: { background: "#f4f1ec", card: "#fbfaf7", text: "#1f1c1a", muted: "#6b645d", accent: "#9c6b3c", accentText: "#ffffff", border: "#d9d2c7", headingFont: "EB Garamond", bodyFont: "Montserrat", scriptFont: "EB Garamond" },
  layout: { cardWidth: "wide", spacing: "normal", align: "left", corners: "square", buttonStyle: "outline", frame: "full", namesCase: "upper" },
  hero: { style: "full-bleed" },
  order: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "faq", "rsvp", "footer", "entourage", "gallery"],
  show: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "faq", "rsvp", "footer"],
  gallery: { style: "stack" },
};
