// Owner-pilot Bridal: Crew Meals: entries, totals, optional supplier link
// (own suppliers only), optional prices, permissions, tenant isolation and
// the Master Backup sheet.

import { describe, it, expect, beforeEach } from "vitest";
import { createWeddingCrewMealsHandler } from "../../netlify/functions/wedding-crew-meals.js";
import { createWeddingSuppliersHandler } from "../../netlify/functions/wedding-suppliers.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request, asOperator, roomForTeam } from "../helpers/tenants.js";
import { crewTotals, mealLine, validateCrewItem } from "../../shared/wedding-crew.js";
import { readXlsx } from "../../shared/xlsx.js";

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "biz-wed";
const W2 = "biz-wed-2";
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W }); await roomForTeam(world, W);
  await createBusiness({ ...world, name: "Cruz Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W2 }); await roomForTeam(world, W2);
  u = {};
  const add = async (key, businessId, role) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@crew.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  };
  await add("camille", W, "owner");
  await add("helper", W, "staff");
  await add("other", W2, "owner");
  await add("dist", "biz-a", "owner");
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
async function crew(uid, body, businessId = W) {
  const res = await createWeddingCrewMealsHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const add = async (item, uid = u.camille, businessId = W) => ok(await crew(uid, { action: "create", item }, businessId), 201).itemId;
const list = async (uid = u.camille, businessId = W) => ok(await crew(uid, { action: "list" }, businessId));

describe("Crew Meals", () => {
  it("totals come from the list; meal line skips zeros; validation", () => {
    const items = [{ breakfast: 3, lunch: 3, dinner: 3 }, { breakfast: 4, lunch: 4, dinner: 0 }];
    expect(crewTotals(items)).toEqual({ breakfast: 7, lunch: 7, dinner: 3, meals: 17, cost: null });
    expect(crewTotals(items, { lunch: 25000 }).cost).toBe(175000);
    expect([mealLine({ breakfast: 3, lunch: 3, dinner: 3 }), mealLine({ breakfast: 3, lunch: 3, dinner: 0 }), mealLine({})]).toEqual(["B 3 · L 3 · D 3", "B 3 · L 3", "—"]);
    expect(() => validateCrewItem({ name: "" })).toThrow(/Crew \/ person is required/);
    expect(() => validateCrewItem({ name: "x", lunch: -1 })).toThrow(/Lunch/);
    expect(() => validateCrewItem({ name: "x", cost: 1 })).toThrow(/can't be set/);
  });

  it("add / edit / remove; an optional link to one of THIS wedding's suppliers (name kept); prices are optional", async () => {
    const sup = ok(await createWeddingSuppliersHandler(deps())({ ...request({ uid: u.camille, businessId: W, method: "POST" }), body: JSON.stringify({ action: "create", supplier: { name: "Nice Print", service: "photo_video" } }) }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) })), 201).supplierId;
    const photo = await add({ name: "Photo team", breakfast: 3, lunch: 3, dinner: 3, location: "Hotel", supplierId: sup });
    await add({ name: "HMUA team", breakfast: 3, lunch: 3, location: "Hotel" });
    let r = await list();
    expect(r.items.map((i) => [i.name, i.breakfast, i.lunch, i.dinner, i.location, i.supplierName])).toEqual([["HMUA team", 3, 3, 0, "Hotel", null], ["Photo team", 3, 3, 3, "Hotel", "Nice Print"]]);
    expect(r.prices).toEqual({});
    ok(await crew(u.camille, { action: "update", itemId: photo, changes: { dinner: 4, remarks: "Vegetarian x1", supplierId: null } }));
    r = await list();
    expect(r.items.find((i) => i.id === photo)).toMatchObject({ dinner: 4, remarks: "Vegetarian x1", supplierId: null, supplierName: null });
    ok(await crew(u.camille, { action: "setPrices", prices: { breakfast: 15000, lunch: 25000, dinner: null } }));
    expect((await list()).prices).toEqual({ breakfast: 15000, lunch: 25000, dinner: null });
    ok(await crew(u.camille, { action: "delete", itemId: photo }));
    expect((await list()).items.map((i) => i.name)).toEqual(["HMUA team"]);
  });

  it("another wedding's supplier can't be linked; other weddings can't see or touch entries; Staff read-only or none; other workspaces have no crew meals", async () => {
    const theirSup = ok(await createWeddingSuppliersHandler(deps())({ ...request({ uid: u.other, businessId: W2, method: "POST" }), body: JSON.stringify({ action: "create", supplier: { name: "Their Studio", service: "photo_video" } }) }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) })), 201).supplierId;
    const bad = await crew(u.camille, { action: "create", item: { name: "Photo team", supplierId: theirSup } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid-supplier");
    const id = await add({ name: "Drivers", lunch: 2 });
    expect((await list(u.other, W2)).items).toEqual([]);
    expect((await crew(u.other, { action: "update", itemId: id, changes: { lunch: 9 } }, W2)).status).toBe(404);
    expect((await crew(u.other, { action: "list" }, W)).status).toBe(403);
    expect((await crew(u.helper, { action: "create", item: { name: "X" } })).status).toBe(403);
    expect((await crew(u.dist, { action: "list" }, "biz-a")).status).toBe(403);
  });

  it("Master Backup: a Crew Meals sheet with supplier, meals, location, remarks, dates and a total row", async () => {
    await add({ name: "Photo team", breakfast: 3, lunch: 3, dinner: 3, location: "Hotel" });
    await add({ name: "Video team", breakfast: 4, lunch: 4, dinner: 4, location: "Hotel", remarks: "Arrive 6 AM" });
    ok(await crew(u.camille, { action: "setPrices", prices: { lunch: 25000 } }));
    const res = await createBackupHandler(deps())(asOperator(world, W));
    const rows = readXlsx(Buffer.from(res.body, "base64"), { sheet: "Crew Meals" }).rows;
    expect(rows[0]).toEqual(["Crew / person", "Linked supplier", "Breakfast", "Lunch", "Dinner", "Location", "Remarks", "Created", "Updated", "Entry id"]);
    expect(rows.slice(1).map((r) => r.slice(0, 7))).toEqual([
      ["Photo team", "", "3", "3", "3", "Hotel", ""],
      ["Video team", "", "4", "4", "4", "Hotel", "Arrive 6 AM"],
      ["Total", "", "7", "7", "7", "", "Est. cost ₱1,750"],
    ]);
  });
});
