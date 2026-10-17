// Owner-pilot Bridal: wedding roles live ON the guest record (one record
// drives RSVP, seats, category, role, seating and the invitation):
//   guests/{id}.roles    [{ id: "principal_sponsor" }, { id: "custom", label: "Program host" }]
//   guests/{id}.roleKeys ["principal_sponsor", "custom:program host"]   (for queries)
// Single roles (Best Man…) belong to one guest at a time; the others take
// any number of people. Removing a role never touches the guest or RSVP.
// The invitation can later personalize wording from the roles (not yet).

import { WeddingError, keyOf } from "./wedding.js";

export const WEDDING_ROLES = Object.freeze({
  bride: { label: "Bride", plural: "Bride", single: true },
  groom: { label: "Groom", plural: "Groom", single: true },
  maid_of_honor: { label: "Maid / Matron of Honor", plural: "Maid / Matron of Honor", single: true },
  best_man: { label: "Best Man", plural: "Best Man", single: true },
  principal_sponsor: { label: "Principal Sponsor", plural: "Principal Sponsors" },
  candle_sponsor: { label: "Secondary Sponsor — Candle", plural: "Candle Sponsors" },
  veil_sponsor: { label: "Secondary Sponsor — Veil", plural: "Veil Sponsors" },
  cord_sponsor: { label: "Secondary Sponsor — Cord", plural: "Cord Sponsors" },
  bridesmaid: { label: "Bridesmaid", plural: "Bridesmaids" },
  groomsman: { label: "Groomsman", plural: "Groomsmen" },
  flower_girl: { label: "Flower Girl", plural: "Flower Girls" },
  ring_bearer: { label: "Ring Bearer", plural: "Ring Bearers" },
  coin_bearer: { label: "Coin / Arras Bearer", plural: "Coin / Arras Bearers" },
  bible_bearer: { label: "Bible Bearer", plural: "Bible Bearers" },
  entourage: { label: "Entourage", plural: "Entourage" },
  bride_parents: { label: "Bride's Parent", plural: "Bride's Parents" },
  groom_parents: { label: "Groom's Parent", plural: "Groom's Parents" },
});
export const WEDDING_ROLE_IDS = Object.freeze(Object.keys(WEDDING_ROLES));
export const MAX_ROLES_PER_GUEST = 10;
// The guest category a NEW guest gets when added straight from a role.
export const categoryForRole = (r) => (r.id === "custom" ? "other" : /_sponsor$/.test(r.id) ? "sponsors" : ["bride", "groom", "bride_parents", "groom_parents"].includes(r.id) ? "family" : "entourage");

// A role as stored, or an error: { id } (built in) or { id: "custom", label }.
export function validateRole(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WeddingError("invalid-input", "Choose a role");
  for (const k of Object.keys(input)) if (!["id", "label"].includes(k)) throw new WeddingError("invalid-input", "Choose a role");
  if (input.id === "custom") {
    const label = typeof input.label === "string" ? input.label.trim().replace(/\s+/g, " ") : "";
    if (!label || label.length > 40) throw new WeddingError("invalid-input", "Name the custom role (up to 40 characters)");
    return { id: "custom", label };
  }
  if (!WEDDING_ROLE_IDS.includes(input.id) || input.label !== undefined) throw new WeddingError("invalid-input", "Choose a role");
  return { id: input.id };
}
export const roleKey = (r) => (r.id === "custom" ? `custom:${keyOf(r.label)}` : r.id);
export const roleLabel = (r, { plural = false } = {}) => (r.id === "custom" ? r.label : WEDDING_ROLES[r.id]?.[plural ? "plural" : "label"] ?? r.id);
export const isSingleRole = (r) => r.id !== "custom" && WEDDING_ROLES[r.id]?.single === true;

// Roles view: one group per role (built-in order, then custom by name),
// each with its guests (by name). Guests without roles aren't listed.
export function rolesPlan(guests) {
  const groups = new Map();
  for (const g of guests || []) {
    for (const r of Array.isArray(g.roles) ? g.roles : []) {
      const key = roleKey(r);
      if (!groups.has(key)) groups.set(key, { key, role: r, label: roleLabel(r, { plural: true }), guests: [] });
      groups.get(key).guests.push(g);
    }
  }
  const rank = (k) => (WEDDING_ROLE_IDS.includes(k) ? WEDDING_ROLE_IDS.indexOf(k) : 1000);
  const list = [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));
  for (const gr of list) gr.guests.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}
