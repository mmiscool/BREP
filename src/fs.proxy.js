// fs.proxy.js - ESM-safe, works in Node (CJS & ESM) and browser.
// - Node: proxies native fs (sync, callback, and promises).
// - Browser: IndexedDB-backed VFS for a common subset.

const isNode =
  typeof process !== 'undefined' &&
  process.versions &&
  process.versions.node &&
  typeof window === 'undefined';
// Node ESM: preload sync fs once via top-level await.
// Node ESM: preload sync fs once WITHOUT top-level await (safe for browsers).
let nodeFsSync = null;
let _preloadFsStarted = false;

function _kickoffNodeFsPreload() {
  if (!isNode || _preloadFsStarted) return;
  _preloadFsStarted = true;
  (async () => {
    try {
      const fsMod = await import('node:fs');
      nodeFsSync = fsMod.default ?? fsMod;
    } catch (_) {
      nodeFsSync = null;
    }
  })();
}

// start the preload in Node, noop in browsers
_kickoffNodeFsPreload();


let nodeFs = null;
let nodeFsPromises = null;

// Lazily load async fs in Node
async function loadNodeFsIfNeeded() {
  if (!isNode) return;
  if (!nodeFs) {
    const fsMod = await import('node:fs');
    const fsPromisesMod = await import('node:fs/promises');
    nodeFs = fsMod.default ?? fsMod;
    nodeFsPromises = fsPromisesMod.default ?? fsPromisesMod;
  }
}

// -------------------- Browser VFS --------------------

const hasIndexedDB = typeof indexedDB !== 'undefined' && !!indexedDB.open;
const VFS_DB_NAME = '__BREP_VFS_DB__';
const VFS_STORE_NAME = 'vfs';
const VFS_DB_VERSION = 1;
const VFS_KEY = '__VFS_INDEX__';

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IDB request failed'));
  });
}

function openVfsDB() {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(VFS_DB_NAME, VFS_DB_VERSION);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(VFS_STORE_NAME)) {
        db.createObjectStore(VFS_STORE_NAME);
      }
    };
    openReq.onsuccess = () => resolve(openReq.result);
    openReq.onerror = () => reject(openReq.error || new Error('Failed to open VFS DB'));
  });
}

async function idbGet(db, key) {
  const tx = db.transaction([VFS_STORE_NAME], 'readonly');
  const store = tx.objectStore(VFS_STORE_NAME);
  return promisifyRequest(store.get(key));
}

async function idbPut(db, key, value) {
  const tx = db.transaction([VFS_STORE_NAME], 'readwrite');
  tx.objectStore(VFS_STORE_NAME).put(value, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IDB put failed'));
  });
}

function coerceIndex(raw) {
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') return null;
  return parsed;
}

class Stats {
  constructor(entry) {
    this.dev = 0;
    this.mode = entry?.mode ?? 0o666;
    this.nlink = 1;
    this.uid = 0;
    this.gid = 0;
    this.rdev = 0;
    this.blksize = 4096;
    this.ino = 0;
    this.size = entry?.size ?? 0;
    this.blocks = Math.ceil(this.size / this.blksize);
    this.atimeMs = entry?.mtimeMs ?? Date.now();
    this.mtimeMs = entry?.mtimeMs ?? Date.now();
    this.ctimeMs = entry?.mtimeMs ?? Date.now();
    this.birthtimeMs = entry?.birthtimeMs ?? this.mtimeMs;

    this.atime = new Date(this.atimeMs);
    this.mtime = new Date(this.mtimeMs);
    this.ctime = new Date(this.ctimeMs);
    this.birthtime = new Date(this.birthtimeMs);

    this._type = entry?.type ?? 'file';
  }
  isFile() { return this._type === 'file'; }
  isDirectory() { return this._type === 'dir'; }
  isSymbolicLink() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
  isCharacterDevice() { return false; }
  isBlockDevice() { return false; }
}

function normalizePath(p) {
  if (!p) return '/';
  p = p.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}
function dirname(p) {
  p = normalizePath(p);
  const parts = p.split('/');
  parts.pop();
  if (parts.length === 1) return '/';
  return parts.join('/') || '/';
}
function basename(p) {
  p = normalizePath(p);
  const parts = p.split('/');
  return parts.pop() || '/';
}

function strToUint8(str) { return new TextEncoder().encode(str); }
function uint8ToStr(uint8) { return new TextDecoder().decode(uint8); }
function uint8ToBase64(uint8) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    const sub = uint8.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}
function base64ToUint8(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
function nowMs() { return Date.now(); }

class IndexedDbFS {
  constructor() {
    this.index = { entries: {} };
    this._idbEnabled = hasIndexedDB;
    this._ready = false;
    this._dbPromise = null;
    this._persistChain = Promise.resolve();
    this._initPromise = this._init();
  }

  async _init() {
    if (!this._idbEnabled) {
      this._ensureIndex();
      this._ready = true;
      return;
    }

    this._dbPromise = openVfsDB();
    try {
      const db = await this._dbPromise;
      const stored = coerceIndex(await idbGet(db, VFS_KEY));
      if (stored) {
        this.index = stored;
      }
    } catch (err) {
      console.warn('[vfs] IndexedDB unavailable; using in-memory storage only.', err);
      this._idbEnabled = false;
    }

    this._ensureIndex();
    this._ready = true;
  }

  ready() { return this._initPromise; }

  _assertReady() {
    if (!this._ready) {
      throw new Error('Browser VFS not ready. Await fs.ready() before using sync APIs.');
    }
  }

  _ensureIndex() {
    if (!this.index || typeof this.index !== 'object' || typeof this.index.entries !== 'object') {
      this.index = { entries: {} };
    }
    if (!this.index.entries['/']) {
      this.index.entries['/'] = { type: 'dir', children: [], mtimeMs: nowMs(), mode: 0o777 };
      this._save();
    }
  }

  _save() {
    if (!this._idbEnabled) return;
    if (!this._dbPromise) this._dbPromise = openVfsDB();
    const snapshot = this.index;
    this._persistChain = this._persistChain
      .then(() => this._dbPromise)
      .then((db) => idbPut(db, VFS_KEY, snapshot))
      .catch((err) => {
        console.warn('[vfs] Persist failed:', err);
      });
  }
  _enoent(code, path) { const err = new Error(`${code}: no such file or directory, ${path}`); err.code = code; return err; }
  _eexist(code, path) { const err = new Error(`${code}: file already exists, ${path}`); err.code = code; return err; }
  _linkIntoParent(p) {
    const parent = dirname(p);
    const name = basename(p);
    const eParent = this.index.entries[parent];
    if (eParent && eParent.type === 'dir') {
      if (!eParent.children.includes(name)) {
        eParent.children.push(name);
        eParent.mtimeMs = nowMs();
      }
    }
  }
  _unlinkFromParent(p) {
    const parent = dirname(p);
    const name = basename(p);
    const eParent = this.index.entries[parent];
    if (eParent && eParent.type === 'dir') {
      const i = eParent.children.indexOf(name);
      if (i >= 0) {
        eParent.children.splice(i, 1);
        eParent.mtimeMs = nowMs();
      }
    }
  }
  _resolveEncoding(options) {
    if (!options) return null;
    if (typeof options === 'string') return options;
    if (typeof options === 'object' && options.encoding) return options.encoding;
    return null;
  }

  writeFileSync(path, data, options = {}) {
    this._assertReady();
    path = normalizePath(path);
    const enc = this._resolveEncoding(options);
    const parent = dirname(path);
    const eParent = this.index.entries[parent];
    if (!eParent || eParent.type !== 'dir') throw this._enoent('ENOENT', parent);

    let bytes;
    if (data instanceof Uint8Array) bytes = data;
    else if (typeof data === 'string') {
      if (enc && enc !== 'utf8') throw new Error(`Unsupported string encoding in browser VFS: ${enc}`);
      bytes = strToUint8(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      throw new Error('Unsupported data type for writeFileSync');
    }

    const content = uint8ToBase64(bytes);
    const exists = !!this.index.entries[path];
    this.index.entries[path] = {
      type: 'file',
      data: content,
      encoding: 'base64',
      size: bytes.length,
      mtimeMs: nowMs(),
      mode: (options.mode ?? 0o666)
    };
    if (!exists) this._linkIntoParent(path);
    this._save();
  }

  appendFileSync(path, data, options = {}) {
    this._assertReady();
    path = normalizePath(path);
    const enc = this._resolveEncoding(options);

    let appendBytes;
    if (data instanceof Uint8Array) appendBytes = data;
    else if (typeof data === 'string') {
      if (enc && enc !== 'utf8') throw new Error(`Unsupported string encoding in browser VFS: ${enc}`);
      appendBytes = strToUint8(data);
    } else if (ArrayBuffer.isView(data)) {
      appendBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      appendBytes = new Uint8Array(data);
    } else {
      throw new Error('Unsupported data type for appendFileSync');
    }

    const existing = this.index.entries[path];
    if (!existing) return this.writeFileSync(path, appendBytes, options);
    if (existing.type !== 'file') throw this._enoent('EISDIR', path);

    const current = base64ToUint8(existing.data);
    const merged = new Uint8Array(current.length + appendBytes.length);
    merged.set(current, 0);
    merged.set(appendBytes, current.length);

    existing.data = uint8ToBase64(merged);
    existing.size = merged.length;
    existing.mtimeMs = nowMs();
    this._save();
  }

  readFileSync(path, options = {}) {
    this._assertReady();
    path = normalizePath(path);
    const entry = this.index.entries[path];
    if (!entry || entry.type !== 'file') throw this._enoent('ENOENT', path);

    const bytes = base64ToUint8(entry.data);
    const enc = this._resolveEncoding(options);
    if (enc) {
      if (enc !== 'utf8') throw new Error(`Unsupported encoding in browser VFS: ${enc}`);
      return uint8ToStr(bytes);
    }
    return bytes;
  }

  mkdirSync(path, options = {}) {
    this._assertReady();
    path = normalizePath(path);
    const recursive = !!(options && (options.recursive === true));
    if (this.index.entries[path]) {
      if (this.index.entries[path].type === 'dir') return;
      throw this._eexist('EEXIST', path);
    }
    if (!recursive) {
      const parent = dirname(path);
      const eParent = this.index.entries[parent];
      if (!eParent || eParent.type !== 'dir') throw this._enoent('ENOENT', parent);
      this.index.entries[path] = { type: 'dir', children: [], mtimeMs: nowMs(), mode: options.mode ?? 0o777 };
      this._linkIntoParent(path); this._save(); return;
    }
    const parts = normalizePath(path).split('/').filter(Boolean);
    let cur = '/';
    for (const part of parts) {
      const next = normalizePath(cur + '/' + part);
      if (!this.index.entries[next]) {
        this.index.entries[next] = { type: 'dir', children: [], mtimeMs: nowMs(), mode: 0o777 };
        this._linkIntoParent(next);
      } else if (this.index.entries[next].type !== 'dir') {
        throw this._eexist('EEXIST', next);
      }
      cur = next;
    }
    this._save();
  }

  readdirSync(path, options = {}) {
    this._assertReady();
    path = normalizePath(path);
    const entry = this.index.entries[path];
    if (!entry || entry.type !== 'dir') throw this._enoent('ENOTDIR', path);
    const withFileTypes = !!options.withFileTypes;
    const list = entry.children.slice();
    if (!withFileTypes) return list;
    return list.map(name => {
      const childPath = normalizePath(path + '/' + name);
      const ch = this.index.entries[childPath];
      return {
        name,
        isFile: () => ch?.type === 'file',
        isDirectory: () => ch?.type === 'dir'
      };
    });
  }

  unlinkSync(path) {
    this._assertReady();
    path = normalizePath(path);
    const entry = this.index.entries[path];
    if (!entry) throw this._enoent('ENOENT', path);
    if (entry.type !== 'file') throw this._enoent('EISDIR', path);
    delete this.index.entries[path];
    this._unlinkFromParent(path);
    this._save();
  }

  rmdirSync(path, options = {}) {
    this._assertReady();
    path = normalizePath(path);
    const entry = this.index.entries[path];
    if (!entry) throw this._enoent('ENOENT', path);
    if (entry.type !== 'dir') throw this._enoent('ENOTDIR', path);
    const recursive = !!options.recursive;
    if (entry.children.length && !recursive) {
      const err = new Error(`ENOTEMPTY: directory not empty, ${path}`); err.code = 'ENOTEMPTY'; throw err;
    }
    if (recursive) {
      const stack = [path];
      while (stack.length) {
        const cur = stack.pop();
        const e = this.index.entries[cur];
        if (!e) continue;
        if (e.type === 'dir') {
          for (const name of e.children) stack.push(normalizePath(cur + '/' + name));
        }
        if (cur !== path) delete this.index.entries[cur];
      }
    }
    delete this.index.entries[path];
    this._unlinkFromParent(path);
    this._save();
  }

  renameSync(oldPath, newPath) {
    this._assertReady();
    oldPath = normalizePath(oldPath);
    newPath = normalizePath(newPath);
    const entry = this.index.entries[oldPath];
    if (!entry) throw this._enoent('ENOENT', oldPath);

    const newParent = dirname(newPath);
    const pEntry = this.index.entries[newParent];
    if (!pEntry || pEntry.type !== 'dir') throw this._enoent('ENOENT', newParent);

    if (this.index.entries[newPath]) {
      if (this.index.entries[newPath].type === 'dir') {
        const err = new Error(`EISDIR: illegal operation on a directory, ${newPath}`); err.code = 'EISDIR'; throw err;
      }
      delete this.index.entries[newPath];
    }

    this.index.entries[newPath] = entry;
    delete this.index.entries[oldPath];

    this._unlinkFromParent(oldPath);
    this._linkIntoParent(newPath);

    if (entry.type === 'dir') {
      const toFix = [];
      for (const key of Object.keys(this.index.entries)) {
        if (key !== oldPath && key.startsWith(oldPath + '/')) toFix.push(key);
      }
      for (const oldChild of toFix) {
        const rel = oldChild.slice(oldPath.length);
        const target = normalizePath(newPath + rel);
        this.index.entries[target] = this.index.entries[oldChild];
        delete this.index.entries[oldChild];
      }
    }

    entry.mtimeMs = nowMs();
    this._save();
  }

  statSync(path) {
    this._assertReady();
    path = normalizePath(path);
    const entry = this.index.entries[path];
    if (!entry) throw this._enoent('ENOENT', path);
    return new Stats(entry);
  }

  existsSync(path) {
    this._assertReady();
    path = normalizePath(path);
    return !!this.index.entries[path];
  }

  _cbify(fn, ...args) {
    const maybeCb = args[args.length - 1];
    const hasCb = typeof maybeCb === 'function';
    const core = () => {
      try {
        const res = fn.apply(this, hasCb ? args.slice(0, -1) : args);
        if (hasCb) setTimeout(() => maybeCb(null, res), 0);
        else return res;
      } catch (err) {
        if (hasCb) setTimeout(() => maybeCb(err), 0);
        else throw err;
      }
    };
    return core();
  }

  // Async (Node-style callbacks)
  readFile(...args) { return this._cbify(this.readFileSync, ...args); }
  writeFile(...args) { return this._cbify(this.writeFileSync, ...args); }
  appendFile(...args) { return this._cbify(this.appendFileSync, ...args); }
  mkdir(...args) { return this._cbify(this.mkdirSync, ...args); }
  readdir(...args) { return this._cbify(this.readdirSync, ...args); }
  unlink(...args) { return this._cbify(this.unlinkSync, ...args); }
  rmdir(...args) { return this._cbify(this.rmdirSync, ...args); }
  rename(...args) { return this._cbify(this.renameSync, ...args); }
  stat(...args) { return this._cbify(this.statSync, ...args); }

  get promises() {
    const wrap = (syncFn) => (...args) => {
      return new Promise((resolve, reject) => {
        try { const res = syncFn.apply(this, args); resolve(res); }
        catch (e) { reject(e); }
      });
    };
    return {
      readFile: wrap(this.readFileSync),
      writeFile: wrap(this.writeFileSync),
      appendFile: wrap(this.appendFileSync),
      mkdir: wrap(this.mkdirSync),
      readdir: wrap(this.readdirSync),
      unlink: wrap(this.unlinkSync),
      rmdir: wrap(this.rmdirSync),
      rename: wrap(this.renameSync),
      stat: wrap(this.statSync),
      rm: wrap(this.rmSync),
    };
  }

  rmSync(path, options = {}) {
    this._assertReady();
    path = normalizePath(path);
    const { force = false, recursive = false } = (typeof options === 'object' && options) || {};
    if (path === '/') { const err = new Error(`EPERM: operation not permitted, rm '${path}'`); err.code = 'EPERM'; throw err; }
    const entry = this.index.entries[path];
    if (!entry) { if (force) return; throw this._enoent('ENOENT', path); }
    if (entry.type === 'file') { this.unlinkSync(path); return; }
    if (recursive) this.rmdirSync(path, { recursive: true });
    else this.rmdirSync(path);
  }
}

const browserFs = (typeof window !== 'undefined') ? new IndexedDbFS() : null;

// -------------------- Public Export --------------------

const universalFs = {
  ready: () => (browserFs ? browserFs.ready() : Promise.resolve()),
  // Async callback-style
  readFile: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.readFile(...args); } await browserFs.ready(); return browserFs.readFile(...args); },
  writeFile: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.writeFile(...args); } await browserFs.ready(); return browserFs.writeFile(...args); },
  appendFile: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.appendFile(...args); } await browserFs.ready(); return browserFs.appendFile(...args); },
  mkdir: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.mkdir(...args); } await browserFs.ready(); return browserFs.mkdir(...args); },
  readdir: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.readdir(...args); } await browserFs.ready(); return browserFs.readdir(...args); },
  unlink: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.unlink(...args); } await browserFs.ready(); return browserFs.unlink(...args); },
  rmdir: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.rmdir(...args); } await browserFs.ready(); return browserFs.rmdir(...args); },
  rename: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.rename(...args); } await browserFs.ready(); return browserFs.rename(...args); },
  stat: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.stat(...args); } await browserFs.ready(); return browserFs.stat(...args); },
  rm: async (...args) => { if (isNode) { await loadNodeFsIfNeeded(); return nodeFs.rm(...args); } await browserFs.ready(); return browserFs.rm(...args); },

  // Sync methods - supported in Node ESM via createRequire, and in CJS via require.
  readFileSync: (...args) => { if (isNode) return requireLikeFsSync().readFileSync(...args); return browserFs.readFileSync(...args); },
  writeFileSync: (...args) => { if (isNode) return requireLikeFsSync().writeFileSync(...args); return browserFs.writeFileSync(...args); },
  appendFileSync: (...args) => { if (isNode) return requireLikeFsSync().appendFileSync(...args); return browserFs.appendFileSync(...args); },
  mkdirSync: (...args) => { if (isNode) return requireLikeFsSync().mkdirSync(...args); return browserFs.mkdirSync(...args); },
  readdirSync: (...args) => { if (isNode) return requireLikeFsSync().readdirSync(...args); return browserFs.readdirSync(...args); },
  unlinkSync: (...args) => { if (isNode) return requireLikeFsSync().unlinkSync(...args); return browserFs.unlinkSync(...args); },
  rmdirSync: (...args) => { if (isNode) return requireLikeFsSync().rmdirSync(...args); return browserFs.rmdirSync(...args); },
  renameSync: (...args) => { if (isNode) return requireLikeFsSync().renameSync(...args); return browserFs.renameSync(...args); },
  statSync: (...args) => { if (isNode) return requireLikeFsSync().statSync(...args); return browserFs.statSync(...args); },
  existsSync: (...args) => { if (isNode) return requireLikeFsSync().existsSync(...args); return browserFs.existsSync(...args); },
  rmSync: (...args) => { if (isNode) return requireLikeFsSync().rmSync(...args); return browserFs.rmSync(...args); },

  // promises API delegated lazily
  promises: new Proxy({}, {
    get: (_, prop) => {
      if (isNode) {
        return async (...args) => {
          await loadNodeFsIfNeeded();
          const fn = nodeFsPromises[prop];
          if (typeof fn !== 'function') throw new Error(`fs.promises.${String(prop)} is not available`);
          return fn(...args);
        };
      } else {
        return async (...args) => {
          await browserFs.ready();
          const prom = browserFs.promises;
          const fn = prom[prop];
          if (typeof fn !== 'function') throw new Error(`fs.promises.${String(prop)} is not implemented in browser VFS`);
          return fn(...args);
        };
      }
    }
  }),
};

// Helper: obtain sync fs in Node from either CJS require or ESM createRequire.
function requireLikeFsSync() {
  if (!isNode) throw new Error("fs sync shim unavailable in this environment");
  // if preload somehow hasn't started, start it now
  if (!_preloadFsStarted) _kickoffNodeFsPreload();
  if (!nodeFsSync) {
    throw new Error("Synchronous fs not ready yet in Node ESM. Use fs.promises early in startup or run under CommonJS.");
  }
  return nodeFsSync;
}
export const fs = universalFs;
