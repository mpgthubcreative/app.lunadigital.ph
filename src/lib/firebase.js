// Lazy Firebase Web SDK initialization — the SDK is only downloaded when a
// screen actually needs it, keeping the initial shell bundle small.
// Configuration comes from VITE_FIREBASE_* environment variables (see
// .env.example); nothing project-specific is hard-coded.
//
// Phase 1: defined but not yet called. Phase 2 (auth) is the first user.

let instancePromise = null;

function readConfig() {
  const env = import.meta.env;
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
}

export function isFirebaseConfigured() {
  const config = readConfig();
  return Boolean(config.apiKey && config.projectId && config.appId);
}

export function getFirebase() {
  if (!instancePromise) {
    instancePromise = (async () => {
      if (!isFirebaseConfigured()) {
        throw new Error("Firebase is not configured for this environment.");
      }
      const [{ initializeApp }, authMod, firestoreMod] = await Promise.all([
        import("firebase/app"),
        import("firebase/auth"),
        import("firebase/firestore"),
      ]);

      const app = initializeApp(readConfig());
      const auth = authMod.getAuth(app);
      const db = firestoreMod.getFirestore(app);

      if (import.meta.env.VITE_USE_EMULATORS === "true") {
        authMod.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
        firestoreMod.connectFirestoreEmulator(db, "127.0.0.1", 8080);
      }

      return { app, auth, db };
    })();
  }
  return instancePromise;
}
