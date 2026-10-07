// Centralized, lazy Firebase Admin initialization for all Netlify
// Functions. Credentials come ONLY from server environment variables —
// never commit a service account file, never import this from browser code.
//
// Lazy on purpose: a function that doesn't touch Firebase (e.g. health)
// must not fail because credentials are missing, and a misconfiguration
// surfaces as a clean 503 from getAdmin() rather than a crash at import.

import { RequestError } from "./http.js";

let cached = null;

function usingEmulators() {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
}

export function isFirebaseConfigured() {
  if (usingEmulators()) return Boolean(process.env.FIREBASE_PROJECT_ID);
  return Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}

export async function getAdmin() {
  if (cached) return cached;

  if (!isFirebaseConfigured()) {
    throw new RequestError("server-misconfigured", "This service is temporarily unavailable.", 503);
  }

  const { default: admin } = await import("firebase-admin");

  if (!admin.apps.length) {
    const options = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    };
    if (!usingEmulators()) {
      options.credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      });
    }
    admin.initializeApp(options);
  }

  cached = { admin, db: admin.firestore(), auth: admin.auth() };
  return cached;
}
