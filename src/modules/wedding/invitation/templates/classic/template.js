// Classic: serif headings, a script line, soft corners, a framed photo.
export default {
  id: "classic",
  label: "Classic",
  description: "Timeless serif lettering, a framed photo and a script line.",
  theme: { background: "#efe9df", card: "#ffffff", text: "#2d2a26", muted: "#6f675f", accent: "#7a5c3e", accentText: "#ffffff", border: "#ddd0bd", headingFont: "Playfair Display", bodyFont: "Lato", scriptFont: "Great Vibes" },
  layout: { cardWidth: "normal", spacing: "airy", align: "center", corners: "soft", buttonStyle: "solid", frame: "card", namesCase: "normal" },
  hero: { style: "framed" },
  order: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"],
  show: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "rsvp", "footer"],
  gallery: { style: "grid" },
};
