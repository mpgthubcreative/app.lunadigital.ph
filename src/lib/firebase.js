// Lazy Firebase Web SDK initialization — SDK pieces are only downloaded
// when needed. Configuration comes from VITE_FIREBASE_* environment
// variables (see .env.example); nothing project-specific is hard-coded,
// so the same build logic works for any environment.
//
// Phase 2 uses Auth only (all tenant data flows through /api/*).
// getFirestoreDb() exists for later phases' direct, rules-protected reads
// and is a separate chunk so sign-in never downloads the Firestore SDK.

let appPromise = null;
let authPromise = null;
let firestorePromise = null;
let firestoreLitePromise = null;

const useEmulators = () => import.meta.env.VITE_USE_EMULATORS === "true";

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
  return Boolean(config.apiKey && config.projectId && config.appId && config.authDomain);
}

function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      if (!isFirebaseConfigured()) throw new Error("Firebase is not configured for this environment.");
      const { initializeApp } = await import("firebase/app");
      return initializeApp(readConfig());
    })();
  }
  return appPromise;
}

export function getFirebase() {
  if (!authPromise) {
    authPromise = (async () => {
      const [app, authMod] = await Promise.all([getApp(), import("firebase/auth")]);
      const auth = authMod.getAuth(app);
      if (useEmulators()) authMod.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      return { app, auth };
    })();
  }
  return authPromise;
}

// Firestore Lite: one-shot reads over REST, no realtime listeners or
// offline cache, and a far smaller download. Enough for summary documents
// like the dashboard's; use getFirestoreDb() only where listeners are needed.
export function getFirestoreLite() {
  if (!firestoreLitePromise) {
    firestoreLitePromise = (async () => {
      const [{ app }, lite] = await Promise.all([getFirebase(), import("firebase/firestore/lite")]);
      const db = lite.getFirestore(app);
      if (useEmulators()) lite.connectFirestoreEmulator(db, "127.0.0.1", 8080);
      return { db, lite };
    })();
  }
  return firestoreLitePromise;
}

export function getFirestoreDb() {
  if (!firestorePromise) {
    firestorePromise = (async () => {
      const [app, firestoreMod] = await Promise.all([getApp(), import("firebase/firestore")]);
      const db = firestoreMod.getFirestore(app);
      if (useEmulators()) firestoreMod.connectFirestoreEmulator(db, "127.0.0.1", 8080);
      return db;
    })();
  }
  return firestorePromise;
}
