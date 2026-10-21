// @vitest-environment jsdom
// One photo path for every Luna upload (src/lib/image.js): typed by bytes,
// HEIC / HEIF converted to JPEG, damaged and non-photo files refused.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ftyp } from "../helpers/image-bytes.js";

const heicTo = vi.fn();
vi.mock("heic-to/csp", () => ({ heicTo }));
const { normalizePhoto, prepareProof, photoDataUrl, designAssetDataUrl, fileKind, NOT_A_PHOTO, PHOTO_DAMAGED, PHOTO_ACCEPT } = await import("../../src/lib/image.js");

const pad = (xs) => Uint8Array.from([...xs, ...Array(40).fill(7)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = pad([..."RIFF\0\0\0\0WEBPVP8 "].map((c) => c.charCodeAt(0)));
const HEIC = ftyp("heic", "mif1", "heic");
const HEIF = ftyp("mif1", "miaf");
const file = (bytes, type = "", name = "photo") => new File([bytes], name, { type });

let bitmap; // what createImageBitmap does: a bitmap, or throws (can't open)
let jpegSizes; // the sizes toBlob returns, in turn
beforeEach(() => {
  bitmap = () => ({ width: 4032, height: 3024, close: vi.fn() });
  jpegSizes = [];
  globalThis.createImageBitmap = vi.fn(async () => bitmap());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: "" }));
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb, type) {
    cb(new Blob([new Uint8Array(jpegSizes.shift() ?? 1000)], { type }));
  });
  // jsdom never loads an <img>: "can't open" unless a test says otherwise.
  globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.stubGlobal("Image", class {
    set src(_) {
      setTimeout(() => this.onerror?.(new Error("can't open")), 0);
    }
  });
  heicTo.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("which files are photos (by their bytes, not the name or claimed type)", () => {
  it("offers HEIC / HEIF in the picker", () => {
    expect(PHOTO_ACCEPT).toMatch(/image\/heic/);
    expect(PHOTO_ACCEPT).toMatch(/\.heif/);
  });
  it.each([["JPG", JPEG, "image/jpeg"], ["JPEG with an empty type", JPEG, ""], ["PNG", PNG, "image/png"], ["WebP", WEBP, "image/webp"], ["HEIC", HEIC, "image/heic"], ["HEIF with an odd type", HEIF, "application/octet-stream"]])("%s → a JPEG", async (_, bytes, type) => {
    const out = await normalizePhoto(file(bytes, type));
    expect(out.type).toBe("image/jpeg");
  });
  it("the canvas shrinks a 4032×3024 phone photo to 1600 px", async () => {
    const draw = vi.fn();
    HTMLCanvasElement.prototype.getContext.mockImplementation(() => ({ fillRect: vi.fn(), drawImage: draw }));
    await normalizePhoto(file(JPEG, "image/jpeg"));
    expect(draw.mock.calls[0].slice(3)).toEqual([1600, 1200]);
    expect(createImageBitmap.mock.calls[0][1]).toEqual({ imageOrientation: "from-image" }); // upright
  });
  it("too big after the first try: quality, then size, step down until it fits", async () => {
    jpegSizes = [9000, 8000, 7000, 1000];
    const out = await normalizePhoto(file(JPEG, "image/jpeg"), { maxBytes: 5000 });
    expect(out.size).toBe(1000);
    expect(HTMLCanvasElement.prototype.toBlob.mock.calls.map((c) => Math.round(c[2] * 100))).toEqual([82, 72, 62, 62]);
  });
  it("an unsupported file is refused (text, PDF, AVIF), even named .jpg", async () => {
    await expect(normalizePhoto(file(new TextEncoder().encode("hello, not a photo at all......"), "image/jpeg", "x.jpg"))).rejects.toThrow(NOT_A_PHOTO);
    await expect(normalizePhoto(file(new TextEncoder().encode("%PDF-1.7 ......................."), "application/pdf"))).rejects.toThrow(NOT_A_PHOTO);
    await expect(normalizePhoto(file(ftyp("avif", "mif1"), "image/avif"))).rejects.toThrow(NOT_A_PHOTO);
  });
  it("a damaged photo (right header, can't be opened) is refused", async () => {
    bitmap = () => {
      throw new Error("decode");
    };
    await expect(normalizePhoto(file(JPEG, "image/jpeg"))).rejects.toThrow(PHOTO_DAMAGED);
    expect(heicTo).not.toHaveBeenCalled();
  });
});

describe("HEIC / HEIF", () => {
  it("Safari opens it itself: the converter isn't loaded", async () => {
    await normalizePhoto(file(HEIC, "image/heic"));
    expect(heicTo).not.toHaveBeenCalled();
  });
  it("other browsers: the converter (lazy) makes the bitmap, then it's a JPEG", async () => {
    bitmap = () => {
      throw new Error("unsupported");
    };
    heicTo.mockResolvedValue({ width: 3024, height: 4032, close: vi.fn() });
    const out = await normalizePhoto(file(HEIC, ""));
    expect(heicTo).toHaveBeenCalledWith(expect.objectContaining({ type: "bitmap" }));
    expect(out.type).toBe("image/jpeg");
  });
  it("a damaged HEIC is refused", async () => {
    bitmap = () => {
      throw new Error("unsupported");
    };
    heicTo.mockRejectedValue(new Error("libheif: invalid"));
    await expect(normalizePhoto(file(HEIF, "image/heif"))).rejects.toThrow(PHOTO_DAMAGED);
  });
});

describe("the upload surfaces", () => {
  it("proofs: a HEIC photo goes up as a JPEG; a PDF only where PDFs are allowed", async () => {
    expect((await prepareProof(file(HEIC, "image/heic"))).contentType).toBe("image/jpeg");
    const pdf = file(new TextEncoder().encode("%PDF-1.7 a receipt ................"), "");
    expect((await prepareProof(pdf, { pdf: true })).contentType).toBe("application/pdf");
    await expect(prepareProof(pdf)).rejects.toThrow(/not a PDF/);
    expect(await fileKind(pdf)).toBe("application/pdf");
  });
  it("Bridal cover / gallery: a JPEG data URL", async () => {
    expect(await photoDataUrl(file(HEIC, "image/heic"))).toMatch(/^data:image\/jpeg;base64,/);
  });
  it("Custom design images: a small PNG stays a PNG (transparency), typed by its bytes; HEIC → JPEG; SVG as is", async () => {
    expect(await designAssetDataUrl(file(PNG, ""))).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(await designAssetDataUrl(file(HEIC, "image/heic"))).toMatch(/^data:image\/jpeg;base64,/);
    expect(await designAssetDataUrl(file(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml", "a.svg"))).toMatch(/^data:image\/svg\+xml;base64,/);
    await expect(designAssetDataUrl(file(new TextEncoder().encode("not an image ......................"), "image/png"))).rejects.toThrow(NOT_A_PHOTO);
  });
});
