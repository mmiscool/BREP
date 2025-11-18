import { SchemaForm } from '../UI/featureDialogs.js';

let stylesInjected = false;

const DEFAULT_DESCRIPTION = 'Dialogs are rendered live using SchemaForm. Use the automated capture script to export PNGs.';

export function renderDialogCapturePage({
  title = 'Dialog Reference',
  description = DEFAULT_DESCRIPTION,
  entries = [],
} = {}) {
  injectPageStyles();

  const appRoot = document.getElementById('app') || document.body;
  appRoot.classList.add('dialog-capture-page');
  appRoot.innerHTML = '';

  const header = document.createElement('header');
  header.className = 'dialog-capture-header';
  header.innerHTML = `
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description || DEFAULT_DESCRIPTION)}</p>
  `;

  const grid = document.createElement('section');
  grid.className = 'dialog-capture-grid';

  entries.forEach((entry) => {
    const displayName = formatName(entry?.displayName, 'Dialog');
    const shortName = formatName(entry?.shortName, displayName || 'Dialog');
    const captureName = entry?.captureName
      ? formatName(entry.captureName, displayName)
      : displayName;

    const params = clone(entry?.initialParams) || {};
    const schema = sanitizeSchema(entry?.schema);
    const options = entry?.formOptions && typeof entry.formOptions === 'object'
      ? entry.formOptions
      : undefined;

    let formHost = null;
    try {
      const form = new SchemaForm(schema, params, options);
      try { form.refreshFromParams?.(); } catch { /* ignore */ }
      formHost = form.uiElement;
      try {
        if (formHost) {
          formHost.style.width = '100%';
          formHost.style.maxWidth = '100%';
        }
      } catch {
        /* ignore width styling errors */
      }
    } catch (error) {
      formHost = buildErrorState(error);
    }

    const card = document.createElement('article');
    card.className = 'dialog-card';
    card.dataset.featureName = captureName;
    card.dataset.featureShortName = shortName;

    const head = document.createElement('div');
    head.className = 'dialog-card-head';

    const badge = document.createElement('span');
    badge.className = 'dialog-short';
    badge.textContent = shortName;

    const titleEl = document.createElement('h2');
    titleEl.className = 'dialog-title';
    titleEl.textContent = displayName;

    head.append(badge, titleEl);

    const formWrap = document.createElement('div');
    formWrap.className = 'dialog-form';
    if (formHost) {
      formWrap.appendChild(formHost);
    } else {
      formWrap.appendChild(buildErrorState(new Error('Form host missing')));
    }

    card.append(head, formWrap);
    grid.appendChild(card);
  });

  appRoot.append(header, grid);
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return {};
  return schema;
}

function formatName(value, fallback = '') {
  if (value == null && value !== 0) return fallback;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : fallback;
}

function clone(value) {
  if (Array.isArray(value)) {
    return value.map((item) => clone(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = clone(value[key]);
    }
    return out;
  }
  return value;
}

function buildErrorState(error) {
  const container = document.createElement('div');
  container.className = 'dialog-error';
  container.textContent = `Failed to render: ${error?.message || error || 'Unknown error'}`;
  return container;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function injectPageStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    :root {
      color-scheme: dark;
      font-family: "Inter", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
      background: #05070d;
      color: #e5ecff;
    }
    body {
      margin: 0;
      padding: 32px;
      min-height: 100vh;
      background: radial-gradient(circle at top, rgba(19,27,47,0.75), rgba(8,11,20,1) 55%);
      display: flex;
      justify-content: center;
    }
    .dialog-capture-page {
      width: min(1040px, 100%);
    }
    .dialog-capture-header {
      text-align: center;
      margin-bottom: 32px;
    }
    .dialog-capture-header h1 {
      margin: 0 0 12px 0;
      font-size: clamp(26px, 4vw, 38px);
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .dialog-capture-header p {
      margin: 0;
      color: #94a3b8;
      font-size: 14px;
    }
    .dialog-capture-grid {
      display: flex;
      flex-direction: column;
      gap: 32px;
      padding-bottom: 80px;
    }
    .dialog-card {
      background: rgba(13,17,27,0.92);
      border-radius: 18px;
      border: 1px solid rgba(71,85,105,0.42);
      padding: 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.45);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .dialog-card-head {
      display: flex;
      align-items: baseline;
      gap: 14px;
    }
    .dialog-short {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 64px;
      padding: 4px 14px;
      border-radius: 999px;
      border: 1px solid rgba(96, 165, 250, 0.45);
      background: rgba(51, 65, 85, 0.45);
      color: #cbd5ff;
      font-weight: 600;
      letter-spacing: 0.08em;
      font-size: 13px;
      text-transform: uppercase;
    }
    .dialog-title {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: #f8fafc;
    }
    .dialog-form {
      background: #0b0f16;
      width: 300px;
      border-radius: 16px;
      padding: 20px;
      border: 1px solid rgba(59,77,109,0.45);
      box-shadow: inset 0 0 0 1px rgba(71,85,105,0.18);
      box-sizing: border-box;
    }
    .dialog-error {
      font-size: 13px;
      color: #f87171;
      line-height: 1.4;
    }
  `;
  document.head.appendChild(style);
}
