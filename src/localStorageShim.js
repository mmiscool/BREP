/* idb-localstorage.js
   ES6 single-file IndexedDB-backed drop-in replacement for window.localStorage.
   - Synchronous API via in-memory cache
   - Auto-migrates existing window.localStorage to IndexedDB and removes old keys
   - Cross-tab sync via BroadcastChannel
   - Safe fallback to native localStorage if IndexedDB unavailable
*/

const DB_NAME = '__LS_SHIM_DB__';
const STORE_NAME = 'kv';
const META_NAME = 'meta';
const DB_VERSION = 1;
const MIGRATION_FLAG_KEY = '__ls_migrated__';
const BC_NAME = '__LS_SHIM_BC__';

const hasIndexedDB = typeof indexedDB !== 'undefined' && !!indexedDB.open;
const nativeLocalStorage = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;

function toStringValue(v) {
  // Match Web Storage semantics: everything is coerced to string
  return v === undefined || v === null ? String(v) : String(v);
}

function tryDispatchStorageEvent({ key, oldValue, newValue }) {
  // Best effort to mirror StorageEvent locally (same-tab) and across tabs
  try {
    if (typeof window !== 'undefined') {
      // StorageEvent isn't constructible on all browsers; fall back to CustomEvent
      let ev;
      try {
        ev = new StorageEvent('storage', {
          key,
          oldValue,
          newValue,
          url: window.location.href,
          storageArea: localStorageShim // reference to this shim (not native)
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
    const openReq = indexedDB.open(DB_NAME, DB_VERSION);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(META_NAME)) {
        db.createObjectStore(META_NAME, { keyPath: 'key' });
      }
    };
    openReq.onsuccess = () => resolve(openReq.result);
    openReq.onerror = () => reject(openReq.error || new Error('Failed to open IDB'));
  });
}

async function idbGetAll(db) {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  if (store.getAll && store.getAllKeys) {
    const [items, keys] = await Promise.all([promisifyRequest(store.getAll()), promisifyRequest(store.getAllKeys())]);
    const out = new Map();
    for (let i = 0; i < keys.length; i++) {
      out.set(items[i].key, items[i].value);
    }
    return out;
  }
  // Fallback: cursor
  return new Promise((resolve, reject) => {
    const out = new Map();
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        out.set(cursor.key, cursor.value.value);
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
  tx.onabort = () => {};
  const store = tx.objectStore(STORE_NAME);
  store.put({ key, value });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB put failed'));
  });
}

async function idbDelete(db, key) {
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB delete failed'));
  });
}

async function idbClear(db) {
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB clear failed'));
  });
}

async function idbGetMeta(db, key) {
  const tx = db.transaction([META_NAME], 'readonly');
  const store = tx.objectStore(META_NAME);
  return promisifyRequest(store.get(key)).then((res) => (res ? res.value : undefined));
}
async function idbSetMeta(db, key, value) {
  const tx = db.transaction([META_NAME], 'readwrite');
  const store = tx.objectStore(META_NAME);
  store.put({ key, value });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB meta put failed'));
  });
}

/** LocalStorage-like shim (singleton) */
class LocalStorageShim {
  constructor() {
    this._cache = new Map();          // string -> string
    this._ready = false;              // hydrated from IDB
    this._dbPromise = null;
    this._bc = null;
    this._idbEnabled = hasIndexedDB;

    // Initialize immediately
    this._init();
  }

  /** Internal init: open DB, hydrate cache, migrate native localStorage, setup BroadcastChannel */
  async _init() {
    try {
      if (!this._idbEnabled) {
        // No IDB: fall back to native localStorage transparently
        this._ready = true;
        return;
      }

      this._dbPromise = openDB();
      const db = await this._dbPromise;

      // Hydrate from IDB
      const idbMap = await idbGetAll(db);
      // Populate cache with IDB first
      idbMap.forEach((v, k) => this._cache.set(k, toStringValue(v)));

      // Migrate native localStorage (prefer native values by overwriting)
      await this._maybeMigrateFromNative(db);

      this._setupBroadcast();

      this._ready = true;
    } catch (err) {
      // If anything goes wrong, disable IDB and just use native localStorage
      console.warn('[idb-localstorage] Falling back to native localStorage:', err);
      this._idbEnabled = false;
      this._ready = true;
    }
  }

  _setupBroadcast() {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this._bc = new BroadcastChannel(BC_NAME);
        this._bc.onmessage = (ev) => {
          const { type, key, newValue, oldValue } = ev.data || {};
          if (type === 'set') {
            const prev = this._cache.get(key) ?? null;
            this._cache.set(key, toStringValue(newValue));
            tryDispatchStorageEvent({ key, oldValue: prev, newValue: toStringValue(newValue) });
          } else if (type === 'remove') {
            const prev = this._cache.get(key) ?? null;
            this._cache.delete(key);
            tryDispatchStorageEvent({ key, oldValue: prev, newValue: null });
          } else if (type === 'clear') {
            if (this._cache.size) {
              // compute oldValue semantics: multiple keys -> spec uses nulls; we just notify a clear event
              this._cache.clear();
              tryDispatchStorageEvent({ key: null, oldValue: null, newValue: null });
            }
          }
        };
      }
    } catch {}
  }

  async _maybeMigrateFromNative(db) {
    try {
      const already = await idbGetMeta(db, MIGRATION_FLAG_KEY);
      if (already) return;

      if (nativeLocalStorage) {
        // Copy all keys from native localStorage directly into cache first (so reads are instant)
        const keys = [];
        for (let i = 0; i < nativeLocalStorage.length; i++) {
          const k = nativeLocalStorage.key(i);
          if (k !== null) keys.push(k);
        }

        for (const key of keys) {
          const val = nativeLocalStorage.getItem(key);
          const strVal = val === null ? null : toStringValue(val);
          if (strVal !== null) {
            this._cache.set(key, strVal);
          }
        }

        // Persist into IDB (overwriting any hydrated values)
        for (const key of keys) {
          const val = nativeLocalStorage.getItem(key);
          if (val !== null) {
            await idbPut(db, key, toStringValue(val));
          }
        }

        // Remove from native localStorage (post-migration)
        for (const key of keys) {
          nativeLocalStorage.removeItem(key);
        }
      }

      await idbSetMeta(db, MIGRATION_FLAG_KEY, true);
    } catch (e) {
      // Non-fatal
      console.warn('[idb-localstorage] Migration warning:', e);
    }
  }

  /** --- LocalStorage API --- */

  get length() {
    if (!this._idbEnabled && nativeLocalStorage) return nativeLocalStorage.length;
    return this._cache.size;
  }

  key(n) {
    if (!this._idbEnabled && nativeLocalStorage) return nativeLocalStorage.key(n);
    if (typeof n !== 'number' || n < 0 || n >= this._cache.size) return null;
    return Array.from(this._cache.keys())[n] ?? null;
  }

  getItem(key) {
    if (!this._idbEnabled && nativeLocalStorage) return nativeLocalStorage.getItem(key);
    const k = toStringValue(key);
    const v = this._cache.get(k);
    return v === undefined ? null : v;
  }

  setItem(key, value) {
    const k = toStringValue(key);
    const v = toStringValue(value);

    if (!this._idbEnabled && nativeLocalStorage) {
      // Synchronous native path
      nativeLocalStorage.setItem(k, v);
      return;
    }

    const oldValue = this._cache.get(k) ?? null;
    this._cache.set(k, v);

    // Async persist
    this._dbPromise?.then((db) => idbPut(db, k, v)).catch((e) => {
      console.warn('[idb-localstorage] setItem persist failed:', e);
    });

    // Notify same-tab listeners
    tryDispatchStorageEvent({ key: k, oldValue, newValue: v });
    // Cross-tab notify
    try {
      this._bc?.postMessage({ type: 'set', key: k, newValue: v, oldValue });
    } catch {}
  }

  removeItem(key) {
    const k = toStringValue(key);

    if (!this._idbEnabled && nativeLocalStorage) {
      nativeLocalStorage.removeItem(k);
      return;
    }

    const oldValue = this._cache.get(k) ?? null;
    this._cache.delete(k);

    this._dbPromise?.then((db) => idbDelete(db, k)).catch((e) => {
      console.warn('[idb-localstorage] removeItem persist failed:', e);
    });

    tryDispatchStorageEvent({ key: k, oldValue, newValue: null });
    try {
      this._bc?.postMessage({ type: 'remove', key: k, oldValue, newValue: null });
    } catch {}
  }

  clear() {
    if (!this._idbEnabled && nativeLocalStorage) {
      nativeLocalStorage.clear();
      return;
    }

    if (this._cache.size === 0) return;

    this._cache.clear();

    this._dbPromise?.then((db) => idbClear(db)).catch((e) => {
      console.warn('[idb-localstorage] clear persist failed:', e);
    });

    tryDispatchStorageEvent({ key: null, oldValue: null, newValue: null });
    try {
      this._bc?.postMessage({ type: 'clear' });
    } catch {}
  }

  /** Convenience: iterate keys (non-standard, but handy) */
  *keys() {
    if (!this._idbEnabled && nativeLocalStorage) {
      for (let i = 0; i < nativeLocalStorage.length; i++) {
        const k = nativeLocalStorage.key(i);
        if (k !== null) yield k;
      }
      return;
    }
    yield* this._cache.keys();
  }

  /** Optional: wait until initial hydration completes (if you need it) */
  ready() {
    if (!this._idbEnabled) return Promise.resolve();
    // If initialization failed, _ready is true but _idbEnabled false; still resolve.
    if (this._ready) return Promise.resolve();
    return this._dbPromise.then(() => undefined).catch(() => undefined);
  }
}

// Singleton instance
const localStorageShim = hasIndexedDB ? new LocalStorageShim() : {
  // Pure native fallback if IDB is missing entirely (old browsers)
  get length() { return nativeLocalStorage ? nativeLocalStorage.length : 0; },
  key(n) { return nativeLocalStorage ? nativeLocalStorage.key(n) : null; },
  getItem(k) { return nativeLocalStorage ? nativeLocalStorage.getItem(k) : null; },
  setItem(k, v) { if (nativeLocalStorage) nativeLocalStorage.setItem(k, toStringValue(v)); },
  removeItem(k) { if (nativeLocalStorage) nativeLocalStorage.removeItem(k); },
  clear() { if (nativeLocalStorage) nativeLocalStorage.clear(); },
  *keys() { if (nativeLocalStorage) { for (let i = 0; i < nativeLocalStorage.length; i++) { const k = nativeLocalStorage.key(i); if (k !== null) yield k; } } },
  ready() { return Promise.resolve(); }
};

// Export as named `localStorage` to enable easy find/replace.
// Example replacement: from `window.localStorage` to imported `localStorage`.
export { localStorageShim as localStorage };
