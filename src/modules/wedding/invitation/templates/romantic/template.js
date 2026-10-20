// Romantic: blush and rose, a flowing script, rounded corners.
export default {
  id: "romantic",
  label: "Romantic",
  description: "Soft blush and rose with a flowing script and rounded details.",
  tier: "standard",
  theme: { background: "#f8eef0", card: "#fffafb", text: "#4a3236", muted: "#8c6f74", accent: "#b56576", accentText: "#ffffff", border: "#efd6db", headingFont: "Playfair Display", bodyFont: "Lato", scriptFont: "Great Vibes" },
  layout: { cardWidth: "normal", spacing: "airy", align: "center", corners: "round", buttonStyle: "pill", frame: "card", namesCase: "normal" },
  hero: { style: "framed" },
  order: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"],
  show: ["hero", "welcome", "story", "ceremony", "reception", "dressCode", "rsvp", "footer"],
  gallery: { style: "grid" },
};
