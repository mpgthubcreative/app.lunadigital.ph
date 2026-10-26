// Custom workspace links: claim / rename / setup / resolve (server only).
// Rules and vocabulary: shared/custom-links.js. Netlify: ./netlify-domains.js.
//
// Records (top level, server-only; Firestore rules deny all):
//   publicLinks/{label}          one per name (current or previous), global
//   publicLinkStats/summary      { names }: names held (= Netlify aliases)
//   platformLocks/netlify-domains  the alias-change lease
// and businesses/{bid}.customLink { label, setup, previous, updatedAt }.
//
// A claim is ONE transaction: the paid check, the name's owner, the
// workspace's other names (they now point here) and the capacity count are
// read together, so two claims of one name, or a claim racing a downgrade,
// can't both win. The address is "pending" until Netlify has the alias and
// HTTPS answers; only then "active". A pending name stays held; nothing is
// released automatically (scripts/custom-links.js release, after the hold).

import { normalizeLinkInput, linkLabelProblem, isLinkLabel, customLinkAllowed, customLinkEntitled, linkAddOnOf, addOnPaid, customLinkState, customLinkHost, CUSTOM_LINK_LOCKED_MESSAGE, CUSTOM_LINK_MAX_PREVIOUS, CUSTOM_LINK_ALIAS_WARN, CUSTOM_LINK_ALIAS_LIMIT } from "../../../shared/custom-links.js";
import { withDomainsLock, httpsReady as defaultHttpsReady, NetlifyDomainsError } from "./netlify-domains.js";

export class CustomLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new CustomLinkError(code, message);
};

const linkRef = (db, label) => db.collection("publicLinks").doc(label);
const statsRef = (db) => db.collection("publicLinkStats").doc("summary");
const PENDING_NOTE = "Getting your link ready. This usually takes a few minutes.";
const WAITING_NOTE = "Luna is finishing your link. It will be ready soon.";

export const customLinkDomain = (env = process.env) => env.VITE_CUSTOM_LINK_DOMAIN || null;

const plansRef = (db, sub) => db.collection("plans").doc(typeof sub?.planId === "string" && sub.planId ? sub.planId : "none");
const ADD_ON_LOCKED = (a) => `Get the ${a.label} (+₱${Math.round(a.price / 100).toLocaleString("en-PH")}) to choose your own address.`;

// The add-on that sells the link (if the plan has one) and where it stands:
// "none" (not bought), "billed" (bill to pay), "waiting" (payment sent, Luna
// confirms), "paid".
async function addOnState(db, sub, plan) {
  const a = linkAddOnOf(plan);
  if (!a) return null;
  let status = "none";
  let invoiceId = null;
  if (addOnPaid(sub, a.id)) status = "paid";
  else if (sub?.addOnDue?.addOnId === a.id && sub.addOnDue.invoiceId) {
    const inv = await db.collection("subscriptionInvoices").doc(sub.addOnDue.invoiceId).get();
    if (inv.exists && inv.data().status !== "paid") ({ status, invoiceId } = { status: inv.data().status === "for_verification" ? "waiting" : "billed", invoiceId: inv.id });
  }
  return { id: a.id, label: a.label, price: a.price, status, invoiceId };
}

// What Settings shows (any member who can see Settings).
export async function readCustomLink({ db, businessId, domain }) {
  const b = await db.collection("businesses").doc(businessId).get();
  const biz = b.exists ? b.data() : {};
  const cur = biz.customLink || null;
  const plan = await plansRef(db, biz.subscription).get().then((p) => (p.exists ? p.data() : null));
  const addOn = await addOnState(db, biz.subscription, plan);
  const paidPlan = customLinkAllowed(biz.subscription);
  return {
    available: Boolean(domain),
    domain,
    allowed: customLinkEntitled(biz.subscription, plan),
    paidPlan,
    addOn,
    lockedMessage: paidPlan && addOn && addOn.status !== "paid" ? ADD_ON_LOCKED(addOn) : CUSTOM_LINK_LOCKED_MESSAGE,
    state: customLinkState(biz.subscription),
    link: cur?.label && domain ? { label: cur.label, host: customLinkHost(cur.label, domain), setup: cur.setup || "pending", previous: cur.previous || [], note: cur.setup === "active" ? null : cur.note || PENDING_NOTE } : null,
    changesLeft: Math.max(0, CUSTOM_LINK_MAX_PREVIOUS - (cur?.previous?.length || 0)),
  };
}

// The Settings availability check (informational; the claim decides).
export async function checkCustomLink({ db, businessId, input, domain }) {
  if (!domain) fail("not-configured", "Custom links aren't available yet.");
  const b = await db.collection("businesses").doc(businessId).get();
  if (!b.exists || !customLinkAllowed(b.data().subscription)) fail("paid-only", CUSTOM_LINK_LOCKED_MESSAGE);
  const plan = await plansRef(db, b.data().subscription).get().then((p) => (p.exists ? p.data() : null));
  if (!customLinkEntitled(b.data().subscription, plan)) fail("add-on-required", ADD_ON_LOCKED(linkAddOnOf(plan)));
  const label = normalizeLinkInput(input, domain);
  const problem = linkLabelProblem(label);
  if (problem) return { label, available: false, reason: problem };
  const snap = await linkRef(db, label).get();
  if (snap.exists && snap.data().businessId !== businessId) return { label, available: false, reason: "That link is already taken. Try another." };
  return { label, available: true, host: customLinkHost(label, domain) };
}

export async function claimCustomLink({ db, FieldValue, businessId, input, actor, domain }) {
  if (!domain) fail("not-configured", "Custom links aren't available yet.");
  const label = normalizeLinkInput(input, domain);
  const problem = linkLabelProblem(label);
  if (problem) fail("invalid-link", problem);
  const bizRef = db.collection("businesses").doc(businessId);
  try {
    return await claimOnce({ db, FieldValue, bizRef, businessId, label, actor });
  } catch (err) {
    // Two claims at once: the loser's create meets the winner's name.
    if (err?.code === 6 || /already exists/i.test(err?.message || "")) fail("link-taken", "That link is already taken. Try another.");
    throw err;
  }
}
async function claimOnce({ db, FieldValue, bizRef, businessId, label, actor }) {
  return db.runTransaction(async (tx) => {
    const b = await tx.get(bizRef);
    if (!b.exists) fail("not-found", "Workspace not found.");
    const biz = b.data();
    if (!customLinkAllowed(biz.subscription)) fail("paid-only", CUSTOM_LINK_LOCKED_MESSAGE);
    const planSnap = await tx.get(plansRef(db, biz.subscription));
    const plan = planSnap.exists ? planSnap.data() : null;
    if (!customLinkEntitled(biz.subscription, plan)) fail("add-on-required", ADD_ON_LOCKED(linkAddOnOf(plan)));
    const target = await tx.get(linkRef(db, label));
    const stats = await tx.get(statsRef(db));
    const mine = (await tx.get(db.collection("publicLinks").where("businessId", "==", businessId))).docs;
    if (target.exists && target.data().businessId !== businessId) fail("link-taken", "That link is already taken. Try another.");
    const cur = biz.customLink || null;
    if (cur?.label === label) return { label, setup: cur.setup || "pending", unchanged: true };
    const previous = [...new Set([...(cur?.previous || []), ...(cur?.label ? [cur.label] : [])])].filter((x) => x !== label);
    if (previous.length > CUSTOM_LINK_MAX_PREVIOUS) fail("too-many-changes", `This link was already changed ${CUSTOM_LINK_MAX_PREVIOUS} times. Contact Luna to change it again.`);
    const names = Number.isSafeInteger(stats.exists ? stats.data().names : 0) ? (stats.exists ? stats.data().names : 0) : 0;
    const isNew = !target.exists;
    if (isNew && names >= CUSTOM_LINK_ALIAS_LIMIT) fail("capacity", "Custom links are temporarily full. Luna has been notified; please try again later.");
    const stamp = FieldValue.serverTimestamp();
    const setup = isNew ? "pending" : target.data().setup || "pending";
    if (isNew) tx.create(linkRef(db, label), { businessId, workspaceTemplateId: biz.workspaceTemplateId ?? null, kind: "current", current: label, setup: "pending", setupError: null, createdAt: stamp, updatedAt: stamp });
    else tx.update(linkRef(db, label), { kind: "current", current: label, updatedAt: stamp });
    // Every older name now leads to this one.
    for (const d of mine) if (d.id !== label) tx.update(d.ref, { kind: "previous", current: label, updatedAt: stamp });
    if (isNew) tx.set(statsRef(db), { names: FieldValue.increment(1), updatedAt: stamp }, { merge: true });
    tx.update(bizRef, { customLink: { label, setup, previous, note: setup === "active" ? null : PENDING_NOTE, updatedAt: stamp } });
    const summary = cur?.label ? `Custom link changed ${cur.label} → ${label}` : `Custom link claimed: ${label}`;
    tx.set(db.collection("platformAudit").doc(), { type: "custom-link.claimed", summary, businessId, label, previous: cur?.label ?? null, actor: actor ?? null, at: stamp });
    tx.set(bizRef.collection("auditLog").doc(), { type: "custom-link.claimed", summary, label, previous: cur?.label ?? null, actor: actor ?? null, at: stamp });
    return { label, setup, previous, created: isNew, names: names + (isNew ? 1 : 0) };
  });
}

// Finish the workspace's names that aren't ready: Netlify alias, then the
// certificate, then the HTTPS check. Safe to repeat (retry). Without a
// Netlify client nothing is called and the link stays pending (Luna
// finishes it with scripts/custom-links.js).
export async function finishCustomLinks({ db, FieldValue, businessId, domain, domains, httpsReady = defaultHttpsReady }) {
  if (!domain) return { setup: "pending" };
  const pending = (await db.collection("publicLinks").where("businessId", "==", businessId).get()).docs.filter((d) => d.data().setup !== "active");
  const stamp = () => FieldValue.serverTimestamp();
  const bizRef = db.collection("businesses").doc(businessId);
  const note = async (labelNote, error = null) => {
    for (const d of pending) await d.ref.update({ setupError: error, updatedAt: stamp() });
    const b = await bizRef.get();
    if (b.exists && b.data().customLink && b.data().customLink.setup !== "active") await bizRef.update({ "customLink.note": labelNote });
  };
  if (!pending.length) return { setup: (await bizRef.get()).data()?.customLink?.setup ?? null };
  if (!domains) {
    await note(WAITING_NOTE, "netlify-not-configured");
    return { setup: "pending", waiting: true };
  }
  let count = null;
  try {
    await withDomainsLock(db, `custom-link:${businessId}`, async () => {
      const site = await domains.site();
      count = site.aliases.length;
      for (const d of pending) {
        const host = customLinkHost(d.id, domain);
        if (site.aliases.includes(host)) continue;
        if (count >= CUSTOM_LINK_ALIAS_LIMIT) throw new NetlifyDomainsError("capacity", `The site has ${count} addresses (limit ${CUSTOM_LINK_ALIAS_LIMIT}).`);
        count = (await domains.addAlias(host)).count;
      }
    });
    await domains.provisionCertificate();
  } catch (err) {
    if (!(err instanceof NetlifyDomainsError)) throw err;
    await note(err.code === "busy" ? PENDING_NOTE : WAITING_NOTE, err.code);
    await db.collection("platformAudit").doc().set({ type: "custom-link.setup-failed", summary: `Custom link setup failed (${err.code}): ${err.message}`, businessId, labels: pending.map((d) => d.id), at: stamp() });
    return { setup: "pending", error: err.code };
  }
  if (count !== null && count >= CUSTOM_LINK_ALIAS_WARN) await db.collection("platformAudit").doc().set({ type: "custom-link.capacity", summary: `Custom links: ${count} of about ${CUSTOM_LINK_ALIAS_LIMIT} site addresses used. Time to plan the wildcard domain.`, count, at: stamp() });
  const currentLabel = (await bizRef.get()).data()?.customLink?.label ?? null;
  let current = null;
  for (const d of pending) {
    const ready = await httpsReady(customLinkHost(d.id, domain));
    if (ready) await d.ref.update({ setup: "active", setupError: null, readyAt: stamp(), updatedAt: stamp() });
    if (d.id === currentLabel) current = ready;
  }
  if (current === true) await bizRef.update({ "customLink.setup": "active", "customLink.note": null });
  else if (current === false) await bizRef.update({ "customLink.note": PENDING_NOTE });
  return { setup: current === true ? "active" : "pending", aliases: count };
}

// Which business a custom address belongs to (any of its names), for the
// public pages' token check. null = not a Luna custom link.
export async function linkBusinessId(db, label) {
  if (!isLinkLabel(label)) return null;
  const snap = await linkRef(db, label).get();
  return snap.exists ? snap.data().businessId : null;
}

// What a custom address shows (public; never tenant data beyond what that
// workspace's public page already shows).
const NOT_FOUND = { status: "not-found" };
export async function resolveCustomHost({ db, label, domain, appOrigin }) {
  if (!domain || !isLinkLabel(label)) return NOT_FOUND;
  const snap = await linkRef(db, label).get();
  if (!snap.exists) return NOT_FOUND;
  const r = snap.data();
  if (r.kind === "previous" && r.current && r.current !== label) {
    const cur = await linkRef(db, r.current).get();
    if (cur.exists && cur.data().setup === "active" && cur.data().businessId === r.businessId) return { status: "moved", host: customLinkHost(r.current, domain) };
  }
  const b = await db.collection("businesses").doc(r.businessId).get();
  if (!b.exists) return { status: "retired" };
  const biz = b.data();
  const state = customLinkState(biz.subscription);
  if (state !== "live") return { status: state };
  const workspace = biz.workspaceTemplateId ?? null;
  let storeSlug = null;
  if (workspace === "distributor") {
    const s = await db.collection("businesses").doc(r.businessId).collection("storefront").doc("settings").get();
    storeSlug = s.exists && typeof s.data().slug === "string" ? s.data().slug : null;
  }
  return { status: "live", workspace, name: biz.name || "", storeSlug, appOrigin };
}

// Super Admin: every name, its workspace and state, and the site count.
export async function listCustomLinks({ db, domain }) {
  const [links, stats] = await Promise.all([db.collection("publicLinks").limit(500).get(), statsRef(db).get()]);
  const ids = [...new Set(links.docs.map((d) => d.data().businessId))];
  const biz = new Map();
  for (let i = 0; i < ids.length; i += 100) for (const s of await db.getAll(...ids.slice(i, i + 100).map((id) => db.collection("businesses").doc(id)))) biz.set(s.id, s.exists ? s.data() : null);
  const rows = links.docs.map((d) => {
    const r = d.data();
    const b = biz.get(r.businessId);
    return { label: d.id, host: domain ? customLinkHost(d.id, domain) : d.id, businessId: r.businessId, businessName: b?.name ?? "(deleted)", workspaceTemplateId: r.workspaceTemplateId, kind: r.kind, current: r.current, setup: r.setup, setupError: r.setupError ?? null, subscriptionStatus: b?.subscription?.status ?? null, state: b ? customLinkState(b.subscription) : "retired" };
  });
  rows.sort((a, b) => (a.businessName || "").localeCompare(b.businessName || "") || (a.kind === "current" ? -1 : 1));
  return { domain, names: stats.exists ? stats.data().names ?? rows.length : rows.length, warnAt: CUSTOM_LINK_ALIAS_WARN, limit: CUSTOM_LINK_ALIAS_LIMIT, rows };
}
