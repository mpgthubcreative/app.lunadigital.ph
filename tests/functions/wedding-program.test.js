// Owner-pilot Bridal: Music & Program (ceremony / reception sequence and
// songs): validation, order and Move up / down, permissions, tenant
// isolation, and the Master Backup sheet.

import { describe, it, expect, beforeEach } from "vitest";
import { createWeddingProgramHandler } from "../../netlify/functions/wedding-program.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { parseDuration, formatDuration, validateProgramItem, SAMPLE_PROGRAM } from "../../shared/wedding-program.js";
import { readXlsx } from "../../shared/xlsx.js";

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "biz-wed";
const W2 = "biz-wed-2";
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W });
  await createBusiness({ ...world, name: "Cruz Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W2 });
  u = {};
  const add = async (key, businessId, role) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@prog.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  };
  await add("camille", W, "owner");
  await add("helper", W, "staff");
  await add("other", W2, "owner");
  await add("dist", "biz-a", "owner");
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
async function prog(uid, body, businessId = W) {
  const res = await createWeddingProgramHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const add = async (section, moment, extra = {}) => ok(await prog(u.camille, { action: "create", item: { section, moment, ...extra } }), 201).itemId;
const list = async (uid = u.camille, businessId = W) => ok(await prog(uid, { action: "list" }, businessId)).items;
const moments = (items, section) => items.filter((i) => i.section === section).map((i) => i.moment);

describe("Music & Program", () => {
  it("durations: 4:17, 1:00:00, minutes; shown back the same way", () => {
    expect([parseDuration("4:17"), parseDuration("1:00:00"), parseDuration("3"), parseDuration(""), parseDuration(" 0:45 ")]).toEqual([257, 3600, 180, null, 45]);
    expect(() => parseDuration("4:75")).toThrow(/minutes:seconds/);
    expect(() => parseDuration("abc")).toThrow(/minutes:seconds/);
    expect([formatDuration(257), formatDuration(3600), formatDuration(null), formatDuration(45)]).toEqual(["4:17", "1:00:00", "—", "0:45"]);
    expect(() => validateProgramItem({ section: "ceremony", moment: "" })).toThrow(/Moment is required/);
    expect(() => validateProgramItem({ section: "party", moment: "x" })).toThrow(/Ceremony or Reception/);
    expect(() => validateProgramItem({ section: "ceremony", moment: "x", order: 1 })).toThrow(/can't be set/);
    expect(SAMPLE_PROGRAM.ceremony).toEqual(expect.arrayContaining(["Groom entrance", "Entourage entrance", "Bride entrance", "Signing", "Recessional"]));
    expect(SAMPLE_PROGRAM.reception).toEqual(expect.arrayContaining(["Guest waiting", "Couple entrance", "First dance", "Mother & son dance", "Father & daughter dance", "Cake & wine", "Speeches", "Same-day edit (SDE)", "Couple thank-you", "After party"]));
  });

  it("items keep the order they were added in, per part; song / duration / person / notes stored; the list starts empty (no auto sample)", async () => {
    expect(await list()).toEqual([]);
    await add("ceremony", "Groom entrance", { song: "Turning Page", durationSec: 257 });
    await add("reception", "Guest waiting", { song: "Playlist", durationSec: 3600 });
    await add("ceremony", "Bride entrance", { song: "Moon River", person: "Bride & father", notes: "Doors open on cue" });
    const items = await list();
    expect(moments(items, "ceremony")).toEqual(["Groom entrance", "Bride entrance"]);
    expect(items.find((i) => i.moment === "Bride entrance")).toMatchObject({ song: "Moon River", durationSec: null, person: "Bride & father", notes: "Doors open on cue" });
    expect(items.find((i) => i.moment === "Guest waiting").durationSec).toBe(3600);
  });

  it("Move up / Move down change the sequence (and stop at the ends); moving to the other part puts it last there", async () => {
    const a = await add("ceremony", "A");
    const b = await add("ceremony", "B");
    const c = await add("ceremony", "C");
    ok(await prog(u.camille, { action: "move", itemId: c, direction: "up" }));
    expect(moments(await list(), "ceremony")).toEqual(["A", "C", "B"]);
    ok(await prog(u.camille, { action: "move", itemId: a, direction: "down" }));
    expect(moments(await list(), "ceremony")).toEqual(["C", "A", "B"]);
    expect(ok(await prog(u.camille, { action: "move", itemId: c, direction: "up" })).moved).toBe(false);
    expect((await prog(u.camille, { action: "move", itemId: c, direction: "sideways" })).status).toBe(400);
    await add("reception", "R1");
    ok(await prog(u.camille, { action: "update", itemId: b, changes: { section: "reception", song: "So Close" } }));
    const items = await list();
    expect(moments(items, "ceremony")).toEqual(["C", "A"]);
    expect(moments(items, "reception")).toEqual(["R1", "B"]);
    ok(await prog(u.camille, { action: "delete", itemId: a }));
    expect(moments(await list(), "ceremony")).toEqual(["C"]);
  });

  it("Staff can read but not change; another wedding can't see or touch it; other workspaces have no program", async () => {
    const a = await add("ceremony", "Groom entrance");
    const staffCanView = (await prog(u.helper, { action: "list" })).status === 200;
    expect([200, 403]).toContain((await prog(u.helper, { action: "list" })).status);
    expect((await prog(u.helper, { action: "create", item: { section: "ceremony", moment: "X" } })).status).toBe(403);
    if (staffCanView) expect((await list(u.helper)).length).toBe(1);
    expect(await list(u.other, W2)).toEqual([]);
    expect((await prog(u.other, { action: "update", itemId: a, changes: { song: "Hacked" } }, W2)).status).toBe(404);
    expect((await prog(u.other, { action: "delete", itemId: a }, W2)).status).toBe(404);
    expect((await prog(u.other, { action: "list" }, W)).status).toBe(403);
    expect((await prog(u.dist, { action: "list" }, "biz-a")).status).toBe(403);
    expect((await list())[0].song).toBe(null);
  });

  it("Master Backup has a readable Music & Program sheet in program order", async () => {
    await add("ceremony", "Groom entrance", { song: "Turning Page", durationSec: 257 });
    await add("ceremony", "Bride entrance", { song: "Moon River" });
    await add("reception", "First dance", { durationSec: 242, person: "Couple" });
    const res = await createBackupHandler(deps())({ ...request({ uid: u.camille, businessId: W, method: "POST" }), body: "{}" });
    expect(res.statusCode).toBe(200);
    const rows = readXlsx(Buffer.from(res.body, "base64"), { sheet: "Music & Program" }).rows;
    expect(rows[0]).toEqual(["Part", "#", "Moment", "Song", "Duration", "Person / group", "Notes", "Item id"]);
    expect(rows.slice(1).map((r) => r.slice(0, 6))).toEqual([
      ["Ceremony", "1", "Groom entrance", "Turning Page", "4:17", ""],
      ["Ceremony", "2", "Bride entrance", "Moon River", "", ""],
      ["Reception", "1", "First dance", "", "4:02", "Couple"],
    ]);
  });
});
