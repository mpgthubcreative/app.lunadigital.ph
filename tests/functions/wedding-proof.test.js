// Owner-pilot Bridal fix pass: Wedding Setup save (read back, invitation
// links need a set-up invitation) and a proof (receipt photo or PDF) on a
// wedding expense: authorized upload / view / replace, storage metering,
// tenant isolation, and safe metadata in the Master Backup.

import { describe, it, expect, beforeEach } from "vitest";
import { createGuestsHandler } from "../../netlify/functions/guests.js";
import { createWeddingSetupHandler } from "../../netlify/functions/wedding-setup.js";
import { createExpensesHandler } from "../../netlify/functions/expenses.js";
import { createBudgetHandler } from "../../netlify/functions/budget.js";
import { createBackupHandler } from "../../netlify/functions/backup.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { setupMissing } from "../../shared/wedding.js";
import { readXlsx } from "../../shared/xlsx.js";

const NOW = new Date("2026-10-16T04:00:00Z");
const W = "biz-wed";
const W2 = "biz-wed-2";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]).toString("base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 3)]).toString("base64");
const PDF = Buffer.from("%PDF-1.4\n" + "x".repeat(500)).toString("base64");
let world;
let u;

beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Reyes-Prado Wedding", planId: "bridal-plus", workspaceTemplateId: "bridal-expense", businessId: W });
  await createBusiness({ ...world, name: "Cruz Wedding", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: W2 });
  u = {};
  const add = async (key, businessId, role) => {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@proof.test`, name: key });
    await addMember({ ...world, businessId, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  };
  await add("camille", W, "owner");
  await add("mon", W, "manager");
  await add("helper", W, "staff");
  await add("other", W2, "owner");
  await add("dist", "biz-a", "owner");
});

const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const H = { guests: createGuestsHandler, setup: createWeddingSetupHandler, expenses: createExpensesHandler, budget: createBudgetHandler };
async function api(kind, uid, body, businessId = W) {
  const res = await H[kind](deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const docAt = (p, businessId = W) => world.db.docs.get(`businesses/${businessId}/${p}`);
const storedBytes = (businessId = W) => docAt("usageCurrent/storage", businessId)?.bytes ?? 0;
const files = () => [...world.storage.files.keys()];
const perm = (uid, key, businessId = W) => docAt(`members/${uid}`, businessId)?.permissions?.[key] === true;

let catN = 0;
async function expense(uid = u.camille, businessId = W) {
  const cat = ok(await api("budget", uid, { action: "createCategory", category: { name: `Photo / Video ${++catN}`, budget: null } }, businessId), 201).categoryId;
  return ok(await api("expenses", uid, { action: "create", expense: { date: "2026-10-15", method: "gcash", category: cat, amount: 2000000, payee: "Nice Print" } }, businessId), 201).expenseId;
}

describe("Wedding Setup save", () => {
  it("returns what was stored (read back), so the Owner sees the saved values; every field round-trips", async () => {
    const SETUP = { coupleNames: "Camille & Carlo", weddingDate: "2027-12-12", ceremonyTime: "15:00", ceremonyVenue: "Example Church", ceremonyAddress: "Taguig City", ceremonyMap: "https://maps.app.goo.gl/church", receptionTime: "17:30", receptionVenue: "Example Garden", receptionAddress: "Pasig City", receptionMap: "https://maps.app.goo.gl/garden", dressCode: "Formal", welcomeMessage: "Join us!", rsvpDeadline: "2027-11-15", rsvpEnabled: true, closeAfterDeadline: false };
    const saved = ok(await api("setup", u.camille, { action: "save", setup: SETUP }));
    expect(saved.saved).toBe(true);
    expect(saved.setup).toMatchObject(SETUP);
    // A later visit (reload / next sign-in) reads the same values.
    expect(ok(await api("setup", u.camille, { action: "get" })).setup).toMatchObject(SETUP);
    // Clearing a field stores null (not the old value).
    expect(ok(await api("setup", u.camille, { action: "save", setup: { ...SETUP, dressCode: null } })).setup.dressCode).toBe(null);
  });

  it("invitation links need the couple's names and the wedding date first: a clear 409, not a silent miss", async () => {
    expect(setupMissing({})).toEqual(["the couple's names", "the wedding date"]);
    expect(setupMissing({ coupleNames: "A & B", weddingDate: "2027-12-12" })).toEqual([]);
    const g = ok(await api("guests", u.camille, { action: "create", guest: { name: "Maria Santos", category: "family", side: "bride", partySize: 2 } }), 201).guestId;
    ok(await api("setup", u.camille, { action: "save", setup: { coupleNames: "Camille & Carlo" } }));
    const r = await api("guests", u.camille, { action: "inviteLink", guestId: g });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("setup-incomplete");
    expect(r.body.message).toBe("Complete Wedding Setup first (More → Wedding Setup): add the wedding date.");
    expect((await api("guests", u.camille, { action: "regenerateInvite", guestId: g })).body.error).toBe("setup-incomplete");
    ok(await api("setup", u.camille, { action: "save", setup: { coupleNames: "Camille & Carlo", weddingDate: "2027-12-12" } }));
    const link = ok(await api("guests", u.camille, { action: "inviteLink", guestId: g }));
    expect(link.created).toBe(true);
    expect(docAt(`guests/${g}`).invitation).toMatchObject({ status: "active" });
    expect(ok(await api("guests", u.camille, { action: "inviteLink", guestId: g })).created).toBe(false);
  });
});

describe("expense proof (receipt photo or PDF)", () => {
  it("Owner adds a photo: stored privately under the business, metered, in the history; members with expenses.view can see it", async () => {
    const e = await expense();
    const r = ok(await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "image/png", dataBase64: PNG } }));
    expect(r).toMatchObject({ expenseId: e, hasProof: true, replaced: false, proof: { contentType: "image/png", size: 208 } });
    const d = docAt(`expenses/${e}`);
    expect(d.proof).toMatchObject({ contentType: "image/png", size: 208, uploadedBy: { uid: u.camille } });
    expect(d.proof.path.startsWith(`tenants/${W}/expenses/proofs/${e}-`)).toBe(true);
    expect(files()).toEqual([d.proof.path]);
    expect(storedBytes()).toBe(208);
    expect(d.history.at(-1)).toMatchObject({ type: "proof-added", label: "Proof added (photo)" });
    expect(d.amount).toBe(2000000); // the money is untouched
    expect(ok(await api("expenses", u.camille, { action: "proof", expenseId: e })).proof).toEqual({ contentType: "image/png", dataBase64: PNG });
    if (perm(u.mon, "expenses.view")) expect(ok(await api("expenses", u.mon, { action: "proof", expenseId: e })).proof.dataBase64).toBe(PNG);
    if (!perm(u.helper, "expenses.view")) expect((await api("expenses", u.helper, { action: "proof", expenseId: e })).status).toBe(403);
    if (!perm(u.helper, "expenses.update")) expect((await api("expenses", u.helper, { action: "attachProof", expenseId: e, proof: { contentType: "image/png", dataBase64: PNG } })).status).toBe(403);
  });

  it("PDF accepted; fakes, non-images and oversized files refused; nothing is stored or metered for a refusal", async () => {
    const e = await expense();
    expect((await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "application/pdf", dataBase64: Buffer.from("not a pdf").toString("base64") } })).body.error).toBe("invalid-proof");
    expect((await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "image/png", dataBase64: Buffer.from("<html>").toString("base64") } })).body.error).toBe("invalid-proof");
    expect((await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "image/png", dataBase64: PNG, url: "x" } })).body.error).toBe("invalid-proof");
    const big = await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-" + "x".repeat(2_600_000)).toString("base64") } });
    expect(big.status).toBe(413);
    expect(files()).toEqual([]);
    expect(storedBytes()).toBe(0);
    ok(await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "application/pdf", dataBase64: PDF } }));
    expect(docAt(`expenses/${e}`).proof.contentType).toBe("application/pdf");
    expect(docAt(`expenses/${e}`).history.at(-1).label).toBe("Proof added (PDF)");
    expect(ok(await api("expenses", u.camille, { action: "proof", expenseId: e })).proof.dataBase64).toBe(PDF);
  });

  it("Replace: the new file is linked, the old one deleted and its storage given back; both events stay in the history", async () => {
    const e = await expense();
    ok(await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "image/png", dataBase64: PNG } }));
    const first = docAt(`expenses/${e}`).proof.path;
    const r = ok(await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "image/jpeg", dataBase64: JPG } }));
    expect(r.replaced).toBe(true);
    const d = docAt(`expenses/${e}`);
    expect(d.proof.contentType).toBe("image/jpeg");
    expect(files()).toEqual([d.proof.path]);
    expect(files()).not.toContain(first);
    expect(storedBytes()).toBe(304);
    expect(d.history.slice(-2).map((h) => h.label)).toEqual(["Proof added (photo)", "Proof replaced (photo)"]);
    expect(ok(await api("expenses", u.camille, { action: "proof", expenseId: e })).proof.dataBase64).toBe(JPG);
  });

  it("tenant isolation: another wedding can't read or attach to this expense; no proof → 404; removed expense → 409", async () => {
    const e = await expense();
    ok(await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "image/png", dataBase64: PNG } }));
    // Their own business: this id doesn't exist there.
    expect((await api("expenses", u.other, { action: "proof", expenseId: e }, W2)).status).toBe(404);
    expect((await api("expenses", u.other, { action: "attachProof", expenseId: e, proof: { contentType: "image/png", dataBase64: PNG } }, W2)).status).toBe(404);
    // Claiming this business: not a member.
    expect((await api("expenses", u.other, { action: "proof", expenseId: e }, W)).status).toBe(403);
    expect(files().length).toBe(1);
    // A proof path pointing outside the business is never served.
    const e2 = await expense(u.other, W2);
    world.db.docs.set(`businesses/${W2}/expenses/${e2}`, { ...docAt(`expenses/${e2}`, W2), proof: { ...docAt(`expenses/${e}`).proof } });
    expect((await api("expenses", u.other, { action: "proof", expenseId: e2 }, W2)).status).toBe(404);
    const plain = await expense();
    expect((await api("expenses", u.camille, { action: "proof", expenseId: plain })).status).toBe(404);
    ok(await api("expenses", u.camille, { action: "remove", expenseId: plain, reason: "Typo" }));
    expect((await api("expenses", u.camille, { action: "attachProof", expenseId: plain, proof: { contentType: "image/png", dataBase64: PNG } })).status).toBe(409);
  });

  it("Distributor expenses don't take proofs (Bridal only)", async () => {
    const r = await api("expenses", u.dist, { action: "proof", expenseId: "abcdefgh12" }, "biz-a");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not-available");
  });

  it("Master Backup lists the proof safely (type, size, when, who); no file bytes, storage path or ledger id", async () => {
    const e = await expense();
    ok(await api("expenses", u.camille, { action: "attachProof", expenseId: e, proof: { contentType: "image/png", dataBase64: PNG } }));
    const p = docAt(`expenses/${e}`).proof;
    const res = await createBackupHandler(deps())({ ...request({ uid: u.camille, businessId: W, method: "POST" }), body: "{}" });
    expect(res.statusCode).toBe(200);
    const bytes = Buffer.from(res.body, "base64");
    const sheet = readXlsx(bytes, { sheet: "Expenses" }).rows;
    const cell = sheet[1][sheet[0].indexOf("proof")];
    expect(JSON.parse(cell)).toEqual({ file: "Image", contentType: "image/png", bytes: 208, uploadedAt: NOW.toISOString(), uploadedBy: "camille" });
    const all = Buffer.from(bytes).toString("latin1");
    expect(all.includes(p.path)).toBe(false);
    expect(all.includes(p.objectId)).toBe(false);
    expect(all.includes(PNG.slice(0, 40))).toBe(false);
  });
});
