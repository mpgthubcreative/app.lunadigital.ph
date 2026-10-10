// Browser authentication (Firebase Auth, email + password).
// Proves WHO the user is. What they may access is decided server-side by
// /api/session and every later API call — never by this module.

import { getFirebase } from "../lib/firebase.js";

const FRIENDLY_ERRORS = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
  "auth/network-request-failed": "Can't reach the sign-in service. Check your connection.",
};

export function friendlyAuthError(err) {
  return FRIENDLY_ERRORS[err && err.code] || "Sign-in failed. Please try again.";
}

export async function watchUser(callback) {
  const { auth } = await getFirebase();
  const { onAuthStateChanged } = await import("firebase/auth");
  return onAuthStateChanged(auth, callback);
}

export async function signIn(email, password) {
  const { auth } = await getFirebase();
  const { signInWithEmailAndPassword } = await import("firebase/auth");
  await signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function signOutUser() {
  const { auth } = await getFirebase();
  const { signOut } = await import("firebase/auth");
  await signOut(auth);
}

export async function currentIdToken() {
  const { auth } = await getFirebase();
  return auth.currentUser ? auth.currentUser.getIdToken() : null;
}

// Phase 18.6: "Forgot password?" on the sign-in screen. Firebase emails the
// reset link straight to the person (Luna never sees it). A login ID has no
// mailbox: its owner gets a new activation link from the business instead.
export async function sendPasswordReset(email) {
  const { auth } = await getFirebase();
  const { sendPasswordResetEmail } = await import("firebase/auth");
  await sendPasswordResetEmail(auth, email.trim());
}
