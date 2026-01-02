/* idbStorage.js
   Primary IndexedDB-backed app storage with a localStorage-like API.
   - Synchronous reads via in-memory cache
   - Async persistence to IndexedDB
   - Same-tab + optional cross-tab change events
*/

const STORAGE_DB_NAME = '__LS_SHIM_DB__';
const STORE_NAME = 'kv';
const DB_VERSION = 1;
const BC_NAME = '__BREP_STORAGE_BC__';

const hasIndexedDB = typeof indexedDB !== 'undefined' && !!indexedDB.open;

function toStringValue(v) {
  // Match Web Storage semantics: everything is coerced to string
  return v === undefined || v === null ? String(v) : String(v);
}

function tryDispatchStorageEvent(storage, { key, oldValue, newValue }) {
  try {
    if (typeof window !== 'undefined') {
      let ev;
      try {
        ev = new StorageEvent('storage', {
          key,
          oldValue,
          newValue,
          url: window.location.href,
          storageArea: storage,
        });
      } catch {
        ev = new CustomEvent('storage', { detail: { key, oldValue, newValue } });
      }
      window.dispatchEvent(ev);
    }
  } catch {}
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IDB request failed'));
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(STORAGE_DB_NAME, DB_VERSION);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    openReq.onsuccess = () => resolve(openReq.result);
    openReq.onerror = () => reject(openReq.error || new Error('Failed to open storage DB'));
  });
}

function unwrapStoredValue(value) {
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
}

async function idbGetAll(db) {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  if (store.getAll && store.getAllKeys) {
    const [items, keys] = await Promise.all([promisifyRequest(store.getAll()), promisifyRequest(store.getAllKeys())]);
    const out = new Map();
    for (let i = 0; i < keys.length; i++) {
      out.set(String(keys[i]), unwrapStoredValue(items[i]));
    }
    return out;
  }
  return new Promise((resolve, reject) => {
    const out = new Map();
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        out.set(String(cursor.key), unwrapStoredValue(cursor.value));
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error || new Error('Cursor failed'));
  });
}

async function idbPut(db, key, value) {
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  if (store.keyPath) {
    store.put({ key, value });
  } else {
    store.put(value, key);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB put failed'));
  });
}

async function idbDelete(db, key) {
  const tx = db.transaction([STORE_NAME], 'readwrite');
  tx.objectStore(STORE_NAME).delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB delete failed'));
  });
}

async function idbClear(db) {
  const tx = db.transaction([STORE_NAME], 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB clear failed'));
  });
}

class IdbStorage {
  constructor() {
    this._cache = new Map();
    this._ready = false;
    this._dbPromise = null;
    this._bc = null;
    this._idbEnabled = hasIndexedDB;
    this._init();
  }

  async _init() {
    if (!this._idbEnabled) {
      this._ready = true;
      return;
    }

    try {
      this._dbPromise = openDB();
      const db = await this._dbPromise;
      const idbMap = await idbGetAll(db);
      idbMap.forEach((v, k) => this._cache.set(k, toStringValue(v)));
      this._setupBroadcast();
    } catch (err) {
      console.warn('[idb-storage] IndexedDB unavailable; using in-memory storage only.', err);
      this._idbEnabled = false;
    }

    this._ready = true;
  }

  _setupBroadcast() {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this._bc = new BroadcastChannel(BC_NAME);
        this._bc.onmessage = (ev) => {
          const { type, key, newValue, oldValue } = ev.data || {};
          if (type === 'set') {
            const prev = this._cache.get(key) ?? null;
            const next = toStringValue(newValue);
            this._cache.set(key, next);
            tryDispatchStorageEvent(this, { key, oldValue: prev, newValue: next });
          } else if (type === 'remove') {
            const prev = this._cache.get(key) ?? null;
            this._cache.delete(key);
            tryDispatchStorageEvent(this, { key, oldValue: prev, newValue: null });
          } else if (type === 'clear') {
            if (this._cache.size) {
              this._cache.clear();
              tryDispatchStorageEvent(this, { key: null, oldValue: null, newValue: null });
            }
          }
        };
      }
    } catch {}
  }

  get length() {
    return this._cache.size;
  }

  key(n) {
    if (typeof n !== 'number' || n < 0 || n >= this._cache.size) return null;
    return Array.from(this._cache.keys())[n] ?? null;
  }

  getItem(key) {
    const k = toStringValue(key);
    const v = this._cache.get(k);
    return v === undefined ? null : v;
  }

  setItem(key, value) {
    const k = toStringValue(key);
    const v = toStringValue(value);
    const oldValue = this._cache.get(k) ?? null;
    this._cache.set(k, v);

    if (this._idbEnabled) {
      this._dbPromise?.then((db) => idbPut(db, k, v)).catch((e) => {
        console.warn('[idb-storage] setItem persist failed:', e);
      });
    }

    tryDispatchStorageEvent(this, { key: k, oldValue, newValue: v });
    try { this._bc?.postMessage({ type: 'set', key: k, newValue: v, oldValue }); } catch {}
  }

  removeItem(key) {
    const k = toStringValue(key);
    const oldValue = this._cache.get(k) ?? null;
    this._cache.delete(k);

    if (this._idbEnabled) {
      this._dbPromise?.then((db) => idbDelete(db, k)).catch((e) => {
        console.warn('[idb-storage] removeItem persist failed:', e);
      });
    }

    tryDispatchStorageEvent(this, { key: k, oldValue, newValue: null });
    try { this._bc?.postMessage({ type: 'remove', key: k, oldValue, newValue: null }); } catch {}
  }

  clear() {
    if (this._cache.size === 0) return;
    this._cache.clear();

    if (this._idbEnabled) {
      this._dbPromise?.then((db) => idbClear(db)).catch((e) => {
        console.warn('[idb-storage] clear persist failed:', e);
      });
    }

    tryDispatchStorageEvent(this, { key: null, oldValue: null, newValue: null });
    try { this._bc?.postMessage({ type: 'clear' }); } catch {}
  }

  *keys() {
    yield* this._cache.keys();
  }

  ready() {
    if (!this._idbEnabled) return Promise.resolve();
    if (this._ready) return Promise.resolve();
    return this._dbPromise.then(() => undefined).catch(() => undefined);
  }
}

const localStorage = new IdbStorage();

export { localStorage };
