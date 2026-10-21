// Garden: sage greens, the photo above the names. A Custom design template
// (Super Admin); existing designs that use it keep working.
export default {
  id: "garden",
  label: "Garden",
  description: "Sage greens with the photo above the names.",
  theme: { background: "#eef3ec", card: "#fbfdf9", text: "#2f3b2f", muted: "#66756a", accent: "#4f6f52", accentText: "#ffffff", border: "#d5e0d2", headingFont: "Cormorant Garamond", bodyFont: "Lato", scriptFont: "Parisienne" },
  layout: { cardWidth: "normal", spacing: "normal", align: "center", corners: "round", buttonStyle: "pill", frame: "card", namesCase: "normal" },
  hero: { style: "photo-above-names" },
  order: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"],
  show: ["hero", "welcome", "story", "ceremony", "reception", "dressCode", "entourage", "gallery", "rsvp", "footer"],
  gallery: { style: "grid" },
};
