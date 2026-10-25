// Restore a scripts/backup-firestore.js backup: all of it, or one business
// (businesses/<id> and everything under it). It never deletes anything and
// never overwrites a document that already exists unless --overwrite; it
// then reads every restored document back and compares it with the backup.
//   Into the emulator (rehearsal; no confirm needed):
//     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-luna node scripts/restore-firestore.js --from <dir>
//   Into a project (an emergency restore):
//     node --env-file=<env> scripts/restore-firestore.js --from <dir> [--business <id>] [--overwrite] [--files] --confirm <projectId>
// Without --execute it only reports what it would write (dry run).
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { parseArgs, requireArgs, fail } from "./_cli.js";
import { getAdmin } from "../netlify/functions/_lib/firebase-admin.js";
import { encodeValue, decodeValue } from "./_firestore-codec.js";

const args = parseArgs();
requireArgs(args, ["from"]);
const FROM = String(args.from);
const execute = args.execute === true;
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) fail("FIREBASE_PROJECT_ID is not set.");
console.log(`Target: project=${projectId} (${emulator ? `EMULATOR ${process.env.FIRESTORE_EMULATOR_HOST}` : "CLOUD"}) mode=${execute ? "EXECUTE" : "DRY RUN"}`);
if (execute && !emulator && args.confirm !== projectId) fail(`Refusing to write to a project: add --confirm ${projectId}.`);

const manifest = JSON.parse(readFileSync(join(FROM, "manifest.json"), "utf8"));
const raw = readFileSync(join(FROM, "firestore.jsonl"));
if (createHash("sha256").update(raw).digest("hex") !== manifest.sha256) fail("The backup file doesn't match its manifest (changed or incomplete).");
const scope = args.business ? `businesses/${args.business}` : null;
const rows = raw.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !scope || r.path === scope || r.path.startsWith(`${scope}/`));
console.log(`Backup of ${manifest.projectId} (${manifest.environment}) from ${manifest.createdAt}: ${rows.length} documents in scope${scope ? ` (${scope})` : ""}.`);

const { db } = await getAdmin();
const { Timestamp, GeoPoint } = await import("firebase-admin/firestore");
const ctx = { Timestamp, GeoPoint, db };

const existing = new Set();
for (let i = 0; i < rows.length; i += 300) {
  const snaps = await db.getAll(...rows.slice(i, i + 300).map((r) => db.doc(r.path)));
  for (const s of snaps) if (s.exists) existing.add(s.ref.path);
}
const toWrite = rows.filter((r) => args.overwrite === true || !existing.has(r.path));
console.log(`Already there: ${existing.size}${args.overwrite === true ? " (will be overwritten)" : " (kept as they are)"} · to write: ${toWrite.length}`);
if (!execute) {
  console.log("DRY RUN: nothing written. Add --execute.");
  process.exit(0);
}
const started = Date.now();
for (let i = 0; i < toWrite.length; i += 400) {
  const batch = db.batch();
  for (const r of toWrite.slice(i, i + 400)) batch.set(db.doc(r.path), decodeValue(r.data, ctx));
  await batch.commit();
}
// Read back and compare.
let same = 0;
const diff = [];
for (let i = 0; i < toWrite.length; i += 300) {
  const part = toWrite.slice(i, i + 300);
  const snaps = await db.getAll(...part.map((r) => db.doc(r.path)));
  snaps.forEach((s, j) => (s.exists && JSON.stringify(encodeValue(s.data())) === JSON.stringify(part[j].data) ? same++ : diff.push(part[j].path)));
}
let files = 0;
if (args.files === true && existsSync(join(FROM, "files"))) {
  const { bucket } = await getAdmin();
  const b = await bucket();
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk(join(FROM, "files"))) {
    const name = relative(join(FROM, "files"), f).replace(/\\/g, "/");
    if (scope && !name.startsWith(`tenants/${args.business}/`)) continue;
    const [exists] = await b.file(name).exists();
    if (exists && args.overwrite !== true) continue;
    await b.upload(f, { destination: name });
    files += 1;
  }
}
console.log(`Restored ${toWrite.length} documents in ${Math.round((Date.now() - started) / 1000)}s; read back identical: ${same}/${toWrite.length}${diff.length ? ` · DIFFERENT: ${diff.slice(0, 5).join(", ")}` : ""}${args.files === true ? ` · files uploaded: ${files}` : ""}`);
process.exit(diff.length ? 2 : 0);
