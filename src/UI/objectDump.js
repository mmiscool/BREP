/**
 * generateObjectUI(obj, options?)
 * - Renders a dark-mode, editable tree view for any JS object/array.
 * - Edits update the original object immediately (by path).
 * - Returns a root <div> you can attach anywhere.
 */
export function generateObjectUI(target, options = {}) {
  ensureStyles();
  const cfg = {
    title: options.title ?? 'Object Inspector',
    showTypes: options.showTypes ?? true,
    collapsed: options.collapsed ?? false, // collapse all by default?
    maxPreview: options.maxPreview ?? 40,  // preview length for summaries
  };

  // Root container
  const root = document.createElement('div');
  root.className = 'objui';

  // Header
  const header = document.createElement('div');
  header.className = 'objui-header';

  const title = document.createElement('div');
  title.className = 'objui-title';
  title.textContent = cfg.title;

  const search = document.createElement('div');
  search.className = 'objui-search';
  const searchInput = document.createElement('input');
  searchInput.placeholder = 'Filter by key or path…';
  search.appendChild(searchInput);

  const actions = document.createElement('div');
  actions.className = 'objui-actions';
  const btnExpand = mkButton('Expand all');
  const btnCollapse = mkButton('Collapse all');
  const btnCopy = mkButton('Copy JSON');
  actions.append(btnExpand, btnCollapse, btnCopy);

  header.append(title, search, actions);
  root.appendChild(header);
  root.appendChild(hr());

  // Tree
  const tree = document.createElement('div');
  tree.className = 'tree';
  root.appendChild(tree);

  // Build nodes
  const state = { target, nodes: [] };
  const top = buildNode(state, target, [], cfg);
  tree.appendChild(top);

  // Wire actions
  btnExpand.addEventListener('click', () => setAllDetails(root, true));
  btnCollapse.addEventListener('click', () => setAllDetails(root, false));
  btnCopy.addEventListener('click', () => {
    try {
      const text = JSON.stringify(target, replacerForJSON(), 2);
      navigator.clipboard.writeText(text);
      pulse(btnCopy, 'Copied!');
    } catch (e) {
      console.error(e);
      alert('Failed to copy JSON.');
    }
  });

  // Filtering
  searchInput.addEventListener('input', () => filterTree(root, searchInput.value.trim().toLowerCase()));

  // Initial collapse preference
  if (cfg.collapsed) setAllDetails(root, false);

  return root;
}

/* ========================= Helpers ========================= */

function ensureStyles() {
  if (document.getElementById('objui-styles')) return;
  const style = document.createElement('style');
  style.id = 'objui-styles';
  style.textContent = `
    :root{ --bg:#0b0d10; --panel:#0f141a; --text:#e5e7eb; --muted:#9aa4b2; --border:#2a3442; --hover:#1b2433; --ok:#3b82f6; }
    .objui{ color:var(--text); font:12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial; }
    .objui .hr{ height:1px; background:#1e2430; margin:6px 0; }

    .objui-header{ display:grid; grid-template-columns: auto 1fr auto; align-items:center; gap:8px; }
    .objui-title{ font-weight:700; color:var(--text); white-space:nowrap; }
    .objui-search input{ width:100%; box-sizing:border-box; background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font:12px system-ui; }
    .objui-actions{ display:flex; gap:6px; }
    .objui-btn{ background:var(--hover); color:var(--text); border:1px solid var(--border); padding:6px 8px; border-radius:8px; cursor:pointer; font-weight:700; font-size:12px; }
    .objui-btn:hover{ filter:brightness(1.1); }

    .tree{ display:block; }

    details{ border-left:1px solid #1e2430; margin-left:8px; }
    summary{ list-style:none; cursor:pointer; user-select:none; padding:4px 4px; margin-left:-8px; display:grid; grid-template-columns:14px 1fr auto auto; align-items:center; gap:8px; color:var(--text); }
    summary::-webkit-details-marker{ display:none; }
    .chev{ width:14px; height:14px; color:#9aa4b2; transform:rotate(180deg); transition:transform .12s ease; }
    details[open] > summary .chev{ transform:rotate(90deg); }
    .key{ color:var(--text); font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .meta{ color:var(--muted); font-style:italic; }
    .type-badge{ color:#b7c0cc; border:1px solid #2d3748; border-radius:6px; padding:2px 6px; font:11px system-ui; }

    .kv{ display:grid; grid-template-columns:14px 180px 1fr auto; align-items:center; gap:8px; padding:4px 4px; }
    .kv .key{ font-weight:600; }
    .value-input, .value-date{ width:100%; box-sizing:border-box; background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:5px 7px; font:12px ui-monospace, Menlo, Consolas, monospace; }
    .value-input.readonly{ background:#0f141a; color:#c9d1d9; border-color:#1e2430; }
    .value-checkbox{ width:16px; height:16px; }

    .hidden{ display:none !important; }
  `;
  document.head.appendChild(style);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isArray = Array.isArray;
const isDate = (v) => v instanceof Date || (typeof v === 'string' && !isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v));
const isFunction = (v) => typeof v === 'function';
const typeOf = (v) => {
  if (v === null) return 'null';
  if (isArray(v)) return 'array';
  if (isDate(v)) return 'date';
  return typeof v; // object, number, string, boolean, bigint, symbol, function, undefined
};

function mkButton(label) {
  const b = document.createElement('button');
  b.className = 'objui-btn';
  b.textContent = label;
  return b;
}

function hr() {
  const d = document.createElement('div');
  d.className = 'hr';
  return d;
}

function pulse(btn, text) {
  const prev = btn.textContent;
  btn.textContent = text;
  btn.style.borderColor = 'var(--ok)';
  setTimeout(() => {
    btn.textContent = prev;
    btn.style.borderColor = 'var(--border)';
  }, 900);
}

function setAllDetails(root, open) {
  root.querySelectorAll('details').forEach(d => d.open = open);
}

function filterTree(root, q) {
  if (!q) {
    root.querySelectorAll('.kv, details').forEach(el => el.classList.remove('hidden'));
    return;
  }
  root.querySelectorAll('[data-path]').forEach(el => {
    const key = el.getAttribute('data-key')?.toLowerCase() ?? '';
    const path = el.getAttribute('data-path')?.toLowerCase() ?? '';
    const hit = key.includes(q) || path.includes(q);
    el.classList.toggle('hidden', !hit);
  });
}

/**
 * Safely get/set by path (array of keys)
 */
function getByPath(obj, path) {
  return path.reduce((acc, k) => (acc != null ? acc[k] : undefined), obj);
}
function setByPath(obj, path, val) {
  if (!path.length) return;
  const last = path[path.length - 1];
  const parent = getByPath(obj, path.slice(0, -1));
  if (parent == null) return;
  parent[last] = val;
}

/**
 * Convert from input string/checkbox into the appropriate type
 * using the current value's type as a hint.
 */
function coerceValue(raw, currentType, currentValue) {
  switch (currentType) {
    case 'number': {
      if (raw === '' || raw === '-' || raw === '+') return Number.NaN;
      const n = Number(raw);
      return Number.isNaN(n) ? currentValue : n;
    }
    case 'bigint': {
      try { return BigInt(raw); } catch { return currentValue; }
    }
    case 'boolean': return !!raw; // for checkbox we pass true/false already
    case 'date': {
      // Accept YYYY-MM-DD (from date input) and coerce to Date instance if original was Date
      const t = typeof currentValue === 'string' ? new Date(raw) : new Date(raw + 'T00:00:00');
      return isNaN(t.getTime()) ? currentValue : (currentValue instanceof Date ? t : t.toISOString());
    }
    case 'object':
    case 'array': {
      // For arrays/objects edited as raw JSON (fallback)
      try {
        const parsed = JSON.parse(raw);
        if (currentType === 'array' && !Array.isArray(parsed)) return currentValue;
        if (currentType === 'object' && (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')) return currentValue;
        return parsed;
      } catch {
        return currentValue;
      }
    }
    case 'null': return null;
    case 'undefined': return undefined;
    case 'symbol': return currentValue; // read-only
    case 'function': return currentValue; // read-only
    default: // string or unknown
      return String(raw);
  }
}

/**
 * JSON replacer to handle BigInt & Date gracefully
 */
function replacerForJSON() {
  return (_, v) => {
    if (typeof v === 'bigint') return v.toString() + 'n';
    if (v instanceof Date) return v.toISOString();
    return v;
  };
}

/**
 * Build a subtree for value at a path.
 */
function buildNode(state, value, path, cfg) {
  const t = typeOf(value);

  // Non-container types: render as key/value row (container handled by caller)
  if (t !== 'object' && t !== 'array') {
    return renderKV(state, path[path.length - 1] ?? '(root)', value, path, cfg);
  }

  // Container: <details> with children
  const details = document.createElement('details');
  details.open = !cfg.collapsed;
  details.setAttribute('data-path', pathToString(path));
  details.setAttribute('data-key', path[path.length - 1] ?? '');
  const summary = document.createElement('summary');

  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('viewBox', '0 0 24 24');
  chev.classList.add('chev');
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathEl.setAttribute('d', 'M15.5 19l-7-7 7-7');
  pathEl.setAttribute('fill', 'none');
  pathEl.setAttribute('stroke', 'currentColor');
  pathEl.setAttribute('stroke-width', '2');
  pathEl.setAttribute('stroke-linecap', 'round');
  pathEl.setAttribute('stroke-linejoin', 'round');
  chev.appendChild(pathEl);

  const keyEl = document.createElement('div');
  keyEl.className = 'key';
  keyEl.textContent = path.length ? String(path[path.length - 1]) : '(root)';

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (t === 'object') {
    const keys = Object.keys(value);
    meta.textContent = `Object { ${previewKeys(keys, cfg.maxPreview)} }`;
  } else {
    meta.textContent = `Array(${value.length})`;
  }

  const typeBadge = document.createElement('div');
  typeBadge.className = 'type-badge';
  typeBadge.textContent = t;

  summary.append(chev, keyEl, meta, cfg.showTypes ? typeBadge : document.createTextNode(''));
  details.appendChild(summary);

  // Children
  if (t === 'object') {
    const keys = Object.keys(value);
    for (const k of keys) {
      const childVal = value[k];
      const childPath = path.concat(k);
      const childType = typeOf(childVal);

      if (childType === 'object' || childType === 'array') {
        details.appendChild(buildNode(state, childVal, childPath, cfg));
      } else {
        details.appendChild(renderKV(state, k, childVal, childPath, cfg));
      }
    }
  } else if (t === 'array') {
    for (let i = 0; i < value.length; i++) {
      const childVal = value[i];
      const childPath = path.concat(i);
      const childType = typeOf(childVal);

      if (childType === 'object' || childType === 'array') {
        details.appendChild(buildNode(state, childVal, childPath, cfg));
      } else {
        details.appendChild(renderKV(state, `[${i}]`, childVal, childPath, cfg));
      }
    }
  }

  return details;
}

function previewKeys(keys, maxLen) {
  const joined = keys.join(', ');
  return joined.length <= maxLen ? joined : joined.slice(0, maxLen - 1) + '…';
}

function pathToString(path) {
  if (!path.length) return '(root)';
  return path.map(p => typeof p === 'number' ? `[${p}]` : `.${String(p)}`).join('').replace(/^\./, '');
}

/**
 * Render a single key-value editable row.
 */
function renderKV(state, key, value, path, cfg) {
  const t = typeOf(value);
  const row = document.createElement('div');
  row.className = 'kv';
  row.setAttribute('data-path', pathToString(path));
  row.setAttribute('data-key', String(key));

  // Spacer to align with chevron column
  row.appendChild(document.createElement('div')); // empty 14px col

  const keyEl = document.createElement('div');
  keyEl.className = 'key';
  keyEl.textContent = String(key);
  row.appendChild(keyEl);

  // Value editor
  const valueEl = document.createElement('div');
  const editor = makeEditorForType(value, t, (newValRaw) => {
    // For checkboxes we pass boolean directly; for others raw string
    const coerced = t === 'boolean' ? newValRaw : coerceValue(newValRaw, t, value);
    setByPath(state.target, path, coerced);
  });
  valueEl.appendChild(editor);
  row.appendChild(valueEl);

  const typeBadge = document.createElement('div');
  typeBadge.className = 'type-badge';
  typeBadge.textContent = t;
  if (!cfg.showTypes) typeBadge.style.display = 'none';
  row.appendChild(typeBadge);

  return row;
}

function makeEditorForType(value, t, onCommit) {
  switch (t) {
    case 'string': {
      const inp = document.createElement('input');
      inp.className = 'value-input';
      inp.type = 'text';
      inp.value = value ?? '';
      inp.addEventListener('change', () => onCommit(inp.value));
      return inp;
    }
    case 'number': {
      const inp = document.createElement('input');
      inp.className = 'value-input';
      inp.type = 'number';
      inp.value = Number.isFinite(value) ? String(value) : '';
      inp.step = 'any';
      inp.addEventListener('change', () => onCommit(inp.value));
      return inp;
    }
    case 'bigint': {
      const inp = document.createElement('input');
      inp.className = 'value-input';
      inp.type = 'text';
      inp.value = value?.toString() ?? '';
      inp.addEventListener('change', () => onCommit(inp.value));
      return inp;
    }
    case 'boolean': {
      const inp = document.createElement('input');
      inp.className = 'value-checkbox';
      inp.type = 'checkbox';
      inp.checked = !!value;
      inp.addEventListener('change', () => onCommit(inp.checked));
      return inp;
    }
    case 'date': {
      const inp = document.createElement('input');
      inp.className = 'value-date';
      inp.type = 'date';
      const d = (value instanceof Date) ? value : new Date(value);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      inp.value = isNaN(d.getTime()) ? '' : `${yyyy}-${mm}-${dd}`;
      inp.addEventListener('change', () => onCommit(inp.value));
      return inp;
    }
    case 'undefined':
    case 'null':
    case 'symbol':
    case 'function': {
      const span = document.createElement('span');
      span.className = 'value-input readonly';
      span.textContent = showPreview(value, 80);
      span.title = 'read-only';
      return span;
    }
    case 'object':
    case 'array': {
      // Fallback JSON editor for leaf that ended up here (should be rare)
      const inp = document.createElement('input');
      inp.className = 'value-input';
      try {
        inp.value = JSON.stringify(value);
      } catch {
        inp.value = String(value);
      }
      inp.addEventListener('change', () => onCommit(inp.value));
      return inp;
    }
    default: {
      const inp = document.createElement('input');
      inp.className = 'value-input';
      inp.type = 'text';
      inp.value = String(value ?? '');
      inp.addEventListener('change', () => onCommit(inp.value));
      return inp;
    }
  }
}

function showPreview(v, max = 40) {
  let s;
  try {
    if (typeof v === 'function') s = `[Function ${v.name || 'anonymous'}]`;
    else if (typeof v === 'symbol') s = v.toString();
    else if (v instanceof Date) s = v.toISOString();
    else {
      const j = JSON.stringify(v, replacerForJSON());
      s = (j === undefined ? String(v) : j);
    }
  } catch {
    s = String(v);
  }
  s = String(s ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
