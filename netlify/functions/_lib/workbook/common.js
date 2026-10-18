// Small helpers shared by the Download Excel sheet builders.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

// A pay period as people say it: "Oct 16–31, 2026", "Sep 30 – Oct 14,
// 2026", "Dec 16, 2026 – Jan 15, 2027".
export function periodText(start, end) {
  if (typeof start !== "string" || typeof end !== "string") return "";
  const y1 = start.slice(0, 4);
  const y2 = end.slice(0, 4);
  if (y1 !== y2) return `${md(start)}, ${y1} – ${md(end)}, ${y2}`;
  if (start === end) return `${md(start)}, ${y1}`;
  if (start.slice(0, 7) === end.slice(0, 7)) return `${md(start)}–${Number(end.slice(8, 10))}, ${y1}`;
  return `${md(start)} – ${md(end)}, ${y1}`;
}

// A stored time -> its business-local day (YYYY-MM-DD), or null.
export function dayOf(v, timezone = "Asia/Manila") {
  const d = v instanceof Date ? v : v && typeof v.toDate === "function" ? v.toDate() : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export const byText = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "en", { sensitivity: "base" });
export const yesNo = (v) => (v === true ? "Yes" : v === false ? "No" : "");
