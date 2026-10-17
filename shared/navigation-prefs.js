// Per-user navigation arrangement (owner pilot, 2026-10-17; Household first,
// generic for every workspace). A PERSONAL preference, stored on the
// member's own record for one business (members/{uid}.navigationPreference):
//   { primary: ["expenses", "grocery", "payroll"] }
// the pages on the phone's main tabs, in order (up to three; More is always
// last and fixed; a Dashboard, where the workspace has one, stays first).
// It never changes modules, permissions or entitlements: the app shows only
// pages this member can open, and tops up from the template's default when
// a chosen page isn't available. Household staff (their own portal) don't use it.

import { MODULE_IDS, CORE_MODULE_IDS } from "./modules.js";

export const PRIMARY_TABS = 3;

export class NavigationPrefError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// null = back to the workspace's default; otherwise { primary: [1..3 page ids] }.
export function validateNavigationPreference(input) {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => k !== "primary")) throw new NavigationPrefError("invalid-input", "Invalid navigation");
  const p = input.primary;
  if (!Array.isArray(p) || p.length < 1 || p.length > PRIMARY_TABS) throw new NavigationPrefError("invalid-input", `Choose 1 to ${PRIMARY_TABS} main pages`);
  const seen = new Set();
  for (const id of p) {
    if (typeof id !== "string" || !MODULE_IDS.includes(id) || CORE_MODULE_IDS.includes(id)) throw new NavigationPrefError("invalid-input", "That page can't be a main tab");
    if (seen.has(id)) throw new NavigationPrefError("invalid-input", "Each page once");
    seen.add(id);
  }
  return { primary: [...p] };
}
