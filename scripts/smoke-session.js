// End-to-end smoke test of sign-in + GET /api/session against a deployed
// (or `netlify dev`) Luna, using the demo accounts from seed-demo.js.
//
//   node --env-file=.env.local scripts/smoke-session.js [baseUrl]
//
// baseUrl defaults to SITE_URL. Reads demo passwords from
// .demo-credentials.local.md; never prints them. Exits non-zero on any
// failure. This is a Phase 2 smoke check, NOT the Phase 3 tenant-isolation
// proof (which runs against the Firestore emulator and covers rules).

import { readFileSync } from "node:fs";
import { normalizeEnvironment, isProduction } from "../shared/environment.js";
import { PERMISSION_KEYS } from "../shared/permissions.js";
import { businessDate } from "../shared/metrics.js";

if (isProduction(normalizeEnvironment(process.env.LUNA_ENV))) {
  console.error("Refusing to run demo-account smoke tests against production.");
  process.exit(1);
}

const baseUrl = (process.argv[2] || process.env.SITE_URL || "").replace(/\/$/, "");
const apiKey = process.env.VITE_FIREBASE_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("Need a base URL (arg or SITE_URL) and VITE_FIREBASE_API_KEY.");
  process.exit(1);
}

const creds = {};
for (const line of readFileSync(new URL("../.demo-credentials.local.md", import.meta.url), "utf8").split("\n")) {
  const m = /^\| (\S+@luna\.test) \| `([^`]+)` \|/.exec(line);
  if (m) creds[m[1].split("@")[0]] = { email: m[1], password: m[2] };
}

const tokens = {};
async function token(key) {
  if (tokens[key]) return tokens[key];
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds[key].email, password: creds[key].password, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`sign-in failed for ${key}: ${data.error && data.error.message}`);
  return (tokens[key] = data.idToken);
}

// Firestore REST read as a demo user: returns the HTTP status only.
async function fsGet(as, path) {
  const project = process.env.VITE_FIREBASE_PROJECT_ID;
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`, {
    headers: { Authorization: `Bearer ${await token(as)}` },
  });
  return res.status;
}

async function post(endpoint, body, { as, businessId } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (as) headers.Authorization = `Bearer ${await token(as)}`;
  if (businessId) headers["X-Luna-Business-Id"] = businessId;
  const res = await fetch(`${baseUrl}/api/${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status: res.status, body: json };
}

// Firestore REST structured query as a demo user: HTTP status only.
async function fsQuery(as, parentPath, collectionId) {
  const project = process.env.VITE_FIREBASE_PROJECT_ID;
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${parentPath}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token(as)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit: 5 } }),
  });
  return res.status;
}

async function session(options) {
  return get("session", options);
}

async function get(endpoint, { as, rawToken, businessId } = {}) {
  const headers = {};
  if (as) headers.Authorization = `Bearer ${await token(as)}`;
  if (rawToken) headers.Authorization = `Bearer ${rawToken}`;
  if (businessId) headers["X-Luna-Business-Id"] = businessId;
  const res = await fetch(`${baseUrl}/api/${endpoint}`, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function wrongPasswordRejected() {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds["owner.a"].email, password: "definitely-wrong", returnSecureToken: true }),
  });
  return res.status === 400;
}

const has = (r, perm) => r.body.permissions && r.body.permissions[perm] === true;
const A = "demo-distributor-a";
const B = "demo-distributor-b";
const C = "demo-retailer-c";

const checks = [
  ["invalid login (wrong password) is rejected by Firebase Auth", async () => wrongPasswordRejected()],
  ["no token → 401", async () => (await session({})).status === 401],
  ["forged token → 401", async () => (await session({ rawToken: "not-a-real-token" })).status === 401],
  ["owner.a → A, account owner, all permissions", async () => {
    const r = await session({ as: "owner.a" });
    return r.status === 200 && r.body.business.id === A && r.body.member.isAccountOwner === true && Object.keys(r.body.permissions).length === PERMISSION_KEYS.length && r.body.plan.id === "growth";
  }],
  ["manager.a → A, no billing/team management", async () => {
    const r = await session({ as: "manager.a" });
    return r.status === 200 && r.body.business.id === A && has(r, "reports.advanced") && !has(r, "billing.view") && !has(r, "users.manage");
  }],
  ["staff.a → A, no reports/users/settings", async () => {
    const r = await session({ as: "staff.a" });
    return r.status === 200 && has(r, "orders.create") && !has(r, "reports.view") && !has(r, "users.view") && !has(r, "settings.view");
  }],
  ["disabled.a → 403 membership-disabled", async () => {
    const r = await session({ as: "disabled.a" });
    return r.status === 403 && r.body.error === "membership-disabled";
  }],
  ["owner.b → B (Starter)", async () => {
    const r = await session({ as: "owner.b" });
    return r.status === 200 && r.body.business.id === B && r.body.plan.id === "starter" && r.body.entitlements.limits.users === 2;
  }],
  ["owner.a selecting B → 403 business-access-denied, no B data", async () => {
    const r = await session({ as: "owner.a", businessId: B });
    return r.status === 403 && r.body.error === "business-access-denied" && !JSON.stringify(r.body).includes("Demo Distributor B");
  }],
  ["owner.b selecting A → 403", async () => (await session({ as: "owner.b", businessId: A })).status === 403],
  ["staff.a selecting C → 403", async () => (await session({ as: "staff.a", businessId: C })).status === 403],
  ["owner.a selecting non-existent business → identical 403", async () => {
    const other = await session({ as: "owner.a", businessId: B });
    const missing = await session({ as: "owner.a", businessId: "no-such-business" });
    return missing.status === 403 && JSON.stringify(missing.body) === JSON.stringify(other.body);
  }],
  ["malformed selector → 400", async () => (await session({ as: "owner.a", businessId: "../demo-distributor-b" })).status === 400],
  ["multi default → A as staff, sees 2 memberships", async () => {
    const r = await session({ as: "multi" });
    return r.status === 200 && r.body.business.id === A && r.body.member.roleTemplate === "staff" && r.body.memberships.length === 2;
  }],
  ["multi selecting B → B as manager", async () => {
    const r = await session({ as: "multi", businessId: B });
    return r.status === 200 && r.body.business.id === B && r.body.member.roleTemplate === "manager" && has(r, "reports.view");
  }],
  ["owner.c → C suspended, read-only", async () => {
    const r = await session({ as: "owner.c" });
    return r.status === 200 && r.body.subscription.status === "suspended" && r.body.subscription.access.canWrite === false;
  }],
  ["staff.c → C suspended, read-only", async () => {
    const r = await session({ as: "staff.c" });
    return r.status === 200 && r.body.subscription.access.canWrite === false;
  }],
  ["usage counts active members only (A: owner, manager, staff, multi = 4)", async () => (await session({ as: "owner.a" })).body.usage.users === 4],
  ["environment reported as staging", async () => (await session({ as: "owner.a" })).body.environment === "staging"],
  // Phase 4: entitlements + package visibility
  ["owner.a session has a schemaVersion-1 package with core modules on", async () => {
    const r = await session({ as: "owner.a" });
    const m = r.body.entitlements.modules;
    return r.status === 200 && m.dashboard === true && m.users === true && m.settings === true && typeof m.reports === "boolean" && r.body.plan.id === "growth";
  }],
  ["staff.a session hides plan, limits and usage", async () => {
    const r = await session({ as: "staff.a" });
    return r.status === 200 && r.body.plan === null && r.body.entitlements.limits === null && r.body.usage === null && r.body.entitlements.modules.orders === true;
  }],
  ["GET /api/reports: no token → 401", async () => (await get("reports")).status === 401],
  ["GET /api/reports: staff.a (no reports.view) → 403", async () => (await get("reports", { as: "staff.a" })).status === 403],
  ["GET /api/reports: manager.a (reports.view + module on) → 501, no data", async () => {
    const r = await get("reports", { as: "manager.a" });
    return r.status === 501 && r.body.error === "not-implemented";
  }],
  ["GET /api/reports: owner.a selecting B → 403", async () => (await get("reports", { as: "owner.a", businessId: B })).status === 403],
  // Phase 5: dashboard summary documents through the deployed Firestore rules.
  // An allowed read of a not-yet-written document is 404; a denied one is 403.
  ["owner.a has dashboard.financials; staff.a doesn't", async () => {
    const [o, s] = await Promise.all([session({ as: "owner.a" }), session({ as: "staff.a" })]);
    return has(o, "dashboard.financials") && !has(s, "dashboard.financials") && has(s, "dashboard.view");
  }],
  ["owner.a reads today's metrics + financialMetrics (allowed)", async () => {
    const day = businessDate((await session({ as: "owner.a" })).body.business.timezone);
    const a = await fsGet("owner.a", `businesses/${A}/metrics/${day}`);
    const b = await fsGet("owner.a", `businesses/${A}/financialMetrics/${day}`);
    return [200, 404].includes(a) && [200, 404].includes(b);
  }],
  ["staff.a reads operational metrics but is refused financialMetrics", async () => {
    const day = businessDate((await session({ as: "staff.a" })).body.business.timezone);
    return [200, 404].includes(await fsGet("staff.a", `businesses/${A}/metrics/current`)) && (await fsGet("staff.a", `businesses/${A}/financialMetrics/${day}`)) === 403;
  }],
  ["owner.a is refused B's financialMetrics", async () => (await fsGet("owner.a", `businesses/${B}/financialMetrics/current`)) === 403],
  ["Expenses (not built) is refused even to owner.a", async () => (await fsGet("owner.a", `businesses/${A}/expenses/any`)) === 403],
  // Phase 6: products + inventory (no data is created by these checks).
  ["POST /api/inventory without a token → 401", async () => (await post("inventory", { action: "receipt" })).status === 401],
  ["staff.a can't create products or receive stock (403)", async () => {
    const a = await post("products", { action: "create", product: { sku: "SMOKE-X", name: "x", unit: "pcs", sellingPrice: 1, reorderLevel: 0 } }, { as: "staff.a" });
    const b = await post("inventory", { action: "receipt", productId: "aaaaaaaaaaaaaaaaaaaa", quantity: 1000, unitCost: 100 }, { as: "staff.a" });
    return a.status === 403 && b.status === 403;
  }],
  ["owner.a selecting B can't create products in B (403)", async () => {
    const r = await post("products", { action: "create", product: { sku: "SMOKE-X", name: "x", unit: "pcs", sellingPrice: 1, reorderLevel: 0 } }, { as: "owner.a", businessId: B });
    return r.status === 403 && r.body.error === "business-access-denied";
  }],
  ["owner.a: smuggled balance fields are refused (400)", async () => (await post("products", { action: "create", product: { sku: "SMOKE-X", name: "x", unit: "pcs", sellingPrice: 1, reorderLevel: 0, onHand: 999000 } }, { as: "owner.a" })).status === 400],
  ["staff.a lists products (quantities) but is refused product costs", async () =>
    (await fsQuery("staff.a", `businesses/${A}`, "products")) === 200 && (await fsQuery("staff.a", `businesses/${A}`, "productCosts")) === 403],
  ["owner.a reads product costs in A, nothing in B", async () =>
    (await fsQuery("owner.a", `businesses/${A}`, "productCosts")) === 200 &&
    (await fsQuery("owner.a", `businesses/${B}`, "products")) === 403 &&
    (await fsQuery("owner.a", `businesses/${B}`, "productCosts")) === 403 &&
    (await fsQuery("owner.a", `businesses/${B}`, "inventoryTransactions")) === 403],
];

console.log(`Smoke-testing ${baseUrl}\n`);
let failed = 0;
for (const [name, fn] of checks) {
  let ok = false;
  let note = "";
  try {
    ok = await fn();
  } catch (err) {
    note = ` (${err.message})`;
  }
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
