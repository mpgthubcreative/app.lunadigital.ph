import { describe, it, expect } from "vitest";
import { sniffImageType, dataUrlImageType, isHeif, STORED_IMAGE_TYPES } from "../../shared/image-type.js";
import { ftyp } from "../helpers/image-bytes.js";

const bytes = (...xs) => Uint8Array.from([...xs, ...Array(16).fill(0)]);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBPVP8 "].map((c) => c.charCodeAt(0)), Array(8).fill(0)));

describe("sniffImageType: the real type from the first bytes", () => {
  it("JPEG, PNG and WebP", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(Buffer.from(JPEG))).toBe("image/jpeg");
  });
  it("iPhone HEIC (heic / heix / hevc brands) and HEIF (mif1 / msf1)", () => {
    expect(sniffImageType(ftyp("heic", "mif1", "heic"))).toBe("image/heic");
    expect(sniffImageType(ftyp("heix", "mif1"))).toBe("image/heic");
    expect(sniffImageType(ftyp("mif1", "heic"))).toBe("image/heic"); // HEIF container holding HEVC
    expect(sniffImageType(ftyp("mif1", "miaf"))).toBe("image/heif");
    expect(sniffImageType(ftyp("msf1"))).toBe("image/heif");
  });
  it("not a photo Luna takes: AVIF, MP4, PDF, text, empty", () => {
    expect(sniffImageType(ftyp("avif", "mif1", "miaf"))).toBeNull();
    expect(sniffImageType(ftyp("isom", "mp41"))).toBeNull();
    expect(sniffImageType(Uint8Array.from([..."%PDF-1.7 hello"].map((c) => c.charCodeAt(0))))).toBeNull();
    expect(sniffImageType(Uint8Array.from([..."<svg onload=x>"].map((c) => c.charCodeAt(0))))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(null)).toBeNull();
  });
  it("Luna stores only JPEG, PNG and WebP; HEIC / HEIF are converted first", () => {
    expect(STORED_IMAGE_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(isHeif("image/heic") && isHeif("image/heif") && !isHeif("image/jpeg")).toBe(true);
  });
});

describe("dataUrlImageType: the label must match the bytes", () => {
  const url = (type, b) => `data:${type};base64,${Buffer.from(b).toString("base64")}`;
  it("accepts a real JPEG / PNG / WebP", () => {
    expect(dataUrlImageType(url("image/jpeg", JPEG))).toBe("image/jpeg");
    expect(dataUrlImageType(url("image/png", PNG))).toBe("image/png");
    expect(dataUrlImageType(url("image/webp", WEBP))).toBe("image/webp");
  });
  it("refuses a mislabelled, HEIC, SVG or non-image data URL", () => {
    expect(dataUrlImageType(url("image/png", JPEG))).toBeNull();
    expect(dataUrlImageType(url("image/jpeg", Buffer.from("ABC")))).toBeNull();
    expect(dataUrlImageType(url("image/heic", ftyp("heic")))).toBeNull();
    expect(dataUrlImageType(url("image/svg+xml", Buffer.from("<svg/>")))).toBeNull();
    expect(dataUrlImageType("data:text/html;base64,AAAA")).toBeNull();
    expect(dataUrlImageType(42)).toBeNull();
  });
});
