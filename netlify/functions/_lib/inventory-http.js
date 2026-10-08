// Shared plumbing for the product / inventory endpoints: actor identity,
// strict payload shapes, and mapping service errors to safe responses.

import { RequestError } from "./http.js";
import { InventoryError } from "../../../shared/inventory.js";
import { QuantityError } from "../../../shared/quantity.js";

export function actorOf(context) {
  return { uid: context.user.uid, name: context.user.name || context.user.email || context.user.uid, email: context.user.email || "" };
}

// Rejects any key outside `allowed` (no smuggled balances / costs / ids).
export function only(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("invalid-request", "Invalid request.", 400);
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new RequestError("invalid-request", `Unexpected field: ${key}`, 400);
  }
  return body;
}

export function optionalText(value, field, max) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new RequestError("invalid-request", `${field} must be text`, 400);
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > max) throw new RequestError("invalid-request", `${field} is too long (max ${max})`, 400);
  return text || null;
}

const STATUS = {
  "not-found": 404,
  "duplicate-sku": 409,
  "product-in-use": 409,
  "has-reservations": 409,
  "opening-not-allowed": 409,
  "insufficient-stock": 409,
  "insufficient-reserved": 409,
  "no-cost-basis": 409,
  "unit-locked": 409,
};

// Service errors carry safe, user-facing messages; anything else is a 500.
export async function mapInventoryErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InventoryError || err instanceof QuantityError) {
      throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
    }
    throw err;
  }
}
