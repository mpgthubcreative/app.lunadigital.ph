// Rustic Garden: sage and rust, Young Serif + Nunito Sans with a Pinyon
// Script line, leafy rules, the story told in chapters. Signature layout.
export default {
  id: "rustic",
  label: "Rustic Garden",
  description: "Sage and rust with leafy details; your story in chapters.",
  version: 1,
  // Offered to new invitations (Wedding Setup's design choice).
  offered: true,
  kind: "signature",
  variant: "rustic",
  theme: { background: "#ffffff", card: "#eef1e9", text: "#1a1a17", muted: "#5b6154", accent: "#b4532a", accentText: "#ffffff", border: "#8fa382", headingFont: "Young Serif", bodyFont: "Nunito Sans", scriptFont: "Pinyon Script" },
  layout: { cardWidth: "wide", spacing: "airy", align: "center", corners: "soft", buttonStyle: "pill", frame: "full", namesCase: "normal" },
  hero: { style: "full-bleed" },
  order: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"],
  show: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"],
  gallery: { style: "grid" },
  recommended: ["city", "ceremonyVenue", "ceremonyTime", "story", "schedule", "dressCode"],
  photoSlots: ["story1", "story2", "when", "venue", "dressCode"],
  wording: { intro: "Together with their families", tagline: "are getting married", countdownTitle: "Counting down the days", storyEyebrow: "how it began", storyTitle: "Our Love Story", detailsEyebrow: "join us", detailsTitle: "Wedding Details", scheduleTitle: "The Day", dressEyebrow: "what to wear", dressTitle: "Dress Code", rsvpEyebrow: "kindly reply", rsvpTitle: "RSVP", closing: "With love" },
  accents: [
    { id: "rust", label: "Rust", hex: "#b4532a" },
    { id: "olive", label: "Olive", hex: "#6b7a3a" },
    { id: "dusty-blue", label: "Dusty blue", hex: "#557089" },
    { id: "plum", label: "Plum", hex: "#7a4560" },
  ],
};
