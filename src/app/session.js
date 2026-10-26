// The session describes WHO is using Luna and WHAT their business is
// allowed to do: user, business, permissions, plan, subscription,
// entitlements and usage. It comes from GET /api/session, which resolves
// all of it server-side from the verified ID token + membership records.
//
// The shell configures navigation and screens entirely from this object —
// nothing in the UI checks a role name or plan id directly. The session
// only shapes the UI; security is enforced server-side on every request.

import { api, setBusinessSelector } from "../lib/api.js";
import { deploymentMismatches } from "@shared/environment.js";

// Environment consistency (2026-10-25): this build and the server must be
// the same deployment (environment, Firebase project, and in production
// the site address). A mismatch stops the app before any business data shows.
export function checkDeployment(server, client = { environment: import.meta.env.VITE_LUNA_ENV, projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID, origin: globalThis.location?.origin }) {
  const wrong = deploymentMismatches(client, server);
  if (!wrong.length) return;
  const err = new Error(`This version of Luna doesn't match its server (${wrong.join(", ")}). Nothing was loaded. Please contact Luna support.`);
  err.code = "deployment-mismatch";
  err.status = 503;
  throw err;
}

const SELECTED_BUSINESS_KEY = "luna.selectedBusinessId";

// The remembered business is a convenience preference only. If the user
// no longer has access to it, the server rejects it and we fall back to
// their default business.
export function getPreferredBusinessId() {
  try {
    return window.localStorage.getItem(SELECTED_BUSINESS_KEY);
  } catch {
    return null;
  }
}

export function setPreferredBusinessId(businessId) {
  try {
    if (businessId) window.localStorage.setItem(SELECTED_BUSINESS_KEY, businessId);
    else window.localStorage.removeItem(SELECTED_BUSINESS_KEY);
  } catch {
    // storage unavailable (private mode) — selection just won't persist
  }
}

async function fetchSession(businessId) {
  setBusinessSelector(() => businessId);
  const data = await api("session");
  checkDeployment(data.deployment);
  return {
    environment: data.environment,
    // This workspace's own public address (custom workspace link), when claimed.
    publicLink: data.publicLink ?? null,
    user: data.user,
    business: data.business,
    member: { ...data.member, permissions: data.permissions },
    plan: data.plan,
    subscription: data.subscription,
    entitlements: data.entitlements,
    usage: data.usage,
    memberships: data.memberships,
  };
}

export async function loadSession() {
  const preferred = getPreferredBusinessId();
  try {
    const session = await fetchSession(preferred);
    setPreferredBusinessId(session.business.id);
    setBusinessSelector(() => session.business.id);
    return session;
  } catch (err) {
    // A stale remembered business (removed/disabled) must not lock the
    // user out of their other businesses: retry once with no selector.
    if (preferred && err.status === 403) {
      setPreferredBusinessId(null);
      const session = await fetchSession(null);
      setPreferredBusinessId(session.business.id);
      setBusinessSelector(() => session.business.id);
      return session;
    }
    throw err;
  }
}
