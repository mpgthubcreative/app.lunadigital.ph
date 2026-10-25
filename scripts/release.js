// Gated release on Netlify Free (2026-10-25). Netlify builds every push to
// main, but with auto publishing stopped (a locked deploy) nothing goes live
// until a person publishes it here, and this script refuses unless GitHub
// CI passed for that exact commit. See docs/RELEASE.md.
//   node scripts/release.js status                         what's live, what's waiting, CI of each
//   node scripts/release.js publish --sha <commit> --confirm <site name>
//   node scripts/release.js rollback --deploy <deploy id> --confirm <site name>   (an earlier deploy, CI not re-checked)
//   node scripts/release.js lock --confirm <site name>     one-time: stop auto publishing (keeps what's live)
//   node scripts/release.js unlock --confirm <site name>   resume auto publishing (not recommended)
// Needs the Netlify CLI signed in (npx netlify login) and .netlify/state.json
// (npx netlify link). Reads GitHub CI without a token (public API).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs, fail } from "./_cli.js";

const REPO = "mpgthubcreative/app.lunadigital.ph";
const args = parseArgs(process.argv.slice(3));
const cmd = process.argv[2];
let siteId;
try {
  siteId = JSON.parse(readFileSync(".netlify/state.json", "utf8")).siteId;
} catch {
  fail("Not linked to a Netlify site (run npx netlify link).");
}

function netlify(method, data) {
  const r = spawnSync(`npx netlify api ${method} --data ${JSON.stringify(JSON.stringify(data))}`, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`netlify api ${method} failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  return JSON.parse(r.stdout);
}
async function ciOf(sha) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/runs?head_sha=${sha}`, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) return { state: `unknown (GitHub ${res.status})` };
  const runs = (await res.json()).workflow_runs || [];
  if (!runs.length) return { state: "no CI run" };
  if (runs.some((r) => r.status !== "completed")) return { state: "running" };
  return runs.every((r) => r.conclusion === "success") ? { state: "passed", ok: true } : { state: `failed (${runs.map((r) => `${r.name}: ${r.conclusion}`).join(", ")})` };
}
const site = () => netlify("getSite", { site_id: siteId });
const confirmSite = (s) => {
  if (args.confirm !== s.name) fail(`Refusing: add --confirm ${s.name} (the Netlify site this publishes to).`);
};
const short = (sha) => (sha || "").slice(0, 7);

if (cmd === "status") {
  const s = site();
  const live = s.published_deploy || {};
  console.log(`Site ${s.name} (${s.ssl_url})${s.custom_domain ? ` · ${s.custom_domain}` : ""}`);
  console.log(`Auto publishing: ${live.locked ? "STOPPED (deploys wait for scripts/release.js publish)" : "ON (every push to main goes live after its build)"}`);
  console.log(`Live: ${short(live.commit_ref)} ${live.id} (${live.published_at || "?"}) · CI ${(await ciOf(live.commit_ref)).state}`);
  const deploys = netlify("listSiteDeploys", { site_id: siteId, per_page: 8 });
  for (const d of deploys) if (d.id !== live.id && d.context === "production") console.log(`  ${d.state.padEnd(9)} ${short(d.commit_ref)} ${d.id} ${d.created_at} · CI ${d.commit_ref ? (await ciOf(d.commit_ref)).state : "-"}`);
} else if (cmd === "publish") {
  if (!/^[0-9a-f]{7,40}$/.test(String(args.sha || ""))) fail("Add --sha <commit> (the commit to publish).");
  const s = site();
  confirmSite(s);
  const ci = await ciOf(String(args.sha));
  if (!ci.ok) fail(`Refusing: CI for ${short(args.sha)} is ${ci.state}. Only a commit whose CI passed can be published.`);
  const d = netlify("listSiteDeploys", { site_id: siteId, per_page: 30 }).find((x) => x.context === "production" && x.commit_ref && x.commit_ref.startsWith(String(args.sha)) && x.state === "ready");
  if (!d) fail(`No finished Netlify build of ${short(args.sha)} yet (wait for it, then run this again).`);
  const out = netlify("restoreSiteDeploy", { site_id: siteId, deploy_id: d.id });
  console.log(`Published ${short(d.commit_ref)} (deploy ${out.id || d.id}) to ${s.name}. CI: passed.`);
  const h = await fetch(`${s.ssl_url}/api/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  console.log(`Health: ${JSON.stringify(h)}`);
} else if (cmd === "rollback") {
  if (!args.deploy || args.deploy === true) fail("Add --deploy <deploy id> (scripts/release.js status lists them; Netlify keeps old deploys).");
  const s = site();
  confirmSite(s);
  const out = netlify("restoreSiteDeploy", { site_id: siteId, deploy_id: String(args.deploy) });
  console.log(`Rolled back ${s.name} to deploy ${out.id} (${short(out.commit_ref)}).`);
} else if (cmd === "lock" || cmd === "unlock") {
  const s = site();
  confirmSite(s);
  const live = s.published_deploy;
  if (!live) fail("Nothing is published yet.");
  const out = netlify(cmd === "lock" ? "lockDeploy" : "unlockDeploy", { deploy_id: live.id });
  console.log(cmd === "lock" ? `Auto publishing STOPPED: ${short(out.commit_ref)} stays live; new builds wait for release.js publish.` : "Auto publishing resumed.");
} else {
  fail("Usage: node scripts/release.js status | publish --sha <commit> --confirm <site> | rollback --deploy <id> --confirm <site> | lock|unlock --confirm <site>");
}
process.exit(0);
