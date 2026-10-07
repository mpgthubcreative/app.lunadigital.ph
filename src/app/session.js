// The session describes WHO is using Luna and WHAT their business is
// allowed to do: user, business, permissions, plan, subscription,
// entitlements and usage. It comes from GET /api/session, which resolves
// all of it server-side from the verified ID token + membership records.
//
// The shell configures navigation and screens entirely from this object —
// nothing in the UI checks a role name or plan id directly. The session
// only shapes the UI; security is enforced server-side on every request.

import { api, setBusinessSelector } from "../lib/api.js";

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
  return {
    environment: data.environment,
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
