// Luna Household Grocery List (household-payroll v4): Owner / Admin manage
// the list; household staff see it and tick items (adding only when the
// Owner allows); nothing here touches money; Master Backup has the sheet.

import { describe, it, expect, beforeEach } from "vitest";
import { createGroceryHandler } from "../../netlify/functions/grocery.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createHouseholdMoneyHandler } from "../../netlify/functions/household-money.js";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request, asOperator } from "../helpers/tenants.js";
import { readXlsx } from "../../shared/xlsx.js";
import { validateGroceryItem, sortGrocery, SAMPLE_GROCERY, GROCERY_CATEGORIES } from "../../shared/grocery.js";

const H = "biz-home";
let world;
let u;
const NOW = new Date("2026-10-17T04:00:00Z");

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Prado Household", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  for (const [key, role] of [["carlo", "owner"], ["dad", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
  // The kasambahay's own login.
  const res = await createHouseholdStaffHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "POST" }), body: JSON.stringify({ action: "create", staff: { name: "Loriza", dailyWage: 41100, payCycle: "semi_monthly", startDate: "2026-06-07" } }) });
  const staffId = JSON.parse(res.body).staffId;
  const login = JSON.parse((await createHouseholdStaffHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "POST" }), body: JSON.stringify({ action: "createLogin", staffId }) })).body);
  await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: login.activationToken, password: "kape-at-pandesal" }) });
  u.helper = login.uid;
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
async function grocery(uid, body, businessId = H) {
  const res = await createGroceryHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const docAt = (p) => world.db.docs.get(`businesses/${H}/${p}`);
const items = () => [...world.db.docs.entries()].filter(([k]) => k.startsWith(`businesses/${H}/groceryItems/`)).map(([k, v]) => ({ id: k.split("/").pop(), ...v }));

describe("shared", () => {
  it("item validation: name required, qty / category optional and trimmed", () => {
    expect(validateGroceryItem({ name: "  Eggs ", qty: "2 trays", category: "Dairy & Eggs" })).toEqual({ name: "Eggs", qty: "2 trays", category: "Dairy & Eggs" });
    expect(validateGroceryItem({ name: "Rice" })).toEqual({ name: "Rice", qty: null, category: null });
    expect(() => validateGroceryItem({ name: "" })).toThrow(/Enter the item/);
    expect(() => validateGroceryItem({ name: "x", price: 5 })).toThrow(/price/);
    expect(() => validateGroceryItem({ name: "x".repeat(81) })).toThrow(/under 80/);
  });
  it("sample library: 14 household groups incl. the PH staples; groups are the category suggestions", () => {
    expect(GROCERY_CATEGORIES).toEqual(["Fresh Produce", "Meat & Seafood", "Dairy & Eggs", "Pantry", "Breakfast", "Snacks", "Drinks", "Frozen", "Baby", "Pets", "Cleaning", "Laundry", "Toiletries", "Household Supplies"]);
    const all = SAMPLE_GROCERY.flatMap((g) => g.items);
    for (const x of ["Pechay", "Sayote", "Calamansi", "Fish sauce", "Instant noodles", "Diapers", "Pee pads", "Fabric conditioner", "Trash bags"]) expect(all).toContain(x);
  });
  it("sort: to-buy by category then name; bought last, latest first", () => {
    const r = sortGrocery([
      { id: "a", name: "Rice", nameLower: "rice", category: "Pantry", bought: false },
      { id: "b", name: "Eggs", nameLower: "eggs", category: "Dairy & Eggs", bought: false },
      { id: "c", name: "Soap", nameLower: "soap", category: null, bought: false },
      { id: "d", name: "Salt", nameLower: "salt", bought: true, boughtAt: new Date("2026-10-01") },
      { id: "e", name: "Milk", nameLower: "milk", bought: true, boughtAt: new Date("2026-10-02") },
    ]);
    expect(r.active.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(r.bought.map((x) => x.id)).toEqual(["e", "d"]);
  });
});

describe("Owner / Admin", () => {
  it("add, edit, check, uncheck, delete, clear bought; who and when are kept", async () => {
    const eggs = ok(await grocery(u.carlo, { action: "add", item: { name: "Eggs", qty: "2 trays", category: "Dairy & Eggs" } }), 201).items[0].itemId;
    expect(docAt(`groceryItems/${eggs}`)).toMatchObject({ name: "Eggs", nameLower: "eggs", qty: "2 trays", category: "Dairy & Eggs", bought: false, source: "manual", createdBy: { uid: u.carlo } });
    ok(await grocery(u.dad, { action: "update", itemId: eggs, changes: { qty: "1 tray" } }));
    expect(docAt(`groceryItems/${eggs}`)).toMatchObject({ qty: "1 tray", updatedBy: { uid: u.dad } });
    ok(await grocery(u.carlo, { action: "check", itemId: eggs, bought: true }));
    expect(docAt(`groceryItems/${eggs}`)).toMatchObject({ bought: true, boughtBy: { uid: u.carlo } });
    expect(docAt(`groceryItems/${eggs}`).boughtAt).toBeTruthy();
    ok(await grocery(u.carlo, { action: "check", itemId: eggs, bought: false }));
    expect(docAt(`groceryItems/${eggs}`)).toMatchObject({ bought: false, boughtAt: null, boughtBy: null });
    const rice = ok(await grocery(u.carlo, { action: "add", item: { name: "Rice", qty: "5 kg", category: "Pantry" } }), 201).items[0].itemId;
    ok(await grocery(u.carlo, { action: "check", itemId: rice, bought: true }));
    ok(await grocery(u.carlo, { action: "check", itemId: eggs, bought: true }));
    expect(ok(await grocery(u.carlo, { action: "clearBought" })).cleared).toBe(2);
    expect(items()).toHaveLength(0);
    const soap = ok(await grocery(u.carlo, { action: "add", item: { name: "Dish soap" } }), 201).items[0].itemId;
    ok(await grocery(u.carlo, { action: "remove", itemId: soap }));
    expect(docAt(`groceryItems/${soap}`)).toBeUndefined();
  });

  it("Sample Grocery List: Add selected adds several at once; an item already on the list isn't copied", async () => {
    ok(await grocery(u.carlo, { action: "add", item: { name: "eggs" } }), 201);
    const r = ok(await grocery(u.carlo, { action: "addMany", source: "sample", items: [{ name: "Eggs", category: "Dairy & Eggs" }, { name: "Onion", category: "Fresh Produce" }, { name: "Garlic", category: "Fresh Produce" }] }), 201);
    expect(r.added).toBe(2);
    expect(r.items[0].existing).toBe(true);
    expect(items().map((i) => i.name).sort()).toEqual(["Garlic", "Onion", "eggs"]);
    expect(items().find((i) => i.name === "Onion")).toMatchObject({ source: "sample", category: "Fresh Produce" });
    // A bought "Eggs" doesn't block adding it again for the next trip.
    ok(await grocery(u.carlo, { action: "check", itemId: items().find((i) => i.name === "eggs").id, bought: true }));
    expect(ok(await grocery(u.carlo, { action: "addMany", source: "sample", items: [{ name: "Eggs" }] }), 201).added).toBe(1);
    expect((await grocery(u.carlo, { action: "addMany", items: [] })).status).toBe(400);
  });

  it("checking an item never creates an expense or changes the month", async () => {
    const id = ok(await grocery(u.carlo, { action: "add", item: { name: "Rice" } }), 201).items[0].itemId;
    ok(await grocery(u.carlo, { action: "check", itemId: id, bought: true }));
    expect([...world.db.docs.keys()].filter((k) => k.startsWith(`businesses/${H}/expenses/`))).toHaveLength(0);
    const m = await createHouseholdMoneyHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "GET" }), queryStringParameters: {} });
    expect(JSON.parse(m.body).month).toMatchObject({ spent: 0, expensesSpent: 0 });
  });
});

describe("Household staff", () => {
  it("can tick items; can't add, edit, delete, clear or change the setting", async () => {
    const id = ok(await grocery(u.carlo, { action: "add", item: { name: "Eggs" } }), 201).items[0].itemId;
    ok(await grocery(u.helper, { action: "check", itemId: id, bought: true }));
    expect(docAt(`groceryItems/${id}`)).toMatchObject({ bought: true, boughtBy: { uid: u.helper } });
    const add = await grocery(u.helper, { action: "add", item: { name: "Milk" } });
    expect(add.status).toBe(403);
    expect(add.body.message).toMatch(/Helpers can add items/);
    for (const body of [{ action: "update", itemId: id, changes: { qty: "1" } }, { action: "remove", itemId: id }, { action: "clearBought" }, { action: "settings", staffCanAdd: true }]) expect((await grocery(u.helper, body)).status, body.action).toBe(403);
  });

  it("when the Owner turns on \"Helpers can add items\", staff can add (and Add selected); off again stops it", async () => {
    ok(await grocery(u.carlo, { action: "settings", staffCanAdd: true }));
    expect(docAt("groceryLists/current").staffCanAdd).toBe(true);
    expect(ok(await grocery(u.helper, { action: "add", item: { name: "Milk" } }), 201).items[0].existing).toBe(false);
    expect(ok(await grocery(u.helper, { action: "addMany", source: "sample", items: [{ name: "Tissue" }] }), 201).added).toBe(1);
    ok(await grocery(u.carlo, { action: "settings", staffCanAdd: false }));
    expect((await grocery(u.helper, { action: "add", item: { name: "Bread" } })).status).toBe(403);
  });

  it("the Grocery List gives no money access: expenses, the month and backup stay refused", async () => {
    expect((await createExpensesHandler(deps())({ ...request({ uid: u.helper, businessId: H, method: "POST" }), body: JSON.stringify({ action: "create", expense: { date: "2026-10-17", category: "x", amount: 100, method: "cash" } }) })).statusCode).toBe(403);
    expect((await createHouseholdMoneyHandler(deps())({ ...request({ uid: u.helper, businessId: H, method: "GET" }), queryStringParameters: {} })).statusCode).toBe(403);
    expect((await createBackupHandler(deps())({ ...request({ uid: u.helper, businessId: H, method: "POST" }), body: "{}" })).statusCode).toBe(403);
  });
});

describe("other workspaces", () => {
  it("Distributor has no Grocery List", async () => {
    const x = await ensureAuthUser({ auth: world.auth, email: "dist@home.test", name: "dist" });
    await addMember({ ...world, businessId: "biz-a", uid: x.uid, email: x.email, name: "dist", roleTemplate: "owner", isAccountOwner: false });
    expect((await grocery(x.uid, { action: "add", item: { name: "Eggs" } }, "biz-a")).status).toBe(403);
  });
});

describe("Master Backup", () => {
  it("Grocery List sheet: item, qty, category, bought, created / bought dates and who", async () => {
    const id = ok(await grocery(u.carlo, { action: "add", item: { name: "Eggs", qty: "2 trays", category: "Dairy & Eggs" } }), 201).items[0].itemId;
    ok(await grocery(u.carlo, { action: "add", item: { name: "Rice" } }), 201);
    ok(await grocery(u.helper, { action: "check", itemId: id, bought: true }));
    const res = await createBackupHandler(deps())(asOperator(world, H));
    expect(res.statusCode).toBe(200);
    const rows = readXlsx(Buffer.from(res.body, "base64"), { sheet: "Grocery List" }).rows;
    expect(rows[0]).toEqual(["Item", "Qty", "Category", "Bought", "Created", "Created by", "Bought on", "Bought by", "Updated by"]);
    const eggs = rows.find((r) => r[0] === "Eggs");
    expect(eggs.slice(0, 4)).toEqual(["Eggs", "2 trays", "Dairy & Eggs", "Yes"]);
    expect(eggs[5]).toBe("carlo");
    expect(eggs[7]).toBe("Loriza");
    expect(rows.find((r) => r[0] === "Rice")[3]).toBe("No");
  });
});
