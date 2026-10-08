// @vitest-environment jsdom
// Phase 12 screen: file -> auto-mapped columns -> server preview (Ready /
// Warning / Error, filter -> view -> download) -> confirm -> batched import
// with progress -> history with row details.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, readSpreadsheet, templateWorkbook } from "../../src/modules/imports/index.js";
import { writeXlsx, readXlsx } from "../../shared/xlsx.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

const FILE = writeXlsx([{ name: "Products", rows: [["Item Code", "Description", "UOM", "SRP"], ["W-1", "Wings", "pcs", 250.5], ["W-1", "Wings again", "pcs", 1], ["", "", "", ""], ["T-1", "Thighs", "kg", 199]] }]);
const PREVIEW = {
  success: true,
  jobId: "jobAAAAAAAAAAAAAAAAA",
  counts: { total: 3, ready: 1, warning: 1, error: 1, warningToCreate: 1, toSkip: 0 },
  rows: [
    { n: 2, status: "ready", action: "create", messages: [] },
    { n: 3, status: "error", action: "none", messages: ["SKU W-1 is also on row 2 of this file"] },
    { n: 5, status: "warning", action: "create", messages: ["=HYPERLINK(\"x\") possible duplicate"] },
  ],
};

function deps(over = {}) {
  const api = vi.fn(async (_p, { body }) => {
    if (body.action === "preview") return PREVIEW;
    if (body.action === "commit") return api.mock.calls.filter(([, o]) => o.body.action === "commit").length < 2 ? { done: false, processed: 1, remaining: 1 } : { done: true, result: { created: 2, skipped: 0, failed: 0, notImported: 1 } };
    return { success: true };
  });
  return {
    api,
    data: {
      listImports: vi.fn(async () => ({ rows: [{ id: "job1", type: "customers", fileName: "c.csv", status: "completed", counts: { total: 3 }, result: { created: 2, skipped: 1, failed: 0, notImported: 0 }, createdBy: { name: "Carlo" }, createdAt: new Date("2026-10-08T06:00:00Z") }], hasMore: false })),
      getImportRows: vi.fn(async () => [{ n: 2, values: { name: "ABC" }, status: "ready", action: "create", messages: [], result: { outcome: "created", id: "c1" } }, { n: 3, values: { name: "ABC" }, status: "warning", action: "skip", messages: ["Already a customer — skipped"], result: null }]),
    },
    toast: vi.fn(),
    download: vi.fn(),
    readFile: async () => FILE.buffer.slice(FILE.byteOffset, FILE.byteOffset + FILE.byteLength),
    ...over,
  };
}
const choose = async (d) => {
  const input = container.querySelector('input[name="file"]');
  Object.defineProperty(input, "files", { value: [{ name: "products.xlsx" }], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
};

describe("reading files", () => {
  it("xlsx and csv: first non-empty row is the header; blank rows kept for numbering", () => {
    const x = readSpreadsheet("p.xlsx", FILE);
    expect(x.headers).toEqual(["Item Code", "Description", "UOM", "SRP"]);
    expect(x.rows[0]).toEqual(["W-1", "Wings", "pcs", "250.5"]);
    const c = readSpreadsheet("c.csv", new TextEncoder().encode("\n\nName,Phone\nABC,0917\n"));
    expect(c).toEqual({ headers: ["Name", "Phone"], rows: [["ABC", "0917"]], headerRow: 3 });
    expect(() => readSpreadsheet("p.pdf", new Uint8Array([1, 2]))).toThrow(/xlsx or .csv/);
  });
  it("templates are real workbooks with the Luna field names", () => {
    expect(readXlsx(templateWorkbook("customers")).rows[0]).toEqual(["Name *", "Company", "Phone", "Email", "Address", "Notes"]);
  });
});

describe("the import flow", () => {
  it("file -> auto mapping -> server preview with the mapped rows (row numbers kept)", async () => {
    const d = deps();
    mount(container, sessionFixture(), d);
    await flush();
    await choose(d);
    const form = container.querySelector('[data-role="mapping"]');
    expect(form.elements.sku.value).toBe("0");
    expect(form.elements.sellingPrice.value).toBe("3");
    expect(form.elements.category.value).toBe("");
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    const body = d.api.mock.calls[0][1].body;
    expect(body).toMatchObject({ action: "preview", type: "products", fileName: "products.xlsx", mapping: { sku: "Item Code", sellingPrice: "SRP", category: null } });
    expect(body.rows.map((r) => r.n)).toEqual([2, 3, 5]);
    expect(body.rows[0].values).toEqual({ sku: "W-1", name: "Wings", unit: "pcs", sellingPrice: "250.5" });
  });

  it("preview: filter -> view -> download the filtered rows; confirm imports in batches", async () => {
    const d = deps();
    mount(container, sessionFixture(), d);
    await flush();
    await choose(d);
    container.querySelector('[data-role="mapping"]').dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(container.querySelectorAll('table[data-table="preview"] tbody tr')).toHaveLength(3);
    container.querySelector('[data-act="filter"][data-filter="error"]').click();
    expect([...container.querySelectorAll('table[data-table="preview"] tbody tr')].map((r) => r.dataset.row)).toEqual(["3"]);
    container.querySelector('[data-act="download-preview"]').click();
    const [name, bytes] = d.download.mock.calls[0];
    expect(name).toBe("luna-import-products-error.xlsx");
    expect(readXlsx(bytes).rows).toEqual([["Row", "Status", "SKU", "Name", "Category", "Unit", "Selling price", "Reorder level", "Message"], ["3", "Error", "W-1", "Wings again", "", "pcs", "1", "", "SKU W-1 is also on row 2 of this file"]]);
    container.querySelector('[data-act="filter"][data-filter="warning"]').click();
    container.querySelector('[data-act="download-preview"]').click();
    expect(readXlsx(d.download.mock.calls[1][1]).rows[1].at(-1)).toBe(`'=HYPERLINK("x") possible duplicate`);
    // Warnings are opt-in.
    expect(container.querySelector('[data-act="commit"]').textContent).toMatch(/Import 1 products/);
    const box = container.querySelector('input[name="includeWarnings"]');
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(container.querySelector('[data-act="commit"]').textContent).toMatch(/Import 2 products/);
    container.querySelector('[data-act="commit"]').click();
    await flush();
    const commits = d.api.mock.calls.filter(([, o]) => o.body.action === "commit").map(([, o]) => o.body);
    expect(commits).toEqual([{ action: "commit", jobId: PREVIEW.jobId, includeWarnings: true }, { action: "commit", jobId: PREVIEW.jobId, includeWarnings: true }]);
    expect(container.querySelector('[data-role="result-summary"]').textContent).toMatch(/2 created · 0 skipped · 0 failed · 1 not imported/);
  });

  it("only offers what the user may import", async () => {
    mount(container, sessionFixture({ roleTemplate: "manager", permissions: resolvePermissions("manager", { revoke: ["products.manage"] }) }), deps());
    await flush();
    expect([...container.querySelectorAll('select[name="type"] option')].map((o) => o.value)).toEqual(["customers"]);
  });

  it("history: one compact row per import; details filter and download rows", async () => {
    const d = deps();
    mount(container, sessionFixture(), d);
    await flush();
    expect(container.querySelector('[data-import="job1"]').textContent).toMatch(/Customers.*c\.csv.*3.*2.*1.*Completed.*Carlo/s);
    container.querySelector('[data-act="view"]').click();
    await flush();
    const view = document.querySelector('[data-role="import-view"]');
    expect(view.querySelectorAll('table[data-table="import-rows"] tbody tr')).toHaveLength(2);
    const sel = view.querySelector('select[name="outcome"]');
    sel.value = "Skipped";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelectorAll('[data-role="import-view"] table[data-table="import-rows"] tbody tr')).toHaveLength(1);
    document.querySelector('[data-role="import-view"] [data-act="download-details"]').click();
    expect(readXlsx(d.download.mock.calls[0][1]).rows[1].slice(0, 3)).toEqual(["3", "Skipped", "ABC"]);
  });

  it("a file over the row limit is refused before anything is sent", async () => {
    const big = writeXlsx([{ name: "P", rows: [["SKU"], ...Array.from({ length: 2001 }, (_, i) => [`S${i}`])] }]);
    const d = deps({ readFile: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength) });
    mount(container, sessionFixture(), d);
    await flush();
    await choose(d);
    expect(container.textContent).toMatch(/more than 2000 data rows/);
    expect(d.api).not.toHaveBeenCalled();
  });
});
