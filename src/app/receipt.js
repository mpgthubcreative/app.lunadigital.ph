// Salary receipt page (Owner pilot 2026-10-19): /receipt#<token>.
//   Owner pays → Luna makes this link → the Owner sends it to the helper →
//   the helper opens it → signs in if needed (and comes straight back here)
//   → the server checks the account is the Staff member this payroll
//   belongs to → the saved salary breakdown (every line, nothing folded
//   away) → one "Confirm received" for all of it.
// Opening the link never confirms. The token comes from the URL fragment
// (never sent as part of a page URL), is kept for this tab only
// (sessionStorage) so sign-in and refresh return to the same receipt, and is
// posted to /api/receipt with the helper's ID token.

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";
import { formatDayId } from "../lib/format.js";
import { watchUser, signIn, signOutUser, currentIdToken, friendlyAuthError } from "./auth.js";
import { renderLogin } from "./screens.js";
import { salaryBreakdown } from "../components/salary-breakdown.js";

const KEY = "luna.receiptToken";
const remember = (token) => {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    return token || sessionStorage.getItem(KEY) || "";
  } catch {
    return token || "";
  }
};
const confirmedText = (iso, timeZone = "Asia/Manila") => {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone });
  const time = d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone }).toUpperCase();
  return `${day} · ${time}`;
};

const DEFAULT_AUTH = { watchUser, signIn, signOut: signOutUser, idToken: currentIdToken };

export function renderReceiptPage(root, { token: given = window.location.hash.slice(1), fetchImpl = (...a) => window.fetch(...a), auth = DEFAULT_AUTH, login = renderLogin } = {}) {
  const token = remember(given);
  const state = { status: "loading", receipt: null, message: "", code: "", busy: false };
  // Don't keep the credential in the address bar / history; the path stays
  // /receipt so a refresh or a sign-in lands back on this receipt.
  try {
    window.history.replaceState(null, "", "/receipt");
  } catch {
    /* not important */
  }
  document.title = "Salary receipt · Luna";

  async function call(action) {
    const idToken = await auth.idToken();
    const res = await fetchImpl("/api/receipt", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ action, token }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || "This link isn't valid. Ask your employer for a new one."), { status: res.status, code: body.error || "" });
    return body.receipt;
  }

  function draw() {
    const r = state.receipt;
    const confirmed = r?.receiptStatus === "confirmed";
    render(
      root,
      html`<main class="receipt-page" data-role="receipt-page">
        <div class="card receipt-card">
          <div class="brand">${lunaMark()}<span class="brand-text">Luna</span></div>
          ${state.status === "loading"
            ? html`<p>Loading your receipt…</p>`
            : state.status === "error"
              ? html`<h1 class="card-title">${state.code === "receipt-not-yours" ? "Not your receipt" : "Link not valid"}</h1>
                  <p data-role="message">${state.message}</p>
                  ${state.code === "receipt-not-yours" ? html`<button type="button" class="btn" data-act="switch">Sign in with another account</button>` : ""}`
              : html`<h1 class="card-title">${confirmed ? "Salary received" : "Your salary"}</h1>
                  <p class="stat-hint" data-role="who">${r.businessName} · ${r.employeeName} · ${formatDayId(r.period.start)} – ${formatDayId(r.period.end)}</p>
                  ${salaryBreakdown(r.rows, r.netPay)}
                  ${r.paidDate ? html`<p class="stat-hint" data-role="paid">Paid ${formatDayId(r.paidDate)}${r.method ? ` · ${r.method}` : ""}</p>` : ""}
                  ${confirmed
                    ? html`<p class="receipt-confirmed" data-role="message"><strong>✓ Received and confirmed</strong><br /><small>${r.employeeName ? `Confirmed by ${r.employeeName}` : "Confirmed"}${r.confirmedAt ? ` · ${confirmedText(r.confirmedAt, r.timezone || undefined)}` : ""}</small></p>`
                    : r.expired
                      ? html`<p data-role="message">This link has expired. Open Luna and confirm it under My salary.</p>`
                      : html`<p class="stat-hint">Confirm received means you received the payment shown above, with this breakdown. Only confirm if you received the full amount.</p><button type="button" class="btn btn-primary btn-block" data-act="confirm" ${state.busy ? "disabled" : ""}>Confirm received</button>`}
                  <p><a href="/" data-role="home">Open Luna</a></p>`}
        </div>
      </main>`
    );
  }

  const fail = (err) => {
    state.status = "error";
    state.code = err.code || "";
    state.message = err.message;
  };
  async function load() {
    state.status = "loading";
    draw();
    try {
      state.receipt = await call("view");
      state.status = "ok";
    } catch (err) {
      fail(err);
    }
    draw();
  }

  root.addEventListener("click", async (event) => {
    if (event.target.closest('[data-act="switch"]')) {
      await auth.signOut(); // the watcher shows sign-in; this receipt stays remembered
      return;
    }
    if (!event.target.closest('[data-act="confirm"]') || state.busy) return;
    state.busy = true;
    draw();
    try {
      state.receipt = await call("confirm");
    } catch (err) {
      fail(err);
    }
    state.busy = false;
    draw();
  });

  if (!token) {
    fail({ message: "This link isn't valid. Ask your employer for a new one." });
    draw();
    return Promise.resolve();
  }
  draw();
  return new Promise((resolve) => {
    auth.watchUser((user) => {
      if (!user) {
        login(root, {
          notice: "Sign in with your Luna account to see your salary receipt.",
          onSubmit: async (email, password) => {
            try {
              await auth.signIn(email, password);
            } catch (err) {
              throw new Error(friendlyAuthError(err));
            }
          },
        });
        resolve();
        return;
      }
      load().then(resolve);
    });
  });
}
