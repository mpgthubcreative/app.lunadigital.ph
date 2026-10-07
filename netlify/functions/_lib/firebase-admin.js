// Centralized, lazy Firebase Admin initialization for all Netlify
// Functions and operator scripts. Credentials come ONLY from server
// environment variables — never commit a service account file, never
// import this from browser code. Nothing project-specific is hard-coded:
// the same code serves any environment (staging, production, emulator).
//
// Lazy on purpose: a function that doesn't touch Firebase (e.g. health)
// must not fail because credentials are missing, and a misconfiguration
// surfaces as a clean 503 rather than a crash at import.

import { RequestError } from "./http.js";

let cached = null;

function usingEmulators() {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
}

export function isFirebaseConfigured() {
  if (usingEmulators()) return Boolean(process.env.FIREBASE_PROJECT_ID);
  return Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}

// Returns { db, auth, admin } where admin.firestore.FieldValue is provided
// for code written against the namespaced API shape (and test fakes).
export async function getAdmin() {
  if (cached) return cached;

  if (!isFirebaseConfigured()) {
    throw new RequestError("server-misconfigured", "This service is temporarily unavailable.", 503);
  }

  const [{ initializeApp, getApps, cert }, { getFirestore, FieldValue }, { getAuth }] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/firestore"),
    import("firebase-admin/auth"),
  ]);

  let app = getApps()[0];
  if (!app) {
    const options = { projectId: process.env.FIREBASE_PROJECT_ID };
    // Optional: Storage isn't provisioned until a later phase.
    if (process.env.FIREBASE_STORAGE_BUCKET) options.storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
    if (!usingEmulators()) {
      options.credential = cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      });
    }
    app = initializeApp(options);
  }

  cached = { db: getFirestore(app), auth: getAuth(app), admin: { firestore: { FieldValue } } };
  return cached;
}
