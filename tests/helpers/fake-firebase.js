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

function getDotted(target, dottedKey) {
  let node = target;
  for (const part of dottedKey.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

function deepMerge(target, data) {
  for (const [k, v] of Object.entries(data)) {
    const plainMap = v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !v[SERVER_TS] && !(INCREMENT in v) && !v[ARRAY_UNION];
    if (plainMap && target[k] && typeof target[k] === "object" && !Array.isArray(target[k]) && !(target[k] instanceof Date)) target[k] = deepMerge(target[k], v);
    else target[k] = resolveValue(v, target[k]);
  }
  return target;
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

// FieldPath.documentId() stand-in (orderBy / where on the document id).
const DOC_ID = Symbol("documentId");
export const FieldPath = { documentId: () => DOC_ID };

const OPS = {
  "==": (a, b) => a === b || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()),
  "<": (a, b) => a !== undefined && a < b,
  "<=": (a, b) => a !== undefined && a <= b,
  ">": (a, b) => a !== undefined && a > b,
  ">=": (a, b) => a !== undefined && a >= b,
  in: (a, b) => b.includes(a),
};
const valueOf = (snap, field) => (field === DOC_ID ? snap.id : snap._data[field] instanceof Date ? snap._data[field].getTime() : snap._data[field]);
const cmp = (a, b) => (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1);

class Query {
  constructor(store, path, filters = [], max = null, order = [], after = null) {
    this.store = store;
    this.path = path;
    this.filters = filters;
    this.max = max;
    this.order = order;
    this.after = after;
  }
  _with(changes) {
    const q = { filters: this.filters, max: this.max, order: this.order, after: this.after, ...changes };
    return new Query(this.store, this.path, q.filters, q.max, q.order, q.after);
  }
  where(field, op, value) {
    if (!OPS[op]) throw new Error(`fake: unsupported operator ${op}`);
    if (op === "in" && (!Array.isArray(value) || value.length > 30)) throw new Error("fake: 'in' needs an array of at most 30 values");
    return this._with({ filters: [...this.filters, { field, op, value: value instanceof Date ? value.getTime() : value }] });
  }
  orderBy(field, dir = "asc") {
    return this._with({ order: [...this.order, { field, dir }] });
  }
  // A document snapshot (like the Admin SDK) or the orderBy values.
  startAfter(...values) {
    return this._with({ after: values });
  }
  limit(n) {
    return this._with({ max: n });
  }
  _matches() {
    const prefix = `${this.path}/`;
    let out = [];
    for (const [path, data] of this.store.docs) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) continue;
      const snap = new DocSnap(new DocRef(this.store, path), clone(data));
      if (this.filters.every((f) => OPS[f.op](valueOf(snap, f.field), f.value))) out.push(snap);
    }
    // Firestore's implicit order: the orderBy fields, then the document id.
    const order = [...this.order];
    if (!order.some((o) => o.field === DOC_ID)) order.push({ field: DOC_ID, dir: order.at(-1)?.dir || "asc" });
    const compare = (x, y) => {
      for (const o of order) {
        const c = cmp(valueOf(x, o.field), valueOf(y, o.field));
        if (c) return o.dir === "desc" ? -c : c;
      }
      return 0;
    };
    out.sort(compare);
    if (this.after) {
      const [first] = this.after;
      const anchor = first instanceof DocSnap ? first : null;
      const values = anchor ? null : this.after.map((v) => (v instanceof Date ? v.getTime() : v));
      out = out.filter((snap) => {
        if (anchor) return compare(snap, anchor) > 0;
        for (let i = 0; i < values.length; i++) {
          const c = cmp(valueOf(snap, order[i].field), values[i]);
          if (c) return (order[i].dir === "desc" ? -c : c) > 0;
        }
        return false;
      });
    }
    return this.max === null ? out : out.slice(0, this.max);
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
  async getAll(...refs) {
    return Promise.all(refs.map((r) => r.get()));
  }
  _set(path, data, options = {}) {
    const previous = this.docs.get(path);
    if (!options.merge || !previous) {
      this.docs.set(path, resolveValue(data, undefined));
      return;
    }
    // Like Firestore set(..., { merge: true }): nested maps merge field by
    // field (increments apply to the current nested value); other values
    // replace.
    this.docs.set(path, deepMerge(clone(previous), data));
  }
  _update(path, data) {
    const previous = this.docs.get(path);
    if (!previous) throw new Error(`fake: NOT_FOUND ${path}`);
    const next = clone(previous);
    // Like Firestore: increments / arrayUnion apply to the CURRENT value at
    // the (possibly dotted) path, not to zero.
    for (const [key, value] of Object.entries(data)) applyDotted(next, key, resolveValue(value, getDotted(next, key)));
    this.docs.set(path, next);
  }
  // Write batch: applied atomically on commit().
  batch() {
    const writes = [];
    return {
      set: (ref, data, options) => writes.push(() => this._set(ref.path, data, options)),
      update: (ref, data) => writes.push(() => this._update(ref.path, data)),
      delete: (ref) => writes.push(() => this.docs.delete(ref.path)),
      commit: async () => {
        const snapshot = new Map(this.docs);
        try {
          writes.forEach((w) => w());
        } catch (err) {
          this.docs = snapshot;
          throw err;
        }
      },
    };
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
    // All-or-nothing like Firestore: a failing write rolls back the others.
    const snapshot = new Map(this.docs);
    try {
      writes.forEach((w) => w());
    } catch (err) {
      this.docs = snapshot;
      throw err;
    }
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

// Minimal stand-in for an Admin SDK Storage bucket.
export class FakeBucket {
  constructor() {
    this.files = new Map();
  }
  file(path) {
    const files = this.files;
    return {
      name: path,
      async save(data, options = {}) {
        files.set(path, { data: Buffer.from(data), contentType: options.contentType, metadata: options.metadata?.metadata || {} });
      },
      async exists() {
        return [files.has(path)];
      },
      async download() {
        if (!files.has(path)) throw Object.assign(new Error("No such object"), { code: 404 });
        return [files.get(path).data];
      },
      async getMetadata() {
        const f = files.get(path);
        return [{ contentType: f.contentType, size: String(f.data.length), metadata: f.metadata }];
      },
      async delete() {
        files.delete(path);
      },
    };
  }
}

export function fakeAdmin() {
  const db = new FakeFirestore();
  const auth = new FakeAuth();
  const admin = { firestore: { FieldValue, FieldPath } };
  const storage = new FakeBucket();
  return { db, auth, admin, storage, bucket: async () => storage };
}
