// @vitest-environment jsdom
// Phase 18.6: the Users page lists the team first (Add member as the main
// action); role templates are a small section at the bottom. The server
// decides what each person may change; the screen hides what it can't do.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/users/index.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
let container;
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (f) => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

const LIST = {
  members: [
    { uid: "u1", name: "Owner A", login: "owner@t.test", role: "owner", roleLabel: "Owner", status: "active", isAccountOwner: true, activation: "active" },
    { uid: "u2", name: "Ana", login: "ana@t.test", role: "staff", roleLabel: "Staff", status: "active", isAccountOwner: false, activation: "pending" },
    { uid: "u3", name: "Lito", login: "lito.4821", usesLoginId: true, role: "manager", roleLabel: "Manager / Admin", status: "disabled", isAccountOwner: false, activation: "active" },
  ],
  roles: ["manager", "staff"],
  canManage: true,
  you: "u1",
};

describe("Users page", () => {
  it("members first (name, login, role, status), Add member, role templates folded at the bottom", async () => {
    const api = vi.fn(async () => LIST);
    mount(container, sessionFixture(), { api });
    await flush();
    const rows = [...container.querySelectorAll('[data-role="members"] tbody tr')];
    expect(rows.map((r) => r.querySelector("td.cell-strong").textContent.trim())).toEqual(["Owner A (you)", "Ana", "Lito"]);
    expect(rows.map((r) => r.querySelector('[data-col="status"]').textContent.trim())).toEqual(["Active", "Not set up yet", "No access"]);
    expect(container.querySelector('[data-act="add"]').textContent).toMatch(/Add member/);
    // Nothing to change on yourself or the account owner.
    expect(rows[0].querySelector(".menu-item")).toBeNull();
    expect([...rows[1].querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Change role", "New activation link", "Remove access"]);
    expect([...rows[2].querySelectorAll(".menu-item")].map((b) => b.textContent.trim())).toEqual(["Restore access"]);
    const roles = container.querySelector('[data-role="role-templates"]');
    expect(roles.tagName).toBe("DETAILS");
    expect(roles.hasAttribute("open")).toBe(false);
  });

  it("Add member sends name, role and (optional) email, then shows the one-time link", async () => {
    const share = vi.fn(async () => {});
    const api = vi.fn(async (path, opts) => (opts?.method === "POST" ? { uid: "u9", login: "mia.1234", activationToken: "t".repeat(32) } : LIST));
    mount(container, sessionFixture(), { api, share, toast: () => {} });
    await flush();
    container.querySelector('[data-act="add"]').click();
    const form = lastForm();
    form.elements.name.value = "Mia";
    form.elements.role.value = "manager";
    submit(form);
    await flush();
    expect(api).toHaveBeenCalledWith("members", { method: "POST", body: { action: "invite", member: { name: "Mia", role: "manager" } } });
    expect(share.mock.calls[0][0]).toMatchObject({ link: expect.stringMatching(/\/activate#t{32}$/), rows: [["Their login ID", "mia.1234"]] });
  });

  it("a manager sees the team but no actions", async () => {
    mount(container, sessionFixture({ roleTemplate: "manager" }), { api: vi.fn(async () => ({ ...LIST, canManage: false })) });
    await flush();
    expect(container.querySelector('[data-act="add"]')).toBeNull();
    expect(container.querySelector(".menu-item")).toBeNull();
  });
});

describe("Users page (Household): a kasambahay gets Household Staff access, never Manager / Admin", () => {
  const HOME = {
    members: [
      { uid: "u1", name: "Carlo", login: "carlo@t.test", role: "owner", roleLabel: "Owner", status: "active", isAccountOwner: true, activation: "active" },
      { uid: "u5", name: "Yanie", login: "yanie@t.test", role: "manager", roleLabel: "Manager / Admin", status: "active", isAccountOwner: false, activation: "active" },
      { uid: "u6", name: "Riza", login: "riza.1234", role: "household_staff", roleLabel: "Household Staff", status: "active", isAccountOwner: false, activation: "active", householdStaff: true },
    ],
    roles: ["manager"],
    canManage: true,
    you: "u1",
    householdStaffAccess: true,
    staffWithoutLogin: [{ id: "st1", name: "Yanie" }],
  };
  it("Add member asks the access type; Household Staff creates the login linked to the staff record", async () => {
    const api = vi.fn(async (path, opts) => (opts ? { uid: "u7", login: "yanie.4821", activationToken: "t".repeat(40) } : HOME));
    const share = vi.fn(async () => {});
    mount(container, sessionFixture(), { api, share });
    await flush();
    expect(container.querySelector('[data-member="u6"]').textContent).toMatch(/Household Staff/);
    container.querySelector('[data-act="add"]').click();
    let f = lastForm();
    expect([...f.elements.kind.options].map((o) => o.value)).toEqual(["household_staff", "manager"]);
    submit(f);
    await flush();
    f = lastForm();
    expect(f.elements.staffId.value).toBe("st1");
    submit(f);
    await flush();
    expect(api).toHaveBeenCalledWith("household-staff", { method: "POST", body: { action: "createLogin", staffId: "st1" } });
    expect(share).toHaveBeenCalled();
  });
  it("Make household staff turns a mistaken Manager / Admin login into that staff record's login", async () => {
    const api = vi.fn(async (path, opts) => (opts ? { uid: "u5", role: "household_staff", staffId: "st1" } : HOME));
    mount(container, sessionFixture(), { api, toast: vi.fn() });
    await flush();
    const btn = container.querySelector('[data-member="u5"] [data-act="make-staff"]');
    expect(btn).not.toBeNull();
    expect(container.querySelector('[data-member="u6"] [data-act="make-staff"]')).toBeNull();
    btn.click();
    submit(lastForm());
    await flush();
    expect(api).toHaveBeenCalledWith("members", { method: "POST", body: { action: "linkStaff", uid: "u5", staffId: "st1" } });
  });
});
