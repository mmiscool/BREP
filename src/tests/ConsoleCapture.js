// ES6, zero-dependency, drop-in console interceptor.
// Creates a capturing proxy for the global `console` on instantiation,
// forwards everything to the original console, and lets you read/clear logs.
//
// Usage:
//   import ConsoleCapture from './ConsoleCapture.js'
//   const cap = new ConsoleCapture({ captureStack: false });
//   console.log('hello');             // still prints
//   cap.getLogs();                    // -> [{ level:'log', args:['hello'], ... }]
//   cap.clearLogs();
//   cap.pause(); cap.resume();        // toggle capture
//   cap.restore();                    // put the original console back

export class ConsoleCapture {
  constructor(options = {}) {
    this.options = {
      captureStack: Boolean(options.captureStack),
      withTimestamp: options.withTimestamp !== false, // default true
      levels: options.levels || null, // e.g., ['log','warn','error']
      maxEntries: Number.isFinite(options.maxEntries) ? options.maxEntries : Infinity,
    };

    this._orig = (typeof window !== 'undefined' ? window.console : console) || {};
    this._installed = false;
    this._capturing = true;
    this._logs = [];
    this._nextId = 1;

    this._proxy = this._buildProxy();
    this.install(); // start intercepting upon creation
  }

  // ---------------- Public API ----------------

  install() {
    if (this._installed) return;
    const target = typeof window !== 'undefined' ? window : globalThis;
    this._prevConsole = target.console;
    target.console = this._proxy;
    this._installed = true;
  }

  restore() {
    if (!this._installed) return;
    const target = typeof window !== 'undefined' ? window : globalThis;
    target.console = this._prevConsole || this._orig;
    this._installed = false;
  }

  pause() { this._capturing = false; }
  resume() { this._capturing = true; }

  getLogs(filter = {}) {
    const { level, since, until } = filter;
    return this._logs.filter(entry => {
      if (level && entry.level !== level) return false;
      if (since && entry.time && entry.time < since) return false;
      if (until && entry.time && entry.time > until) return false;
      return true;
    }).slice(); // shallow copy
  }

  clearLogs() {
    this._logs.length = 0;
  }

  // For symmetry with your example; same names, same behavior.
  get logs() { return this.getLogs(); }
  getLogsAll() { return this.getLogs(); }

  // ---------------- Internal ----------------

  _buildProxy() {
    const orig = this._orig;
    const proxy = {};

    // Collect all property names (functions + others) from the original console
    const names = new Set([
      ...Object.getOwnPropertyNames(orig),
      ...Object.keys(orig)
    ]);

    // Common console methods across browsers/environments
    const knownMethods = [
      'log','info','warn','error','debug','trace',
      'group','groupCollapsed','groupEnd',
      'table','time','timeEnd','timeLog',
      'count','countReset','assert','clear','dir','dirxml'
    ];
    knownMethods.forEach(n => names.add(n));

    // Bind/wrap every function; copy over non-functions.
    for (const name of names) {
      const desc = this._safeGetDescriptor(orig, name);
      if (!desc) continue;

      if (typeof desc.value === 'function') {
        proxy[name] = this._wrapMethod(name, orig[name]);
      } else if (desc.get || desc.set) {
        // Recreate getters/setters to retain behavior
        Object.defineProperty(proxy, name, {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get ? desc.get.bind(orig) : undefined,
          set: desc.set ? desc.set.bind(orig) : undefined
        });
      } else {
        // Copy primitives/objects as-is
        try {
          proxy[name] = orig[name];
        } catch {
          // Some environments may throw on access; ignore
        }
      }
    }

    // Make it obvious (optional)
    Object.defineProperty(proxy, '__capturing__', {
      value: true, enumerable: false
    });

    return proxy;
  }

  _safeGetDescriptor(obj, prop) {
    try {
      return Object.getOwnPropertyDescriptor(obj, prop);
    } catch {
      return null;
    }
  }

  _wrapMethod(level, fn) {
    const self = this;

    // Respect optional level filtering
    const levelAllowed =
      !self.options.levels || self.options.levels.includes(level);

    function wrapped(...args) {
      // Special-case assert: only logs if first arg is falsy
      const isAssert = level === 'assert';
      const shouldCaptureAssert = isAssert ? !args[0] : true;

      if (self._capturing && levelAllowed && shouldCaptureAssert) {
        const entry = {
          id: self._nextId++,
          level,
          args, // keep original values (objects by reference)
        };
        if (self.options.withTimestamp) {
          entry.time = new Date();
        }
        if (self.options.captureStack) {
          // Discard the first two lines (Error + this wrapper)
          const stack = new Error().stack || '';
          entry.stack = stack.split('\n').slice(2).join('\n');
        }

        // Enforce maxEntries as a ring buffer if set
        if (self.options.maxEntries !== Infinity && self._logs.length >= self.options.maxEntries) {
          self._logs.shift();
        }
        self._logs.push(entry);
      }

      // Forward to the original function (if it exists), preserving the original `this`
      try {
        if (typeof fn === 'function') {
          return fn.apply(self._orig, args);
        }
      } catch (err) {
        // If the original console throws, avoid breaking the app
        try {
          // Last-resort fallback to native console if available
          return self._orig && typeof self._orig.log === 'function'
            ? self._orig.log('ConsoleCapture forwarding error:', err)
            : undefined;
        } catch { /* ignore */ }
      }
      return undefined;
    }

    // Keep function name for nicer stacks (non-critical)
    try { Object.defineProperty(wrapped, 'name', { value: `capture_${level}` }); } catch {}

    return wrapped;
  }
}
