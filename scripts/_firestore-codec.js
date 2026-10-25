// Firestore values <-> JSON for scripts/backup-firestore.js and
// scripts/restore-firestore.js: timestamps, geo points, document
// references and bytes survive the round trip exactly.

const TAG = "__luna";

export function encodeValue(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(encodeValue);
  if (typeof v.toDate === "function" && Number.isInteger(v.seconds) && Number.isInteger(v.nanoseconds)) return { [TAG]: "ts", s: v.seconds, n: v.nanoseconds };
  if (typeof v.latitude === "number" && typeof v.longitude === "number" && Object.keys(v).length <= 2) return { [TAG]: "geo", lat: v.latitude, lng: v.longitude };
  if (typeof v.path === "string" && v.firestore && typeof v.collection === "function") return { [TAG]: "ref", path: v.path };
  if (v instanceof Uint8Array) return { [TAG]: "bytes", b64: Buffer.from(v).toString("base64") };
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeValue(x)]));
}

export function decodeValue(v, { Timestamp, GeoPoint, db }) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, { Timestamp, GeoPoint, db }));
  switch (v[TAG]) {
    case "ts":
      return new Timestamp(v.s, v.n);
    case "geo":
      return new GeoPoint(v.lat, v.lng);
    case "ref":
      return db.doc(v.path);
    case "bytes":
      return Buffer.from(v.b64, "base64");
    default:
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeValue(x, { Timestamp, GeoPoint, db })]));
  }
}
