// Luna Standard: the original Luna Bridal invitation (warm ivory, one card,
// names in capitals). Every wedding without another choice uses it.
export default {
  id: "standard",
  label: "Luna Standard",
  description: "Warm ivory, one elegant card. The original Luna invitation.",
  tier: "standard",
  theme: { background: "#f6f1ea", card: "#fffdf9", text: "#3b3430", muted: "#7b6f66", accent: "#8a6d4b", accentText: "#fffdf9", border: "#e8dccb", headingFont: "Cormorant Garamond", bodyFont: "Inter", scriptFont: "Cormorant Garamond" },
  layout: { cardWidth: "normal", spacing: "normal", align: "center", corners: "square", buttonStyle: "pill", frame: "card", namesCase: "upper" },
  hero: { style: "photo-below-names" },
  order: ["hero", "welcome", "ceremony", "reception", "dressCode", "rsvp", "story", "map", "entourage", "gallery", "faq", "footer"],
  show: ["hero", "welcome", "ceremony", "reception", "dressCode", "rsvp"],
  gallery: { style: "grid" },
};
