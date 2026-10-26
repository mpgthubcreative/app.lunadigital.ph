// Free trial RSVP capacity (2026-10-26; shared/wedding.js TRIAL_RSVP_GUESTS).
//   weddingSetup/trialRsvp   { guests: { [guestId]: seats }, used }  server-only
// Every guest that got RSVP access during the trial, with the people it
// counts for (its party size when the link was made, or later raised).
// Read and written inside the caller's transaction, so two links made at
// the same moment can't take the 21st place (the second one retries and
// sees the first). Only grows during the trial: removing a guest or
// shrinking a party frees nothing (those invitations were sent). Once the
// trial converts it's never consulted again; the links stay as they are.

import { trialOpen } from "../../../shared/trial.js";
import { WeddingError, TRIAL_RSVP_GUESTS, TRIAL_RSVP_LIMIT_MESSAGE } from "../../../shared/wedding.js";

export const trialRsvpRef = (tenant) => tenant.doc("weddingSetup", "trialRsvp");

export function trialRsvpUsage(snap) {
  const d = snap?.exists ? snap.data() : {};
  const guests = d.guests && typeof d.guests === "object" && !Array.isArray(d.guests) ? d.guests : {};
  const used = Object.values(guests).reduce((t, n) => t + (Number.isSafeInteger(n) && n > 0 ? n : 0), 0);
  return { used, limit: TRIAL_RSVP_GUESTS, guests };
}

// Read phase (before any write in the transaction).
export async function readTrialRsvp(tx, tenant) {
  const b = await tx.get(tenant.ref);
  const trial = trialOpen(b.exists ? b.data().subscription : null);
  return { trial, ...(trial ? trialRsvpUsage(await tx.get(trialRsvpRef(tenant))) : { used: 0, limit: TRIAL_RSVP_GUESTS, guests: {} }) };
}

// Write phase: this guest now counts for `seats` people. Nothing outside a
// trial; nothing more when it already counts for as many.
export function claimTrialRsvp(tx, tenant, state, guestId, seats) {
  if (!state.trial) return null;
  const had = state.guests[guestId] ?? 0;
  if (seats <= had) return { used: state.used, limit: state.limit };
  const used = state.used - had + seats;
  if (used > state.limit) throw new WeddingError("trial-rsvp-limit", TRIAL_RSVP_LIMIT_MESSAGE);
  tx.set(trialRsvpRef(tenant), { guests: { ...state.guests, [guestId]: seats }, used, updatedAt: new Date() });
  return { used, limit: state.limit };
}

// The Guests page: "RSVP trial: 12 / 20" (null once paid).
export async function readTrialRsvpUsage({ tenant }) {
  const b = await tenant.ref.get();
  if (!trialOpen(b.exists ? b.data().subscription : null)) return { trialRsvp: null };
  const u = trialRsvpUsage(await trialRsvpRef(tenant).get());
  return { trialRsvp: { used: u.used, limit: u.limit } };
}
