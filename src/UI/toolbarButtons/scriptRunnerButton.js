import { FloatingWindow } from '../FloatingWindow.js';
import '../EnvMonacoEditor.js';

const PANEL_KEY = Symbol('ScriptRunnerPanel');
const DEFAULT_SNIPPET = `// Access the app environment via the global "env" object.
console.log('env keys', Object.keys(env || {}));

// Example: log the active part history entry
console.log('active history', viewer?.partHistory?.getActiveStep?.());
`;

class ScriptRunnerPanel {
  constructor(viewer) {
    this.viewer = viewer;
    this.window = null;
    this.root = null;
    this.editorEl = null;
    this.editorWrap = null;
    this.outputEl = null;
    this.consoleWrap = null;
    this.splitterEl = null;
    this.contentRoot = null;
    this.introEl = null;
    this.statusEl = null;
    this._initializedValue = false;
    this._consoleHeight = 180;
    this._lastContentRect = null;
  }

  toggle() {
    if (this.root && this.root.style.display !== 'none') this.close();
    else this.open();
  }

  open() {
    this._ensureWindow();
    if (!this.root) return;
    this.root.style.display = 'flex';
    try { this.editorEl?.refreshEnvAutocomplete?.(); } catch {}
  }

  close() {
    if (!this.root) return;
    try { this.root.style.display = 'none'; } catch {}
  }

  _ensureWindow() {
    if (this.root) return;
    const fw = new FloatingWindow({
      title: 'Script Runner',
      width: 760,
      height: 520,
      right: 16,
      top: 56,
      shaded: false,
      onClose: () => this.close(),
    });

    const btnRun = document.createElement('button');
    btnRun.className = 'fw-btn';
    btnRun.textContent = 'Run';
    btnRun.addEventListener('click', () => this._runCode());

    const btnRefresh = document.createElement('button');
    btnRefresh.className = 'fw-btn';
    btnRefresh.textContent = 'Refresh env types';
    btnRefresh.addEventListener('click', () => {
      try {
        this.editorEl?.refreshEnvAutocomplete?.();
        this._setStatus('env typings refreshed from window.env');
      } catch {
        this._setStatus('Unable to refresh env typings');
      }
    });

    fw.addHeaderAction(btnRun);
    fw.addHeaderAction(btnRefresh);

    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.gap = '8px';
    content.style.width = '100%';
    content.style.height = '100%';
    content.style.boxSizing = 'border-box';
    content.style.minHeight = '0';
    this.contentRoot = content;

    const intro = document.createElement('div');
    intro.textContent = 'Run ad-hoc JavaScript with Monaco autocomplete for window.env.';
    intro.style.color = '#aeb6c5';
    intro.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    intro.style.opacity = '0.9';
    this.introEl = intro;

    const editorWrap = document.createElement('div');
    editorWrap.style.display = 'flex';
    editorWrap.style.flexDirection = 'column';
    editorWrap.style.flex = '1 1 60%';
    editorWrap.style.minHeight = '200px';
    editorWrap.style.minWidth = '0';
    editorWrap.style.position = 'relative';

    const editor = document.createElement('env-monaco-editor');
    editor.style.position = 'absolute';
    editor.style.inset = '0';
    editor.setAttribute('language', 'javascript');
    if (!this._initializedValue) {
      editor.value = DEFAULT_SNIPPET;
      this._initializedValue = true;
    }

    const splitter = document.createElement('div');
    splitter.style.flex = '0 0 10px';
    splitter.style.height = '10px';
    splitter.style.cursor = 'row-resize';
    splitter.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))';
    splitter.style.border = '1px solid #1f2530';
    splitter.style.borderRadius = '8px';
    splitter.style.margin = '6px 0';
    splitter.style.position = 'relative';
    splitter.style.zIndex = '2';
    splitter.addEventListener('pointerdown', (ev) => this._onSplitterPointerDown(ev));

    const consoleWrap = document.createElement('div');
    consoleWrap.style.display = 'flex';
    consoleWrap.style.flexDirection = 'column';
    consoleWrap.style.flex = '0 0 180px';
    consoleWrap.style.minHeight = '120px';
    consoleWrap.style.maxHeight = '70vh';
    consoleWrap.style.gap = '6px';
    consoleWrap.style.position = 'relative';

    const output = document.createElement('div');
    output.style.flex = '1 1 auto';
    output.style.background = '#0e1117';
    output.style.border = '1px solid #1f2530';
    output.style.borderRadius = '8px';
    output.style.padding = '8px';
    output.style.overflow = 'auto';
    output.style.font = '12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    output.style.color = '#d1d5db';

    const statusRow = document.createElement('div');
    statusRow.style.display = 'flex';
    statusRow.style.alignItems = 'center';
    statusRow.style.gap = '8px';

    const status = document.createElement('div');
    status.style.flex = '1';
    status.style.color = '#9ca3af';
    status.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    status.textContent = 'Idle';

    const btnClear = document.createElement('button');
    btnClear.className = 'fw-btn';
    btnClear.textContent = 'Clear output';
    btnClear.addEventListener('click', () => { output.innerHTML = ''; });

    statusRow.appendChild(status);
    statusRow.appendChild(btnClear);

    content.appendChild(intro);
    editorWrap.appendChild(editor);
    content.appendChild(editorWrap);
    content.appendChild(splitter);
    consoleWrap.appendChild(statusRow);
    consoleWrap.appendChild(output);
    content.appendChild(consoleWrap);

    fw.content.appendChild(content);

    this.window = fw;
    this.root = fw.root;
    this.editorEl = editor;
    this.editorWrap = editorWrap;
    this.outputEl = output;
    this.consoleWrap = consoleWrap;
    this.splitterEl = splitter;
    this.statusEl = status;
    try { this.root.style.display = 'none'; } catch {}
    requestAnimationFrame(() => this._applySplitHeights());
  }

  async _runCode() {
    const code = this.editorEl?.value || '';
    if (!code.trim()) {
      this._setStatus('Nothing to run');
      return;
    }
    this._appendOutput(`>>> Running at ${new Date().toLocaleTimeString()}`);
    this._setStatus('Running...');

    const exec = () => {
      const fn = new Function('viewer', 'env', 'monaco', `"use strict";\n${code}`);
      return fn(this.viewer, window.env, window.monaco);
    };

    try {
      const result = exec();
      if (result instanceof Promise) {
        const resolved = await result;
        this._appendOutput(this._stringify(resolved));
        this._setStatus('Completed (async)');
      } else {
        this._appendOutput(this._stringify(result));
        this._setStatus('Completed');
      }
    } catch (e) {
      const msg = e?.stack || e?.message || String(e);
      this._appendOutput(msg, true);
      this._setStatus('Error');
      try { console.error('[ScriptRunner]', e); } catch {}
    }
  }

  _appendOutput(text, isError = false) {
    if (!this.outputEl) return;
    const line = document.createElement('div');
    line.textContent = text;
    line.style.whiteSpace = 'pre-wrap';
    line.style.color = isError ? '#fca5a5' : '#d1d5db';
    this.outputEl.appendChild(line);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  _setStatus(msg) {
    if (!this.statusEl) return;
    this.statusEl.textContent = msg;
  }

  _stringify(value) {
    try {
      if (typeof value === 'string') return value;
      if (typeof value === 'function') return value.toString();
      if (value === undefined) return 'undefined';
      if (value === null) return 'null';
      const json = JSON.stringify(value, null, 2);
      return typeof json === 'string' ? json : String(value);
    } catch {
      try { return String(value); } catch { return '[unprintable]'; }
    }
  }

  _onSplitterPointerDown(ev) {
    if (ev.button !== 0) return;
    const startY = ev.clientY;
    const startHeight = (this.consoleWrap?.getBoundingClientRect?.().height) || this._consoleHeight;
    const onMove = (e) => {
      const dy = e.clientY - startY;
      this._setConsoleHeight(startHeight - dy);
      try { e.preventDefault(); } catch {}
    };
    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      try { this._consoleHeight = (this.consoleWrap?.getBoundingClientRect?.().height) || this._consoleHeight; } catch {}
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    try { ev.preventDefault(); } catch {}
  }

  _setConsoleHeight(px) {
    if (!this.contentRoot || !this.consoleWrap || !this.editorWrap) return;
    const minConsole = 120;
    const minEditor = 180;
    const rect = this.contentRoot.getBoundingClientRect?.();
    const contentH = rect?.height || 0;
    const introH = this.introEl?.offsetHeight || 0;
    const splitterH = this.splitterEl?.offsetHeight || 10;
    const available = Math.max(0, contentH - introH - splitterH - 8); // account for gap/margins
    if (available <= 0) return;
    const maxConsole = Math.max(minConsole, available - minEditor);
    const clamped = Math.min(Math.max(px, minConsole), maxConsole);
    const editorHeight = Math.max(minEditor, available - clamped);
    this._consoleHeight = clamped;
    this.consoleWrap.style.flexBasis = `${clamped}px`;
    this.consoleWrap.style.height = `${clamped}px`;
    this.editorWrap.style.flexBasis = `${editorHeight}px`;
    this.editorWrap.style.height = `${editorHeight}px`;
    try { this.editorEl?.editor?.layout?.(); } catch {}
  }

  _applySplitHeights() {
    this._setConsoleHeight(this._consoleHeight);
    try { this.editorEl?.editor?.layout?.(); } catch {}
  }
}

export function createScriptRunnerButton(viewer) {
  if (!viewer) return null;
  if (!viewer[PANEL_KEY]) {
    viewer[PANEL_KEY] = new ScriptRunnerPanel(viewer);
  }
  const panel = viewer[PANEL_KEY];
  return {
    label: '</>',
    title: 'Open Script Runner',
    onClick: () => panel.toggle(),
  };
}
