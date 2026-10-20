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
