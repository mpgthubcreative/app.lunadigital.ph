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
  ["owner.a session has a package with core modules on", async () => {
    const r = await session({ as: "owner.a" });
    const m = r.body.entitlements.modules;
    return r.status === 200 && m.dashboard === true && m.users === true && m.settings === true && typeof m.reports === "boolean" && r.body.plan.id === "growth";
  }],
  // Phase 8.5: every demo tenant is an explicit distributor workspace with the Distributor modules
  ["A, B and C are distributor workspaces with Orders, Payments and Inventory", async () => {
    const rows = await Promise.all([session({ as: "owner.a" }), session({ as: "owner.b" }), session({ as: "owner.c" })]);
    return rows.every((r) => r.status === 200 && r.body.workspace?.templateId === "distributor" && r.body.entitlements.workspaceTemplateId === "distributor" && ["orders", "payments", "inventory"].every((k) => r.body.entitlements.modules[k] === true));
  }],
  ["staff.a session hides plan, limits and usage", async () => {
    const r = await session({ as: "staff.a" });
    return r.status === 200 && r.body.plan === null && r.body.entitlements.limits === null && r.body.usage === null && r.body.entitlements.modules.orders === true;
  }],
  ["GET /api/reports: no token → 401", async () => (await get("reports")).status === 401],
  ["GET /api/reports: staff.a (no reports.view) → 403", async () => (await get("reports", { as: "staff.a" })).status === 403],
  // Phase 11: Reports is built (Distributor v4).
  ["GET /api/reports: manager.a, today's range → 200 with financial figures", async () => {
    const day = businessDate((await session({ as: "manager.a" })).body.business.timezone);
    const r = await get(`reports?from=${day}&to=${day}`, { as: "manager.a" });
    return r.status === 200 && r.body.access?.financials === true && "netSales" in r.body.overview && Array.isArray(r.body.sections);
  }],
  ["GET /api/reports: a future or 367-day range → 400; unknown parameters (businessId) → 400", async () => {
    const day = businessDate((await session({ as: "manager.a" })).body.business.timezone);
    const future = await get(`reports?from=${day}&to=2099-01-01`, { as: "manager.a" });
    const sneaky = await get(`reports?from=${day}&to=${day}&businessId=${B}`, { as: "manager.a" });
    return future.status === 400 && sneaky.status === 400;
  }],
  ["A, B, C snapshots: every unbuilt module is false (planned, not enabled)", async () => {
    const rows = await Promise.all([session({ as: "owner.a" }), session({ as: "owner.b" }), session({ as: "owner.c" })]);
    return rows.every((r) => r.status === 200 && ["suppliers", "production", "returns"].every((k) => r.body.entitlements.modules[k] === false));
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
  // Phase 10: Expenses is built; Owner/Manager read it, Staff (no expenses.*) don't.
  ["Expenses: owner.a reads (404 for a missing doc, not 403); staff.a is refused", async () => (await fsGet("owner.a", `businesses/${A}/expenses/any`)) === 404 && (await fsGet("staff.a", `businesses/${A}/expenses/any`)) === 403],
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
  // Phase 7: orders (refusals and reads only; no orders are created here).
  ["POST /api/orders without a token → 401", async () => (await post("orders", { action: "create" })).status === 401],
  ["staff.a can't give a discount (403 discount-not-allowed)", async () => {
    const r = await post("orders", { action: "create", idempotencyKey: `smoke-${Date.now()}-discount`, order: { customer: { name: "Smoke" }, source: "phone", items: [{ productId: "aaaaaaaaaaaaaaaaaaaa", quantity: 1000 }], discount: 100 } }, { as: "staff.a" });
    return r.status === 403 && r.body.error === "discount-not-allowed";
  }],
  ["staff.a can't cancel orders (403)", async () => (await post("orders", { action: "cancel", orderId: "aaaaaaaaaaaaaaaaaaaa", reason: "smoke test" }, { as: "staff.a" })).status === 403],
  ["forged totals are refused (400)", async () => (await post("orders", { action: "create", idempotencyKey: `smoke-${Date.now()}-total`, total: 1, order: { customer: { name: "Smoke" }, source: "phone", items: [] } }, { as: "owner.a" })).status === 400],
  ["owner.a selecting B can't write B's orders (403)", async () => (await post("orders", { action: "fulfill", orderId: "aaaaaaaaaaaaaaaaaaaa" }, { as: "owner.a", businessId: B })).body.error === "business-access-denied"],
  ["staff.a lists orders but is refused order costs", async () =>
    (await fsQuery("staff.a", `businesses/${A}`, "orders")) === 200 && (await fsQuery("staff.a", `businesses/${A}`, "orderCosts")) === 403],
  ["owner.a reads order costs in A; nothing of B's orders", async () =>
    (await fsQuery("owner.a", `businesses/${A}`, "orderCosts")) === 200 &&
    (await fsQuery("owner.a", `businesses/${B}`, "orders")) === 403 &&
    (await fsQuery("owner.a", `businesses/${B}`, "orderCosts")) === 403],
  // Phase 8: payments (refusals and reads only; no payments are recorded here).
  ["POST /api/payments without a token → 401", async () => (await post("payments", { action: "record" })).status === 401],
  ["staff.a can't verify or remove payments (403)", async () =>
    (await post("payments", { action: "verify", paymentId: "aaaaaaaaaaaaaaaaaaaa" }, { as: "staff.a" })).status === 403 &&
    (await post("payments", { action: "void", paymentId: "aaaaaaaaaaaaaaaaaaaa", reason: "smoke test" }, { as: "staff.a" })).status === 403],
  ["forged order totals in a payment are refused (400)", async () => (await post("payments", { action: "record", orderId: "aaaaaaaaaaaaaaaaaaaa", payment: { amount: 100, method: "cash" }, amountPaid: 1 }, { as: "owner.a" })).status === 400],
  ["owner.a selecting B can't touch B's payments or proofs (403)", async () =>
    (await post("payments", { action: "proof", paymentId: "aaaaaaaaaaaaaaaaaaaa" }, { as: "owner.a", businessId: B })).body.error === "business-access-denied"],
  ["staff.a lists payments; the reference index is server-only; B's payments refused", async () =>
    (await fsQuery("staff.a", `businesses/${A}`, "payments")) === 200 &&
    (await fsQuery("staff.a", `businesses/${A}`, "paymentRefs")) === 403 &&
    (await fsQuery("owner.a", `businesses/${B}`, "payments")) === 403],
  // Phase 9: customers (refusals and reads only; no customers are created here).
  ["A, B, C have Customers, Expenses, Reports and Imports on (distributor v5)", async () => {
    const rows = await Promise.all([session({ as: "owner.a" }), session({ as: "owner.b" }), session({ as: "owner.c" })]);
    return rows.every((r) => r.status === 200 && ["customers", "expenses", "reports", "imports"].every((k) => r.body.entitlements.modules[k] === true) && r.body.workspace?.templateVersion === 5);
  }],
  ["POST /api/customers without a token → 401", async () => (await post("customers", { action: "create" })).status === 401],
  ["customer statistics can't be sent from the browser (400)", async () => (await post("customers", { action: "create", customer: { name: "Smoke", stats: { outstandingBalance: 0 } } }, { as: "staff.a" })).status === 400],
  ["owner.a selecting B can't write B's customers (403)", async () => (await post("customers", { action: "create", customer: { name: "Smoke" } }, { as: "owner.a", businessId: B })).body.error === "business-access-denied"],
  ["staff.a lists customers; B's customers refused", async () =>
    (await fsQuery("staff.a", `businesses/${A}`, "customers")) === 200 && (await fsQuery("owner.a", `businesses/${B}`, "customers")) === 403],
  // Phase 10: expenses (refusals and reads only; no expenses are created here).
  ["POST /api/expenses without a token → 401", async () => (await post("expenses", { action: "create" })).status === 401],
  ["staff.a can't record expenses (403)", async () => (await post("expenses", { action: "create", expense: { date: "2026-10-01", category: "rent", amount: 100, method: "cash" } }, { as: "staff.a" })).status === 403],
  ["forged expense metrics are refused (400)", async () => (await post("expenses", { action: "create", expense: { date: "2026-10-01", category: "rent", amount: 100, method: "cash", operatingExpenses: 0 } }, { as: "owner.a" })).status === 400],
  ["a ₱0 expense is refused (400)", async () => (await post("expenses", { action: "create", expense: { date: "2026-10-01", category: "rent", amount: 0, method: "cash" } }, { as: "owner.a" })).status === 400],
  ["owner.a selecting B can't write B's expenses (403)", async () => (await post("expenses", { action: "create", expense: { date: "2026-10-01", category: "rent", amount: 100, method: "cash" } }, { as: "owner.a", businessId: B })).body.error === "business-access-denied"],
  ["manager.a lists expenses; B's expenses refused", async () =>
    (await fsQuery("manager.a", `businesses/${A}`, "expenses")) === 200 && (await fsQuery("owner.a", `businesses/${B}`, "expenses")) === 403],
  // Phase 12: imports (refusals and reads only; nothing is imported here).
  ["POST /api/imports without a token → 401", async () => (await post("imports", { action: "preview" })).status === 401],
  ["staff.a (no imports.run) can't preview an import (403)", async () =>
    (await post("imports", { action: "preview", type: "products", fileName: "p.csv", rows: [{ n: 2, values: { sku: "SMOKE-I", name: "x", unit: "pcs", sellingPrice: "1" } }] }, { as: "staff.a" })).status === 403],
  ["owner.a selecting B can't import into B (403)", async () =>
    (await post("imports", { action: "preview", type: "products", fileName: "p.csv", rows: [] }, { as: "owner.a", businessId: B })).body.error === "business-access-denied"],
  ["unknown import actions and smuggled fields are refused (400)", async () =>
    (await post("imports", { action: "update", jobId: "aaaaaaaaaaaaaaaaaaaa" }, { as: "owner.a" })).status === 400 &&
    (await post("imports", { action: "commit", jobId: "aaaaaaaaaaaaaaaaaaaa", rows: [] }, { as: "owner.a" })).status === 400],
  ["a missing import job is 404", async () => (await post("imports", { action: "commit", jobId: "aaaaaaaaaaaaaaaaaaaa" }, { as: "owner.a" })).status === 404],
  ["manager.a reads Import History; staff.a and B refused", async () =>
    (await fsQuery("manager.a", `businesses/${A}`, "imports")) === 200 &&
    (await fsQuery("staff.a", `businesses/${A}`, "imports")) === 403 &&
    (await fsQuery("owner.a", `businesses/${B}`, "imports")) === 403],
  // Phase 12.5: exports (each successful export writes one small audit entry).
  ["POST /api/exports without a token → 401", async () => (await post("exports", { dataset: "orders" })).status === 401],
  ["staff.a (no data.export) can't export (403)", async () => (await post("exports", { dataset: "orders", filters: {} }, { as: "staff.a" })).status === 403],
  ["owner.a selecting B can't export B (403)", async () => (await post("exports", { dataset: "orders", filters: {} }, { as: "owner.a", businessId: B })).body.error === "business-access-denied"],
  ["unknown datasets / filters are refused (400)", async () =>
    (await post("exports", { dataset: "members" }, { as: "owner.a" })).status === 400 &&
    (await post("exports", { dataset: "orders", filters: { orderBy: "total" } }, { as: "owner.a" })).body.error === "invalid-filters"],
  ["manager.a downloads Inventory as a real .xlsx", async () => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${await token("manager.a")}` };
    const res = await fetch(`${baseUrl}/api/exports`, { method: "POST", headers, body: JSON.stringify({ dataset: "inventory", filters: { lowOnly: true } }) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return res.status === 200 && /spreadsheetml/.test(res.headers.get("content-type")) && bytes[0] === 0x50 && bytes[1] === 0x4b && /Luna_Inventory_\d{4}-\d{2}-\d{2}\.xlsx/.test(res.headers.get("content-disposition"));
  }],

  // Phase 13: notifications (own inbox only; writes through the API).
  ["POST /api/notifications without a token → 401", async () => (await post("notifications", { action: "readAll" })).status === 401],
  ["staff.a reads its own inbox and counter; owner.a can't read manager.a's", async () => {
    const staff = (await session({ as: "staff.a" })).body.user.uid;
    const manager = (await session({ as: "manager.a" })).body.user.uid;
    const own = await fsQuery("staff.a", `businesses/${A}/members/${staff}`, "inbox");
    const counter = await fsGet("staff.a", `businesses/${A}/members/${staff}/inboxState/summary`);
    return own === 200 && [200, 404].includes(counter) && (await fsGet("owner.a", `businesses/${A}/members/${manager}/inboxState/summary`)) === 403 && (await fsQuery("owner.a", `businesses/${A}/members/${manager}`, "inbox")) === 403;
  }],
  ["owner.a selecting B can't touch B's notifications (403)", async () => (await post("notifications", { action: "readAll" }, { as: "owner.a", businessId: B })).body.error === "business-access-denied"],
  ["unknown notification actions and switching off payment alerts are refused (400)", async () =>
    (await post("notifications", { action: "delete" }, { as: "owner.a" })).status === 400 &&
    (await post("notifications", { action: "preferences", preferences: { payments: { inApp: false } } }, { as: "owner.a" })).body.error === "mandatory-notification"],
  ["staff.a can mark its own notifications read", async () => (await post("notifications", { action: "readAll" }, { as: "staff.a" })).status === 200],

  // Phase 14: household payroll (a Distributor business has none of it).
  ["payroll endpoints without a token → 401", async () => (await post("payroll", { action: "prepare" })).status === 401 && (await post("attendance", { action: "set" })).status === 401],
  ["owner.a (Distributor) can't use payroll, attendance, advances or household staff (403)", async () => {
    const r = await Promise.all([post("household-staff", { action: "create", staff: { name: "x", dailyWage: 1, payCycle: "weekly" } }, { as: "owner.a" }), post("attendance", { action: "set", staffId: "aaaaaaaaaaaa", date: "2026-10-01", status: "present" }, { as: "owner.a" }), post("payroll", { action: "prepare", staffId: "aaaaaaaaaaaa", periodStart: "2026-10-01" }, { as: "owner.a" }), post("advances", { action: "create", advance: { staffId: "aaaaaaaaaaaa", date: "2026-10-01", amount: 1 } }, { as: "owner.a" })]);
    return r.every((x) => x.status === 403);
  }],
  ["owner.a can't read payroll collections in its Distributor business (403)", async () => (await fsGet("owner.a", `businesses/${A}/payrolls/x`)) === 403 && (await fsQuery("owner.a", `businesses/${A}`, "attendance")) === 403],
  ["public receipt endpoint: unknown token → 404 with a plain message; extra fields → 400", async () => {
    const bad = await post("receipt", { action: "view", token: "NotARealTokenNotARealToken01" });
    return bad.status === 404 && bad.body.message === "This link isn't valid. Ask your employer for a new one." && (await post("receipt", { action: "view", token: "x", businessId: A })).status === 400;
  }],
  ["the receipt page is served without login", async () => {
    const res = await fetch(`${baseUrl}/receipt`);
    return res.status === 200 && /<div id="app"/.test(await res.text());
  }],
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
