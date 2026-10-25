// @vitest-environment jsdom
// Bridal final consolidated pass (2026-10-25), on screen: the editor bar
// (Edit · Preview · Undo · ⋯), Family per side, one-step Undo, Reset
// section / Reset invitation; All Guests rows with the invitation link
// (one-tap Copy) and Sent ▾; and the example empty states (shown, never
// saved, gone once there's real data).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountSetup, standardPreviewDesign } from "../../src/modules/wedding/setup.js";
import { mount as mountGuests } from "../../src/modules/wedding/guests.js";
import { mount as mountProgram } from "../../src/modules/wedding/program.js";
import { mount as mountCrew } from "../../src/modules/wedding/crew.js";
import { mount as mountSuppliers } from "../../src/modules/wedding/suppliers.js";
import { mount as mountTasks } from "../../src/modules/wedding/tasks.js";
import { examplesState } from "../../src/components/examples.js";
import { render } from "../../src/lib/html.js";
import { businessDate } from "../../shared/metrics.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async (n = 16) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const SESSION = { member: { permissions: { "guests.manage": true } }, business: { timezone: "Asia/Manila" }, subscription: {} };
const IMG_A = "data:image/jpeg;base64,AAAA";
const IMG_B = "data:image/jpeg;base64,BBBB";
let container;
let calls;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

// An in-memory /api/wedding-setup.
function fakeApi(initial = {}, { hero = null, photos = {} } = {}) {
  const db = { setup: structuredClone(initial), hero, photos: { ...photos } };
  calls = [];
  const api = async (_path, { body }) => {
    calls.push(structuredClone(body));
    if (body.action === "get") return { setup: structuredClone(db.setup), hero: db.hero, photos: { ...db.photos }, gallery: [], entourage: [], invitation: null };
    if (body.action === "save") {
      db.setup = { ...db.setup, ...body.setup };
      return { saved: true, setup: structuredClone(db.setup) };
    }
    if (body.action === "preview") return { design: standardPreviewDesign(body.templateId), gallery: [], entourage: [], photos: {} };
    if (body.action === "photo") {
      if (body.dataUrl) db.photos[body.slot] = body.dataUrl;
      else delete db.photos[body.slot];
      return {};
    }
    if (body.action === "hero") {
      db.hero = body.dataUrl;
      return {};
    }
    if (body.action === "resetInvitation") {
      for (const k of ["story", "welcomeMessage", "partner1Family", "partner2Family", "templateOptions"]) delete db.setup[k];
      db.hero = null;
      db.photos = {};
      return { reset: true, setup: structuredClone(db.setup) };
    }
    return {};
  };
  return { api, db };
}
const sheet = () => document.querySelector('[data-role="mini-editor"]');
const sendSheet = async () => {
  sheet().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
};
const saves = () => calls.filter((c) => c.action === "save").map((c) => c.setup);
const NAMED = { templateId: "gold", published: false, partner1Name: "Camille", partner2Name: "Carlo", coupleNames: "Camille & Carlo", weddingDate: "2027-05-15" };
const start = async (setup = NAMED, more = {}, opts = {}) => {
  const f = fakeApi(setup, more);
  mountSetup(container, SESSION, { api: f.api, toast: () => {}, shrink: async () => IMG_B, confirm: async () => true, ...opts });
  await flush();
  return f;
};

describe("the editor bar", () => {
  it("Edit · Preview, Undo and ⋯ (Guide, Change design, Reset invitation); Clean Preview has no controls at all", async () => {
    await start();
    const bar = container.querySelector('[data-role="editor-bar"]');
    expect([...bar.querySelectorAll(".ie-mode")].map((b) => b.textContent)).toEqual(["Edit", "Clean Preview"]);
    expect(bar.querySelector('[data-act="undo"]').disabled).toBe(true);
    expect([...bar.querySelectorAll('[data-role="editor-more"] .menu-item')].map((b) => b.textContent)).toEqual(["Guide", "Change design", "Reset invitation"]);
    bar.querySelector('[data-mode="preview"]').click();
    await flush();
    expect(container.querySelector('[data-act="undo"]')).toBeNull();
    expect(container.querySelectorAll('[data-role="canvas"] .ie-edit, [data-role="canvas"] .ie-replace, [data-role="canvas"] .ie-sample').length).toBe(0);
    // Outside the invitation: how many still use examples, and Back to editing.
    expect(container.querySelector('[data-role="sample-notice"]').textContent).toMatch(/items are still using template examples\. Replace them before publishing/);
    expect(container.querySelector('[data-role="canvas"]').textContent).not.toMatch(/template examples|Sample/);
    expect(container.querySelector('.ie-back [data-mode="edit"]').textContent).toBe("Back to editing");
  });
});

describe("Family: several people per side", () => {
  it("add (relation, Other with its own word), reorder and remove on each side; Save sends the lists in order; the invitation shows them", async () => {
    await start();
    container.querySelector('[data-ie-edit="family"]').click();
    const f = sheet();
    expect(f.querySelector('[data-field="partner1Family"] .field-label').textContent).toBe("Family of Camille");
    expect(f.querySelector('[data-field="partner2Family"] .field-label').textContent).toBe("Family of Carlo");
    // The design's example names are placeholders only.
    expect(f.elements["partner2Family-name-0"].value).toBe("");
    expect(f.elements["partner2Family-name-0"].placeholder).toBe("Daniel Brooks");
    // No older one-line entry: its field isn't shown.
    expect(f.querySelector('[data-field="partner1Parents"]')).toBeNull();
    f.elements["partner2Family-rel-0"].value = "father";
    f.elements["partner2Family-name-0"].value = "Ramon A. Prado";
    f.querySelector('[data-act="list-add"][data-key="partner2Family"]').click();
    f.elements["partner2Family-rel-1"].value = "other";
    f.elements["partner2Family-rel-1"].dispatchEvent(new Event("change", { bubbles: true }));
    expect(f.elements["partner2Family-label-1"].hidden).toBe(false);
    f.elements["partner2Family-label-1"].value = "Ninang";
    f.elements["partner2Family-name-1"].value = "Tita Linda";
    f.querySelector('[data-act="list-add"][data-key="partner2Family"]').click();
    f.elements["partner2Family-rel-2"].value = "brother";
    f.elements["partner2Family-name-2"].value = "John Prado";
    // Reorder: John up one; remove Tita Linda.
    f.querySelector('[data-act="list-up"][data-key="partner2Family"][data-i="2"]').click();
    expect(f.elements["partner2Family-name-1"].value).toBe("John Prado");
    f.querySelector('[data-act="list-remove"][data-key="partner2Family"][data-i="2"]').click();
    f.elements["partner1Family-rel-0"].value = "mother";
    f.elements["partner1Family-name-0"].value = "Maria Reyes";
    await sendSheet();
    expect(saves().at(-1)).toEqual({ partner1Family: [{ relation: "mother", name: "Maria Reyes" }], partner2Family: [{ relation: "father", name: "Ramon A. Prado" }, { relation: "brother", name: "John Prado" }] });
    const fam = [...container.querySelectorAll(".sg-family")].map((x) => [x.querySelector(".sg-kicker").textContent, ...[...x.querySelectorAll(".sg-family-member")].map((m) => [...m.children].map((c) => c.textContent).join(": "))]);
    expect(fam).toEqual([["Family of Camille", "Mother: Maria Reyes"], ["Family of Carlo", "Father: Ramon A. Prado", "Brother: John Prado"]]);
  });
  it("an older wedding's one-line family still shows, and its field appears in the sheet", async () => {
    await start({ ...NAMED, partner1Parents: "Mr. & Mrs. Reyes" });
    expect(container.querySelector(".sg-family").textContent).toMatch(/Mr\. & Mrs\. Reyes/);
    container.querySelector('[data-ie-edit="family"]').click();
    expect(sheet().elements.partner1Parents.value).toBe("Mr. & Mrs. Reyes");
  });
});

describe("Undo (one step)", () => {
  it("reverts the last saved section exactly, then nothing more", async () => {
    const { db } = await start({ ...NAMED, story: "Our first story." });
    container.querySelector('[data-ie-edit="story"]').click();
    sheet().elements.story.value = "A new story.";
    await sendSheet();
    expect(db.setup.story).toBe("A new story.");
    const undo = container.querySelector('[data-act="undo"]');
    expect(undo.disabled).toBe(false);
    expect(undo.title).toBe("Undo: Our story");
    undo.click();
    await flush();
    expect(db.setup.story).toBe("Our first story.");
    expect(container.querySelector('[data-act="undo"]').disabled).toBe(true);
  });
  it("a photo replacement: Undo puts the previous photo back (or removes a first photo)", async () => {
    const { db } = await start(NAMED, { photos: { story1: IMG_A } });
    // Replace story1 (pick → shrink → save), then Undo.
    container.querySelector('[data-ie-photo="story1"]').click();
    const input = document.querySelector('[data-role="photo-pick"]');
    Object.defineProperty(input, "files", { value: [new File(["x"], "p.jpg", { type: "image/jpeg" })] });
    input.dispatchEvent(new Event("change"));
    await flush();
    expect(db.photos.story1).toBe(IMG_B);
    container.querySelector('[data-act="undo"]').click();
    await flush();
    expect(db.photos.story1).toBe(IMG_A);
  });
});

describe("Reset section / Reset invitation", () => {
  it("Reset section: only that section (fields, wording, photos) after a confirmation; names and date stay; Undo brings it back", async () => {
    const confirm = vi.fn(async () => true);
    const { db } = await start({ ...NAMED, story: "Ours.", welcomeMessage: "Hello!", templateOptions: { gold: { wording: { storyTitle: "Us" } } } }, { photos: { story1: IMG_A } }, { confirm });
    container.querySelector('[data-ie-edit="story"]').click();
    sheet().querySelector('[data-act="reset-section"]').click();
    await flush();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Reset Our story?", confirmLabel: "Reset section" }));
    expect(db.setup.story).toBeNull();
    expect(db.setup.templateOptions.gold.wording).toEqual({ storyEyebrow: null, storyTitle: null });
    expect(db.photos.story1).toBeUndefined();
    expect(db.setup.welcomeMessage).toBe("Hello!"); // other sections untouched
    container.querySelector('[data-act="undo"]').click();
    await flush();
    expect(db.setup.story).toBe("Ours.");
    expect(db.photos.story1).toBe(IMG_A);
    // The names section: names and date are never reset.
    container.querySelector('[data-ie-edit="hero"]').click();
    sheet().elements.city.value = "Tagaytay";
    await sendSheet();
    container.querySelector('[data-ie-edit="hero"]').click();
    sheet().querySelector('[data-act="reset-section"]').click();
    await flush();
    expect(db.setup).toMatchObject({ partner1Name: "Camille", partner2Name: "Carlo", coupleNames: "Camille & Carlo", weddingDate: "2027-05-15", city: null });
  });
  it("Reset section on a section still showing examples: nothing to remove, no confirmation", async () => {
    const confirm = vi.fn(async () => true);
    await start(NAMED, {}, { confirm });
    container.querySelector('[data-ie-edit="dress"]').click();
    sheet().querySelector('[data-act="reset-section"]').click();
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(saves()).toEqual([]);
  });
  it("⋯ → Reset invitation: confirmed, one server call, the design's examples again; Undo is cleared", async () => {
    const confirm = vi.fn(async () => true);
    const { db } = await start({ ...NAMED, story: "Ours." }, { hero: IMG_A }, { confirm });
    container.querySelector('[data-ie-edit="story"]').click();
    sheet().elements.story.value = "Changed.";
    await sendSheet();
    container.querySelector('[data-act="reset-invitation"]').click();
    await flush();
    expect(confirm.mock.calls.at(-1)[0]).toMatchObject({ title: "Reset invitation?", confirmLabel: "Reset invitation", danger: true });
    expect(confirm.mock.calls.at(-1)[0].body).toMatch(/Guests, RSVP answers, roles, seating, expenses, tasks, crew meals and program are not touched/);
    expect(calls.at(-1)).toEqual({ action: "resetInvitation" });
    expect(db.setup.story).toBeUndefined();
    expect(container.querySelector('[data-act="undo"]').disabled).toBe(true);
    expect(container.querySelector(".sg-hero-photo").getAttribute("src")).toBe("/invitations/samples/gold/hero.webp");
    // Declining the confirmation changes nothing.
    confirm.mockResolvedValueOnce(false);
    const n = calls.length;
    container.querySelector('[data-act="reset-invitation"]').click();
    await flush();
    expect(calls.length).toBe(n);
  });
});

describe("All Guests: send invitations from the row", () => {
  const FULL = { coupleNames: "Camille & Carlo", weddingDate: "2027-12-12", rsvpEnabled: true, weddingSlug: "camilleandcarlo" };
  const G = (o) => ({ id: "g1", name: "Carlo", category: "family", side: "both", partySize: 2, rsvp: "awaiting", confirmed: 0, invitationSent: null, revision: 3, history: [], ...o });
  const data = (rows, extra = {}) => ({
    listGuests: vi.fn(async () => ({ rows, hasMore: false })),
    getGuestTotals: vi.fn(async () => ({})),
    getSeating: vi.fn(async () => null),
    getWeddingSetup: vi.fn(async () => ({ setup: FULL })),
    guestsApi: vi.fn(async (b) => (b.action === "inviteLink" ? { path: "/w/camilleandcarlo/invite/" + "a".repeat(32) } : {})),
    ...extra,
  });
  const session = () => sessionFixture({ roleTemplate: "owner", workspaceTemplateId: "bridal-expense" });
  it("a party row: side · invited · +1 allowed; Invitation link [Copy] in one tap (Link copied); Sent ▾ sets today's date; RSVP received", async () => {
    const d = data([G(), G({ id: "g2", name: "The Prado Family", partySize: 4, rsvp: "attending", confirmed: 3, invitationSent: "2026-10-20", members: [{ id: "m1", name: "Ramon" }] })]);
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    const toast = vi.fn();
    mountGuests(container, session(), { data: d, toast, confirm: async () => true });
    await flush();
    const row = (id) => container.querySelector(`[data-guest="${id}"]`);
    expect(row("g1").querySelector('[data-role="guest-sub"]').textContent).toBe("Both / Mutual · 2 invited · +1 allowed");
    expect(row("g2").querySelector('[data-role="guest-sub"]').textContent).toMatch(/4 invited · 3 attending/);
    expect(row("g1").querySelector('[data-role="sent"]').value).toBe("");
    expect(row("g2").querySelector('[data-role="sent"]').selectedOptions[0].textContent).toMatch(/^Sent ✓/);
    expect(row("g2").querySelector('[data-role="rsvp-received"]').textContent).toBe("RSVP received");
    expect(row("g1").querySelector('[data-role="rsvp-received"]')).toBeNull();
    // One tap: the party's link to the clipboard.
    row("g1").querySelector('[data-act="invite-copy-row"]').click();
    await flush();
    expect(d.guestsApi).toHaveBeenCalledWith({ action: "inviteLink", guestId: "g1" });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${location.origin}/w/camilleandcarlo/invite/${"a".repeat(32)}`);
    expect(toast).toHaveBeenCalledWith("Link copied: Carlo", "success");
    // Sent ▾ → the existing invitationSent field, today's date.
    const sel = row("g1").querySelector('[data-role="sent"]');
    sel.value = "sent";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(d.guestsApi).toHaveBeenCalledWith({ action: "update", guestId: "g1", expectedRevision: 3, changes: { invitationSent: businessDate("Asia/Manila") } });
    // Not sent clears it (the guest's history keeps the change).
    const sel2 = container.querySelector('[data-guest="g2"] [data-role="sent"]');
    sel2.value = "";
    sel2.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(d.guestsApi).toHaveBeenCalledWith({ action: "update", guestId: "g2", expectedRevision: 3, changes: { invitationSent: null } });
  });
  it("no clipboard: a small sheet shows the link to copy", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    mountGuests(container, session(), { data: data([G()]), toast: () => {}, confirm: async () => true });
    await flush();
    container.querySelector('[data-act="invite-copy-row"]').click();
    await flush();
    const f = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    expect(f.elements.url.value).toBe(`${location.origin}/w/camilleandcarlo/invite/${"a".repeat(32)}`);
  });
  it("no guests yet: example parties (never saved) and one + Add Guest; real guests replace them", async () => {
    const d = data([]);
    mountGuests(container, session(), { data: d, toast: () => {}, confirm: async () => true });
    await flush();
    const ex = container.querySelector('[data-role="guest-examples"]');
    expect([...ex.querySelectorAll("[data-example] .wl-name")].map((x) => x.textContent)).toEqual(["The Prado Family", "Carlo Prado", "Anna Santos"]);
    expect(ex.querySelector('[data-act="new"]').textContent).toBe("+ Add Guest");
    expect(ex.textContent).toMatch(/Add individuals, couples or families. You can assign roles and tables later./);
    expect(d.guestsApi).not.toHaveBeenCalled();
    container.replaceChildren();
    mountGuests(container, session(), { data: data([G()]), toast: () => {}, confirm: async () => true });
    await flush();
    expect(container.querySelector('[data-role="guest-examples"]')).toBeNull();
  });
});

describe("example empty states elsewhere", () => {
  const S = (perm) => ({ member: { permissions: { [perm]: true } }, business: { id: "w", currency: "PHP" } });
  it("Music & Program and Crew Meals: examples while empty (never sent to the server); hidden once there's a real item", async () => {
    const api = vi.fn(async (_p, { body }) => (body.action === "list" ? { items: [], prices: {} } : {}));
    mountProgram(container, S("tasks.manage"), { api, toast: () => {} });
    await flush();
    expect([...container.querySelectorAll('[data-role="program-examples"] .wl-name')].map((x) => x.textContent)).toEqual(["Bridal entrance", "Signing of marriage contract", "Recessional"]);
    expect(container.querySelector('[data-role="program-examples"] [data-act="new"]').textContent).toBe("+ Add Program Item");
    expect(api.mock.calls.every(([, { body }]) => body.action === "list")).toBe(true);
    container.replaceChildren();
    mountCrew(container, S("vendors.manage"), { api, toast: () => {}, activeSuppliers: async () => [] });
    await flush();
    expect([...container.querySelectorAll('[data-role="crew-examples"] .wl-name')].map((x) => x.textContent)).toEqual(["Photographer team", "Videographer team", "Coordinator team", "Lights & sounds"]);
    expect(container.querySelector('[data-role="crew-examples"]').textContent).toMatch(/4 meals · Lunch/);
    container.replaceChildren();
    const api2 = vi.fn(async () => ({ items: [{ id: "c1", name: "Photo team", breakfast: 0, lunch: 4, dinner: 0 }], prices: {} }));
    mountCrew(container, S("vendors.manage"), { api: api2, toast: () => {}, activeSuppliers: async () => [] });
    await flush();
    expect(container.querySelector('[data-role="crew-examples"]')).toBeNull();
  });
  it("Expenses and Tasks: examples while empty, nothing written, no totals from them; real rows replace them", async () => {
    const empty = { rows: [], hasMore: false };
    const writes = { suppliersApi: vi.fn(), expensesApi: vi.fn(), paymentsApi: vi.fn(), tasksApi: vi.fn(), budgetApi: vi.fn() };
    const data = (o = {}) => ({ getBudget: vi.fn(async () => ({ total: 0, spent: 0, upcoming: 0, contracted: 0, contractedPaid: 0 })), listCategories: vi.fn(async () => []), listWeddingExpenses: vi.fn(async () => empty), activeSuppliers: vi.fn(async () => []), listSuppliers: vi.fn(async () => empty), listSupplierPayments: vi.fn(async () => empty), listTasks: vi.fn(async () => empty), ...writes, ...o });
    const owner = sessionFixture({ roleTemplate: "owner", workspaceTemplateId: "bridal-expense" });
    mountSuppliers(container, owner, { data: data(), now: () => new Date("2026-10-25T04:00:00Z"), toast: () => {}, confirm: async () => true });
    await flush();
    const ex = container.querySelector('[data-role="expense-examples"]');
    expect([...ex.querySelectorAll("[data-example]")].map((r) => [r.querySelector(".wl-name").textContent, r.querySelector(".wl-sub").textContent, r.querySelector(".ex-tag").textContent])).toEqual([
      ["Photographer", "₱90,000 total · ₱20,000 paid · ₱70,000 left", "Example"],
      ["Venue", "₱150,000 total · ₱50,000 paid · ₱100,000 left", "Example"],
      ["Wedding dress", "₱35,000 paid", "Example"],
    ]);
    expect(ex.querySelector('[data-act="add-expense"]').textContent).toBe("+ Add Expense");
    // The money summary is the real (zero) totals, never the examples'.
    expect(container.querySelector('[data-role="money-summary"]').textContent).not.toMatch(/90|150|35/);
    container.replaceChildren();
    mountTasks(container, owner, { data: data(), now: () => new Date("2026-10-25T04:00:00Z"), toast: () => {}, confirm: async () => true });
    await flush();
    expect([...container.querySelectorAll('[data-role="task-examples"] [data-example] .wl-name')].map((x) => x.textContent)).toEqual(["Book final food tasting", "Send final guest count to caterer", "Confirm bridal car", "Pick up wedding rings"]);
    expect(container.querySelector('[data-role="task-examples"] [data-act="new"]').textContent).toBe("+ Add Task");
    for (const fn of Object.values(writes)) expect(fn).not.toHaveBeenCalled();
    container.replaceChildren();
    mountTasks(container, owner, { data: data({ listTasks: vi.fn(async () => ({ rows: [{ id: "t1", title: "Book florist", status: "not_started", open: true, history: [] }], hasMore: false })) }), now: () => new Date("2026-10-25T04:00:00Z"), toast: () => {}, confirm: async () => true });
    await flush();
    expect(container.querySelector('[data-role="task-examples"]')).toBeNull();
  });
  it("examples are drawn quiet, marked Example, and can't be opened", () => {
    const d = document.createElement("div");
    render(d, examplesState({ title: "No tasks yet", items: [{ name: "Confirm bridal car", end: "Due Dec 1" }], add: { act: "new", label: "+ Add Task" } }));
    const row = d.querySelector("[data-example]");
    expect(row.querySelector(".ex-tag").textContent).toBe("Example");
    expect(row.querySelector("button, a")).toBeNull();
    expect(d.querySelector('[data-act="new"]').textContent).toBe("+ Add Task");
  });
});
