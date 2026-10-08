// Drift guard: Firestore and Storage rules can't import shared/, so they
// keep their own copies of the module list, limit keys, export-only
// permissions and the data -> module -> permission mapping. This suite
// reads the rule files and fails if any copy disagrees with the registry.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { MODULES, MODULE_IDS, CORE_MODULE_IDS } from "../../shared/modules.js";
import { LIMIT_KEYS, FEATURE_KEYS, FEATURE_DEFINITIONS } from "../../shared/plans.seed.js";
import { EXPORT_ONLY_PERMISSIONS } from "../../shared/tenancy.js";
import { PLAN_ID_PATTERN } from "../../shared/entitlements.js";
import { PERMISSIONS, moduleForPermission } from "../../shared/permissions.js";
import { WORKSPACE_TEMPLATES, WORKSPACE_TEMPLATE_IDS, acceptedTemplateVersions } from "../../shared/workspaces.js";

const root = resolve(import.meta.dirname, "../..");
const firestoreRules = readFileSync(resolve(root, "firestore.rules"), "utf8");
const storageRules = readFileSync(resolve(root, "storage.rules"), "utf8");

// Strips // comments so commented-out code can't satisfy a check.
const code = (text) => text.replace(/\/\/.*$/gm, "");

function listReturnedBy(text, fn) {
  const m = new RegExp(`function ${fn}\\(\\)\\s*\\{\\s*return \\[([^\\]]*)\\]`).exec(code(text));
  if (!m) throw new Error(`function ${fn}() not found`);
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

// Every `match /<name>/...` followed (in its block) by canAccessModule(bid, 'm', 'p').
function gatedPaths(text) {
  const out = {};
  const re = /match \/([A-Za-z]+)\/\{[^}]+\}\s*\{([\s\S]*?)(?=\n\s*match |\n\s*\}\s*\n)/g;
  for (const m of code(text).matchAll(re)) {
    const calls = [...m[2].matchAll(/canAccessModule\(bid, '([a-z]+)', '([a-z.]+)'\)/g)].map((c) => ({ module: c[1], permission: c[2] }));
    if (calls.length) out[m[1]] = calls;
  }
  return out;
}

// Snapshot validation in a rules file must check every module, limit and
// feature the same way validateEntitlementsSnapshot does.
function snapshotChecks(name, text) {
  describe(`${name}: entitlement snapshot validation matches shared/entitlements.js`, () => {
    const src = code(text);

    it("moduleIds / limitKeys / featureKeys match the registry", () => {
      expect(listReturnedBy(text, "moduleIds")).toEqual([...MODULE_IDS]);
      expect(listReturnedBy(text, "limitKeys")).toEqual([...LIMIT_KEYS]);
      expect(listReturnedBy(text, "featureKeys")).toEqual([...FEATURE_KEYS]);
    });

    it("every module flag is type-checked; core modules must be true", () => {
      for (const id of MODULE_IDS) {
        const mod = MODULES.find((m) => m.id === id);
        expect(src, id).toContain(CORE_MODULE_IDS.includes(id) ? `m.${id} == true` : mod.available ? `m.${id} is bool` : `m.${id} == false`);
      }
    });

    it("every limit is checked as a non-negative int", () => {
      for (const key of LIMIT_KEYS) expect(src, key).toContain(`validLimit(l, '${key}')`);
    });

    it("every feature value is checked against its definition", () => {
      for (const [key, def] of Object.entries(FEATURE_DEFINITIONS)) {
        const expected = def.type === "boolean" ? `f.${key} is bool` : `f.${key} in [${def.values.map((v) => `'${v}'`).join(", ")}]`;
        expect(src, key).toContain(expected);
      }
    });

    it("schemaVersion and plan id are checked", () => {
      expect(src).toContain("ent.get('schemaVersion', 0) == 2 && workspaceValid(business, ent)");
      expect(src).toContain("ent.get('planId', null) == planId");
    });

    it("no legacy (schemaVersion 1) arm remains after the Phase 8.5 migration", () => {
      expect(src).not.toMatch(/legacySnapshot|schemaVersion', 0\) == 1/);
    });

    // Rules copy of shared/workspaces.js: id -> version, id -> allowed modules.
    it("workspace template versions and allowed modules match the registry", () => {
      const versions = /function workspaceTemplateVersions\(\)\s*\{\s*return \{([^}]*)\}/.exec(src);
      expect(versions, "workspaceTemplateVersions()").not.toBeNull();
      const parsedVersions = Object.fromEntries([...versions[1].matchAll(/'([a-z0-9-]+)':\s*\[([^\]]*)\]/g)].map((m) => [m[1], m[2].split(",").map((x) => Number(x.trim()))]));
      expect(parsedVersions).toEqual(Object.fromEntries(WORKSPACE_TEMPLATE_IDS.map((id) => [id, acceptedTemplateVersions(id)])));

      const mods = /function workspaceTemplateModules\(\)\s*\{\s*return \{([\s\S]*?)\};\s*\}/.exec(src);
      expect(mods, "workspaceTemplateModules()").not.toBeNull();
      const parsedModules = Object.fromEntries([...mods[1].matchAll(/'([a-z0-9-]+)':\s*\[([^\]]*)\]/g)].map((m) => [m[1], m[2].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean)]));
      expect(parsedModules).toEqual(Object.fromEntries(WORKSPACE_TEMPLATE_IDS.map((id) => [id, [...WORKSPACE_TEMPLATES[id].modules]])));
    });

    it("module access also requires the workspace to allow the module", () => {
      expect(src).toContain("workspaceAllows(business, business.entitlements, moduleId)");
    });
  });
}

snapshotChecks("firestore.rules", firestoreRules);
snapshotChecks("storage.rules", storageRules);

describe("firestore.rules matches the registry", () => {
  it("moduleIds() === MODULE_IDS", () => {
    expect(listReturnedBy(firestoreRules, "moduleIds")).toEqual([...MODULE_IDS]);
  });

  it("limitKeys() === LIMIT_KEYS", () => {
    expect(listReturnedBy(firestoreRules, "limitKeys")).toEqual([...LIMIT_KEYS]);
  });

  it("export-only permissions match shared/tenancy.js", () => {
    const m = /key in \[([^\]]*)\]/.exec(code(firestoreRules));
    expect(m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""))).toEqual([...EXPORT_ONLY_PERMISSIONS]);
  });

  it("plan id pattern matches PLAN_ID_PATTERN", () => {
    expect(code(firestoreRules)).toContain(`planId.matches('${PLAN_ID_PATTERN.source}')`);
  });

  it("every registry collection is gated by its module + permission, and nothing else is", () => {
    const gated = gatedPaths(firestoreRules);
    const expected = {};
    for (const mod of MODULES) {
      for (const [c, permission] of Object.entries(mod.collections)) expected[c] = { module: mod.id, permission };
    }
    // Subcollections inherit their parent collection's gate.
    expected.rows = expected.imports;

    expect(Object.keys(gated).sort()).toEqual(Object.keys(expected).sort());
    for (const [collection, calls] of Object.entries(gated)) {
      for (const call of calls) expect(call, collection).toEqual(expected[collection]);
    }
  });

  it("module data is never gated by permission alone", () => {
    const tenantBlock = code(firestoreRules).split("match /businesses/{bid} {")[1];
    // Inside the tenant block, can(...) appears only inside canAccessModule.
    expect(tenantBlock).not.toMatch(/[^A-Za-z]can\(bid/);
  });

  it("there is no browser write rule", () => {
    const writes = [...code(firestoreRules).matchAll(/allow ([a-z, ]+):\s*if ([^;]+);/g)].filter((m) => /write|create|update|delete/.test(m[1]));
    expect(writes.map((m) => m[2].trim())).toEqual(["false"]);
  });
});

describe("storage.rules matches the registry", () => {
  it("moduleIds() === MODULE_IDS", () => {
    expect(listReturnedBy(storageRules, "moduleIds")).toEqual([...MODULE_IDS]);
  });

  it("every storage area is gated by its module + permission", () => {
    const gated = {};
    for (const m of code(storageRules).matchAll(/match \/([a-z]+)\/\{path=\*\*\}\s*\{ allow read: if canAccessModule\(bid, '([a-z]+)', '([a-z.]+)'\); \}/g)) {
      gated[m[1]] = { module: m[2], permission: m[3] };
    }
    const expected = {};
    for (const mod of MODULES) for (const [area, permission] of Object.entries(mod.storage)) expected[area] = { module: mod.id, permission };
    expect(gated).toEqual(expected);
  });

  it("there is no browser write rule", () => {
    const writes = [...code(storageRules).matchAll(/allow ([a-z, ]+):\s*if ([^;]+);/g)].filter((m) => /write|create|update|delete/.test(m[1]));
    expect(writes.map((m) => m[2].trim())).toEqual(["false"]);
  });
});

describe("permission -> module ownership", () => {
  it("every permission belongs to a real module", () => {
    for (const key of Object.keys(PERMISSIONS)) expect(MODULE_IDS, key).toContain(moduleForPermission(key));
  });

  it("every built module's view permission belongs to that module", () => {
    for (const mod of MODULES.filter((m) => m.available)) expect(moduleForPermission(mod.permission), mod.id).toBe(mod.id);
  });

  it("collection permissions belong to the collection's module", () => {
    for (const mod of MODULES) for (const permission of Object.values(mod.collections)) expect(moduleForPermission(permission), mod.id).toBe(mod.id);
  });

  it("storage-area permissions belong to the area's module", () => {
    for (const mod of MODULES) for (const permission of Object.values(mod.storage)) expect(moduleForPermission(permission)).toBe(mod.id);
  });

  it("unknown permissions have no module", () => {
    expect(moduleForPermission("teleport.view")).toBeNull();
  });
});
