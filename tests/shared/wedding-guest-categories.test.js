import { describe, it, expect } from "vitest";
import { guestCategoryDelta, rsvpByCategory, validateGuestInput, GUEST_CATEGORY_IDS } from "../../shared/wedding.js";
import { guestsQuery } from "../../shared/list-queries.js";

const g = (over) => ({ partySize: 4, rsvp: "awaiting", confirmed: 0, ...over });

describe("guest categories (Phase 18.6)", () => {
  it("validates the category: one of the fixed list, or none", () => {
    expect(GUEST_CATEGORY_IDS).toContain("sponsors");
    expect(validateGuestInput({ name: "A", side: "both", partySize: 1, category: "family" }).category).toBe("family");
    expect(validateGuestInput({ name: "A", side: "both", partySize: 1, category: "" }).category).toBeNull();
    expect(() => validateGuestInput({ name: "A", side: "both", partySize: 1, category: "cousins" })).toThrow(/category/);
  });

  it("moves counts between categories; a guest with no category only counts in the totals", () => {
    expect(guestCategoryDelta(null, g({ category: "family" }))).toEqual({ family: { invitations: 1, invitedSeats: 4, awaiting: 1, awaitingSeats: 4 } });
    expect(guestCategoryDelta(g({ category: "family" }), g({ category: "family", rsvp: "attending", confirmed: 3 }))).toEqual({ family: { attending: 1, attendingSeats: 3, awaiting: -1, awaitingSeats: -4 } });
    expect(guestCategoryDelta(g({ category: "family" }), g({ category: "work" }))).toEqual({ family: { invitations: -1, invitedSeats: -4, awaiting: -1, awaitingSeats: -4 }, work: { invitations: 1, invitedSeats: 4, awaiting: 1, awaitingSeats: 4 } });
    expect(guestCategoryDelta(g({}), g({ partySize: 6 }))).toEqual({});
  });

  it("the guests list (and its Excel) filters on the stored category", () => {
    expect(guestsQuery({ category: "family", rsvp: "attending" }).parts[0].where).toEqual([["category", "==", "family"], ["rsvp", "==", "attending"]]);
    expect(guestsQuery({}).parts[0].where).toEqual([]);
  });

  it("dashboard rows: categories in order, then Not set = totals minus categories", () => {
    const doc = { invitations: 3, invitedSeats: 9, attending: 1, attendingSeats: 3, awaiting: 2, awaitingSeats: 6, byCategory: { work: { invitations: 1, invitedSeats: 3, attending: 1, attendingSeats: 3 }, family: { invitations: 1, invitedSeats: 4, awaiting: 1, awaitingSeats: 4 } } };
    const rows = rsvpByCategory(doc);
    expect(rows.map((r) => [r.label, r.invitedSeats, r.attendingSeats, r.awaitingSeats])).toEqual([["Family", 4, 0, 4], ["Work / Office", 3, 3, 0], ["Not set", 2, 0, 2]]);
    expect(rsvpByCategory({})).toEqual([]);
  });
});
