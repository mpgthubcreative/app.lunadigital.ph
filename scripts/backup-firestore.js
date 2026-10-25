// Logical backup of the whole Firestore database (every collection,
// recursively) and, optionally, every Storage file, to a local folder.
// Read-only. A complement to the managed backups / PITR in docs/BACKUP.md:
// it needs no extra IAM role, and scripts/restore-firestore.js can restore
// it (all of it, or one business) into the emulator or a project.
//   node --env-file=.env.local scripts/backup-firestore.js --out <dir> [--files] [--business <id>]
// Writes <dir>/firestore.jsonl (one document per line), <dir>/files/** when
// --files, and <dir>/manifest.json (counts per top-level collection, a
// SHA-256 of firestore.jsonl, the project and environment).
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseArgs, requireArgs, connectReadOnly } from "./_cli.js";
import { encodeValue } from "./_firestore-codec.js";

const args = parseArgs();
requireArgs(args, ["out"]);
const OUT = String(args.out);
mkdirSync(OUT, { recursive: true });
const { db, bucket: bucketOf } = await connectReadOnly();
const lines = createWriteStream(join(OUT, "firestore.jsonl"));
const counts = {};
let total = 0;

async function walk(col) {
  const top = col.path.split("/")[0];
  // Pages of 500 so a large collection never loads at once.
  let last = null;
  for (;;) {
    let q = col.orderBy("__name__").limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const d of snap.docs) {
      lines.write(`${JSON.stringify({ path: d.ref.path, data: encodeValue(d.data()) })}\n`);
      counts[top] = (counts[top] || 0) + 1;
      total += 1;
    }
    for (let i = 0; i < snap.docs.length; i += 10) await Promise.all(snap.docs.slice(i, i + 10).map(async (d) => { for (const sub of await d.ref.listCollections()) await walk(sub); }));
    if (snap.size < 500) break;
    last = snap.docs.at(-1);
  }
  // Documents that only exist as parents of subcollections.
  for (const ref of await col.listDocuments()) {
    if ((await ref.get()).exists) continue;
    for (const sub of await ref.listCollections()) await walk(sub);
  }
}

const started = Date.now();
if (args.business) {
  const ref = db.collection("businesses").doc(String(args.business));
  const snap = await ref.get();
  if (snap.exists) {
    lines.write(`${JSON.stringify({ path: ref.path, data: encodeValue(snap.data()) })}\n`);
    counts.businesses = 1;
    total = 1;
  }
  for (const sub of await ref.listCollections()) await walk(sub);
} else {
  for (const col of await db.listCollections()) await walk(col);
}
await new Promise((res) => lines.end(res));

let files = 0;
if (args.files) {
  const bucket = await bucketOf();
  const [list] = await bucket.getFiles(args.business ? { prefix: `tenants/${args.business}/` } : {});
  for (const f of list) {
    const target = join(OUT, "files", f.name);
    mkdirSync(dirname(target), { recursive: true });
    await f.download({ destination: target });
    files += 1;
  }
}
const manifest = {
  createdAt: new Date().toISOString(),
  projectId: process.env.FIREBASE_PROJECT_ID,
  environment: process.env.LUNA_ENV,
  scope: args.business ? { business: String(args.business) } : "all",
  documents: total,
  collections: counts,
  files,
  sha256: createHash("sha256").update(readFileSync(join(OUT, "firestore.jsonl"))).digest("hex"),
  seconds: Math.round((Date.now() - started) / 1000),
};
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`Backup: ${total} documents${args.files ? `, ${files} files` : ""} in ${manifest.seconds}s → ${OUT}`);
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
process.exit(0);
