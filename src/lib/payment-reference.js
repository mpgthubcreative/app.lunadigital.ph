// Reading a payment reference off a screenshot (2026-10-20). Proof of a
// payment is the screenshot OR the reference number; when a screenshot is
// attached, Luna tries to read the reference from it and fills it in for the
// person to check and edit. If nothing can be read, the screenshot alone is
// still enough.
//
// The reader (Tesseract OCR) runs in the browser, from Luna's own domain
// (public/ocr/, copied at build by scripts/copy-ocr-assets.js): the
// screenshot never leaves the device for this. It's loaded only when a
// screenshot is attached.

// GCash "Ref No. 1234 567 891234", Maya "Reference ID 1A2B…", banks
// "Reference Number / Ref. # / Transaction ID / Trace No.". The reference is
// what follows the label on the same line (or the next line).
const LABEL = /\b(?:ref(?:erence)?\.?\s*(?:no\.?|number|num\.?|id|code|#)?|transaction\s*(?:no\.?|number|id|ref(?:erence)?)|trace\s*(?:no\.?|number)|confirmation\s*(?:no\.?|number|code))\s*[:#.\-]?\s*/i;
const CANDIDATE = /^[A-Z0-9][A-Z0-9 \-]{3,40}/i;
const clean = (v) => v.replace(/[\s\-]/g, "").toUpperCase();
// A reference has digits and is 6-30 characters once spaces / dashes go.
const plausible = (v) => /\d/.test(v) && v.length >= 6 && v.length <= 30 && !/^(19|20)\d{6}$/.test(v);

export function extractReference(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const m = LABEL.exec(lines[i]);
    if (!m) continue;
    for (const rest of [lines[i].slice(m.index + m[0].length), lines[i + 1] ?? ""]) {
      const c = CANDIDATE.exec(rest.trim());
      // Stop at the first word that isn't part of the number ("1234 567 891234 Jun 5" → digits only).
      const value = c ? clean(c[0].split(/\s+(?=[A-Za-z]{3,})/)[0]) : "";
      if (plausible(value)) return value;
    }
  }
  // GCash's 13-digit reference without its label (4-3-6 digits).
  const g = /\b(\d{4})\s?(\d{3})\s?(\d{6})\b/.exec(text);
  return g ? `${g[1]}${g[2]}${g[3]}` : null;
}

// The whole payment off a confirmation screenshot (2026-10-26): amount,
// reference, and the method / date when they're clear. Only a suggestion:
// the customer checks and edits it, and the server and the business decide.
//   { amount: centavos | null, reference, method: "gcash" | "maya" | "bank_transfer" | null, date: "YYYY-MM-DD" | null }
const MONEY = /(?:₱|php|p)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\b/gi;
const LABELLED_AMOUNT = /\b(total\s+amount(?:\s+sent|\s+paid)?|amount(?:\s+sent|\s+paid|\s+transferred)?|total|you\s+sent|sent)\b\s*[:\-]?\s*(?:₱|php|p)?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/i;
const toCentavos = (whole, cents) => {
  const n = Number(String(whole).replace(/,/g, "")) * 100 + Number(cents || 0);
  return Number.isSafeInteger(n) && n > 0 && n < 100_000_000_00 ? n : null;
};
export function extractAmount(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // A labelled amount wins ("Total Amount Sent ₱145.00"), on its line or the next.
  for (let i = 0; i < lines.length; i += 1) {
    if (/\bfee\b|\bbalance\b|\bcharge\b/i.test(lines[i])) continue;
    const m = LABELLED_AMOUNT.exec(lines[i]) || (/^(total\s+amount|amount)(\s+sent|\s+paid)?\s*:?$/i.test(lines[i]) ? LABELLED_AMOUNT.exec(`${lines[i]} ${lines[i + 1] ?? ""}`) : null);
    const v = m ? toCentavos(m[2], m[3]) : null;
    if (v) return v;
  }
  // Else the first peso amount that isn't a fee / balance line.
  for (const line of lines) {
    if (/\bfee\b|\bbalance\b|\bcharge\b/i.test(line)) continue;
    for (const m of line.matchAll(MONEY)) {
      const v = toCentavos(m[1], m[2]);
      if (v) return v;
    }
  }
  return null;
}
export function extractMethod(text) {
  if (typeof text !== "string") return null;
  const gcash = /\bg\s?cash\b/i.test(text);
  const maya = /\b(?:pay)?maya\b/i.test(text);
  if (gcash && !maya) return "gcash";
  if (maya && !gcash) return "maya";
  if (!gcash && !maya && /\b(?:instapay|pesonet|bdo|bpi|metrobank|landbank|unionbank|security\s?bank|rcbc|chinabank|pnb|eastwest|bank\s+transfer|fund\s+transfer)\b/i.test(text)) return "bank_transfer";
  return null;
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function extractDate(text) {
  if (typeof text !== "string") return null;
  const day = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2100 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);
  const w = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text);
  if (w) return day(Number(w[3]), MONTHS[w[1].toLowerCase()], Number(w[2]));
  const n = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text); // Philippine apps: MM/DD/YYYY
  if (n) return day(Number(n[3]), Number(n[1]), Number(n[2]));
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  return iso ? day(Number(iso[1]), Number(iso[2]), Number(iso[3])) : null;
}
export function extractPayment(text) {
  const out = { amount: extractAmount(text), reference: extractReference(text), method: extractMethod(text), date: extractDate(text) };
  return out.amount || out.reference ? out : null;
}

let reader = null;
async function getReader() {
  if (!reader) {
    reader = (async () => {
      const { createWorker } = await import("tesseract.js");
      return createWorker("eng", 1, { workerPath: "/ocr/worker.min.js", corePath: "/ocr", langPath: "/ocr", workerBlobURL: false, gzip: true, logger: () => {} });
    })().catch((err) => {
      reader = null;
      throw err;
    });
  }
  return reader;
}

// Starts loading the reader (~7 MB the first time, then cached) when someone
// is about to pick a screenshot, so the read itself is quick.
export function warmReader() {
  getReader().catch(() => {});
}

// The reference read from an image file, or null (never throws). The first
// read on a slow connection can take a while: up to a minute.
export async function detectReference(file, { timeoutMs = 60000, recognize = null } = {}) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type || "")) return null;
  try {
    const run = recognize ? recognize(file) : getReader().then((w) => w.recognize(file)).then((r) => r.data.text);
    const text = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve(""), timeoutMs))]);
    return extractReference(text);
  } catch {
    return null;
  }
}

// The payment read from an image file, or null (never throws).
export async function detectPayment(file, { timeoutMs = 60000, recognize = null } = {}) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type || "")) return null;
  try {
    const run = recognize ? recognize(file) : getReader().then((w) => w.recognize(file)).then((r) => r.data.text);
    const text = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve(""), timeoutMs))]);
    return extractPayment(text);
  } catch {
    return null;
  }
}

// Wires a form: when a screenshot is picked, read it and fill the
// Reference field if it's still empty (the person can edit it). Call from
// formDialog's onFormChange (runs on every change; binds once).
export function bindReferenceDetection(form, { file = "proof", reference = "reference", detect = detectReference, warm = warmReader } = {}) {
  const fileEl = form.elements[file];
  const refEl = form.elements[reference];
  if (!fileEl || !refEl || fileEl.dataset.readsReference) return;
  fileEl.dataset.readsReference = "1";
  // Tapping the screenshot field: start loading the reader while they choose.
  fileEl.addEventListener("click", () => warm(), { once: true });
  const hint = refEl.closest(".field")?.querySelector(".stat-hint");
  const say = (t) => {
    if (hint) hint.textContent = t;
  };
  fileEl.addEventListener("change", async () => {
    const f = fileEl.files?.[0];
    if (!f || refEl.value.trim()) return;
    say("Reading the reference from the screenshot…");
    const ref = await detect(f);
    if (ref && !refEl.value.trim()) {
      refEl.value = ref;
      refEl.dispatchEvent(new Event("input", { bubbles: true }));
      say("Read from the screenshot: check it and correct it if needed.");
    } else if (!ref) say("Couldn't read a reference. The screenshot alone is enough.");
  });
}
