// EnvMonacoEditor - custom element that lazy-loads Monaco and injects typings for window.env
// Usage:
//   import './EnvMonacoEditor.js';
//   const el = document.createElement('env-monaco-editor');
//   document.body.appendChild(el);

class EnvMonacoEditor extends HTMLElement {
  static MAX_DEPTH = 6;
  static get observedAttributes() {
    return ['language', 'readonly', 'theme'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._editor = null;
    this._model = null;
    this._envLibDisposable = null;
    this._stylesMirrored = false;
    this._envInterval = null;
    this._lastEnvFingerprint = null;

    this._pendingValue = '';
    this._pendingLanguage = null;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: relative;
          min-height: 120px;
          background: #0f0f12;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 10px;
          overflow: hidden;
          box-sizing: border-box;
        }
        *, *::before, *::after {
          box-sizing: inherit;
        }
        .wrap {
          height: 100%;
          width: 100%;
          position: absolute;
          inset: 0;
        }
        .container {
          height: 100%;
          width: 100%;
          position: absolute;
          inset: 0;
        }
        .loading {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          color: rgba(255,255,255,0.72);
          font: 13px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
                "Courier New", monospace;
          letter-spacing: 0.2px;
          background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
          user-select: none;
          pointer-events: none;
        }
      </style>
      <div class="wrap">
        <div class="container"></div>
        <div class="loading">Loading editor...</div>
      </div>
    `;

    this._container = this.shadowRoot.querySelector('.container');
    this._loading = this.shadowRoot.querySelector('.loading');
  }

  connectedCallback() {
    this._boot();
    this._startEnvWatcher();
  }

  disconnectedCallback() {
    this._disposeEnvLib();
    this._disposeEditor();
    this._stopEnvWatcher();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (name === 'language') {
      if (this._editor && this._model && window.monaco) {
        window.monaco.editor.setModelLanguage(this._model, this.language);
      } else {
        this._pendingLanguage = this.language;
      }
    }

    if (name === 'readonly') {
      if (this._editor) this._editor.updateOptions({ readOnly: this.readonly });
    }

    if (name === 'theme') {
      if (this._editor && window.monaco) {
        window.monaco.editor.setTheme(this.theme);
      }
    }
  }

  // ---- Public API ----

  get value() {
    return this._editor ? this._editor.getValue() : this._pendingValue;
  }

  set value(v) {
    const text = String(v ?? '');
    if (this._editor) this._editor.setValue(text);
    else this._pendingValue = text;
  }

  get language() {
    return this.getAttribute('language') || 'javascript';
  }

  set language(v) {
    this.setAttribute('language', v);
  }

  get readonly() {
    return this.hasAttribute('readonly');
  }

  set readonly(v) {
    if (v) this.setAttribute('readonly', '');
    else this.removeAttribute('readonly');
  }

  // Default to dark
  get theme() {
    return this.getAttribute('theme') || 'vs-dark';
  }

  set theme(v) {
    this.setAttribute('theme', v);
  }

  get monaco() {
    return window.monaco || null;
  }

  get editor() {
    return this._editor || null;
  }

  refreshEnvAutocomplete() {
    if (!window.monaco) return;
    this._installEnvAutocomplete(window.monaco);
  }

  // Optional helper if you want to set model value without resetting undo stack
  setValuePreserveUndo(text) {
    if (!this._editor || !this._model) {
      this._pendingValue = String(text ?? '');
      return;
    }
    const fullRange = this._model.getFullModelRange();
    this._editor.executeEdits('env-monaco-editor', [
      { range: fullRange, text: String(text ?? ''), forceMoveMarkers: true },
    ]);
  }

  // ---- Internal ----

  async _boot() {
    try {
      const monaco = await EnvMonacoEditor._loadMonaco();
      this._mirrorMonacoStylesIntoShadow();
      EnvMonacoEditor._registerRuntimeCompletion(monaco);

      // Create editor + model
      this._createEditor(monaco);

      // Install env autocomplete types
      this._installEnvAutocomplete(monaco);

      // Apply theme
      monaco.editor.setTheme(this.theme);

      // Done
      this._loading.style.display = 'none';
    } catch (e) {
      try {
        this._loading.textContent = 'Editor failed to load';
        this._loading.style.pointerEvents = 'auto';
      } catch { /* ignore */ }
      try { console.warn('[EnvMonacoEditor] Failed to load Monaco', e); } catch { /* ignore */ }
    }
  }

  _startEnvWatcher() {
    if (this._envInterval) return;
    this._lastEnvFingerprint = this._fingerprintEnv(window.env);
    this._envInterval = setInterval(() => this._autoRefreshEnvLib(), 1200);
  }

  _stopEnvWatcher() {
    if (this._envInterval) clearInterval(this._envInterval);
    this._envInterval = null;
  }

  _autoRefreshEnvLib() {
    const fp = this._fingerprintEnv(window.env);
    if (fp && fp !== this._lastEnvFingerprint) {
      this._lastEnvFingerprint = fp;
      if (window.monaco) this._installEnvAutocomplete(window.monaco);
    }
  }

  _mirrorMonacoStylesIntoShadow() {
    if (this._stylesMirrored || !this.shadowRoot) return;
    const targets = [
      ...document.querySelectorAll('link[rel="stylesheet"][href*="/vs/"]'),
      ...document.querySelectorAll('style[data-name^="vs/"]'),
    ];
    if (!targets.length) return;
    const frag = document.createDocumentFragment();
    for (const node of targets) {
      const clone = node.cloneNode(true);
      frag.appendChild(clone);
    }
    const host = document.createElement('div');
    host.setAttribute('data-monaco-style-host', '');
    host.appendChild(frag);
    this.shadowRoot.appendChild(host);
    this._stylesMirrored = true;
  }

  _collectProps(obj) {
    const props = [];
    const seenProtos = new Set();
    let cursor = obj;
    while (cursor && cursor !== Object.prototype && cursor !== Function.prototype) {
      if (seenProtos.has(cursor)) break;
      seenProtos.add(cursor);
      let descs = null;
      try { descs = Object.getOwnPropertyDescriptors(cursor); } catch { descs = null; }
      if (!descs) { cursor = Object.getPrototypeOf(cursor); continue; }
      for (const [key, desc] of Object.entries(descs)) {
        if (key === 'constructor') continue;
        if (props.some((p) => p.key === key)) continue;
        const hasValue = Object.prototype.hasOwnProperty.call(desc, 'value');
        const getterOnly = !hasValue && (!!desc.get || !!desc.set);
        const val = hasValue ? desc.value : undefined;
        props.push({ key, value: val, getterOnly });
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    return props;
  }

  _fingerprintEnv(obj, seen = new WeakSet(), depth = 0) {
    const t = typeof obj;
    if (obj === null || t !== 'object') return t;
    if (seen.has(obj)) return 'c';
    seen.add(obj);
    if (depth > 4) return 'd';
    const entries = this._collectProps(obj);
    const keys = entries.map((p) => p.key).sort();
    const parts = [];
    for (const k of keys.slice(0, 120)) {
      const entry = entries.find((p) => p.key === k);
      if (!entry) continue;
      const { getterOnly, value } = entry;
      const next = getterOnly ? 'g' : this._fingerprintEnv(value, seen, depth + 1);
      parts.push(`${k}:${next}`);
    }
    return `{${parts.join(',')}}`;
  }

  _createEditor(monaco) {
    const uri = monaco.Uri.parse(`file:///env-monaco-editor/${EnvMonacoEditor._uuid()}.js`);
    const lang = this._pendingLanguage || this.language;

    this._model = monaco.editor.createModel(this._pendingValue || '', lang, uri);

    this._editor = monaco.editor.create(this._container, {
      model: this._model,
      theme: this.theme,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 19,
      tabSize: 2,
      insertSpaces: true,
      readOnly: this.readonly,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
    });

    this._editor.onDidChangeModelContent(() => {
      // Standard "input" event for form-style usage + a detailed "change" event
      this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      this.dispatchEvent(
        new CustomEvent('change', {
          detail: { value: this._editor.getValue() },
          bubbles: true,
          composed: true,
        }),
      );
    });
  }

  _installEnvAutocomplete(monaco) {
    // Ensure JS uses TS language service features
    monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      checkJs: true,
      noEmit: true,
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.ESNext,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: false,
    });

    // Replace previous env typings
    this._disposeEnvLib();

    const envObj = window.env ?? {};
    const dts = this._makeEnvDts(envObj);

    const libPath = `file:///__generated__/window-env-${EnvMonacoEditor._uuid()}.d.ts`;
    this._envLibDisposable = monaco.languages.typescript.javascriptDefaults.addExtraLib(dts, libPath);
  }

  _disposeEnvLib() {
    if (this._envLibDisposable?.dispose) this._envLibDisposable.dispose();
    this._envLibDisposable = null;
  }

  _disposeEditor() {
    if (this._editor) this._editor.dispose();
    this._editor = null;
    if (this._model) this._model.dispose();
    this._model = null;
  }

  _makeEnvDts(envObj) {
    const envType = this._inferTsType(envObj, new Set());
    return `// Generated from live window.env
export {};

declare global {
  interface Window {
    env: ${envType};
  }

  // Convenience alias: use "env" directly
  const env: Window["env"];
}
`;
  }

  _inferTsType(value, seen) {
    return this._inferTsTypeInternal(value, seen, 0);
  }

  _inferTsTypeInternal(value, seen, depth) {
    if (depth > EnvMonacoEditor.MAX_DEPTH) return 'any';
    const t = typeof value;

    if (value === null) return 'null';
    if (t === 'string') return 'string';
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'bigint') return 'bigint';
    if (t === 'symbol') return 'symbol';
    if (t === 'undefined') return 'undefined';
    if (t === 'function') return 'Function';

    if (t === 'object') {
      if (seen.has(value)) return 'any';
      seen.add(value);

      if (value instanceof Date) return 'Date';
      if (value instanceof RegExp) return 'RegExp';
      if (value instanceof Map) return 'Map<any, any>';
      if (value instanceof Set) return 'Set<any>';

      if (Array.isArray(value)) {
        if (value.length === 0) return 'any[]';
        const sample = value.slice(0, 20);
        const types = [...new Set(sample.map((v) => this._inferTsTypeInternal(v, new Set(seen), depth + 1)))];
        return `(${types.join(' | ')})[]`;
      }

      const entries = this._collectProps(value);
      if (entries.length === 0) return 'Record<string, any>';

      const props = entries.map(({ key: k, value: v, getterOnly }) => {
        const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        const optional = (v === undefined || getterOnly) ? '?' : '';
        const type = getterOnly ? 'any' : this._inferTsTypeInternal(v, new Set(seen), depth + 1);
        return `  ${safeKey}${optional}: ${type};`;
      });

      return `{\n${props.join('\n')}\n}`;
    }

    return 'any';
  }

  // ---- Static helpers ----

  static _registerRuntimeCompletion(monaco) {
    if (EnvMonacoEditor._runtimeCompletionRegistered) return;
    EnvMonacoEditor._runtimeCompletionRegistered = true;
    try {
      monaco.languages.registerCompletionItemProvider('javascript', {
        triggerCharacters: ['.', '?'],
        provideCompletionItems: (model, position) => {
          try {
            const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
            const expr = line.split(/[^A-Za-z0-9_$?.]/).pop() || '';
            if (!expr || !expr.startsWith('env')) return { suggestions: [] };
            const cleaned = expr.replace(/^\?/g, '').replace(/\?/g, '');
            const parts = cleaned.split('.').filter(Boolean);
            if (parts[0] !== 'env') return { suggestions: [] };
            parts.shift();
            let target = window.env;
            for (const p of parts) {
              if (target && typeof target === 'object' && p in target) target = target[p];
              else return { suggestions: [] };
            }
            if (target == null) return { suggestions: [] };
            const keys = Array.from(new Set(
              this.prototype._collectProps ? this.prototype._collectProps(target).map((p) => p.key) : Object.keys(target)
            ));
            const wordInfo = model.getWordUntilPosition(position);
            const range = new monaco.Range(
              position.lineNumber,
              wordInfo.startColumn,
              position.lineNumber,
              wordInfo.endColumn,
            );
            const suggestions = keys.map((key) => ({
              label: key,
              insertText: key,
              kind: monaco.languages.CompletionItemKind.Property,
              range,
            }));
            return { suggestions };
          } catch {
            return { suggestions: [] };
          }
        },
      });
    } catch { /* ignore */ }
  }

  static _uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  }

  static _loadMonaco() {
    if (window.monaco) return Promise.resolve(window.monaco);
    if (EnvMonacoEditor._monacoPromise) return EnvMonacoEditor._monacoPromise;

    EnvMonacoEditor._monacoPromise = new Promise((resolve, reject) => {
      const ensureLoader = () => {
        if (window.require?.config) return Promise.resolve();
        return new Promise((res, rej) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/loader.js';
          script.async = true;
          script.onload = () => res();
          script.onerror = () => rej(new Error('Failed to load Monaco loader'));
          document.head.appendChild(script);
        });
      };

      ensureLoader()
        .then(() => {
          window.require.config({
            paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs' },
          });

          window.require(['vs/editor/editor.main'], () => {
            if (!window.monaco) {
              reject(new Error('Monaco loaded but window.monaco is missing'));
              return;
            }
            resolve(window.monaco);
          });
        })
        .catch(reject);
    });

    return EnvMonacoEditor._monacoPromise;
  }
}

EnvMonacoEditor._monacoPromise = null;
EnvMonacoEditor._runtimeCompletionRegistered = false;

if (!customElements.get('env-monaco-editor')) {
  customElements.define('env-monaco-editor', EnvMonacoEditor);
}

export { EnvMonacoEditor };
export default EnvMonacoEditor;
