// Full-page screens shown outside the app shell: sign-in and access
// problems (no membership, disabled membership, inactive subscription).

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";
import { ENVIRONMENT_LABELS, normalizeEnvironment } from "@shared/environment.js";

function environmentTag() {
  const env = normalizeEnvironment(import.meta.env.VITE_LUNA_ENV);
  const label = ENVIRONMENT_LABELS[env];
  return label ? html`<div class="env-tag">${label}</div>` : "";
}

function authFrame(body) {
  return html`
    <div class="auth-page">
      <div class="auth-card card">
        <div class="auth-brand">${lunaMark()}<span>Luna</span></div>
        ${environmentTag()}
        ${body}
      </div>
    </div>
  `;
}

// onSubmit(email, password) → resolves on success, throws with a friendly
// message on failure.
export function renderLogin(root, { onSubmit, notice = "" }) {
  render(
    root,
    authFrame(html`
      <h1 class="auth-title">Sign in</h1>
      <p class="auth-subtitle">Use the account your business administrator gave you.</p>
      ${notice ? html`<p class="form-notice" role="status">${notice}</p>` : ""}
      <form class="form" id="loginForm" novalidate>
        <div class="field">
          <label for="loginEmail">Email</label>
          <input class="input" id="loginEmail" name="email" type="email" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="loginPassword">Password</label>
          <input class="input" id="loginPassword" name="password" type="password" autocomplete="current-password" required />
        </div>
        <p class="form-error" id="loginError" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary btn-block" id="loginSubmit">Sign in</button>
      </form>
    `)
  );

  const form = root.querySelector("#loginForm");
  const emailInput = root.querySelector("#loginEmail");
  const passwordInput = root.querySelector("#loginPassword");
  const errorEl = root.querySelector("#loginError");
  const submitBtn = root.querySelector("#loginSubmit");
  emailInput.focus();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    errorEl.hidden = true;
    if (!email || !password) {
      errorEl.textContent = "Enter your email and password.";
      errorEl.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";
    try {
      await onSubmit(email, password);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
      passwordInput.value = "";
      passwordInput.focus();
    }
  });
}

export function renderAccessProblem(root, { title, message, email = "", onSignOut, onRetry = null }) {
  render(
    root,
    authFrame(html`
      <h1 class="auth-title">${title}</h1>
      <p class="auth-subtitle">${message}</p>
      ${email ? html`<p class="auth-meta">Signed in as ${email}</p>` : ""}
      <div class="auth-actions">
        ${onRetry ? html`<button type="button" class="btn" id="retryBtn">Try again</button>` : ""}
        <button type="button" class="btn btn-primary" id="signOutBtn">Sign out</button>
      </div>
    `)
  );
  root.querySelector("#signOutBtn").addEventListener("click", onSignOut);
  if (onRetry) root.querySelector("#retryBtn").addEventListener("click", onRetry);
}

export function renderBoot(root, message = "Loading Luna…") {
  render(root, html`<div class="boot"><span class="spinner" aria-hidden="true"></span><span>${message}</span></div>`);
}
