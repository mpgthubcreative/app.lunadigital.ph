// Builds a two-tenant world through the REAL provisioning code, so tests
// exercise the same writes the operator scripts perform.

import { fakeAdmin } from "./fake-firebase.js";
import { seedPlans, createBusiness, ensureAuthUser, addMember } from "../../netlify/functions/_lib/provisioning.js";

export async function buildWorld() {
  const env = fakeAdmin();
  const { db, admin, auth } = env;
  await seedPlans({ db, admin });

  await createBusiness({ db, admin, name: "Biz A", planId: "growth", workspaceTemplateId: "distributor", businessId: "biz-a" });
  await createBusiness({ db, admin, name: "Biz B", planId: "starter", workspaceTemplateId: "distributor", businessId: "biz-b" });
  await createBusiness({ db, admin, name: "Biz S", planId: "starter", workspaceTemplateId: "distributor", businessId: "biz-s", subscriptionStatus: "suspended" });
  await createBusiness({ db, admin, name: "Biz X", planId: "starter", workspaceTemplateId: "distributor", businessId: "biz-x", subscriptionStatus: "cancelled" });

  const uids = {};
  const add = async (key, businessId, roleTemplate, extra = {}) => {
    const user = await ensureAuthUser({ auth, email: `${key}@t.test`, name: key });
    uids[key] = user.uid;
    await addMember({ db, admin, businessId, uid: user.uid, email: user.email, name: key, roleTemplate, ...extra });
  };

  await add("ownera", "biz-a", "owner", { isAccountOwner: true });
  await add("managera", "biz-a", "manager");
  await add("staffa", "biz-a", "staff");
  await add("disableda", "biz-a", "staff", { status: "disabled" });
  await add("ownerb", "biz-b", "owner", { isAccountOwner: true });
  await add("multi", "biz-a", "staff");
  await add("multi", "biz-b", "manager");
  await add("owners", "biz-s", "owner", { isAccountOwner: true });
  await add("ownerx", "biz-x", "owner", { isAccountOwner: true });
  await add("staffx", "biz-x", "staff");
  await ensureAuthUser({ auth, email: "nobody@t.test", name: "nobody" }).then((u) => (uids.nobody = u.uid));

  return { ...env, uids };
}

export function request({ uid, token, businessId, method = "GET" } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  else if (uid) headers.authorization = `Bearer token:${uid}`;
  if (businessId !== undefined) headers["x-luna-business-id"] = businessId;
  return { httpMethod: method, headers };
}
