// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderLogin, renderAccessProblem } from "../../src/app/screens.js";
import { friendlyAuthError } from "../../src/app/auth.js";

let root;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app");
});

const submit = () => root.querySelector("#loginForm").dispatchEvent(new Event("submit", { cancelable: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("login screen", () => {
  it("requires email and password before calling sign-in", async () => {
    const onSubmit = vi.fn();
    renderLogin(root, { onSubmit });
    submit();
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(root.querySelector("#loginError").hidden).toBe(false);
  });

  it("submits credentials and shows a friendly error on failure, clearing the password", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Email or password is incorrect."));
    renderLogin(root, { onSubmit });
    root.querySelector("#loginEmail").value = " owner.a@luna.test ";
    root.querySelector("#loginPassword").value = "wrong";
    submit();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("owner.a@luna.test", "wrong");
    expect(root.querySelector("#loginError").textContent).toBe("Email or password is incorrect.");
    expect(root.querySelector("#loginPassword").value).toBe("");
    expect(root.querySelector("#loginSubmit").disabled).toBe(false);
  });

  it("shows a notice (e.g. session ended)", () => {
    renderLogin(root, { onSubmit: vi.fn(), notice: "Your session ended. Please sign in again." });
    expect(root.querySelector(".form-notice").textContent).toMatch(/session ended/);
  });

  it("maps Firebase errors without revealing whether the email exists", () => {
    expect(friendlyAuthError({ code: "auth/invalid-credential" })).toBe("Email or password is incorrect.");
    expect(friendlyAuthError({ code: "auth/too-many-requests" })).toMatch(/Too many attempts/);
    expect(friendlyAuthError({ code: "something-new" })).toBe("Sign-in failed. Please try again.");
  });
});

describe("access problem screen", () => {
  it("explains the problem and offers sign out", () => {
    const onSignOut = vi.fn();
    renderAccessProblem(root, { title: "Access disabled", message: "Your access to this business has been disabled.", email: "x@luna.test", onSignOut });
    expect(root.querySelector(".auth-title").textContent).toBe("Access disabled");
    root.querySelector("#signOutBtn").click();
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(root.querySelector("#retryBtn")).toBeNull();
  });
});
