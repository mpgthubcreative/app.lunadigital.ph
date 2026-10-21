// An ISO-BMFF ftyp box (HEIC / HEIF / AVIF files start with one): size,
// "ftyp", major brand, minor version, compatible brands; then padding.
export const ftyp = (major, ...compat) => {
  const brands = [major, "\0\0\0\0", ...compat].join("");
  const size = 8 + brands.length;
  return Uint8Array.from([0, 0, 0, size, ..."ftyp", ...brands].map((c) => (typeof c === "number" ? c : c.charCodeAt(0))).concat(Array(16).fill(0)));
};
