// Distributor imports (Phase 12): Products and Customers from .xlsx / .csv.
// Pure definitions shared by the browser (mapping, early feedback) and the
// server (authoritative validation). Rows are turned into exactly the
// input the Products / Customers screens send, then checked by the SAME
// validators (validateProductInput / validateCustomerInput), so an import
// can never create something the screens couldn't.
//
// Deliberately NOT imported: orders, payments, expenses, inventory
// movements (stock is entered with Inventory's opening count), sales /
// COGS history. Existing records are never updated by an import: a row
// matching one is skipped with a warning.

import { validateProductInput, InventoryError } from "./inventory.js";
import { validateCustomerInput, phoneKey, CustomerError } from "./customers.js";
import { parseCentavos, parseQuantity, UNITS, QuantityError } from "./quantity.js";

export const IMPORT_SCHEMA_VERSION = 1;
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_CHUNK_ROWS = 200; // rows per stored chunk document
export const IMPORT_COMMIT_BATCH = 100; // rows created per commit request
export const IMPORT_CELL_MAX = 500;
export const IMPORT_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export const IMPORT_STATUSES = Object.freeze({ previewed: "Ready to import", committing: "Importing", completed: "Completed", cancelled: "Cancelled", expired: "Expired" });
export const ROW_STATUSES = Object.freeze({ ready: "Ready", warning: "Warning", error: "Error" });

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const field = (key, label, { required = false, synonyms = [] } = {}) => ({ key, label, required, synonyms: [key, label, ...synonyms].map(normalizeHeader) });

export const IMPORT_TYPES = Object.freeze({
  products: {
    label: "Products",
    module: "inventory",
    permission: "products.manage",
    fields: [
      field("sku", "SKU", { required: true, synonyms: ["item code", "code", "product code", "stock code"] }),
      field("name", "Name", { required: true, synonyms: ["product", "product name", "item", "item name", "description"] }),
      field("category", "Category", { synonyms: ["group", "type"] }),
      field("unit", "Unit", { required: true, synonyms: ["uom", "unit of measure", "units"] }),
      field("sellingPrice", "Selling price", { required: true, synonyms: ["price", "srp", "unit price", "retail price"] }),
      field("reorderLevel", "Reorder level", { synonyms: ["reorder", "reorder point", "min stock", "minimum stock", "minimum"] }),
    ],
  },
  customers: {
    label: "Customers",
    module: "customers",
    permission: "customers.manage",
    fields: [
      field("name", "Name", { required: true, synonyms: ["customer", "customer name", "store", "store name", "buyer"] }),
      field("company", "Company", { synonyms: ["business", "company name", "store company"] }),
      field("phone", "Phone", { synonyms: ["mobile", "contact", "contact number", "phone number", "cellphone", "cp"] }),
      field("email", "Email", { synonyms: ["e-mail", "email address"] }),
      field("address", "Address", { synonyms: ["location", "delivery address"] }),
      field("notes", "Notes", { synonyms: ["remarks", "note", "comments"] }),
    ],
  },
});
export const IMPORT_TYPE_IDS = Object.freeze(Object.keys(IMPORT_TYPES));

export function normalizeHeader(h) {
  return String(h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// headers -> { fieldKey: columnIndex | null }, best guess by name.
export function autoMap(type, headers) {
  const def = IMPORT_TYPES[type];
  const used = new Set();
  const out = {};
  for (const f of def.fields) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && f.synonyms.includes(normalizeHeader(h)));
    out[f.key] = i >= 0 ? i : null;
    if (i >= 0) used.add(i);
  }
  return out;
}

export function validateMapping(type, mapping, columnCount) {
  const def = IMPORT_TYPES[type];
  if (!def) throw new ImportError("invalid-type", "Choose Products or Customers");
  const seen = new Set();
  for (const f of def.fields) {
    const c = mapping[f.key];
    if (c === null || c === undefined) {
      if (f.required) throw new ImportError("invalid-mapping", `Choose the column for ${f.label}`);
      continue;
    }
    if (!Number.isInteger(c) || c < 0 || c >= columnCount) throw new ImportError("invalid-mapping", `Invalid column for ${f.label}`);
    if (seen.has(c)) throw new ImportError("invalid-mapping", "Each column can be used for one field only");
    seen.add(c);
  }
  return true;
}

// Mapped row objects { fieldKey: text } from the sheet rows (header row
// excluded). `n` is the spreadsheet row number shown to the user.
export function mapRows(type, rows, mapping, { headerRow = 1 } = {}) {
  const def = IMPORT_TYPES[type];
  return rows
    .map((r, i) => {
      const values = {};
      for (const f of def.fields) {
        const c = mapping[f.key];
        if (c !== null && c !== undefined) values[f.key] = String(r[c] ?? "").trim();
      }
      return { n: headerRow + 1 + i, values };
    })
    .filter((row) => Object.values(row.values).some((v) => v !== ""));
}

// ---------- per-row conversion (shape only; duplicates are server-side) ----------

const UNIT_ALIASES = { pc: "pcs", piece: "pcs", pieces: "pcs", kilo: "kg", kilos: "kg", kgs: "kg", gram: "g", grams: "g", liter: "l", litre: "l", liters: "l", litres: "l", ltr: "l", milliliter: "ml", millilitre: "ml", meter: "m", metre: "m", meters: "m", boxes: "box", cases: "case", packs: "pack", sacks: "sack", bottles: "bottle", rolls: "roll", sets: "set", dozens: "dozen" };
function unitId(text) {
  const t = String(text).trim().toLowerCase().replace(/\.$/, "");
  if (Object.hasOwn(UNITS, t)) return t;
  if (Object.hasOwn(UNIT_ALIASES, t)) return UNIT_ALIASES[t];
  const byLabel = Object.entries(UNITS).find(([, u]) => u.label.toLowerCase() === t);
  return byLabel ? byLabel[0] : null;
}
const money = (text) => String(text).replace(/₱|php|p(?=\d)/gi, "").replace(/\s/g, "");

// values -> { input } for createProduct / createCustomer, or { errors: [] }.
export function convertRow(type, values) {
  for (const [k, v] of Object.entries(values || {})) {
    if (!IMPORT_TYPES[type].fields.some((f) => f.key === k)) return { errors: [`Unknown field ${k}`] };
    if (typeof v !== "string") return { errors: [`${k} must be text`] };
    if (v.length > IMPORT_CELL_MAX) return { errors: [`${k} is longer than ${IMPORT_CELL_MAX} characters`] };
  }
  const errors = [];
  try {
    if (type === "products") {
      const unit = unitId(values.unit ?? "");
      if (!unit) errors.push(`Unit "${values.unit ?? ""}" isn't one of ${Object.values(UNITS).map((u) => u.label).join(", ")}`);
      let sellingPrice = null;
      try {
        sellingPrice = parseCentavos(money(values.sellingPrice ?? ""));
      } catch {
        errors.push(`Selling price "${values.sellingPrice ?? ""}" isn't an amount like 1250.50`);
      }
      let reorderLevel = 0;
      if (unit && values.reorderLevel) {
        try {
          reorderLevel = parseQuantity(values.reorderLevel, unit);
        } catch (err) {
          errors.push(`Reorder level: ${err.message}`);
        }
      }
      if (errors.length) return { errors };
      const input = validateProductInput({ sku: values.sku ?? "", name: values.name ?? "", ...(values.category ? { category: values.category } : {}), unit, sellingPrice, reorderLevel });
      return { input };
    }
    const raw = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
    const clean = validateCustomerInput(raw);
    return { input: Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null && v !== undefined)) };
  } catch (err) {
    if (err instanceof InventoryError || err instanceof CustomerError || err instanceof QuantityError) return { errors: [err.message] };
    throw err;
  }
}

// The key used to find duplicates of a row, within the file and in Luna.
export function duplicateKeys(type, input) {
  if (type === "products") return { sku: input.sku };
  return { nameLower: input.name.toLocaleLowerCase("en"), phoneKey: phoneKey(input.phone ?? null) };
}
