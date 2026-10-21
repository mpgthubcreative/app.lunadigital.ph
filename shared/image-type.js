// What an image really is, from its first bytes (2026-10-21). One check for
// the browser (before converting a photo) and the server (before storing
// one): never the file name or the type the browser claims, which phones
// leave empty or set to anything.
//
// Luna stores JPEG, PNG and WebP. HEIC / HEIF (iPhone photos) are
// recognised so the browser can convert them to JPEG first; the server
// never accepts them.

export const STORED_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

// HEIF brands (ISO/IEC 23008-12). AVIF uses the same box but isn't a phone
// photo format Luna converts.
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "mif2"]);

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));

// bytes: Uint8Array or Buffer (the first 64 bytes are enough).
// -> "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif" | null
export function sniffImageType(bytes) {
  const b = bytes;
  if (!b || typeof b.length !== "number") return null;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 16 && ascii(b, 4, 8) === "ftyp") {
    // The ftyp box: size, "ftyp", major brand, minor version, compatible brands.
    const size = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
    const brands = [ascii(b, 8, 12)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, i + 4));
    if (brands.some((x) => HEIC_BRANDS.has(x))) return "image/heic";
    if (brands[0] !== "avif" && brands.some((x) => HEIF_BRANDS.has(x))) return "image/heif";
  }
  return null;
}

export const isHeif = (type) => type === "image/heic" || type === "image/heif";

// "data:image/jpeg;base64,..." -> the type, only when the bytes really are
// that stored type; otherwise null.
export function dataUrlImageType(dataUrl) {
  const m = typeof dataUrl === "string" ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  if (!m) return null;
  const head = base64Head(m[2].slice(0, 88));
  return head && sniffImageType(head) === m[1] ? m[1] : null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Head(s) {
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    if (ch === "=") break;
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
