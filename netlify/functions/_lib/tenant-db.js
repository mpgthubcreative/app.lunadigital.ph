// The ONLY way server code should reach tenant data. Every reference it
// hands out is rooted at businesses/{businessId}/..., so a handler cannot
// accidentally query another tenant's (or every tenant's) collection.
// Handlers should never call db.collection("orders") etc. directly.

import { isValidBusinessId } from "../../../shared/tenancy.js";

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export function tenantDb(db, businessId) {
  if (!isValidBusinessId(businessId)) {
    throw new Error(`tenantDb: invalid businessId ${JSON.stringify(businessId)}`);
  }
  const root = db.collection("businesses").doc(businessId);

  const checkSegment = (value) => {
    if (typeof value !== "string" || !SEGMENT.test(value)) {
      throw new Error(`tenantDb: invalid path segment ${JSON.stringify(value)}`);
    }
    return value;
  };

  return {
    businessId,
    ref: root,
    collection: (name) => root.collection(checkSegment(name)),
    doc: (collectionName, id) => root.collection(checkSegment(collectionName)).doc(checkSegment(id)),
    member: (uid) => root.collection("members").doc(checkSegment(uid)),
  };
}
