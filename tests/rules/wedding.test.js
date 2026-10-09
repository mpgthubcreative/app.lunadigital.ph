// Phase 16 rules: Wedding data (suppliers, supplier payments, tasks and
// their totals, guests and RSVP totals, plus the shared budget primitive and
// Wedding Expenses) is readable only by members of THAT Bridal business with
// the module's view permission, only in the bridal-expense workspace;
// nothing is browser-writable. Compatible step: bridal-expense v1 snapshots
// (no Wedding keys) stay valid but open no Wedding data; forged Wedding
// modules in other workspaces open nothing.

import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { A, businessDoc, createEnv, dbAs, dbAnon, seedMember } from "./fixture.js";

let env;
const W = "wed-a";
const W2 = "wed-b";
const COLLECTIONS = { weddingSuppliers: "vendors.view", supplierPayments: "vendorpayments.view", weddingTasks: "tasks.view", taskTotals: "tasks.view", guests: "guests.view", guestTotals: "guests.view", budgets: "budget.view", expenseCategories: "budget.view", spendingMetrics: "budget.view", expenses: "expenses.view" };
const WEDDING_ONLY = ["weddingSuppliers", "supplierPayments", "weddingTasks", "taskTotals", "guests", "guestTotals"];
const KEYS = ["vendors", "vendorpayments", "tasks", "guests"];
const doc = { status: "active", open: true, dueDate: "2026-12-01", rsvp: "awaiting", nameLower: "abc", supplierId: "s1", date: "2026-10-10" };

beforeAll(async () => {
  env = await createEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const bid of [W, W2]) {
      await db.doc(`businesses/${bid}`).set(businessDoc(`Wedding ${bid}`, "active", { planId: "growth", workspaceTemplateId: "bridal-expense" }));
      for (const c of Object.keys(COLLECTIONS)) await db.doc(`businesses/${bid}/${c}/d1`).set({ ...doc, status: c === "supplierPayments" ? "upcoming" : "active" });
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
    }
    await seedMember(db, W, "manager@wed-a", { role: "manager" });
    await seedMember(db, W, "staff@wed-a", { role: "staff" });
    await seedMember(db, W, "noGuests@wed-a", { role: "manager", overrides: { revoke: ["guests.view"] } });
    // Wedding collections in Distributor A and a Baby business: not reachable.
    for (const c of WEDDING_ONLY) await db.doc(`businesses/${A}/${c}/d1`).set({ x: 1 });
    await db.doc("businesses/baby-x").set(businessDoc("Baby", "active", { planId: "growth", workspaceTemplateId: "baby-expense" }));
    await seedMember(db, "baby-x", "owner@baby-x", { role: "owner", isAccountOwner: true });
    for (const c of WEDDING_ONLY) await db.doc(`businesses/baby-x/${c}/d1`).set({ x: 1 });
    // Compatible step: a Bridal business still on its v1 snapshot (no Wedding keys, Expenses / Budget off).
    const v1 = businessDoc("Wedding v1", "active", { planId: "growth", workspaceTemplateId: "bridal-expense" });
    for (const k of KEYS) delete v1.entitlements.modules[k];
    v1.entitlements.modules.expenses = false;
    v1.entitlements.modules.budget = false;
    v1.entitlements.workspaceTemplateVersion = 1;
    await db.doc("businesses/wed-v1").set(v1);
    await seedMember(db, "wed-v1", "owner@wed-v1", { role: "owner", isAccountOwner: true });
    for (const c of Object.keys(COLLECTIONS)) await db.doc(`businesses/wed-v1/${c}/d1`).set({ x: 1 });
    await db.doc("businesses/wed-v1/settings/general").set({ x: 1 });
    // Malformed: unknown version, a non-bool Wedding key.
    const v3 = businessDoc("Wedding v3", "active", { planId: "growth", workspaceTemplateId: "bridal-expense" });
    v3.entitlements.workspaceTemplateVersion = 3;
    const bad = businessDoc("Wedding bad", "active", { planId: "growth", workspaceTemplateId: "bridal-expense" });
    bad.entitlements.modules.guests = "yes";
    for (const [bid, b] of [["wed-v3", v3], ["wed-bad", bad]]) {
      await db.doc(`businesses/${bid}`).set(b);
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      await db.doc(`businesses/${bid}/guests/d1`).set({ x: 1 });
    }
    // Wedding modules forged into Distributor, Household and Baby snapshots.
    for (const [bid, t] of [["dist-wforged", "distributor"], ["home-wforged", "household-payroll"], ["baby-wforged", "baby-expense"]]) {
      const f = businessDoc(`Forged ${t}`, "active", { planId: "growth", workspaceTemplateId: t });
      for (const k of KEYS) f.entitlements.modules[k] = true;
      await db.doc(`businesses/${bid}`).set(f);
      await seedMember(db, bid, `owner@${bid}`, { role: "owner", isAccountOwner: true });
      for (const c of WEDDING_ONLY) await db.doc(`businesses/${bid}/${c}/d1`).set({ x: 1 });
    }
  });
});
afterAll(async () => {
  await env?.cleanup();
});

describe("reading Wedding data", () => {
  for (const uid of ["owner@wed-a", "manager@wed-a"]) {
    it(`${uid} reads every Wedding collection and runs the screens' queries (incl. the overdue count)`, async () => {
      const db = dbAs(env, uid);
      for (const c of Object.keys(COLLECTIONS)) await assertSucceeds(db.doc(`businesses/${W}/${c}/d1`).get());
      await assertSucceeds(db.collection(`businesses/${W}/weddingSuppliers`).where("status", "==", "active").orderBy("nameLower").limit(26).get());
      await assertSucceeds(db.collection(`businesses/${W}/supplierPayments`).where("status", "==", "upcoming").where("supplierId", "==", "s1").orderBy("dueDate").limit(26).get());
      await assertSucceeds(db.collection(`businesses/${W}/weddingTasks`).where("open", "==", true).where("dueDate", "<", "2026-10-16").orderBy("dueDate").limit(26).get());
      await assertSucceeds(db.collection(`businesses/${W}/guests`).where("rsvp", "==", "attending").orderBy("nameLower").limit(26).get());
      await assertSucceeds(db.collection(`businesses/${W}/expenses`).where("status", "==", "active").where("supplierId", "==", "s1").orderBy("date", "desc").limit(26).get());
    });
  }

  it("Bridal Staff (no Wedding permissions) and a manager without guests.view are refused", async () => {
    for (const c of Object.keys(COLLECTIONS)) await assertFails(dbAs(env, "staff@wed-a").doc(`businesses/${W}/${c}/d1`).get());
    for (const c of ["guests", "guestTotals"]) await assertFails(dbAs(env, "noGuests@wed-a").doc(`businesses/${W}/${c}/d1`).get());
    await assertSucceeds(dbAs(env, "noGuests@wed-a").doc(`businesses/${W}/weddingTasks/d1`).get());
  });

  it("Bridal B, a Distributor owner, a Baby owner, signed-out users: nothing of Bridal A", async () => {
    for (const c of Object.keys(COLLECTIONS)) {
      for (const uid of ["owner@wed-b", "ownerA", "owner@baby-x"]) {
        await assertFails(dbAs(env, uid).doc(`businesses/${W}/${c}/d1`).get());
        await assertFails(dbAs(env, uid).collection(`businesses/${W}/${c}`).get());
      }
      await assertFails(dbAnon(env).doc(`businesses/${W}/${c}/d1`).get());
    }
  });

  it("Distributor and Baby businesses never expose Wedding collections, even to their owner", async () => {
    for (const c of WEDDING_ONLY) {
      await assertFails(dbAs(env, "ownerA").doc(`businesses/${A}/${c}/d1`).get());
      await assertFails(dbAs(env, "owner@baby-x").doc(`businesses/baby-x/${c}/d1`).get());
    }
  });

  it("forged Wedding modules in Distributor / Household / Baby snapshots open nothing", async () => {
    for (const bid of ["dist-wforged", "home-wforged", "baby-wforged"]) for (const c of WEDDING_ONLY) await assertFails(dbAs(env, `owner@${bid}`).doc(`businesses/${bid}/${c}/d1`).get());
  });

  it("compatible step: a v1 Bridal snapshot is still valid (settings) but opens no Wedding data", async () => {
    await assertSucceeds(dbAs(env, "owner@wed-v1").doc("businesses/wed-v1/settings/general").get());
    for (const c of Object.keys(COLLECTIONS)) await assertFails(dbAs(env, "owner@wed-v1").doc(`businesses/wed-v1/${c}/d1`).get());
  });

  it("an unknown version or a non-bool Wedding key fails closed", async () => {
    for (const bid of ["wed-v3", "wed-bad"]) await assertFails(dbAs(env, `owner@${bid}`).doc(`businesses/${bid}/guests/d1`).get());
  });
});

describe("no browser writes", () => {
  it("not suppliers' paid / balance, payments' status, tasks, RSVP, the totals or expenses", async () => {
    const db = dbAs(env, "owner@wed-a");
    await assertFails(db.doc(`businesses/${W}/weddingSuppliers/d1`).update({ paid: 0 }));
    await assertFails(db.doc(`businesses/${W}/weddingSuppliers/new`).set({ name: "x" }));
    await assertFails(db.doc(`businesses/${W}/supplierPayments/d1`).update({ status: "paid" }));
    await assertFails(db.doc(`businesses/${W}/weddingTasks/d1`).update({ status: "completed" }));
    await assertFails(db.doc(`businesses/${W}/taskTotals/current`).set({ open: 0 }));
    await assertFails(db.doc(`businesses/${W}/guests/d1`).update({ rsvp: "attending", confirmed: 3 }));
    await assertFails(db.doc(`businesses/${W}/guestTotals/current`).set({ attendingSeats: 99 }));
    await assertFails(db.doc(`businesses/${W}/budgets/current`).set({ spent: 0 }));
    await assertFails(db.doc(`businesses/${W}/expenses/new`).set({ amount: 1 }));
  });
});
