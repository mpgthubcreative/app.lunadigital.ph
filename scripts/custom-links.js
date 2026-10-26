// Luna operator: custom workspace links (2026-10-26). Uses the operator's
// own Netlify login (npx netlify), like scripts/release.js, so it works
// without a Netlify token on the server.
//   node --env-file=.env.local scripts/custom-links.js list
//   node --env-file=.env.local scripts/custom-links.js finish --business <id> --confirm <projectId>
//       add the workspace's pending names to the site, then mark each ready
//       once HTTPS answers (run again if HTTPS isn't ready yet)
//   node --env-file=.env.local scripts/custom-links.js release [--execute --confirm <projectId>]
//       names held 90+ days after their workspace was cancelled or deleted:
//       dry run lists them; --execute removes the alias and frees the name
//   node --env-file=.env.local scripts/custom-links.js remove --label <name> --reason "<why>" --confirm <projectId>
//       an operator removal (e.g. a controlled test link): frees one name now
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs, connect, connectReadOnly, fail } from "./_cli.js";
import { customLinkDomain, listCustomLinks, finishCustomLinks } from "../netlify/functions/_lib/custom-links.js";
import { httpsReady } from "../netlify/functions/_lib/netlify-domains.js";
import { customLinkHost, CUSTOM_LINK_HOLD_DAYS } from "../shared/custom-links.js";

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const domain = customLinkDomain();
if (!domain) fail("VITE_CUSTOM_LINK_DOMAIN isn't set in the env file.");
const siteId = JSON.parse(readFileSync(".netlify/state.json", "utf8")).siteId;

function netlify(method, data) {
  const r = spawnSync(`npx netlify api ${method} --data ${JSON.stringify(JSON.stringify(data))}`, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw Object.assign(new Error(`netlify api ${method} failed`), { code: "netlify-refused" });
  return r.stdout ? JSON.parse(r.stdout) : {};
}
// The same interface as ./netlify-domains.js, through the CLI login.
const cliDomains = {
  configured: true,
  async site() {
    const s = netlify("getSite", { site_id: siteId });
    return { primary: s.custom_domain || null, aliases: Array.isArray(s.domain_aliases) ? s.domain_aliases : [] };
  },
  async addAlias(host) {
    const s = await this.site();
    if (s.aliases.includes(host)) return { added: false, count: s.aliases.length };
    const out = netlify("updateSite", { site_id: siteId, body: { domain_aliases: [...s.aliases, host] } });
    return { added: true, count: (out.domain_aliases || []).length };
  },
  async removeAlias(host) {
    const s = await this.site();
    if (!s.aliases.includes(host)) return { removed: false };
    netlify("updateSite", { site_id: siteId, body: { domain_aliases: s.aliases.filter((a) => a !== host) } });
    return { removed: true };
  },
  async provisionCertificate() {
    try {
      netlify("provisionSiteTLSCertificate", { site_id: siteId });
    } catch {
      /* already issued or in progress: the HTTPS check decides */
    }
  },
};

// Frees one name: the alias, the registry entry, the count, the business's record.
async function freeName(db, FieldValue, label, why) {
  const ref = db.collection("publicLinks").doc(label);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const r = snap.data();
  await cliDomains.removeAlias(customLinkHost(label, domain));
  await db.runTransaction(async (tx) => {
    const biz = await tx.get(db.collection("businesses").doc(r.businessId));
    tx.delete(ref);
    tx.set(db.collection("publicLinkStats").doc("summary"), { names: FieldValue.increment(-1) }, { merge: true });
    if (biz.exists && biz.data().customLink) {
      const c = biz.data().customLink;
      if (c.label === label) tx.update(biz.ref, { customLink: null });
      else tx.update(biz.ref, { "customLink.previous": (c.previous || []).filter((x) => x !== label) });
    }
    tx.set(db.collection("platformAudit").doc(), { type: "custom-link.released", summary: `Custom link released: ${label} (${why})`, businessId: r.businessId, label, reason: why, actor: "cli", at: FieldValue.serverTimestamp() });
  });
  return true;
}
const daysSince = (t) => (t?.toDate ? (Date.now() - t.toDate().getTime()) / 86400000 : null);

if (cmd === "list") {
  const { db } = await connectReadOnly();
  const c = await listCustomLinks({ db, domain });
  console.log(`${c.names} of ${c.limit} addresses (warn at ${c.warnAt})`);
  for (const r of c.rows) console.log(`  ${r.host.padEnd(44)} ${r.kind.padEnd(8)} ${r.setup.padEnd(7)} ${r.state.padEnd(11)} ${r.businessName}${r.setupError ? ` · ${r.setupError}` : ""}`);
} else if (cmd === "finish") {
  if (!args.business || args.business === true) fail("Add --business <id>.");
  const { db, admin } = await connect(args);
  const out = await finishCustomLinks({ db, FieldValue: admin.firestore.FieldValue, businessId: String(args.business), domain, domains: cliDomains, httpsReady });
  console.log(`Setup: ${out.setup}${out.error ? ` (${out.error})` : ""}${out.aliases != null ? ` · site addresses: ${out.aliases}` : ""}. ${out.setup === "active" ? "Ready." : "Run again in a few minutes if HTTPS isn't ready yet."}`);
} else if (cmd === "release") {
  const execute = args.execute === true;
  const { db, admin } = execute ? await connect(args) : await connectReadOnly();
  const links = (await db.collection("publicLinks").get()).docs;
  const due = [];
  for (const d of links) {
    const b = await db.collection("businesses").doc(d.data().businessId).get();
    const sub = b.exists ? b.data().subscription || {} : null;
    const since = !sub ? null : sub.status === "cancelled" ? daysSince(sub.statusChangedAt) : sub.status === "deleted" ? daysSince(b.data().deletion?.deletedAt) : null;
    if (since !== null && since >= CUSTOM_LINK_HOLD_DAYS) due.push({ label: d.id, businessId: d.data().businessId, status: sub.status, days: Math.floor(since) });
  }
  console.log(`${due.length} name(s) held ${CUSTOM_LINK_HOLD_DAYS}+ days after cancellation / deletion:`);
  for (const x of due) console.log(`  ${x.label} (${x.businessId}, ${x.status} ${x.days} days)`);
  if (!execute) console.log("DRY RUN: nothing released. Add --execute --confirm <projectId>.");
  else for (const x of due) await freeName(db, admin.firestore.FieldValue, x.label, `held ${x.days} days after ${x.status}`);
} else if (cmd === "remove") {
  if (!args.label || args.label === true) fail("Add --label <name>.");
  const why = typeof args.reason === "string" ? args.reason.trim() : "";
  if (why.length < 3) fail('Add --reason "<why>" (it is recorded).');
  const { db, admin } = await connect(args);
  console.log((await freeName(db, admin.firestore.FieldValue, String(args.label), why)) ? `Released ${args.label}.` : `${args.label} isn't claimed.`);
} else {
  fail("Usage: list | finish --business <id> | release [--execute] | remove --label <name> --reason <why>  (writes need --confirm <projectId>)");
}
process.exit(0);
