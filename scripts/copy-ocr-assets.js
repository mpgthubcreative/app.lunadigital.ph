// Copies the payment-screenshot reader (Tesseract OCR) into public/ocr/ so
// it's served from Luna's own domain (CSP: no third-party scripts or
// connections). Run before every build (npm "prebuild"); public/ocr/ is not
// committed. Only loaded when someone attaches a payment screenshot.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const out = join(process.cwd(), "public", "ocr");
mkdirSync(out, { recursive: true });
const tesseract = dirname(require.resolve("tesseract.js/package.json"));
const core = dirname(require.resolve("tesseract.js-core/package.json"));
const eng = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
const files = [
  [join(tesseract, "dist", "worker.min.js"), "worker.min.js"],
  // The browser picks one build (relaxed SIMD, SIMD or plain), text recognition only.
  ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"].map((f) => [join(core, f), f]),
  // The compact English model (integer "best"), ~3 MB.
  [join(eng, "4.0.0_best_int", "eng.traineddata.gz"), "eng.traineddata.gz"],
];
for (const [from, name] of files) copyFileSync(from, join(out, name));
console.log(`ocr assets: ${files.length} files → public/ocr/`);
