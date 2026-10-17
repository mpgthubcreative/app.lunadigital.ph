// Per-user navigation arrangement: stored on the member's own record for
// one business; never changes modules or permissions; household staff
// (their own portal) can't set one.

import { describe, it, expect, beforeEach } from "vitest";
import { createPreferencesHandler } from "../../netlify/functions/preferences.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { createHouseholdStaffHandler } from "../../netlify/functions/household-staff.js";
import { createActivateHandler } from "../../netlify/functions/activate.js";
import { createBusiness, addMember, ensureAuthUser } from "../../netlify/functions/_lib/provisioning.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { validateNavigationPreference } from "../../shared/navigation-prefs.js";

const H = "biz-home";
let world;
let u;
const deps = () => ({ getAdmin: async () => world, now: () => new Date("2026-10-17T04:00:00Z") });
beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Home", planId: "household-plus", workspaceTemplateId: "household-payroll", businessId: H });
  u = {};
  for (const [key, role] of [["carlo", "owner"], ["dad", "manager"]]) {
    const x = await ensureAuthUser({ auth: world.auth, email: `${key}@home.test`, name: key });
    await addMember({ ...world, businessId: H, uid: x.uid, email: x.email, name: key, roleTemplate: role, isAccountOwner: role === "owner" });
    u[key] = x.uid;
  }
});
const set = async (uid, navigation, businessId = H) => {
  const res = await createPreferencesHandler(deps())({ ...request({ uid, businessId, method: "POST" }), body: JSON.stringify({ action: "setNavigation", navigation }) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const session = async (uid, businessId = H) => JSON.parse((await createSessionHandler(deps())({ ...request({ uid, businessId, method: "GET" }) })).body);
const member = (uid) => world.db.docs.get(`businesses/${H}/members/${uid}`);

describe("navigation preference", () => {
  it("validation: 1–3 known, non-core pages, each once; null = default", () => {
    expect(validateNavigationPreference({ primary: ["expenses", "grocery", "payroll"] })).toEqual({ primary: ["expenses", "grocery", "payroll"] });
    expect(validateNavigationPreference(null)).toBeNull();
    for (const bad of [{ primary: [] }, { primary: ["a", "b", "c", "d"] }, { primary: ["expenses", "expenses"] }, { primary: ["users"] }, { primary: ["nope"] }, { primary: ["payroll"], extra: 1 }, []]) expect(() => validateNavigationPreference(bad), JSON.stringify(bad)).toThrow();
  });

  it("each person's own: the Owner's order doesn't change the Admin's; the session returns it; permissions untouched", async () => {
    const before = JSON.stringify(member(u.carlo).permissions);
    expect((await set(u.carlo, { primary: ["expenses", "grocery", "payroll"] })).status).toBe(200);
    expect(member(u.carlo).navigationPreference).toEqual({ primary: ["expenses", "grocery", "payroll"] });
    expect(member(u.dad).navigationPreference).toBeUndefined();
    expect((await session(u.carlo)).member.navigationPreference).toEqual({ primary: ["expenses", "grocery", "payroll"] });
    expect((await session(u.dad)).member.navigationPreference).toBeNull();
    expect(JSON.stringify(member(u.carlo).permissions)).toBe(before);
  });

  it("reset (null) removes it", async () => {
    await set(u.carlo, { primary: ["grocery"] });
    expect((await set(u.carlo, null)).status).toBe(200);
    expect(member(u.carlo).navigationPreference).toBeNull();
  });

  it("invalid input is refused; household staff can't set one", async () => {
    expect((await set(u.carlo, { primary: ["settings"] })).status).toBe(400);
    const staffId = JSON.parse((await createHouseholdStaffHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "POST" }), body: JSON.stringify({ action: "create", staff: { name: "Loriza", dailyWage: 41100, payCycle: "semi_monthly", startDate: "2026-06-07" } }) })).body).staffId;
    const login = JSON.parse((await createHouseholdStaffHandler(deps())({ ...request({ uid: u.carlo, businessId: H, method: "POST" }), body: JSON.stringify({ action: "createLogin", staffId }) })).body);
    await createActivateHandler(deps())({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "activate", token: login.activationToken, password: "kape-at-pandesal" }) });
    expect((await set(login.uid, { primary: ["grocery"] })).status).toBe(403);
  });
});
