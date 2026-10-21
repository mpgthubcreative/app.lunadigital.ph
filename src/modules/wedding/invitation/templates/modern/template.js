// Modern: white, full-width, left-aligned, a full-bleed photo.
export default {
  id: "modern",
  label: "Modern",
  description: "Clean and minimal: white, left-aligned, a full-width photo.",
  theme: { background: "#ffffff", card: "#ffffff", text: "#1d1d1f", muted: "#6e6e73", accent: "#1d1d1f", accentText: "#ffffff", border: "#e5e5ea", headingFont: "Josefin Sans", bodyFont: "Inter", scriptFont: "Josefin Sans" },
  layout: { cardWidth: "wide", spacing: "airy", align: "left", corners: "square", buttonStyle: "square", frame: "full", namesCase: "upper" },
  hero: { style: "full-bleed" },
  order: ["hero", "welcome", "ceremony", "reception", "map", "dressCode", "gallery", "faq", "rsvp", "footer", "story", "entourage"],
  show: ["hero", "welcome", "ceremony", "reception", "map", "dressCode", "gallery", "rsvp", "footer"],
  gallery: { style: "carousel" },
};
