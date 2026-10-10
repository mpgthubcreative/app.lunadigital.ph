// Public account activation page (Phase 18.6): /activate#<token>. No login:
// the person opens the link the Owner sent, sees which business it's for
// and their login, and chooses their own password (the Owner never knows
// it). The token comes from the URL fragment (never sent as part of the
// page URL) and is posted to /api/activate, which accepts it once.

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";

async function call(body, fetchImpl) {
  const res = await fetchImpl("/api/activate", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.message || "This link isn't valid. Ask for a new one."), { status: res.status, code: out.error });
  return out.activation;
}

export function renderActivatePage(root, { token = window.location.hash.slice(1), fetchImpl = (...a) => window.fetch(...a) } = {}) {
  const state = { status: "loading", info: null, message: "", formError: "", busy: false };
  // Don't keep the credential in the address bar / history longer than needed.
  try {
    window.history.replaceState(null, "", "/activate");
  } catch {
    /* not important */
  }
  document.title = "Set up your account · Luna";

  function draw() {
    const a = state.info;
    render(
      root,
      html`<main class="receipt-page" data-role="activate-page">
        <div class="card receipt-card">
          <div class="brand">${lunaMark()}<span class="brand-text">Luna</span></div>
          ${state.status === "loading"
            ? html`<p>Loading…</p>`
            : state.status === "error"
              ? html`<h1 class="card-title">Link not valid</h1><p data-role="message">${state.message}</p>`
              : state.status === "done"
                ? html`<h1 class="card-title">You're all set</h1>
                    <p data-role="message">Sign in with <strong>${a.login}</strong> and the password you just chose.</p>
                    <a class="btn btn-primary btn-block" href="/" data-role="signin">Go to sign in</a>`
                : a.used
                  ? html`<h1 class="card-title">Already set up</h1><p data-role="message">This account is ready. Sign in with <strong>${a.login}</strong>.</p><a class="btn btn-primary btn-block" href="/">Go to sign in</a>`
                  : a.expired
                    ? html`<h1 class="card-title">Link expired</h1><p data-role="message">Ask ${a.businessName || "your employer"} for a new link.</p>`
                    : html`<h1 class="card-title">Hi ${a.name}!</h1>
                        <p>${a.businessName} made a Luna account for you.</p>
                        <dl class="dl dl-compact"><dt>${a.usesLoginId ? "Your login ID" : "Your login"}</dt><dd><strong data-role="login">${a.login}</strong></dd></dl>
                        ${a.usesLoginId ? html`<p class="stat-hint">Write it down: you'll type it to sign in.</p>` : ""}
                        <form class="form" data-role="activate-form" novalidate>
                          <div class="field"><label for="actPw">Choose a password</label><input class="input" id="actPw" name="password" type="password" autocomplete="new-password" minlength="8" required /><div class="stat-hint">At least 8 characters. Only you will know it.</div></div>
                          <div class="field"><label for="actPw2">Type it again</label><input class="input" id="actPw2" name="password2" type="password" autocomplete="new-password" required /></div>
                          ${state.formError ? html`<p class="form-error" role="alert">${state.formError}</p>` : ""}
                          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? "disabled" : ""}>${state.busy ? "Saving…" : "Save my password"}</button>
                        </form>`}
        </div>
      </main>`
    );
  }

  root.addEventListener("submit", async (event) => {
    if (event.target.dataset.role !== "activate-form") return;
    event.preventDefault();
    const pw = event.target.elements.password.value;
    const pw2 = event.target.elements.password2.value;
    if (pw.length < 8) state.formError = "Use at least 8 characters.";
    else if (pw !== pw2) state.formError = "The two passwords don't match.";
    else state.formError = "";
    if (state.formError) return draw();
    state.busy = true;
    draw();
    try {
      state.info = await call({ action: "activate", token, password: pw }, fetchImpl);
      state.status = "done";
    } catch (err) {
      if (err.code === "weak-password") state.formError = err.message;
      else {
        state.status = "error";
        state.message = err.message;
      }
    }
    state.busy = false;
    draw();
  });

  draw();
  if (!token) {
    state.status = "error";
    state.message = "This link isn't valid. Ask for a new one.";
    draw();
    return Promise.resolve();
  }
  return call({ action: "view", token }, fetchImpl)
    .then((info) => {
      state.status = "ok";
      state.info = info;
    })
    .catch((err) => {
      state.status = "error";
      state.message = err.message;
    })
    .then(draw);
}
