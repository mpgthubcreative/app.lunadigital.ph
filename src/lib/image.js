// Photos and screenshots, one path for every Luna upload (2026-10-21).
// The file's first bytes say what it is (never the name or the type the
// phone claims). JPEG, PNG, WebP and iPhone HEIC / HEIF photos are opened,
// turned upright, shrunk and re-encoded as a fresh JPEG in the browser,
// so only that JPEG is uploaded (never the original HEIC, and no EXIF /
// location data). The server still checks the real type and size.
//
// HEIC: Safari opens it itself. Other browsers load the converter
// (heic-to, its own chunk) only when a HEIC photo is chosen.

import { sniffImageType, isHeif } from "@shared/image-type.js";

// What a photo input offers. Listing HEIC / HEIF (and the extensions, for
// pickers that ignore types) keeps iPhone and Android photos selectable.
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif";
export const PHOTO_OR_PDF_ACCEPT = `${PHOTO_ACCEPT},application/pdf,.pdf`;

export const NOT_A_PHOTO = "That file isn't a photo. Choose a photo or screenshot from your phone or computer.";
export const PHOTO_DAMAGED = "That photo couldn't be opened. It may be damaged; try another photo.";

const MAX_SIDE = 1600;

async function readBytes(blob, n) {
  const part = blob.slice(0, n);
  if (typeof part.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsArrayBuffer(part);
  });
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the file"));
    reader.readAsDataURL(blob);
  });
}

// The real type of a chosen file: an image type, "application/pdf", or null.
export async function fileKind(file) {
  if (!file) return null;
  const head = await readBytes(file, 64);
  if (head.length > 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "application/pdf";
  return sniffImageType(head);
}

// Something the canvas can draw, upright (EXIF / HEIF rotation applied).
async function decode(file, kind) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* this browser can't open it natively: try below */
    }
  }
  if (typeof URL?.createObjectURL === "function") {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      if (img.naturalWidth) return img;
    } catch {
      /* not openable here */
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
  if (isHeif(kind)) {
    try {
      const { heicTo } = await import("heic-to/csp");
      return await heicTo({ blob: file, type: "bitmap" });
    } catch {
      return null;
    }
  }
  return null;
}

const toBlob = (canvas, quality) => new Promise((resolve) => (canvas.toBlob ? canvas.toBlob(resolve, "image/jpeg", quality) : resolve(null)));

// File -> a JPEG Blob at most maxSide px on its longest side (and, when
// maxBytes is given, under it: quality, then size, step down).
export async function normalizePhoto(file, { maxSide = MAX_SIDE, quality = 0.82, maxBytes = 0 } = {}) {
  const kind = await fileKind(file);
  if (!kind || kind === "application/pdf") throw new Error(NOT_A_PHOTO);
  const img = await decode(file, kind);
  const w = img?.naturalWidth || img?.width;
  const h = img?.naturalHeight || img?.height;
  if (!w || !h) throw new Error(PHOTO_DAMAGED);
  let side = Math.min(maxSide, Math.max(w, h));
  let q = quality;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = side / Math.max(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(PHOTO_DAMAGED);
    ctx.fillStyle = "#fff"; // a transparent PNG becomes white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas, q);
    if (!blob) throw new Error(PHOTO_DAMAGED);
    if (!maxBytes || blob.size <= maxBytes) {
      img.close?.();
      return blob;
    }
    if (q > 0.62) q -= 0.1;
    else side = Math.round(side * 0.8);
  }
  img.close?.();
  throw new Error("That photo is too large even after shrinking; try another photo");
}

// A photo as a small JPEG data URL (Bridal cover / gallery).
export async function photoDataUrl(file, { maxSide = 1200, quality = 0.8, maxChars = 0 } = {}) {
  return readAsDataUrl(await normalizePhoto(file, { maxSide, quality, maxBytes: maxChars ? Math.floor((maxChars - 40) * 0.75) : 0 }));
}

// File -> { contentType, dataBase64 } ready for the proof uploads
// (payments, subscription, payroll, advances, expenses).
export async function prepareProof(file, { pdf = false } = {}) {
  if (!file) return null;
  const kind = await fileKind(file);
  // Payroll / advance / expense proofs may be a PDF (sent as is; the server
  // checks it really is one).
  if (kind === "application/pdf") {
    if (!pdf) throw new Error("Choose a photo or screenshot (not a PDF)");
    if (file.size > 2_400_000) throw new Error("That PDF is too large (max 2.4 MB)");
    const url = await readAsDataUrl(file);
    return { contentType: "application/pdf", dataBase64: url.slice(url.indexOf(",") + 1) };
  }
  if (!kind) throw new Error(pdf ? "That file isn't a photo, screenshot or PDF. Choose one of those." : NOT_A_PHOTO);
  const url = await readAsDataUrl(await normalizePhoto(file, { maxSide: MAX_SIDE, quality: 0.82, maxBytes: 2_300_000 }));
  return { contentType: "image/jpeg", dataBase64: url.slice(url.indexOf(",") + 1) };
}

// A Custom invitation design image (Super Admin) as a data URL, typed by
// its bytes: a PNG / WebP / JPEG up to ~500 KB goes as is (a PNG keeps its
// transparency); a larger JPEG / WebP or any HEIC photo becomes a JPEG; an
// SVG goes as is (the server refuses active content).
const ASSET_MAX_BYTES = 500_000;
export async function designAssetDataUrl(file) {
  const kind = await fileKind(file);
  if (!kind && (file.type === "image/svg+xml" || /\.svg$/i.test(file.name || ""))) {
    const url = await readAsDataUrl(file);
    return `data:image/svg+xml;base64,${url.slice(url.indexOf(",") + 1)}`;
  }
  if (!kind || kind === "application/pdf") throw new Error(NOT_A_PHOTO);
  if (!isHeif(kind) && file.size <= ASSET_MAX_BYTES) {
    const url = await readAsDataUrl(file);
    return `data:${kind};base64,${url.slice(url.indexOf(",") + 1)}`;
  }
  if (kind === "image/png") throw new Error("That PNG is larger than 500 KB; save a smaller one (a JPEG photo is shrunk for you)");
  return photoDataUrl(file, { maxSide: 2000, quality: 0.85, maxChars: 690_000 });
}
