// Minimal in-memory stand-ins for the Firebase Admin SDK surface Luna's
// server code uses (Firestore docs/collections/equality queries/count/
// transactions + FieldValue, and Auth token verification/users).
//
// Unit-test fidelity only. Phase 3 replaces this with the real Firestore
// emulator for tenant-isolation tests.

const SERVER_TS = Symbol("serverTimestamp");
const ARRAY_UNION = Symbol("arrayUnion");
const INCREMENT = Symbol("increment");

export const FieldValue = {
  serverTimestamp: () => ({ [SERVER_TS]: true }),
  arrayUnion: (...values) => ({ [ARRAY_UNION]: values }),
  increment: (n) => ({ [INCREMENT]: n }),
};

let autoId = 0;

function resolveValue(value, previous) {
  if (value && typeof value === "object") {
    if (value[SERVER_TS]) return new Date("2026-10-07T00:00:00Z");
    if (INCREMENT in value) return (typeof previous === "number" ? previous : 0) + value[INCREMENT];
    if (value[ARRAY_UNION]) {
      const base = Array.isArray(previous) ? [...previous] : [];
      for (const v of value[ARRAY_UNION]) if (!base.includes(v)) base.push(v);
      return base;
    }
    if (!Array.isArray(value) && !(value instanceof Date)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, previous ? previous[k] : undefined);
      return out;
    }
  }
  return value;
}

function applyDotted(target, dottedKey, value) {
  const parts = dottedKey.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    node[part] = node[part] && typeof node[part] === "object" ? { ...node[part] } : {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

class DocSnap {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this._data = data;
  }
  data() {
    return clone(this._data);
  }
}

class DocRef {
  constructor(store, path) {
    this.store = store;
    this.path = path;
    this.id = path.split("/").at(-1);
  }
  collection(name) {
    return new CollectionRef(this.store, `${this.path}/${name}`);
  }
  async get() {
    return new DocSnap(this, clone(this.store.docs.get(this.path)));
  }
  async set(data, options) {
    this.store._set(this.path, data, options);
  }
  async update(data) {
    this.store._update(this.path, data);
  }
  async delete() {
    this.store.docs.delete(this.path);
  }
  async create(data) {
    if (this.store.docs.has(this.path)) {
      const err = new Error("6 ALREADY_EXISTS: Document already exists");
      err.code = 6;
      throw err;
    }
    this.store._set(this.path, data);
  }
}

class Query {
  constructor(store, path, filters = []) {
    this.store = store;
    this.path = path;
    this.filters = filters;
  }
  where(field, op, value) {
    if (op !== "==") throw new Error(`fake: unsupported operator ${op}`);
    return new Query(this.store, this.path, [...this.filters, { field, value }]);
  }
  _matches() {
    const prefix = `${this.path}/`;
    const out = [];
    for (const [path, data] of this.store.docs) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) continue;
      if (this.filters.every((f) => data[f.field] === f.value)) out.push(new DocSnap(new DocRef(this.store, path), clone(data)));
    }
    return out;
  }
  async get() {
    const docs = this._matches();
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this._matches().length }) }) };
  }
}

class CollectionRef extends Query {
  doc(id) {
    autoId += 1;
    return new DocRef(this.store, `${this.path}/${id ?? `auto${String(autoId).padStart(6, "0")}`}`);
  }
}

export class FakeFirestore {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new CollectionRef(this, name);
  }
  doc(path) {
    return new DocRef(this, path);
  }
  _set(path, data, options = {}) {
    const previous = this.docs.get(path);
    const base = options.merge && previous ? previous : {};
    this.docs.set(path, { ...base, ...resolveValue(data, base) });
  }
  _update(path, data) {
    const previous = this.docs.get(path);
    if (!previous) throw new Error(`fake: NOT_FOUND ${path}`);
    const next = clone(previous);
    for (const [key, value] of Object.entries(data)) applyDotted(next, key, resolveValue(value, undefined));
    this.docs.set(path, next);
  }
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: (target) => target.get(),
      set: (ref, data, options) => writes.push(() => this._set(ref.path, data, options)),
      update: (ref, data) => writes.push(() => this._update(ref.path, data)),
      create: (ref, data) =>
        writes.push(() => {
          if (this.docs.has(ref.path)) throw Object.assign(new Error("6 ALREADY_EXISTS"), { code: 6 });
          this._set(ref.path, data);
        }),
      delete: (ref) => writes.push(() => this.docs.delete(ref.path)),
    };
    const result = await fn(tx);
    writes.forEach((w) => w());
    return result;
  }
  // Test helper: raw write without FieldValue handling.
  seed(path, data) {
    this.docs.set(path, structuredClone(data));
  }
}

// Token format for tests: "token:<uid>". Special tokens simulate failures.
export class FakeAuth {
  constructor() {
    this.users = new Map();
    this.disabledUids = new Set();
  }
  async verifyIdToken(token) {
    if (token === "expired") throw Object.assign(new Error("expired"), { code: "auth/id-token-expired" });
    if (!token.startsWith("token:")) throw Object.assign(new Error("bad"), { code: "auth/argument-error" });
    const uid = token.slice("token:".length);
    if (this.disabledUids.has(uid)) throw Object.assign(new Error("disabled"), { code: "auth/user-disabled" });
    const user = [...this.users.values()].find((u) => u.uid === uid);
    return { uid, email: user ? user.email : "", name: user ? user.displayName : "" };
  }
  async getUserByEmail(email) {
    const user = this.users.get(email);
    if (!user) throw Object.assign(new Error("not found"), { code: "auth/user-not-found" });
    return user;
  }
  async createUser({ email, displayName }) {
    const user = { uid: `uid-${email.split("@")[0].replace(/[^a-z0-9]/gi, "")}`, email, displayName };
    this.users.set(email, user);
    return user;
  }
  async generatePasswordResetLink(email) {
    return `https://example.test/reset?email=${encodeURIComponent(email)}`;
  }
}

export function fakeAdmin() {
  const db = new FakeFirestore();
  const auth = new FakeAuth();
  const admin = { firestore: { FieldValue } };
  return { db, auth, admin };
}
