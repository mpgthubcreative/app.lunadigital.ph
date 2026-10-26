// Custom workspace links on Netlify Free (2026-10-26): every claimed name is
// one explicit domain alias on Luna's ONE Netlify site (no wildcard, no
// per-customer site). Netlify DNS (lunadigitalsystem.com) creates the DNS
// record for an alias of the site, and Netlify issues the HTTPS certificate.
//
// Server-only. Needs NETLIFY_API_TOKEN (a Netlify personal access token,
// never sent to the browser) and the site id (NETLIFY_SITE_ID, or Netlify's
// own SITE_ID). Without them nothing is called: links stay "pending" until
// Luna finishes them (scripts/custom-links.js uses the operator's own
// Netlify login).
//
// Aliases are read-modify-write on the site (domain_aliases is one list), so
// changes are serialized with a short lease in Firestore
// (platformLocks/netlify-domains): two claims at once never drop each
// other's alias.

const API = "https://api.netlify.com/api/v1";
const LOCK_MS = 60_000;

export class NetlifyDomainsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function netlifyDomainsFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  const token = env.NETLIFY_API_TOKEN;
  const siteId = env.NETLIFY_SITE_ID || env.SITE_ID;
  if (!token || !siteId) return null;
  return netlifyDomains({ token, siteId, fetchImpl });
}

export function netlifyDomains({ token, siteId, fetchImpl }) {
  const call = async (method, path, body) => {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new NetlifyDomainsError("netlify-unreachable", `Netlify couldn't be reached (${err.message}).`);
    }
    if (!res.ok) throw new NetlifyDomainsError("netlify-refused", `Netlify answered ${res.status} to ${method} ${path.replace(siteId, "<site>")}.`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };
  const site = async () => {
    const s = await call("GET", `/sites/${siteId}`);
    return { primary: s.custom_domain || null, aliases: Array.isArray(s.domain_aliases) ? s.domain_aliases : [] };
  };
  return {
    configured: true,
    site,
    // Adds `host` (idempotent: already there = nothing sent). Returns the alias count after.
    async addAlias(host) {
      const s = await site();
      if (s.aliases.includes(host) || s.primary === host) return { added: false, count: s.aliases.length };
      const aliases = [...s.aliases, host];
      const out = await call("PATCH", `/sites/${siteId}`, { domain_aliases: aliases });
      const now = Array.isArray(out.domain_aliases) ? out.domain_aliases : aliases;
      if (!now.includes(host)) throw new NetlifyDomainsError("netlify-refused", "Netlify didn't keep the new address.");
      return { added: true, count: now.length };
    },
    async removeAlias(host) {
      const s = await site();
      if (!s.aliases.includes(host)) return { removed: false, count: s.aliases.length };
      const aliases = s.aliases.filter((a) => a !== host);
      await call("PATCH", `/sites/${siteId}`, { domain_aliases: aliases });
      return { removed: true, count: aliases.length };
    },
    // Asks Netlify to (re)issue the site certificate so it covers new aliases.
    async provisionCertificate() {
      try {
        await call("POST", `/sites/${siteId}/ssl`);
      } catch (err) {
        // Already issued / in progress answers 4xx: the HTTPS check decides.
        if (err.code !== "netlify-refused") throw err;
      }
    },
  };
}

// HTTPS ready = the address answers Luna's health check over a valid
// certificate (fetch refuses an invalid one).
export async function httpsReady(host, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`https://${host}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.service === "luna";
  } catch {
    return false;
  }
}

// One Netlify alias change at a time (Firestore lease).
export async function withDomainsLock(db, owner, fn, now = () => Date.now()) {
  const ref = db.collection("platformLocks").doc("netlify-domains");
  const took = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const held = snap.exists ? snap.data() : null;
    if (held && held.owner !== owner && held.until > now()) return false;
    tx.set(ref, { owner, until: now() + LOCK_MS });
    return true;
  });
  if (!took) throw new NetlifyDomainsError("busy", "Another link is being set up. Try again in a minute.");
  try {
    return await fn();
  } finally {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.data().owner === owner) tx.delete(ref);
    });
  }
}
