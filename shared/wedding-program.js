// Owner-pilot Bridal: Music & Program. The couple's ceremony and reception
// sequence: what happens next, and what song plays.
//   weddingProgram/{itemId}  (server-only; read and written through
//   /api/wedding-program)
//     { section: "ceremony" | "reception", order, moment, song, durationSec,
//       person, notes, schemaVersion, createdBy/At, updatedBy/At }
// Order is an integer per section (gaps allowed); Move up / down swaps two
// neighbours. Kept plain so later passes can add song links (Spotify /
// YouTube), a printable / shareable program, a total running time, a
// coordinator view and music cues without reshaping the records.

import { WeddingError } from "./wedding.js";

export const PROGRAM_SCHEMA_VERSION = 1;
export const PROGRAM_SECTIONS = Object.freeze({ ceremony: { label: "Ceremony" }, reception: { label: "Reception" } });
export const PROGRAM_MAX_ITEMS = 200;
export const PROGRAM_MAX_DURATION = 24 * 3600;
const LIMITS = { moment: 60, song: 120, person: 80, notes: 500 };
const FIELDS = ["section", "moment", "song", "durationSec", "person", "notes"];

// Common moments, no songs attached (Sample Program). + Add makes one item.
export const SAMPLE_PROGRAM = Object.freeze({
  ceremony: Object.freeze(["Prelude (guests seated)", "Groom entrance", "Entourage entrance", "Bride entrance", "Ring exchange", "Signing", "Recessional"]),
  reception: Object.freeze(["Guest waiting", "Entourage entrance", "Couple entrance", "Introduction", "First dance", "Mother & son dance", "Father & daughter dance", "Cake & wine", "Speeches", "Same-day edit (SDE)", "Couple thank-you", "After party"]),
});

const clean = (v, field, max, required = false) => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw new WeddingError("invalid-input", `${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new WeddingError("invalid-input", `${field} must be text`);
  const t = v.trim().replace(/[ \t]+/g, " ");
  if (t.length > max) throw new WeddingError("invalid-input", `${field} must be ${max} characters or fewer`);
  return t;
};

// "4:17" -> 257, "1:00:00" -> 3600, "3" -> 180 (minutes), "" -> null.
export function parseDuration(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  let sec = null;
  if (/^\d{1,3}$/.test(s)) sec = Number(s) * 60;
  else if (/^\d{1,3}:[0-5]\d$/.test(s)) {
    const [m, x] = s.split(":").map(Number);
    sec = m * 60 + x;
  } else if (/^\d{1,2}:[0-5]\d:[0-5]\d$/.test(s)) {
    const [h, m, x] = s.split(":").map(Number);
    sec = h * 3600 + m * 60 + x;
  }
  if (sec === null || sec > PROGRAM_MAX_DURATION) throw new WeddingError("invalid-input", "Duration: use minutes:seconds, e.g. 4:17 (or 1:00:00)");
  return sec;
}
// 257 -> "4:17", 3600 -> "1:00:00", null -> "—".
export function formatDuration(sec) {
  if (!Number.isSafeInteger(sec) || sec < 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const x = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
}

export function validateProgramItem(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WeddingError("invalid-input", "Invalid program item");
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new WeddingError("invalid-input", `Field ${k} can't be set here`);
  const has = (k) => !partial || Object.hasOwn(input, k);
  const out = {};
  if (has("section")) {
    if (!Object.hasOwn(PROGRAM_SECTIONS, input.section)) throw new WeddingError("invalid-input", "Choose Ceremony or Reception");
    out.section = input.section;
  }
  if (has("moment")) out.moment = clean(input.moment, "Moment", LIMITS.moment, true);
  for (const k of ["song", "person", "notes"]) if (has(k)) out[k] = clean(input[k], k[0].toUpperCase() + k.slice(1), LIMITS[k]);
  if (has("durationSec")) {
    const d = input.durationSec;
    if (d !== null && d !== undefined && !(Number.isSafeInteger(d) && d >= 0 && d <= PROGRAM_MAX_DURATION)) throw new WeddingError("invalid-input", "Invalid duration");
    out.durationSec = d ?? null;
  }
  if (partial && !Object.keys(out).length) throw new WeddingError("invalid-input", "Nothing to change");
  return out;
}

// Items of one section, in program order.
export const programSection = (items, section) => (items || []).filter((i) => i.section === section).sort((a, b) => a.order - b.order || String(a.moment).localeCompare(String(b.moment)));
