// universal-path.js (ESM, no dependencies, ES6)
// POSIX-only path replacement that works in Node and the browser.
// Node: proxies to node:path.posix when possible (CJS); falls back to shim in ESM.
// Browser: minimal POSIX path implementation compatible with Node's API.

const isNode =
  typeof process !== 'undefined' &&
  process.versions &&
  process.versions.node &&
  typeof window === 'undefined';

// -------------------- Node path passthrough (POSIX) --------------------
let nodePosix = null;
async function loadNodePathIfNeeded() {
  if (!isNode) return;
  if (!nodePosix) {
    const mod = await import('node:path');
    nodePosix = (mod.default ?? mod).posix;
  }
}

// IMPORTANT: Never assume `require` exists in ESM.
// In CJS we use `require('node:path')`; in ESM we fall back to the shim.
function getNodePosixSync() {
  if (!isNode) return browserPosix;

  // CJS: require is available
  /* eslint-disable no-undef */
  if (typeof require === 'function') {
    const mod = require('node:path');
    return (mod.default ?? mod).posix;
  }
  /* eslint-enable no-undef */

  // Some runtimes expose module.createRequire in CJS-like contexts
  if (typeof module !== 'undefined' && module && typeof module.createRequire === 'function') {
    const req = module.createRequire(typeof __filename !== 'undefined' ? __filename : process.cwd());
    const mod = req('node:path');
    return (mod.default ?? mod).posix;
  }

  // Pure ESM: no sync loader available — use the shim (POSIX semantics).
  return browserPosix;
}

// -------------------- Browser POSIX implementation --------------------
const SEP = '/';
const DELIM = ':';

function _assertString(p) {
  if (typeof p !== 'string') throw new TypeError('Path must be a string');
}

function _isAbsolute(p) {
  return p.startsWith(SEP);
}

function _normalizeString(path, allowAboveRoot) {
  const parts = path.split('/');
  const newParts = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === '.') continue;
    if (part === '..') {
      if (newParts.length && newParts[newParts.length - 1] !== '..') {
        newParts.pop();
      } else if (allowAboveRoot) {
        newParts.push('..');
      }
    } else {
      newParts.push(part);
    }
  }
  return newParts.join('/');
}

function _normalize(path) {
  _assertString(path);
  if (path === '') return '.';
  const isAbs = _isAbsolute(path);
  const trailingSlash = path.endsWith('/');
  let res = _normalizeString(path, !isAbs);
  if (res === '' && !isAbs) res = '.';
  if (res !== '' && trailingSlash) res += '/';
  return (isAbs ? '/' : '') + res;
}

function _join(...paths) {
  let joined = '';
  for (let i = 0; i < paths.length; i++) {
    const segment = paths[i];
    _assertString(segment);
    if (segment !== '') {
      if (joined === '') joined = segment;
      else joined += '/' + segment;
    }
  }
  return _normalize(joined);
}

function _resolve(...paths) {
  // For browser & ESM fallback: base is '/', to match VFS root
  let resolvedPath = '';
  let resolvedAbsolute = false;

  for (let i = paths.length - 1; i >= 0; i--) {
    const p = paths[i];
    if (p === undefined) continue;
    _assertString(p);
    if (p === '') continue;
    resolvedPath = p + '/' + resolvedPath;
    if (p.startsWith('/')) {
      resolvedAbsolute = true;
      break;
    }
  }

  if (!resolvedAbsolute) {
    resolvedPath = '/' + resolvedPath;
    resolvedAbsolute = true;
  }

  const normalized = _normalizeString(resolvedPath, false);
  return (resolvedAbsolute ? '/' : '') + normalized || (resolvedAbsolute ? '/' : '.');
}

function _relative(from, to) {
  _assertString(from); _assertString(to);
  if (from === to) return '';
  from = _resolve(from);
  to = _resolve(to);

  if (from === to) return '';

  const fromParts = from.slice(1).split('/').filter(Boolean);
  const toParts = to.slice(1).split('/').filter(Boolean);

  let i = 0;
  const len = Math.min(fromParts.length, toParts.length);
  for (; i < len; i++) {
    if (fromParts[i] !== toParts[i]) break;
  }

  const up = fromParts.slice(i).map(() => '..');
  const down = toParts.slice(i);
  const rel = up.concat(down).join('/');
  return rel || '';
}

function _dirname(path) {
  _assertString(path);
  if (path.length === 0) return '.';
  const isAbs = _isAbsolute(path);
  const end = path.endsWith('/') ? path.length - 1 : path.length;
  let slashIndex = -1;
  for (let i = end - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47) { slashIndex = i; break; }
  }
  if (slashIndex === -1) return isAbs ? '/' : '.';
  if (isAbs && slashIndex === 0) return '/';
  return path.slice(0, slashIndex);
}

function _basename(path, ext = '') {
  _assertString(path);
  if (ext !== undefined && typeof ext !== 'string') throw new TypeError('ext must be a string');
  let end = path.length;
  if (end === 0) return '';
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  if (end === 0) return '/';

  let start = 0;
  for (let i = end - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47) { start = i + 1; break; }
  }
  let base = path.slice(start, end);
  if (ext && base.endsWith(ext) && ext !== '' && ext !== base) {
    base = base.slice(0, base.length - ext.length);
  }
  return base;
}

function _extname(path) {
  _assertString(path);
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === 47) {
      if (end !== -1) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) end = i + 1;
    if (code === 46) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (startDot === startPart)) return '';
  return path.slice(startDot, end);
}

function _parse(path) {
  _assertString(path);
  const root = _isAbsolute(path) ? '/' : '';
  const dir = _dirname(path);
  const base = _basename(path);
  const ext = _extname(base);
  const name = ext ? base.slice(0, base.length - ext.length) : base;
  return { root, dir, base, ext, name };
}

function _format(obj) {
  const dir = obj.dir || obj.root || '';
  const base = obj.base || (obj.name || '') + (obj.ext || '');
  if (!dir) return base || '.';
  if (dir.endsWith('/')) return dir + base;
  return dir + '/' + base;
}

function _toNamespacedPath(p) { return p; }

// The browser POSIX object (also used as Node ESM fallback)
const browserPosix = {
  sep: SEP,
  delimiter: DELIM,
  normalize: _normalize,
  join: _join,
  resolve: _resolve,
  isAbsolute: _isAbsolute,
  relative: _relative,
  dirname: _dirname,
  basename: _basename,
  extname: _extname,
  parse: _parse,
  format: _format,
  toNamespacedPath: _toNamespacedPath,
  posix: null, // set below
  win32: null, // shimbed
};
browserPosix.posix = browserPosix;

// -------------------- Unified export --------------------
const universalPosix = {
  get sep() { return isNode ? getNodePosixSync().sep : browserPosix.sep; },
  get delimiter() { return isNode ? getNodePosixSync().delimiter : browserPosix.delimiter; },

  normalize: (...args) => isNode ? getNodePosixSync().normalize(...args) : browserPosix.normalize(...args),
  join: (...args) => isNode ? getNodePosixSync().join(...args) : browserPosix.join(...args),
  resolve: (...args) => isNode ? getNodePosixSync().resolve(...args) : browserPosix.resolve(...args),
  isAbsolute: (...args) => isNode ? getNodePosixSync().isAbsolute(...args) : browserPosix.isAbsolute(...args),
  relative: (...args) => isNode ? getNodePosixSync().relative(...args) : browserPosix.relative(...args),
  dirname: (...args) => isNode ? getNodePosixSync().dirname(...args) : browserPosix.dirname(...args),
  basename: (...args) => isNode ? getNodePosixSync().basename(...args) : browserPosix.basename(...args),
  extname: (...args) => isNode ? getNodePosixSync().extname(...args) : browserPosix.extname(...args),
  parse: (...args) => isNode ? getNodePosixSync().parse(...args) : browserPosix.parse(...args),
  format: (...args) => isNode ? getNodePosixSync().format(...args) : browserPosix.format(...args),
  toNamespacedPath: (...args) => isNode ? getNodePosixSync().toNamespacedPath(...args) : browserPosix.toNamespacedPath(...args),

  posix: null,
  win32: null,
};

universalPosix.posix = universalPosix;
const win32Shim = new Proxy({}, {
  get() {
    throw new Error("POSIX-only path module: use the default export/`posix` with your VFS.");
  }
});
universalPosix.win32 = win32Shim;

export default universalPosix;
export const posix = universalPosix;
export const win32 = win32Shim;
export const ensureNodePathLoaded = loadNodePathIfNeeded;
