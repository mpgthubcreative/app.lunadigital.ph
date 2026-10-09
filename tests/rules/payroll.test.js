// Phase 14 rules: household payroll data (staff, attendance, payrolls,
// advances) is readable only by members of THAT household with the module's
// view permission, only in the household-payroll workspace; nothing is
// browser-writable; receipt links are server-only. Strict step: only
// household-payroll v2 snapshots carrying every module key are valid; stale,
// missing or malformed versions and forged modules fail closed.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const H = "home-a";
const H2 = "home-b";
const COLLECTIONS = { householdStaff: "household.view", attendance: "attendance.view", payrolls: "payroll.view", advances: "advances.view" };

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [H, H2]) {
      await db.doc(`businesses/${bid}`).set(businessDoc(`Home ${bid}`, "active", { planId: "growth", workspaceTemplateId: "household-payroll" }));
      for (const c of Object.keys(COLLECTIONS)) await db.doc(`businesses/${bid}/${c}/d1`).set({ staffId: "s1", status: "draft", date: "2026-10-01", periodStart: "2026-10-01" });
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
    }
    await seedMember(db, H, "manager@home-a", { role: "manager" });
    await seedMember(db, H, "staff@home-a", { role: "staff" });
    await seedMember(db, H, "noPay@home-a", { role: "manager", overrides: { revoke: ["payroll.view"] } });
    await db.doc("receiptLinks/abc").set({ businessId: H, payrollId: "d1" });
    // Payroll collections in a Distributor business: not reachable (template ceiling).
    for (const c of Object.keys(COLLECTIONS)) await db.doc(`businesses/${A}/${c}/d1`).set({ x: 1 });
    // Stale / malformed household snapshots and a Distributor with forged household modules.
    const STALE = {
      "home-old": (e) => { for (const k of ["household", "attendance", "payroll", "advances"]) delete e.modules[k]; e.workspaceTemplateVersion = 1; },
      "home-v1": (e) => { e.workspaceTemplateVersion = 1; },
      "home-nover": (e) => { delete e.workspaceTemplateVersion; },
      "home-v3": (e) => { e.workspaceTemplateVersion = 3; },
      "home-vstr": (e) => { e.workspaceTemplateVersion = "2"; },
      "home-nokeys": (e) => { delete e.modules.payroll; },
    };
    for (const [bid, mutate] of Object.entries(STALE)) {
      const b = businessDoc(bid, "active", { planId: "growth", workspaceTemplateId: "household-payroll" });
      mutate(b.entitlements);
      await db.doc(`businesses/${bid}`).set(b);
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      await db.doc(`businesses/${bid}/payrolls/d1`).set({ x: 1 });
      await db.doc(`businesses/${bid}/settings/general`).set({ x: 1 });
    }
    const forged = businessDoc("Forged", "active", { planId: "growth", workspaceTemplateId: "distributor" });
    for (const k of ["household", "attendance", "payroll", "advances"]) forged.entitlements.modules[k] = true;
    await db.doc("businesses/dist-forged").set(forged);
    await seedMember(db, "dist-forged", "owner@dist-forged", { role: "owner", isAccountOwner: true });
    for (const c of Object.keys(COLLECTIONS)) await db.doc(`businesses/dist-forged/${c}/d1`).set({ x: 1 });
    await db.doc("businesses/dist-forged/orders/d1").set({ x: 1 });
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("reading household payroll data", () => {
  for (const uid of ["owner@home-a", "manager@home-a"]) {
    it(`${uid} reads staff, attendance, payrolls and advances, and runs the screens' queries`, async () => {
      const db = dbAs(env, uid);
      for (const c of Object.keys(COLLECTIONS)) await assertSucceeds(db.doc(`businesses/${H}/${c}/d1`).get());
      await assertSucceeds(db.collection(`businesses/${H}/attendance`).where("staffId", "==", "s1").where("date", ">=", "2026-10-01").orderBy("date").limit(31).get());
      await assertSucceeds(db.collection(`businesses/${H}/payrolls`).where("status", "==", "draft").orderBy("periodStart", "desc").limit(25).get());
      await assertSucceeds(db.collection(`businesses/${H}/advances`).where("status", "==", "not_yet_paid").orderBy("date", "desc").limit(25).get());
    });
  }

  it("household Staff role (no payroll permissions) and a manager without payroll.view are refused", async () => {
    for (const c of Object.keys(COLLECTIONS)) await assertFails(dbAs(env, "staff@home-a").doc(`businesses/${H}/${c}/d1`).get());
    await assertFails(dbAs(env, "noPay@home-a").doc(`businesses/${H}/payrolls/d1`).get());
    await assertSucceeds(dbAs(env, "noPay@home-a").doc(`businesses/${H}/attendance/d1`).get());
  });

  it("another household, a Distributor owner, signed-out users: nothing", async () => {
    for (const c of Object.keys(COLLECTIONS)) {
      await assertFails(dbAs(env, "owner@home-b").doc(`businesses/${H}/${c}/d1`).get());
      await assertFails(dbAs(env, "owner@home-b").collection(`businesses/${H}/${c}`).get());
      await assertFails(dbAs(env, "ownerA").doc(`businesses/${H}/${c}/d1`).get());
      await assertFails(dbAnon(env).doc(`businesses/${H}/${c}/d1`).get());
    }
  });

  it("a Distributor business never exposes payroll collections, even to its owner", async () => {
    for (const c of Object.keys(COLLECTIONS)) await assertFails(dbAs(env, "ownerA").doc(`businesses/${A}/${c}/d1`).get());
  });

  it("receipt links are server-only", async () => {
    await assertFails(dbAs(env, "owner@home-a").doc("receiptLinks/abc").get());
    await assertFails(dbAnon(env).doc("receiptLinks/abc").get());
    await assertFails(dbAs(env, "owner@home-a").collection("receiptLinks").get());
  });

  it("strict: the current household v2 snapshot works", async () => {
    await assertSucceeds(dbAs(env, `owner@${H}`).doc(`businesses/${H}/payrolls/d1`).get());
  });

  for (const [bid, what] of [["home-old", "pre-Phase-14 (v1, no household keys)"], ["home-v1", "v1 with every key"], ["home-nover", "missing version"], ["home-v3", "unknown future version"], ["home-vstr", "version as a string"], ["home-nokeys", "v2 missing the payroll key"]]) {
    it(`strict: ${what} snapshot fails closed (payroll AND settings)`, async () => {
      await assertFails(dbAs(env, `owner@${bid}`).doc(`businesses/${bid}/payrolls/d1`).get());
      await assertFails(dbAs(env, `owner@${bid}`).doc(`businesses/${bid}/settings/general`).get());
    });
  }

  it("strict: household modules forged into a Distributor snapshot open no payroll data", async () => {
    for (const c of Object.keys(COLLECTIONS)) await assertFails(dbAs(env, "owner@dist-forged").doc(`businesses/dist-forged/${c}/d1`).get());
  });
});

describe("no browser writes", () => {
  it("not attendance, not payroll amounts, not advances' status, not receipt links", async () => {
    const db = dbAs(env, "owner@home-a");
    await assertFails(db.doc(`businesses/${H}/attendance/d1`).update({ status: "present" }));
    await assertFails(db.doc(`businesses/${H}/payrolls/d1`).update({ netPay: 1, receiptStatus: "confirmed" }));
    await assertFails(db.doc(`businesses/${H}/advances/d1`).update({ status: "paid" }));
    await assertFails(db.doc(`businesses/${H}/householdStaff/new`).set({ name: "x", dailyWage: 1 }));
    await assertFails(db.doc("receiptLinks/forged").set({ businessId: H, payrollId: "d1" }));
  });
});
