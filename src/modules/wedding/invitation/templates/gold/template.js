// Gold Elegance: cream and antique gold, Cormorant Garamond + Mulish. A full
// "signature" page (hero card over the cover photo, countdown, story,
// details with the day's schedule, dress code with a palette, RSVP).
export default {
  id: "gold",
  label: "Gold Elegance",
  description: "Cream and antique gold, a countdown and the day's schedule.",
  version: 1,
  // Offered to new invitations (Wedding Setup's design choice).
  offered: true,
  kind: "signature",
  variant: "gold",
  theme: { background: "#f7f3ec", card: "#ffffff", text: "#363535", muted: "#6f6a63", accent: "#bd9627", accentText: "#ffffff", border: "#e4d8bf", headingFont: "Cormorant Garamond", bodyFont: "Mulish", scriptFont: "Cormorant Garamond" },
  layout: { cardWidth: "wide", spacing: "airy", align: "center", corners: "square", buttonStyle: "solid", frame: "full", namesCase: "normal" },
  hero: { style: "full-bleed" },
  order: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"],
  show: ["hero", "welcome", "story", "ceremony", "reception", "map", "dressCode", "entourage", "gallery", "faq", "rsvp", "footer"],
  gallery: { style: "grid" },
  recommended: ["city", "ceremonyVenue", "ceremonyTime", "story", "schedule", "dressCode"],
  photoSlots: ["story1", "story2", "when", "venue", "dressCode"],
  wording: { intro: "Together with their families", tagline: "Are getting married", countdownTitle: "Counting down to our day", storyEyebrow: "How it began", storyTitle: "Our Love Story", detailsEyebrow: "The celebration", detailsTitle: "Wedding Details", scheduleTitle: "The Day", dressEyebrow: "What to wear", dressTitle: "Dress Code", rsvpEyebrow: "Kindly reply", rsvpTitle: "RSVP", closing: "With love" },
  accents: [
    { id: "gold", label: "Antique gold", hex: "#bd9627" },
    { id: "rose", label: "Rose gold", hex: "#b7766b" },
    { id: "sage", label: "Sage", hex: "#7d8f69" },
    { id: "navy", label: "Navy", hex: "#2f4060" },
  ],
};
