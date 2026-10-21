// Reception seating per PERSON (2026-10-21). The RSVP stays party-based;
// each confirmed person gets their own table. Sanrah's Party (5 confirmed,
// named Sanrah + Mayet): Sanrah → Table 1, Mayet → Table 2, Member 3 →
// Table 1, the rest unassigned. Capacity counts people; one table per
// person; only confirmed people of an Attending party; a lower RSVP count
// frees the last people's seats and says so; older whole-party records
// still read and convert on their next change.

import { describe, it, expect, beforeEach } from "vitest";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createInviteHandler } from "../../netlify/functions/invite.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request, roomForTeam } from "../helpers/tenants.js";
import { SEATING_DOC_ID } from "../../shared/wedding.js";
import { seatingPlan, seatablePeople, seatsOf, reconcileSeats } from "../../shared/wedding-seating.js";

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "biz-wed";
let world;
let u;
beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W });
  await roomForTeam(world, W);
  const x = await ensureAuthUser({ auth: world.auth, email: "camille@seat.test", name: "Camille" });
  await addMember({ ...world, businessId: W, uid: x.uid, email: x.email, name: "Camille", roleTemplate: "owner", isAccountOwner: true });
  u = { camille: x.uid };
});
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const api = async (body, handler = createGuestsHandler) => {
  const res = await handler(deps())({ ...request({ uid: u.camille, businessId: W, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const doc = (p) => world.db.docs.get(`businesses/${W}/${p}`);
const guestsAll = () => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${W}/guests/`)).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
const plan = () => seatingPlan(guestsAll(), doc(`guestTotals/${SEATING_DOC_ID}`));
const table = (name, capacity) => api({ action: "createTable", table: { name, capacity } }).then((r) => ok(r, 201).tableId);
const seat = (guestId, seatKey, tableId) => api({ action: "seatPerson", guestId, seatKey, tableId });

async function sanrahsParty() {
  const g = ok(await api({ action: "create", guest: { name: "Sanrah", category: "family", side: "bride", partySize: 5 } }), 201).guestId;
  const mayet = ok(await api({ action: "addMember", guestId: g, name: "Mayet" }), 201).memberId;
  ok(await api({ action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 5 } }));
  return { g, mayet };
}

describe("shared rules: who can be seated", () => {
  it("the confirmed people, marked attending first, then named, then unnamed (Member n); none unless Attending", () => {
    const g = { name: "Sanrah", rsvp: "attending", confirmed: 4, partySize: 5, members: [{ id: "mMayet00001", name: "Mayet" }, { id: "mJo00000001", name: "Jo", attending: true }] };
    expect(seatablePeople(g).map((p) => [p.key, p.name])).toEqual([["mJo00000001", "Jo"], ["primary", "Sanrah"], ["mMayet00001", "Mayet"], ["u1", "Member 4"]]);
    expect(seatablePeople({ ...g, rsvp: "declined" })).toEqual([]);
    expect(seatablePeople({ ...g, confirmed: 1 }).map((p) => p.key)).toEqual(["mJo00000001"]);
  });
  it("an older whole-party record reads as every confirmed person at its table; reconcile frees only what no longer fits", () => {
    const old = { name: "Tan", rsvp: "attending", confirmed: 3, partySize: 3, tableId: "tOld1234" };
    expect(seatsOf(old)).toEqual({ primary: "tOld1234", u1: "tOld1234", u2: "tOld1234" });
    const r = reconcileSeats(old, { ...old, confirmed: 2 });
    expect(r.fields).toEqual({ seats: { primary: "tOld1234", u1: "tOld1234" }, tableIds: ["tOld1234"], tableId: null });
    expect(r.released).toEqual([{ key: "u2", name: "Member 3", tableId: "tOld1234" }]);
  });
});

describe("Sanrah's Party: 5 confirmed, seated one person at a time", () => {
  it("Sanrah → Table 1, Mayet → Table 2, Member 3 → Table 1, the rest unassigned; counts are people", async () => {
    const { g, mayet } = await sanrahsParty();
    const t1 = await table("Table 1", 10);
    const t2 = await table("Table 2", 10);
    ok(await seat(g, "primary", t1));
    ok(await seat(g, mayet, t2));
    ok(await seat(g, "u1", t1));
    expect(doc(`guests/${g}`)).toMatchObject({ seats: { primary: t1, [mayet]: t2, u1: t1 }, tableIds: [t1, t2].sort(), rsvp: "attending", confirmed: 5, partySize: 5 });
    const p = plan();
    expect(p.tables.map((t) => [t.name, t.used, t.people.map((x) => x.name)])).toEqual([["Table 1", 2, ["Sanrah", "Member 3"]], ["Table 2", 1, ["Mayet"]]]);
    expect(p.unassigned[0].people.map((x) => x.name)).toEqual(["Member 4", "Member 5"]);
    expect([p.attendingSeats, p.seatedSeats, p.unassignedSeats]).toEqual([5, 3, 2]);
    expect(doc(`guests/${g}`).history.slice(-3).map((h) => h.label)).toEqual(["Sanrah seated at Table 1", "Mayet seated at Table 2", "Member 3 seated at Table 1"]);
  });

  it("moving or unassigning one person never touches the others; a person is at one table only", async () => {
    const { g, mayet } = await sanrahsParty();
    const t1 = await table("Table 1", 10);
    const t2 = await table("Table 2", 10);
    ok(await seat(g, "primary", t1));
    ok(await seat(g, mayet, t2));
    ok(await seat(g, "primary", t2)); // move Sanrah
    expect(doc(`guests/${g}`).seats).toEqual({ primary: t2, [mayet]: t2 });
    expect(doc(`guests/${g}`).history.at(-1).label).toBe("Sanrah moved from Table 1 to Table 2");
    ok(await seat(g, "primary", null)); // unassign Sanrah
    expect(doc(`guests/${g}`).seats).toEqual({ [mayet]: t2 });
    expect(ok(await seat(g, mayet, t2)).unchanged).toBe(true);
    expect(plan().tables.map((t) => t.used)).toEqual([0, 1]);
  });

  it("capacity counts people: a full table refuses one more; the whole-party seat needs room for everyone", async () => {
    const { g, mayet } = await sanrahsParty();
    const small = await table("Table 3", 2);
    ok(await seat(g, "primary", small));
    ok(await seat(g, mayet, small));
    const full = await seat(g, "u1", small);
    expect(full).toMatchObject({ status: 409, body: { error: "table-full", message: "Table 3 is full (2 seats). Choose another table or add seats." } });
    const big = await table("Table 4", 4);
    const party = await api({ action: "seat", guestId: g, tableId: big });
    expect(party.body).toMatchObject({ error: "table-full" });
    expect(party.body.message).toMatch(/Table 4 has only 4 seats left; Sanrah's party needs 5/);
    expect(plan().tables.find((t) => t.name === "Table 3").used).toBe(2);
  });

  it("only confirmed people of an Attending party: not a declined party, not more members than confirmed", async () => {
    const { g } = await sanrahsParty();
    const t1 = await table("Table 1", 10);
    ok(await api({ action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 3 } }));
    expect((await seat(g, "u2", t1)).body.message).toBe("Only the 3 confirmed people of Sanrah's party can be seated"); // Member 4
    ok(await api({ action: "setRsvp", guestId: g, rsvp: { status: "declined" } }));
    expect((await seat(g, "primary", t1)).body.message).toBe("Only guests who are attending can be seated");
    expect((await seat(g, "x9", t1)).status).toBe(400);
  });

  it("RSVP down: the last people's seats are freed and named (history + toast); RSVP up: new people start unassigned", async () => {
    const { g, mayet } = await sanrahsParty();
    const t1 = await table("Table 1", 10);
    const t2 = await table("Table 2", 10);
    for (const [k, t] of [["primary", t1], [mayet, t2], ["u1", t1], ["u2", t1], ["u3", t2]]) ok(await seat(g, k, t));
    const down = ok(await api({ action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 3 } }));
    expect(down.unseated).toEqual(["Member 4", "Member 5"]);
    expect(doc(`guests/${g}`).seats).toEqual({ primary: t1, [mayet]: t2, u1: t1 });
    expect(doc(`guests/${g}`).history.at(-1).label).toBe("Owner changed: Attending 5 → Attending 3 · seats freed: Member 4 (Table 1), Member 5 (Table 2)");
    ok(await api({ action: "setRsvp", guestId: g, rsvp: { status: "attending", confirmed: 5 } }));
    expect(doc(`guests/${g}`).seats).toEqual({ primary: t1, [mayet]: t2, u1: t1 });
    expect(plan().unassigned[0].people.map((x) => x.name)).toEqual(["Member 4", "Member 5"]);
  });

  it("naming an unnamed seated person keeps their table; removing a named member frees theirs", async () => {
    const { g, mayet } = await sanrahsParty();
    const t1 = await table("Table 1", 10);
    ok(await seat(g, "u1", t1)); // Member 3
    ok(await seat(g, "u2", t1)); // Member 4
    const jo = ok(await api({ action: "addMember", guestId: g, name: "Jo" }), 201).memberId;
    expect(doc(`guests/${g}`).seats).toEqual({ [jo]: t1, u1: t1 }); // Jo took Member 3's seat; Member 4 is now "Member 4" again as u1
    expect(seatablePeople({ id: g, ...doc(`guests/${g}`) }).find((p) => p.key === "u1").name).toBe("Member 4");
    ok(await seat(g, mayet, t1));
    ok(await api({ action: "removeMember", guestId: g, memberId: mayet }));
    expect(doc(`guests/${g}`).seats).toEqual({ [jo]: t1, u1: t1 });
    expect(doc(`guests/${g}`).history.at(-1).label).toBe("Party member removed: Mayet · seat freed: Mayet");
  });

  it("an older whole-party record: shown per person, converted on the next change; deleting a table frees its people", async () => {
    const { g } = await sanrahsParty();
    const t1 = await table("Table 1", 10);
    const ref = `businesses/${W}/guests/${g}`;
    const { seats, tableIds, ...rest } = world.db.docs.get(ref);
    world.db.docs.set(ref, { ...rest, tableId: t1 }); // as stored before 2026-10-21
    expect(plan().tables[0].used).toBe(5);
    ok(await seat(g, "u3", null)); // Member 5 leaves the table
    expect(doc(`guests/${g}`)).toMatchObject({ tableId: null, tableIds: [t1] });
    expect(Object.keys(doc(`guests/${g}`).seats)).toHaveLength(4);
    expect(ok(await api({ action: "deleteTable", tableId: t1 })).unseated).toBe(4);
    expect(doc(`guests/${g}`).seats).toEqual({});
  });

  it("the guest's own RSVP through their link follows the same rule", async () => {
    ok(await api({ action: "save", setup: { coupleNames: "Camille & Carlo", weddingDate: "2027-02-14", rsvpEnabled: true, closeAfterDeadline: false } }, createWeddingSetupHandler));
    const { g, mayet } = await sanrahsParty();
    const t1 = await table("Table 1", 10);
    ok(await seat(g, "primary", t1));
    ok(await seat(g, mayet, t1));
    const token = ok(await api({ action: "inviteLink", guestId: g })).path.split("/").pop();
    const res = await createInviteHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "respond", token, rsvp: { status: "attending", confirmed: 1 } }) });
    expect(res.statusCode).toBe(200);
    expect(doc(`guests/${g}`).seats).toEqual({ primary: t1 });
    expect(doc(`guests/${g}`).history.at(-1).label).toMatch(/seats freed: Mayet \(Table 1\)$/);
  });
});
